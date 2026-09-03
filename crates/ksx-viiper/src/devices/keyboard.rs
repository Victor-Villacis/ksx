//! HID keyboard: the typed device-specific state E1.1 step 3 asks for.
//!
//! Wire input (variable length): `u8 modifiers`, `u8 count`, then `count`
//! HID keyboard-page usage ids for the non-modifier keys held. The server
//! keeps the N-key-rollover bitmap itself; the 32-byte bitmap in libVIIPER is
//! its in-process struct and never crosses the TCP wire. Feedback is one byte
//! of LED state.
//!
//! [`KeyboardState`] is the whole held-key set, so every packet is the full
//! state — a lost packet is corrected by the next one, and "release
//! everything" is one packet, which is what every ksx exit path needs.

use std::collections::BTreeSet;

/// Feedback packet size.
pub const FEEDBACK_LEN: usize = 1;

/// The most non-modifier keys one packet carries. The count byte allows 255;
/// no keyboard reports more than a few dozen and the server's own limit is
/// unmeasured (row M-NKRO), so the cap is conservative and the excess is
/// dropped in ascending-usage order rather than sent.
pub const MAX_KEYS: usize = 32;

/// Modifier bits of the `modifiers` byte (USB HID boot-protocol order).
pub mod modifier {
    pub const LEFT_CTRL: u8 = 0x01;
    pub const LEFT_SHIFT: u8 = 0x02;
    pub const LEFT_ALT: u8 = 0x04;
    pub const LEFT_GUI: u8 = 0x08;
    pub const RIGHT_CTRL: u8 = 0x10;
    pub const RIGHT_SHIFT: u8 = 0x20;
    pub const RIGHT_ALT: u8 = 0x40;
    pub const RIGHT_GUI: u8 = 0x80;
}

/// One thing a keyboard can hold: a modifier bit or a usage id.
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq, PartialOrd, Ord)]
pub enum Usage {
    /// One of the [`modifier`] bits.
    Modifier(u8),
    /// A keyboard-page usage id (`0x04` = `a` … `0x65` = Application).
    Key(u8),
}

/// The complete held-key state.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeyboardState {
    modifiers: u8,
    keys: BTreeSet<u8>,
}

impl KeyboardState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn modifiers(&self) -> u8 {
        self.modifiers
    }

    /// Held non-modifier usages, ascending.
    pub fn keys(&self) -> impl Iterator<Item = u8> + '_ {
        self.keys.iter().copied()
    }

    pub fn is_neutral(&self) -> bool {
        self.modifiers == 0 && self.keys.is_empty()
    }

    /// Returns whether the state changed.
    pub fn press(&mut self, usage: Usage) -> bool {
        match usage {
            Usage::Modifier(bit) => {
                let before = self.modifiers;
                self.modifiers |= bit;
                before != self.modifiers
            }
            Usage::Key(id) => self.keys.insert(id),
        }
    }

    /// Returns whether the state changed.
    pub fn release(&mut self, usage: Usage) -> bool {
        match usage {
            Usage::Modifier(bit) => {
                let before = self.modifiers;
                self.modifiers &= !bit;
                before != self.modifiers
            }
            Usage::Key(id) => self.keys.remove(&id),
        }
    }

    /// Releases everything. Returns whether anything was held.
    pub fn release_all(&mut self) -> bool {
        let held = !self.is_neutral();
        self.modifiers = 0;
        self.keys.clear();
        held
    }

    /// Appends the input packet for this state to `out`.
    pub fn encode_into(&self, out: &mut Vec<u8>) {
        let count = self.keys.len().min(MAX_KEYS);
        out.reserve(2 + count);
        out.push(self.modifiers);
        out.push(count as u8);
        out.extend(self.keys.iter().take(count));
    }

    /// The input packet for this state.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        self.encode_into(&mut out);
        out
    }

    /// The packet that releases everything: `[0, 0]`.
    pub const NEUTRAL_PACKET: [u8; 2] = [0, 0];
}

/// LED state pushed by the host.
#[derive(Clone, Copy, Debug, Default, Hash, PartialEq, Eq)]
pub struct Leds {
    pub num_lock: bool,
    pub caps_lock: bool,
    pub scroll_lock: bool,
    pub compose: bool,
    pub kana: bool,
}

impl Leds {
    pub const NUM_LOCK: u8 = 0x01;
    pub const CAPS_LOCK: u8 = 0x02;
    pub const SCROLL_LOCK: u8 = 0x04;
    pub const COMPOSE: u8 = 0x08;
    pub const KANA: u8 = 0x10;

    pub fn decode(packet: &[u8]) -> Option<Self> {
        match packet {
            [bits] => Some(Self::from_bits(*bits)),
            _ => None,
        }
    }

    pub fn from_bits(bits: u8) -> Self {
        Self {
            num_lock: bits & Self::NUM_LOCK != 0,
            caps_lock: bits & Self::CAPS_LOCK != 0,
            scroll_lock: bits & Self::SCROLL_LOCK != 0,
            compose: bits & Self::COMPOSE != 0,
            kana: bits & Self::KANA != 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neutral_is_two_zero_bytes() {
        assert_eq!(KeyboardState::new().encode(), vec![0, 0]);
        assert_eq!(KeyboardState::NEUTRAL_PACKET, [0, 0]);
    }

    #[test]
    fn packet_is_modifiers_count_then_usages_ascending() {
        let mut state = KeyboardState::new();
        assert!(state.press(Usage::Key(0x16))); // s
        assert!(state.press(Usage::Key(0x04))); // a
        assert!(state.press(Usage::Modifier(modifier::LEFT_SHIFT)));
        assert!(!state.press(Usage::Key(0x04)), "already held");
        assert_eq!(state.encode(), vec![0x02, 2, 0x04, 0x16]);
        assert!(state.release(Usage::Key(0x16)));
        assert!(!state.release(Usage::Key(0x16)), "already released");
        assert_eq!(state.encode(), vec![0x02, 1, 0x04]);
        assert!(state.release_all());
        assert!(!state.release_all());
        assert_eq!(state.encode(), vec![0, 0]);
    }

    #[test]
    fn the_count_byte_always_matches_the_usages_sent() {
        let mut state = KeyboardState::new();
        for id in 4..(4 + MAX_KEYS as u8 + 10) {
            state.press(Usage::Key(id));
        }
        let packet = state.encode();
        assert_eq!(packet[1] as usize, MAX_KEYS);
        assert_eq!(packet.len(), 2 + MAX_KEYS);
        assert_eq!(packet[2], 4, "lowest usages win when capped");
    }

    #[test]
    fn leds_decode_one_byte() {
        let leds = Leds::decode(&[Leds::CAPS_LOCK | Leds::NUM_LOCK]).unwrap();
        assert!(leds.caps_lock && leds.num_lock);
        assert!(!leds.scroll_lock && !leds.compose && !leds.kana);
        assert_eq!(Leds::decode(&[]), None);
        assert_eq!(Leds::decode(&[1, 2]), None);
    }
}
