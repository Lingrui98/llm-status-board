use crate::commands;
use crate::config;
use crate::types::{AccountConfig, RefreshOutcome};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

/// 托盘图标 id（运行期通过 app.tray_by_id 取回以更新 tooltip / 替换菜单）
const TRAY_ID: &str = "main-tray";
/// 托盘菜单项 id
const MENU_SHOW: &str = "tray-show";
const MENU_REFRESH: &str = "tray-refresh";
/// R16 §6：暂停/恢复自动刷新（点击只 emit，真值在前端）
const MENU_TOGGLE_PAUSE: &str = "tray-toggle-pause";
/// R16 §6：打开设置（显示窗口 + emit 让前端切视图）
const MENU_OPEN_SETTINGS: &str = "tray-open-settings";
const MENU_QUIT: &str = "tray-quit";
/// 「暂无数据」占位项 id（不可点击）
const MENU_EMPTY: &str = "tray-empty";
/// 「…其余 N 个」溢出项 id（不可点击）
const MENU_MORE: &str = "tray-more";
/// 账号状态区菜单项 id 前缀：完整 id 为 account:{账号id}，点击后按前缀反解账号 id
const MENU_ACCOUNT_PREFIX: &str = "account:";
/// 账号区最多直接展示的账号数，超出折叠为「…其余 N 个」（菜单过高在 Windows 上会出滚动条，体验差）
const MAX_ACCOUNTS_IN_MENU: usize = 8;
/// 失败原因在菜单里的最大字符数（超出截断并补省略号）
const MAX_ERROR_CHARS: usize = 12;

/// 自动刷新暂停状态（R16 §6）。
///
/// **运行态、不持久化**：重启即恢复「运行」，避免用户忘记恢复导致长期不刷新。
/// **前端是唯一真值源**：托盘点击只 emit 事件，等前端回报 `set_auto_refresh_paused`
/// 才更新这里，Rust 不自行翻转（避免两端漂移）。
static AUTO_REFRESH_PAUSED: AtomicBool = AtomicBool::new(false);

/// 当前是否暂停自动刷新
pub fn is_auto_refresh_paused() -> bool {
    AUTO_REFRESH_PAUSED.load(Ordering::SeqCst)
}

fn store_auto_refresh_paused(paused: bool) {
    AUTO_REFRESH_PAUSED.store(paused, Ordering::SeqCst);
}

/// 暂停/恢复菜单项的（文案, 是否可点击）——纯函数，便于单测（R16 §6）。
/// - `autoRefreshSec == 0`（未启用定时刷新）→ 置灰并显示「自动刷新已关闭」
/// - 暂停中 → 「恢复自动刷新」；否则 → 「暂停自动刷新」
pub fn pause_menu_item(auto_refresh_sec: u32, paused: bool) -> (String, bool) {
    if auto_refresh_sec == 0 {
        ("自动刷新已关闭".to_string(), false)
    } else if paused {
        ("恢复自动刷新".to_string(), true)
    } else {
        ("暂停自动刷新".to_string(), true)
    }
}

/// 托盘 tooltip 文案（R16 §6：暂停时追加「 · 已暂停」）——纯函数，便于单测
pub fn tooltip_text(total: usize, failed: usize, paused: bool) -> String {
    let base = if failed > 0 {
        format!("LLM Status Board · {total} 个账号 · {failed} 个异常")
    } else {
        format!("LLM Status Board · {total} 个账号全部正常")
    };
    if paused {
        format!("{base} · 已暂停")
    } else {
        base
    }
}

/// 显示并聚焦主窗口（菜单「显示看板」/ 点击账号项 / 左键切换的「显示」分支共用）
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 托盘左键单击的判定（纯函数，可单测）：**仅当窗口「可见且未最小化」时才隐藏**。
/// 隐藏中或最小化（任务栏里点了最小化）都视为「用户想让窗口回来」→ 显示 + 还原 + 聚焦。
/// Windows 与 macOS 共用这一份判定，不做平台分支。
pub fn should_hide_on_tray_click(is_visible: bool, is_minimized: bool) -> bool {
    is_visible && !is_minimized
}

