//! ksx-hidmaestro — HIDMaestro experiments and a future host contract.
//!
//! HIDMaestro (<https://github.com/hifihedgehog/HIDMaestro>, **MIT**) is a
//! user-mode (UMDF2) HID descriptor emulator and KSX's planned route to richer
//! personas than ViGEmBus provides. S1.5c freezes only a source-level,
//! plain-USB DualSense conformance slice; Switch Pro and Xbox Series remain
//! roadmap scope, not implemented catalog/runtime paths.
//!
//! # Status: experimental model, NOT a production wire client
//!
//! This build has no production implementation of HIDMaestro's creator/input/
//! output protocol, regardless of whether the driver is installed. Most of this
//! crate predates the authoritative upstream layout and was implemented against
//! the protocol map in
//! `docs/research/padforge-code-audit.md` §3, which was extracted from
//! PadForge's working C# client. HIDMaestro's author has since supplied the exact
//! object names and pointed KSX to `driver/driver.h` and
//! `sdk/HIDMaestro.Core/Internal/SharedMemoryIO.cs`. Those sources show that the
//! real protocol is larger than this crate's custom latch: creator-owned mappings
//! and events, native HID/GIP/extended input data, an output ring, PID state and
//! per-controller configuration. The current encoder must not be connected to a
//! live driver.
//!
//! What that means concretely:
//!
//! | Layer | Verified | How |
//! |---|---|---|
//! | Seqlock discipline ([`seqlock`]) | **Yes** — real concurrency test | writer thread vs reader loop over shared atomics |
//! | Keepalive cadence ([`keepalive`]) | **Yes** — pure logic, derived constants | arithmetic against the three watchdogs |
//! | Axis routing by name ([`axis`], [`state`]) | **Yes** — pure logic | including a counterfactual that reproduces the phantom-trigger bug |
//! | Legacy lifecycle scaffold ([`context`]) | **Model only, not the supported upstream lifecycle** | recorded test-double order; it must not back production Play |
//! | Plain-USB DualSense feedback ([`feedback`]) | **Source-pinned contract, hardware unverified** | exact raw `OutputReceived` envelope, offsets, validity policy and effective-state fixtures |
//! | Privileged-host protocol ([`host`]) | **Yes — pure framing/state machine only** | all twelve frozen message vectors + encoded in-memory host; no SDK calls |
//! | Windows host transport ([`windows_transport`]) | **Source complete, fake-host evidence gated** | precreated one-use pipe, authenticated endpoint, bounded framed I/O and fail-closed teardown; production launch remains unreachable without the fixed native bootstrap |
//! | Host rendezvous policy ([`rendezvous`]) | **Yes — pure identity policy only** | fixed token/name/argv plus exact peer-evidence refusals; this policy module itself has no pipe, process or elevation calls |
//! | Current custom latch ([`shm`], [`state::HmGamepadState::encode`]) | **Not HIDMaestro wire-compatible** | useful test scaffold; upstream layout is now known but not implemented here |
//! | Anything touching a real device | **No** | there is no device to touch |
//!
//! Nothing here fakes a controller. [`driver::UnavailableDriver`] always
//! refuses the missing KSX implementation, while `ksx doctor` separately
//! reports install evidence.
//!
//! # Shape
//!
//! - [`seqlock`] — an isolated seqlock model and its read/write discipline. The
//!   production SDK/driver structures have additional fields and ownership rules.
//! - [`keepalive`] — 16 ms idle-dedup, derived from three driver watchdogs.
//! - [`axis`] / [`state`] — HID-usage axes, routed **by role through the
//!   profile's map**, never positionally.
//! - [`profile`] — descriptor + axis map, PID-block detection.
//! - [`context`] — an older lifecycle scaffold retained for tests, not the
//!   supported `HMContext` / `HMController` production boundary.
//! - [`feedback`] — source-pinned plain-USB DualSense raw feedback plus older
//!   experimental Xbox/PID tables.
//! - [`host`] — bounded/versioned future process protocol and transport-neutral
//!   client state machine. It launches nothing and touches no driver.
//! - [`rendezvous`] — the pure token/name/argv and peer-identity policy the
//!   authenticated Windows transport must enforce before using [`host`].
//! - [`windows_transport`] — the Windows-only one-use named-pipe transport. Its
//!   only current launcher is the fixed, non-elevating inherited-token fake host
//!   behind an explicit test feature; no production elevated-host bootstrap is
//!   reachable yet.
//! - [`driver`] — availability evidence plus the always-not-implemented driver.
//! - [`shm`] (Windows) — experimental open-existing file-mapping storage; the
//!   real writer creates named mappings/events with the upstream security contract.

pub mod axis;
pub mod context;
pub mod driver;
mod dualsense_feedback;
pub mod error;
pub mod feedback;
pub mod host;
pub mod keepalive;
pub mod profile;
pub mod rendezvous;
pub mod seqlock;
#[cfg(windows)]
pub mod shm;
pub mod state;
pub mod windows_transport;

pub use axis::{AxisMap, AxisRole, HmAxis};
pub use context::{HmContext, HmDriverApi, SlotId};
pub use driver::{Availability, UnavailableDriver};
pub use error::{HmError, ProbeSummary};
pub use feedback::{
    decode_xbox_hid, decode_xinput, Decoded, DualSenseDecodeResult, DualSenseDisposition,
    DualSenseFeedbackDecoder, DualSenseRejectReason, EffectiveMotorSnapshot, Motors, OutputSource,
    RawDualSensePacket,
};
pub use keepalive::{Cadence, Publish, KEEPALIVE};
pub use profile::{slug_for, HmProfile, Transport};
pub use seqlock::{HeapStorage, Latch, LatchStorage};
pub use state::{route, HmGamepadState, HmHat, FRAME_BYTES};

