//! Production HIDMaestro adapter — one lane, one bounded protocol.
//!
//! The ordinary daemon owns only an authenticated protocol client. All driver
//! and shared-memory handles live in one fixed elevated sibling process: the
//! SDK-lane host that loads the hash-pinned official SDK
//! (`docs/HIDMAESTRO-STATE.md`, "Architecture decision"). Every HIDMaestro
//! persona rides it — DualSense joined on 2026-08-20 after the hardware
//! session measured the SDK lane working first-try while the candidate lane
//! needed three live root-causes; the audited candidate host still ships as
//! the conformance reference, and its client wiring lives in git history.
//! The host connects lazily at the first plug, so UAC appears exactly when a
//! rich persona is requested.

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

/// Canonical SHA-256 of `tools/hidmaestro-sdk-host/runtime-contract-sdk.json`,
/// the SDK lane's own bounded contract. Pinned identically in
/// `publish-sdk.ps1`, `SdkHostSession.cs` and `build-installer.yml`.
#[cfg(windows)]
const SDK_RUNTIME_CONTRACT_SHA256: [u8; 32] = [
    0xB7, 0x44, 0xC0, 0xF3, 0xF0, 0xD8, 0x00, 0x54, 0xBB, 0xD2, 0x3E, 0x86, 0x82, 0x82, 0x0C, 0x2B,
    0x2C, 0x42, 0x57, 0x5C, 0x09, 0xA8, 0x36, 0x27, 0xCB, 0x68, 0x56, 0xB0, 0xFD, 0x22, 0xF2, 0x40,
];

/// The host's live-controller ceiling — ksx's eight-player couch design, and
/// the `controllerLimit` the SDK contract declares. Enforced HERE, before the
/// host is asked: any host Fault poisons the whole one-use session by design
/// (fail-closed), so an over-capacity request must be refused locally rather
/// than allowed to tear down every live pad. The host's own Capacity fault
/// stays as defense-in-depth.
#[cfg(windows)]
const HOST_CONTROLLER_LIMIT: usize = 8;

/// XInput seats four pads; a fifth Xbox Series companion would come up
/// slotless (measured 2026-08-20: each Xbox pad claims a real slot).
#[cfg(windows)]
const XINPUT_SEAT_LIMIT: usize = 4;

#[cfg(windows)]
struct LivePad {
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

/// The authenticated connection to the fixed installed elevated SDK host,
/// established at the first plug of a HIDMaestro persona.
#[cfg(windows)]
pub struct HidMaestroBackend {
    sdk: Option<LaneClient>,
    pads: BTreeMap<u32, LivePad>,
    next_handle: u32,
}

#[cfg(not(windows))]
pub struct HidMaestroBackend {
    _unavailable: (),
}

impl HidMaestroBackend {
    /// Prepare the backend. The host is not launched here: the fixed
    /// elevated sibling starts at the FIRST plug of a HIDMaestro persona, so
    /// UAC appears exactly when a rich persona is requested.
    #[cfg(windows)]
    pub fn connect() -> Result<Self, OutputError> {
        Ok(Self {
            sdk: None,
            pads: BTreeMap::new(),
            next_handle: 1,
        })
    }

    /// The host client, launching and authenticating the SDK host on first
    /// use.
    #[cfg(windows)]
    fn client(&mut self) -> Result<&mut LaneClient, OutputError> {
        if self.sdk.is_none() {
            let expected = ksx_hidmaestro::host::HostExpectation {
                sdk_sha256: SDK_RUNTIME_CONTRACT_SHA256,
                catalog_sha256: CATALOG_SHA256,
                catalog_resource_count: 228,
            };
            let client =
                ksx_hidmaestro::windows_transport::WindowsHostTransport::connect_production_sdk(
                    expected,
                )
                .map_err(|error| OutputError::HidMaestroRuntime(error.to_string()))?;
            self.sdk = Some(client);
        }
        Ok(self.sdk.as_mut().expect("just connected"))
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
        if let Some(client) = self.sdk.as_mut() {
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
        // The BUILD GATE decides which personas exist, not this adapter.
        // Asking `can_plug` keeps ksx-core's `PadBackend::supports` in sole
        // charge of that, so a persona going live is a change there rather
        // than a second place to remember.
        if !persona.can_plug() {
            return Err(OutputError::PersonaUnsupported(persona));
        }
        let profile = ksx_hidmaestro::host::ProfileId::try_from(persona)
            .map_err(|_| OutputError::PersonaUnsupported(persona))?;
        // Capacity is refused HERE, before the host is asked: a host Fault
        // poisons the whole one-use session (fail-closed), so letting a 9th
        // create reach the host would tear down eight live pads. The host
        // enforces the same limits as defense-in-depth.
        if self.pads.len() >= HOST_CONTROLLER_LIMIT {
            return Err(OutputError::HidMaestroRuntime(format!(
                "the HIDMaestro host carries at most {HOST_CONTROLLER_LIMIT} live controllers"
            )));
        }
        if persona.is_xinput()
            && self
                .pads
                .values()
                .filter(|pad| pad.persona.is_xinput())
                .count()
                >= XINPUT_SEAT_LIMIT
        {
            return Err(OutputError::HidMaestroRuntime(format!(
                "XInput seats {XINPUT_SEAT_LIMIT} pads; another {persona} pad would come up slotless"
            )));
        }
        let ready = self.client()?.create(profile).map_err(Self::runtime)?;
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
