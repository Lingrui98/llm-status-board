//! R18 托盘悬停「用量总结」浮层（窗口 label `summary`）的后端实现。
//!
//! 本模块只负责后端：**悬停状态机与定时器**、**窗口显示/隐藏与定位**、以及给浮层的 IPC。
//! 浮层 UI 由前端 `summary.html` 负责（与主界面共用同一套设计语言）。
//!
//! 设计要点：
//! - 状态机（[`next_hover_state`] / [`due_action`]）与定位（[`popup_position`]）都是
//!   **纯函数**，可在无 GUI 环境下单测（对应规格 AC-1..AC-8）。
//! - **同一时刻最多一个待执行定时器**：用全局 generation 计数让旧定时器失效。
//! - 浮层窗口由 `tauri.conf.json` 声明（启动即创建、`visible:false`），显示/隐藏用
//!   `show()`/`hide()`，**不销毁**，避免每次悬停重建 WebView。
//! - 与 R17 左键切换、右键菜单、tooltip 摘要互不干扰（浮层出现时不改 tooltip）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, LogicalPosition, Manager, Position, Size};

// ---------- 常量（规格 §1/§2/§3） ----------

/// Enter → 显示的延迟（防误触闪烁）
pub const HOVER_SHOW_DELAY_MS: u64 = 150;
/// Leave → 隐藏的延迟（留出指针移入浮层的余量）
pub const HOVER_HIDE_DELAY_MS: u64 = 250;
/// `Move` 触发重定位的节流间隔
pub const MOVE_REPOSITION_THROTTLE_MS: u64 = 100;
/// 浮层窗口逻辑尺寸（与 tauri.conf.json 一致）
pub const POPUP_WIDTH: f64 = 300.0;
pub const POPUP_HEIGHT: f64 = 360.0;
/// 浮层与图标/工作区边缘的间距（物理像素）
pub const POPUP_GAP: f64 = 8.0;
/// 浮层窗口 label
pub const POPUP_LABEL: &str = "summary";

// ---------- 悬停状态机（纯函数） ----------

/// 待执行定时器类型
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PendingTimer {
    Show,
    Hide,
}

/// 驱动状态机的事件
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoverEvent {
    /// 指针进入托盘图标
    Enter,
    /// 指针离开托盘图标
    Leave,
    /// 指针在托盘图标上移动（只重定位，不改显隐状态）
    Move,
    /// 指针进入浮层（前端 IPC 回报）
    PointerEnter,
    /// 指针离开浮层（前端 IPC 回报）
    PointerLeave,
    /// Escape 键
    Escape,
    /// 浮层失焦
    Blur,
    /// 点击账号行
    RowClick,
    /// 托盘左键（R17 切换主窗口的同时必须隐藏浮层）
    TrayLeftClick,
    /// 主窗口获得焦点
    MainFocus,
}

/// 状态机输出：立刻要执行的动作
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PopupAction {
    /// 什么都不做
    None,
    /// 取消待执行定时器（不改显隐）
    CancelPending,
    /// 起一个「延迟显示」定时器
    ScheduleShow,
    /// 起一个「延迟隐藏」定时器
    ScheduleHide,
    /// 立即显示
    ShowNow,
    /// 立即隐藏
    HideNow,
}

/// 悬停状态（`pending` 是单个 Option → 天然保证「最多一个待执行定时器」）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct HoverState {
    /// 浮层当前是否可见
    pub visible: bool,
    /// 指针是否在浮层内（由前端回报）
    pub pointer_inside: bool,
    /// 待执行定时器：`(类型, 截止时刻 ms)`
    pub pending: Option<(PendingTimer, u64)>,
}

impl HoverState {
    pub const fn new() -> Self {
        Self {
            visible: false,
            pointer_inside: false,
            pending: None,
        }
    }
}

