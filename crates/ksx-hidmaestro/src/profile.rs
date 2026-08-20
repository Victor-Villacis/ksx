//! Profiles: the descriptor + axis map a virtual device is created from.
//!
//! HIDMaestro v1.6.1's source project selects 228 profile JSON resources, 130
//! of which carry a descriptor-shaped hexadecimal payload. S1.5c freezes only
//! the plain-USB DualSense conformance slice; the other persona slugs below are
//! roadmap selectors, not claims that their catalog profiles are implemented.

use ksx_core::Persona;

use crate::axis::AxisMap;
use crate::error::HmError;

/// The byte pattern that says a descriptor carries a HID-PID force-feedback
/// block: `Usage(Set Effect Report), Collection(Logical)`.
///
/// Detection matters because of *ordering*, not features: if this is present,
/// the PID pool must be published **before** the device enumerates
/// ([`crate::context`]).
pub const PID_BLOCK_SIGNATURE: [u8; 4] = [0x09, 0x21, 0xA1, 0x02];

/// Does this HID report descriptor declare a PID FFB block?
pub fn has_pid_block(descriptor: &[u8]) -> bool {
    descriptor
        .windows(PID_BLOCK_SIGNATURE.len())
        .any(|w| w == PID_BLOCK_SIGNATURE)
}

/// Transport metadata retained by the profile model.
///
/// The current S1.5c conformance stub constructs only [`Transport::Usb`]; a
/// variant's existence is not evidence that its runtime path is implemented.
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
pub enum Transport {
    Usb,
    Bluetooth,
}

/// One profile-shaped value used by the private conformance model.
#[derive(Clone, Debug)]
pub struct HmProfile {
    /// Catalog selector, e.g. `dualsense`.
    pub slug: String,
    pub vid: u16,
    pub pid: u16,
    pub transport: Transport,
    /// Descriptor bytes attached to the model. **Empty means not deployable**.
    /// Production must supply hash-bound catalog bytes; the conformance helper
    /// below deliberately supplies a synthetic test-only descriptor.
    pub descriptor: Vec<u8>,
    /// Role → HID usage. The only routing table; see [`crate::axis`].
    pub axis_map: AxisMap,
}

impl HmProfile {
    pub fn is_deployable(&self) -> bool {
        !self.descriptor.is_empty()
    }

    pub fn has_pid_block(&self) -> bool {
        has_pid_block(&self.descriptor)
    }

    /// Rejects a profile ksx cannot drive correctly, with the reason named.
    ///
    /// Two failure modes, both fatal at *create* time rather than at submit
    /// time: no descriptor (the device cannot exist) and an incomplete axis map
    /// (some role would be silently unrouted — the class of bug this crate is
    /// built to prevent, so it is refused rather than degraded).
    pub fn validate(&self) -> Result<(), HmError> {
        if !self.is_deployable() {
            return Err(HmError::ProfileNotDeployable(self.slug.clone()));
        }
        if let Some(missing) = self.axis_map.missing().next() {
            return Err(HmError::UnknownProfile(format!(
                "{} declares no axis for role '{}'",
                self.slug,
                missing.name()
            )));
        }
        Ok(())
    }
}

/// The planned catalog selector for each HIDMaestro-routed persona.
///
/// A returned slug proves only which upstream catalog entry the roadmap names.
/// It does not prove descriptor, input, feedback, transport, or hardware
/// conformance. S1.5c's only frozen runtime-candidate scope is `dualsense`.
///
/// Returns `None` for the personas that never reach this backend
/// ([`Persona::backend`] routes them to ViGEmBus) — a HIDMaestro Xbox 360 pad
/// would be a synthesis layer replacing the genuine article.
pub const fn slug_for(persona: Persona) -> Option<&'static str> {
    match persona {
        Persona::DualSense => Some("dualsense"),
        Persona::SwitchPro => Some("switch-pro"),
        Persona::XboxSeries => Some("xbox-series-xs-bt"),
        Persona::Snes => Some("ibuffalo-snes"),
        Persona::Genesis => Some("daemonbite-genesis"),
        Persona::Xbox360 | Persona::PlayStation => None,
    }
}

