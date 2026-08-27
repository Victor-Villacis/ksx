//! The single canonical KSX key vocabulary.
//!
//! Names and numeric values are contractual: native preset TOML stores these
//! exact spellings (`Eight`, `BackslashPipe`, `CommaLeftArrow`, ...) and parses
//! them back via [`Key::from_name`]. Values 0..=93 are set-1 make
//! scancodes; higher values are logical ids the capture layer produces after
//! applying KSX's E0/E1 correction table — e.g. an E0-extended Numpad4
//! stroke arrives here as `Key::Left` (5003), never as raw scancode 75 plus a
//! flag. Mouse pseudo-keys (20001..=20013) are defined now so mouse support can
//! land later without a breaking change.
//!
//! There is exactly one key type. Duplicate discriminants are a compile error,
//! and the exhaustive tests keep both spellings and values unique.

macro_rules! keys {
    ($($name:ident = $value:literal),+ $(,)?) => {
        /// Post-correction logical key id. See module docs.
        #[repr(u16)]
        #[derive(Clone, Copy, Debug, Hash, PartialEq, Eq, PartialOrd, Ord)]
        pub enum Key {
            $($name = $value,)+
        }

        impl Key {
            /// Every defined key, in stable declaration order.
            pub const ALL: &'static [Key] = &[$(Key::$name,)+];

            /// The canonical KSX spelling (exact, case-sensitive).
            pub const fn name(self) -> &'static str {
                match self {
                    $(Key::$name => stringify!($name),)+
                }
            }

            /// Parse a canonical KSX spelling (exact, case-sensitive).
            pub fn from_name(name: &str) -> Option<Self> {
                match name {
                    $(stringify!($name) => Some(Key::$name),)+
                    _ => None,
                }
            }

            /// The stable numeric value (scancode-derived `u16`).
            pub const fn value(self) -> u16 {
                self as u16
            }

            /// Reverse of [`Key::value`].
            pub fn from_value(value: u16) -> Option<Self> {
                match value {
                    $($value => Some(Key::$name),)+
                    _ => None,
                }
            }
        }
    };
}

keys! {
    None = 0,
    Escape = 1,
    One = 2,
    Two = 3,
    Three = 4,
    Four = 5,
    Five = 6,
    Six = 7,
    Seven = 8,
    Eight = 9,
    Nine = 10,
    Zero = 11,
    DashUnderscore = 12,
    PlusEquals = 13,
    Backspace = 14,
    Tab = 15,
    Q = 16,
    W = 17,
    E = 18,
    R = 19,
    T = 20,
    Y = 21,
    U = 22,
    I = 23,
    O = 24,
    P = 25,
    OpenBracketBrace = 26,
    CloseBracketBrace = 27,
    Enter = 28,
    LeftControl = 29,
    A = 30,
    S = 31,
    D = 32,
    F = 33,
    G = 34,
    H = 35,
    J = 36,
    K = 37,
    L = 38,
    SemicolonColon = 39,
    SingleDoubleQuote = 40,
    Tilde = 41,
    LeftShift = 42,
    BackslashPipe = 43,
    Z = 44,
    X = 45,
    C = 46,
    V = 47,
    B = 48,
    N = 49,
    M = 50,
    CommaLeftArrow = 51,
    PeriodRightArrow = 52,
    ForwardSlashQuestionMark = 53,
    RightShift = 54,
    NumpadAsterisk = 55,
    LeftAlt = 56,
    Space = 57,
    CapsLock = 58,
    F1 = 59,
    F2 = 60,
    F3 = 61,
    F4 = 62,
    F5 = 63,
    F6 = 64,
    F7 = 65,
    F8 = 66,
    F9 = 67,
    F10 = 68,
    NumLock = 69,
    ScrollLock = 70,
    Numpad7 = 71,
    Numpad8 = 72,
    Numpad9 = 73,
    NumpadMinus = 74,
    Numpad4 = 75,
    Numpad5 = 76,
    Numpad6 = 77,
    NumpadPlus = 78,
    Numpad1 = 79,
    Numpad2 = 80,
    Numpad3 = 81,
    Numpad0 = 82,
    NumpadDelete = 83,
    Oem16 = 84,
    LeftBackslashPipe = 86,
    F11 = 87,
    F12 = 88,
    LeftWindows = 91,
    RightWindows = 92,
    Menu = 93,
    Up = 5001,
    Down = 5002,
    Left = 5003,
    Right = 5004,
    Home = 10071,
    PageUp = 10073,
    End = 10079,
    PageDown = 10081,
    Insert = 10082,
    Delete = 10083,
    MediaPreviousTrack = 10001,
    MediaPlayPause = 10002,
    MediaNextTrack = 10003,
    VolumeUp = 10004,
    VolumeDown = 10005,
    VolumeMute = 10006,
    RightControl = 10008,
    RightAlt = 10009,
    Oem0 = 10020,
    Oem2 = 10010,
    Oem3 = 10011,
    Oem4 = 10015,
    Oem5 = 10012,
    Oem6 = 10013,
    Oem7 = 10014,
    Oem13 = 10007,
    NumpadDivide = 10040,
    ShiftModifier = 10016,
    PrintScreen = 10017,
    Break = 10018,
    Pause = 10019,
    NumpadEnter = 10021,
    MouseLeftButton = 20001,
    MouseRightButton = 20002,
    MouseMiddleButton = 20003,
    MouseExtraLeft = 20004,
    MouseExtraRight = 20005,
    MouseWheelUp = 20006,
    MouseWheelDown = 20007,
    MouseWheelLeft = 20008,
    MouseWheelRight = 20009,
    MouseMoveLeft = 20010,
    MouseMoveRight = 20011,
    MouseMoveUp = 20012,
    MouseMoveDown = 20013,
    Unknown = 30000,
}

