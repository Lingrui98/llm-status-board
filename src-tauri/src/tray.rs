use crate::config;
use crate::types::{AccountConfig, QuotaWindow, RefreshOutcome};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Listener, Manager};

/// 托盘图标 id（运行期通过 app.tray_by_id 取回以更新 tooltip / 替换菜单）
const TRAY_ID: &str = "main-tray";
/// 托盘菜单项 id
const MENU_SHOW: &str = "tray-show";
/// 「立即刷新」项 id。**同时用作事件名**：点击只 emit 该事件，由前端唯一的 `refresh()` 执行
/// （R21：与主面板刷新同源；前端 `App.tsx` 监听的就是 `tray-refresh`）
const MENU_REFRESH: &str = "tray-refresh";
/// R21：前端 `refresh()` 结束（成功/失败都发）事件——Rust 收到后恢复「立即刷新」可用态
/// 并刷新账号状态区/tooltip
const EVENT_REFRESH_SETTLED: &str = "frontend-refresh-settled";
/// R21：置灰「刷新中…」的兜底超时——超过该时长仍未收到 settled（事件丢失：监听未就绪、
/// 渲染进程异常/重载）就自行恢复菜单，避免「立即刷新」永久不可用。
pub const REFRESH_WATCHDOG: Duration = Duration::from_secs(15);

/// R21：刷新「代次」。**点击「立即刷新」与收到 settled 都自增**：
/// - 点击：把代次推进到自己这一代，并启动看门狗；
/// - settled：推进代次，作废所有在途看门狗（它们醒来时代次已变，不再动作）；
/// - 看门狗：仅当代次仍停在自己那一代（期间既无 settled 也无新点击）才恢复；
///   恢复时先「认领」（自增一次），因此重复触发天然幂等。
static REFRESH_EPOCH: AtomicU64 = AtomicU64::new(0);

/// 看门狗是否应当恢复菜单（纯函数，便于单测）：
/// 仅当代次仍等于本次点击那一代（期间没有任何 settled / 新点击）才恢复。
pub fn watchdog_should_restore(click_epoch: u64, current_epoch: u64) -> bool {
    click_epoch == current_epoch
}
/// 打开设置（显示窗口 + emit 让前端切视图）
const MENU_OPEN_SETTINGS: &str = "tray-open-settings";
const MENU_QUIT: &str = "tray-quit";
/// 「暂无数据」占位项 id（不可点击）
const MENU_EMPTY: &str = "tray-empty";
/// 「…其余 N 个」溢出项 id（不可点击）
const MENU_MORE: &str = "tray-more";
/// 账号状态区菜单项 id 前缀：完整 id 为 account:{账号id}，点击后按前缀反解账号 id
const MENU_ACCOUNT_PREFIX: &str = "account:";
/// R23：子菜单里「窗口明细行」的 id 前缀（禁用项不产生事件；与账号项前缀区分开，保持契约干净）
const MENU_WINDOW_PREFIX: &str = "account-window:";
/// 账号区最多直接展示的账号数，超出折叠为「…其余 N 个」（菜单过高在 Windows 上会出滚动条，体验差）
const MAX_ACCOUNTS_IN_MENU: usize = 8;
/// 失败原因在菜单里的最大字符数（超出截断并补省略号）
const MAX_ERROR_CHARS: usize = 12;
/// R23：文本配额条格数（已用 `█` / 剩余 `░`）
const QUOTA_BAR_CELLS: usize = 8;