/// 悬停状态机（规格 §1，纯函数）：返回新状态 + 要立刻执行的动作。
///
/// - `Enter`：未显示 → 150ms 后显示；**已显示 → 不重置、不重放动画**。
/// - `Leave`：已显示 → 250ms 后隐藏（期间可被 `PointerEnter` 取消）；未显示 → 取消待显示。
/// - `PointerEnter`：取消待隐藏；`PointerLeave`：重新起 250ms 隐藏。
/// - `Escape`/`Blur`/`RowClick`/`TrayLeftClick`/`MainFocus` → **立即隐藏（延迟 0）并清定时器**。
pub fn next_hover_state(
    state: HoverState,
    event: HoverEvent,
    now_ms: u64,
) -> (HoverState, PopupAction) {
    match event {
        HoverEvent::Enter => {
            if state.visible {
                (state, PopupAction::None)
            } else {
                (
                    HoverState {
                        visible: false,
                        pointer_inside: state.pointer_inside,
                        pending: Some((PendingTimer::Show, now_ms + HOVER_SHOW_DELAY_MS)),
                    },
                    PopupAction::ScheduleShow,
                )
            }
        }
        HoverEvent::Leave => {
            if state.visible {
                (
                    HoverState {
                        visible: true,
                        pointer_inside: state.pointer_inside,
                        pending: Some((PendingTimer::Hide, now_ms + HOVER_HIDE_DELAY_MS)),
                    },
                    PopupAction::ScheduleHide,
                )
            } else {
                let action = if state.pending.is_some() {
                    PopupAction::CancelPending
                } else {
                    PopupAction::None
                };
                (
                    HoverState {
                        visible: false,
                        pointer_inside: state.pointer_inside,
                        pending: None,
                    },
                    action,
                )
            }
        }
        HoverEvent::PointerEnter => {
            let action = if state.pending.is_some() {
                PopupAction::CancelPending
            } else {
                PopupAction::None
            };
            (
                HoverState {
                    visible: state.visible,
                    pointer_inside: true,
                    pending: None,
                },
                action,
            )
        }
        HoverEvent::PointerLeave => {
            if state.visible {
                (
                    HoverState {
                        visible: true,
                        pointer_inside: false,
                        pending: Some((PendingTimer::Hide, now_ms + HOVER_HIDE_DELAY_MS)),
                    },
                    PopupAction::ScheduleHide,
                )
            } else {
                (
                    HoverState {
                        visible: false,
                        pointer_inside: false,
                        pending: state.pending,
                    },
                    PopupAction::None,
                )
            }
        }
        // 只重定位，不动显隐（节流另行处理）
        HoverEvent::Move => (state, PopupAction::None),
        HoverEvent::Escape
        | HoverEvent::Blur
        | HoverEvent::RowClick
        | HoverEvent::TrayLeftClick
        | HoverEvent::MainFocus => (HoverState::new(), PopupAction::HideNow),
    }
}

/// 定时器到点判定（纯函数）：`None` = 还没到点；`Some(..)` = 该执行的动作。
/// 到点前的任意新事件都会替换/清除 `pending`（配合 generation 使旧定时器失效）。
pub fn due_action(state: HoverState, now_ms: u64) -> Option<PopupAction> {
    let (pending, deadline) = state.pending?;
    if now_ms < deadline {
        return None;
    }
    Some(match pending {
        PendingTimer::Show => PopupAction::ShowNow,
        PendingTimer::Hide => PopupAction::HideNow,
    })
}

// ---------- 定位（纯函数，物理进 / 逻辑出） ----------

/// 物理像素矩形（浮层定位内部统一用它算）
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PhysRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl PhysRect {
    pub const fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Self { x, y, w, h }
    }

    pub fn right(&self) -> f64 {
        self.x + self.w
    }

    pub fn bottom(&self) -> f64 {
        self.y + self.h
    }

    pub fn center_x(&self) -> f64 {
        self.x + self.w / 2.0
    }

    pub fn center_y(&self) -> f64 {
        self.y + self.h / 2.0
    }

    /// 是否包含某点（右/下边为开区间，避免边界算「压住光标」）
    pub fn contains_point(&self, px: f64, py: f64) -> bool {
        px >= self.x && px < self.right() && py >= self.y && py < self.bottom()
    }
}

/// 把 tauri 的 `Position`/`Size`（可能是逻辑或物理）转成本模块的物理矩形。
///
/// 托盘几何在 Windows/macOS 上都是**物理像素**（`Physical` 变体会原样返回）；
/// 逻辑变体理论上不会出现，这里按 scale=1 兜底，绝不产出 NaN。
pub fn phys_rect_from_tauri(position: Position, size: Size) -> PhysRect {
    let p = position.to_physical::<f64>(1.0);
    let s = size.to_physical::<f64>(1.0);
    PhysRect::new(p.x, p.y, s.width, s.height)
}

/// 图标相对工作区哪一侧空间最大 → 浮层就放那一侧（任务栏在哪，浮层就在其对面）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Side {
    Above,
    Below,
    Left,
    Right,
}

impl Side {
    fn opposite(self) -> Self {
        match self {
            Self::Above => Self::Below,
            Self::Below => Self::Above,
            Self::Left => Self::Right,
            Self::Right => Self::Left,
        }
    }

    /// 该侧放得下吗（含 `margin` 边距）
    fn fits(self, rect: PhysRect, work: PhysRect, margin: f64) -> bool {
        match self {
            Self::Above => rect.y >= work.y + margin,
            Self::Below => rect.bottom() <= work.bottom() - margin,
            Self::Left => rect.x >= work.x + margin,
            Self::Right => rect.right() <= work.right() - margin,
        }
    }
}

