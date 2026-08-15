//! The feedback decode table — rumble/FFB coming back from the OS.
//!
//! The plain-USB DualSense path is transcribed from pinned HIDMaestro v1.6.1,
//! Linux and SDL sources. Other tables remain the older PadForge-derived model.
//! Every rule is still **unverified on physical hardware**; tests pin the source
//! contract so a live capture can contradict it precisely rather than vaguely.
//!
//! One safety rule governs the whole module: a non-motor command never invents
//! a zero-motor update. The stateful DualSense reducer carries the complete
//! prior motor pair forward; structurally invalid input produces no snapshot.
//! Only source-proven zero forms are interpreted as an explicit stop.

/// Which lane a packet arrived on. HIDMaestro reports this alongside the bytes,
/// and it disambiguates layouts that would otherwise collide on length.
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
#[repr(u8)]
pub enum OutputSource {
    /// A HID output report written to the device.
    HidOutput = 0,
    /// A HID `SetFeature`.
    HidFeature = 1,
    /// An `XUSB`-style vibration IOCTL, forwarded by the GIP companion.
    XInput = 2,
    /// A HID `GetFeature` response.
    HidFeatureRead = 3,
}

/// Motor magnitudes, in the 16-bit domain XInput and SDL both use.
///
/// u16 rather than u8 because two of the four sources carry more than 8 bits of
/// range (XInput's IOCTL sends the high byte of a u16; the Xbox Series BT form
/// sends 0..100 scaled by 655). Narrowing happens at the ksx boundary, once.
#[derive(Clone, Copy, Debug, Default, Hash, PartialEq, Eq)]
pub struct Motors {
    /// Low-frequency (left) motor.
    pub large: u16,
    /// High-frequency (right) motor.
    pub small: u16,
    /// Left impulse trigger (Xbox One+ only; 0 elsewhere).
    pub left_trigger: u16,
    /// Right impulse trigger.
    pub right_trigger: u16,
}

impl Motors {
    /// Narrow to the 8-bit shape `ksx_output::Feedback` carries.
    pub const fn as_u8(self) -> (u8, u8) {
        ((self.large >> 8) as u8, (self.small >> 8) as u8)
    }
}

/// Result of decoding one packet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decoded {
    /// New motor state, to be applied.
    Motors(Motors),
    /// Not a feedback packet at all (wrong header, too short to be anything).
    Ignored,
}

/// Scales the Xbox Series BT motor range (0..=100) into the 16-bit domain.
/// The audit's constant is ×655; 100 × 655 = 65500, i.e. full scale within
/// rounding, and the multiply cannot overflow a u16 for in-range input.
const XBOX_BT_MOTOR_SCALE: u16 = 655;

/// Decodes an [`OutputSource::XInput`] vibration IOCTL.
///
/// Layout: `[00, 08, leftHi, rightHi, reserved]`, i.e. the *high bytes* of the
/// two u16 magnitudes. 7+ bytes is `XINPUT_VIBRATION_EX`, which appends impulse
/// trigger magnitudes at offsets 4 and 5. A 5-byte packet explicitly **zeroes**
/// the trigger motors (it is the short form saying "no impulse data"), which is
/// different from preserving them.
///
/// Zero magnitudes are a legitimate value and are never filtered: Chromium
/// drives dual-rumble as a `hi=127 / hi=0` square wave, so dropping the zero
/// half would leave the pad buzzing continuously.
pub fn decode_xinput(bytes: &[u8]) -> Decoded {
    if bytes.len() < 5 || bytes[0] != 0x00 || bytes[1] != 0x08 {
        return Decoded::Ignored;
    }
    let mut motors = Motors {
        large: u16::from(bytes[2]) << 8,
        small: u16::from(bytes[3]) << 8,
        ..Motors::default()
    };
    // 6-byte packets carry no impulse fields either; only the documented 7+
    // form does. Treat anything shorter as "triggers zeroed", as the 5-byte
    // form does.
    if bytes.len() >= 7 {
        motors.left_trigger = u16::from(bytes[4]) << 8;
        motors.right_trigger = u16::from(bytes[5]) << 8;
    }
    Decoded::Motors(motors)
}