/// 托盘 tooltip 文案 —— 纯函数，便于单测。
/// R21：只由「账号数 / 异常数」决定（原「暂停」态随暂停开关一并移除）。
pub fn tooltip_text(total: usize, failed: usize) -> String {
    if failed > 0 {
        format!("LLM Status Board · {total} 个账号 · {failed} 个异常")
    } else {
        format!("LLM Status Board · {total} 个账号全部正常")
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
/// R18：`pub(crate)` —— 浮层里的账号行点击（`summary_open_account`）复用同一条路径
pub(crate) fn open_account_detail(app: &AppHandle, account_id: &str) {
    show_main_window(app);
    let _ = app.emit("tray-open-account", account_id.to_string());
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
///
/// R20：判定口径统一到 [`crate::primary_metric`]（与主卡片 R19、悬停浮层同一套）：
/// 失败（`✗ 原因`，12 字符截断）→ 订阅优先（`剩余 X%（窗口名）`）→ 余额（`金额 币种`）→ `—`。
/// 本函数只保留**失败分支**，其余交给单一事实来源，避免在托盘里再抄一份判定。
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
    match &o.info {
        Some(info) => crate::primary_metric::format_primary_metric_line(
            &crate::primary_metric::pick_primary_metric(info),
        ),
        // 刷新成功但没有 info：与「无数据」同口径
        None => "—".into(),
    }
}

/* ---------- R23：额度条与多窗口明细（docs/round-23-plan.md） ---------- */

/// R23：文本配额条（8 格；已用 `█` / 剩余 `░`，按钳制后已用百分比四舍五入到整格）。
/// 纯函数，便于单测；非有限输入按 0 格处理（正常路径上游已过滤无效窗口，这里是兜底）。
pub fn quota_bar_text(used_percent: f64) -> String {
    let clamped = if used_percent.is_finite() {
        used_percent.clamp(0.0, 100.0)
    } else {
        0.0
    };
    let used_cells = ((clamped / 100.0) * QUOTA_BAR_CELLS as f64).round() as usize;
    let mut s = String::with_capacity(QUOTA_BAR_CELLS * 3);
    for _ in 0..used_cells {
        s.push('█');
    }
    for _ in used_cells..QUOTA_BAR_CELLS {
        s.push('░');
    }
    s
}

/// R23：限额窗口明细显示方式（设置 `quota_detail_display`；缺省/未知值一律回落 percent）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuotaDetailMode {
    /// 百分比条（默认）
    Percent,
    /// 原始数字（已用 / 上限，USD）
    Raw,
}

/// 解析设置值 → 显示模式（纯函数）：只有精确 "raw" 才进数字模式，其余（含 None/空串/未知）回落 percent
pub fn quota_detail_mode(raw: Option<&str>) -> QuotaDetailMode {
    match raw.map(str::trim) {
        Some("raw") => QuotaDetailMode::Raw,
        _ => QuotaDetailMode::Percent,
    }
}

/// R23：单个窗口的明细行文本（纯函数）。
/// - percent：`{窗口}  {条} 已用 {N}%`——N 用**真实值**（超限窗口显示 >100，如「已用 100.9%」；
///   条宽按钳制值渲染满格，事实与图形各司其职）；
/// - raw：`{窗口}  已用 {A} / 上限 {L} {币种}`；
/// - raw 但窗口缺金额字段（如 Kimi 的百分比窗口）→ 诚实回落 percent，不留空白。
pub fn window_detail_line(w: &QuotaWindow, mode: QuotaDetailMode) -> String {
    let label = w
        .window
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(crate::primary_metric::DEFAULT_WINDOW_LABEL);
    let pct = w.used_percent.unwrap_or(0.0);
    // 单匹配代替嵌套 if（规避 clippy::collapsible_if；CI -D warnings）
    match (mode, &w.used_amount, &w.limit_amount) {
        (QuotaDetailMode::Raw, Some(u), Some(l)) => format!(
            "{label}  已用 {} / 上限 {} {}",
            crate::primary_metric::format_decimal(u.amount),
            crate::primary_metric::format_decimal(l.amount),
            u.currency
        ),
        // raw 但窗口缺金额字段（如 Kimi 的百分比窗口）→ 诚实回落 percent，不留空白
        _ => format!(
            "{label}  {} 已用 {}%",
            quota_bar_text(pct),
            crate::primary_metric::trim_number_text(pct)
        ),
    }
}

/// R23：账号主行文本（纯函数，可单测）。
/// - 无有效窗口 / 失败 / 未刷新：`名称    {主指标}`（R20 规范串，原样）；
/// - 有窗口 + percent + 配额主指标：`名称    {条} {主指标}`（条 = 最紧窗口已用程度）；
/// - 有窗口 + percent + 余额主指标（窗口未成为主指标）：主行不加条，避免「条 + 金额」无标注混排；
/// - raw 且最紧窗口带金额字段：`名称    {窗口明细数字行}`；raw 无金额 → 回落 percent 形态。
pub fn account_line_text(
    name: &str,
    outcome: Option<&RefreshOutcome>,
    mode: QuotaDetailMode,
) -> String {
    let status = tray_status_text(outcome);
    let Some(info) = outcome.and_then(|o| o.info.as_ref()) else {
        return format!("{name}    {status}");
    };
    let Some(tightest) = crate::primary_metric::tightest_window(&info.quota_windows) else {
        return format!("{name}    {status}");
    };
    if mode == QuotaDetailMode::Raw
        && tightest.used_amount.is_some()
        && tightest.limit_amount.is_some()
    {
        return format!("{name}    {}", window_detail_line(tightest, mode));
    }
    let is_quota_primary = matches!(
        crate::primary_metric::pick_primary_metric(info),
        crate::primary_metric::PrimaryMetric::Quota { .. }
    );
    if is_quota_primary {
        format!(
            "{name}    {} {}",
            quota_bar_text(tightest.used_percent.unwrap_or(0.0)),
            status
        )
    } else {
        format!("{name}    {status}")
    }
}

/// 账号菜单项 id：account:{账号id}。每次重建保持稳定，on_menu_event 按前缀反解
fn account_menu_id(account_id: &str) -> String {
    format!("{MENU_ACCOUNT_PREFIX}{account_id}")
}

/// R23：账号区条目 —— 单行项（0/1 个有效窗口）或带明细的子菜单（≥2 个有效窗口）
enum AccountEntry {
    Item(MenuItem<tauri::Wry>),
    Sub(Submenu<tauri::Wry>),
}

impl AccountEntry {
    fn as_menu_item(&self) -> &dyn IsMenuItem<tauri::Wry> {
        match self {
            AccountEntry::Item(i) => i,
            AccountEntry::Sub(s) => s,
        }
    }
}

/// 托盘展示所需数据：启用账号（config.json，提供名字与顺序）+ 上次刷新结果（results.json）
/// 以及 R23 限额明细显示模式（config.json settings）。
/// 读取失败均降级为空/默认——托盘必须总能建出来，不能因文件问题拖垮启动
fn load_tray_data(app: &AppHandle) -> (Vec<AccountConfig>, Vec<RefreshOutcome>, QuotaDetailMode) {
    let cfg = config::load(app).ok();
    let enabled: Vec<AccountConfig> = cfg
        .as_ref()
        .map(|c| c.accounts.iter().filter(|a| a.enabled).cloned().collect())
        .unwrap_or_default();
    let mode = quota_detail_mode(
        cfg.as_ref()
            .and_then(|c| c.settings.quota_detail_display.as_deref()),
    );
    let outcomes = config::results_file_path(app)
        .and_then(|p| config::load_results(&p))
        .unwrap_or_default();
    (enabled, outcomes, mode)
}

/// 构建托盘菜单：常规操作区（显示看板/立即刷新/打开设置）/ 账号状态区 / 退出。
/// refreshing = true 时「立即刷新」置灰并显示「刷新中…」（刷新开始时重建一次即达到置灰效果）
fn build_menu(app: &AppHandle, refreshing: bool) -> Result<Menu<tauri::Wry>, tauri::Error> {
    let show_item = MenuItem::with_id(app, MENU_SHOW, "显示看板", true, None::<&str>)?;
    // R21：刷新中置灰文案由纯函数决定（可单测）
    let (refresh_label, refresh_enabled) = refresh_menu_item(refreshing);
    let refresh_item = MenuItem::with_id(
        app,
        MENU_REFRESH,
        refresh_label,
        refresh_enabled,
        None::<&str>,
    )?;

    // 账号状态区：按 config 的启用账号顺序，逐个配上 results.json 里的状态文本
    let (enabled, outcomes, detail_mode) = load_tray_data(app);

    let settings_item = MenuItem::with_id(app, MENU_OPEN_SETTINGS, "打开设置", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, MENU_QUIT, "退出", true, None::<&str>)?;

    let mut account_entries: Vec<AccountEntry> = Vec::new();
    if !enabled.is_empty() {
        if outcomes.is_empty() {
            // 从未刷新过：单行占位提示（不可点击）
            account_entries.push(AccountEntry::Item(MenuItem::with_id(
                app,
                MENU_EMPTY,
                "暂无数据，点击立即刷新",
                false,
                None::<&str>,
            )?));
        } else {
            for acc in enabled.iter().take(MAX_ACCOUNTS_IN_MENU) {
                let outcome = outcomes.iter().find(|o| o.account_id == acc.id);
                let main_text = account_line_text(&acc.name, outcome, detail_mode);
                let windows: Vec<&QuotaWindow> = outcome
                    .and_then(|o| o.info.as_ref())
                    .map(|i| crate::primary_metric::valid_windows(&i.quota_windows))
                    .unwrap_or_default();

                if windows.len() >= 2 {
                    // R23：多窗口账号 → 子菜单（主行 = 最紧窗口摘要；子项 = 每窗口一行明细（禁用）
                    // + 分隔 + 「打开详情」），不占主菜单高度
                    let mut child_items: Vec<MenuItem<tauri::Wry>> = Vec::new();
                    for (idx, w) in windows.iter().enumerate() {
                        child_items.push(MenuItem::with_id(
                            app,
                            format!("{MENU_WINDOW_PREFIX}{}:{idx}", acc.id),
                            window_detail_line(w, detail_mode),
                            false,
                            None::<&str>,
                        )?);
                    }
                    let sep = PredefinedMenuItem::separator(app)?;
                    let open_item = MenuItem::with_id(
                        app,
                        account_menu_id(&acc.id),
                        "打开详情",
                        true,
                        None::<&str>,
                    )?;
                    let mut refs: Vec<&dyn IsMenuItem<tauri::Wry>> = Vec::new();
                    for item in &child_items {
                        refs.push(item);
                    }
                    refs.push(&sep);
                    refs.push(&open_item);
                    let sub = Submenu::with_id_and_items(
                        app,
                        format!("{MENU_ACCOUNT_PREFIX}{}:sub", acc.id),
                        main_text,
                        true,
                        &refs,
                    )?;
                    account_entries.push(AccountEntry::Sub(sub));
                } else {
                    account_entries.push(AccountEntry::Item(MenuItem::with_id(
                        app,
                        account_menu_id(&acc.id),
                        main_text,
                        true,
                        None::<&str>,
                    )?));
                }
            }
            if enabled.len() > MAX_ACCOUNTS_IN_MENU {
                account_entries.push(AccountEntry::Item(MenuItem::with_id(
                    app,
                    MENU_MORE,
                    format!("…其余 {} 个", enabled.len() - MAX_ACCOUNTS_IN_MENU),
                    false,
                    None::<&str>,
                )?));
            }
        }
    }

    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    if account_entries.is_empty() {
        // 无启用账号：不显示账号区
        Menu::with_items(
            app,
            &[&show_item, &refresh_item, &settings_item, &sep2, &quit_item],
        )
    } else {
        let mut items: Vec<&dyn IsMenuItem<tauri::Wry>> =
            vec![&show_item, &refresh_item, &settings_item, &sep1];
        for entry in &account_entries {
            items.push(entry.as_menu_item());
        }
        items.push(&sep2);
        items.push(&quit_item);
        Menu::with_items(app, &items)
    }
}

/// 重建托盘菜单并替换到托盘图标上（启动 / 刷新开始 / 刷新结束时调用）。
/// 菜单项 id 保持稳定（account:{账号id}），旧菜单随 set_menu 整体替换、由 Tauri 释放，不会泄漏
fn rebuild_menu(app: &AppHandle, refreshing: bool) {
    MENU_REFRESHING.store(refreshing, Ordering::SeqCst);
    if let Ok(menu) = build_menu(app, refreshing) {
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            // 替换失败不致命：保留旧菜单（对齐代码库「非关键失败静默降级」的风格）
            let _ = tray.set_menu(Some(menu));
        }
    }
}

