//! A BOARD: the picture you map on.
//!
//! **The backend does not care what the input looks like.** It cares that `H`
//! arrived and that `H` is bound to a control. Everything about where a cap
//! sits, how wide it is, and what is printed on it is a rendering choice — and
//! `keyboard_layout::KeyCell` has always said so in its own type, keeping `cap`
//! (display) apart from `key` (identity, and the only field the bind verb ever
//! sees). Lay the keyboard out in alphabetical order and nothing downstream can
//! tell: every `cap` moved and every `key` stayed.
//!
//! What was wrong is that there has only ever been ONE board and it was a
//! `const`. A `Board` gives that picture an id, so the shipped QWERTY, an
//! arcade encoder's terminals and a panel somebody drew can be entries in one
//! roster rather than three unrelated ideas.
//!
//! # Two coordinate stories, on purpose
//!
//! Every cell carries absolute `x/y/w/h` AND the row-flow hints (`row`, `unit`,
//! `sp`) the shipped board is authored in. That is deliberate and temporary:
//!
//! - The absolute geometry is the destination. It is the only form that can
//!   express an arcade panel, whose controls sit where the plywood put them.
//! - The row hints are what the page renders from TODAY. Six real things are
//!   keyed to the six `.n-kbrow` elements — arrow-key roving focus
//!   (`NocturneIsland.ts`), the per-row keycap sculpt (`studio.css`
//!   `nth-child(1..6)`), the closed set of `u*` width classes, the Arranger's
//!   regex that reads `unit` back out of the class string, the hand-fitted
//!   980px board width, and the `sp` margin constants derived from row 1's
//!   exact contents.
//!
//! So this phase introduces the type and changes nothing on the wire. Absolute
//! rendering is its own step, with those six answered one at a time.
//!
//! # The geometry is derived, not invented
//!
//! `studio.css` documents the ladder: `width(n) = n × unit + (n−1) × gap`, with
//! `--nku: 35.5px` and `--nkg: 4px`, and a cap `34/30` taller than it is wide.
//! [`Board::shipped_qwerty`] replays exactly that arithmetic, so a cell's `x` is
//! where the flex row actually puts it. `board_width_matches_the_fitted_card`
//! checks the running sum against the 980px card the comment in `studio.css`
//! says 35.5px was chosen to fill — if someone edits the unit, that test says
//! whether the board still fits before anyone looks at it.

#[cfg(test)]
use crate::keyboard_layout::KeyCell;
use crate::keyboard_layout::ROWS;

/// `--nku` in `studio.css`: one keycap wide.
pub(crate) const UNIT: f32 = 35.5;
/// `--nkg`: the gap between caps, and between rows.
pub(crate) const GAP: f32 = 4.0;
/// A cap is `34/30` taller than it is wide (`.n-key { height: … * 34 / 30 }`).
const CAP_ASPECT: f32 = 34.0 / 30.0;

/// `.n-key.sp` opens a cluster gap. Rows 2-6 use `(nku + nkg) × 21/34`; row 1
/// overrides it to `22.66/34`, a constant `studio.css` derives from row 1's own
/// contents ("506px main-block width − 438px of F-row keys and gaps, / 3 gaps").
const SP_NUMERATOR: f32 = 21.0;
const SP_NUMERATOR_ROW1: f32 = 22.66;
const SP_DENOMINATOR: f32 = 34.0;

/// What a cell IS, physically. The shipped board is uniformly `Keycap`; an
/// arcade panel names its hardware, which is what somebody standing at a
/// cabinet actually sees.
/// Some of this is read only by the tests until the picker lands. That is not
/// an oversight: the absolute geometry and the non-keycap kinds exist so an
/// arcade panel can be expressed at all, while the page still renders the
/// shipped board through its six `.n-kbrow` elements. The tests DO read them —
/// they are why the arithmetic can be trusted when rendering switches over —
/// so the allow is scoped to the non-test build, exactly as `render_map::Zone`
/// scopes its geometry.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BoardCellKind {
    Keycap,
    Button30,
    Button24,
    Joystick,
}

