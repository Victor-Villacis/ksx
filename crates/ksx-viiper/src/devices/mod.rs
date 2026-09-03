//! Byte-exact report codecs, one module per device kind.
//!
//! Every layout is transcribed from the VIIPER 0.7.0 documentation and the
//! generated `viiper-client` source, then pinned by a test with the literal
//! bytes. Little-endian throughout; input reports are fixed size except the
//! keyboard's, which carries its own key count.

pub mod dualshock4;
pub mod keyboard;
pub mod mouse;
pub mod xbox360;

/// The device types `bus/{b}/add` accepts.
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq, PartialOrd, Ord)]
pub enum DeviceKind {
    /// Xbox 360 wired pad (VID 045E / PID 028E, `subType` 1 by default).
    Xbox360,
    /// DualShock 4 (VID 054C / PID 09CC).
    DualShock4,
    /// DualSense / DualSense Edge (`dualsense` / `dualsenseedge`).
    DualSense,
    /// Nintendo Switch 2 Pro Controller.
    Ns2Pro,
    /// N-key-rollover HID keyboard (VID 2E8A / PID 0010 by default).
    Keyboard,
    /// Five-button HID mouse with two wheels.
    Mouse,
}

impl DeviceKind {
    pub const ALL: &'static [DeviceKind] = &[
        DeviceKind::Xbox360,
        DeviceKind::DualShock4,
        DeviceKind::DualSense,
        DeviceKind::Ns2Pro,
        DeviceKind::Keyboard,
        DeviceKind::Mouse,
    ];

    /// The `type` string on the wire.
    pub const fn type_name(self) -> &'static str {
        match self {
            DeviceKind::Xbox360 => "xbox360",
            DeviceKind::DualShock4 => "dualshock4",
            DeviceKind::DualSense => "dualsense",
            DeviceKind::Ns2Pro => "ns2pro",
            DeviceKind::Keyboard => "keyboard",
            DeviceKind::Mouse => "mouse",
        }
    }

    /// Parses a `type` string as the server prints it (`dualsenseedge` maps
    /// to [`DeviceKind::DualSense`] — same wire model).
    pub fn from_type_name(name: &str) -> Option<Self> {
        Some(match name {
            "xbox360" => DeviceKind::Xbox360,
            "dualshock4" => DeviceKind::DualShock4,
            "dualsense" | "dualsenseedge" => DeviceKind::DualSense,
            "ns2pro" => DeviceKind::Ns2Pro,
            "keyboard" => DeviceKind::Keyboard,
            "mouse" => DeviceKind::Mouse,
            _ => return None,
        })
    }

    /// Fixed input report size, or `None` for the variable-length keyboard.
    pub const fn input_len(self) -> Option<usize> {
        match self {
            DeviceKind::Xbox360 => Some(xbox360::INPUT_LEN),
            DeviceKind::DualShock4 => Some(dualshock4::INPUT_LEN),
            DeviceKind::DualSense => Some(33),
            DeviceKind::Ns2Pro => Some(27),
            DeviceKind::Keyboard => None,
            DeviceKind::Mouse => Some(mouse::INPUT_LEN),
        }
    }

    /// Fixed feedback packet size (`0` = the kind sends none).
    pub const fn feedback_len(self) -> usize {
        match self {
            DeviceKind::Xbox360 => xbox360::FEEDBACK_LEN,
            DeviceKind::DualShock4 => dualshock4::FEEDBACK_LEN,
            DeviceKind::DualSense => 6,
            DeviceKind::Ns2Pro => 34,
            DeviceKind::Keyboard => keyboard::FEEDBACK_LEN,
            DeviceKind::Mouse => 0,
        }
    }

    /// Stream options for this kind.
    pub const fn stream_options(self) -> crate::stream::StreamOptions {
        crate::stream::StreamOptions::for_feedback_len(self.feedback_len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn type_names_round_trip() {
        for kind in DeviceKind::ALL {
            assert_eq!(DeviceKind::from_type_name(kind.type_name()), Some(*kind));
        }
        assert_eq!(
            DeviceKind::from_type_name("dualsenseedge"),
            Some(DeviceKind::DualSense)
        );
        assert_eq!(DeviceKind::from_type_name("gamecube"), None);
    }

    #[test]
    fn sizes_match_the_documented_layouts() {
        assert_eq!(DeviceKind::Xbox360.input_len(), Some(20));
        assert_eq!(DeviceKind::Xbox360.feedback_len(), 2);
        assert_eq!(DeviceKind::DualShock4.input_len(), Some(31));
        assert_eq!(DeviceKind::DualShock4.feedback_len(), 7);
        assert_eq!(DeviceKind::Keyboard.input_len(), None);
        assert_eq!(DeviceKind::Keyboard.feedback_len(), 1);
        assert_eq!(DeviceKind::Mouse.input_len(), Some(9));
        assert_eq!(DeviceKind::Mouse.feedback_len(), 0);
        assert_eq!(DeviceKind::DualSense.input_len(), Some(33));
        assert_eq!(DeviceKind::Ns2Pro.feedback_len(), 34);
    }
}
