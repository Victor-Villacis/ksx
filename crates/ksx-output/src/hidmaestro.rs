//! Production HIDMaestro adapter — two lanes, one bounded protocol.
//!
//! The ordinary daemon owns only authenticated protocol clients. All driver
//! and shared-memory handles live in fixed elevated sibling processes:
//! DualSense in the audited candidate host, Switch Pro and Xbox Series in the
//! SDK-lane host that loads the hash-pinned official SDK
//! (`docs/HIDMAESTRO-STATE.md`, "Architecture decision"). Each lane connects
//! lazily at the first plug of one of its personas, so UAC appears exactly
//! when a rich persona is requested and never for the other lane. The SDK
//! lane's personas remain build-gated in `ksx-core` until hardware proves
//! them; the lane is wired, not offered.

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
const RUNTIME_CONTRACT_SHA256: [u8; 32] = [
    0x4F, 0x76, 0xF3, 0x1C, 0x04, 0x93, 0x90, 0xA1, 0x34, 0x23, 0x88, 0xE0, 0x9F, 0x9D, 0x0D, 0x0E,
    0x35, 0x47, 0x16, 0x2D, 0x08, 0xEA, 0x50, 0x1F, 0xD8, 0x29, 0xAF, 0x3C, 0xF6, 0x4F, 0x67, 0xDA,
];

#[cfg(windows)]
const CATALOG_SHA256: [u8; 32] = [
    0x8F, 0x40, 0x7E, 0x6E, 0x1C, 0x3C, 0x24, 0x1E, 0x16, 0xCF, 0x6B, 0xEF, 0x38, 0x72, 0x16, 0xAD,
    0x4D, 0x1F, 0x5D, 0xE0, 0x55, 0xA2, 0xC4, 0xCC, 0x04, 0x1C, 0xA1, 0x6C, 0xE7, 0x95, 0x4A, 0x6A,
];

/// Canonical SHA-256 of `tools/hidmaestro-sdk-host/runtime-contract-sdk.json`,
/// the SDK lane's own bounded contract. Pinned identically in
/// `publish-sdk.ps1`, `SdkHostSession.cs` and `build-installer.yml`.
#[cfg(windows)]
const SDK_RUNTIME_CONTRACT_SHA256: [u8; 32] = [
    0x3F, 0xC7, 0x4E, 0x0A, 0xD0, 0x63, 0xCE, 0x02, 0xA2, 0x2D, 0xB9, 0x86, 0x68, 0x42, 0xBD, 0x02,
    0x98, 0x7D, 0x10, 0x27, 0x31, 0x5A, 0xE8, 0x99, 0xEA, 0xE9, 0x03, 0x05, 0x84, 0x7C, 0xDB, 0xAF,
];

/// Which elevated sibling serves a persona. DualSense must never travel the
/// SDK lane (one persona, one lane), and the SDK personas cannot exist on the
/// candidate host at all.
#[cfg(windows)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HostLane {
    Candidate,
    Sdk,
}

#[cfg(windows)]
fn lane_for(persona: Persona) -> Option<HostLane> {
    match persona {
        Persona::DualSense => Some(HostLane::Candidate),
        Persona::SwitchPro | Persona::XboxSeries => Some(HostLane::Sdk),
        Persona::Xbox360 | Persona::PlayStation => None,
    }
}

#[cfg(windows)]
struct LivePad {
    /// Which host owns this pad. Both hosts number their one controller `1`,
    /// so a controller id means nothing without its lane.
    lane: HostLane,
    controller: ksx_hidmaestro::host::ControllerId,
    /// ⚠️ WHICH PERSONA THIS PAD ACTUALLY IS. `persona()` used to answer
    /// DualSense for any live handle — true only while DualSense was the one
    /// profile that could exist, and a lie the moment a second one can. The
    /// answer feeds session reporting and the XInput-slot accounting, so it
    /// comes from the profile the host confirmed, never from a constant.
    persona: Persona,
    state: PadState,
    last_submit: Instant,
    feedback: VecDeque<Feedback>,
}

#[cfg(windows)]
type LaneClient =
    ksx_hidmaestro::host::HostClient<ksx_hidmaestro::windows_transport::WindowsHostTransport>;

/// Authenticated connections to the fixed installed elevated hosts, one per
/// lane, each established at the first plug of one of its personas.
#[cfg(windows)]
pub struct HidMaestroBackend {
    candidate: Option<LaneClient>,
    sdk: Option<LaneClient>,
    pads: BTreeMap<u32, LivePad>,
    next_handle: u32,
}

#[cfg(not(windows))]
pub struct HidMaestroBackend {
    _unavailable: (),
}

impl HidMaestroBackend {
    /// Prepare the backend. Neither host is launched here: each lane's fixed
    /// elevated sibling starts at the FIRST plug of one of its personas, so
    /// UAC appears exactly when a rich persona is requested and never for a
    /// lane that session never uses.
    #[cfg(windows)]
    pub fn connect() -> Result<Self, OutputError> {
        Ok(Self {
            candidate: None,
            sdk: None,
            pads: BTreeMap::new(),
            next_handle: 1,
        })
    }