/// 按侧别摆放：主轴贴图标外侧 `gap`，另一轴与图标中心对齐
fn place(side: Side, icon: PhysRect, pw: f64, ph: f64, gap: f64) -> PhysRect {
    match side {
        Side::Above => PhysRect::new(icon.center_x() - pw / 2.0, icon.y - gap - ph, pw, ph),
        Side::Below => PhysRect::new(icon.center_x() - pw / 2.0, icon.bottom() + gap, pw, ph),
        Side::Left => PhysRect::new(icon.x - gap - pw, icon.center_y() - ph / 2.0, pw, ph),
        Side::Right => PhysRect::new(icon.right() + gap, icon.center_y() - ph / 2.0, pw, ph),
    }
}

/// 把矩形 clamp 进工作区（含 `margin`）。工作区比浮层还小时取左上角，保证不越屏。
fn clamp_rect(rect: PhysRect, work: PhysRect, margin: f64) -> PhysRect {
    let min_x = work.x + margin;
    let max_x = (work.right() - margin - rect.w).max(min_x);
    let min_y = work.y + margin;
    let max_y = (work.bottom() - margin - rect.h).max(min_y);
    PhysRect::new(
        rect.x.clamp(min_x, max_x),
        rect.y.clamp(min_y, max_y),
        rect.w,
        rect.h,
    )
}

/// 由「显示器完整 bounds 与 work area 的差集」判断任务栏方位（规格 §2 的选边依据）。
/// 返回的是**浮层应放置的一侧**（任务栏在哪，浮层就放它对面）。
/// `work == bounds`（任务栏自动隐藏/无任务栏）→ `None`，退回「空间最大的一侧」。
fn taskbar_side(bounds: PhysRect, work: PhysRect) -> Option<Side> {
    const EPS: f64 = 1.0;
    if work.bottom() < bounds.bottom() - EPS {
        return Some(Side::Above); // 任务栏在下 → 浮层在上
    }
    if work.y > bounds.y + EPS {
        return Some(Side::Below); // 任务栏在上 → 浮层在下
    }
    if work.x > bounds.x + EPS {
        return Some(Side::Right); // 任务栏在左 → 浮层在右
    }
    if work.right() < bounds.right() - EPS {
        return Some(Side::Left); // 任务栏在右 → 浮层在左
    }
    None
}

/// 无任务栏信息时的退路：图标到工作区四边中**空间最大**的一侧
fn widest_side(icon: PhysRect, work: PhysRect) -> Side {
    [
        (Side::Above, icon.y - work.y),
        (Side::Below, work.bottom() - icon.bottom()),
        (Side::Left, icon.x - work.x),
        (Side::Right, work.right() - icon.right()),
    ]
    .into_iter()
    .max_by(|a, b| a.1.total_cmp(&b.1))
    .map(|(side, _)| side)
    .unwrap_or(Side::Above)
}

/// 浮层定位（规格 §2，纯函数）：**物理像素进、逻辑像素出**。
///
/// - `icon`：托盘图标矩形（物理）；`cursor`：光标位置（物理）
/// - `bounds`：**光标所在显示器**的完整区域（物理，用来判断任务栏方位）
/// - `work`：**光标所在显示器**的 work area（物理，浮层必须落在它里面）
/// - `scale`：该显示器缩放因子（非正/非有限按 1 处理）
/// - `popup_logical`：浮层逻辑尺寸（见 [`POPUP_WIDTH`]/[`POPUP_HEIGHT`]）
///
/// 选边：任务栏在哪就放对面（`work == bounds` 时取空间最大侧）；该侧放不下 → 退对面侧；
/// 仍放不下 → 在工作区内 clamp（绝不越屏）。最后保证矩形**不与光标点相交**（不压光标）。
pub fn popup_position(
    icon: PhysRect,
    cursor: (f64, f64),
    bounds: PhysRect,
    work: PhysRect,
    scale: f64,
    popup_logical: (f64, f64),
) -> (f64, f64) {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let pw = popup_logical.0 * scale;
    let ph = popup_logical.1 * scale;
    let gap = POPUP_GAP;

    let primary = taskbar_side(bounds, work).unwrap_or_else(|| widest_side(icon, work));

    let mut rect = place(primary, icon, pw, ph, gap);
    if !primary.fits(rect, work, gap) {
        let opposite = primary.opposite();
        let alt = place(opposite, icon, pw, ph, gap);
        rect = if opposite.fits(alt, work, gap) {
            alt
        } else {
            clamp_rect(rect, work, gap)
        };
    }
    // 另一轴（以及最终结果）一并 clamp 进工作区
    rect = clamp_rect(rect, work, gap);

    // 最后一道保险：clamp 之后若仍压住光标，沿主轴把它推到光标之外
    if rect.contains_point(cursor.0, cursor.1) {
        rect = match primary {
            Side::Above => PhysRect::new(rect.x, (cursor.1 - rect.h).min(rect.y), rect.w, rect.h),
            Side::Below => PhysRect::new(rect.x, (cursor.1 + 1.0).max(rect.y), rect.w, rect.h),
            Side::Left => PhysRect::new((cursor.0 - rect.w).min(rect.x), rect.y, rect.w, rect.h),
            Side::Right => PhysRect::new((cursor.0 + 1.0).max(rect.x), rect.y, rect.w, rect.h),
        };
        rect = clamp_rect(rect, work, gap);
    }
    (rect.x / scale, rect.y / scale)
}

