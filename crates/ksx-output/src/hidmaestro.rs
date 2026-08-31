//! Production HIDMaestro adapter for the source-built DualSense lane.
//!
//! The ordinary daemon owns only an authenticated protocol client. All driver
//! and shared-memory handles live in one fixed elevated sibling process: the
//! source-built `ksx-hidmaestro-host.exe`. That runtime supports one exact
//! DualSense controller. Other HIDMaestro catalog profiles remain in the
//! product vocabulary but capability-gated until a distributable production
//! runtime exists. The host connects lazily at the first DualSense plug, so
//! UAC appears only when it is needed.

#[cfg(windows)]
use std::collections::{BTreeMap, VecDeque};
#[cfg(windows)]
use std::time::{Duration, Instant};

use ksx_core::{PadState, Persona};

use crate::backend::{Feedback, PadHandle, VirtualPadBackend};
use crate::error::OutputError;

#[cfg(windows)]
const LEASE_REFRESH: Duration = Duration::from_secs(1);

#[cfg(windows)]
const CATALOG_SHA256: [u8; 32] = [
    0x8F, 0x40, 0x7E, 0x6E, 0x1C, 0x3C, 0x24, 0x1E, 0x16, 0xCF, 0x6B, 0xEF, 0x38, 0x72, 0x16, 0xAD,
    0x4D, 0x1F, 0x5D, 0xE0, 0x55, 0xA2, 0xC4, 0xCC, 0x04, 0x1C, 0xA1, 0x6C, 0xE7, 0x95, 0x4A, 0x6A,
];

/// Canonical LF-normalized SHA-256 of
/// `tools/hidmaestro-host/runtime-contract.json`, pinned identically in the
/// source-build publisher and installer workflow.
#[cfg(windows)]
const RUNTIME_CONTRACT_SHA256: [u8; 32] = [
    0x4F, 0x76, 0xF3, 0x1C, 0x04, 0x93, 0x90, 0xA1, 0x34, 0x23, 0x88, 0xE0, 0x9F, 0x9D, 0x0D, 0x0E,
    0x35, 0x47, 0x16, 0x2D, 0x08, 0xEA, 0x50, 0x1F, 0xD8, 0x29, 0xAF, 0x3C, 0xF6, 0x4F, 0x67, 0xDA,
];

/// The source-built host owns one fixed device and shared-memory endpoint.
/// Refuse a second pad before asking it because a host Fault poisons the whole
/// fail-closed session.
#[cfg(windows)]
const HOST_CONTROLLER_LIMIT: usize = 1;

#[cfg(windows)]
struct LivePad {
    controller: ksx_hidmaestro::host::ControllerId,
    /// The profile accepted for this handle. Keeping it with the live record
    /// makes `persona()` truthful if the source-built host later gains another
    /// independently released profile.
    persona: Persona,
    state: PadState,
    last_submit: Instant,
    feedback: VecDeque<Feedback>,
}

#[cfg(windows)]
type LaneClient =
    ksx_hidmaestro::host::HostClient<ksx_hidmaestro::windows_transport::WindowsHostTransport>;

/// The authenticated connection to the fixed installed source-built host,
/// established at the first DualSense plug.
#[cfg(windows)]
pub struct HidMaestroBackend {
    client: Option<LaneClient>,
    pads: BTreeMap<u32, LivePad>,
    next_handle: u32,
}

#[cfg(not(windows))]
pub struct HidMaestroBackend {
    _unavailable: (),
}

impl HidMaestroBackend {
    /// Prepare the backend. The host is not launched here: the fixed
    /// elevated sibling starts at the first DualSense plug, so UAC appears
    /// exactly when that production persona is requested.
    #[cfg(windows)]
    pub fn connect() -> Result<Self, OutputError> {
        Ok(Self {
            client: None,
            pads: BTreeMap::new(),
            next_handle: 1,
        })
    }

    /// Launch and authenticate the fixed source-built host on first use.
    #[cfg(windows)]
    fn client(&mut self) -> Result<&mut LaneClient, OutputError> {
        if self.client.is_none() {
            let expected = ksx_hidmaestro::host::HostExpectation {
                sdk_sha256: RUNTIME_CONTRACT_SHA256,
                catalog_sha256: CATALOG_SHA256,
                catalog_resource_count: 228,
            };
            let client =
                ksx_hidmaestro::windows_transport::WindowsHostTransport::connect_production(
                    expected,
                )
                .map_err(|error| OutputError::HidMaestroRuntime(error.to_string()))?;
            self.client = Some(client);
        }
        Ok(self.client.as_mut().expect("just connected"))
    }

