//! HIDMaestro support for KSX's production plain-USB DualSense persona.
//!
//! HIDMaestro (<https://github.com/hifihedgehog/HIDMaestro>, MIT) is a UMDF2
//! virtual-HID engine. The ordinary KSX daemon never opens its device mappings
//! or mutates PnP state. [`windows_transport`] starts one fixed installed
//! elevated sibling, authenticates that retained process over a one-use pipe,
//! and [`host`] carries bounded create/submit/feedback/destroy messages. The
//! sibling owns the exact driver ABI and one session-owned DualSense root.
//!
//! Switch Pro and Xbox Series remain independently build-gated. The older
//! seqlock, profile and lifecycle modules are retained as research/test models;
//! they are not the live driver path and cannot be selected by product routing.

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

    /// End to end through the *real* Sony map, against an expectation written
    /// out by hand rather than recomputed with `route`/`encode`.
    ///
    /// This used to build `expected` by calling `route()` and `encode()` — the
    /// two functions `submit()` calls internally — so swapping two axis roles
    /// changed both sides identically and the test still passed. The literals
    /// below are the reason it can now fail: they name the Sony usages
    /// (`rightStickX -> Z`, `leftTrigger -> Rx`), the HID Y-inversion, and the
    /// fact that the D-pad rides the hat instead of the button mask.
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

        // buttons(4) | hat(1) | axis_len(1) | pad(2), then 6 x (usage u16, f32).
        assert_eq!(
            u32::from_le_bytes(out[0..4].try_into().unwrap()),
            state::button::B,
            "B is the only button on the mask: DPAD_LEFT rides the hat"
        );
        assert_eq!(out[4], HmHat::West as u8, "DPAD_LEFT is hat West (7)");
        assert_eq!(out[5], 6, "six roles, no trigger mirror on this profile");
        assert_eq!(&out[6..8], &[0, 0], "the two reserved pad bytes");

        // Insertion order is `AxisRole::ALL`, resolved through
        // `AxisMap::sony_convention` — NOT the XInput assignment.
        let expected: [(u16, f32); 6] = [
            (0x0130, 1.0), // leftStickX  -> X,  lx = i16::MAX -> full right
            (0x0131, 0.5), // leftStickY  -> Y,  centered (inverted, exact)
            (0x0132, 0.5), // rightStickX -> Z   <- Z is leftTrigger under XInput
            (0x0135, 0.5), // rightStickY -> Rz, centered (inverted, exact)
            (0x0133, 1.0), // leftTrigger -> Rx, lt = 255 -> fully pulled
            (0x0134, 0.0), // rightTrigger-> Ry, released
        ];
        for (i, (usage, value)) in expected.into_iter().enumerate() {
            let at = 8 + i * 6;
            assert_eq!(
                u16::from_le_bytes(out[at..at + 2].try_into().unwrap()),
                usage,
                "axis slot {i} usage"
            );
            assert_eq!(
                f32::from_le_bytes(out[at + 2..at + 6].try_into().unwrap()),
                value,
                "axis slot {i} ({usage:#06x}) value"
            );
        }
        assert!(
            out[8 + 6 * 6..].iter().all(|&b| b == 0),
            "the unused tail must be zeroed so idle dedup can byte-compare"
        );
    }

    /// The module docs above claim the seqlock/profile/lifecycle half "cannot
    /// be selected by product routing". Until now nothing enforced that: the
    /// claim was a sentence, and a `HmContext`/`UnavailableDriver`/
    /// `HmController` call added to the product would have contradicted it
    /// silently.
    ///
    /// `crates/ksx-output/src/hidmaestro.rs` is the ONLY production consumer of
    /// this crate (nothing else in `crates/` names `ksx_hidmaestro` outside its
    /// own tests), so freezing the module set it reaches for is the whole
    /// boundary. `windows_transport.rs`'s
    /// `source_keeps_production_and_fake_admission_separate` is the same shape
    /// one layer down.
    #[test]
    fn the_research_model_is_unreachable_from_the_product() {
        let consumer = include_str!("../../ksx-output/src/hidmaestro.rs");
        let mut seen: Vec<&str> = Vec::new();
        for (at, _) in consumer.match_indices("ksx_hidmaestro::") {
            let rest = &consumer[at + "ksx_hidmaestro::".len()..];
            let end = rest
                .find(|c: char| !c.is_alphanumeric() && c != '_')
                .unwrap_or(rest.len());
            let module = &rest[..end];
            if !seen.contains(&module) {
                seen.push(module);
            }
        }
        assert!(
            !seen.is_empty(),
            "no `ksx_hidmaestro::` paths found — did the consumer move, or start \
             importing with `use`? This guard reads fully-qualified paths only."
        );
        seen.sort_unstable();
        assert_eq!(
            seen,
            ["host", "windows_transport"],
            "the live driver path is `host` + `windows_transport`. Anything else \
             here means the product now selects the research model, and lib.rs's \
             module docs are wrong."
        );
        // The model's own entry points, by name, so a `use` import cannot get
        // one in behind the qualified-path scan above.
        for model in [
            "HmContext",
            "HmController",
            "UnavailableDriver",
            "HmProfile",
            "HeapStorage",
            "Latch",
            "HmGamepadState",
        ] {
            assert!(
                !consumer.contains(model),
                "the product names the research-model type `{model}`"
            );
        }
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