/// 结合「窗口状态是否读取成功」的最终决策（纯函数，可单测）：
/// `None`（读取失败）→ 不隐藏，即降级为显示 + 聚焦。
fn resolve_tray_click_hide(state: Option<(bool, bool)>) -> bool {
    state.is_some_and(|(visible, minimized)| should_hide_on_tray_click(visible, minimized))
}

/// 托盘左键单击：切换显示/隐藏。
/// 与「✕ 隐藏到托盘」开关（`close_to_tray`）**完全解耦**——那个开关只管关闭按钮。
/// 取窗口状态失败（平台不支持等）时**降级为显示 + 聚焦**：宁可多显示一次，也不能点了没反应。
fn toggle_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let state = window.is_visible().ok().zip(window.is_minimized().ok());
    if resolve_tray_click_hide(state) {
        let _ = window.hide();
    } else {
        show_main_window(app);
    }
}

/// 点击账号状态项：显示主窗口并通知前端打开该账号详情抽屉
/// （前端 App.tsx 监听 tray-open-account，切看板视图并复用 focusRequest 机制）
fn open_account_detail(app: &AppHandle, account_id: &str) {
    show_main_window(app);
    let _ = app.emit("tray-open-account", account_id.to_string());
}

/// 与前端 formatDecimal 同款的小数位规则：|v|≥1 保留 2 位，0.01≤|v|<1 保留 4 位，0<|v|<0.01 保留 6 位
fn format_decimal(v: f64) -> String {
    let abs = v.abs();
    if abs > 0.0 && abs < 0.01 {
        format!("{v:.6}")
    } else if abs < 1.0 {
        format!("{v:.4}")
    } else {
        format!("{v:.2}")
    }
}