/// A deliberately synthetic descriptor for private conformance-model tests.
///
/// This is not a HIDMaestro catalog descriptor and must never be submitted to a
/// driver. `with_pid` exists solely to exercise both lifecycle-ordering paths.
#[cfg(test)]
pub(crate) fn conformance_stub_descriptor(with_pid: bool) -> Vec<u8> {
    let mut d = vec![0x05, 0x01, 0x09, 0x05, 0xA1, 0x01];
    if with_pid {
        d.extend_from_slice(&PID_BLOCK_SIGNATURE);
    }
    d.push(0xC0);
    d
}

/// Synthetic one-DualSense profile for the private latch/lifecycle conformance
/// model.
///
/// Only the identity, USB transport, and by-role axis map reflect the pinned
/// DualSense source. The descriptor is intentionally fake and contains a PID
/// marker solely so tests can exercise pre-enumeration ordering. This function
/// is not a catalog loader and does not authorize controller creation.
#[cfg(test)]
pub(crate) fn dualsense_conformance_stub_profile() -> HmProfile {
    HmProfile {
        slug: "dualsense".to_owned(),
        vid: 0x054C,
        pid: 0x0CE6,
        transport: Transport::Usb,
        descriptor: conformance_stub_descriptor(true),
        axis_map: AxisMap::sony_convention(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pid_block_detection_matches_the_documented_signature() {
        assert_eq!(PID_BLOCK_SIGNATURE, [0x09, 0x21, 0xA1, 0x02]);
        assert!(has_pid_block(&conformance_stub_descriptor(true)));
        assert!(!has_pid_block(&conformance_stub_descriptor(false)));
        // It must be a subsequence search, not a prefix check.
        let mut buried = vec![0u8; 300];
        buried[200..204].copy_from_slice(&PID_BLOCK_SIGNATURE);
        assert!(has_pid_block(&buried));
        // ...and a near miss must not fire.
        assert!(!has_pid_block(&[0x09, 0x21, 0xA1, 0x01]));
        assert!(!has_pid_block(&[]));
    }

    #[test]
    fn roadmap_selectors_name_only_the_hidmaestro_personas() {
        assert_eq!(slug_for(Persona::XboxSeries), Some("xbox-series-xs-bt"));
        assert_eq!(slug_for(Persona::DualSense), Some("dualsense"));
        assert_eq!(slug_for(Persona::SwitchPro), Some("switch-pro"));
        // The two ViGEm personas must NOT be reachable here: a HIDMaestro X360
        // pad is the synthesis layer we deliberately refuse.
        assert_eq!(slug_for(Persona::Xbox360), None);
        assert_eq!(slug_for(Persona::PlayStation), None);
    }

    #[test]
    fn the_dualsense_conformance_profile_is_explicitly_a_valid_stub() {
        let p = dualsense_conformance_stub_profile();
        p.validate().unwrap();
        assert_eq!(p.slug, "dualsense");
        assert_eq!((p.vid, p.pid), (0x054C, 0x0CE6));
        assert_eq!(p.transport, Transport::Usb);
        assert!(p.axis_map.is_complete());
        assert_eq!(p.descriptor, conformance_stub_descriptor(true));
        assert!(
            p.has_pid_block(),
            "the synthetic fixture requests PID ordering"
        );
    }

    #[test]
    fn an_undeployable_profile_is_refused_by_name() {
        let mut p = dualsense_conformance_stub_profile();
        p.descriptor.clear();
        let err = p.validate().unwrap_err();
        assert!(matches!(err, HmError::ProfileNotDeployable(s) if s == "dualsense"));
    }

    #[test]
    fn an_incomplete_axis_map_is_refused_at_create_time_not_at_submit_time() {
        let mut p = dualsense_conformance_stub_profile();
        p.axis_map = AxisMap::new();
        let err = p.validate().unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("leftStickX"),
            "{msg} must name the missing role"
        );
    }
}
