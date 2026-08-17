//! The standard board `/nocturne` draws, keyed to the canonical vocabulary.
//!
//! One authored table: each visual cell of the 104-key grid carries its
//! display cap and the exact [`ksx_core::Key`] spelling the mapper's binding
//! tables use — so "which key drives what" is a lookup, never a guess, and
//! the unit test below refuses any spelling `Key::from_name` does not
//! recognize. Cells with an empty key are layout chrome (the ghost spacers
//! that keep the nav column aligned).
//!
//! The SHORT drawn in a keycap's corner derives from the same zone tables
//! the mapper and the binding pane read (`render_map::zones_for`), compacted
//! for a 9px corner: face and shoulder labels pass through ("A", "✕", "L2"),
//! stick and d-pad directions gain their cluster prefix ("L↑", "R←", "D↓"),
//! and the center trio compacts per family (view→Vw, share→Sh, menu→Mn,
//! options→Op, guide→⌂). One vocabulary source; two surfaces cannot
//! disagree.

/// One visual cell of the standard board.
pub(crate) struct KeyCell {
    /// The printed cap.
    pub cap: &'static str,
    /// The canonical `ksx_core::Key` name, or `""` for layout chrome.
    pub key: &'static str,
    /// Width class suffix (`""` = 1u, `"u1_5"`, `"u2"`, …).
    pub unit: &'static str,
    /// Opens a cluster gap before this cell.
    pub sp: bool,
    /// Invisible alignment cell.
    pub ghost: bool,
}

const fn k(cap: &'static str, key: &'static str) -> KeyCell {
    KeyCell {
        cap,
        key,
        unit: "",
        sp: false,
        ghost: false,
    }
}

const fn ks(cap: &'static str, key: &'static str) -> KeyCell {
    KeyCell {
        cap,
        key,
        unit: "",
        sp: true,
        ghost: false,
    }
}

const fn kw(cap: &'static str, key: &'static str, unit: &'static str) -> KeyCell {
    KeyCell {
        cap,
        key,
        unit,
        sp: false,
        ghost: false,
    }
}

const fn kws(cap: &'static str, key: &'static str, unit: &'static str) -> KeyCell {
    KeyCell {
        cap,
        key,
        unit,
        sp: true,
        ghost: false,
    }
}

const fn ghost(sp: bool) -> KeyCell {
    KeyCell {
        cap: "",
        key: "",
        unit: "",
        sp,
        ghost: true,
    }
}

pub(crate) const ROW1: &[KeyCell] = &[
    k("Esc", "Escape"),
    ks("F1", "F1"),
    k("F2", "F2"),
    k("F3", "F3"),
    k("F4", "F4"),
    ks("F5", "F5"),
    k("F6", "F6"),
    k("F7", "F7"),
    k("F8", "F8"),
    ks("F9", "F9"),
    k("F10", "F10"),
    k("F11", "F11"),
    k("F12", "F12"),
    ks("Prt", "PrintScreen"),
    k("Scr", "ScrollLock"),
    k("Pse", "Pause"),
];

pub(crate) const ROW2: &[KeyCell] = &[
    k("`", "Tilde"),
    k("1", "One"),
    k("2", "Two"),
    k("3", "Three"),
    k("4", "Four"),
    k("5", "Five"),
    k("6", "Six"),
    k("7", "Seven"),
    k("8", "Eight"),
    k("9", "Nine"),
    k("0", "Zero"),
    k("−", "DashUnderscore"),
    k("=", "PlusEquals"),
    kw("⌫", "Backspace", "u2"),
    ks("Ins", "Insert"),
    k("Hm", "Home"),
    k("PgU", "PageUp"),
    ks("Num", "NumLock"),
    k("/", "NumpadDivide"),
    k("*", "NumpadAsterisk"),
    k("−", "NumpadMinus"),
];

pub(crate) const ROW3: &[KeyCell] = &[
    kw("Tab", "Tab", "u1_5"),
    k("Q", "Q"),
    k("W", "W"),
    k("E", "E"),
    k("R", "R"),
    k("T", "T"),
    k("Y", "Y"),
    k("U", "U"),
    k("I", "I"),
    k("O", "O"),
    k("P", "P"),
    k("[", "OpenBracketBrace"),
    k("]", "CloseBracketBrace"),
    kw("\\", "BackslashPipe", "u1_5"),
    ks("Del", "Delete"),
    k("End", "End"),
    k("PgD", "PageDown"),
    ks("7", "Numpad7"),
    k("8", "Numpad8"),
    k("9", "Numpad9"),
    k("+", "NumpadPlus"),
];