/// Decodes an [`OutputSource::HidOutput`] packet from an Xbox-family device.
///
/// Two forms, disambiguated by length:
/// - **len 4..=7** — the Xbox Series *Bluetooth* short form,
///   `[trigL, trigR, motorL, motorR, dur, delay, loop]`, motors 0..=100. It is
///   SDL's XboxOne rumble payload minus SDL's 2-byte header.
/// - **len >= 8** — the legacy Xbox HID form, motors at bytes 5 and 6.
pub fn decode_xbox_hid(bytes: &[u8]) -> Decoded {
    match bytes.len() {
        0..=3 => Decoded::Ignored,
        4..=7 => {
            // Out-of-range magnitudes are clamped rather than rejected: a
            // consumer that sends 255 means "as hard as you can", and dropping
            // the packet would mean "not at all".
            let scale = |v: u8| u16::from(v.min(100)) * XBOX_BT_MOTOR_SCALE;
            Decoded::Motors(Motors {
                left_trigger: scale(bytes[0]),
                right_trigger: scale(bytes[1]),
                large: scale(bytes[2]),
                small: scale(bytes[3]),
            })
        }
        _ => Decoded::Motors(Motors {
            large: u16::from(bytes[5]) << 8,
            small: u16::from(bytes[6]) << 8,
            ..Motors::default()
        }),
    }
}

pub use crate::dualsense_feedback::{
    DualSenseDecodeResult, DualSenseDisposition, DualSenseFeedbackDecoder, DualSenseRejectReason,
    EffectiveMotorSnapshot, RawDualSensePacket, DUALSENSE_COMPATIBLE_VIBRATION_MASK,
    DUALSENSE_COMPATIBLE_VIBRATION_V2_MASK, DUALSENSE_HAPTICS_SELECT_MASK,
    DUALSENSE_LEFT_LARGE_MOTOR_OFFSET, DUALSENSE_RIGHT_SMALL_MOTOR_OFFSET,
    DUALSENSE_USB_OUTPUT_DATA_LEN, DUALSENSE_USB_OUTPUT_REPORT_ID, DUALSENSE_VALID_FLAG0_OFFSET,
    DUALSENSE_VALID_FLAG2_OFFSET, HID_OUTPUT_SOURCE,
};

/// A HID-PID effect, reduced to what a rumble consumer needs: a magnitude and
/// **when it expires**.
///
/// The reason this carries a deadline at all is PadForge's stuck-rumble bug
/// (Jedi Outcast): PID effect durations expire on the *device* clock, so a game
/// that sets a 200 ms constant-force effect and then goes quiet leaves the last
/// vibration latched forever unless something sweeps expiries per tick. See
/// [`PidEffects::apply_if_due`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PidEffect {
    pub magnitude: u16,
    /// Effect duration in milliseconds; `None` = infinite (until Block Free or
    /// Device Control stop).
    pub duration_ms: Option<u32>,
    /// Milliseconds since the effect started, accumulated by the per-tick pass.
    pub elapsed_ms: u32,
    pub running: bool,
}

impl PidEffect {
    pub fn expired(&self) -> bool {
        match self.duration_ms {
            Some(d) => self.elapsed_ms >= d,
            None => false,
        }
    }
}

/// The PID effect pool for one device.
///
/// Fixed capacity: the pool must be published to the driver **before the device
/// enumerates** (DirectInput issues `GetFeature(PidPool)` during `CreateEffect`,
/// so lazy init on first output packet is too late — see
/// [`crate::context::HmContext::create_controller`]), which means its size is a
/// property of the profile, not of runtime demand.
#[derive(Clone, Copy, Debug)]
pub struct PidEffects<const N: usize> {
    effects: [PidEffect; N],
}

impl<const N: usize> Default for PidEffects<N> {
    fn default() -> Self {
        Self::new()
    }
}

impl<const N: usize> PidEffects<N> {
    pub const fn new() -> Self {
        Self {
            effects: [PidEffect {
                magnitude: 0,
                duration_ms: None,
                elapsed_ms: 0,
                running: false,
            }; N],
        }
    }