    #[cfg(not(windows))]
    pub fn connect() -> Result<Self, OutputError> {
        Err(OutputError::HidMaestroHostUnavailable)
    }

    #[cfg(windows)]
    fn live_mut(&mut self, handle: PadHandle) -> Result<&mut LivePad, OutputError> {
        self.pads
            .get_mut(&handle.0)
            .ok_or(OutputError::UnknownHandle(handle))
    }

    #[cfg(windows)]
    fn runtime(error: ksx_hidmaestro::host::HostClientError) -> OutputError {
        match error {
            ksx_hidmaestro::host::HostClientError::HostFault {
                code: ksx_hidmaestro::host::FaultCode::SdkUnavailable,
                detail,
            } => OutputError::HidMaestroMissing { probe: detail },
            other => OutputError::HidMaestroRuntime(other.to_string()),
        }
    }
}

#[cfg(windows)]
impl VirtualPadBackend for HidMaestroBackend {
    fn service(&mut self) -> Result<(), OutputError> {
        let now = Instant::now();
        let renewals: Vec<_> = self
            .pads
            .values()
            .filter(|pad| now.duration_since(pad.last_submit) >= LEASE_REFRESH)
            .map(|pad| (pad.controller, pad.state))
            .collect();
        for (controller, state) in renewals {
            self.client()?
                .submit(controller, state)
                .map_err(Self::runtime)?;
            if let Some(pad) = self
                .pads
                .values_mut()
                .find(|pad| pad.controller == controller)
            {
                pad.last_submit = now;
            }
        }

        // Poll only if the host is already running: servicing must never
        // launch an elevated process.
        if let Some(client) = self.client.as_mut() {
            let mut events = Vec::new();
            while let Some(event) = client.poll_feedback().map_err(Self::runtime)? {
                events.push(event);
            }
            for event in events {
                if let Some(pad) = self
                    .pads
                    .values_mut()
                    .find(|pad| pad.controller == event.controller)
                {
                    if pad.feedback.len() == 64 {
                        pad.feedback.pop_front();
                    }
                    pad.feedback.push_back(Feedback {
                        large_motor: event.large_motor,
                        small_motor: event.small_motor,
                        led_number: event.led_number,
                    });
                }
            }
        }
        Ok(())
    }

    fn plug(&mut self) -> Result<PadHandle, OutputError> {
        Err(OutputError::PersonaUnsupported(Persona::Xbox360))
    }

    fn plug_persona(&mut self, persona: Persona) -> Result<PadHandle, OutputError> {
        // Defense in depth: the build capability gate owns the product offer,
        // while this one-controller host accepts only its exact profile.
        if persona != Persona::DualSense || !persona.can_plug() {
            return Err(OutputError::PersonaUnsupported(persona));
        }
        // Capacity is refused HERE, before the host is asked. The host enforces
        // the same one-controller limit as defense in depth.
        if self.pads.len() >= HOST_CONTROLLER_LIMIT {
            return Err(OutputError::HidMaestroRuntime(format!(
                "the HIDMaestro host's live-controller capacity is {HOST_CONTROLLER_LIMIT}"
            )));
        }
        let ready = self
            .client()?
            .create(ksx_hidmaestro::host::ProfileId::DualSense)
            .map_err(Self::runtime)?;
        let handle = PadHandle(self.next_handle);
        self.next_handle = self.next_handle.checked_add(1).ok_or_else(|| {
            OutputError::HidMaestroRuntime("pad handle space is exhausted".into())
        })?;
        self.pads.insert(
            handle.0,
            LivePad {
                controller: ready.controller,
                persona: ready.profile.persona(),
                state: PadState::default(),
                last_submit: Instant::now(),
                feedback: VecDeque::new(),
            },
        );
        Ok(handle)
    }

    fn persona(&self, handle: PadHandle) -> Option<Persona> {
        self.pads.get(&handle.0).map(|pad| pad.persona)
    }

    fn user_index(&self, _handle: PadHandle) -> Option<u8> {
        None
    }

    fn update(&mut self, handle: PadHandle, state: &PadState) -> Result<(), OutputError> {
        let controller = self.live_mut(handle)?.controller;
        self.client()?
            .submit(controller, *state)
            .map_err(Self::runtime)?;
        let pad = self.live_mut(handle)?;
        pad.state = *state;
        pad.last_submit = Instant::now();
        Ok(())
    }

    fn poll_feedback(&mut self, handle: PadHandle) -> Option<Feedback> {
        self.pads.get_mut(&handle.0)?.feedback.pop_front()
    }

