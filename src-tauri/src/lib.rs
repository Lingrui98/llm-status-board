mod commands;
mod config;
mod http;
mod jsonpath;
mod providers;
mod types;

#[cfg(test)]
mod net_tests;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::save_config,
            commands::config_path,
            commands::test_account,
            commands::refresh_all,
            commands::get_last_results,
            commands::get_history,
            commands::export_config,
            commands::import_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