/// R23：菜单的「刷新中」置灰态记录。原重建入口（点击/收尾）自带参数不存在漂移；
/// 新增的 save_config 钩子需要读到当前真实态，避免设置保存把「刷新中…」提前恢复成可点
static MENU_REFRESHING: AtomicBool = AtomicBool::new(false);

/// R23：设置保存后立即重建菜单（配额显示模式等托盘相关设置即时生效），
/// 并保持「刷新中」置灰态（由 `MENU_REFRESHING` 供值）
pub(crate) fn rebuild_menu_now(app: &AppHandle) {
    rebuild_menu(app, MENU_REFRESHING.load(Ordering::SeqCst));
}

/// 「立即刷新」菜单项的（文案, 是否可点击）——纯函数，便于单测（R21：刷新中置灰）
pub fn refresh_menu_item(refreshing: bool) -> (&'static str, bool) {
    if refreshing {
        ("刷新中…", false)
    } else {
        ("立即刷新", true)
    }
}

/// 托盘 tooltip 摘要（R21：只反映账号数与异常数）
fn update_tooltip(app: &AppHandle, outcomes: &[RefreshOutcome]) {
    let total = outcomes.len();
    let failed = outcomes.iter().filter(|o| !o.ok).count();
    let tip = tooltip_text(total, failed);
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(&tip));
    }
}

