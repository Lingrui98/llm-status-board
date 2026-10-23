mod balance_usage;
mod commands;
mod config;
mod http;
mod jsonpath;
mod primary_metric;
mod providers;
mod summary;
mod tray;
mod types;

#[cfg(test)]
mod net_tests;

use tauri::Manager;

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
/// 只作用于主窗口（R18 的 `summary` 浮层位置由悬停实时计算，不该被这里改写）。
/// 失败静默降级（窗口几何调整不该影响启动）。
fn guard_window_on_screen<R: tauri::Runtime>(window: &tauri::Window<R>) {
    if window.label() != "main" {
        return;
    }
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
        .plugin(
            // R18：summary 浮层位置每次悬停实时计算，**不参与** window-state 的保存/恢复
            // （否则插件会把它当成普通窗口记忆位置，与定位逻辑打架）
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&[summary::POPUP_LABEL])
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        // R22 一键更新：
        // - updater：从 GitHub Releases 的 latest.json 检查/下载/安装（签名校验插件内置）
        // - process：macOS 安装完成后 relaunch（Windows 由 NSIS 安装器自行接管重启）
        // - opener：更新失败兜底「前往发布页手动下载」（capability 已把 URL 限定在本仓库 releases）
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        // 必须排在 window-state 之后（见函数注释）
        .plugin(window_geometry_guard_plugin())
        .setup(|app| {
            tray::setup(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                // 点 ✕ 默认隐藏到托盘（托盘菜单「退出」才是真退出）；
                // 设置页「关闭窗口时」改为直接退出后，此处放行即可
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    tray::on_close_requested(window, api);
                }
                // R18 §1：主窗口获得焦点 → 立即隐藏用量总结浮层（浮层自身获焦不处理）
                tauri::WindowEvent::Focused(true) if window.label() == "main" => {
                    summary::on_main_focus(window.app_handle());
                }
                // 顶层浮层失焦才立即隐藏。前端不监听 WebView 内部 blur，避免原生缩放误触发隐藏。
                tauri::WindowEvent::Focused(false) if window.label() == summary::POPUP_LABEL => {
                    summary::on_popup_blur(window.app_handle());
                }
                _ => {}
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
            commands::show_summary_popup,
            commands::hide_summary_popup,
            commands::set_summary_pointer_inside,
            commands::summary_open_account,
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
