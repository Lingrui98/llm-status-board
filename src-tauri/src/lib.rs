mod commands;
mod config;
mod http;
mod jsonpath;
mod providers;
mod tray;
mod types;

#[cfg(test)]
mod net_tests;

/// 默认窗口尺寸（R16 §3 越界降级时复位用；与 `tauri.conf.json` 保持一致）
const DEFAULT_WINDOW_WIDTH: f64 = 1180.0;
const DEFAULT_WINDOW_HEIGHT: f64 = 780.0;

/// R16 §3 越界降级判定（纯函数，便于单测）。
/// 仅当「窗口不在任何显示器上」**且**「系统确实报告了至少一个显示器」才需要兜底——
/// 后半个条件避免窗口尚未上屏时被误判、把刚恢复出来的尺寸冲掉。
pub fn should_reset_window_geometry(
    current_monitor_found: bool,
    available_monitor_count: usize,
) -> bool {
    !current_monitor_found && available_monitor_count > 0
}

/// 拔掉外接屏后重启：保存的位置已不在任何显示器上 → 居中并把尺寸复位为默认 1180×780。
/// 失败静默降级（窗口几何调整不该影响启动）。
fn guard_window_on_screen<R: tauri::Runtime>(window: &tauri::Window<R>) {
    let has_monitor = window.current_monitor().ok().flatten().is_some();
    let monitor_count = window
        .available_monitors()
        .map(|m| m.len())
        .unwrap_or_default();
    if should_reset_window_geometry(has_monitor, monitor_count) {
        let _ = window.center();
        let _ = window.set_size(tauri::LogicalSize::new(
            DEFAULT_WINDOW_WIDTH,
            DEFAULT_WINDOW_HEIGHT,
        ));
    }
}

/// 承载 §3 兜底的内部插件：必须注册在 `window_state` **之后**，
/// 这样它的 `on_window_ready` 才在该插件恢复完窗口状态之后执行。
fn window_geometry_guard_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("window-geometry-guard")
        .on_window_ready(|window| guard_window_on_screen(&window))
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // R16 常驻与自动化插件
        // - autostart：开机自启（macOS 用 LaunchAgent，Windows 走注册表默认实现）
        // - window-state：窗口位置/大小持久化（默认 flags = all，默认文件名 .window-state.json）
        // - notification：系统通知（前端 JS API 与 Rust 侧命令都可用）
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        // 必须排在 window-state 之后（见函数注释）
        .plugin(window_geometry_guard_plugin())
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
            commands::get_usage_history,
            commands::upsert_usage_history,
            commands::set_auto_refresh_paused,
            commands::export_csv,
            commands::export_config,
            commands::import_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// R16 §3 / AC-6：只有在「窗口不在任何显示器上」且「系统确实有显示器」时才兜底复位，
    /// 避免窗口尚未上屏时误判、把刚恢复出来的尺寸冲掉
    #[test]
    fn window_geometry_fallback_predicate() {
        assert!(
            should_reset_window_geometry(false, 1),
            "越界且有显示器 → 复位"
        );
        assert!(should_reset_window_geometry(false, 2));
        assert!(
            !should_reset_window_geometry(false, 0),
            "没有任何显示器（尚未上屏）→ 不动窗口"
        );
        assert!(
            !should_reset_window_geometry(true, 1),
            "窗口在显示器上 → 不动"
        );
        assert!(!should_reset_window_geometry(true, 0));
    }
}