impl BoardCellKind {
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Keycap => "keycap",
            Self::Button30 => "button30",
            Self::Button24 => "button24",
            Self::Joystick => "joystick",
        }
    }
}

/// Where a board came from — which decides who may change it, not how it draws.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BoardOrigin {
    /// Compiled in. The user picks it; nobody edits it.
    Shipped,
    /// Derived from hardware ksx recognised, e.g. an encoder's terminals.
    Recognized,
    /// Drawn by the user.
    Authored,
}

impl BoardOrigin {
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Shipped => "shipped",
            Self::Recognized => "recognized",
            Self::Authored => "authored",
        }
    }
}

/// One thing you can press, and the key it emits.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Debug)]
pub(crate) struct BoardCell {
    /// Stable within a board. `key:G` for the shipped board, where the key IS
    /// the identity; an arcade panel needs its own, because two of its buttons
    /// may legitimately emit the same key.
    pub(crate) id: String,
    /// The printed text. Display only — nothing parses it.
    pub(crate) cap: String,
    /// The canonical `ksx_core::Key` name. **The only field the backend sees.**
    /// Empty for layout chrome.
    pub(crate) key: String,
    pub(crate) kind: BoardCellKind,
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) w: f32,
    pub(crate) h: f32,
    /// Which player owns it, on a board that has seats.
    pub(crate) player: Option<u8>,
    /// An invisible alignment cell. It occupies space and emits nothing.
    pub(crate) ghost: bool,

    // ── row-flow hints; see the module doc ────────────────────────────────
    /// Which `.n-kbrow` renders it today.
    pub(crate) row: u8,
    /// The `u*` width class, or empty for 1u.
    pub(crate) unit: String,
    /// Opens a cluster gap before this cell.
    pub(crate) sp: bool,
}

/// A picture, with an id.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Debug)]
pub(crate) struct Board {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) origin: BoardOrigin,
    /// The virtual space `x/y/w/h` live in, at the shipped scale.
    pub(crate) bounds: (f32, f32),
    pub(crate) cells: Vec<BoardCell>,
}

/// The `u*` class suffix as a number of units. Unknown suffixes are 1u, which
/// is also what `studio.css` silently renders — the two agree deliberately, so
/// this never disagrees with the page about how wide something is.
fn units_of(unit: &str) -> f32 {
    match unit {
        "u1_25" => 1.25,
        "u1_5" => 1.5,
        "u1_75" => 1.75,
        "u2" => 2.0,
        "u2_25" => 2.25,
        "u2_75" => 2.75,
        "u6_25" => 6.25,
        _ => 1.0,
    }
}

/// `width(n) = n × unit + (n−1) × gap`, straight from `studio.css`.
fn width_of(units: f32) -> f32 {
    units * UNIT + (units - 1.0) * GAP
}