// ---------- 运行态（全局单例） ----------

static HOVER_STATE: Mutex<HoverState> = Mutex::new(HoverState::new());
/// 定时器代号：任何新事件/立即动作都会自增，使旧定时器作废
static TIMER_GEN: AtomicU64 = AtomicU64::new(0);
/// 上次 `Move` 重定位时刻
static LAST_MOVE_MS: AtomicU64 = AtomicU64::new(0);
/// 最近一次悬停几何（图标矩形 + 光标），显示时用它定位
static LAST_GEOMETRY: Mutex<Option<(PhysRect, (f64, f64))>> = Mutex::new(None);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 访问全局状态（Mutex 中毒时取回内部值，不让一次 panic 永久锁死浮层）
fn with_state<R>(f: impl FnOnce(&mut HoverState) -> R) -> R {
    let mut guard = HOVER_STATE.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut guard)
}

fn remember_geometry(icon: PhysRect, cursor: (f64, f64)) {
    let mut guard = LAST_GEOMETRY.lock().unwrap_or_else(|e| e.into_inner());
    *guard = Some((icon, cursor));
}

fn last_geometry() -> Option<(PhysRect, (f64, f64))> {
    *LAST_GEOMETRY.lock().unwrap_or_else(|e| e.into_inner())
}

fn hide_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(POPUP_LABEL) {
        let _ = window.hide();
    }
}

fn show_window(app: &AppHandle) {
    position_window(app);
    if let Some(window) = app.get_webview_window(POPUP_LABEL) {
        let _ = window.show();
    }
}

/// 用最近一次几何 + 光标所在显示器的 work area 给浮层定位
fn position_window(app: &AppHandle) {
    let Some((icon, cursor)) = last_geometry() else {
        return;
    };
    let Some(window) = app.get_webview_window(POPUP_LABEL) else {
        return;
    };
    let Ok(Some(monitor)) = app.monitor_from_point(cursor.0, cursor.1) else {
        return;
    };
    let area = monitor.work_area();
    let work = PhysRect::new(
        area.position.x as f64,
        area.position.y as f64,
        area.size.width as f64,
        area.size.height as f64,
    );
    // 完整显示器区域：与 work area 相减即可判断任务栏在哪一侧
    let size = monitor.size();
    let origin = monitor.position();
    let bounds = PhysRect::new(
        origin.x as f64,
        origin.y as f64,
        size.width as f64,
        size.height as f64,
    );
    let (x, y) = popup_position(
        icon,
        cursor,
        bounds,
        work,
        monitor.scale_factor(),
        (POPUP_WIDTH, POPUP_HEIGHT),
    );
    let _ = window.set_position(LogicalPosition::new(x, y));
}

/// 起一个待执行定时器（会先让同类型的旧定时器失效）
fn schedule_timer(app: &AppHandle, kind: PendingTimer, delay_ms: u64) {
    let generation = TIMER_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let deadline = now_ms() + delay_ms;
    let app = app.clone();
    std::thread::spawn(move || {
        // 睡到截止时刻：循环 + 小步长，避免调度抖动导致提前唤醒
        loop {
            let now = now_ms();
            if now >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis((deadline - now).min(50)));
        }
        // 期间若有新事件，本次定时器已被取消
        if TIMER_GEN.load(Ordering::SeqCst) != generation {
            return;
        }
        let now = now_ms();
        let Some(action) = with_state(|state| due_action(*state, now)) else {
            return;
        };
        // 只执行与本次定时器同类型的动作
        let effective = match (kind, action) {
            (PendingTimer::Show, PopupAction::ShowNow) => PopupAction::ShowNow,
            (PendingTimer::Hide, PopupAction::HideNow) => PopupAction::HideNow,
            _ => return,
        };
        with_state(|state| {
            state.visible = effective == PopupAction::ShowNow;
            state.pending = None;
        });
        match effective {
            PopupAction::ShowNow => show_window(&app),
            _ => hide_window(&app),
        }
    });
}

