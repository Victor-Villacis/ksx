//! DualShock 4: `PadState` → VIIPER's 31-byte input packet.
//!
//! This is VIIPER's own model, not the HID report ViGEmBus takes
//! (`ksx-output/src/ds4.rs`): sticks are signed bytes centred on 0, the D-pad
//! is four independent bits (the server builds the hat), and the touchpad and
//! IMU ride along. Layout (little-endian, from the generated
//! `Dualshock4Input`): `i8 lx, ly, rx, ry`, `u16 buttons`, `u8 dpad`,
//! `u8 l2, r2`, `u16 touch1x, touch1y, u8 touch1_active`, `u16 touch2x,
//! touch2y, u8 touch2_active`, `i16 gyro x, y, z`, `i16 accel x, y, z`.
//!
//! Two of ksx's persona rules carry over from the ViGEm DS4 mapper and are
//! stated here rather than buried:
//!
//! 1. **Opposing D-pad pairs cancel.** ksx's aggregation can hold Up+Down; the
//!    packet could carry both bits, but the hat the server derives cannot, and
//!    "stand still" is the safer resolution than an arbitrary winner. Same
//!    rule as `ds4.rs::dpad_hat`, so a preset behaves identically on either
//!    DS4 lane.
//! 2. **Triggers are analog and digital.** L2/R2 bits are set alongside the
//!    analog value above XInput's trigger threshold.
//!
//! One OPEN measurement: the sign of the Y axes. XInput is up-positive; a DS4
//! HID report is down-positive, and VIIPER's `stick_ly` is documented only as
//! "center at 0". This encoder inverts Y like the HID report does (the server
//! most plausibly maps `int8 + 128` straight onto the HID byte); row M-DS4AXIS
//! in `docs/research/viiper-2026.md` confirms or flips it, and
//! [`Y_AXIS_INVERTED`] is the single constant that changes.

use ksx_core::pad::XButtons;
use ksx_core::PadState;

/// Input packet size.
pub const INPUT_LEN: usize = 31;
/// Feedback packet size.
pub const FEEDBACK_LEN: usize = 7;

/// See the module docs: pending M-DS4AXIS.
pub const Y_AXIS_INVERTED: bool = true;

/// XInput's `XINPUT_GAMEPAD_TRIGGER_THRESHOLD`, the point at which the
/// digital L2/R2 bits join the analog value.
const TRIGGER_THRESHOLD: u8 = 30;

/// `buttons` bits (from the generated `viiper-client` constants).
pub mod button {
    pub const PS: u16 = 1 << 0;
    pub const TOUCHPAD_CLICK: u16 = 1 << 1;
    pub const SQUARE: u16 = 1 << 4;
    pub const CROSS: u16 = 1 << 5;
    pub const CIRCLE: u16 = 1 << 6;
    pub const TRIANGLE: u16 = 1 << 7;
    pub const L1: u16 = 1 << 8;
    pub const R1: u16 = 1 << 9;
    pub const L2: u16 = 1 << 10;
    pub const R2: u16 = 1 << 11;
    pub const SHARE: u16 = 1 << 12;
    pub const OPTIONS: u16 = 1 << 13;
    pub const L3: u16 = 1 << 14;
    pub const R3: u16 = 1 << 15;
}

/// `dpad` bits.
pub mod dpad {
    pub const UP: u8 = 0x01;
    pub const DOWN: u8 = 0x02;
    pub const LEFT: u8 = 0x04;
    pub const RIGHT: u8 = 0x08;
}

/// The accelerometer a controller lying flat reports (`-9.81 m/s²` at the
/// documented 512 counts per m/s²); VIIPER's own default.
pub const ACCEL_Z_FLAT: i16 = -5023;

/// Rescales a signed 16-bit XInput axis to a signed byte.
fn axis(v: i16) -> i8 {
    (v >> 8) as i8
}

fn dpad_bits(buttons: XButtons) -> u8 {
    let up = buttons.contains(XButtons::DPAD_UP);
    let down = buttons.contains(XButtons::DPAD_DOWN);
    let left = buttons.contains(XButtons::DPAD_LEFT);
    let right = buttons.contains(XButtons::DPAD_RIGHT);
    let mut bits = 0;
    if up && !down {
        bits |= dpad::UP;
    }
    if down && !up {
        bits |= dpad::DOWN;
    }
    if left && !right {
        bits |= dpad::LEFT;
    }
    if right && !left {
        bits |= dpad::RIGHT;
    }
    bits
}

fn button_bits(state: &PadState) -> u16 {
    let b = state.buttons;
    let mut bits = 0;
    let mut set = |flag: XButtons, bit: u16| {
        if b.contains(flag) {
            bits |= bit;
        }
    };
    set(XButtons::A, button::CROSS);
    set(XButtons::B, button::CIRCLE);
    set(XButtons::X, button::SQUARE);
    set(XButtons::Y, button::TRIANGLE);
    set(XButtons::LEFT_BUMPER, button::L1);
    set(XButtons::RIGHT_BUMPER, button::R1);
    set(XButtons::BACK, button::SHARE);
    set(XButtons::START, button::OPTIONS);
    set(XButtons::LEFT_THUMB, button::L3);
    set(XButtons::RIGHT_THUMB, button::R3);
    set(XButtons::GUIDE, button::PS);
    if state.lt > TRIGGER_THRESHOLD {
        bits |= button::L2;
    }
    if state.rt > TRIGGER_THRESHOLD {
        bits |= button::R2;
    }
    bits
}

