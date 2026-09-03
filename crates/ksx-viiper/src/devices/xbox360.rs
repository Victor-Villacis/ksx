//! Xbox 360 pad: a field copy, because [`PadState`] *is* the XInput wire
//! shape and so is VIIPER's 20-byte input packet.
//!
//! Layout (little-endian): `u32 buttons`, `u8 lt`, `u8 rt`, `i16 lx`, `i16 ly`,
//! `i16 rx`, `i16 ry`, 6 reserved bytes. Button bits are XInput's
//! (`XINPUT_GAMEPAD_*`), which [`ksx_core::pad::XButtons`] already is.
//! Feedback is 2 bytes: left (low-frequency) and right (high-frequency)
//! motor. There is no LED / player-index byte on this lane — the XInput user
//! index has to be discovered by correlation, exactly as the ViGEm lane does.

use ksx_core::PadState;

/// Input packet size.
pub const INPUT_LEN: usize = 20;
/// Feedback packet size.
pub const FEEDBACK_LEN: usize = 2;

/// Encodes a pad state into the 20-byte input packet.
pub fn encode(state: &PadState) -> [u8; INPUT_LEN] {
    let mut out = [0_u8; INPUT_LEN];
    out[0..4].copy_from_slice(&u32::from(state.buttons.bits()).to_le_bytes());
    out[4] = state.lt;
    out[5] = state.rt;
    out[6..8].copy_from_slice(&state.lx.to_le_bytes());
    out[8..10].copy_from_slice(&state.ly.to_le_bytes());
    out[10..12].copy_from_slice(&state.rx.to_le_bytes());
    out[12..14].copy_from_slice(&state.ry.to_le_bytes());
    out
}

/// Rumble as the game asked for it.
#[derive(Clone, Copy, Debug, Default, Hash, PartialEq, Eq)]
pub struct Rumble {
    /// Low-frequency (left) motor, 0..=255.
    pub left: u8,
    /// High-frequency (right) motor, 0..=255.
    pub right: u8,
}

impl Rumble {
    /// Decodes one feedback packet; `None` if it is not exactly 2 bytes.
    pub fn decode(packet: &[u8]) -> Option<Self> {
        match packet {
            [left, right] => Some(Self {
                left: *left,
                right: *right,
            }),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ksx_core::pad::XButtons;

    #[test]
    fn neutral_is_all_zero() {
        assert_eq!(encode(&PadState::default()), [0_u8; 20]);
    }

    #[test]
    fn every_field_lands_on_its_documented_offset() {
        let state = PadState {
            buttons: XButtons::A | XButtons::DPAD_UP | XButtons::RIGHT_BUMPER,
            lt: 0x11,
            rt: 0xEE,
            lx: -32768,
            ly: 32767,
            rx: 0x0102,
            ry: -2,
        };
        let bytes = encode(&state);
        // 0x1000 | 0x0001 | 0x0200 = 0x1201, little-endian u32.
        assert_eq!(&bytes[0..4], &[0x01, 0x12, 0x00, 0x00]);
        assert_eq!(bytes[4], 0x11);
        assert_eq!(bytes[5], 0xEE);
        assert_eq!(&bytes[6..8], &[0x00, 0x80]);
        assert_eq!(&bytes[8..10], &[0xFF, 0x7F]);
        assert_eq!(&bytes[10..12], &[0x02, 0x01]);
        assert_eq!(&bytes[12..14], &[0xFE, 0xFF]);
        assert_eq!(&bytes[14..20], &[0; 6]);
    }

    #[test]
    fn button_bits_are_xinputs() {
        let bits = |b: XButtons| {
            u32::from_le_bytes(
                encode(&PadState {
                    buttons: b,
                    ..Default::default()
                })[0..4]
                    .try_into()
                    .unwrap(),
            )
        };
        assert_eq!(bits(XButtons::DPAD_UP), 0x0001);
        assert_eq!(bits(XButtons::DPAD_RIGHT), 0x0008);
        assert_eq!(bits(XButtons::START), 0x0010);
        assert_eq!(bits(XButtons::BACK), 0x0020);
        assert_eq!(bits(XButtons::LEFT_THUMB), 0x0040);
        assert_eq!(bits(XButtons::RIGHT_THUMB), 0x0080);
        assert_eq!(bits(XButtons::LEFT_BUMPER), 0x0100);
        assert_eq!(bits(XButtons::RIGHT_BUMPER), 0x0200);
        assert_eq!(bits(XButtons::GUIDE), 0x0400);
        assert_eq!(bits(XButtons::A), 0x1000);
        assert_eq!(bits(XButtons::B), 0x2000);
        assert_eq!(bits(XButtons::X), 0x4000);
        assert_eq!(bits(XButtons::Y), 0x8000);
    }

    #[test]
    fn rumble_decodes_two_bytes_only() {
        assert_eq!(
            Rumble::decode(&[0x40, 0xFF]),
            Some(Rumble {
                left: 0x40,
                right: 0xFF
            })
        );
        assert_eq!(Rumble::decode(&[]), None);
        assert_eq!(Rumble::decode(&[1, 2, 3]), None);
    }
}
