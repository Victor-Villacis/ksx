//! Production HIDMaestro adapter for the first live, exact DualSense slice.
//!
//! The ordinary daemon owns only an authenticated protocol client. All driver
//! and shared-memory handles live in the fixed elevated sibling process. The
//! host supports one exact DualSense controller; Switch Pro and Xbox Series
//! remain build-gated until their independently reviewed runtime paths exist.

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
    0x1C, 0x49, 0xF9, 0xCE, 0x3F, 0x40, 0x6E, 0xD3, 0x16, 0x39, 0x35, 0xB7, 0x59, 0xED, 0xC3, 0x5B,
    0x9B, 0x3C, 0xBE, 0xBD, 0x63, 0x96, 0xA9, 0x9D, 0xDF, 0xE3, 0xDC, 0x9F, 0x07, 0xE4, 0x68, 0xB0,
];

#[cfg(windows)]
const CATALOG_SHA256: [u8; 32] = [
    0x8F, 0x40, 0x7E, 0x6E, 0x1C, 0x3C, 0x24, 0x1E, 0x16, 0xCF, 0x6B, 0xEF, 0x38, 0x72, 0x16, 0xAD,
    0x4D, 0x1F, 0x5D, 0xE0, 0x55, 0xA2, 0xC4, 0xCC, 0x04, 0x1C, 0xA1, 0x6C, 0xE7, 0x95, 0x4A, 0x6A,
];

#[cfg(windows)]
struct LivePad {
    controller: ksx_hidmaestro::host::ControllerId,
    state: PadState,
    last_submit: Instant,
    feedback: VecDeque<Feedback>,
}

/// One authenticated connection to the fixed installed elevated host.
#[cfg(windows)]
pub struct HidMaestroBackend {
    client:
        ksx_hidmaestro::host::HostClient<ksx_hidmaestro::windows_transport::WindowsHostTransport>,
    pads: BTreeMap<u32, LivePad>,
    next_handle: u32,
}

#[cfg(not(windows))]
pub struct HidMaestroBackend {
    _unavailable: (),
}

impl HidMaestroBackend {
    /// Start the fixed production host. No driver object is touched until a
    /// DualSense is actually requested through [`plug_persona`](Self::plug_persona).
    #[cfg(windows)]
    pub fn connect() -> Result<Self, OutputError> {
        let expected = ksx_hidmaestro::host::HostExpectation {
            sdk_sha256: RUNTIME_CONTRACT_SHA256,
            catalog_sha256: CATALOG_SHA256,
            catalog_resource_count: 228,
        };
        let client =
            ksx_hidmaestro::windows_transport::WindowsHostTransport::connect_production(expected)
                .map_err(|error| OutputError::HidMaestroRuntime(error.to_string()))?;
        Ok(Self {
            client,
            pads: BTreeMap::new(),
            next_handle: 1,
        })
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
            self.client
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

        while let Some(event) = self.client.poll_feedback().map_err(Self::runtime)? {
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
        Ok(())
    }

    fn plug(&mut self) -> Result<PadHandle, OutputError> {
        Err(OutputError::PersonaUnsupported(Persona::Xbox360))
    }

    fn plug_persona(&mut self, persona: Persona) -> Result<PadHandle, OutputError> {
        if persona != Persona::DualSense {
            return Err(OutputError::PersonaUnsupported(persona));
        }
        if !self.pads.is_empty() {
            return Err(OutputError::HidMaestroRuntime(
                "the current HIDMaestro host supports one live DualSense".to_owned(),
            ));
        }
        let ready = self
            .client
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
                state: PadState::default(),
                last_submit: Instant::now(),
                feedback: VecDeque::new(),
            },
        );
        Ok(handle)
    }

    fn persona(&self, handle: PadHandle) -> Option<Persona> {
        self.pads
            .contains_key(&handle.0)
            .then_some(Persona::DualSense)
    }

    fn user_index(&self, _handle: PadHandle) -> Option<u8> {
        None
    }

    fn update(&mut self, handle: PadHandle, state: &PadState) -> Result<(), OutputError> {
        let controller = self.live_mut(handle)?.controller;
        self.client
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
        self.client.destroy(controller).map_err(Self::runtime)?;
        self.pads.remove(&handle.0);
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for HidMaestroBackend {
    fn drop(&mut self) {
        let _ = self.client.shutdown();
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