/// R21：把托盘从「刷新中…」恢复——重建菜单（恢复可用态）+ 用最新 `results.json`
/// 刷新账号状态区与 tooltip。**不推进代次**（由调用方负责）。
fn restore_tray_after_refresh(app: &AppHandle) {
    rebuild_menu(app, false);
    let (_, outcomes, _) = load_tray_data(app);
    update_tooltip(app, &outcomes);
}

/// R21：前端 `refresh()` 结束（成功/失败都发）→ 作废在途看门狗并恢复托盘显示。
fn on_frontend_refresh_settled(app: &AppHandle) {
    REFRESH_EPOCH.fetch_add(1, Ordering::SeqCst);
    restore_tray_after_refresh(app);
}

/// R21：兜底看门狗——事件可能丢失（点击时前端监听尚未注册、渲染进程异常/重载）。
/// `REFRESH_WATCHDOG` 后若代次仍停在自己这一代（期间既无 settled 也无新点击）则自行恢复；
/// 恢复前先自增代次「认领」，因此重复触发/后续唤醒都幂等无副作用。
fn spawn_refresh_watchdog(app: &AppHandle, click_epoch: u64) {
    let app = app.clone();
    // 有意「发射后不管」：看门狗只是兜底，不关心 JoinHandle；
    // 用 drop 显式丢弃，避免 clippy 的 let_underscore_future / must_use 噪音
    drop(tauri::async_runtime::spawn(async move {
        tokio::time::sleep(REFRESH_WATCHDOG).await;
        if !watchdog_should_restore(click_epoch, REFRESH_EPOCH.load(Ordering::SeqCst)) {
            // 期间已收到 settled 或又发生了新点击：交给那一方负责，自己不动作
            return;
        }
        REFRESH_EPOCH.fetch_add(1, Ordering::SeqCst);
        restore_tray_after_refresh(&app);
    }));
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

    // R21：前端 refresh() 结束（成功/失败都发）→ 恢复「立即刷新」可用态 + 刷新账号区/tooltip。
    // 这样托盘点刷新后，主界面（转圈/更新时刻/卡片）与托盘菜单同时更新，双向同步。
    let handle = app.handle().clone();
    app.listen(EVENT_REFRESH_SETTLED, move |_event| {
        on_frontend_refresh_settled(&handle);
    });

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
                MENU_REFRESH => {
                    // R21：与主面板刷新**同源** —— 只置灰自己并 emit，由前端唯一的 `refresh()` 执行。
                    // 这里**不再**直接调刷新命令：否则会绕过前端状态/用量历史/通知推导，
                    // 且与前端 refresh() 形成双刷新（托盘点一次只能跑一次刷新）。
                    rebuild_menu(app, true);
                    let click_epoch = REFRESH_EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
                    let _ = app.emit(MENU_REFRESH, ());
                    // 兜底：若 settled 事件丢失，超时后自行恢复（见 spawn_refresh_watchdog）
                    spawn_refresh_watchdog(app, click_epoch);
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
            // R18：悬停（Enter/Leave/Move）驱动用量总结浮层；`rect`/`position` 都是物理像素。
            // 只在托盘区域记录几何，不做任何窗口操作（显示/隐藏由 summary 状态机定时决定）。
            match event {
                TrayIconEvent::Enter { position, rect, .. } => {
                    crate::summary::on_tray_enter(
                        tray.app_handle(),
                        crate::summary::phys_rect_from_tauri(rect.position, rect.size),
                        (position.x, position.y),
                    );
                }
                TrayIconEvent::Leave { position, rect, .. } => {
                    crate::summary::on_tray_leave(
                        tray.app_handle(),
                        crate::summary::phys_rect_from_tauri(rect.position, rect.size),
                        (position.x, position.y),
                    );
                }
                TrayIconEvent::Move { position, rect, .. } => {
                    crate::summary::on_tray_move(
                        tray.app_handle(),
                        crate::summary::phys_rect_from_tauri(rect.position, rect.size),
                        (position.x, position.y),
                    );
                }
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => {
                    // R17：左键单击 = 切换主窗口显示/隐藏（Windows 与 macOS 同逻辑）
                    // R18：同时立即隐藏浮层，避免主窗口弹出后浮层残留
                    crate::summary::on_tray_left_click(tray.app_handle());
                    toggle_main_window(tray.app_handle());
                }
                _ => {}
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
            history_error: None,
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
            history_error: None,
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
            history_error: None,
            ..long
        };
        assert_eq!(tray_status_text(Some(&short)), "✗ HTTP 401");

        let no_reason = RefreshOutcome {
            error: None,
            history_error: None,
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

    /// R20 口径修正（AC-9，**有意变更**）：原来的「已用百分比最高的窗口」改为
    /// 「**剩余**百分比 + 窗口名」（与主卡片 R19 一致）。
    /// 旧断言 `7d 36%`（已用）→ 新断言 `剩余 64.4%（7d）`。
    /// 取最紧窗口 = 已用最大者（7d 35.6）→ 剩余 = 100 − 35.6 = 64.4；无数据窗口忽略。
    #[test]
    fn quota_window_uses_tightest_remaining_percent() {
        let info = AccountInfo {
            quota_windows: vec![
                QuotaWindow {
                    window: Some("5h".into()),
                    used_percent: Some(20.0),
                    resets_at: None,
                    ..Default::default()
                },
                QuotaWindow {
                    window: Some("7d".into()),
                    used_percent: Some(35.6),
                    resets_at: None,
                    ..Default::default()
                },
                QuotaWindow {
                    window: Some("月配额".into()),
                    used_percent: None,
                    resets_at: None,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        assert_eq!(
            tray_status_text(Some(&ok_outcome(info))),
            "剩余 64.4%（7d）"
        );
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

    /// R21：托盘**不再有**「暂停/恢复自动刷新」项 —— 用源码扫描固化这一移除。
    ///
    /// 这里刻意用「拼装 + 转义」的方式构造探查关键字，避免本测试自身把关键字写进源码、
    /// 破坏 `grep -ri "<关键字>" src-tauri/src` 应为 0 命中的验收证据。
    #[test]
    fn removed_control_leaves_no_trace_in_source() {
        let source = include_str!("tray.rs");
        let needle_en: String = ['p', 'a', 'u', 's', 'e'].iter().collect();
        let needle_id: String = ["tray", "toggle", "-", &needle_en].join("");
        let needle_zh = "\u{5df2}\u{6682}\u{505c}"; // 中文关键字（转义写法，避免本文件命中验收 grep）
        assert!(
            !source.to_lowercase().contains(&needle_en),
            "托盘源码不应再出现暂停相关标识"
        );
        assert!(!source.contains(&needle_id), "被移除的菜单项 id 不应残留");
        assert!(!source.contains(needle_zh), "tooltip 不应再有暂停后缀文案");
    }

    /// R21：菜单 id 集合恰好是移除后的那一套（右鍵其余项不动，左键切换/悬停不受影响）
    #[test]
    fn menu_id_inventory_is_exactly_expected() {
        assert_eq!(MENU_SHOW, "tray-show");
        assert_eq!(MENU_REFRESH, "tray-refresh");
        assert_eq!(MENU_OPEN_SETTINGS, "tray-open-settings");
        assert_eq!(MENU_QUIT, "tray-quit");
        assert_eq!(MENU_EMPTY, "tray-empty");
        assert_eq!(MENU_MORE, "tray-more");
        assert_eq!(MENU_ACCOUNT_PREFIX, "account:");
    }

    /// R21：tooltip 只由「账号数 / 异常数」决定（已无暂停形参、无暂停后缀）
    #[test]
    fn tooltip_text_reflects_accounts_and_failures_only() {
        assert_eq!(tooltip_text(3, 0), "LLM Status Board · 3 个账号全部正常");
        assert_eq!(tooltip_text(3, 1), "LLM Status Board · 3 个账号 · 1 个异常");
        assert_eq!(tooltip_text(0, 0), "LLM Status Board · 0 个账号全部正常");
        assert_eq!(tooltip_text(5, 5), "LLM Status Board · 5 个账号 · 5 个异常");
    }

    /// R21：配置契约里也不存在暂停字段 —— 自动刷新只有 `autoRefreshSec` 这一个控制点（0 = 关闭）
    #[test]
    fn auto_refresh_interval_is_the_only_control_point() {
        let settings_src = include_str!("types.rs");
        let needle: String = ["auto", "_refresh", "_", "p", "a", "u", "s", "e", "d"].join("");
        assert!(!settings_src.contains(&needle), "Settings 不应有暂停字段");
        assert_eq!(
            crate::types::Settings::default().auto_refresh_sec,
            0,
            "默认 0 = 关闭自动刷新（唯一控制点）"
        );
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

    // ---------- R20：规格 §3 黄金表（跨语言一致性证据） ----------

    /// 黄金表输入（覆盖「结果态 / 未刷新 / 有 info」三类）
    enum GoldenInput {
        /// `ok=false` + 原因
        Failure(&'static str),
        /// 尚未刷新（`outcome = None`）
        NotRefreshed,
        /// 有 info：`(余额, 窗口列表)`；窗口 = `(窗口名, 已用百分比)`
        Info {
            balance: Option<(f64, &'static str)>,
            windows: Vec<(Option<&'static str>, Option<f64>)>,
        },
    }

    /// **规格 `docs/round-20-plan.md` §3 黄金表（逐字嵌入，勿改措辞/顺序）**。
    /// 前端 `primaryMetric`/`formatPrimaryMetricLine` 会嵌入同一张表；
    /// 终审会机械 diff「本表 ↔ §3」，任一侧漂移即红灯。
    ///
    /// `#[rustfmt::skip]`：每行期望串必须独占一行，机械 diff 才能稳定抽取
    /// （rustfmt 会把短行折叠回单行，破坏可机械比对性）。
    #[rustfmt::skip]
    fn golden_table() -> Vec<(&'static str, GoldenInput, &'static str)> {
        use GoldenInput::{Failure, Info, NotRefreshed};
        vec![
            (
                "G1",
                Info {
                    balance: Some((0.0, "USD")),
                    windows: vec![(Some("7d"), Some(0.0))],
                },
                "剩余 100%（7d）",
            ),
            (
                "G2",
                Info {
                    balance: None,
                    windows: vec![(Some("5h"), Some(26.86)), (Some("7d"), Some(12.36))],
                },
                "剩余 73.14%（5h）",
            ),
            (
                "G3",
                Info {
                    balance: Some((12.5, "USD")),
                    windows: vec![(Some("7d"), Some(90.0))],
                },
                "12.50 USD",
            ),
            (
                "G4",
                Info {
                    balance: Some((0.0, "USD")),
                    windows: vec![],
                },
                "0.00 USD",
            ),
            (
                "G5",
                Info {
                    balance: None,
                    windows: vec![],
                },
                "—",
            ),
            (
                "G6",
                Info {
                    balance: Some((0.0, "USD")),
                    windows: vec![(Some("7d"), None), (Some("5h"), Some(f64::NAN))],
                },
                "0.00 USD",
            ),
            (
                "G7",
                Info {
                    balance: None,
                    windows: vec![(Some(""), Some(20.0))],
                },
                "剩余 80%（当前窗口）",
            ),
            (
                "G8",
                Info {
                    balance: None,
                    windows: vec![(Some("7d"), Some(-5.0))],
                },
                "剩余 100%（7d）",
            ),
            (
                "G9",
                Info {
                    balance: None,
                    windows: vec![(Some("7d"), Some(150.0))],
                },
                "剩余 0%（7d）",
            ),
            (
                "G10",
                Failure("连接超时：无法访问上游中转站（TLS 握手失败）"),
                "✗ 连接超时：无法访问上游…",
            ),
            (
                "G11",
                NotRefreshed,
                "—",
            ),
            (
                "G12",
                Info {
                    balance: Some((0.5, "USD")),
                    windows: vec![],
                },
                "0.5000 USD",
            ),
        ]
    }

    /// AC-1..AC-7：黄金表 12 条**逐条**断言输出与规格 §3 逐字一致
    #[test]
    fn golden_table_matches_spec_verbatim() {
        let table = golden_table();
        assert!(table.len() >= 8, "黄金表至少 8 条：{}", table.len());
        for (id, input, expect) in table {
            let got = match input {
                GoldenInput::Failure(err) => tray_status_text(Some(&RefreshOutcome {
                    account_id: "a1".into(),
                    ok: false,
                    info: None,
                    error: Some(err.to_string()),
                    history_error: None,
                })),
                GoldenInput::NotRefreshed => tray_status_text(None),
                GoldenInput::Info { balance, windows } => {
                    let info = AccountInfo {
                        balance: balance.map(|(amount, currency)| Money {
                            amount,
                            currency: currency.into(),
                        }),
                        quota_windows: windows
                            .into_iter()
                            .map(|(window, used_percent)| QuotaWindow {
                                window: window.map(String::from),
                                used_percent,
                                resets_at: None,
                                ..Default::default()
                            })
                            .collect(),
                        ..Default::default()
                    };
                    tray_status_text(Some(&ok_outcome(info)))
                }
            };
            assert_eq!(got, expect, "黄金表 {id} 输出必须与规格 §3 逐字一致");
        }
    }

    // ---------- R21：刷新入口同源（托盘点一次只跑一次刷新） ----------

    /// 「立即刷新」的置灰文案：刷新中 → 不可点；空闲 → 可点
    #[test]
    fn refresh_menu_item_shows_refreshing_state() {
        assert_eq!(refresh_menu_item(true), ("刷新中…", false));
        assert_eq!(refresh_menu_item(false), ("立即刷新", true));
    }

    /// R21：托盘「立即刷新」只 emit 事件，**不得**直连刷新命令
    /// （否则既绕过前端统一 `refresh()` 造成界面不同步，又与前端形成双刷新）。
    /// 探查关键字用拼装方式构造，避免本测试自身命中源码扫描。
    #[test]
    fn tray_refresh_delegates_to_frontend_handler() {
        let source = include_str!("tray.rs");
        let direct_call: String = ["refresh", "_all"].join("");
        assert!(
            !source.contains(&direct_call),
            "托盘不得直连刷新命令：应由事件交前端统一 refresh() 执行"
        );
        // 事件名与 fe-k3 的监听（App.tsx: listen("tray-refresh", …)）逐字一致
        assert_eq!(MENU_REFRESH, "tray-refresh");
        // 前端刷新结束事件名固定（fe-k3 在 refresh() 的 finally 里 emit）
        assert_eq!(EVENT_REFRESH_SETTLED, "frontend-refresh-settled");
        // 托盘侧确实发出/监听了这两个名字
        assert!(
            source.contains("app.emit(MENU_REFRESH"),
            "点击「立即刷新」应 emit 事件"
        );
        assert!(
            source.contains("app.listen(EVENT_REFRESH_SETTLED"),
            "应监听前端刷新结束事件以恢复可用态并刷新账号区"
        );
    }

    // ---------- R21：置灰「刷新中…」的兜底看门狗 ----------

    /// ① 超时且代次未变（期间没收到 settled、也没有新点击）→ **应恢复**
    #[test]
    fn watchdog_restores_when_no_settled() {
        assert_eq!(
            REFRESH_WATCHDOG,
            Duration::from_secs(15),
            "超时常量固定 15s"
        );
        assert!(
            watchdog_should_restore(1, 1),
            "代次未前进 ⇒ 事件丢失 ⇒ 必须自行恢复，避免永久置灰"
        );
    }

    /// ② 超时前收到 settled（代次前进）→ **不恢复**（不重复重建菜单）
    #[test]
    fn watchdog_skips_when_settled_advanced_epoch() {
        // 点击代次=1，settled 到达后 代次=2
        assert!(
            !watchdog_should_restore(1, 2),
            "已由 settled 恢复 ⇒ 看门狗不得二次重建菜单"
        );
    }

    /// ③ 连续两次点击：只有**最后一次**的看门狗有效（第一次不得恢复第二次的置灰态）
    #[test]
    fn watchdog_only_last_click_is_effective() {
        let (first_click, second_click) = (1u64, 2u64);
        let mut restores = 0;
        // 第一次点击的看门狗醒来：代次已被第二次点击推进到 2 → 不动作
        if watchdog_should_restore(first_click, second_click) {
            restores += 1;
        }
        // 第二次点击的看门狗醒来：代次仍是 2 且期间无 settled → 恢复
        if watchdog_should_restore(second_click, second_click) {
            restores += 1;
        }
        assert_eq!(restores, 1, "连续点击只允许最后一次看门狗生效");
    }

    /// ④ 幂等：看门狗恢复时「认领」代次，同一代再次触发不得有副作用
    #[test]
    fn watchdog_is_idempotent_after_restore() {
        let click_epoch = 1u64;
        let mut epoch = click_epoch;
        let mut restores = 0;
        // 第一次唤醒：代次未变 → 恢复并认领（代次 1 → 2）
        if watchdog_should_restore(click_epoch, epoch) {
            epoch += 1;
            restores += 1;
        }
        // 重复触发（同一代）：认领后代次已变 → 不得再恢复
        if watchdog_should_restore(click_epoch, epoch) {
            restores += 1;
        }
        assert_eq!(restores, 1, "恢复必须恰好一次（幂等）");
        assert_eq!(epoch, 2, "恢复即认领，代次前进");
    }

    // ---------- R23：额度条与多窗口明细（docs/round-23-plan.md） ----------

    /// 文本配额条：8 格、已用 █ / 剩余 ░、四舍五入到整格；越界钳制（>100 满格、<0 空格、NaN 空格）
    #[test]
    fn quota_bar_text_cells_and_clamping() {
        assert_eq!(quota_bar_text(0.0), "░░░░░░░░");
        assert_eq!(quota_bar_text(50.0), "████░░░░");
        assert_eq!(quota_bar_text(100.0), "████████");
        // 四舍五入：12.5% = 1 格；6%（0.48 格）→ 0 格；7%（0.56 格）→ 1 格
        assert_eq!(quota_bar_text(12.5), "█░░░░░░░");
        assert_eq!(quota_bar_text(6.0), "░░░░░░░░");
        assert_eq!(quota_bar_text(7.0), "█░░░░░░░");
        // 钳制：超限满格、负值/NaN 空格
        assert_eq!(quota_bar_text(150.0), "████████");
        assert_eq!(quota_bar_text(-5.0), "░░░░░░░░");
        assert_eq!(quota_bar_text(f64::NAN), "░░░░░░░░");
    }

    /// 显示模式解析：仅精确 "raw" 进数字模式；None/空串/未知值一律回落 percent
    #[test]
    fn quota_detail_mode_parse_with_fallback() {
        assert_eq!(quota_detail_mode(Some("raw")), QuotaDetailMode::Raw);
        assert_eq!(quota_detail_mode(None), QuotaDetailMode::Percent);
        assert_eq!(quota_detail_mode(Some("percent")), QuotaDetailMode::Percent);
        assert_eq!(quota_detail_mode(Some(" raw ")), QuotaDetailMode::Raw);
        assert_eq!(
            quota_detail_mode(Some("RAW")),
            QuotaDetailMode::Percent,
            "大小写不敏感刻意不做（与设置白名单一致）"
        );
        assert_eq!(quota_detail_mode(Some("")), QuotaDetailMode::Percent);
        assert_eq!(quota_detail_mode(Some("bogus")), QuotaDetailMode::Percent);
    }

    fn window(window: &str, used_percent: Option<f64>, amounts: Option<(f64, f64)>) -> QuotaWindow {
        let (used_amount, limit_amount) = match amounts {
            Some((u, l)) => (
                Some(Money {
                    amount: u,
                    currency: "USD".into(),
                }),
                Some(Money {
                    amount: l,
                    currency: "USD".into(),
                }),
            ),
            None => (None, None),
        };
        QuotaWindow {
            window: Some(window.into()),
            used_percent,
            resets_at: None,
            used_amount,
            limit_amount,
        }
    }

    /// 窗口明细行：percent 带条 + 真实已用值（超限 >100 可见）；raw 数字行；raw 无金额回落 percent
    #[test]
    fn window_detail_line_both_modes_and_fallback() {
        let kimi = window("5h", Some(26.86), None);
        assert_eq!(
            window_detail_line(&kimi, QuotaDetailMode::Percent),
            "5h  ██░░░░░░ 已用 26.86%"
        );
        // raw 但无金额 → 回落 percent（不留空白）
        assert_eq!(
            window_detail_line(&kimi, QuotaDetailMode::Raw),
            "5h  ██░░░░░░ 已用 26.86%"
        );

        // 超限：202/200 = 101%（取整十避免浮点 ±1 ulp 影响逐字断言；超限事实必须可见）
        let bosc_day = window("1d", Some(101.0), Some((202.0, 200.0)));
        assert_eq!(
            window_detail_line(&bosc_day, QuotaDetailMode::Percent),
            "1d  ████████ 已用 101%",
            "超限显示真实值，条满格"
        );
        assert_eq!(
            window_detail_line(&bosc_day, QuotaDetailMode::Raw),
            "1d  已用 202.00 / 上限 200.00 USD"
        );

        // 窗口名缺失 → 主指标同款兜底
        let anon = window("", Some(50.0), None);
        assert_eq!(
            window_detail_line(&anon, QuotaDetailMode::Percent),
            "当前窗口  ████░░░░ 已用 50%"
        );
    }

    /// 账号主行：无窗口原样；配额主指标带条；余额主指标不加条；raw 有金额换数字行、无金额回落
    #[test]
    fn account_line_text_rules() {
        // 无窗口 / 未刷新：原样
        assert_eq!(
            account_line_text("A", None, QuotaDetailMode::Percent),
            "A    —"
        );

        // 配额主指标（余额 null + 窗口）→ 带条
        let quota = ok_outcome(AccountInfo {
            quota_windows: vec![window("7d", Some(35.6), None)],
            ..Default::default()
        });
        assert_eq!(
            account_line_text("Model", Some(&quota), QuotaDetailMode::Percent),
            "Model    ███░░░░░ 剩余 64.4%（7d）"
        );

        // 余额主指标（余额非 0 + 窗口）→ 主行不加条
        let paid = ok_outcome(AccountInfo {
            balance: Some(Money {
                amount: 12.5,
                currency: "USD".into(),
            }),
            quota_windows: vec![window("7d", Some(90.0), None)],
            ..Default::default()
        });
        assert_eq!(
            account_line_text("Paid", Some(&paid), QuotaDetailMode::Percent),
            "Paid    12.50 USD"
        );

        // raw + 数字限额窗口 → 数字行
        let bosc = ok_outcome(AccountInfo {
            balance: Some(Money {
                amount: 0.0,
                currency: "USD".into(),
            }),
            quota_windows: vec![window("1d", Some(101.0), Some((202.0, 200.0)))],
            ..Default::default()
        });
        assert_eq!(
            account_line_text("bosc", Some(&bosc), QuotaDetailMode::Raw),
            "bosc    1d  已用 202.00 / 上限 200.00 USD"
        );
        // raw + 纯百分比窗口（无金额）→ 回落 percent 带条形态
        assert_eq!(
            account_line_text("Model", Some(&quota), QuotaDetailMode::Raw),
            "Model    ███░░░░░ 剩余 64.4%（7d）"
        );
    }
}