/// 处理一次悬停事件：跑状态机 → 更新状态 → 执行动作
pub fn handle_hover_event(app: &AppHandle, event: HoverEvent) {
    let now = now_ms();
    let action = with_state(|state| {
        let (next, action) = next_hover_state(*state, event, now);
        *state = next;
        action
    });
    match action {
        PopupAction::None => {}
        PopupAction::CancelPending => {
            TIMER_GEN.fetch_add(1, Ordering::SeqCst);
        }
        PopupAction::ScheduleShow => schedule_timer(app, PendingTimer::Show, HOVER_SHOW_DELAY_MS),
        PopupAction::ScheduleHide => schedule_timer(app, PendingTimer::Hide, HOVER_HIDE_DELAY_MS),
        PopupAction::ShowNow => {
            TIMER_GEN.fetch_add(1, Ordering::SeqCst);
            show_window(app);
        }
        PopupAction::HideNow => {
            TIMER_GEN.fetch_add(1, Ordering::SeqCst);
            hide_window(app);
        }
    }
}

// ---------- 供 tray.rs / commands.rs 调用的入口 ----------

/// 指针进入托盘图标（记录几何 + 起 150ms 显示定时器）
pub fn on_tray_enter(app: &AppHandle, icon: PhysRect, cursor: (f64, f64)) {
    remember_geometry(icon, cursor);
    handle_hover_event(app, HoverEvent::Enter);
}

/// 指针离开托盘图标（已显示 → 250ms 后隐藏；未显示 → 取消待显示）
pub fn on_tray_leave(app: &AppHandle, icon: PhysRect, cursor: (f64, f64)) {
    remember_geometry(icon, cursor);
    handle_hover_event(app, HoverEvent::Leave);
}

/// 指针在托盘图标上移动：记录几何 + 状态机（Move 不改显隐），浮层可见时按 ≥100ms 节流重定位
pub fn on_tray_move(app: &AppHandle, icon: PhysRect, cursor: (f64, f64)) {
    remember_geometry(icon, cursor);
    handle_hover_event(app, HoverEvent::Move);
    let now = now_ms();
    let last = LAST_MOVE_MS.load(Ordering::SeqCst);
    if now.saturating_sub(last) < MOVE_REPOSITION_THROTTLE_MS {
        return;
    }
    LAST_MOVE_MS.store(now, Ordering::SeqCst);
    if with_state(|state| state.visible) {
        position_window(app);
    }
}

/// 托盘左键：立即隐藏浮层（R17 的切换主窗口由 tray.rs 继续处理）
pub fn on_tray_left_click(app: &AppHandle) {
    handle_hover_event(app, HoverEvent::TrayLeftClick);
}

/// 主窗口获得焦点 → 立即隐藏浮层
pub fn on_main_focus(app: &AppHandle) {
    handle_hover_event(app, HoverEvent::MainFocus);
}

/// 浮层自身失焦（Rust 侧 `WindowEvent::Focused(false)`）→ 立即隐藏
pub fn on_popup_blur(app: &AppHandle) {
    handle_hover_event(app, HoverEvent::Blur);
}

/// 点击浮层里的账号行 → 立即隐藏（走 RowClick 语义，与 Escape 区分便于日后扩展）
pub fn on_row_click(app: &AppHandle) {
    handle_hover_event(app, HoverEvent::RowClick);
}

/// 浮层内指针进入/离开（IPC `set_summary_pointer_inside`）
pub fn set_pointer_inside(app: &AppHandle, inside: bool) {
    handle_hover_event(
        app,
        if inside {
            HoverEvent::PointerEnter
        } else {
            HoverEvent::PointerLeave
        },
    );
}

/// 立即隐藏（IPC `hide_summary_popup` / Escape / blur / 行点击）
pub fn hide_now(app: &AppHandle) {
    handle_hover_event(app, HoverEvent::Escape);
}

