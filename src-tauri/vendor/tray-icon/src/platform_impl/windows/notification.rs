// Copyright 2022-2022 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use windows_sys::Win32::UI::{
    Shell::{
        NIF_GUID, NIF_SHOWTIP, NIF_TIP, NIM_ADD, NIM_SETVERSION, NIN_SELECT, NOTIFYICONDATAW,
        NOTIFYICON_VERSION_4,
    },
    WindowsAndMessaging::{WM_CONTEXTMENU, WM_LBUTTONUP, WM_RBUTTONUP},
};

// NIN_KEYSELECT = NIN_SELECT | NINF_KEY (not exported by windows-sys).
const NIN_KEYSELECT: u32 = NIN_SELECT | 1;

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
        Shell::{NIF_MESSAGE, NIN_POPUPOPEN},
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
            for message in [WM_MOUSEMOVE, WM_LBUTTONDOWN, WM_RBUTTONDOWN, NIN_POPUPOPEN] {
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
}
