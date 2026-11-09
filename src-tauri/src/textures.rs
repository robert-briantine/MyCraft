// Magasin local des textures personnalisées du joueur.
//
// Le navigateur, lui, passe par Express (voir server.js). Ici tout vient du
// disque de l'utilisateur, donc chaque nom reçu est traité comme non fiable :
// il doit survivre à une vérification de composant de chemin, d'extension et
// de signature binaire avant d'être touché.
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_BATCH: usize = 64;
const MAX_NAME_LEN: usize = 96;
const ALLOWED_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

fn store_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("dossier de données inaccessible : {e}"))?
        .join("textures");
    fs::create_dir_all(&dir).map_err(|e| format!("impossible de créer le dossier : {e}"))?;
    Ok(dir)
}

/// Returns the canonical `stem.ext` for an untrusted file name, or an error.
/// Only a single path component is accepted, so neither `..` nor any separator
/// can escape the texture folder, and the extension must be a known image type.
fn safe_name(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    // Séparateurs refusés avant même d'interroger `Path` : sa notion de
    // séparateur dépend du système de compilation, cette règle ne le peut pas.
    if raw.contains(['/', '\\', ':']) || raw.contains('\0') {
        return Err(format!("chemin refusé : {raw}"));
    }
    let candidate = Path::new(raw);
    let file_name = candidate
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "nom de fichier invalide".to_string())?;
    if candidate != Path::new(file_name) {
        return Err(format!("chemin refusé : {raw}"));
    }
    let ext = candidate
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .ok_or_else(|| "extension manquante".to_string())?;
    if !ALLOWED_EXTS.contains(&ext.as_str()) {
        return Err(format!("extension refusée : .{ext}"));
    }
    // rfind('.') retombe toujours sur une frontière de caractère, contrairement
    // à un calcul en octets qui paniquerait sur un nom non-ASCII.
    let dot = file_name.rfind('.').ok_or_else(|| "extension manquante".to_string())?;
    let stem = &file_name[..dot];
    if stem.is_empty()
        || stem.len() > MAX_NAME_LEN
        || stem.starts_with('.')
        || stem.contains("..")
        || !stem
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        return Err(format!("nom refusé : {raw}"));
    }
    Ok(format!("{stem}.{ext}"))
}

/// The extension alone is trivially forged, so the leading bytes have to match
/// the declared format before anything is written or handed back to the webview.
fn matches_signature(bytes: &[u8], ext: &str) -> bool {
    match ext {
        "png" => bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
        "jpg" | "jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "webp" => bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

fn check_payload(name: &str, bytes: &[u8]) -> Result<String, String> {
    let stored = safe_name(name)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(format!("{name} dépasse 8 Mo"));
    }
    if !matches_signature(bytes, stored.rsplit('.').next().unwrap_or("")) {
        return Err(format!("{name} n'est pas une image de ce format"));
    }
    Ok(stored)
}

#[tauri::command]
pub fn list_textures(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = store_dir(&app)?;
    let mut names = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        if let Some(raw) = entry.file_name().to_str() {
            // A stray file left by an older build must not poison the list.
            if let Ok(clean) = safe_name(raw) {
                if clean == raw {
                    names.push(clean);
                }
            }
        }
    }
    names.sort();
    Ok(names)
}

#[tauri::command]
pub fn read_texture(app: AppHandle, name: String) -> Result<Vec<u8>, String> {
    let stored = safe_name(&name)?;
    if stored != name {
        return Err(format!("nom refusé : {name}"));
    }
    let path = store_dir(&app)?.join(&stored);
    let meta = fs::metadata(&path).map_err(|_| format!("{name} introuvable"))?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return Err(format!("{name} illisible"));
    }
    fs::read(&path).map_err(|e| format!("{name} illisible : {e}"))
}