/// 立即显示（IPC `show_summary_popup`，兜底入口：不依赖悬停）
pub fn show_now(app: &AppHandle) {
    TIMER_GEN.fetch_add(1, Ordering::SeqCst);
    with_state(|state| {
        state.visible = true;
        state.pending = None;
    });
    show_window(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一块 1920×1080 的完整显示器区域（物理像素）
    fn bounds_full() -> PhysRect {
        PhysRect::new(0.0, 0.0, 1920.0, 1080.0)
    }

    /// 任务栏在下方（占 40px）：work area 比 bounds 少下面一条
    fn work_bottom_taskbar() -> PhysRect {
        PhysRect::new(0.0, 0.0, 1920.0, 1040.0)
    }

    // ---------- AC-1 / AC-2 / AC-3 / AC-4：状态机 ----------

    /// AC-1：Enter → ScheduleShow，149ms 未到点、150ms 到点显示
    #[test]
    fn enter_shows_at_150ms_not_before() {
        let (state, action) = next_hover_state(HoverState::new(), HoverEvent::Enter, 0);
        assert_eq!(action, PopupAction::ScheduleShow);
        assert_eq!(state.pending, Some((PendingTimer::Show, 150)));
        assert_eq!(due_action(state, 149), None, "149ms 不该显示");
        assert_eq!(due_action(state, 150), Some(PopupAction::ShowNow));
    }

    /// AC-1：Leave（已显示）→ ScheduleHide，249ms 未隐藏、250ms 隐藏
    #[test]
    fn leave_hides_at_250ms_not_before() {
        let visible = HoverState {
            visible: true,
            pointer_inside: false,
            pending: None,
        };
        let (state, action) = next_hover_state(visible, HoverEvent::Leave, 1000);
        assert_eq!(action, PopupAction::ScheduleHide);
        assert_eq!(state.pending, Some((PendingTimer::Hide, 1250)));
        assert_eq!(due_action(state, 1249), None, "249ms 不该隐藏");
        assert_eq!(due_action(state, 1250), Some(PopupAction::HideNow));
    }

    /// 未显示时 Leave：取消待显示定时器（防误触）
    #[test]
    fn leave_before_show_cancels_pending_show() {
        let (pending, _) = next_hover_state(HoverState::new(), HoverEvent::Enter, 0);
        let (state, action) = next_hover_state(pending, HoverEvent::Leave, 50);
        assert_eq!(action, PopupAction::CancelPending);
        assert_eq!(state.pending, None, "定时器必须被清掉");
        assert!(!state.visible);
        // 没有待执行定时器时 Leave 不再产生动作
        let (_, action2) = next_hover_state(state, HoverEvent::Leave, 60);
        assert_eq!(action2, PopupAction::None);
    }

    /// AC-3：Leave 后浮层内指针回报 → 取消隐藏；再离开 → 重新 250ms 隐藏
    #[test]
    fn pointer_enter_cancels_hide_then_leave_reschedules() {
        let visible = HoverState {
            visible: true,
            pointer_inside: false,
            pending: None,
        };
        let (leaving, action) = next_hover_state(visible, HoverEvent::Leave, 0);
        assert_eq!(action, PopupAction::ScheduleHide);

        let (inside, action) = next_hover_state(leaving, HoverEvent::PointerEnter, 100);
        assert_eq!(action, PopupAction::CancelPending, "指针进入浮层应取消隐藏");
        assert_eq!(inside.pending, None);
        assert!(inside.pointer_inside);
        assert!(inside.visible);

        let (outside, action) = next_hover_state(inside, HoverEvent::PointerLeave, 200);
        assert_eq!(action, PopupAction::ScheduleHide);
        assert_eq!(outside.pending, Some((PendingTimer::Hide, 450)));
        assert!(!outside.pointer_inside);
    }

    /// AC-2：连续 Enter/Leave 抖动后，任一时刻待执行定时器 ≤ 1，且动作总是「最新意图」
    #[test]
    fn jitter_keeps_at_most_one_pending_timer() {
        let mut state = HoverState::new();
        let mut schedule_count = 0;
        let mut cancel_count = 0;
        let mut pending_max = 0;
        for (i, event) in [
            HoverEvent::Enter,
            HoverEvent::Leave,
            HoverEvent::Enter,
            HoverEvent::Leave,
            HoverEvent::Enter,
            HoverEvent::Enter,
        ]
        .into_iter()
        .enumerate()
        {
            let (next, action) = next_hover_state(state, event, i as u64 * 10);
            state = next;
            match action {
                PopupAction::ScheduleShow | PopupAction::ScheduleHide => schedule_count += 1,
                PopupAction::CancelPending => cancel_count += 1,
                _ => {}
            }
            pending_max = pending_max.max(usize::from(state.pending.is_some()));
        }
        assert_eq!(pending_max, 1, "同一时刻最多一个待执行定时器");
        assert_eq!(schedule_count, 4, "四次 Enter 各起一个显示定时器");
        assert_eq!(cancel_count, 2, "两次 Leave 取消待显示");
        // 最后一次 Enter（t=50ms）→ 显示定时器截止 200ms
        assert_eq!(state.pending, Some((PendingTimer::Show, 200)));
    }

    /// §1：已显示时再次 Enter 不重置、不重放动画
    #[test]
    fn enter_while_visible_does_not_reset() {
        let visible = HoverState {
            visible: true,
            pointer_inside: false,
            pending: None,
        };
        let (state, action) = next_hover_state(visible, HoverEvent::Enter, 9999);
        assert_eq!(action, PopupAction::None);
        assert_eq!(state, visible);
    }

    /// AC-4：Escape / blur / 行点击 / 托盘左键 / 主窗口获焦 → 立即隐藏并清定时器
    #[test]
    fn immediate_hide_events_clear_state() {
        for event in [
            HoverEvent::Escape,
            HoverEvent::Blur,
            HoverEvent::RowClick,
            HoverEvent::TrayLeftClick,
            HoverEvent::MainFocus,
        ] {
            let busy = HoverState {
                visible: true,
                pointer_inside: true,
                pending: Some((PendingTimer::Hide, 10_000)),
            };
            let (state, action) = next_hover_state(busy, event, 5);
            assert_eq!(
                action,
                PopupAction::HideNow,
                "{event:?} 应立即隐藏（延迟 0）"
            );
            assert_eq!(state, HoverState::new(), "{event:?} 应清空状态与定时器");
        }
    }

    /// Move 不改显隐状态；节流常量与规格一致
    #[test]
    fn move_is_state_neutral_and_throttle_matches_spec() {
        let visible = HoverState {
            visible: true,
            pointer_inside: false,
            pending: None,
        };
        assert_eq!(
            next_hover_state(visible, HoverEvent::Move, 1),
            (visible, PopupAction::None)
        );
        assert_eq!(MOVE_REPOSITION_THROTTLE_MS, 100);
        assert_eq!(HOVER_SHOW_DELAY_MS, 150);
        assert_eq!(HOVER_HIDE_DELAY_MS, 250);
    }

    // ---------- AC-5..AC-8：定位 ----------

    /// AC-5：任务栏在下 → 浮层在图标上方；上/左/右同理；且都不压光标
    #[test]
    fn popup_placed_opposite_to_taskbar_side() {
        let bounds = bounds_full();
        let pw = (POPUP_WIDTH, POPUP_HEIGHT);
        let margin = POPUP_GAP;
        let phys = |x: f64, y: f64| PhysRect::new(x, y, POPUP_WIDTH, POPUP_HEIGHT);

        // 任务栏在下（work 少了底部 40px）→ 浮层在图标上方
        let icon = PhysRect::new(1800.0, 1000.0, 24.0, 24.0);
        let cursor = (icon.center_x(), icon.center_y());
        let (x, y) = popup_position(icon, cursor, bounds, work_bottom_taskbar(), 1.0, pw);
        let rect = phys(x, y);
        assert!(rect.bottom() <= icon.y, "任务栏在下 → 浮层应在图标上方");
        assert!(!rect.contains_point(cursor.0, cursor.1), "不得压住光标");

        // 任务栏在上 → 浮层在图标下方
        let work_top = PhysRect::new(0.0, 40.0, 1920.0, 1040.0);
        let icon_top = PhysRect::new(1800.0, 40.0, 24.0, 24.0);
        let cursor_top = (icon_top.center_x(), icon_top.center_y());
        let (x, y) = popup_position(icon_top, cursor_top, bounds, work_top, 1.0, pw);
        let rect = phys(x, y);
        assert!(rect.y >= icon_top.bottom(), "任务栏在上 → 浮层应在图标下方");
        assert!(!rect.contains_point(cursor_top.0, cursor_top.1));

        // 任务栏在左 → 浮层在图标右侧
        let work_left = PhysRect::new(40.0, 0.0, 1880.0, 1080.0);
        let icon_left = PhysRect::new(40.0, 500.0, 24.0, 24.0);
        let cursor_left = (icon_left.center_x(), icon_left.center_y());
        let (x, y) = popup_position(icon_left, cursor_left, bounds, work_left, 1.0, pw);
        let rect = phys(x, y);
        assert!(rect.x >= icon_left.right(), "任务栏在左 → 浮层应在图标右侧");
        assert!(!rect.contains_point(cursor_left.0, cursor_left.1));
        assert!(rect.x >= work_left.x + margin - 0.001, "不得侵入左侧任务栏");

        // 任务栏在右 → 浮层在图标左侧
        let work_right = PhysRect::new(0.0, 0.0, 1880.0, 1080.0);
        let icon_right = PhysRect::new(1856.0, 500.0, 24.0, 24.0);
        let cursor_right = (icon_right.center_x(), icon_right.center_y());
        let (x, y) = popup_position(icon_right, cursor_right, bounds, work_right, 1.0, pw);
        let rect = phys(x, y);
        assert!(
            rect.right() <= icon_right.x,
            "任务栏在右 → 浮层应在图标左侧"
        );
        assert!(!rect.contains_point(cursor_right.0, cursor_right.1));
        assert!(
            rect.right() <= work_right.right() - margin + 0.001,
            "不得越过工作区右边界"
        );
    }

    /// AC-6：该侧放不下 → 退对面侧；最终矩形完全落在 work area 内（含 8px 边距）
    #[test]
    fn popup_falls_back_and_stays_inside_work_area() {
        let bounds = bounds_full();
        let work = work_bottom_taskbar();
        let pw = (POPUP_WIDTH, POPUP_HEIGHT);
        let margin = POPUP_GAP;

        // 图标贴近工作区顶部（上方只剩 100px，放不下 360）→ 必须退到下方
        let icon = PhysRect::new(900.0, 100.0, 24.0, 24.0);
        let cursor = (icon.center_x(), icon.center_y());
        let (x, y) = popup_position(icon, cursor, bounds, work, 1.0, pw);
        let rect = PhysRect::new(x, y, POPUP_WIDTH, POPUP_HEIGHT);
        assert!(rect.y >= icon.bottom(), "上方放不下应退到下方");
        assert!(!rect.contains_point(cursor.0, cursor.1));

        // 右下角 + 两种缩放：无论怎么退，最终必须整体在工作区内（含 8px 边距）
        let corner = PhysRect::new(1900.0, 1020.0, 20.0, 20.0);
        let cursor_corner = (corner.center_x(), corner.center_y());
        for scale in [1.0, 2.0] {
            let (x, y) = popup_position(corner, cursor_corner, bounds, work, scale, pw);
            let rect = PhysRect::new(
                x * scale,
                y * scale,
                POPUP_WIDTH * scale,
                POPUP_HEIGHT * scale,
            );
            assert!(rect.x >= work.x + margin - 0.001, "不得越过左边界");
            assert!(rect.y >= work.y + margin - 0.001, "不得越过上边界");
            assert!(
                rect.right() <= work.right() - margin + 0.001,
                "不得越过右边界: {rect:?}"
            );
            assert!(
                rect.bottom() <= work.bottom() - margin + 0.001,
                "不得越过下边界: {rect:?}"
            );
        }
    }

    /// AC-7：`scaleFactor=2` → 逻辑坐标 = 物理/2（用与尺寸无关的「贴图标间距」轴校验）
    #[test]
    fn popup_position_converts_physical_to_logical_by_scale() {
        let bounds = bounds_full();
        // 任务栏在上 → 浮层在图标下方：主轴位置 = icon.bottom + GAP，与浮层尺寸无关
        let work = PhysRect::new(0.0, 40.0, 1920.0, 1040.0);
        let icon = PhysRect::new(900.0, 40.0, 24.0, 24.0);
        let cursor = (icon.center_x(), icon.center_y());
        let pw = (POPUP_WIDTH, POPUP_HEIGHT);

        let (x1, y1) = popup_position(icon, cursor, bounds, work, 1.0, pw);
        let (x2, y2) = popup_position(icon, cursor, bounds, work, 2.0, pw);

        assert!(
            (y1 - (icon.bottom() + POPUP_GAP)).abs() <= 1.0,
            "物理坐标应贴图标下沿 + GAP: {y1}"
        );
        assert!(
            (y2 * 2.0 - y1).abs() <= 1.0,
            "scale=2 时逻辑坐标 × 2 应回到物理坐标（误差 ≤1 逻辑像素）: {y1} vs {}",
            y2 * 2.0
        );
        // 两条轴的中心都应落在图标中心（证明换算没把位置算歪）
        assert!((x1 + POPUP_WIDTH / 2.0 - icon.center_x()).abs() <= 1.0);
        assert!((x2 * 2.0 + POPUP_WIDTH - icon.center_x()).abs() <= 1.0);

        // 非法缩放按 1 处理，且绝不产出 NaN/Infinity
        let (x3, y3) = popup_position(icon, cursor, bounds, work, 0.0, pw);
        assert_eq!((x3, y3), (x1, y1));
        let (x4, y4) = popup_position(icon, cursor, bounds, work, f64::NAN, pw);
        assert!(
            x4.is_finite() && y4.is_finite(),
            "NaN 缩放不得产出 NaN 坐标"
        );
    }

    /// AC-8：光标在第二显示器 → 以第二显示器 work area 为界
    #[test]
    fn popup_uses_cursor_monitor_work_area() {
        // 第二屏：横向偏移 1920，任务栏在下
        let bounds2 = PhysRect::new(1920.0, 0.0, 1920.0, 1080.0);
        let work2 = PhysRect::new(1920.0, 0.0, 1920.0, 1040.0);
        let icon = PhysRect::new(3800.0, 1000.0, 24.0, 24.0);
        let cursor = (icon.center_x(), icon.center_y());
        let (x, y) = popup_position(
            icon,
            cursor,
            bounds2,
            work2,
            1.0,
            (POPUP_WIDTH, POPUP_HEIGHT),
        );
        let rect = PhysRect::new(x, y, POPUP_WIDTH, POPUP_HEIGHT);
        assert!(
            rect.x >= work2.x + POPUP_GAP && rect.right() <= work2.right() - POPUP_GAP,
            "应完全落在第二屏工作区内: {rect:?}"
        );
        assert!(rect.bottom() <= icon.y, "第二屏底部任务栏 → 浮层仍在上方");
        assert!(!rect.contains_point(cursor.0, cursor.1));
    }
}
