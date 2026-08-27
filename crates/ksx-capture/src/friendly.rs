//! Best-effort friendly names from the registry Enum tree: strip the
//! `REV_xxxx&` segment from the
//! hardware id, open `HKLM\SYSTEM\CurrentControlSet\Enum\<hwid>`, walk instance
//! subkeys for one whose `Class` matches, and take the `DeviceDesc` text after
//! the `;` separator. Any failure yields `None`.

use windows_sys::Win32::System::Registry::HKEY_LOCAL_MACHINE;

use crate::backend::DeviceKind;
use crate::regkey::RegKey;

/// Revision strip: `HID\VID_D209&PID_0430&REV_0001&MI_00` →
/// `HID\VID_D209&PID_0430&MI_00`. If there is no `&` after `REV`, the id is
/// returned unchanged so the registry lookup still has a usable id.
pub(crate) fn strip_revision(hwid: &str) -> String {
    if let Some(rev) = hwid.find("REV") {
        if let Some(amp_rel) = hwid[rev..].find('&') {
            let amp = rev + amp_rel;
            return format!("{}{}", &hwid[..rev], &hwid[amp + 1..]);
        }
    }
    hwid.to_owned()
}

/// The registry `Class` value for a device kind.
fn class_name(kind: DeviceKind) -> &'static str {
    match kind {
        DeviceKind::Keyboard => "Keyboard",
        DeviceKind::Mouse => "Mouse",
    }
}

/// Best-effort friendly name for an Interception hardware id.
pub(crate) fn friendly_name(hwid: &str, kind: DeviceKind) -> Option<String> {
    let path = format!("SYSTEM\\CurrentControlSet\\Enum\\{}", strip_revision(hwid));
    let root = RegKey::open(HKEY_LOCAL_MACHINE, &path)?;
    // Instance keys live one level down, so a bounded depth-2 walk covers the
    // registry shape without unbounded recursion.
    search(&root, class_name(kind), 2)
}

fn search(key: &RegKey, class: &str, depth: u8) -> Option<String> {
    for name in key.subkey_names() {
        if name == "Properties" {
            continue; // access-denied by ACL; no friendly name is available
        }
        let Some(sub) = RegKey::open(key.0, &name) else {
            continue;
        };
        if sub.string_value("Class").as_deref() == Some(class) {
            if let Some(desc) = sub.string_value("DeviceDesc") {
                // "@keyboard.inf,%...%;HID Keyboard Device" → text after ';'.
                let friendly = match desc.find(';') {
                    Some(i) => desc[i + 1..].to_owned(),
                    None => desc,
                };
                if !friendly.is_empty() {
                    return Some(friendly);
                }
            }
        }
        if depth > 1 {
            if let Some(found) = search(&sub, class, depth - 1) {
                return Some(found);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_revision_handles_registry_hardware_ids() {
        assert_eq!(
            strip_revision("HID\\VID_D209&PID_0430&REV_0001&MI_00"),
            "HID\\VID_D209&PID_0430&MI_00"
        );
        // No REV segment: unchanged.
        assert_eq!(
            strip_revision("HID\\VID_D209&PID_0430&MI_00"),
            "HID\\VID_D209&PID_0430&MI_00"
        );
        // REV at the end with no following '&': unchanged, leaving a usable id.
        assert_eq!(strip_revision("HID\\FOO&REV_0001"), "HID\\FOO&REV_0001");
    }

    /// Live-registry test, read-only. What it pins is the `;` split, which is
    /// the whole point of this module: the registry stores
    /// `@keyboard.inf,%hid.keyboarddevice%;HID Keyboard Device`, and the text
    /// a picker shows is the part after the `;`. Return the raw value and the
    /// device list reads as INF syntax.
    ///
    /// The previous version of this test asserted only `!name.is_empty()`,
    /// which `search()` already guarantees before it returns `Some` — it could
    /// not fail for any implementation of this module. These assertions can:
    /// drop the split and the first one fires.
    ///
    /// Prints a SKIP when the board is not in this machine's Enum tree. A
    /// check that silently passes when its subject is absent is not a check.
    #[test]
    fn a_resolved_friendly_name_is_a_name_not_the_raw_inf_token() {
        let hwid = "HID\\VID_D209&PID_0430&REV_0001&MI_00";
        let Some(name) = friendly_name(hwid, DeviceKind::Keyboard) else {
            println!("SKIP: no {hwid} keyboard node in this machine's Enum tree");
            return;
        };
        assert!(!name.is_empty());
        assert!(
            !name.starts_with('@'),
            "the INF token survived the ';' split: {name}"
        );
        assert!(!name.contains(';'), "the ';' split did not happen: {name}");
        assert!(
            !name.to_ascii_lowercase().contains(".inf"),
            "an INF file name is not a device name: {name}"
        );
    }
}
