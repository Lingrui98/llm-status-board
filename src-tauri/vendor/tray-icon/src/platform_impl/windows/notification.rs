// Copyright 2022-2022 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use windows_sys::Win32::UI::{
    Shell::{
        NIF_GUID, NIF_SHOWTIP, NIF_TIP, NIM_ADD, NIM_SETVERSION, NIN_POPUPOPEN, NIN_SELECT,
        NOTIFYICONDATAW, NOTIFYICON_VERSION_4,
    },
    WindowsAndMessaging::{WM_CONTEXTMENU, WM_LBUTTONUP, WM_RBUTTONUP},
};

// NIN_KEYSELECT = NIN_SELECT | NINF_KEY (not exported by windows-sys).
const NIN_KEYSELECT: u32 = NIN_SELECT | 1;
// NIN_POPUPCLOSE = NIN_POPUPOPEN + 1 (not exported by windows-sys).
pub(super) const NIN_POPUPCLOSE: u32 = NIN_POPUPOPEN + 1;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum HoverOutput {
    None,
    Enter {
        arm_leave_timer: bool,
    },
    Move {
        arm_leave_timer: bool,
    },
    Leave {
        position: (f64, f64),
        kill_timer: bool,
    },
}

/// Tracks Windows tray hover state across `WM_MOUSEMOVE`, `WM_TIMER`, and
/// `NOTIFYICON_VERSION_4` popup notifications.
///
/// Key invariants:
/// - Initial `Enter` arms the leave-poll timer and records `last_position` so a
///   single `WM_MOUSEMOVE` followed by a pause still detects exit.
/// - `WM_TIMER` keeps `last_position` intact while the cursor remains inside
///   the icon rect so hovering longer than one timer tick does not blind the
///   leave detector.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub(super) struct HoverTracker {
    pub(super) entered: bool,
    pub(super) last_position: Option<(f64, f64)>,
}

impl HoverTracker {
    pub(super) fn reset(&mut self) {
        self.entered = false;
        self.last_position = None;
    }

    pub(super) fn on_mouse_move(&mut self, position: (f64, f64)) -> HoverOutput {
        if !self.entered {
            self.entered = true;
            self.last_position = Some(position);
            return HoverOutput::Enter {
                arm_leave_timer: true,
            };
        }

        if self.last_position != Some(position) {
            self.last_position = Some(position);
            HoverOutput::Move {
                arm_leave_timer: true,
            }
        } else {
            HoverOutput::None
        }
    }

    pub(super) fn on_popup_open(
        &mut self,
        position: (f64, f64),
        cursor_inside_rect: bool,
    ) -> HoverOutput {
        if !self.entered && cursor_inside_rect {
            self.entered = true;
            self.last_position = Some(position);
            HoverOutput::Enter {
                arm_leave_timer: true,
            }
        } else {
            HoverOutput::None
        }
    }

    pub(super) fn on_popup_close(
        &mut self,
        fallback_position: (f64, f64),
        cursor_inside_rect: bool,
    ) -> HoverOutput {
        self.leave_if_outside(fallback_position, cursor_inside_rect)
    }

    pub(super) fn on_leave_timer(
        &mut self,
        fallback_position: (f64, f64),
        cursor_inside_rect: bool,
    ) -> HoverOutput {
        self.leave_if_outside(fallback_position, cursor_inside_rect)
    }

    fn leave_if_outside(
        &mut self,
        fallback_position: (f64, f64),
        cursor_inside_rect: bool,
    ) -> HoverOutput {
        if !self.entered || cursor_inside_rect {
            return HoverOutput::None;
        }
        self.entered = false;
        let position = self.last_position.take().unwrap_or(fallback_position);
        HoverOutput::Leave {
            position,
            kill_timer: true,
        }
    }
}

pub(super) fn tooltip_flags(tooltip: Option<&str>) -> u32 {
    NIF_TIP
        | if tooltip.is_some_and(|text| !text.is_empty()) {
            NIF_SHOWTIP
        } else {
            0
        }
}

/// Returns whether version 4 was negotiated. A failed add must not set a version;
/// a failed negotiation leaves the icon using its existing legacy callbacks.
/// Called on both initial registration and every Explorer restart.
pub(super) fn register_icon(
    mut data: NOTIFYICONDATAW,
    mut notify: impl FnMut(u32, &NOTIFYICONDATAW) -> bool,
) -> bool {
    if !notify(NIM_ADD, &data) || data.uID > u16::MAX as u32 {
        return false;
    }
    data.uFlags &= NIF_GUID;
    data.Anonymous.uVersion = NOTIFYICON_VERSION_4;
    notify(NIM_SETVERSION, &data)
}