    /// The lane's client, launching and authenticating its host on first use.
    #[cfg(windows)]
    fn client_for(&mut self, lane: HostLane) -> Result<&mut LaneClient, OutputError> {
        let slot = match lane {
            HostLane::Candidate => &mut self.candidate,
            HostLane::Sdk => &mut self.sdk,
        };
        if slot.is_none() {
            let expected = match lane {
                HostLane::Candidate => ksx_hidmaestro::host::HostExpectation {
                    sdk_sha256: RUNTIME_CONTRACT_SHA256,
                    catalog_sha256: CATALOG_SHA256,
                    catalog_resource_count: 228,
                },
                HostLane::Sdk => ksx_hidmaestro::host::HostExpectation {
                    sdk_sha256: SDK_RUNTIME_CONTRACT_SHA256,
                    catalog_sha256: CATALOG_SHA256,
                    catalog_resource_count: 228,
                },
            };
            let client = match lane {
                HostLane::Candidate => {
                    ksx_hidmaestro::windows_transport::WindowsHostTransport::connect_production(
                        expected,
                    )
                }
                HostLane::Sdk => {
                    ksx_hidmaestro::windows_transport::WindowsHostTransport::connect_production_sdk(
                        expected,
                    )
                }
            }
            .map_err(|error| OutputError::HidMaestroRuntime(error.to_string()))?;
            *slot = Some(client);
        }
        Ok(slot.as_mut().expect("just connected"))
    }

    /// The lane's client only if its host is already running — polling paths
    /// must never launch an elevated process as a side effect.
    #[cfg(windows)]
    fn connected_client(&mut self, lane: HostLane) -> Option<&mut LaneClient> {
        match lane {
            HostLane::Candidate => self.candidate.as_mut(),
            HostLane::Sdk => self.sdk.as_mut(),
        }
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
            .map(|pad| (pad.lane, pad.controller, pad.state))
            .collect();
        for (lane, controller, state) in renewals {
            self.client_for(lane)?
                .submit(controller, state)
                .map_err(Self::runtime)?;
            if let Some(pad) = self
                .pads
                .values_mut()
                .find(|pad| pad.lane == lane && pad.controller == controller)
            {
                pad.last_submit = now;
            }
        }

        // Poll only lanes whose host is already running: servicing must never
        // launch an elevated process. Both hosts number their controller `1`,
        // so events are matched lane-first.
        for lane in [HostLane::Candidate, HostLane::Sdk] {
            let Some(client) = self.connected_client(lane) else {
                continue;
            };
            let mut events = Vec::new();
            while let Some(event) = client.poll_feedback().map_err(Self::runtime)? {
                events.push(event);
            }
            for event in events {
                if let Some(pad) = self
                    .pads
                    .values_mut()
                    .find(|pad| pad.lane == lane && pad.controller == event.controller)
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
        // The BUILD GATE decides which personas exist, not this adapter.
        // Asking `can_plug` keeps ksx-core's `PadBackend::supports` in sole
        // charge of that, so a persona going live is a change there rather
        // than a second place to remember.
        if !persona.can_plug() {
            return Err(OutputError::PersonaUnsupported(persona));
        }
        let profile = ksx_hidmaestro::host::ProfileId::try_from(persona)
            .map_err(|_| OutputError::PersonaUnsupported(persona))?;
        let lane = lane_for(persona).ok_or(OutputError::PersonaUnsupported(persona))?;
        // The ceiling is the HOSTS', and it is one controller in TOTAL — each
        // host enforces `controllerLimit: 1`, and the product offers at most
        // one rich persona at a time.
        if !self.pads.is_empty() {
            return Err(OutputError::HidMaestroRuntime(
                "the current HIDMaestro hosts support one live controller at a time".to_owned(),
            ));
        }
        let ready = self
            .client_for(lane)?
            .create(profile)
            .map_err(Self::runtime)?;
        let handle = PadHandle(self.next_handle);
        self.next_handle = self.next_handle.checked_add(1).ok_or_else(|| {
            OutputError::HidMaestroRuntime("pad handle space is exhausted".into())
        })?;
        self.pads.insert(
            handle.0,
            LivePad {
                lane,
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
        let (lane, controller) = {
            let pad = self.live_mut(handle)?;
            (pad.lane, pad.controller)
        };
        self.client_for(lane)?
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
        let (lane, controller) = {
            let pad = self.live_mut(handle)?;
            (pad.lane, pad.controller)
        };
        self.client_for(lane)?
            .destroy(controller)
            .map_err(Self::runtime)?;
        self.pads.remove(&handle.0);
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for HidMaestroBackend {
    fn drop(&mut self) {
        if let Some(mut client) = self.candidate.take() {
            let _ = client.shutdown();
        }
        if let Some(mut client) = self.sdk.take() {
            let _ = client.shutdown();
        }
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
