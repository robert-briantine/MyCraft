// Magasin des mondes sauvegardés.
//
// Comme pour les textures, tout ce qui vient du webview est traité comme non
// fiable : le nom de monde est vérifié avant de toucher le disque et le contenu
// est validé structurellement avant d'être écrit. L'écriture passe par un
// renommage atomique, donc une coupure en pleine écriture laisse l'ancien monde
// intact plutôt qu'un fichier à moitié rempli.
//
// Le fichier ne contient que le diff du joueur (blocs modifiés + position) : le
// relief, lui, se régénère à l'identique depuis les graines côté JavaScript.
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Un monde n'est que le diff du joueur : quelques kilo-octets en pratique. Ce
/// plafond n'est pas une limite d'usage mais un garde-fou contre une boucle de bug
/// qui remplirait le disque.
const MAX_SAVE_BYTES: u64 = 64 * 1024 * 1024;
/// Au-delà, la liste des mondes renvoie l'entrée sans métadonnées plutôt que de
/// parser un fichier démesuré à chaque affichage de l'écran d'accueil.
const LIST_SCAN_MAX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SLOT_LEN: usize = 32;
const MAX_NAME_CHARS: usize = 48;
const MAX_EDIT_CELLS: usize = 2_000_000;
const SAVE_VERSION: u64 = 1;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlayerState {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

/// Enveloppe vérifiée à l'écriture. `seed` et les champs inconnus sont ignorés
/// volontairement : c'est le navigateur qui détient la vérité sur le format.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveEnvelope {
    version: u64,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    saved_at: i64,
    #[serde(default)]
    cells: Option<u64>,
    player: PlayerState,
    edits: Vec<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldMeta {
    pub slot: String,
    pub name: Option<String>,
    pub saved_at: i64,
    pub cells: Option<u64>,
    pub player: Option<PlayerState>,
    pub bytes: u64,
}

/// Le nom de monde devient un composant de chemin : lettres et chiffres sont
/// admis, accents compris (il vient du clavier du joueur), mais tout séparateur,
/// point ou deux-points est refusé — le slot ne peut donc pas sortir du dossier.
fn validate_slot(raw: &str) -> Result<String, String> {
    let slot = raw.trim().to_lowercase();
    if slot.is_empty() || slot.chars().count() > MAX_SLOT_LEN {
        return Err(format!("nom de monde refusé : {raw}"));
    }
    if !slot
        .chars()
        .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-'))
    {
        return Err(format!("nom de monde refusé : {raw}"));
    }
    Ok(slot)
}

fn worlds_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("dossier de données inaccessible : {e}"))?
        .join("worlds");
    fs::create_dir_all(&dir).map_err(|e| format!("impossible de créer le dossier : {e}"))?;
    Ok(dir)
}

fn save_path(dir: &Path, slot: &str) -> PathBuf {
    dir.join(format!("{slot}.json"))
}

