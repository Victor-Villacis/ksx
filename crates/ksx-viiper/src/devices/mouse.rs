//! HID mouse: the 9-byte input packet. Motion and wheel deltas are consumed
//! per report; button bits persist until changed. No feedback.

/// Input packet size.
pub const INPUT_LEN: usize = 9;

/// Button bits.
pub mod button {
    pub const LEFT: u8 = 0x01;
    pub const RIGHT: u8 = 0x02;
    pub const MIDDLE: u8 = 0x04;
    pub const BACK: u8 = 0x08;
    pub const FORWARD: u8 = 0x10;
}

/// One mouse report.
#[derive(Clone, Copy, Debug, Default, Hash, PartialEq, Eq)]
pub struct MouseReport {
    pub buttons: u8,
    pub dx: i16,
    pub dy: i16,
    /// Vertical wheel, positive = up.
    pub wheel: i16,
    /// Horizontal wheel, positive = right.
    pub pan: i16,
}

impl MouseReport {
    pub fn encode(&self) -> [u8; INPUT_LEN] {
        let mut out = [0_u8; INPUT_LEN];
        out[0] = self.buttons;
        out[1..3].copy_from_slice(&self.dx.to_le_bytes());
        out[3..5].copy_from_slice(&self.dy.to_le_bytes());
        out[5..7].copy_from_slice(&self.wheel.to_le_bytes());
        out[7..9].copy_from_slice(&self.pan.to_le_bytes());
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_is_buttons_then_four_le_i16() {
        let report = MouseReport {
            buttons: button::LEFT | button::FORWARD,
            dx: -1,
            dy: 256,
            wheel: 1,
            pan: -256,
        };
        assert_eq!(
            report.encode(),
            [0x11, 0xFF, 0xFF, 0x00, 0x01, 0x01, 0x00, 0x00, 0xFF]
        );
        assert_eq!(MouseReport::default().encode(), [0; 9]);
    }
}