pub(crate) const ROW4: &[KeyCell] = &[
    kw("Caps", "CapsLock", "u1_75"),
    k("A", "A"),
    k("S", "S"),
    k("D", "D"),
    k("F", "F"),
    k("G", "G"),
    k("H", "H"),
    k("J", "J"),
    k("K", "K"),
    k("L", "L"),
    k(";", "SemicolonColon"),
    k("'", "SingleDoubleQuote"),
    kw("Enter", "Enter", "u2_25"),
    ghost(true),
    ghost(false),
    ghost(false),
    ks("4", "Numpad4"),
    k("5", "Numpad5"),
    k("6", "Numpad6"),
];

pub(crate) const ROW5: &[KeyCell] = &[
    kw("Shift", "LeftShift", "u2_25"),
    k("Z", "Z"),
    k("X", "X"),
    k("C", "C"),
    k("V", "V"),
    k("B", "B"),
    k("N", "N"),
    k("M", "M"),
    k(",", "CommaLeftArrow"),
    k(".", "PeriodRightArrow"),
    k("/", "ForwardSlashQuestionMark"),
    kw("Shift", "RightShift", "u2_75"),
    ghost(true),
    k("↑", "Up"),
    ghost(false),
    ks("1", "Numpad1"),
    k("2", "Numpad2"),
    k("3", "Numpad3"),
];

pub(crate) const ROW6: &[KeyCell] = &[
    kw("Ctrl", "LeftControl", "u1_25"),
    kw("Win", "LeftWindows", "u1_25"),
    kw("Alt", "LeftAlt", "u1_25"),
    kw("Space", "Space", "u6_25"),
    kw("Alt", "RightAlt", "u1_25"),
    kw("Win", "RightWindows", "u1_25"),
    kw("Menu", "Menu", "u1_25"),
    kw("Ctrl", "RightControl", "u1_25"),
    ks("←", "Left"),
    k("↓", "Down"),
    k("→", "Right"),
    kws("0", "Numpad0", "u2"),
    k(".", "NumpadDelete"),
];

pub(crate) const ROWS: [&[KeyCell]; 6] = [ROW1, ROW2, ROW3, ROW4, ROW5, ROW6];

/// The corner short for one mapper function, in the given persona's own
/// vocabulary — derived from the SAME zone table the binding pane reads.
pub(crate) fn short_for(persona: &str, fn_name: &str) -> String {
    // Directions carry their cluster prefix; everything else compacts the
    // zone's own label.
    match fn_name {
        "ly.max" => return "L↑".to_owned(),
        "ly.min" => return "L↓".to_owned(),
        "lx.min" => return "L←".to_owned(),
        "lx.max" => return "L→".to_owned(),
        "ry.max" => return "R↑".to_owned(),
        "ry.min" => return "R↓".to_owned(),
        "rx.min" => return "R←".to_owned(),
        "rx.max" => return "R→".to_owned(),
        "dpad.up" => return "D↑".to_owned(),
        "dpad.down" => return "D↓".to_owned(),
        "dpad.left" => return "D←".to_owned(),
        "dpad.right" => return "D→".to_owned(),
        _ => {}
    }
    let label = crate::render_map::zones_for(persona)
        .iter()
        .find(|zone| zone.fn_name == fn_name)
        .map(|zone| zone.label)
        .unwrap_or(fn_name);
    match label {
        "view" => "Vw".to_owned(),
        "menu" => "Mn".to_owned(),
        "share" => "Sh".to_owned(),
        "options" => "Op".to_owned(),
        "guide" | "PS" => "⌂".to_owned(),
        other => other.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every key name on the board is a canonical `ksx_core::Key` spelling —
    /// a typo here would silently unlight a physical key forever.
    #[test]
    fn every_board_key_is_canonical() {
        for row in ROWS {
            for cell in row {
                if cell.ghost {
                    assert!(cell.key.is_empty() && cell.cap.is_empty());
                    continue;
                }
                assert!(
                    ksx_core::Key::from_name(cell.key).is_some(),
                    "cell {:?} names unknown key {:?}",
                    cell.cap,
                    cell.key,
                );
            }
        }
    }

    /// No physical key appears twice: a duplicate would double-draw a short.
    #[test]
    fn board_keys_are_unique() {
        let mut seen = std::collections::BTreeSet::new();
        for row in ROWS {
            for cell in row {
                if cell.key.is_empty() {
                    continue;
                }
                assert!(seen.insert(cell.key), "duplicate board key {:?}", cell.key);
            }
        }
    }

    /// Shorts come from the zone vocabulary: family-aware, compact, total
    /// over every mappable function.
    #[test]
    fn shorts_cover_every_zone_function_in_both_families() {
        for persona in ["xbox360", "playstation"] {
            for zone in crate::render_map::zones_for(persona) {
                let short = short_for(persona, zone.fn_name);
                assert!(
                    !short.is_empty() && short.chars().count() <= 2,
                    "{persona} {}: short {short:?} does not fit a keycap corner",
                    zone.fn_name,
                );
            }
        }
    }
}
