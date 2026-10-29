# Local Windows notification protocol fix

Source: `tray-icon` 0.25.1 from crates.io, checksum
`b2b9c52859a94554803ccd4a24b98f74148ebc73b90676d783f3490b1bff9d72`.
The original MIT and Apache-2.0 license files are included.

Only the Windows backend is changed. It registers each icon with
`NOTIFYICON_VERSION_4` and requests `NIF_SHOWTIP` only for nonempty tooltips.
Omitting tooltip text in the legacy protocol can still leave an empty native
tooltip over the application's custom summary window.

Version 4 packs the icon ID into the high word of the callback parameter and
uses `NIN_SELECT` / `NIN_KEYSELECT` for activation and `WM_CONTEXTMENU` for menus.
The callback adapter preserves the existing public events without emitting
duplicate button-up events. Explorer restart re-registration repeats version
negotiation. If negotiation fails, callbacks retain the legacy interpretation.

`notification.rs` accepts a fake Shell function so the app's unit tests exercise
the actual registration and callback implementation on Linux, macOS and Windows.
The remaining platform backends and public API are unchanged.

References:
- https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ns-shellapi-notifyicondataw
- https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shell_notifyiconw

Remove this patch when an upstream tray-icon release provides equivalent
tooltip suppression and callback handling; update Cargo.lock at the same time.
