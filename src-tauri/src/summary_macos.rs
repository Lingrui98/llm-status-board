//! macOS summary uses a nonactivating panel, not application-wide activation.
//! Keep Tao's window delegate: replacing it would lose resize/focus notifications.
use tauri::{AppHandle, Manager};
use tauri_nspanel::objc2::AnyThread;
use tauri_nspanel::objc2_app_kit::{NSTrackingArea, NSTrackingAreaOptions};
use tauri_nspanel::{tauri_panel, ManagerExt, StyleMask, WebviewWindowExt};

tauri_panel! {
    panel!(SummaryPanel {
        config: {
            can_become_main_window: false,
            can_become_key_window: true,
            becomes_key_only_if_needed: true,
            is_floating_panel: true
        }
    })
}

fn tracking_options() -> NSTrackingAreaOptions {
    NSTrackingAreaOptions::ActiveAlways
        | NSTrackingAreaOptions::MouseEnteredAndExited
        | NSTrackingAreaOptions::MouseMoved
        | NSTrackingAreaOptions::CursorUpdate
        | NSTrackingAreaOptions::InVisibleRect
}

/// Called once from Tauri setup on the AppKit main thread.
pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let window = app
        .get_webview_window(super::summary::POPUP_LABEL)
        .ok_or("summary window missing")?;
    let panel = window.to_panel::<SummaryPanel>()?;
    panel.add_style_mask(StyleMask::empty().nonactivating_panel().into())?;
    panel.set_hides_on_deactivate(false);
    panel.set_accepts_mouse_moved_events(true);
    panel.set_released_when_closed(false);

    // WebKit normally tracks only while its window is key. Install an additional
    // ActiveAlways area on the actual WKWebView, without replacing WebKit areas.
    // NSView retains the area; InVisibleRect follows each resize automatically.
    window.with_webview(|webview| unsafe {
        // SAFETY: with_webview runs on the main thread and inner() is this live
        // WKWebView (an NSView subclass). The reference never leaves this closure.
        let view = &*webview.inner().cast::<NSView>();
        let _mtm = MainThreadMarker::new().expect("AppKit main thread");
        let area = NSTrackingArea::initWithRect_options_owner_userInfo(
            NSTrackingArea::alloc(),
            view.bounds(),
            tracking_options(),
            Some(view),
            None,
        );
        view.addTrackingArea(&area);
        crate::summary_cursor_macos::install(view, _mtm);
    })?;
    Ok(())
}

/// Native panel operations must run on the main thread, including timer calls.
pub fn set_visible(app: &AppHandle, visible: bool) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        if let Ok(panel) = handle.get_webview_panel(super::summary::POPUP_LABEL) {
            if visible {
                // orderFrontRegardless only: no makeKeyAndOrderFront or app activation.
                panel.show();
            } else {
                crate::summary_cursor_macos::reset();
                panel.hide();
            }
        }
    }) {
        eprintln!("无法更新用量总结面板: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracking_works_without_key_window_and_follows_resize() {
        let options = tracking_options();
        assert!(options.contains(NSTrackingAreaOptions::ActiveAlways));
        assert!(options.contains(NSTrackingAreaOptions::InVisibleRect));
        assert!(options.contains(NSTrackingAreaOptions::CursorUpdate));
        assert!(options.contains(NSTrackingAreaOptions::MouseMoved));
        assert!(!options.contains(NSTrackingAreaOptions::ActiveInKeyWindow));
    }
}
