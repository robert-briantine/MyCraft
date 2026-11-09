#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod textures;
mod world;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .on_navigation(|url| {
                    // Le développement garde son serveur Express ; la version livrée
                    // n'a qu'une seule entrée et ne doit jamais sortir de chez elle.
                    if cfg!(debug_assertions) {
                        return true;
                    }
                    ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                        || (matches!(url.scheme(), "http" | "https")
                            && url.host_str() == Some("tauri.localhost")))
                        && url.port().is_none()
                        && url.username().is_empty()
                        && url.password().is_none()
                        && matches!(url.path(), "/" | "/index.html")
                })
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            textures::list_textures,
            textures::read_texture,
            textures::import_textures,
            world::save_world,
            world::load_world,
            world::clear_world,
            world::list_worlds
        ])
        .run(tauri::generate_context!())
        .expect("Impossible de démarrer MyCraft");
}
