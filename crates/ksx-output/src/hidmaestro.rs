//! Default-disabled HIDMaestro output checkpoint (M8).
//!
//! This module deliberately contains no live adapter. The former experiment
//! modeled a private shared-memory latch plus process-global install and cleanup
//! operations; upstream source proved that was neither the supported SDK
//! boundary nor ownership-safe for KSX, so it was removed rather than left as
//! an attractive implementation seam.
//!
//! The bounded host protocol in `ksx-hidmaestro` remains a pure contract, but
//! it is not wired into [`VirtualPadBackend`] yet. Three safety properties must
//! be designed and proven together before that is sound:
//!
//! - creating later controllers cannot starve an earlier controller's lease;
//! - a poisoned conversation cannot tear pads down before the supervisor has
//!   restored keyboard passthrough; and
//! - dropping the client side has a specified, tested host cleanup/EOF result.
//!
//! [`HidMaestroBackend::connect`] therefore refuses as a build fact without
//! probing the machine. Installing HIDMaestro cannot enable code this build
//! intentionally does not contain, and all rich-persona capability gates remain
//! off.

use ksx_core::{PadBackend, PadState, Persona};

use crate::backend::{Feedback, PadHandle, VirtualPadBackend};
use crate::error::OutputError;

/// Zero-state placeholder for the future supported HIDMaestro host adapter.
///
/// The private zero-sized field prevents downstream code from constructing a
/// fake "connected" value while keeping the production router's factory type
/// stable. There is no client, transport, controller map, SDK object or driver
/// lifecycle hidden inside it.
pub struct HidMaestroBackend {
    _unavailable: (),
}

impl HidMaestroBackend {
    /// Refuses unconditionally because this build has no safe live adapter.
    pub fn connect() -> Result<Self, OutputError> {
        Err(OutputError::HidMaestroHostUnavailable)
    }

    fn accepts(persona: Persona) -> bool {
        persona.backend() == PadBackend::HidMaestro
    }
}

impl VirtualPadBackend for HidMaestroBackend {
    fn plug(&mut self) -> Result<PadHandle, OutputError> {
        // The persona-less operation means Xbox 360, which belongs to ViGEm.
        Err(OutputError::PersonaUnsupported(Persona::Xbox360))
    }

    fn plug_persona(&mut self, persona: Persona) -> Result<PadHandle, OutputError> {
        if !Self::accepts(persona) {
            return Err(OutputError::PersonaUnsupported(persona));
        }
        Err(OutputError::HidMaestroHostUnavailable)
    }

    fn persona(&self, _handle: PadHandle) -> Option<Persona> {
        None
    }

    fn user_index(&self, _handle: PadHandle) -> Option<u8> {
        None
    }

    fn update(&mut self, handle: PadHandle, _state: &PadState) -> Result<(), OutputError> {
        Err(OutputError::UnknownHandle(handle))
    }

    fn poll_feedback(&mut self, _handle: PadHandle) -> Option<Feedback> {
        None
    }

    fn unplug(&mut self, handle: PadHandle) -> Result<(), OutputError> {
        Err(OutputError::UnknownHandle(handle))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unavailable() -> HidMaestroBackend {
        HidMaestroBackend { _unavailable: () }
    }

    #[test]
    fn production_connect_is_an_unconditional_build_refusal() {
        let err = HidMaestroBackend::connect().err().unwrap();
        assert!(matches!(err, OutputError::HidMaestroHostUnavailable));
        assert!(err.is_not_implemented());
        assert!(!err.is_hidmaestro_missing());
        assert!(err
            .to_string()
            .contains("installing HIDMaestro does not change it"));
    }

    #[test]
    fn placeholder_is_zero_state_and_cannot_claim_a_live_handle() {
        assert_eq!(std::mem::size_of::<HidMaestroBackend>(), 0);
        let mut backend = unavailable();
        for persona in [Persona::DualSense, Persona::SwitchPro, Persona::XboxSeries] {
            assert!(matches!(
                backend.plug_persona(persona),
                Err(OutputError::HidMaestroHostUnavailable)
            ));
        }
        for persona in [Persona::Xbox360, Persona::PlayStation] {
            assert!(matches!(
                backend.plug_persona(persona),
                Err(OutputError::PersonaUnsupported(actual)) if actual == persona
            ));
        }

        let ghost = PadHandle(7);
        assert_eq!(backend.persona(ghost), None);
        assert_eq!(backend.user_index(ghost), None);
        assert_eq!(backend.poll_feedback(ghost), None);
        assert!(matches!(
            backend.update(ghost, &PadState::default()),
            Err(OutputError::UnknownHandle(actual)) if actual == ghost
        ));
        assert!(matches!(
            backend.unplug(ghost),
            Err(OutputError::UnknownHandle(actual)) if actual == ghost
        ));
    }

    #[test]
    fn production_adapter_source_has_no_legacy_or_live_host_seam() {
        let source = include_str!("hidmaestro.rs");
        // Split fragments prevent the guard from matching its own vocabulary.
        for forbidden in [
            ["HmDriver", "Api"].concat(),
            ["Hm", "Context"].concat(),
            ["HmGamepad", "State"].concat(),
            ["Host", "Client"].concat(),
            ["Host", "Transport"].concat(),
            ["ksx_", "hidmaestro::"].concat(),
            ["Latch", "<"].concat(),
            ["Mapped", "Storage"].concat(),
            ["remove_all_virtual_", "controllers"].concat(),
            ["install_", "driver"].concat(),
            ["create_", "controller"].concat(),
        ] {
            assert!(
                !source.contains(&forbidden),
                "forbidden production adapter seam: {forbidden}"
            );
        }
    }
}