/// Encodes a pad state into the 31-byte input packet.
pub fn encode(state: &PadState) -> [u8; INPUT_LEN] {
    let y = |v: i16| {
        if Y_AXIS_INVERTED {
            axis(v.saturating_neg())
        } else {
            axis(v)
        }
    };
    let mut out = [0_u8; INPUT_LEN];
    out[0] = axis(state.lx) as u8;
    out[1] = y(state.ly) as u8;
    out[2] = axis(state.rx) as u8;
    out[3] = y(state.ry) as u8;
    out[4..6].copy_from_slice(&button_bits(state).to_le_bytes());
    out[6] = dpad_bits(state.buttons);
    out[7] = state.lt;
    out[8] = state.rt;
    // touch1 (9..14) and touch2 (14..19): inactive, zero.
    // gyro (19..25): zero.
    // accel (25..31): flat on a table.
    out[29..31].copy_from_slice(&ACCEL_Z_FLAT.to_le_bytes());
    out
}

/// The 7-byte feedback packet: rumble, lightbar colour and flash timing.
#[derive(Clone, Copy, Debug, Default, Hash, PartialEq, Eq)]
pub struct Feedback {
    pub rumble_small: u8,
    pub rumble_large: u8,
    pub led_red: u8,
    pub led_green: u8,
    pub led_blue: u8,
    /// Flash on-time in 2.5 ms units.
    pub flash_on: u8,
    /// Flash off-time in 2.5 ms units.
    pub flash_off: u8,
}

impl Feedback {
    pub fn decode(packet: &[u8]) -> Option<Self> {
        match packet {
            [small, large, r, g, b, on, off] => Some(Self {
                rumble_small: *small,
                rumble_large: *large,
                led_red: *r,
                led_green: *g,
                led_blue: *b,
                flash_on: *on,
                flash_off: *off,
            }),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neutral_packet_is_flat_on_a_table() {
        let bytes = encode(&PadState::default());
        assert_eq!(bytes.len(), 31);
        assert_eq!(&bytes[0..4], &[0, 0, 0, 0]);
        assert_eq!(&bytes[4..9], &[0, 0, 0, 0, 0]);
        assert_eq!(&bytes[9..29], &[0; 20]);
        assert_eq!(&bytes[29..31], &(-5023_i16).to_le_bytes());
    }

    #[test]
    fn face_buttons_map_to_the_playstation_bits() {
        let state = PadState {
            buttons: XButtons::A | XButtons::Y | XButtons::START | XButtons::GUIDE,
            ..Default::default()
        };
        let bits = u16::from_le_bytes(encode(&state)[4..6].try_into().unwrap());
        assert_eq!(
            bits,
            button::CROSS | button::TRIANGLE | button::OPTIONS | button::PS
        );
    }

    #[test]
    fn triggers_are_analog_and_digital() {
        let light = PadState {
            lt: TRIGGER_THRESHOLD,
            ..Default::default()
        };
        let full = PadState {
            lt: 255,
            rt: 200,
            ..Default::default()
        };
        assert_eq!(encode(&light)[7], TRIGGER_THRESHOLD);
        assert_eq!(
            u16::from_le_bytes(encode(&light)[4..6].try_into().unwrap()) & button::L2,
            0
        );
        let bits = u16::from_le_bytes(encode(&full)[4..6].try_into().unwrap());
        assert_eq!(bits, button::L2 | button::R2);
        assert_eq!(encode(&full)[7], 255);
        assert_eq!(encode(&full)[8], 200);
    }

    #[test]
    fn opposing_dpad_pairs_cancel() {
        let both = PadState {
            buttons: XButtons::DPAD_UP | XButtons::DPAD_DOWN | XButtons::DPAD_LEFT,
            ..Default::default()
        };
        assert_eq!(encode(&both)[6], dpad::LEFT);
        let diagonal = PadState {
            buttons: XButtons::DPAD_UP | XButtons::DPAD_RIGHT,
            ..Default::default()
        };
        assert_eq!(encode(&diagonal)[6], dpad::UP | dpad::RIGHT);
    }

    #[test]
    fn sticks_scale_to_signed_bytes_with_y_inverted() {
        let state = PadState {
            lx: 32767,
            ly: 32767,
            rx: -32768,
            ry: -32768,
            ..Default::default()
        };
        let bytes = encode(&state);
        assert_eq!(bytes[0] as i8, 127);
        assert_eq!(
            bytes[1] as i8, -128,
            "up on XInput is negative on the HID axis"
        );
        assert_eq!(bytes[2] as i8, -128);
        assert_eq!(bytes[3] as i8, 127);
        assert_eq!(encode(&PadState::default())[1], 0, "centre stays centre");
    }

    #[test]
    fn feedback_decodes_seven_bytes_only() {
        let fb = Feedback::decode(&[1, 2, 3, 4, 5, 6, 7]).unwrap();
        assert_eq!(fb.rumble_small, 1);
        assert_eq!(fb.rumble_large, 2);
        assert_eq!((fb.led_red, fb.led_green, fb.led_blue), (3, 4, 5));
        assert_eq!((fb.flash_on, fb.flash_off), (6, 7));
        assert_eq!(Feedback::decode(&[1, 2]), None);
    }
}