impl Board {
    /// The standard 104-key board, converted from the authored table.
    ///
    /// The table stays the authoring surface — a row of `k("G", "G")` calls is
    /// far easier to read and review than 108 coordinate triples, and its two
    /// invariants (every key canonical, no key twice) are already pinned there.
    /// This walks it once and records where the flex row puts each cap.
    pub(crate) fn shipped_qwerty() -> Self {
        let row_step = UNIT * CAP_ASPECT + GAP;
        let mut cells = Vec::new();
        let mut widest = 0.0_f32;

        for (index, row) in ROWS.iter().enumerate() {
            let row_number = index as u8 + 1;
            let sp_extra = (UNIT + GAP)
                * if index == 0 {
                    SP_NUMERATOR_ROW1
                } else {
                    SP_NUMERATOR
                }
                / SP_DENOMINATOR;
            let y = index as f32 * row_step;
            let mut x = 0.0_f32;

            for cell in row.iter() {
                if cell.sp {
                    x += sp_extra;
                }
                let w = width_of(units_of(cell.unit));
                cells.push(BoardCell {
                    // Layout chrome has no key, so it cannot borrow one for an
                    // id. Position is the only thing that distinguishes two
                    // ghosts, and it is what the row-flow already uses.
                    id: if cell.key.is_empty() {
                        format!("chrome:{row_number}:{}", x.round() as i32)
                    } else {
                        format!("key:{}", cell.key)
                    },
                    cap: cell.cap.to_owned(),
                    key: cell.key.to_owned(),
                    kind: BoardCellKind::Keycap,
                    x,
                    y,
                    w,
                    h: UNIT * CAP_ASPECT,
                    player: None,
                    ghost: cell.ghost,
                    row: row_number,
                    unit: cell.unit.to_owned(),
                    sp: cell.sp,
                });
                x += w + GAP;
            }
            // The trailing gap is not part of the row.
            widest = widest.max(x - GAP);
        }

        Self {
            id: "qwerty-104".to_owned(),
            name: "Standard keyboard".to_owned(),
            origin: BoardOrigin::Shipped,
            bounds: (widest, ROWS.len() as f32 * row_step - GAP),
            cells,
        }
    }

    /// Cells in row order, grouped as the page still renders them.
    pub(crate) fn rows(&self) -> Vec<Vec<&BoardCell>> {
        let mut rows: Vec<Vec<&BoardCell>> = Vec::new();
        for cell in &self.cells {
            let index = usize::from(cell.row).saturating_sub(1);
            while rows.len() <= index {
                rows.push(Vec::new());
            }
            rows[index].push(cell);
        }
        rows
    }
}

