mod commands;
mod config;
mod http;
mod jsonpath;
mod providers;
mod tray;
mod types;

#[cfg(test)]
mod net_tests;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            tray::setup(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 点 ✕ 默认隐藏到托盘（托盘菜单「退出」才是真退出）；
            // 设置页「关闭窗口时」改为直接退出后，此处放行即可
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                tray::on_close_requested(window, api);
            }
        })
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