/// 按字符数截断（托盘菜单宽度有限）：超长时截到 max-1 个字符并补「…」，总长不超过 max
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// 单个账号在托盘菜单里的状态文本（纯函数，可单测）。
/// 优先级：刷新失败（✗ + 截断原因）> 余额（金额+币种）> 已用百分比最高的配额窗口（如「5h 36%」）> 「—」
pub fn tray_status_text(outcome: Option<&RefreshOutcome>) -> String {
    let Some(o) = outcome else {
        return "—".into();
    };
    if !o.ok {
        let reason = o.error.as_deref().unwrap_or("刷新失败").trim();
        let reason = if reason.is_empty() {
            "刷新失败"
        } else {
            reason
        };
        return format!("✗ {}", truncate_chars(reason, MAX_ERROR_CHARS));
    }
    if let Some(info) = &o.info {
        if let Some(b) = &info.balance {
            return format!("{} {}", format_decimal(b.amount), b.currency);
        }
        // 无余额（订阅/窗口类账号）：取已用百分比最高的窗口作为代表，忽略无数据/NaN 窗口
        let worst = info
            .quota_windows
            .iter()
            .filter(|w| w.used_percent.is_some_and(|p| !p.is_nan()))
            .max_by(|a, b| {
                a.used_percent
                    .partial_cmp(&b.used_percent)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        if let Some(w) = worst {
            let label = w.window.as_deref().unwrap_or("窗口");
            let pct = w.used_percent.unwrap_or(0.0).round();
            return format!("{label} {pct}%");
        }
    }
    "—".into()
}

/// 账号菜单项 id：account:{账号id}。每次重建保持稳定，on_menu_event 按前缀反解
fn account_menu_id(account_id: &str) -> String {
    format!("{MENU_ACCOUNT_PREFIX}{account_id}")
}

/// 托盘展示所需数据：启用账号（config.json，提供名字与顺序）+ 上次刷新结果（results.json）+
/// `autoRefreshSec`（R16 暂停项是否可用）。
/// 读取失败均降级为空/0——托盘必须总能建出来，不能因文件问题拖垮启动
fn load_tray_data(app: &AppHandle) -> (Vec<AccountConfig>, Vec<RefreshOutcome>, u32) {
    let (enabled, auto_refresh_sec) = match config::load(app) {
        Ok(cfg) => (
            cfg.accounts.into_iter().filter(|a| a.enabled).collect(),
            cfg.settings.auto_refresh_sec,
        ),
        Err(_) => (Vec::new(), 0),
    };
    let outcomes = config::results_file_path(app)
        .and_then(|p| config::load_results(&p))
        .unwrap_or_default();
    (enabled, outcomes, auto_refresh_sec)
}

/// 构建托盘菜单：常规操作区（显示看板/立即刷新/暂停自动刷新/打开设置）/ 账号状态区 / 退出。
/// refreshing = true 时「立即刷新」置灰并显示「刷新中…」（刷新开始时重建一次即达到置灰效果）
fn build_menu(app: &AppHandle, refreshing: bool) -> Result<Menu<tauri::Wry>, tauri::Error> {
    let show_item = MenuItem::with_id(app, MENU_SHOW, "显示看板", true, None::<&str>)?;
    let refresh_item = if refreshing {
        MenuItem::with_id(app, MENU_REFRESH, "刷新中…", false, None::<&str>)?
    } else {
        MenuItem::with_id(app, MENU_REFRESH, "立即刷新", true, None::<&str>)?
    };

    // 账号状态区：按 config 的启用账号顺序，逐个配上 results.json 里的状态文本
    let (enabled, outcomes, auto_refresh_sec) = load_tray_data(app);

    // R16 §6：暂停/恢复项（文案与可用性由纯函数决定）
    let (pause_label, pause_enabled) = pause_menu_item(auto_refresh_sec, is_auto_refresh_paused());
    let pause_item = MenuItem::with_id(
        app,
        MENU_TOGGLE_PAUSE,
        pause_label,
        pause_enabled,
        None::<&str>,
    )?;
    let settings_item = MenuItem::with_id(app, MENU_OPEN_SETTINGS, "打开设置", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, MENU_QUIT, "退出", true, None::<&str>)?;

    let mut account_items: Vec<MenuItem<tauri::Wry>> = Vec::new();
    if !enabled.is_empty() {
        if outcomes.is_empty() {
            // 从未刷新过：单行占位提示（不可点击）
            account_items.push(MenuItem::with_id(
                app,
                MENU_EMPTY,
                "暂无数据，点击立即刷新",
                false,
                None::<&str>,
            )?);
        } else {
            for acc in enabled.iter().take(MAX_ACCOUNTS_IN_MENU) {
                let status = tray_status_text(outcomes.iter().find(|o| o.account_id == acc.id));
                account_items.push(MenuItem::with_id(
                    app,
                    account_menu_id(&acc.id),
                    format!("{}    {}", acc.name, status),
                    true,
                    None::<&str>,
                )?);
            }
            if enabled.len() > MAX_ACCOUNTS_IN_MENU {
                account_items.push(MenuItem::with_id(
                    app,
                    MENU_MORE,
                    format!("…其余 {} 个", enabled.len() - MAX_ACCOUNTS_IN_MENU),
                    false,
                    None::<&str>,
                )?);
            }
        }
    }

    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    if account_items.is_empty() {
        // 无启用账号：不显示账号区
        Menu::with_items(
            app,
            &[
                &show_item,
                &refresh_item,
                &pause_item,
                &settings_item,
                &sep2,
                &quit_item,
            ],
        )
    } else {
        let mut items: Vec<&dyn IsMenuItem<tauri::Wry>> = vec![
            &show_item,
            &refresh_item,
            &pause_item,
            &settings_item,
            &sep1,
        ];
        for item in &account_items {
            items.push(item);
        }
        items.push(&sep2);
        items.push(&quit_item);
        Menu::with_items(app, &items)
    }
}

/// 重建托盘菜单并替换到托盘图标上（启动 / 刷新开始 / 刷新结束时调用）。
/// 菜单项 id 保持稳定（account:{账号id}），旧菜单随 set_menu 整体替换、由 Tauri 释放，不会泄漏
fn rebuild_menu(app: &AppHandle, refreshing: bool) {
    if let Ok(menu) = build_menu(app, refreshing) {
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            // 替换失败不致命：保留旧菜单（对齐代码库「非关键失败静默降级」的风格）
            let _ = tray.set_menu(Some(menu));
        }
    }
}

/// 托盘 tooltip 摘要（R16 §6 起：暂停时追加「 · 已暂停」）
fn update_tooltip(app: &AppHandle, outcomes: &[RefreshOutcome]) {
    let total = outcomes.len();
    let failed = outcomes.iter().filter(|o| !o.ok).count();
    let tip = tooltip_text(total, failed, is_auto_refresh_paused());
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(&tip));
    }
}