/// Imports files the player picked in the native dialog. The paths come from
/// the webview, so they are re-checked rather than trusted: regular file, size
/// ceiling, real image signature, and only the base name is kept on disk.
#[tauri::command]
pub fn import_textures(app: AppHandle, paths: Vec<String>) -> Result<Vec<String>, String> {
    if paths.len() > MAX_BATCH {
        return Err(format!("trop de fichiers d'un coup (max {MAX_BATCH})"));
    }
    let dir = store_dir(&app)?;
    let mut imported = Vec::new();
    for raw in paths {
        let source = Path::new(raw.trim());
        let meta = fs::metadata(source).map_err(|_| format!("{raw} introuvable"))?;
        if !meta.is_file() {
            return Err(format!("{raw} n'est pas un fichier"));
        }
        if meta.len() > MAX_FILE_BYTES {
            return Err(format!("{raw} dépasse 8 Mo"));
        }
        let name = source
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("{raw} : nom illisible"))?
            .to_string();
        let bytes = fs::read(source).map_err(|e| format!("{raw} : {e}"))?;
        let stored = check_payload(&name, &bytes)?;
        fs::write(dir.join(&stored), &bytes).map_err(|e| format!("{stored} : {e}"))?;
        imported.push(stored);
    }
    Ok(imported)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0];
    const JPG: &[u8] = &[0xff, 0xd8, 0xff, 0xe0, 0, 0];
    const GIF: &[u8] = b"GIF89a....";
    const WEBP: &[u8] = b"RIFF\x04\0\0\0WEBPVP8 ";

    fn accepted(raw: &str) -> String {
        safe_name(raw).unwrap_or_else(|e| panic!("« {raw} » devait être accepté : {e}"))
    }

    #[test]
    fn noms_normaux_acceptes_et_normalises() {
        assert_eq!(accepted("stone.png"), "stone.png");
        assert_eq!(accepted("  herbe_01.PNG  "), "herbe_01.png");
        assert_eq!(accepted("mon-bloc.jpg"), "mon-bloc.jpg");
        assert_eq!(accepted("a.b.c.png"), "a.b.c.png");
    }

    #[test]
    fn traversees_de_chemin_refusees() {
        for raw in [
            "../evil.png",
            "/etc/passwd.png",
            "sub/stone.png",
            "./stone.png",
            "..\\..\\windows\\x.png",
            "C:\\Windows\\System32\\x.png",
            "stone.png/",
            "stone.png\\..\\..\\x.png",
        ] {
            assert!(safe_name(raw).is_err(), "« {raw} » aurait dû être refusé");
        }
    }

    #[test]
    fn extensions_hors_liste_refusees() {
        for raw in ["evil.exe", "script.bat", "page.html", "lib.dll", "noext", "a.tar.gz", ".png"] {
            assert!(safe_name(raw).is_err(), "« {raw} » aurait dû être refusé");
        }
    }

    #[test]
    fn noms_hosts_refuses_sans_paniquer() {
        // Tris des cas où un découpage en octets hors frontière UTF-8 paniquerait.
        for raw in ["é.png", "blòc.png", "\0.png", "sp ace.png", "..png", ".hidden.png", "🧱.png"] {
            assert!(safe_name(raw).is_err(), "« {raw} » aurait dû être refusé");
        }
        assert!(safe_name(&format!("{}.png", "a".repeat(MAX_NAME_LEN + 1))).is_err());
    }

    #[test]
    fn signature_binaire_obligatoire() {
        assert!(matches_signature(PNG, "png"));
        assert!(matches_signature(JPG, "jpg") && matches_signature(JPG, "jpeg"));
        assert!(matches_signature(GIF, "gif"));
        assert!(matches_signature(WEBP, "webp"));
        // Un JPEG renommé en .png ne passe pas : l'extension seule ne vaut rien.
        assert!(!matches_signature(JPG, "png"));
        assert!(!matches_signature(PNG, "jpg"));
        assert!(!matches_signature(b"MZ\0\0", "png"));
        assert!(!matches_signature(&[], "png"));
    }

    #[test]
    fn payload_trop_gros_refuse() {
        let huge = vec![0u8; MAX_FILE_BYTES as usize + 1];
        assert!(check_payload("gros.png", &huge).is_err());
    }
}
