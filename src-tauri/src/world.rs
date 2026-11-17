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
    effacer_monde(&worlds_dir(&app)?, &safe)
}

/// Efface le monde **et** ses deux caches : un cache orphelin survivrait à la
/// suppression et serait relu sous un monde neuf portant le même nom. Renvoie vrai
/// si le fichier de sauvegarde existait (les caches, eux, sont facultatifs).
fn effacer_monde(dir: &Path, slot: &str) -> Result<bool, String> {
    let path = save_path(dir, slot);
    let ile = island_path(dir, slot);
    let geom = geom_path(dir, slot);
    let existait = path.exists();
    if ile.exists() {
        fs::remove_file(&ile).map_err(|e| format!("cache d’île non supprimé : {e}"))?;
    }
    if geom.exists() {
        fs::remove_file(&geom).map_err(|e| format!("cache de géométrie non supprimé : {e}"))?;
    }
    if !existait {
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

// ---- cache d'île -----------------------------------------------------------
//
// Le cache d'île est le terrain préfabriqué : un fichier binaire comprimé, gros par
// nature (des dizaines de mégaoctets pour une île entière), que le jeu relit au lieu
// de régénérer neuf minutes de bruit. Son contenu ne regarde pas le magasin : c'est
// `ile.js` qui en détient le format et sait dire pourquoi un fichier ne convient pas.
// Ici on ne contrôle que la signature — assez pour qu'un bug JS n'écrive pas vingt
// mégaoctets de bruit à la place du terrain, pas assez pour faire deux juges du même
// format.

/// Extension du fichier jumeau de `<slot>.json`, dans le même dossier.
const ISLAND_EXT: &str = ".ile.bin";
/// Garde-fou contre une boucle de bug, pas une limite d'usage : l'île entière du monde
/// par défaut tient en quelques dizaines de mégaoctets comprimés.
const MAX_ISLAND_BYTES: u64 = 256 * 1024 * 1024;
const ISLAND_MAGIC: &[u8] = b"MCI1";
const ISLAND_VERSION: u8 = 1;
/// Ce que lit `island_meta` : les clés d'en-tête sont toutes au début du fichier (le
/// JSON de tête précède le corps comprimé), relire le reste ne servirait à rien.
const ISLAND_META_WINDOW: usize = 8 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IslandMeta {
    pub bytes: u64,
    pub codec: Option<String>,
    pub cree_at: i64,
    pub invalide: bool,
}

fn island_path(dir: &Path, slot: &str) -> PathBuf {
    dir.join(format!("{slot}{ISLAND_EXT}"))
}

/// Le binaire voyage en base64 parce que les commandes Tauri échangent des chaînes :
/// transiter 21 Mo par un tableau JSON d'entiers coûtait bien plus cher. Les blancs
/// éventuels sont ignorés — une chaîne recopiée à la main peut en porter.
fn decode_base64(texte: &str) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let propre: String = texte.chars().filter(|c| !c.is_whitespace()).collect();
    STANDARD
        .decode(propre.as_bytes())
        .map_err(|e| format!("cache d’île mal encodé : {e}"))
}

fn encode_base64(bytes: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD.encode(bytes)
}

/// Ne vérifie que la poignée d'octets qui dit si ce fichier peut être un cache. La
/// lecture, elle, n'impose rien : `CacheIle` rend un motif précis au joueur, et un
/// magasin qui trierait ses propres fichiers les rendrait indestructibles.
fn check_island(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 > MAX_ISLAND_BYTES {
        return Err(format!(
            "cache d’île de {} octets refusé (max {MAX_ISLAND_BYTES})",
            bytes.len()
        ));
    }
    if bytes.len() < 9 {
        return Err("cache d’île trop court pour porter son en-tête".to_string());
    }
    if &bytes[..4] != ISLAND_MAGIC {
        return Err("cache d’île sans signature MCI1".to_string());
    }
    if bytes[4] != ISLAND_VERSION {
        return Err(format!(
            "version de cache {n} non reconnue (attendu {ISLAND_VERSION})",
            n = bytes[4]
        ));
    }
    Ok(())
}

/// En-tête lu sans toucher au corps : `magic` | version | u32 longueur LE | JSON.
/// Une fenêtre tronquée laisse les champs vides sans déclarer le fichier invalide —
/// seule la signature l'est jamais. Partagé par les deux caches binaires (île, géométrie).
fn decrire_en_tete_cache(
    octets: &[u8],
    taille_fichier: u64,
    magic: &[u8],
    version: u8,
) -> IslandMeta {
    let signature_ok = octets.len() >= 9 && &octets[..4] == magic && octets[4] == version;
    let mut codec = None;
    let mut cree_at = 0;
    if octets.len() >= 9 {
        let longueur = u32::from_le_bytes([octets[5], octets[6], octets[7], octets[8]]) as usize;
        if 9 + longueur <= octets.len() {
            if let Ok(entete) = serde_json::from_slice::<serde_json::Value>(&octets[9..9 + longueur])
            {
                codec = entete
                    .get("codec")
                    .and_then(|c| c.as_str())
                    .map(|s| s.to_string());
                cree_at = entete.get("cree").and_then(|c| c.as_i64()).unwrap_or(0);
            }
        }
    }
    IslandMeta {
        bytes: taille_fichier,
        codec,
        cree_at,
        invalide: !signature_ok,
    }
}

#[tauri::command]
pub fn save_island(app: AppHandle, slot: String, payload: String) -> Result<u64, String> {
    let safe = validate_slot(&slot)?;
    let bytes = decode_base64(&payload)?;
    check_island(&bytes)?;
    let dir = worlds_dir(&app)?;
    write_atomic(&dir, &format!("{safe}{ISLAND_EXT}"), &bytes)?;
    Ok(bytes.len() as u64)
}

/// Rend `None` quand il n'y a pas de cache : c'est le premier lancement, pas une
/// erreur. Un fichier présent est rendu tel quel, même vérolé — le jeu saura le refuser
/// en nommant le motif, et le joueur pourra encore l'effacer.
#[tauri::command]
pub fn load_island(app: AppHandle, slot: String) -> Result<Option<String>, String> {
    let safe = validate_slot(&slot)?;
    let path = island_path(&worlds_dir(&app)?, &safe);
    if !path.exists() {
        return Ok(None);
    }
    let meta = fs::metadata(&path).map_err(|e| format!("cache d’île illisible : {e}"))?;
    if !meta.is_file() {
        return Err("cache d’île : pas un fichier".to_string());
    }
    if meta.len() > MAX_ISLAND_BYTES {
        return Err(format!(
            "cache d’île de {} octets refusé (max {MAX_ISLAND_BYTES})",
            meta.len()
        ));
    }
    let bytes = fs::read(&path).map_err(|e| format!("cache d’île illisible : {e}"))?;
    Ok(Some(encode_base64(&bytes)))
}

#[tauri::command]
pub fn clear_island(app: AppHandle, slot: String) -> Result<bool, String> {
    let safe = validate_slot(&slot)?;
    let path = island_path(&worlds_dir(&app)?, &safe);
    if !path.exists() {
        return Ok(false);
    }
    fs::remove_file(&path).map_err(|e| format!("suppression impossible : {e}"))?;
    Ok(true)
}

#[tauri::command]
pub fn island_meta(app: AppHandle, slot: String) -> Result<Option<IslandMeta>, String> {
    let safe = validate_slot(&slot)?;
    let path = island_path(&worlds_dir(&app)?, &safe);
    let meta = match fs::metadata(&path) {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };
    if !meta.is_file() {
        return Ok(None);
    }
    let fenetre = (meta.len() as usize).min(ISLAND_META_WINDOW);
    let mut tampon = vec![0u8; fenetre];
    // Une lecture qui échoue rend 0 octet : la description tombe alors sur
    // `invalide`, qui est exactement ce que le joueur doit voir.
    let lus = (|| -> Result<usize, String> {
        use std::io::Read;
        let mut fichier = fs::File::open(&path).map_err(|e| format!("cache d’île illisible : {e}"))?;
        fichier
            .read(&mut tampon)
            .map_err(|e| format!("cache d’île illisible : {e}"))
    })()
    .unwrap_or(0);
    Ok(Some(decrire_en_tete_cache(
        &tampon[..lus],
        meta.len(),
        ISLAND_MAGIC,
        ISLAND_VERSION,
    )))
}

// ---- cache de géométrie ------------------------------------------------------
// Le fichier jumeau qui porte les tampons sommets déjà dans la forme voulue par la carte
// graphique (`public/js/geom-disque.js`). Le magasin ne juge que la signature et la
// taille : c'est le jeu qui sait si un bloc décrit encore son monde.
const GEOM_EXT: &str = ".geom.bin";
/// Le plafond doit couvrir le plus grand budget promis au joueur (2 Go dans
/// `GEOM_BUDGETS_MO`) plus l'en-tête et ses tables : à 384 Mo, le réglage par défaut
/// du client (1 Go) se heurtait à un refus du magasin. Même valeur que `server.js`.
const MAX_GEOM_BYTES: u64 = 2304 * 1024 * 1024;
const GEOM_MAGIC: &[u8] = b"MCG1";
/// Doit bouger **avec** `GEOM_VERSION` de `public/js/geom-disque.js` et celui de
/// `server.js` : à 1 contre 2 côté client, tout cache v2 était refusé à l'écriture et
/// le bureau rejouait le monde depuis le mailleur, sans jamais rien garder.
const GEOM_VERSION: u8 = 2;

/// Même description que le cache d'île — codec, date, validité de signature.
pub type GeomMeta = IslandMeta;

fn geom_path(dir: &Path, slot: &str) -> PathBuf {
    dir.join(format!("{slot}{GEOM_EXT}"))
}

fn check_geom(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 > MAX_GEOM_BYTES {
        return Err(format!(
            "cache de géométrie de {} octets refusé (max {MAX_GEOM_BYTES})",
            bytes.len()
        ));
    }
    if bytes.len() < 9 {
        return Err("cache de géométrie trop court pour porter son en-tête".to_string());
    }
    if &bytes[..4] != GEOM_MAGIC {
        return Err("cache de géométrie sans signature MCG1".to_string());
    }
    if bytes[4] != GEOM_VERSION {
        return Err(format!(
            "version de cache {n} non reconnue (attendu {GEOM_VERSION})",
            n = bytes[4]
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn save_geometry(app: AppHandle, slot: String, payload: String) -> Result<u64, String> {
    let safe = validate_slot(&slot)?;
    let bytes = decode_base64(&payload)?;
    check_geom(&bytes)?;
    let dir = worlds_dir(&app)?;
    write_atomic(&dir, &format!("{safe}{GEOM_EXT}"), &bytes)?;
    Ok(bytes.len() as u64)
}

/// `None` quand il n'y a pas encore de cache : le premier lancement, pas une erreur.
#[tauri::command]
pub fn load_geometry(app: AppHandle, slot: String) -> Result<Option<String>, String> {
    let safe = validate_slot(&slot)?;
    let path = geom_path(&worlds_dir(&app)?, &safe);
    if !path.exists() {
        return Ok(None);
    }
    let meta = fs::metadata(&path).map_err(|e| format!("cache de géométrie illisible : {e}"))?;
    if !meta.is_file() {
        return Err("cache de géométrie : pas un fichier".to_string());
    }
    if meta.len() > MAX_GEOM_BYTES {
        return Err(format!(
            "cache de géométrie de {} octets refusé (max {MAX_GEOM_BYTES})",
            meta.len()
        ));
    }
    let bytes = fs::read(&path).map_err(|e| format!("cache de géométrie illisible : {e}"))?;
    Ok(Some(encode_base64(&bytes)))
}

#[tauri::command]
pub fn clear_geometry(app: AppHandle, slot: String) -> Result<bool, String> {
    let safe = validate_slot(&slot)?;
    let path = geom_path(&worlds_dir(&app)?, &safe);
    if !path.exists() {
        return Ok(false);
    }
    fs::remove_file(&path).map_err(|e| format!("suppression impossible : {e}"))?;
    Ok(true)
}

#[tauri::command]
pub fn geometry_meta(app: AppHandle, slot: String) -> Result<Option<GeomMeta>, String> {
    let safe = validate_slot(&slot)?;
    let path = geom_path(&worlds_dir(&app)?, &safe);
    let meta = match fs::metadata(&path) {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };
    if !meta.is_file() {
        return Ok(None);
    }
    let fenetre = (meta.len() as usize).min(ISLAND_META_WINDOW);
    let mut tampon = vec![0u8; fenetre];
    let lus = (|| -> Result<usize, String> {
        use std::io::Read;
        let mut fichier =
            fs::File::open(&path).map_err(|e| format!("cache de géométrie illisible : {e}"))?;
        fichier
            .read(&mut tampon)
            .map_err(|e| format!("cache de géométrie illisible : {e}"))
    })()
    .unwrap_or(0);
    Ok(Some(decrire_en_tete_cache(
        &tampon[..lus],
        meta.len(),
        GEOM_MAGIC,
        GEOM_VERSION,
    )))
}

/// Voie binaire du cache de triangles.
///
/// Tauri n'envoie des octets bruts que quand la charge utile d'`invoke` **est** le tampon
/// (`process-ipc-message-fn.js` ne regarde que le payload et pose alors
/// `Content-Type: application/octet-stream`) ; dès que le payload est un objet, tout part
/// en `JSON.stringify` et un `Uint8Array` niché devient `Array.from(...)` — quatre fois
/// plus d'octets et une conversion sur le fil principal. Les paramètres ne peuvent donc
/// pas voyager à côté du binaire : ils sont encadrés **devant** lui. Le format est décrit
/// et commenté dans `public/js/geom-cadre.js`, qui le partage avec les suites ; les deux
/// côtés se jugent sur les mêmes vecteurs dorés.
///
/// Pourquoi cette voie existe : sans elle, le bureau ne connaît que la réécriture
/// complète. Mesuré le 2026-11-17, chaque publication y encodait le fichier entier en
/// base64 sur le fil principal — 218 ms à 50 Mo, 433 ms à 100 Mo, et l'écriture était
/// même refusée par la version de format. Le joueur décrivait exactement cela : « il y a
/// des saccades, ce n'est pas fluide comme sur mon PC Linux ».
pub mod brut {
    use super::*;
    use std::io::{Read, Seek, SeekFrom, Write};
    use tauri::ipc::{InvokeBody, Request, Response};

    const CADRE_MAGIC: &[u8; 4] = b"MCGF";
    const CADRE_VERSION: u8 = 1;
    const TETE_REQUETE: usize = 32;
    const TETE_REPONSE: usize = 24;

    pub const OP_SONDER: u8 = 0;
    pub const OP_LIRE: u8 = 1;
    pub const OP_ECRIRE: u8 = 2;
    pub const OP_AJOUTER: u8 = 3;
    pub const OP_POSER_TETE: u8 = 4;
    pub const OP_MIGRER: u8 = 5;

    const STATUT_OK: u8 = 0;
    const STATUT_CONFLIT: u8 = 1;
    const STATUT_ERREUR: u8 = 2;

    /// magic(4) + version(1) + tailleTete(4), comme le client et le serveur web.
    const EN_TETE_FIXE: usize = 9;
    /// La table de toute l'île fait ~4 Mo ; au-delà de 64 c'est une erreur, pas un usage.
    const TETE_MAX_BYTES: usize = 64 * 1024 * 1024;
    const MORCEAU_COPIE: usize = 8 * 1024 * 1024;
    const TABLE_GEOM: &[u8] = b"\"entrees\":[";
    const PIED: [u8; 2] = [b']', b'}'];

    /// Un désaccord sur l'état du disque n'est pas une panne : prévenu par `conflit`, le
    /// jeu change de voie (réécriture complète) au lieu d'interrompre la publication.
    #[derive(Debug)]
    pub struct Ecart {
        pub conflit: bool,
        pub motif: String,
    }

    impl Ecart {
        fn conflit(motif: &str) -> Self {
            Self { conflit: true, motif: motif.to_string() }
        }
        fn erreur(motif: impl Into<String>) -> Self {
            Self { conflit: false, motif: motif.into() }
        }
    }

    type Verdict = Result<u64, Ecart>;

    pub struct Cadre<'a> {
        pub op: u8,
        pub slot: String,
        pub a: u64,
        pub b: u64,
        pub corps: &'a [u8],
    }

    fn lire_u64(brut: &[u8], o: usize) -> u64 {
        let mut tampon = [0u8; 8];
        tampon.copy_from_slice(&brut[o..o + 8]);
        u64::from_le_bytes(tampon)
    }

    fn poser_u64(brut: &mut [u8], o: usize, valeur: u64) {
        brut[o..o + 8].copy_from_slice(&valeur.to_le_bytes());
    }

    pub fn lire_requete(brut: &[u8]) -> Result<Cadre<'_>, String> {
        if brut.len() < TETE_REQUETE {
            return Err(format!("trame trop courte ({} o)", brut.len()));
        }
        if &brut[..4] != CADRE_MAGIC {
            return Err("trame sans signature MCGF".to_string());
        }
        if brut[4] != CADRE_VERSION {
            return Err(format!("version de trame {} non reconnue", brut[4]));
        }
        let longueur_nom = u16::from_le_bytes([brut[6], brut[7]]) as usize;
        if longueur_nom == 0 || longueur_nom > MAX_SLOT_LEN {
            return Err(format!("longueur de nom invraisemblable ({longueur_nom})"));
        }
        let fin_nom = TETE_REQUETE + longueur_nom;
        if brut.len() < fin_nom {
            return Err("nom de monde tronqué".to_string());
        }
        let slot = std::str::from_utf8(&brut[TETE_REQUETE..fin_nom])
            .map_err(|e| format!("nom de monde non UTF-8 : {e}"))?
            .to_string();
        Ok(Cadre {
            op: brut[5],
            slot,
            a: lire_u64(brut, 8),
            b: lire_u64(brut, 16),
            corps: &brut[fin_nom..],
        })
    }

    pub fn construire_reponse(op: u8, statut: u8, a: u64, b: u64, corps: &[u8]) -> Vec<u8> {
        let mut reponse = vec![0u8; TETE_REPONSE + corps.len()];
        reponse[..4].copy_from_slice(CADRE_MAGIC);
        reponse[4] = CADRE_VERSION;
        reponse[5] = op;
        reponse[6] = statut;
        poser_u64(&mut reponse, 8, a);
        poser_u64(&mut reponse, 16, b);
        reponse[TETE_REPONSE..].copy_from_slice(corps);
        reponse
    }

    /// Même garde que `looksLikeGeom` du serveur web : signature, version, et en-tête qui
    /// tient dans ce qu'on prétend être l'en-tête.
    fn ressemble_a_cache(octets: &[u8]) -> bool {
        if octets.len() < EN_TETE_FIXE || octets.len() as u64 > MAX_GEOM_BYTES {
            return false;
        }
        if &octets[..4] != GEOM_MAGIC || octets[4] != GEOM_VERSION {
            return false;
        }
        let tete = u32::from_le_bytes([octets[5], octets[6], octets[7], octets[8]]) as usize;
        tete > 0 && EN_TETE_FIXE + tete <= octets.len()
    }

    fn taille(chemin: &Path) -> Option<u64> {
        fs::metadata(chemin).ok().filter(|m| m.is_file()).map(|m| m.len())
    }

    /// Écrit à poste fixe sans jamais tronquer : `write_all` après `seek` boucle sur les
    /// écritures partielles, ce que `fs::write` ne sait pas faire ici.
    fn ecrire_en_vers(chemin: &Path, octets: &[u8], position: u64) -> Result<(), String> {
        let mut fichier = fs::OpenOptions::new()
            .write(true)
            .open(chemin)
            .map_err(|e| format!("écriture impossible : {e}"))?;
        fichier
            .seek(SeekFrom::Start(position))
            .map_err(|e| format!("placement impossible : {e}"))?;
        fichier
            .write_all(octets)
            .map_err(|e| format!("écriture interrompue : {e}"))?;
        fichier.sync_all().map_err(|e| format!("synchro impossible : {e}"))
    }

    /// `None` = pas encore de cache, ce qui n'est pas une erreur.
    pub fn lire_fichier(chemin: &Path) -> Result<Option<Vec<u8>>, Ecart> {
        match taille(chemin) {
            None => Ok(None),
            Some(n) if n > MAX_GEOM_BYTES => Err(Ecart::erreur(format!(
                "cache de géométrie de {n} octets refusé (max {MAX_GEOM_BYTES})"
            ))),
            Some(_) => fs::read(chemin)
                .map(Some)
                .map_err(|e| Ecart::erreur(format!("cache de géométrie illisible : {e}"))),
        }
    }

    pub fn ecrire_fichier(dir: &Path, slot: &str, octets: &[u8]) -> Verdict {
        check_geom(octets).map_err(Ecart::erreur)?;
        write_atomic(dir, &format!("{slot}{GEOM_EXT}"), octets).map_err(Ecart::erreur)?;
        Ok(octets.len() as u64)
    }

    /// Colle des blocs à la fin, à condition que le fichier mesure exactement ce que le
    /// jeu croit : c'est la seule garde contre deux onglets écrivant le même monde.
    pub fn ajouter_blocs(chemin: &Path, base: u64, octets: &[u8]) -> Verdict {
        if base < EN_TETE_FIXE as u64 {
            return Err(Ecart::conflit("taille de base invalide"));
        }
        let existante = taille(chemin).ok_or_else(|| Ecart::conflit("aucun fichier à prolonger"))?;
        if existante != base {
            return Err(Ecart::conflit("taille divergente"));
        }
        if base + octets.len() as u64 > MAX_GEOM_BYTES {
            return Err(Ecart::conflit("cache trop volumineux"));
        }
        ecrire_en_vers(chemin, octets, base).map_err(Ecart::erreur)?;
        Ok(base + octets.len() as u64)
    }

    /// Repose l'en-tête. Par cette voie le client ne peut toucher **que** la région
    /// réservée : la signature et le pied `]}` restent intouchables.
    pub fn poser_tete(chemin: &Path, offset: u64, octets: &[u8]) -> Verdict {
        let existante = taille(chemin).ok_or_else(|| Ecart::erreur("aucun fichier à compléter"))?;
        if existante < EN_TETE_FIXE as u64 {
            return Err(Ecart::conflit("fichier trop court"));
        }
        let mut entete = [0u8; EN_TETE_FIXE];
        fs::File::open(chemin)
            .and_then(|mut f| f.read_exact(&mut entete))
            .map_err(|e| Ecart::erreur(format!("en-tête illisible : {e}")))?;
        let region = EN_TETE_FIXE + u32::from_le_bytes([entete[5], entete[6], entete[7], entete[8]]) as usize;
        if existante < region as u64 {
            return Err(Ecart::conflit("fichier trop court pour cet en-tête"));
        }
        if offset == 0 {
            if !ressemble_a_cache(octets) {
                return Err(Ecart::conflit("en-tête invalide"));
            }
            if u32::from_le_bytes([octets[5], octets[6], octets[7], octets[8]]) as usize
                != region - EN_TETE_FIXE
            {
                return Err(Ecart::conflit("gabarit d’en-tête différent"));
            }
            if octets.len() != region {
                return Err(Ecart::conflit("longueur d’en-tête inattendue"));
            }
        } else {
            if offset < EN_TETE_FIXE as u64 {
                return Err(Ecart::conflit("la signature de tête est protégée"));
            }
            if offset + octets.len() as u64 > region as u64 {
                return Err(Ecart::conflit("hors de la région d’en-tête"));
            }
        }
        ecrire_en_vers(chemin, octets, offset).map_err(Ecart::erreur)?;
        Ok(octets.len() as u64)
    }

    /// Rattrape un ancien gabarit d'en-tête sans que le jeu ait à renvoyer son corps :
    /// ces octets sont déjà sur ce disque, on les copie ici. Gardes identiques à
    /// `POST /world-geometry/migrer` du serveur web — les deux magasins doivent rendre
    /// le même verdict au même fichier.
    pub fn migrer_corps(chemin: &Path, attendu: u64, debut: u64, table: &[u8]) -> Verdict {
        let region = table.len();
        if attendu < (EN_TETE_FIXE + 16) as u64 {
            return Err(Ecart::conflit("taille de fichier attendue invalide"));
        }
        // Le corps reçu EST l'en-tête complet : il doit mesurer exactement ce qu'il annonce.
        if debut != region as u64 {
            return Err(Ecart::conflit("en-tête reçu incohérent avec le décalage annoncé"));
        }
        if region < 32 || region > TETE_MAX_BYTES {
            return Err(Ecart::conflit("table de décalages invraisemblable"));
        }
        if !ressemble_a_cache(table) {
            return Err(Ecart::conflit("en-tête de cache invalide"));
        }
        // Pied vérifié sur les deux derniers octets : surtout pas de regex ni de `trim_end`
        // sur les espaces de bourrage (mesuré côté serveur : 70 % de CPU sans réponse).
        if table[region - 2] != PIED[0] || table[region - 1] != PIED[1] {
            return Err(Ecart::conflit("table de décalages sans pied"));
        }
        if region < TABLE_GEOM.len() || !table.windows(TABLE_GEOM.len()).any(|f| f == TABLE_GEOM) {
            return Err(Ecart::conflit("table de décalages mal formée"));
        }
        let existante = taille(chemin).ok_or_else(|| Ecart::conflit("aucun cache à migrer"))?;
        if existante != attendu {
            return Err(Ecart::conflit("taille divergente"));
        }
        let mut entete = [0u8; EN_TETE_FIXE];
        fs::File::open(chemin)
            .and_then(|mut f| f.read_exact(&mut entete))
            .map_err(|e| Ecart::erreur(format!("lecture impossible : {e}")))?;
        if &entete[..4] != GEOM_MAGIC {
            return Err(Ecart::conflit("signature de cache absente"));
        }
        if entete[4] != GEOM_VERSION {
            return Err(Ecart::conflit("version de cache inconnue"));
        }
        let ancien_debut =
            EN_TETE_FIXE as u64 + u32::from_le_bytes([entete[5], entete[6], entete[7], entete[8]]) as u64;
        if ancien_debut <= EN_TETE_FIXE as u64 || ancien_debut >= attendu {
            return Err(Ecart::conflit("corps de cache vide"));
        }
        let nouveau = debut + (attendu - ancien_debut);
        if nouveau > MAX_GEOM_BYTES {
            return Err(Ecart::conflit("cache trop volumineux"));
        }

        let tmp = PathBuf::from(format!("{}.{}.migr.tmp", chemin.display(), std::process::id()));
        let a_copier = attendu - ancien_debut;
        let copie = (|| -> Result<(), String> {
            let mut source = fs::File::open(chemin).map_err(|e| format!("lecture impossible : {e}"))?;
            let mut cible = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&tmp)
                .map_err(|e| format!("écriture impossible : {e}"))?;
            cible.set_len(nouveau).map_err(|e| format!("préallocation impossible : {e}"))?;
            let mut tampon = vec![0u8; MORCEAU_COPIE.min(a_copier.max(1) as usize)];
            let mut fait = 0u64;
            while fait < a_copier {
                let vouloir = (a_copier - fait).min(MORCEAU_COPIE as u64) as usize;
                source
                    .seek(SeekFrom::Start(ancien_debut + fait))
                    .map_err(|e| format!("placement impossible : {e}"))?;
                let lus = source
                    .read(&mut tampon[..vouloir])
                    .map_err(|e| format!("copie interrompue : {e}"))?;
                if lus == 0 {
                    return Err(format!("copie interrompue à {fait}/{a_copier} octets"));
                }
                cible
                    .seek(SeekFrom::Start(debut + fait))
                    .map_err(|e| format!("placement impossible : {e}"))?;
                cible
                    .write_all(&tampon[..lus])
                    .map_err(|e| format!("copie interrompue : {e}"))?;
                fait += lus as u64;
            }
            cible
                .seek(SeekFrom::Start(0))
                .map_err(|e| format!("placement impossible : {e}"))?;
            cible.write_all(table).map_err(|e| format!("copie interrompue : {e}"))?;
            cible.sync_all().map_err(|e| format!("synchro impossible : {e}"))
        })();
        if let Err(motif) = copie {
            let _ = fs::remove_file(&tmp);
            return Err(Ecart::erreur(motif));
        }
        // On ne remplace le fichier que si le candidat se présente bien.
        let valide = (|| -> Result<bool, String> {
            let mut candidat = [0u8; EN_TETE_FIXE];
            fs::File::open(&tmp)
                .and_then(|mut f| f.read_exact(&mut candidat))
                .map_err(|e| e.to_string())?;
            if candidat != entete_table(table) {
                return Err("tête du candidat différente".to_string());
            }
            if taille(&tmp) != Some(nouveau) {
                return Err("taille du candidat différente".to_string());
            }
            Ok(true)
        })();
        if valide.is_err() {
            let _ = fs::remove_file(&tmp);
            return Err(Ecart::erreur(valide.unwrap_err()));
        }
        fs::rename(&tmp, chemin).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            Ecart::erreur(format!("remplacement impossible : {e}"))
        })?;
        Ok(nouveau)
    }

    fn entete_table(table: &[u8]) -> [u8; EN_TETE_FIXE] {
        let mut entete = [0u8; EN_TETE_FIXE];
        entete.copy_from_slice(&table[..EN_TETE_FIXE]);
        entete
    }

    /// Unique porte d'entrée binaire. Une requête venue par la voie JSON (le repli
    /// `postMessage` de Tauri, ou Android) est refusée : le jeu l'apprend et reprend sa
    /// voie base64, qui reste en place précisément pour ce cas.
    #[tauri::command]
    pub fn geom_brut(app: AppHandle, request: Request<'_>) -> Result<Response, String> {
        let brut: &[u8] = match request.body() {
            InvokeBody::Raw(octets) => octets.as_slice(),
            InvokeBody::Json(_) => {
                return Err("corps attendu en octets bruts — la voie JSON est refusée".to_string())
            }
        };
        let cadre = lire_requete(brut).map_err(|e| format!("trame illisible : {e}"))?;
        let slot = validate_slot(&cadre.slot)?;
        let dir = worlds_dir(&app)?;
        let chemin = geom_path(&dir, &slot);

        let (statut, a, corps): (u8, u64, Vec<u8>) = match cadre.op {
            OP_SONDER => (STATUT_OK, 1, Vec::new()),
            OP_LIRE => match lire_fichier(&chemin) {
                Ok(Some(octets)) => {
                    let n = octets.len() as u64;
                    (STATUT_OK, n, octets)
                }
                Ok(None) => (STATUT_OK, 0, Vec::new()),
                Err(e) => (si_statut(&e), 0, Vec::new()),
            },
            OP_ECRIRE => vers_statut(ecrire_fichier(&dir, &slot, cadre.corps)),
            OP_AJOUTER => vers_statut(ajouter_blocs(&chemin, cadre.a, cadre.corps)),
            OP_POSER_TETE => vers_statut(poser_tete(&chemin, cadre.a, cadre.corps)),
            OP_MIGRER => vers_statut(migrer_corps(&chemin, cadre.a, cadre.b, cadre.corps)),
            autre => return Err(format!("opération inconnue : {autre}")),
        };
        Ok(Response::new(construire_reponse(cadre.op, statut, a, 0, &corps)))
    }

    fn si_statut(ecart: &Ecart) -> u8 {
        if ecart.conflit { STATUT_CONFLIT } else { STATUT_ERREUR }
    }

    fn vers_statut(verdict: Verdict) -> (u8, u64, Vec<u8>) {
        match verdict {
            Ok(n) => (STATUT_OK, n, Vec::new()),
            Err(e) => {
                // La trame de réponse ne porte qu'un octet de statut : sans cette trace, un
                // refus du disque arrive au jeu comme un conflit sec et personne ne voit si
                // c'est une taille divergente, le plafond ou le pied de table qui manque.
                eprintln!("[geom_brut] {}", e.motif);
                (si_statut(&e), 0, Vec::new())
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn octets_hex(texte: &str) -> Vec<u8> {
            (0..texte.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&texte[i..i + 2], 16).unwrap())
                .collect()
        }

        /// En-tête au format du client : fixe(9) | JSON bourré d'espaces | pied `]}` à poste
        /// fixe. Le corps commence à `taille_region`.
        fn tete_cache(taille_region: usize, contenu: &str) -> Vec<u8> {
            assert!(contenu.len() + 2 <= taille_region - EN_TETE_FIXE);
            let mut v = Vec::with_capacity(taille_region);
            v.extend_from_slice(GEOM_MAGIC);
            v.push(GEOM_VERSION);
            v.extend_from_slice(&((taille_region - EN_TETE_FIXE) as u32).to_le_bytes());
            v.extend_from_slice(contenu.as_bytes());
            while v.len() < taille_region - 2 {
                v.push(b' ');
            }
            v.extend_from_slice(b"]}");
            v
        }

        fn dossier(tag: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!("mycraft-brut-{}-{tag}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            dir
        }

        // ---- trames : les mêmes octets que dans `tests/geom-bureau.mjs` --------------

        #[test]
        fn la_trame_ajout_se_relit_telle_quelle() {
            let brut = octets_hex("4d4347460103020048015c0000000000000000000000000000000000000000006162dead");
            let cadre = lire_requete(&brut).unwrap();
            assert_eq!(cadre.op, OP_AJOUTER);
            assert_eq!(cadre.slot, "ab");
            assert_eq!(cadre.a, 6029640);
            assert_eq!(cadre.b, 0);
            assert_eq!(cadre.corps, &[0xde, 0xad]);
        }

        #[test]
        fn la_trame_migration_emporte_le_corps_apres_les_deux_champs() {
            let brut = octets_hex("4d43474601050700f7640000000000004c01080000000000000000000000000064656661756c7401020304");
            let cadre = lire_requete(&brut).unwrap();
            assert_eq!(cadre.op, OP_MIGRER);
            assert_eq!(cadre.slot, "default");
            assert_eq!(cadre.a, 25847);
            assert_eq!(cadre.b, 524620);
            assert_eq!(cadre.corps, &[1, 2, 3, 4]);
        }

        #[test]
        fn la_reponse_annonce_operation_statut_et_taille() {
            let reponse = construire_reponse(OP_AJOUTER, STATUT_OK, 676095460, 0, &[]);
            assert_eq!(
                reponse,
                octets_hex("4d43474601030000e4654c28000000000000000000000000")
            );
        }

        #[test]
        fn les_trames_grossieres_sont_refusees() {
            assert!(lire_requete(&[0u8; 4]).is_err(), "tronquée");
            let mut sans_signature = construire_reponse(OP_SONDER, STATUT_OK, 0, 0, &[]);
            sans_signature[..4].copy_from_slice(b"XXXX");
            assert!(lire_requete(&sans_signature).is_err(), "sans signature MCGF");
            // Un nom plus long que MAX_SLOT_LEN ne peut pas devenir un nom de fichier.
            let brut = {
                let mut b = vec![0u8; TETE_REQUETE];
                b[..4].copy_from_slice(CADRE_MAGIC);
                b[4] = CADRE_VERSION;
                b[5] = OP_LIRE;
                b[6] = (MAX_SLOT_LEN + 1) as u8;
                b
            };
            assert!(lire_requete(&brut).is_err(), "nom hors limites");
        }

        // ---- opérations sur fichier --------------------------------------------------

        #[test]
        fn l_ajout_colle_a_la_fin_quand_la_base_colle() {
            let dir = dossier("ajout");
            let chemin = dir.join(format!("ab{GEOM_EXT}"));
            fs::write(&chemin, [7u8; 40]).unwrap();
            assert_eq!(ajouter_blocs(&chemin, 40, &[1, 2, 3]).unwrap(), 43);
            let relu = fs::read(&chemin).unwrap();
            assert_eq!(&relu[40..], &[1, 2, 3]);
            assert_eq!(relu.len(), 43);
            let _ = fs::remove_dir_all(dir);
        }

        #[test]
        fn l_ajout_refuse_un_desaccord_sur_la_taille_sans_rien_ecrire() {
            let dir = dossier("ajout-desaccord");
            let chemin = dir.join(format!("ab{GEOM_EXT}"));
            fs::write(&chemin, [7u8; 40]).unwrap();
            // Deux onglets qui se croient seuls : celui qui arrive avec la mauvaise base
            // doit essuyer un conflit, et le fichier ne doit pas bouger d'un octet.
            let ecart = ajouter_blocs(&chemin, 41, &[9]).unwrap_err();
            assert!(ecart.conflit, "taille divergente doit être un conflit : {}", ecart.motif);
            assert_eq!(fs::read(&chemin).unwrap().len(), 40);
            // Fichier absent : conflit aussi — le jeu retombera sur la réécriture complète.
            let absent = dir.join(format!("zz{GEOM_EXT}"));
            assert!(ajouter_blocs(&absent, 40, &[9]).unwrap_err().conflit);
            // Une base absurde est refusée avant même de regarder le disque.
            assert!(ajouter_blocs(&chemin, 8, &[9]).unwrap_err().conflit);
            let _ = fs::remove_dir_all(dir);
        }

        #[test]
        fn la_table_ne_peut_pas_sortir_de_la_region_reservee() {
            let dir = dossier("tete");
            let chemin = dir.join(format!("ab{GEOM_EXT}"));
            let region = 64;
            let mut fichier = tete_cache(region, "{\"entrees\":[");
            fichier.extend_from_slice(&[0u8; 32]); // corps
            fs::write(&chemin, &fichier).unwrap();

            // Dans la réservation : passe.
            let ligne = b"{\"1,0\":{\"o\":40}},";
            assert_eq!(poser_tete(&chemin, 32, ligne).unwrap(), ligne.len() as u64);
            assert_eq!(&fs::read(&chemin).unwrap()[32..32 + ligne.len()], ligne);
            // Par-dessus la signature : refusé, la signature reste intacte.
            assert!(poser_tete(&chemin, 4, b"XXXX").unwrap_err().conflit);
            assert_eq!(&fs::read(&chemin).unwrap()[..4], GEOM_MAGIC);
            // Au-delà de la région réservée : refusé, sinon on écraserait le corps.
            let trop_long = vec![b'x'; region - 32 + 1];
            assert!(poser_tete(&chemin, 32, &trop_long).unwrap_err().conflit);
            let _ = fs::remove_dir_all(dir);
        }

        #[test]
        fn la_migration_deplace_le_corps_sans_le_perdre() {
            let dir = dossier("migrer");
            let chemin = dir.join(format!("ab{GEOM_EXT}"));
            let ancienne_region = 64;
            let corps: Vec<u8> = (0..300u32).map(|i| (i % 251) as u8).collect();
            let mut ancien = tete_cache(ancienne_region, "{\"entrees\":[");
            ancien.extend_from_slice(&corps);
            fs::write(&chemin, &ancien).unwrap();
            let attendu = ancien.len() as u64;

            // Nouvelle table plus grande : le corps saute à `debut`, copié par le magasin.
            let nouvelle_region = 128usize;
            let table = tete_cache(nouvelle_region, "{\"entrees\":[{\"0,0\":{\"o\":0}}");
            let nouveau = migrer_corps(&chemin, attendu, nouvelle_region as u64, &table).unwrap();
            assert_eq!(nouveau, nouvelle_region as u64 + (attendu - ancienne_region as u64));
            let relu = fs::read(&chemin).unwrap();
            assert_eq!(relu.len(), nouveau as usize);
            assert_eq!(&relu[..nouvelle_region], &table[..]);
            assert_eq!(&relu[nouvelle_region..], &corps[..]);
            // Plus rien ne traîne à côté.
            assert!(fs::read_dir(&dir).unwrap().count() <= 1, "le temporaire doit avoir disparu");
            let _ = fs::remove_dir_all(dir);
        }

        #[test]
        fn la_migration_refuse_les_gabarits_incoherents() {
            let dir = dossier("migrer-gardes");
            let chemin = dir.join(format!("ab{GEOM_EXT}"));
            let mut ancien = tete_cache(64, "{\"entrees\":[");
            ancien.extend_from_slice(&[3u8; 200]);
            fs::write(&chemin, &ancien).unwrap();
            let attendu = ancien.len() as u64;

            // La table reçue doit mesurer exactement le décalage qu'elle annonce.
            let table = tete_cache(128, "{\"entrees\":[");
            assert!(migrer_corps(&chemin, attendu, 127, &table).unwrap_err().conflit);
            // Taille annoncée différente de ce qu'il y a sur le disque.
            assert!(migrer_corps(&chemin, attendu + 1, 128, &table).unwrap_err().conflit);
            // Table sans pied `]}` : le fichier n'est pas touché.
            let sans_pied = {
                let mut t = table.clone();
                let n = t.len();
                t[n - 2] = b' ';
                t[n - 1] = b' ';
                t
            };
            assert!(migrer_corps(&chemin, attendu, 128, &sans_pied).unwrap_err().conflit);
            assert_eq!(fs::read(&chemin).unwrap(), ancien, "un refus ne doit rien changer");
            // Et une table sans la trace de la table des décalages est mal formée.
            let sans_table = tete_cache(128, "{\"version\":2");
            assert!(migrer_corps(&chemin, attendu, 128, &sans_table).unwrap_err().conflit);
            let _ = fs::remove_dir_all(dir);
        }

        #[test]
        fn seul_le_format_v2_entre_sur_le_disque() {
            // Punaisé sur la valeur absolue : le client (`public/js/geom-disque.js`) et le
            // serveur web écrivent en 2. Utiliser la constante des deux côtés laisserait le
            // magasin repartir à 1 sans que personne ne s'en aperçoive — c'est exactement
            // l'état dans lequel le bureau refusait toutes ses publications.
            assert_eq!(GEOM_VERSION, 2, "le client écrit GEOM_VERSION = 2");
            let dir = dossier("version");
            let mut v2 = tete_cache(32, "{\"entrees\":[");
            v2[4] = 2;
            assert_eq!(ecrire_fichier(&dir, "ab", &v2).unwrap(), v2.len() as u64);
            let mut v1 = v2.clone();
            v1[4] = 1;
            assert!(ecrire_fichier(&dir, "ab", &v1).is_err(), "v1 doit être refusé");
            let mut v3 = v2.clone();
            v3[4] = 3;
            assert!(ecrire_fichier(&dir, "ab", &v3).is_err(), "une version inconnue aussi");
            let mut casse = v2.clone();
            casse[0] = b'X';
            assert!(ecrire_fichier(&dir, "ab", &casse).is_err(), "signature absente");
            assert!(ecrire_fichier(&dir, "ab", &[1, 2, 3]).is_err(), "trop court");
            let _ = fs::remove_dir_all(dir);
        }
    }
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

    // ---- cache d'île ----

    /// Un fichier de cache tel que l'écrivent `EcrivainIle` et `EcrivainGeom` : signature,
    /// version, longueur d'en-tête en petit boutien, JSON d'en-tête, puis un corps opaque.
    fn cache_syntheme(magic: &[u8], codec: &str, cree: i64, version: u8, corps: &[u8]) -> Vec<u8> {
        let entete = format!("{{\"codec\":\"{codec}\",\"cree\":{cree},\"troncons\":3}}");
        let mut octets = Vec::new();
        octets.extend_from_slice(magic);
        octets.push(version);
        octets.extend_from_slice(&(entete.len() as u32).to_le_bytes());
        octets.extend_from_slice(entete.as_bytes());
        octets.extend_from_slice(corps);
        octets
    }

    #[test]
    fn base64_aller_retour_sur_toutes_les_valeurs() {
        let brut: Vec<u8> = (0..=255u8).cycle().take(1000).collect();
        let encode = encode_base64(&brut);
        assert!(!encode.chars().any(|c| c.is_whitespace()), "{encode}");
        assert_eq!(decode_base64(&encode).unwrap(), brut);
        // Une chaîne recopiée avec des retours à la ligne doit rester décodable.
        assert_eq!(decode_base64(&encode.replace("A", "A\n")).unwrap(), brut);
        assert!(decode_base64("pas du base64 !!").is_err());
    }

    #[test]
    fn cache_valide_accepte_et_decrit() {
        let fichier = cache_syntheme(ISLAND_MAGIC, "deflate", 1_700_000_000_000, ISLAND_VERSION, b"\x00\x01corps");
        check_island(&fichier).expect("cache valide accepté");
        let meta = decrire_en_tete_cache(&fichier, fichier.len() as u64, ISLAND_MAGIC, ISLAND_VERSION);
        assert_eq!(meta.codec.as_deref(), Some("deflate"));
        assert_eq!(meta.cree_at, 1_700_000_000_000);
        assert_eq!(meta.bytes, fichier.len() as u64);
        assert!(!meta.invalide);
    }

    #[test]
    fn caches_invalides_refuses() {
        for (raw, quoi) in [
            (Vec::new(), "vide"),
            (b"MCI".to_vec(), "trop court"),
            (b"XXXX\x01\x00\x00\x00\x00{}".to_vec(), "sans signature"),
            (cache_syntheme(ISLAND_MAGIC, "rle", 0, 7, b""), "version inconnue"),
        ] {
            assert!(check_island(&raw).is_err(), "{quoi} aurait dû être refusé");
        }
    }

    #[test]
    fn fenetre_tronquee_ne_declare_pas_invalide() {
        // `island_meta` ne lit que le début du fichier : une tête plus longue que la
        // fenêtre laisse les champs vides, mais le fichier reste valable.
        let fichier = cache_syntheme(ISLAND_MAGIC, "rle", 42, ISLAND_VERSION, &[7u8; 4096]);
        let vue = &fichier[..(9 + 4).min(fichier.len())];
        let meta = decrire_en_tete_cache(vue, fichier.len() as u64, ISLAND_MAGIC, ISLAND_VERSION);
        assert!(!meta.invalide, "une lecture partielle n'invalide pas le cache");
        assert_eq!(meta.bytes, fichier.len() as u64);
    }

    #[test]
    fn cache_ecrit_atome_et_recharge() {
        let dir = tmp_dir("ile");
        let fichier = cache_syntheme(ISLAND_MAGIC, "deflate", 1, ISLAND_VERSION, b"\xff\xfe\xfd");
        write_atomic(&dir, &format!("herbe{ISLAND_EXT}"), &fichier).unwrap();
        assert_eq!(fs::read(island_path(&dir, "herbe")).unwrap(), fichier);
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "un fichier temporaire traîne : {leftovers:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    // ---- cache de géométrie ----

    #[test]
    fn geom_valide_accepte_et_decrit() {
        let fichier = cache_syntheme(GEOM_MAGIC, "deflate", 1_700_000_000_000, GEOM_VERSION, b"\x00\x01corps");
        check_geom(&fichier).expect("cache de géométrie valide accepté");
        let meta = decrire_en_tete_cache(&fichier, fichier.len() as u64, GEOM_MAGIC, GEOM_VERSION);
        assert_eq!(meta.codec.as_deref(), Some("deflate"));
        assert!(!meta.invalide);
    }

    #[test]
    fn geom_invalides_refuses() {
        for (raw, quoi) in [
            (Vec::new(), "vide"),
            (b"MCG".to_vec(), "trop court"),
            // Un fichier d'île n'est pas un fichier de géométrie, même bien formé.
            (cache_syntheme(ISLAND_MAGIC, "deflate", 0, ISLAND_VERSION, b"corps"), "signature d'île"),
            (cache_syntheme(GEOM_MAGIC, "brut", 0, 9, b"corps"), "version inconnue"),
        ] {
            assert!(check_geom(&raw).is_err(), "{quoi} aurait dû être refusé");
        }
    }

    #[test]
    fn geom_ecrit_atome_et_recharge() {
        let dir = tmp_dir("geom");
        let fichier = cache_syntheme(GEOM_MAGIC, "deflate", 7, GEOM_VERSION, b"\xfe\xed\xfa\xce");
        write_atomic(&dir, &format!("caverne{GEOM_EXT}"), &fichier).unwrap();
        assert_eq!(fs::read(geom_path(&dir, "caverne")).unwrap(), fichier);
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "un fichier temporaire traîne : {leftovers:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn effacer_le_monde_emporte_les_deux_caches() {
        let dir = tmp_dir("caches-avec-monde");
        write_atomic(&dir, "jardin.json", SAVE.as_bytes()).unwrap();
        write_atomic(&dir, &format!("jardin{ISLAND_EXT}"), b"MCI1").unwrap();
        write_atomic(&dir, &format!("jardin{GEOM_EXT}"), b"MCG1").unwrap();
        assert!(effacer_monde(&dir, "jardin").unwrap());
        assert!(!save_path(&dir, "jardin").exists());
        assert!(!island_path(&dir, "jardin").exists(), "le cache d'île a survécu au monde");
        assert!(!geom_path(&dir, "jardin").exists(), "le cache de géométrie a survécu au monde");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn effacer_le_monde_emporte_le_cache() {
        let dir = tmp_dir("ile-avec-monde");
        write_atomic(&dir, "jardin.json", SAVE.as_bytes()).unwrap();
        write_atomic(&dir, &format!("jardin{ISLAND_EXT}"), b"MCI1").unwrap();
        assert!(effacer_monde(&dir, "jardin").unwrap());
        assert!(!save_path(&dir, "jardin").exists());
        assert!(!island_path(&dir, "jardin").exists(), "le cache a survécu au monde");
        // Un monde sans cache s'efface quand même, et le dire ne suffit pas à mentir.
        write_atomic(&dir, "pre.json", SAVE.as_bytes()).unwrap();
        assert!(effacer_monde(&dir, "pre").unwrap());
        assert!(!effacer_monde(&dir, "pre").unwrap());
        let _ = fs::remove_dir_all(&dir);
    }
}