/// R16 §6：前端回报暂停状态后调用——更新运行态、重建菜单文案、刷新 tooltip。
/// 失败保持旧菜单/旧 tooltip（沿用本文件「非关键失败静默降级」的风格）。
pub fn apply_auto_refresh_paused(app: &AppHandle, paused: bool) {
    store_auto_refresh_paused(paused);
    rebuild_menu(app, false);
    let (_, outcomes, _) = load_tray_data(app);
    update_tooltip(app, &outcomes);
}

/// 供测试复位运行态（避免 `cargo test` 中用例互相污染）
#[cfg(test)]
fn reset_auto_refresh_paused_for_test() {
    store_auto_refresh_paused(false);
}

/// 托盘「立即刷新」：复用 refresh_all 命令（结果照常落盘 results.json，前端下次 get_last_results 能拿到）。
/// 流程：菜单重建为置灰「刷新中…」→ 跑刷新 → 更新 tooltip → 再重建菜单展示最新账号状态。
/// 刷新失败不影响托盘本身（菜单照常恢复）。
/// 取舍说明：窗口内前端发起的刷新不会主动通知 Rust，托盘菜单不会因此更新——
/// 只有托盘自己的「立即刷新」和下次启动会刷新账号区（保持单向数据流，不加新 IPC）。
fn trigger_refresh(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        rebuild_menu(&app, true);
        if let Ok(outcomes) = commands::refresh_all(app.clone()).await {
            update_tooltip(&app, &outcomes);
        }
        // 成功与失败都重建：成功后账号区读到 refresh_all 刚落盘的最新结果
        rebuild_menu(&app, false);
    });
}

/// 关闭窗口（✕）时按配置决定：隐藏到托盘（默认）或允许真正退出
pub fn on_close_requested(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    // 配置读取失败时保守处理：隐藏而不退出，避免误关常驻工具
    let close_to_tray = config::load(window.app_handle())
        .map(|cfg| cfg.settings.close_to_tray.unwrap_or(true))
        .unwrap_or(true);
    if close_to_tray {
        api.prevent_close();
        let _ = window.hide();
    }
}