/// Écrit puis renomme : `<monde>.json` ne contient jamais qu'un fichier complet,
/// soit l'ancien, soit le nouveau.
fn write_atomic(dir: &Path, file_name: &str, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("impossible de créer le dossier : {e}"))?;
    let tmp = dir.join(format!("{file_name}.{}.tmp", std::process::id()));
    let result = (|| {
        let mut handle = fs::File::create(&tmp).map_err(|e| format!("écriture impossible : {e}"))?;
        handle
            .write_all(bytes)
            .map_err(|e| format!("écriture impossible : {e}"))?;
        handle.sync_all().map_err(|e| format!("synchro impossible : {e}"))?;
        drop(handle);
        fs::rename(&tmp, dir.join(file_name)).map_err(|e| format!("remplacement impossible : {e}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Refuse tout ce qui ne ressemble pas au document produit par `saves.js` : un
/// bug côté JS ne doit pas pouvoir figer un monde illisible sur le disque.
fn check_payload(payload: &str) -> Result<SaveEnvelope, String> {
    let len = payload.len() as u64;
    if len == 0 {
        return Err("sauvegarde vide".to_string());
    }
    if len > MAX_SAVE_BYTES {
        return Err(format!("sauvegarde de {len} octets refusée (max {MAX_SAVE_BYTES})"));
    }
    let envelope: SaveEnvelope =
        serde_json::from_str(payload).map_err(|e| format!("sauvegarde mal formée : {e}"))?;
    if envelope.version != SAVE_VERSION {
        return Err(format!(
            "version de sauvegarde {n} non reconnue (attendu {SAVE_VERSION})",
            n = envelope.version
        ));
    }
    if envelope.edits.len() % 4 != 0 {
        return Err("liste de blocs tronquée (taille hors multiple de 4)".to_string());
    }
    if envelope.edits.len() / 4 > MAX_EDIT_CELLS {
        return Err(format!("trop de blocs modifiés (max {MAX_EDIT_CELLS})"));
    }
    let p = &envelope.player;
    if !(p.x.is_finite() && p.y.is_finite() && p.z.is_finite()) {
        return Err("position du joueur invalide".to_string());
    }
    if let Some(name) = &envelope.name {
        if name.chars().count() > MAX_NAME_CHARS {
            return Err(format!("nom de monde trop long (max {MAX_NAME_CHARS} caractères)"));
        }
    }
    Ok(envelope)
}

fn read_meta(dir: &Path, slot: &str) -> WorldMeta {
    let path = save_path(dir, slot);
    let bytes = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let mut saved_at = 0;
    let mut cells = None;
    let mut player = None;
    let mut name = None;
    if bytes > 0 && bytes <= LIST_SCAN_MAX_BYTES {
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(envelope) = serde_json::from_str::<SaveEnvelope>(&text) {
                saved_at = envelope.saved_at;
                cells = envelope.cells;
                name = envelope.name.filter(|n| !n.is_empty());
                player = Some(envelope.player);
            }
        }
    }
    WorldMeta {
        slot: slot.to_string(),
        name,
        saved_at,
        cells,
        player,
        bytes,
    }
}

#[tauri::command]
pub fn save_world(app: AppHandle, slot: String, payload: String) -> Result<u64, String> {
    let safe = validate_slot(&slot)?;
    let envelope = check_payload(&payload)?;
    let dir = worlds_dir(&app)?;
    // Le compte de cubes est redondant avec la taille du tableau ; on le recalcule
    // ici pour que la liste des mondes affiche une valeur sûre.
    let payload = with_cells(&payload, envelope.edits.len() / 4)?;
    write_atomic(&dir, &format!("{safe}.json"), payload.as_bytes())?;
    Ok(payload.len() as u64)
}

/// Relit le document tel qu'écrit, en réinjectant le compte de cubes corrigé.
/// Passer par Value évite d'imposer au navigateur un champ optionnel manquant.
fn with_cells(payload: &str, cells: usize) -> Result<String, String> {
    let mut value: serde_json::Value =
        serde_json::from_str(payload).map_err(|e| format!("sauvegarde mal formée : {e}"))?;
    value["cells"] = serde_json::Value::from(cells as u64);
    serde_json::to_string(&value).map_err(|e| format!("réencodage impossible : {e}"))
}

/// Rend `None` quand le monde n'existe pas encore : une première partie est le cas
/// normal, pas une erreur.
#[tauri::command]
pub fn load_world(app: AppHandle, slot: String) -> Result<Option<String>, String> {
    let safe = validate_slot(&slot)?;
    let path = save_path(&worlds_dir(&app)?, &safe);
    if !path.exists() {
        return Ok(None);
    }
    let meta = fs::metadata(&path).map_err(|e| format!("sauvegarde illisible : {e}"))?;
    if !meta.is_file() {
        return Err("sauvegarde : pas un fichier".to_string());
    }
    if meta.len() > MAX_SAVE_BYTES {
        return Err(format!(
            "sauvegarde de {} octets refusée (max {MAX_SAVE_BYTES})",
            meta.len()
        ));
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("sauvegarde illisible : {e}"))?;
    Ok(Some(text))
}

#[tauri::command]
pub fn clear_world(app: AppHandle, slot: String) -> Result<bool, String> {
    let safe = validate_slot(&slot)?;
    let path = save_path(&worlds_dir(&app)?, &safe);
    if !path.exists() {
        return Ok(false);
    }
    fs::remove_file(&path).map_err(|e| format!("suppression impossible : {e}"))?;
    Ok(true)
}

/// Tous les mondes enregistrés, du plus récent au plus ancien. Les fichiers
/// temporaires d'une écriture en cours sont écartés d'office (seuls les noms
/// `<slot>.json` avec un slot valide sont retenus).
#[tauri::command]
pub fn list_worlds(app: AppHandle) -> Result<Vec<WorldMeta>, String> {
    let dir = worlds_dir(&app)?;
    let mut metas = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let Some(raw) = entry.file_name().to_str().map(|s| s.to_string()) else {
            continue;
        };
        let Some(slot) = raw.strip_suffix(".json") else { continue };
        if slot.is_empty() || slot != validate_slot(slot).unwrap_or_default() {
            continue;
        }
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        metas.push(read_meta(&dir, &slot));
    }
    metas.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    Ok(metas)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAVE: &str = r#"{"version":1,"seed":{"terrain":42},"name":"Village du lac","savedAt":1700000000000,"cells":1,"player":{"x":8.5,"y":40.0,"z":8.5},"edits":[1,2,3,9]}"#;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mycraft-world-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn noms_de_monde_acceptes() {
        assert_eq!(validate_slot("default").unwrap(), "default");
        assert_eq!(validate_slot("  default  ").unwrap(), "default");
        assert_eq!(validate_slot("Sauvegarde-2").unwrap(), "sauvegarde-2");
        // Le nom saisi au clavier peut être accentué : il doit rester utilisable
        // comme nom de fichier.
        assert_eq!(validate_slot("Château-du-Lac").unwrap(), "château-du-lac");
        assert_eq!(validate_slot(&"a".repeat(MAX_SLOT_LEN)).unwrap().chars().count(), MAX_SLOT_LEN);
    }

    #[test]
    fn noms_de_monde_refuses() {
        for raw in [
            "",
            "   ",
            "../evil",
            "..",
            "a/b",
            "a\\b",
            "été.png",
            "with space",
            "x:",
            "a.b",
            "a".repeat(MAX_SLOT_LEN + 1).as_str(),
        ] {
            assert!(validate_slot(raw).is_err(), "« {raw} » aurait dû être refusé");
        }
    }

    #[test]
    fn payload_valide_accepte() {
        let envelope = check_payload(SAVE).expect("document valide accepté");
        assert_eq!(envelope.edits.len(), 4);
        assert_eq!(envelope.saved_at, 1_700_000_000_000);
        assert!((envelope.player.y - 40.0).abs() < f64::EPSILON);
    }

    #[test]
    fn payloads_invalides_refuses() {
        for raw in [
            "",
            "   ",
            "[1,2,3]",
            "bloc de texte",
            "{\"version\":1,\"edits\":[1,2,3],\"player\":{\"x\":0,\"y\":0,\"z\":0}}",
            "{\"version\":2,\"edits\":[],\"player\":{\"x\":0,\"y\":0,\"z\":0}}",
            "{\"version\":1,\"edits\":[],\"player\":{\"x\":null,\"y\":0,\"z\":0}}",
            "{\"version\":1,\"edits\":[]}",
        ] {
            assert!(check_payload(raw).is_err(), "« {raw} » aurait dû être refusé");
        }
    }

    #[test]
    fn payload_trop_gros_refuse() {
        // Le contrôle de taille précède tout parsing : un simple remplissage suffit
        // à dépasser le plafond sans se ruiner en allocation.
        let huge = format!(
            "{{\"version\":1,\"savedAt\":0,\"player\":{{\"x\":0,\"y\":0,\"z\":0}},\"pad\":\"{}\",\"edits\":[]}}",
            "x".repeat(MAX_SAVE_BYTES as usize)
        );
        assert!(check_payload(&huge).is_err());
    }

    #[test]
    fn nom_de_monde_trop_long_refuse() {
        let long = "é".repeat(MAX_NAME_CHARS + 1);
        let payload = format!(
            "{{\"version\":1,\"name\":\"{long}\",\"savedAt\":0,\"player\":{{\"x\":0,\"y\":0,\"z\":0}},\"edits\":[]}}"
        );
        assert!(check_payload(&payload).is_err(), "un nom de {} caractères aurait dû être refusé", MAX_NAME_CHARS + 1);

        let ok = "é".repeat(MAX_NAME_CHARS);
        let valid = format!(
            "{{\"version\":1,\"name\":\"{ok}\",\"savedAt\":0,\"player\":{{\"x\":0,\"y\":0,\"z\":0}},\"edits\":[]}}"
        );
        assert!(check_payload(&valid).is_ok(), "un nom de {MAX_NAME_CHARS} caractères devait passer");
    }

    #[test]
    fn compte_de_blocs_recalcule_avant_ecriture() {
        let rewritten = with_cells(SAVE, 7).unwrap();
        assert!(rewritten.contains("\"cells\":7"), "{rewritten}");
    }

    #[test]
    fn ecriture_atomique_laisse_un_fichier_complet() {
        let dir = tmp_dir("roundtrip");
        write_atomic(&dir, "monde.json", SAVE.as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(dir.join("monde.json")).unwrap(), SAVE);
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "un fichier temporaire traîne : {leftovers:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reecriture_remplace_le_contenu() {
        let dir = tmp_dir("overwrite");
        write_atomic(&dir, "monde.json", SAVE.as_bytes()).unwrap();
        write_atomic(&dir, "monde.json", b"{\"version\":1}").unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("monde.json")).unwrap(),
            "{\"version\":1}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn metadonnees_lues_depuis_le_fichier() {
        let dir = tmp_dir("meta");
        write_atomic(&dir, "herbe.json", SAVE.as_bytes()).unwrap();
        let meta = read_meta(&dir, "herbe");
        assert_eq!(meta.slot, "herbe");
        assert_eq!(meta.saved_at, 1_700_000_000_000);
        assert_eq!(meta.cells, Some(1));
        assert_eq!(meta.bytes, SAVE.len() as u64);
        assert_eq!(meta.name.as_deref(), Some("Village du lac"));
        let player = meta.player.expect("position présente");
        assert!((player.x - 8.5).abs() < f64::EPSILON);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn metadonnees_d_un_fichier_illisible_ne_bloquent_pas() {
        let dir = tmp_dir("meta-casse");
        write_atomic(&dir, "casse.json", b"{ ceci n'est pas du json").unwrap();
        let meta = read_meta(&dir, "casse");
        assert_eq!(meta.saved_at, 0);
        assert_eq!(meta.cells, None);
        assert!(meta.player.is_none());
        assert!(meta.bytes > 0);
        let _ = fs::remove_dir_all(&dir);
    }
}
