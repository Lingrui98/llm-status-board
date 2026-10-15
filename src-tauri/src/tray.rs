use crate::commands;
use crate::config;
use crate::types::{AccountConfig, RefreshOutcome};
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

/// 托盘图标 id（运行期通过 app.tray_by_id 取回以更新 tooltip / 替换菜单）
const TRAY_ID: &str = "main-tray";
/// 托盘菜单项 id
const MENU_SHOW: &str = "tray-show";
const MENU_REFRESH: &str = "tray-refresh";
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

/// 显示并聚焦主窗口（左键单击托盘 / 菜单「显示看板」/ 点击账号项共用）
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
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

/// 托盘展示所需数据：启用账号（config.json，提供名字与顺序）+ 上次刷新结果（results.json）。
/// 读取失败均降级为空——托盘必须总能建出来，不能因文件问题拖垮启动
fn load_tray_data(app: &AppHandle) -> (Vec<AccountConfig>, Vec<RefreshOutcome>) {
    let enabled = config::load(app)
        .map(|cfg| cfg.accounts.into_iter().filter(|a| a.enabled).collect())
        .unwrap_or_default();
    let outcomes = config::results_file_path(app)
        .and_then(|p| config::load_results(&p))
        .unwrap_or_default();
    (enabled, outcomes)
}

/// 构建托盘菜单：常规操作区（显示看板/立即刷新）/ 账号状态区 / 退出。
/// refreshing = true 时「立即刷新」置灰并显示「刷新中…」（刷新开始时重建一次即达到置灰效果）
fn build_menu(app: &AppHandle, refreshing: bool) -> Result<Menu<tauri::Wry>, tauri::Error> {
    let show_item = MenuItem::with_id(app, MENU_SHOW, "显示看板", true, None::<&str>)?;
    let refresh_item = if refreshing {
        MenuItem::with_id(app, MENU_REFRESH, "刷新中…", false, None::<&str>)?
    } else {
        MenuItem::with_id(app, MENU_REFRESH, "立即刷新", true, None::<&str>)?
    };
    let quit_item = MenuItem::with_id(app, MENU_QUIT, "退出", true, None::<&str>)?;

    // 账号状态区：按 config 的启用账号顺序，逐个配上 results.json 里的状态文本
    let (enabled, outcomes) = load_tray_data(app);
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
        Menu::with_items(app, &[&show_item, &refresh_item, &sep2, &quit_item])
    } else {
        let mut items: Vec<&dyn IsMenuItem<tauri::Wry>> = vec![&show_item, &refresh_item, &sep1];
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

/// 托盘 tooltip 摘要：「N 个账号 · M 个异常」或「N 个账号全部正常」
fn update_tooltip(app: &AppHandle, outcomes: &[RefreshOutcome]) {
    let total = outcomes.len();
    let failed = outcomes.iter().filter(|o| !o.ok).count();
    let tip = if failed > 0 {
        format!("LLM Status Board · {total} 个账号 · {failed} 个异常")
    } else {
        format!("LLM Status Board · {total} 个账号全部正常")
    };
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(&tip));
    }
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
                show_main_window(tray.app_handle());
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
}