/// Adapt version-4 callbacks to the existing public mouse event stream. Physical
/// button-up messages precede activation/context messages; forwarding both would
/// toggle the main window twice or open the menu twice for one click.
pub(super) fn mouse_message(lparam: isize, version_4: bool) -> Option<u32> {
    if !version_4 {
        return Some(lparam as u32);
    }
    match (lparam as u32) & 0xffff {
        NIN_SELECT | NIN_KEYSELECT => Some(WM_LBUTTONUP),
        WM_CONTEXTMENU => Some(WM_RBUTTONUP),
        WM_LBUTTONUP | WM_RBUTTONUP => None,
        message => Some(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::UI::{
        Shell::NIF_MESSAGE,
        WindowsAndMessaging::{WM_LBUTTONDOWN, WM_MOUSEMOVE, WM_RBUTTONDOWN},
    };

    #[test]
    fn no_text_never_requests_a_standard_tooltip() {
        for text in [None, Some("")] {
            assert_eq!(tooltip_flags(text) & NIF_SHOWTIP, 0);
            assert_ne!(tooltip_flags(text) & NIF_TIP, 0); // Also clears old text on modify.
        }
        assert_ne!(tooltip_flags(Some("status")) & NIF_SHOWTIP, 0);
    }

    #[test]
    fn startup_and_explorer_restart_both_negotiate_version_4_without_showtip() {
        for _ in 0..2 {
            let data = NOTIFYICONDATAW {
                cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
                uID: 7,
                uFlags: NIF_MESSAGE | NIF_GUID | tooltip_flags(None),
                ..Default::default()
            };
            let mut calls = Vec::new();
            assert!(register_icon(data, |operation, data| {
                assert_eq!(data.uID, 7);
                assert_eq!(data.uFlags & NIF_SHOWTIP, 0);
                match operation {
                    NIM_ADD => assert_ne!(data.uFlags & NIF_MESSAGE, 0),
                    NIM_SETVERSION => {
                        assert_eq!(data.uFlags, NIF_GUID);
                        // SAFETY: register_icon writes this union field before the call.
                        assert_eq!(unsafe { data.Anonymous.uVersion }, NOTIFYICON_VERSION_4);
                    }
                    _ => panic!("unexpected Shell operation"),
                }
                calls.push(operation);
                true
            }));
            assert_eq!(calls, [NIM_ADD, NIM_SETVERSION]);
        }
    }

    #[test]
    fn failed_registration_or_negotiation_keeps_legacy_callbacks() {
        let mut calls = Vec::new();
        assert!(!register_icon(
            NOTIFYICONDATAW::default(),
            |operation, _| {
                calls.push(operation);
                false
            }
        ));
        assert_eq!(calls, [NIM_ADD]);
        calls.clear();
        assert!(!register_icon(
            NOTIFYICONDATAW::default(),
            |operation, _| {
                calls.push(operation);
                operation == NIM_ADD
            }
        ));
        assert_eq!(calls, [NIM_ADD, NIM_SETVERSION]);
        assert_eq!(
            mouse_message(WM_LBUTTONUP as isize, false),
            Some(WM_LBUTTONUP)
        );
        assert_eq!(
            mouse_message(WM_RBUTTONUP as isize, false),
            Some(WM_RBUTTONUP)
        );
    }

    fn packed(id: u16, message: u32) -> isize {
        ((u32::from(id) << 16) | message) as i32 as isize
    }

    #[test]
    fn packed_icon_ids_do_not_break_hover_or_button_events() {
        for id in [1, 42, u16::MAX] {
            for message in [
                WM_MOUSEMOVE,
                WM_LBUTTONDOWN,
                WM_RBUTTONDOWN,
                NIN_POPUPOPEN,
                NIN_POPUPCLOSE,
            ] {
                assert_eq!(mouse_message(packed(id, message), true), Some(message));
            }
        }
    }

    #[test]
    fn one_mouse_click_produces_one_activation_and_one_menu_request() {
        let left: Vec<_> = [WM_LBUTTONDOWN, WM_LBUTTONUP, NIN_SELECT]
            .into_iter()
            .filter_map(|message| mouse_message(packed(9, message), true))
            .collect();
        assert_eq!(left, [WM_LBUTTONDOWN, WM_LBUTTONUP]);
        let right: Vec<_> = [WM_RBUTTONDOWN, WM_RBUTTONUP, WM_CONTEXTMENU]
            .into_iter()
            .filter_map(|message| mouse_message(packed(9, message), true))
            .collect();
        assert_eq!(right, [WM_RBUTTONDOWN, WM_RBUTTONUP]);
        assert_eq!(
            mouse_message(packed(9, NIN_KEYSELECT), true),
            Some(WM_LBUTTONUP)
        );
        assert_eq!(
            mouse_message(packed(9, WM_CONTEXTMENU), true),
            Some(WM_RBUTTONUP)
        );
    }

    #[test]
    fn stationary_hover_still_emits_leave_and_allows_reenter() {
        let mut tracker = HoverTracker::default();
        // Single WM_MOUSEMOVE enters and arms timer; no second Move occurs.
        assert_eq!(
            tracker.on_mouse_move((100.0, 200.0)),
            HoverOutput::Enter {
                arm_leave_timer: true
            }
        );
        // Duplicate move at same pixel does not spam Move.
        assert_eq!(tracker.on_mouse_move((100.0, 200.0)), HoverOutput::None);
        // Multiple timer ticks while cursor remains inside must preserve tracking.
        assert_eq!(
            tracker.on_leave_timer((100.0, 200.0), true),
            HoverOutput::None
        );
        assert_eq!(
            tracker.on_leave_timer((100.0, 200.0), true),
            HoverOutput::None
        );
        // Once cursor moves outside (even without another WM_MOUSEMOVE), Leave fires.
        assert_eq!(
            tracker.on_leave_timer((150.0, 150.0), false),
            HoverOutput::Leave {
                position: (100.0, 200.0),
                kill_timer: true
            }
        );
        // Next hover emits Enter again instead of getting stuck on Move.
        assert_eq!(
            tracker.on_mouse_move((102.0, 202.0)),
            HoverOutput::Enter {
                arm_leave_timer: true
            }
        );
    }

    #[test]
    fn move_then_stationary_hover_then_exit_does_not_stick_entered() {
        let mut tracker = HoverTracker::default();
        assert_eq!(
            tracker.on_mouse_move((10.0, 10.0)),
            HoverOutput::Enter {
                arm_leave_timer: true
            }
        );
        assert_eq!(
            tracker.on_mouse_move((12.0, 10.0)),
            HoverOutput::Move {
                arm_leave_timer: true
            }
        );
        // Previously, the first timer tick consumed `last_position`, causing
        // later exits without a fresh WM_MOUSEMOVE to leave `entered = true`.
        assert_eq!(
            tracker.on_leave_timer((12.0, 10.0), true),
            HoverOutput::None
        );
        assert_eq!(
            tracker.on_leave_timer((50.0, 50.0), false),
            HoverOutput::Leave {
                position: (12.0, 10.0),
                kill_timer: true
            }
        );
        assert!(!tracker.entered);
        assert_eq!(
            tracker.on_mouse_move((11.0, 11.0)),
            HoverOutput::Enter {
                arm_leave_timer: true
            }
        );
    }

    #[test]
    fn popup_open_and_close_behave_safely_with_cursor_position() {
        let mut tracker = HoverTracker::default();
        // Keyboard-triggered NIN_POPUPOPEN when cursor is outside must not fake mouse Enter.
        assert_eq!(
            tracker.on_popup_open((10.0, 10.0), false),
            HoverOutput::None
        );
        // Fallback Enter when cursor is inside rect and WM_MOUSEMOVE was missed.
        assert_eq!(
            tracker.on_popup_open((10.0, 10.0), true),
            HoverOutput::Enter {
                arm_leave_timer: true
            }
        );
        // Already entered: NIN_POPUPOPEN does not emit duplicate Enter.
        assert_eq!(tracker.on_popup_open((10.0, 10.0), true), HoverOutput::None);
        // NIN_POPUPCLOSE while cursor still inside (e.g. Shell timeout) keeps entered=true.
        assert_eq!(
            tracker.on_popup_close((10.0, 10.0), true),
            HoverOutput::None
        );
        // NIN_POPUPCLOSE while cursor outside emits Leave immediately.
        assert_eq!(
            tracker.on_popup_close((50.0, 50.0), false),
            HoverOutput::Leave {
                position: (10.0, 10.0),
                kill_timer: true
            }
        );
        assert!(!tracker.entered);
    }

    #[test]
    fn reset_clears_entered_state() {
        let mut tracker = HoverTracker::default();
        tracker.on_mouse_move((10.0, 10.0));
        tracker.reset();
        assert!(!tracker.entered);
        assert_eq!(tracker.last_position, None);
    }
}