/// 构建系统托盘：左键单击 = 显示/聚焦主窗口，右键 = 菜单
/// （显示看板 / 立即刷新 / 账号状态区（点击直达详情）/ 退出）。
/// 启动时直接用 results.json 里的上次结果构建账号区，无需等待首次刷新；
/// results.json 为空时账号区显示「暂无数据，点击立即刷新」单行占位。
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let menu = build_menu(app.handle(), false)?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("LLM Status Board")
        // 左键不弹菜单（交给 on_tray_icon_event 做显示/聚焦），菜单只在右键弹出
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            // 账号状态项：id 前缀匹配，反解账号 id 后通知前端打开详情
            if let Some(account_id) = id.strip_prefix(MENU_ACCOUNT_PREFIX) {
                open_account_detail(app, account_id);
                return;
            }
            match id {
                MENU_SHOW => show_main_window(app),
                MENU_REFRESH => trigger_refresh(app),
                // R16 §6：暂停/恢复的真值在前端——这里只 emit，不翻转本地状态，
                // 等前端回报 set_auto_refresh_paused 后再重建菜单（避免两端漂移）
                MENU_TOGGLE_PAUSE => {
                    let _ = app.emit(MENU_TOGGLE_PAUSE, ());
                }
                MENU_OPEN_SETTINGS => {
                    show_main_window(app);
                    let _ = app.emit(MENU_OPEN_SETTINGS, ());
                }
                MENU_QUIT => app.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击（抬起时触发一次，避免按下/抬起重复弹窗）
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                // R17：左键单击 = 切换显示/隐藏（Windows 与 macOS 同逻辑）
                toggle_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AccountInfo, Money, QuotaWindow};

    fn ok_outcome(info: AccountInfo) -> RefreshOutcome {
        RefreshOutcome {
            account_id: "a1".into(),
            ok: true,
            info: Some(info),
            error: None,
        }
    }

    /// 失败：✗ 前缀 + 原因截断（≤12 字符，超长补省略号）；短原因不截断；无原因用默认文案
    #[test]
    fn failure_shows_mark_and_truncated_reason() {
        let long = RefreshOutcome {
            account_id: "a1".into(),
            ok: false,
            info: None,
            error: Some("HTTP 401: 无效的访问令牌".into()),
        };
        let text = tray_status_text(Some(&long));
        assert!(text.starts_with("✗ "), "失败应以 ✗ 前缀标识: {text}");
        let reason = &text["✗ ".len()..];
        assert!(
            reason.chars().count() <= MAX_ERROR_CHARS,
            "原因应 ≤12 字符: {reason}"
        );
        assert!(reason.ends_with('…'), "超长原因应带省略号: {reason}");

        let short = RefreshOutcome {
            error: Some("HTTP 401".into()),
            ..long
        };
        assert_eq!(tray_status_text(Some(&short)), "✗ HTTP 401");

        let no_reason = RefreshOutcome {
            error: None,
            ..short
        };
        assert_eq!(tray_status_text(Some(&no_reason)), "✗ 刷新失败");
    }

    /// 余额：金额 + 币种，小数位规则与前端 formatDecimal 一致（≥1 两位 / <1 四位）
    #[test]
    fn balance_shows_amount_and_currency() {
        let info = AccountInfo {
            balance: Some(Money {
                amount: 110.5,
                currency: "CNY".into(),
            }),
            ..Default::default()
        };
        assert_eq!(tray_status_text(Some(&ok_outcome(info))), "110.50 CNY");

        let small = AccountInfo {
            balance: Some(Money {
                amount: 0.5,
                currency: "USD".into(),
            }),
            ..Default::default()
        };
        assert_eq!(tray_status_text(Some(&ok_outcome(small))), "0.5000 USD");
    }

    /// 无余额的订阅/窗口类账号：取已用百分比最高的窗口（四舍五入），无数据窗口忽略
    #[test]
    fn quota_window_picks_highest_used_percent() {
        let info = AccountInfo {
            quota_windows: vec![
                QuotaWindow {
                    window: Some("5h".into()),
                    used_percent: Some(20.0),
                    resets_at: None,
                },
                QuotaWindow {
                    window: Some("7d".into()),
                    used_percent: Some(35.6),
                    resets_at: None,
                },
                QuotaWindow {
                    window: Some("月配额".into()),
                    used_percent: None,
                    resets_at: None,
                },
            ],
            ..Default::default()
        };
        assert_eq!(tray_status_text(Some(&ok_outcome(info))), "7d 36%");
    }

    /// 空情形：成功但无余额也无窗口 → 「—」；该账号尚无刷新结果（None）→ 「—」
    #[test]
    fn empty_and_missing_outcome_show_placeholder() {
        assert_eq!(
            tray_status_text(Some(&ok_outcome(AccountInfo::default()))),
            "—"
        );
        assert_eq!(tray_status_text(None), "—");
    }

    // ---------- R16 §6 托盘增强 ----------

    /// AC-18：暂停项文案与可用性——暂停/恢复两种文案；`autoRefreshSec=0` 置灰
    #[test]
    fn pause_menu_item_label_and_enabled() {
        assert_eq!(
            pause_menu_item(60, false),
            ("暂停自动刷新".to_string(), true)
        );
        assert_eq!(
            pause_menu_item(60, true),
            ("恢复自动刷新".to_string(), true)
        );
        // 未启用定时刷新 → 置灰并说明原因（暂停与否都一样）
        assert_eq!(
            pause_menu_item(0, false),
            ("自动刷新已关闭".to_string(), false)
        );
        assert_eq!(
            pause_menu_item(0, true),
            ("自动刷新已关闭".to_string(), false)
        );
    }

    /// AC-18：暂停时 tooltip 追加「 · 已暂停」，且不破坏既有异常摘要
    #[test]
    fn tooltip_appends_paused_suffix() {
        assert_eq!(
            tooltip_text(3, 0, false),
            "LLM Status Board · 3 个账号全部正常"
        );
        assert_eq!(
            tooltip_text(3, 1, false),
            "LLM Status Board · 3 个账号 · 1 个异常"
        );
        assert_eq!(
            tooltip_text(3, 1, true),
            "LLM Status Board · 3 个账号 · 1 个异常 · 已暂停"
        );
        assert_eq!(
            tooltip_text(0, 0, true),
            "LLM Status Board · 0 个账号全部正常 · 已暂停"
        );
    }

    /// 运行态暂停标记：可置位/复位（不持久化，重启即恢复运行）
    #[test]
    fn auto_refresh_paused_state_round_trip() {
        reset_auto_refresh_paused_for_test();
        assert!(!is_auto_refresh_paused());
        store_auto_refresh_paused(true);
        assert!(is_auto_refresh_paused());
        reset_auto_refresh_paused_for_test();
        assert!(!is_auto_refresh_paused());
    }

    /// R16 §6：两个新菜单项 id 与规格一致（前端按事件名接线，改名会破坏契约）
    #[test]
    fn r16_menu_ids_match_spec() {
        assert_eq!(MENU_TOGGLE_PAUSE, "tray-toggle-pause");
        assert_eq!(MENU_OPEN_SETTINGS, "tray-open-settings");
    }

    // ---------- R17 左键切换显示/隐藏 ----------

    /// 4 种组合：只有「可见且未最小化」才隐藏；隐藏/最小化都走显示+还原+聚焦
    #[test]
    fn should_hide_on_tray_click_covers_all_states() {
        assert!(
            should_hide_on_tray_click(true, false),
            "可见且未最小化 → 隐藏"
        );
        assert!(
            !should_hide_on_tray_click(true, true),
            "可见但已最小化 → 还原显示（不是隐藏）"
        );
        assert!(!should_hide_on_tray_click(false, false), "已隐藏 → 显示");
        assert!(
            !should_hide_on_tray_click(false, true),
            "隐藏且最小化 → 显示"
        );
    }

    /// 状态读取失败（None）→ 降级为「显示 + 聚焦」；正常状态按判定表走
    #[test]
    fn tray_click_degrades_to_show_when_state_unknown() {
        assert!(
            !resolve_tray_click_hide(None),
            "取窗口状态失败时必须降级为显示，不能隐藏"
        );
        assert!(resolve_tray_click_hide(Some((true, false))));
        assert!(!resolve_tray_click_hide(Some((true, true))));
        assert!(!resolve_tray_click_hide(Some((false, false))));
        assert!(!resolve_tray_click_hide(Some((false, true))));
    }
}
