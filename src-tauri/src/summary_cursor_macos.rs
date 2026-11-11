//! AppKit cursor tracking independent of WebKit's key-window cursor policy.
use std::cell::{Cell, RefCell};
use tauri_nspanel::objc2::{
    define_class, msg_send, rc::Retained, sel, AnyThread, ClassType, DefinedClass, MainThreadOnly,
    Message,
};
use tauri_nspanel::objc2_app_kit::{
    NSCursor, NSCursorFrameResizeDirections, NSCursorFrameResizePosition, NSEvent, NSTrackingArea,
    NSTrackingAreaOptions, NSView, NSWindowStyleMask, NSWorkspace,
};
use tauri_nspanel::objc2_foundation::{MainThreadMarker, NSObject, NSObjectProtocol};

// Keep these in sync with .summary-resize-grip. Coordinates are logical points.
const GRIP_INSET: f64 = 11.0;
const GRIP_SIDE: f64 = 20.0;

fn hits_grip(x: f64, y_from_bottom: f64, width: f64) -> bool {
    x >= width - GRIP_INSET - GRIP_SIDE
        && x < width - GRIP_INSET
        && y_from_bottom > GRIP_INSET
        && y_from_bottom <= GRIP_INSET + GRIP_SIDE
}

fn foreground_pid() -> i32 {
    NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .map(|app| app.processIdentifier())
        .unwrap_or(-1)
}

fn diagnostics_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var_os("LSB_SUMMARY_HOVER_DIAGNOSTICS").is_some())
}

struct CursorIvars {
    view: Retained<NSView>,
    cursor: Retained<NSCursor>,
    inside: Cell<bool>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = CursorIvars]
    struct SummaryGripCursor;
    unsafe impl NSObjectProtocol for SummaryGripCursor {}
    impl SummaryGripCursor {
        #[unsafe(method(mouseMoved:))]
        fn mouse_moved(&self, event: &NSEvent) { self.update(event); }
        #[unsafe(method(mouseEntered:))]
        fn mouse_entered(&self, event: &NSEvent) { self.update(event); }
        #[unsafe(method(cursorUpdate:))]
        fn cursor_update(&self, event: &NSEvent) { self.update(event); }
        #[unsafe(method(mouseExited:))]
        fn mouse_exited(&self, _event: &NSEvent) { self.reset(); }
    }
);

impl SummaryGripCursor {
    fn update(&self, event: &NSEvent) {
        let view = &self.ivars().view;
        if let Some(window) = view.window() {
            // Nonactivating panels can take keyboard focus without bringing the
            // application to the foreground. Tauri set_focus additionally calls
            // activateIgnoringOtherApps and must NOT be used here.
            if window.isVisible()
                && !window.isKeyWindow()
                && window
                    .styleMask()
                    .contains(NSWindowStyleMask::NonactivatingPanel)
            {
                let before = foreground_pid();
                window.makeKeyWindow();
                if diagnostics_enabled() {
                    eprintln!(
                        "[summary-hover] key={} foreground-before={} foreground-after={} self={}",
                        window.isKeyWindow(),
                        before,
                        foreground_pid(),
                        std::process::id()
                    );
                }
            }
        }
        let point = view.convertPoint_fromView(event.locationInWindow(), None);
        let bounds = view.bounds();
        let y = if view.isFlipped() {
            bounds.origin.y + bounds.size.height - point.y
        } else {
            point.y - bounds.origin.y
        };
        if hits_grip(point.x - bounds.origin.x, y, bounds.size.width) {
            if !self.ivars().inside.replace(true) && diagnostics_enabled() {
                eprintln!("[summary-hover] grip-enter: setting native resize cursor");
            }
            self.ivars().cursor.set();
        } else {
            self.reset();
        }
    }
    fn reset(&self) {
        // Do not overwrite WebKit's cursors over account buttons elsewhere.
        if self.ivars().inside.replace(false) {
            NSCursor::arrowCursor().set();
        }
    }
}

thread_local! {
    // The summary WebView is created once and lives until application exit.
    // NSTrackingArea does not retain its owner, so retain it for that lifetime.
    static OWNER: RefCell<Option<Retained<SummaryGripCursor>>> = const { RefCell::new(None) };
}

pub fn install(view: &NSView, mtm: MainThreadMarker) {
    let cursor = unsafe {
        let supported: bool = msg_send![NSCursor::class(), respondsToSelector: sel!(frameResizeCursorFromPosition:inDirections:)];
        if supported {
            NSCursor::frameResizeCursorFromPosition_inDirections(
                NSCursorFrameResizePosition::BottomRight,
                NSCursorFrameResizeDirections::All,
            )
        } else {
            // The public diagonal frame cursor is available on newer macOS only.
            NSCursor::crosshairCursor()
        }
    };
    let owner = SummaryGripCursor::alloc(mtm).set_ivars(CursorIvars {
        view: view.retain(),
        cursor,
        inside: Cell::new(false),
    });
    let owner: Retained<SummaryGripCursor> = unsafe { msg_send![super(owner), init] };
    let area = unsafe {
        NSTrackingArea::initWithRect_options_owner_userInfo(
            NSTrackingArea::alloc(),
            view.bounds(),
            NSTrackingAreaOptions::ActiveAlways
                | NSTrackingAreaOptions::InVisibleRect
                | NSTrackingAreaOptions::MouseMoved
                | NSTrackingAreaOptions::MouseEnteredAndExited
                | NSTrackingAreaOptions::CursorUpdate,
            Some(&owner),
            None,
        )
    };
    view.addTrackingArea(&area);
    OWNER.with(|slot| *slot.borrow_mut() = Some(owner));
}

pub fn reset() {
    if diagnostics_enabled() {
        eprintln!(
            "[summary-hover] hide foreground={} self={}",
            foreground_pid(),
            std::process::id()
        );
    }
    OWNER.with(|slot| {
        if let Some(owner) = slot.borrow().as_ref() {
            owner.reset();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grip_hit_matches_css_points_at_multiple_sizes() {
        for width in [260.0, 300.0, 600.0, 1200.0] {
            assert!(hits_grip(width - 21.0, 21.0, width));
            assert!(hits_grip(width - 31.0, 31.0, width));
            assert!(!hits_grip(width - 11.0, 21.0, width));
            assert!(!hits_grip(width - 32.0, 21.0, width));
            assert!(!hits_grip(width - 21.0, 11.0, width));
            assert!(!hits_grip(width - 21.0, 32.0, width));
        }
    }
    #[test]
    fn native_geometry_matches_stylesheet() {
        let css = include_str!("../../src/summary/summary.css");
        let grip = css
            .split(".summary-resize-grip {")
            .nth(1)
            .unwrap()
            .split('}')
            .next()
            .unwrap();
        assert!(grip.contains(&format!("right: {GRIP_INSET}px")));
        assert!(grip.contains(&format!("bottom: {GRIP_INSET}px")));
        assert!(grip.contains(&format!("width: {GRIP_SIDE}px")));
        assert!(grip.contains(&format!("height: {GRIP_SIDE}px")));
    }
}