    pub fn set(&mut self, index: usize, effect: PidEffect) -> bool {
        match self.effects.get_mut(index) {
            Some(slot) => {
                *slot = effect;
                true
            }
            None => false,
        }
    }

    pub fn get(&self, index: usize) -> Option<&PidEffect> {
        self.effects.get(index)
    }

    /// The per-tick pass. Ages every running effect by `elapsed_ms`, stops the
    /// ones that expired, and returns the resulting magnitude (max over live
    /// effects).
    ///
    /// Must be called every tick even when no packet arrived — that is the whole
    /// point. Without it the last effect latches forever.
    pub fn apply_if_due(&mut self, elapsed_ms: u32) -> u16 {
        let mut magnitude = 0u16;
        for effect in &mut self.effects {
            if !effect.running {
                continue;
            }
            effect.elapsed_ms = effect.elapsed_ms.saturating_add(elapsed_ms);
            if effect.expired() {
                effect.running = false;
                effect.magnitude = 0;
                continue;
            }
            magnitude = magnitude.max(effect.magnitude);
        }
        magnitude
    }

    /// HID-PID "Device Control: stop all" / "Block Free".
    pub fn free_all(&mut self) {
        self.effects = Self::new().effects;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xinput_ioctl_five_byte_form_zeroes_the_trigger_motors() {
        let d = decode_xinput(&[0x00, 0x08, 0x7F, 0xFF, 0x00]);
        assert_eq!(
            d,
            Decoded::Motors(Motors {
                large: 0x7F00,
                small: 0xFF00,
                left_trigger: 0,
                right_trigger: 0,
            })
        );
    }

    #[test]
    fn xinput_ioctl_seven_byte_form_carries_impulse_triggers() {
        let d = decode_xinput(&[0x00, 0x08, 0x10, 0x20, 0x30, 0x40, 0x00]);
        assert_eq!(
            d,
            Decoded::Motors(Motors {
                large: 0x1000,
                small: 0x2000,
                left_trigger: 0x3000,
                right_trigger: 0x4000,
            })
        );
    }

    #[test]
    fn xinput_zero_magnitudes_are_data_not_noise() {
        // Chromium's dual-rumble square wave is hi=127 then hi=0. Filtering the
        // zero half leaves the pad buzzing forever.
        let d = decode_xinput(&[0x00, 0x08, 0x00, 0x00, 0x00]);
        assert_eq!(d, Decoded::Motors(Motors::default()));
        assert_ne!(d, Decoded::Ignored);
    }

    #[test]
    fn a_non_vibration_ioctl_is_ignored() {
        assert_eq!(decode_xinput(&[0x00, 0x09, 1, 2, 3]), Decoded::Ignored);
        assert_eq!(decode_xinput(&[0x00, 0x08, 1, 2]), Decoded::Ignored);
        assert_eq!(decode_xinput(&[]), Decoded::Ignored);
    }

    #[test]
    fn xbox_series_bt_short_form_scales_0_to_100_by_655() {
        // [trigL, trigR, motorL, motorR, dur, delay, loop]
        let d = decode_xbox_hid(&[0, 0, 100, 50, 0xFF, 0, 0]);
        assert_eq!(
            d,
            Decoded::Motors(Motors {
                large: 100 * 655,
                small: 50 * 655,
                left_trigger: 0,
                right_trigger: 0,
            })
        );
        // Full scale is ~65500, i.e. u16 range within rounding.
        match d {
            Decoded::Motors(m) => assert!(m.large > 65_000),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn xbox_legacy_hid_reads_motors_at_bytes_five_and_six() {
        let d = decode_xbox_hid(&[0, 0, 0, 0, 0, 0xAA, 0xBB, 0]);
        assert_eq!(
            d,
            Decoded::Motors(Motors {
                large: 0xAA00,
                small: 0xBB00,
                ..Motors::default()
            })
        );
    }

    #[test]
    fn xbox_hid_length_selects_the_form() {
        // The boundary the two layouts meet at: 7 is BT short, 8 is legacy.
        let bt = decode_xbox_hid(&[10, 20, 30, 40, 0, 0, 0]);
        let legacy = decode_xbox_hid(&[10, 20, 30, 40, 0, 0, 0, 0]);
        assert_ne!(bt, legacy);
        match bt {
            Decoded::Motors(m) => assert_eq!(m.large, 30 * 655),
            other => panic!("{other:?}"),
        }
        match legacy {
            Decoded::Motors(m) => assert_eq!(m.large, 0),
            other => panic!("{other:?}"),
        }
        assert_eq!(decode_xbox_hid(&[1, 2, 3]), Decoded::Ignored);
    }

    fn dualsense_packet(data: &[u8], seq_no: u32) -> RawDualSensePacket<'_> {
        RawDualSensePacket {
            source: HID_OUTPUT_SOURCE,
            report_id: DUALSENSE_USB_OUTPUT_REPORT_ID,
            data,
            seq_no,
        }
    }

    #[test]
    fn hidmaestro_output_source_values_are_source_pinned() {
        assert_eq!(OutputSource::HidOutput as u8, 0);
        assert_eq!(OutputSource::HidFeature as u8, 1);
        assert_eq!(OutputSource::XInput as u8, 2);
        assert_eq!(OutputSource::HidFeatureRead as u8, 3);
    }

    #[test]
    fn dualsense_raw_output_uses_separate_report_id_and_47_data_bytes() {
        let mut full_report = [0u8; DUALSENSE_USB_OUTPUT_DATA_LEN + 1];
        full_report[0] = DUALSENSE_USB_OUTPUT_REPORT_ID;
        full_report[1] = DUALSENSE_COMPATIBLE_VIBRATION_MASK | DUALSENSE_HAPTICS_SELECT_MASK;
        full_report[3] = 0x34;
        full_report[4] = 0x78;

        let mut decoder = DualSenseFeedbackDecoder::default();
        assert_eq!(
            decoder.apply(dualsense_packet(&full_report[1..], 7)),
            DualSenseDecodeResult::Snapshot {
                disposition: DualSenseDisposition::ApplyLegacy,
                snapshot: EffectiveMotorSnapshot {
                    large_motor: 0x78,
                    small_motor: 0x34,
                    source_seq_no: 7,
                },
            }
        );

        // Counterexample for the old bug: retaining the report ID in Data
        // shifts validFlag0 and both motors, so this must not apply an update.
        let mut shifted = DualSenseFeedbackDecoder::new(0xAA, 0xBB);
        assert!(matches!(
            shifted.apply(dualsense_packet(&full_report[..47], 8)),
            DualSenseDecodeResult::Snapshot {
                disposition: DualSenseDisposition::PreserveSelectorOnly,
                snapshot: EffectiveMotorSnapshot {
                    large_motor: 0xAA,
                    small_motor: 0xBB,
                    ..
                },
            }
        ));
    }

    #[test]
    fn legacy_and_v2_updates_replace_both_motors_atomically() {
        let mut decoder = DualSenseFeedbackDecoder::default();
        let mut legacy = [0u8; DUALSENSE_USB_OUTPUT_DATA_LEN];
        legacy[0] = DUALSENSE_COMPATIBLE_VIBRATION_MASK | DUALSENSE_HAPTICS_SELECT_MASK;
        legacy[2] = 0x12;
        legacy[3] = 0xAB;
        assert!(matches!(
            decoder.apply(dualsense_packet(&legacy, 1)),
            DualSenseDecodeResult::Snapshot {
                disposition: DualSenseDisposition::ApplyLegacy,
                snapshot: EffectiveMotorSnapshot {
                    large_motor: 0xAB,
                    small_motor: 0x12,
                    ..
                },
            }
        ));

        let mut v2 = [0u8; DUALSENSE_USB_OUTPUT_DATA_LEN];
        v2[0] = DUALSENSE_HAPTICS_SELECT_MASK;
        v2[2] = 0x56;
        v2[3] = 0xCD;
        v2[38] = DUALSENSE_COMPATIBLE_VIBRATION_V2_MASK;
        assert!(matches!(
            decoder.apply(dualsense_packet(&v2, 2)),
            DualSenseDecodeResult::Snapshot {
                disposition: DualSenseDisposition::ApplyV2,
                snapshot: EffectiveMotorSnapshot {
                    large_motor: 0xCD,
                    small_motor: 0x56,
                    ..
                },
            }
        ));
    }

    #[test]
    fn valid_zero_pairs_and_sdl_all_zero_are_explicit_stops() {
        let cases = [
            (
                DUALSENSE_COMPATIBLE_VIBRATION_MASK | DUALSENSE_HAPTICS_SELECT_MASK,
                0,
                DualSenseDisposition::StopLegacy,
            ),
            (
                DUALSENSE_HAPTICS_SELECT_MASK,
                DUALSENSE_COMPATIBLE_VIBRATION_V2_MASK,
                DualSenseDisposition::StopV2,
            ),
        ];
        for (valid0, valid2, expected) in cases {
            let mut decoder = DualSenseFeedbackDecoder::new(0xAA, 0x55);
            let mut data = [0u8; DUALSENSE_USB_OUTPUT_DATA_LEN];
            data[0] = valid0;
            data[38] = valid2;
            assert!(matches!(
                decoder.apply(dualsense_packet(&data, 4)),
                DualSenseDecodeResult::Snapshot {
                    disposition,
                    snapshot: EffectiveMotorSnapshot {
                        large_motor: 0,
                        small_motor: 0,
                        ..
                    },
                } if disposition == expected
            ));
        }

        let mut decoder = DualSenseFeedbackDecoder::new(0xAA, 0x55);
        let data = [0u8; DUALSENSE_USB_OUTPUT_DATA_LEN];
        assert!(matches!(
            decoder.apply(dualsense_packet(&data, 5)),
            DualSenseDecodeResult::Snapshot {
                disposition: DualSenseDisposition::StopAllZero,
                snapshot: EffectiveMotorSnapshot {
                    large_motor: 0,
                    small_motor: 0,
                    ..
                },
            }
        ));
    }

    #[test]
    fn partial_unrelated_and_conflicting_flags_preserve_complete_state() {
        let cases = [
            (0, 0, DualSenseDisposition::PreserveNoMotorValidity),
            (
                DUALSENSE_HAPTICS_SELECT_MASK,
                0,
                DualSenseDisposition::PreserveSelectorOnly,
            ),
            (
                DUALSENSE_COMPATIBLE_VIBRATION_MASK,
                0,
                DualSenseDisposition::PreserveMissingSelector,
            ),
            (
                0,
                DUALSENSE_COMPATIBLE_VIBRATION_V2_MASK,
                DualSenseDisposition::PreserveMissingSelector,
            ),
            (
                DUALSENSE_COMPATIBLE_VIBRATION_MASK | DUALSENSE_HAPTICS_SELECT_MASK,
                DUALSENSE_COMPATIBLE_VIBRATION_V2_MASK,
                DualSenseDisposition::PreserveConflictingVariants,
            ),
            (
                DUALSENSE_COMPATIBLE_VIBRATION_MASK,
                DUALSENSE_COMPATIBLE_VIBRATION_V2_MASK,
                DualSenseDisposition::PreserveConflictingVariants,
            ),
        ];
        for (valid0, valid2, expected) in cases {
            let mut decoder = DualSenseFeedbackDecoder::new(0x91, 0x27);
            let mut data = [0u8; DUALSENSE_USB_OUTPUT_DATA_LEN];
            data[0] = valid0;
            data[1] = 0x80;
            data[2] = 0xFF;
            data[3] = 0xFF;
            data[38] = valid2;
            assert!(matches!(
                decoder.apply(dualsense_packet(&data, 9)),
                DualSenseDecodeResult::Snapshot {
                    disposition,
                    snapshot: EffectiveMotorSnapshot {
                        large_motor: 0x91,
                        small_motor: 0x27,
                        source_seq_no: 9,
                    },
                } if disposition == expected
            ));
        }
    }

    #[test]
    fn wrong_envelopes_reject_before_indexing_and_do_not_change_state() {
        let data = [0u8; DUALSENSE_USB_OUTPUT_DATA_LEN];
        let mut decoder = DualSenseFeedbackDecoder::new(0x81, 0x18);
        assert_eq!(
            decoder.apply(RawDualSensePacket {
                source: OutputSource::XInput as u8,
                report_id: DUALSENSE_USB_OUTPUT_REPORT_ID,
                data: &data,
                seq_no: 1,
            }),
            DualSenseDecodeResult::Rejected(DualSenseRejectReason::Source)
        );
        assert_eq!(
            decoder.apply(RawDualSensePacket {
                source: HID_OUTPUT_SOURCE,
                report_id: 0x05,
                data: &data,
                seq_no: 2,
            }),
            DualSenseDecodeResult::Rejected(DualSenseRejectReason::ReportId)
        );
        assert_eq!(
            decoder.apply(RawDualSensePacket {
                source: HID_OUTPUT_SOURCE,
                report_id: DUALSENSE_USB_OUTPUT_REPORT_ID,
                data: &data[..46],
                seq_no: 3,
            }),
            DualSenseDecodeResult::Rejected(DualSenseRejectReason::Length)
        );
        assert_eq!(decoder.effective_motors(), (0x81, 0x18));
    }

    #[test]
    fn callback_memory_is_copied_into_the_effective_snapshot() {
        let mut callback_buffer = vec![0u8; DUALSENSE_USB_OUTPUT_DATA_LEN];
        callback_buffer[0] = DUALSENSE_COMPATIBLE_VIBRATION_MASK | DUALSENSE_HAPTICS_SELECT_MASK;
        callback_buffer[2] = 0x12;
        callback_buffer[3] = 0xAB;
        let mut decoder = DualSenseFeedbackDecoder::default();
        let result = decoder.apply(dualsense_packet(&callback_buffer, 7));
        callback_buffer.fill(0xFF);

        assert_eq!(decoder.effective_motors(), (0xAB, 0x12));
        assert!(matches!(
            result,
            DualSenseDecodeResult::Snapshot {
                snapshot: EffectiveMotorSnapshot {
                    large_motor: 0xAB,
                    small_motor: 0x12,
                    source_seq_no: 7,
                },
                ..
            }
        ));
    }

    #[test]
    fn motors_narrow_to_the_ksx_feedback_shape() {
        let m = Motors {
            large: 0xABCD,
            small: 0x1234,
            ..Motors::default()
        };
        assert_eq!(m.as_u8(), (0xAB, 0x12));
    }

    /// The Jedi Outcast bug: without a per-tick expiry sweep the last effect
    /// latches forever once the game stops sending packets.
    #[test]
    fn pid_effects_expire_on_the_tick_pass_not_on_the_next_packet() {
        let mut pool = PidEffects::<8>::new();
        assert!(pool.set(
            0,
            PidEffect {
                magnitude: 40_000,
                duration_ms: Some(200),
                elapsed_ms: 0,
                running: true,
            }
        ));
        // 199 ms of silence: still rumbling.
        assert_eq!(pool.apply_if_due(199), 40_000);
        // One more tick and it must stop by itself, with no packet involved.
        assert_eq!(pool.apply_if_due(1), 0);
        assert!(!pool.get(0).unwrap().running);
        // Repeated ticks stay at zero.
        assert_eq!(pool.apply_if_due(1000), 0);
    }

    #[test]
    fn an_infinite_pid_effect_survives_the_sweep_until_freed() {
        let mut pool = PidEffects::<4>::new();
        pool.set(
            1,
            PidEffect {
                magnitude: 1000,
                duration_ms: None,
                elapsed_ms: 0,
                running: true,
            },
        );
        assert_eq!(pool.apply_if_due(10_000), 1000);
        pool.free_all();
        assert_eq!(pool.apply_if_due(1), 0);
    }

    #[test]
    fn the_pool_reports_the_strongest_live_effect() {
        let mut pool = PidEffects::<4>::new();
        for (i, mag) in [100u16, 5000, 300].into_iter().enumerate() {
            pool.set(
                i,
                PidEffect {
                    magnitude: mag,
                    duration_ms: Some(50),
                    elapsed_ms: 0,
                    running: true,
                },
            );
        }
        assert_eq!(pool.apply_if_due(10), 5000);
        assert!(!pool.set(99, PidEffect::default()), "pool is fixed size");
    }
}