impl BoardCell {
    /// The authored table's own shape, for code that still speaks it.
    #[cfg(test)]
    fn matches(&self, cell: &KeyCell) -> bool {
        self.cap == cell.cap
            && self.key == cell.key
            && self.unit == cell.unit
            && self.sp == cell.sp
            && self.ghost == cell.ghost
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **The wire vocabulary, pinned.** These strings will name a board and its
    /// cells wherever one is served or stored, so they are a contract the
    /// moment anything reads them — and renaming a variant in Rust must not
    /// silently rename it on disk or in a payload.
    ///
    /// This also keeps the non-keycap kinds honest: they exist because an
    /// arcade panel has real hardware the shipped board does not, and a
    /// variant nothing has ever spelled out is a variant nobody can rely on.
    #[test]
    fn every_kind_and_origin_spells_itself() {
        assert_eq!(BoardCellKind::Keycap.as_str(), "keycap");
        assert_eq!(BoardCellKind::Button30.as_str(), "button30");
        assert_eq!(BoardCellKind::Button24.as_str(), "button24");
        assert_eq!(BoardCellKind::Joystick.as_str(), "joystick");

        assert_eq!(BoardOrigin::Shipped.as_str(), "shipped");
        assert_eq!(BoardOrigin::Recognized.as_str(), "recognized");
        assert_eq!(BoardOrigin::Authored.as_str(), "authored");
    }

    /// The shipped board names itself, and says it is not editable. `origin` is
    /// what a picker will use to decide whether a board offers a rename or a
    /// delete, so getting it wrong offers to edit something compiled in.
    #[test]
    fn the_shipped_board_says_what_it_is() {
        let board = Board::shipped_qwerty();
        assert_eq!(board.id, "qwerty-104");
        assert_eq!(board.origin, BoardOrigin::Shipped);
        assert!(!board.name.is_empty(), "a board a user picks needs a name");
    }

    /// Rows step down by exactly one cap plus one gap, every cap is the same
    /// height, and the shipped board has no seats. A row that did not advance
    /// would stack two rows of caps on one another the moment rendering moves
    /// to absolute positions — and nothing else would notice.
    #[test]
    fn rows_advance_and_caps_are_uniform() {
        let board = Board::shipped_qwerty();
        let cap_height = UNIT * (34.0 / 30.0);

        for cell in &board.cells {
            assert_eq!(cell.kind, BoardCellKind::Keycap, "the board is all caps");
            assert_eq!(cell.player, None, "the shipped board has no seats");
            assert!(
                (cell.h - cap_height).abs() < 0.01,
                "{:?} is a different height from every other cap",
                cell.cap
            );
            let expected_y = f32::from(cell.row - 1) * (cap_height + GAP);
            assert!(
                (cell.y - expected_y).abs() < 0.01,
                "row {} sits at {} rather than {expected_y}",
                cell.row,
                cell.y
            );
        }
    }

    /// The conversion is lossless in the direction that matters: every field
    /// `dress()` reads comes back identical, in the same order. This is the
    /// whole claim of introducing the type — the page cannot change.
    #[test]
    fn the_shipped_board_is_the_authored_table_verbatim() {
        let board = Board::shipped_qwerty();
        let rows = board.rows();
        assert_eq!(rows.len(), ROWS.len(), "a row went missing");

        for (index, (converted, authored)) in rows.iter().zip(ROWS.iter()).enumerate() {
            assert_eq!(
                converted.len(),
                authored.len(),
                "row {} changed length",
                index + 1
            );
            for (cell, source) in converted.iter().zip(authored.iter()) {
                assert!(
                    cell.matches(source),
                    "row {} cell {:?} does not match the authored table",
                    index + 1,
                    cell.cap
                );
            }
        }
    }

    /// A cell's id must identify it. The shipped board's key IS its identity —
    /// that is the invariant `board_keys_are_unique` already pins — but ghosts
    /// have no key, and two ghosts in one row would collide on any id built
    /// from one.
    #[test]
    fn every_cell_id_is_unique() {
        let board = Board::shipped_qwerty();
        let mut seen = std::collections::BTreeSet::new();
        for cell in &board.cells {
            assert!(
                seen.insert(cell.id.clone()),
                "two cells share the id {:?} — one of them cannot be addressed",
                cell.id
            );
        }
    }

    /// Every key on a board must be one the engine can actually receive. The
    /// authored table pins this for itself; the Board is where an ARCADE panel
    /// will arrive later, and it must be held to the same rule or a typo
    /// persists forever and silently matches nothing.
    #[test]
    fn every_board_key_is_canonical() {
        for cell in &Board::shipped_qwerty().cells {
            if cell.ghost {
                assert!(cell.key.is_empty(), "chrome must not claim a key");
                continue;
            }
            assert!(
                ksx_core::Key::from_name(&cell.key).is_some(),
                "{:?} is not a key ksx can receive",
                cell.key
            );
        }
    }

    /// `studio.css` says 35.5px was chosen so the board fills the 980px card,
    /// and warns against rounding it up because 36px lands the plate wider than
    /// its scroll container. Nothing checked that. Now the arithmetic does.
    #[test]
    fn board_width_matches_the_fitted_card() {
        let board = Board::shipped_qwerty();
        let (width, _) = board.bounds;
        assert!(
            (900.0..=980.0).contains(&width),
            "the board is {width}px wide; the card it is fitted to is 980px. \
             Either --nku changed or a row grew — studio.css's own comment says \
             36px already overflows the scroll container."
        );
    }

    /// x advances by the cap plus a gap, and a cluster opens an extra one. Two
    /// caps must never overlap: an overlapping board hands a click to the wrong
    /// key, which is indistinguishable from a mapping that stopped working.
    #[test]
    fn cells_in_a_row_never_overlap() {
        let board = Board::shipped_qwerty();
        for (index, row) in board.rows().iter().enumerate() {
            for pair in row.windows(2) {
                let (left, right) = (pair[0], pair[1]);
                assert!(
                    left.x + left.w <= right.x + 0.01,
                    "row {} overlaps {:?} with {:?}",
                    index + 1,
                    left.cap,
                    right.cap
                );
            }
        }
    }
}
