//! Device identity and raw input events.

use crate::key::Key;

/// Stable device identity: the PnP *device instance path*, e.g.
/// `HID\VID_D209&PID_0430&MI_00\8&A1B2C3D4&0&0000`.
///
/// Never a positional index: Interception slot indices drift on every replug.
/// Instance paths are
/// port-topology-derived and stable while a board stays on its physical port
/// (a documented cabinet invariant, not an accident).
///
/// Comparison is exact and case-sensitive: the capture layer must canonicalize
/// before constructing one (Windows returns uppercase from `CM_Get_Device_ID`;
/// store that verbatim). ksx-core never inspects the contents.
///
/// **`Arc<str>`, not `String`, and the reason is the capture thread.** Every
/// event carries an owned id — `decision.rs` says so at its own funnel:
/// allocation-free "except for the `DeviceId` clone the owned `KeyEvent`
/// contract requires". At keyboard rates that clone is invisible. An analog
/// source reports at up to 1 kHz, and four of them would put four thousand
/// heap allocations per second on the one thread whose p99 is this product's
/// headline number (`ARCHITECTURE.md` rule 1: no allocation in the capture
/// thread; rule 5: p99 capture→submit < 1 ms). A refcount bump retires the
/// whole class rather than the instance.
///
/// Nothing about the contract moves: `Arc<str>` derives `Hash`, `Eq` and `Ord`
/// through to the string contents, so exact case-sensitive comparison is
/// unchanged, and every constructor below keeps its signature.
///
/// This is M11's third piece; `docs/UNIVERSAL-IO.md` carries the plan the
/// analog sources arrive on and the reason this had to come first.
#[derive(Clone, Debug, Hash, PartialEq, Eq, PartialOrd, Ord)]
pub struct DeviceId(std::sync::Arc<str>);

impl DeviceId {
    pub fn new(path: impl Into<String>) -> Self {
        Self(path.into().into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<&str> for DeviceId {
    fn from(path: &str) -> Self {
        Self(path.into())
    }
}

impl From<String> for DeviceId {
    fn from(path: String) -> Self {
        Self(path.into())
    }
}

impl AsRef<str> for DeviceId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl core::fmt::Display for DeviceId {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(&self.0)
    }
}

/// One key transition on one device, as delivered by a capture backend.
#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub struct KeyEvent {
    pub device: DeviceId,
    pub key: Key,
    /// `true` = press, `false` = release.
    pub down: bool,
    /// Monotonic tick at capture time. Unit is backend-defined for now (QPC
    /// ticks on Windows); ksx-core only ever compares or subtracts it, so the
    /// placeholder stays OS-free.
    pub t: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_id_is_exact_and_case_sensitive() {
        let a = DeviceId::new(r"HID\VID_D209&PID_0430&MI_00\8&A1B2C3D4&0&0000");
        let b = DeviceId::from(r"HID\VID_D209&PID_0430&MI_00\8&A1B2C3D4&0&0000");
        let c = DeviceId::new(r"hid\vid_d209&pid_0430&mi_00\8&a1b2c3d4&0&0000");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.as_str(), r"HID\VID_D209&PID_0430&MI_00\8&A1B2C3D4&0&0000");
        assert_eq!(a.to_string(), a.as_str());
    }

    /// The capture thread clones an id into every event it forwards. That
    /// clone must not touch the allocator: an analog source reports at up to
    /// 1 kHz, and this is the thread with the p99 budget.
    #[test]
    fn cloning_a_device_id_shares_the_string_instead_of_copying_it() {
        let original = DeviceId::new(r"HID\VID_D209&PID_0430&MI_00\8&A1B2C3D4&0&0000");
        let clone = original.clone();
        assert_eq!(original, clone);
        assert!(
            std::ptr::eq(original.as_str(), clone.as_str()),
            "a cloned DeviceId must share its buffer — a per-event heap copy is \
             what this type exists to avoid",
        );
        // …and an id built separately from equal bytes is still equal, so the
        // sharing is an optimisation and never part of identity.
        let separate = DeviceId::from(r"HID\VID_D209&PID_0430&MI_00\8&A1B2C3D4&0&0000");
        assert_eq!(original, separate);
    }

    #[test]
    fn key_event_equality() {
        let ev = |down: bool| KeyEvent {
            device: DeviceId::new("X"),
            key: Key::A,
            down,
            t: 42,
        };
        assert_eq!(ev(true), ev(true));
        assert_ne!(ev(true), ev(false));
    }
}