    fn unplug(&mut self, handle: PadHandle) -> Result<(), OutputError> {
        let controller = self.live_mut(handle)?.controller;
        self.client()?.destroy(controller).map_err(Self::runtime)?;
        self.pads.remove(&handle.0);
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for HidMaestroBackend {
    fn drop(&mut self) {
        if let Some(mut client) = self.client.take() {
            let _ = client.shutdown();
        }
    }
}

/// The one-controller capacity refusal and the constant it duplicates.
///
/// **Why this exists (2026-08-26 audit).** The refusal sits behind a real
/// elevated host, so it cannot be exercised by plugging in a unit test.
/// Staging and runtime disagreeing is not a cosmetic bug: staging waves a pad
/// through and the backend refuses it mid-session, after another player is
/// already live.
///
/// The pad is built directly rather than plugged, because plugging is exactly
/// what would reach the host. The refusal is a pure function of `self.pads`
/// and runs before `self.client()?`, which is the property the test confirms.
#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn live(persona: Persona, id: u32) -> LivePad {
        LivePad {
            controller: ksx_hidmaestro::host::ControllerId::new(id).expect("nonzero"),
            persona,
            state: PadState::default(),
            last_submit: Instant::now(),
            feedback: VecDeque::new(),
        }
    }

    /// A backend holding `personas` as live pads and NO host connection.
    fn backend_with(personas: &[Persona]) -> HidMaestroBackend {
        let pads = personas
            .iter()
            .enumerate()
            .map(|(i, &p)| (i as u32, live(p, i as u32 + 1)))
            .collect();
        HidMaestroBackend {
            client: None,
            pads,
            next_handle: personas.len() as u32 + 1,
        }
    }

    #[test]
    fn a_second_pad_is_refused_without_the_host_being_asked() {
        let mut backend = backend_with(&[Persona::DualSense; HOST_CONTROLLER_LIMIT]);
        let err = backend
            .plug_persona(Persona::DualSense)
            .expect_err("a second pad must be refused");
        let msg = err.to_string();
        // From `HOST_CONTROLLER_LIMIT` — the constant this crate's refusal is
        // actually built from — rather than the literal 1. The tie back to
        // `ksx_core::MAX_HIDMAESTRO_PADS` is its own assertion below
        // (`the_runtime_limits_match_the_ones_staging_validates_against`), so
        // the number lives in exactly one place per layer and the layers are
        // pinned together once, on purpose, where that is the point.
        assert!(
            msg.contains(&format!(
                "live-controller capacity is {HOST_CONTROLLER_LIMIT}"
            )),
            "{msg}"
        );
        // THE POINT OF REFUSING LOCALLY: a host Fault poisons the whole one-use
        // session, so a second create reaching the host would tear down the
        // existing pad. `client` still being `None` is the proof that the
        // refusal never got that far.
        assert!(
            backend.client.is_none(),
            "the refusal must not open the elevated host",
        );
        assert_eq!(backend.pads.len(), HOST_CONTROLLER_LIMIT, "nothing changed");
    }

    #[test]
    fn gated_profiles_are_refused_before_capacity_or_host_access() {
        let mut backend = backend_with(&[Persona::DualSense]);
        for persona in [
            Persona::SwitchPro,
            Persona::XboxSeries,
            Persona::Snes,
            Persona::Genesis,
        ] {
            assert!(matches!(
                backend.plug_persona(persona),
                Err(OutputError::PersonaUnsupported(actual)) if actual == persona
            ));
        }
        assert!(backend.client.is_none());
        assert_eq!(backend.pads.len(), 1);
    }

    /// The staging gate and the runtime gate must agree on the pool size.
    ///
    /// Added 2026-08-26: each limit is written twice, once here and once in
    /// `ksx-core`, with nothing tying them together. Raise one and staging
    /// admits a pad the backend then refuses mid-session — or lower one and
    /// staging refuses a pad that would have worked. Both are silent.
    #[test]
    fn the_runtime_limits_match_the_ones_staging_validates_against() {
        assert_eq!(
            HOST_CONTROLLER_LIMIT,
            usize::from(ksx_core::MAX_HIDMAESTRO_PADS),
            "the host's pool ceiling and `StageRefusal::TooManyHidMaestroPads` \
             must be the same number",
        );
    }
}

#[cfg(not(windows))]
impl VirtualPadBackend for HidMaestroBackend {
    fn plug(&mut self) -> Result<PadHandle, OutputError> {
        Err(OutputError::HidMaestroHostUnavailable)
    }

    fn plug_persona(&mut self, _persona: Persona) -> Result<PadHandle, OutputError> {
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