impl Key {
    /// Whether this is a mouse-wheel pseudo-key.
    pub const fn is_mouse_wheel(self) -> bool {
        matches!(
            self,
            Key::MouseWheelUp | Key::MouseWheelDown | Key::MouseWheelLeft | Key::MouseWheelRight
        )
    }

    /// Whether this is a mouse-movement pseudo-key.
    pub const fn is_mouse_move(self) -> bool {
        matches!(
            self,
            Key::MouseMoveLeft | Key::MouseMoveRight | Key::MouseMoveUp | Key::MouseMoveDown
        )
    }

    /// Whether this is a mouse-button pseudo-key.
    pub const fn is_mouse_click(self) -> bool {
        matches!(
            self,
            Key::MouseLeftButton
                | Key::MouseRightButton
                | Key::MouseMiddleButton
                | Key::MouseExtraLeft
                | Key::MouseExtraRight
        )
    }

    /// Any mouse pseudo-key (wheel, move, or click).
    pub const fn is_mouse_pseudo(self) -> bool {
        self.is_mouse_wheel() || self.is_mouse_move() || self.is_mouse_click()
    }
}

impl core::fmt::Display for Key {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.name())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// The COMPLETE key vocabulary, frozen as literals: every canonical
    /// spelling paired with its wire value.
    ///
    /// Why the whole table and not a sample (2026-08-26 audit): `Key::name()`
    /// is `stringify!($variant)`, so the enum variant IS the word written into
    /// native preset TOML. Renaming a variant is a refactor any IDE will offer
    /// and it compiles clean — but every preset already on disk then fails
    /// [`Key::from_name`] and reads as "unknown key". This table was 54 of the
    /// 137 spellings before it was completed; the 13 `Mouse*` and 9 `Oem*`
    /// names had no literal witness anywhere in the workspace
    /// (`ksx-studio/src/keyboard_layout.rs` covers only the physical-keyboard
    /// subset).
    ///
    /// This is the append-only compatibility surface the module docs describe.
    /// Adding a key means adding a row. Changing a row means breaking saved
    /// presets, and that has to be loud.
    #[rustfmt::skip]
    const WIRE_VOCABULARY: &[(&str, u16)] = &[
        ("None", 0), ("Escape", 1), ("One", 2), ("Two", 3),
        ("Three", 4), ("Four", 5), ("Five", 6), ("Six", 7),
        ("Seven", 8), ("Eight", 9), ("Nine", 10), ("Zero", 11),
        ("DashUnderscore", 12), ("PlusEquals", 13), ("Backspace", 14), ("Tab", 15),
        ("Q", 16), ("W", 17), ("E", 18), ("R", 19),
        ("T", 20), ("Y", 21), ("U", 22), ("I", 23),
        ("O", 24), ("P", 25), ("OpenBracketBrace", 26), ("CloseBracketBrace", 27),
        ("Enter", 28), ("LeftControl", 29), ("A", 30), ("S", 31),
        ("D", 32), ("F", 33), ("G", 34), ("H", 35),
        ("J", 36), ("K", 37), ("L", 38), ("SemicolonColon", 39),
        ("SingleDoubleQuote", 40), ("Tilde", 41), ("LeftShift", 42), ("BackslashPipe", 43),
        ("Z", 44), ("X", 45), ("C", 46), ("V", 47),
        ("B", 48), ("N", 49), ("M", 50), ("CommaLeftArrow", 51),
        ("PeriodRightArrow", 52), ("ForwardSlashQuestionMark", 53), ("RightShift", 54), ("NumpadAsterisk", 55),
        ("LeftAlt", 56), ("Space", 57), ("CapsLock", 58), ("F1", 59),
        ("F2", 60), ("F3", 61), ("F4", 62), ("F5", 63),
        ("F6", 64), ("F7", 65), ("F8", 66), ("F9", 67),
        ("F10", 68), ("NumLock", 69), ("ScrollLock", 70), ("Numpad7", 71),
        ("Numpad8", 72), ("Numpad9", 73), ("NumpadMinus", 74), ("Numpad4", 75),
        ("Numpad5", 76), ("Numpad6", 77), ("NumpadPlus", 78), ("Numpad1", 79),
        ("Numpad2", 80), ("Numpad3", 81), ("Numpad0", 82), ("NumpadDelete", 83),
        ("Oem16", 84), ("LeftBackslashPipe", 86), ("F11", 87), ("F12", 88),
        ("LeftWindows", 91), ("RightWindows", 92), ("Menu", 93), ("Up", 5001),
        ("Down", 5002), ("Left", 5003), ("Right", 5004), ("Home", 10071),
        ("PageUp", 10073), ("End", 10079), ("PageDown", 10081), ("Insert", 10082),
        ("Delete", 10083), ("MediaPreviousTrack", 10001), ("MediaPlayPause", 10002), ("MediaNextTrack", 10003),
        ("VolumeUp", 10004), ("VolumeDown", 10005), ("VolumeMute", 10006), ("RightControl", 10008),
        ("RightAlt", 10009), ("Oem0", 10020), ("Oem2", 10010), ("Oem3", 10011),
        ("Oem4", 10015), ("Oem5", 10012), ("Oem6", 10013), ("Oem7", 10014),
        ("Oem13", 10007), ("NumpadDivide", 10040), ("ShiftModifier", 10016), ("PrintScreen", 10017),
        ("Break", 10018), ("Pause", 10019), ("NumpadEnter", 10021), ("MouseLeftButton", 20001),
        ("MouseRightButton", 20002), ("MouseMiddleButton", 20003), ("MouseExtraLeft", 20004), ("MouseExtraRight", 20005),
        ("MouseWheelUp", 20006), ("MouseWheelDown", 20007), ("MouseWheelLeft", 20008), ("MouseWheelRight", 20009),
        ("MouseMoveLeft", 20010), ("MouseMoveRight", 20011), ("MouseMoveUp", 20012), ("MouseMoveDown", 20013),
        ("Unknown", 30000),
    ];

    /// Every spelling a preset may already contain still parses, still renders
    /// the same way, and still carries the same number.
    ///
    /// Replaces `every_canonical_name_round_trips` (a 54-name sample) and the
    /// set-size half of `full_enum_is_distinct_and_complete`. Those two size
    /// assertions could not fail: `Key` is macro-generated, so a duplicate
    /// discriminant is `E0081` and a duplicate variant is `E0428` — both
    /// compile errors, checked with `rustc` before removing them.
    #[test]
    fn the_wire_vocabulary_is_frozen() {
        // The key vocabulary is an append-only compatibility surface.
        assert_eq!(Key::ALL.len(), 137);
        assert_eq!(
            WIRE_VOCABULARY.len(),
            Key::ALL.len(),
            "a new key needs a frozen (spelling, value) row before it ships",
        );

        for &(name, value) in WIRE_VOCABULARY {
            let key = Key::from_name(name)
                .unwrap_or_else(|| panic!("preset spelling '{name}' no longer parses"));
            assert_eq!(key.name(), name, "'{name}' now renders under another name");
            assert_eq!(key.value(), value, "'{name}' changed its wire value");
            assert_eq!(
                Key::from_value(value),
                Some(key),
                "value {value} must resolve back to '{name}'",
            );
        }

        // ...and no key escaped the table. Length alone would not catch a
        // duplicated row masking a missing one.
        let frozen: HashSet<&str> = WIRE_VOCABULARY.iter().map(|&(n, _)| n).collect();
        assert_eq!(frozen.len(), WIRE_VOCABULARY.len(), "duplicate frozen row");
        for key in Key::ALL {
            assert!(
                frozen.contains(key.name()),
                "{} ships with no frozen spelling",
                key.name(),
            );
        }
    }

    /// Kept alongside `the_wire_vocabulary_is_frozen` even though every line
    /// below is a subset of that table, because the provenance differs: these
    /// numbers were written by hand against the set-1 scancode spec and the
    /// E0/E1 correction table, while the full table was transcribed from the
    /// enum. If the big table is ever regenerated from a broken enum, this is
    /// the independent witness that still disagrees.
    #[test]
    fn stable_value_spot_checks() {
        assert_eq!(Key::None.value(), 0);
        assert_eq!(Key::Escape.value(), 1);
        assert_eq!(Key::Eight.value(), 9);
        assert_eq!(Key::Enter.value(), 28);
        assert_eq!(Key::SemicolonColon.value(), 39);
        assert_eq!(Key::BackslashPipe.value(), 43);
        assert_eq!(Key::CommaLeftArrow.value(), 51);
        assert_eq!(Key::PeriodRightArrow.value(), 52);
        assert_eq!(Key::Space.value(), 57);
        assert_eq!(Key::Oem16.value(), 84);
        assert_eq!(Key::LeftBackslashPipe.value(), 86);
        assert_eq!(Key::Menu.value(), 93);
        assert_eq!(Key::Up.value(), 5001);
        assert_eq!(Key::Right.value(), 5004);
        assert_eq!(Key::Oem13.value(), 10007);
        assert_eq!(Key::Pause.value(), 10019);
        assert_eq!(Key::NumpadEnter.value(), 10021);
        assert_eq!(Key::NumpadDivide.value(), 10040);
        assert_eq!(Key::MouseLeftButton.value(), 20001);
        assert_eq!(Key::MouseMoveDown.value(), 20013);
        assert_eq!(Key::Unknown.value(), 30000);
    }

    #[test]
    fn value_round_trips_for_all() {
        for key in Key::ALL {
            assert_eq!(Key::from_value(key.value()), Some(*key));
            assert_eq!(Key::from_name(key.name()), Some(*key));
        }
        assert_eq!(Key::from_value(85), None);
        assert_eq!(Key::from_name("eight"), None); // case-sensitive by contract
        assert_eq!(Key::from_name(""), None);
    }

    #[test]
    fn mouse_pseudo_key_classification() {
        assert!(Key::MouseWheelUp.is_mouse_wheel());
        assert!(Key::MouseMoveDown.is_mouse_move());
        assert!(Key::MouseExtraRight.is_mouse_click());
        assert!(Key::MouseLeftButton.is_mouse_pseudo());
        assert!(!Key::A.is_mouse_pseudo());
        assert!(!Key::Unknown.is_mouse_pseudo());
    }
}