/// One private, non-wire-compatible pad model: a profile, a test latch, and its
/// cadence.
///
/// This is the whole private model submit path, and it is deliberately small.
pub struct HmController<S: LatchStorage> {
    slot: SlotId,
    profile: HmProfile,
    latch: Latch<S>,
    cadence: Cadence<FRAME_BYTES>,
    frame: HmGamepadState,
    /// Scratch encode buffer. Owned so the submit path allocates nothing.
    scratch: [u8; FRAME_BYTES],
}

impl<S: LatchStorage> HmController<S> {
    pub fn new(slot: SlotId, profile: HmProfile, latch: Latch<S>) -> Result<Self, HmError> {
        profile.validate()?;
        Ok(Self {
            slot,
            profile,
            latch,
            cadence: Cadence::new(),
            frame: HmGamepadState::new(),
            scratch: [0; FRAME_BYTES],
        })
    }

    pub fn slot(&self) -> SlotId {
        self.slot
    }

    pub fn profile(&self) -> &HmProfile {
        &self.profile
    }

    /// Routes a ksx pad state into the private latch format and publishes it if
    /// the cadence says to. This does not encode or submit HIDMaestro wire data.
    ///
    /// Allocation-free and lock-free: routing writes into an inline frame, the
    /// encode goes into an owned scratch buffer, and the publish is three
    /// atomic stores plus a byte copy. Returns what the cadence decided, so a
    /// caller can count elided submits without instrumenting the latch.
    pub fn submit(&mut self, state: &ksx_core::PadState, now: std::time::Instant) -> Publish {
        route(&self.profile.axis_map, state, &mut self.frame);
        self.frame.encode(&mut self.scratch);
        let decision = self.cadence.take(&self.scratch, now);
        if decision.should_publish() {
            self.latch.publish(&self.scratch);
        }
        decision
    }

    /// Current private-latch `SeqNo`, used only by the cadence/model tests. No
    /// HIDMaestro driver observes this counter.
    pub fn seq(&self) -> u32 {
        self.latch.seq()
    }
}

#[cfg(test)]
mod tests {
    use ksx_core::pad::XButtons;
    use ksx_core::PadState;

    use super::*;
    use std::time::{Duration, Instant};

    fn controller() -> HmController<HeapStorage> {
        let profile = profile::dualsense_conformance_stub_profile();
        let latch = Latch::new(HeapStorage::new(FRAME_BYTES), FRAME_BYTES).unwrap();
        HmController::new(0, profile, latch).unwrap()
    }

    /// End to end, with no driver: state in, deduped publications out, SeqNo
    /// advancing only when something was actually written.
    #[test]
    fn the_submit_path_dedups_idle_frames_and_advances_seqno_only_on_publish() {
        let mut c = controller();
        let t0 = Instant::now();
        let neutral = PadState::default();

        assert_eq!(c.submit(&neutral, t0), Publish::Changed);
        let after_first = c.seq();
        assert_eq!(after_first, 2);

        // 15 idle ticks: nothing is written, SeqNo does not move.
        for ms in 1..16u64 {
            assert_eq!(
                c.submit(&neutral, t0 + Duration::from_millis(ms)),
                Publish::Skip
            );
        }
        assert_eq!(c.seq(), after_first, "an elided submit writes nothing");

        // The keepalive tick republishes the identical frame, which is the only
        // reason SeqNo moves here — and the only reason the GIP companion does
        // not zero XInput state.
        assert_eq!(c.submit(&neutral, t0 + KEEPALIVE), Publish::Keepalive);
        assert_eq!(c.seq(), after_first + 2);

        // A change goes out immediately, mid-window.
        let pressed = PadState {
            buttons: XButtons::A,
            ..PadState::default()
        };
        assert_eq!(
            c.submit(&pressed, t0 + KEEPALIVE + Duration::from_micros(1)),
            Publish::Changed
        );
        assert_eq!(c.seq(), after_first + 4);
    }

    #[test]
    fn what_is_published_is_what_a_reader_reads_back() {
        let mut c = controller();
        let state = PadState {
            buttons: XButtons::B | XButtons::DPAD_LEFT,
            lt: 255,
            lx: i16::MAX,
            ..PadState::default()
        };
        c.submit(&state, Instant::now());

        let mut out = [0u8; FRAME_BYTES];
        c.latch.read_into(&mut out).unwrap();
        let mut expected = HmGamepadState::new();
        route(&c.profile.axis_map, &state, &mut expected);
        let mut expected_bytes = [0u8; FRAME_BYTES];
        expected.encode(&mut expected_bytes);
        assert_eq!(out, expected_bytes);
    }

    #[test]
    fn a_controller_cannot_be_built_from_an_undeployable_profile() {
        let mut profile = profile::dualsense_conformance_stub_profile();
        profile.descriptor.clear();
        let latch = Latch::new(HeapStorage::new(FRAME_BYTES), FRAME_BYTES).unwrap();
        assert!(matches!(
            HmController::new(0, profile, latch),
            Err(HmError::ProfileNotDeployable(_))
        ));
    }
}
