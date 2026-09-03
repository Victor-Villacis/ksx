//! `ksx_core::Key` → USB HID keyboard-page usage.
//!
//! `Key` values 0..=93 are set-1 make scancodes and the higher ones are ksx's
//! post-correction logical ids (`crates/ksx-core/src/key.rs`). This table
//! maps each to the usage a real USB keyboard would send for the same cap,
//! per the USB HID Usage Tables (keyboard/keypad page 0x07). Modifiers map to
//! their bit in the modifier byte instead of a usage id.
//!
//! Deliberately unmapped, and pinned as such by the exhaustiveness test:
//!
//! - **Media and volume keys** live on the Consumer page (0x0C), which
//!   VIIPER's keyboard does not expose. Mapping them to keyboard-page ids
//!   would type the wrong thing; `None` is honest.
//! - **Mouse pseudo-keys** (`20001..=20013`) are input vocabulary, not keys.
//! - **`ShiftModifier`** is a logical marker ksx's capture layer produces, not
//!   a cap.
//! - **The OEM keys** (`Oem0`–`Oem16`) have no stable meaning across layouts.
//! - **`None` / `Unknown`**.

use ksx_core::Key;

use crate::devices::keyboard::{modifier, Usage};

/// The HID usage for `key`, or `None` when the key has no keyboard-page form.
pub const fn usage_of(key: Key) -> Option<Usage> {
    use Usage::{Key as K, Modifier as M};
    Some(match key {
        Key::Escape => K(0x29),
        Key::One => K(0x1E),
        Key::Two => K(0x1F),
        Key::Three => K(0x20),
        Key::Four => K(0x21),
        Key::Five => K(0x22),
        Key::Six => K(0x23),
        Key::Seven => K(0x24),
        Key::Eight => K(0x25),
        Key::Nine => K(0x26),
        Key::Zero => K(0x27),
        Key::DashUnderscore => K(0x2D),
        Key::PlusEquals => K(0x2E),
        Key::Backspace => K(0x2A),
        Key::Tab => K(0x2B),
        Key::Q => K(0x14),
        Key::W => K(0x1A),
        Key::E => K(0x08),
        Key::R => K(0x15),
        Key::T => K(0x17),
        Key::Y => K(0x1C),
        Key::U => K(0x18),
        Key::I => K(0x0C),
        Key::O => K(0x12),
        Key::P => K(0x13),
        Key::OpenBracketBrace => K(0x2F),
        Key::CloseBracketBrace => K(0x30),
        Key::Enter => K(0x28),
        Key::LeftControl => M(modifier::LEFT_CTRL),
        Key::A => K(0x04),
        Key::S => K(0x16),
        Key::D => K(0x07),
        Key::F => K(0x09),
        Key::G => K(0x0A),
        Key::H => K(0x0B),
        Key::J => K(0x0D),
        Key::K => K(0x0E),
        Key::L => K(0x0F),
        Key::SemicolonColon => K(0x33),
        Key::SingleDoubleQuote => K(0x34),
        Key::Tilde => K(0x35),
        Key::LeftShift => M(modifier::LEFT_SHIFT),
        Key::BackslashPipe => K(0x31),
        Key::Z => K(0x1D),
        Key::X => K(0x1B),
        Key::C => K(0x06),
        Key::V => K(0x19),
        Key::B => K(0x05),
        Key::N => K(0x11),
        Key::M => K(0x10),
        Key::CommaLeftArrow => K(0x36),
        Key::PeriodRightArrow => K(0x37),
        Key::ForwardSlashQuestionMark => K(0x38),
        Key::RightShift => M(modifier::RIGHT_SHIFT),
        Key::NumpadAsterisk => K(0x55),
        Key::LeftAlt => M(modifier::LEFT_ALT),
        Key::Space => K(0x2C),
        Key::CapsLock => K(0x39),
        Key::F1 => K(0x3A),
        Key::F2 => K(0x3B),
        Key::F3 => K(0x3C),
        Key::F4 => K(0x3D),
        Key::F5 => K(0x3E),
        Key::F6 => K(0x3F),
        Key::F7 => K(0x40),
        Key::F8 => K(0x41),
        Key::F9 => K(0x42),
        Key::F10 => K(0x43),
        Key::NumLock => K(0x53),
        Key::ScrollLock => K(0x47),
        Key::Numpad7 => K(0x5F),
        Key::Numpad8 => K(0x60),
        Key::Numpad9 => K(0x61),
        Key::NumpadMinus => K(0x56),
        Key::Numpad4 => K(0x5C),
        Key::Numpad5 => K(0x5D),
        Key::Numpad6 => K(0x5E),
        Key::NumpadPlus => K(0x57),
        Key::Numpad1 => K(0x59),
        Key::Numpad2 => K(0x5A),
        Key::Numpad3 => K(0x5B),
        Key::Numpad0 => K(0x62),
        Key::NumpadDelete => K(0x63),
        Key::LeftBackslashPipe => K(0x64),
        Key::F11 => K(0x44),
        Key::F12 => K(0x45),
        Key::LeftWindows => M(modifier::LEFT_GUI),
        Key::RightWindows => M(modifier::RIGHT_GUI),
        Key::Menu => K(0x65),
        Key::Up => K(0x52),
        Key::Down => K(0x51),
        Key::Left => K(0x50),
        Key::Right => K(0x4F),
        Key::Home => K(0x4A),
        Key::PageUp => K(0x4B),
        Key::End => K(0x4D),
        Key::PageDown => K(0x4E),
        Key::Insert => K(0x49),
        Key::Delete => K(0x4C),
        Key::RightControl => M(modifier::RIGHT_CTRL),
        Key::RightAlt => M(modifier::RIGHT_ALT),
        Key::NumpadDivide => K(0x54),
        Key::PrintScreen => K(0x46),
        Key::Break => K(0x48),
        Key::Pause => K(0x48),
        Key::NumpadEnter => K(0x58),
        Key::None
        | Key::Unknown
        | Key::Oem0
        | Key::Oem2
        | Key::Oem3
        | Key::Oem4
        | Key::Oem5
        | Key::Oem6
        | Key::Oem7
        | Key::Oem13
        | Key::Oem16
        | Key::ShiftModifier
        | Key::MediaPreviousTrack
        | Key::MediaPlayPause
        | Key::MediaNextTrack
        | Key::VolumeUp
        | Key::VolumeDown
        | Key::VolumeMute
        | Key::MouseLeftButton
        | Key::MouseRightButton
        | Key::MouseMiddleButton
        | Key::MouseExtraLeft
        | Key::MouseExtraRight
        | Key::MouseWheelUp
        | Key::MouseWheelDown
        | Key::MouseWheelLeft
        | Key::MouseWheelRight
        | Key::MouseMoveLeft
        | Key::MouseMoveRight
        | Key::MouseMoveUp
        | Key::MouseMoveDown => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// Every key ksx knows is either mapped or explicitly in this list. A new
    /// `Key` variant fails to compile in `usage_of` (the match is exhaustive)
    /// and this test says which side it must join.
    const UNMAPPED: &[Key] = &[
        Key::None,
        Key::Unknown,
        Key::Oem0,
        Key::Oem2,
        Key::Oem3,
        Key::Oem4,
        Key::Oem5,
        Key::Oem6,
        Key::Oem7,
        Key::Oem13,
        Key::Oem16,
        Key::ShiftModifier,
        Key::MediaPreviousTrack,
        Key::MediaPlayPause,
        Key::MediaNextTrack,
        Key::VolumeUp,
        Key::VolumeDown,
        Key::VolumeMute,
        Key::MouseLeftButton,
        Key::MouseRightButton,
        Key::MouseMiddleButton,
        Key::MouseExtraLeft,
        Key::MouseExtraRight,
        Key::MouseWheelUp,
        Key::MouseWheelDown,
        Key::MouseWheelLeft,
        Key::MouseWheelRight,
        Key::MouseMoveLeft,
        Key::MouseMoveRight,
        Key::MouseMoveUp,
        Key::MouseMoveDown,
    ];

    #[test]
    fn every_key_is_mapped_or_deliberately_not() {
        for key in Key::ALL {
            let mapped = usage_of(*key).is_some();
            let listed = UNMAPPED.contains(key);
            assert!(
                mapped != listed,
                "{key:?}: mapped={mapped} listed_unmapped={listed} — one and only one"
            );
        }
    }

    #[test]
    fn no_two_caps_share_a_usage_except_break_and_pause() {
        let mut seen: BTreeMap<Usage, Key> = BTreeMap::new();
        for key in Key::ALL {
            let Some(usage) = usage_of(*key) else {
                continue;
            };
            if let Some(previous) = seen.insert(usage, *key) {
                assert!(
                    matches!((previous, key), (Key::Break, Key::Pause)),
                    "{previous:?} and {key:?} both map to {usage:?}"
                );
            }
        }
    }

    #[test]
    fn usages_stay_on_the_keyboard_page() {
        for key in Key::ALL {
            match usage_of(*key) {
                Some(Usage::Key(id)) => assert!((0x04..=0x65).contains(&id), "{key:?} → {id:#x}"),
                Some(Usage::Modifier(bit)) => assert_eq!(bit.count_ones(), 1, "{key:?}"),
                None => {}
            }
        }
    }

    #[test]
    fn spot_checks_against_the_hid_usage_table() {
        assert_eq!(usage_of(Key::A), Some(Usage::Key(0x04)));
        assert_eq!(usage_of(Key::Z), Some(Usage::Key(0x1D)));
        assert_eq!(usage_of(Key::One), Some(Usage::Key(0x1E)));
        assert_eq!(usage_of(Key::Zero), Some(Usage::Key(0x27)));
        assert_eq!(usage_of(Key::Enter), Some(Usage::Key(0x28)));
        assert_eq!(usage_of(Key::Escape), Some(Usage::Key(0x29)));
        assert_eq!(usage_of(Key::Space), Some(Usage::Key(0x2C)));
        assert_eq!(usage_of(Key::F12), Some(Usage::Key(0x45)));
        assert_eq!(usage_of(Key::Right), Some(Usage::Key(0x4F)));
        assert_eq!(usage_of(Key::Numpad0), Some(Usage::Key(0x62)));
        assert_eq!(usage_of(Key::LeftControl), Some(Usage::Modifier(0x01)));
        assert_eq!(usage_of(Key::RightWindows), Some(Usage::Modifier(0x80)));
        assert_eq!(usage_of(Key::VolumeUp), None);
        assert_eq!(usage_of(Key::MouseLeftButton), None);
    }
}
