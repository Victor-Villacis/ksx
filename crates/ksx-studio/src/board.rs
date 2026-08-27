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
            id: QWERTY_ID.to_owned(),
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

// ───────────────────────────────────────────────────────────────────────────
// The encoder board
// ───────────────────────────────────────────────────────────────────────────

/// One control pitch: a cell plus the gap after it.
const STEP: f32 = UNIT + GAP;

/// Vertical distance between one player band and the next, in cell pitches.
/// Three rows of controls plus a little air, so four players fit one plate.
const BAND_PITCH: f32 = 3.4;

/// What a terminal DOES on the panel, parsed from its id.
///
/// The ids are the backend's (`panel_programming::IPAC4_TERMINALS`), spelled
/// `<player><role>`: `1up`, `2sw3`, `4coin`. Parsing them here rather than
/// having the backend serve a shape is deliberate — a terminal role decides
/// where it is DRAWN and what is PRINTED on it, and both are this crate's
/// business. What the backend owns is what the terminal is wired to, which
/// arrives as `normal_key` and is passed through untouched.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TerminalRole {
    Up,
    Down,
    Left,
    Right,
    /// Action switch 1-8, as printed on a cabinet.
    Switch(u8),
    Start,
    Coin,
    /// An id this build does not recognise. **Still drawn.** A terminal that
    /// vanishes from the picture is a control the user owns and cannot map,
    /// with no way to find out why.
    Unknown,
}

impl TerminalRole {
    /// The printed text. `id` is the fallback so an unrecognised terminal says
    /// what it is rather than showing a blank cap.
    fn cap(self, id: &str) -> String {
        match self {
            Self::Up => "\u{25b2}".to_owned(),
            Self::Down => "\u{25bc}".to_owned(),
            Self::Left => "\u{25c0}".to_owned(),
            Self::Right => "\u{25b6}".to_owned(),
            Self::Switch(n) => n.to_string(),
            Self::Start => "Start".to_owned(),
            Self::Coin => "Coin".to_owned(),
            Self::Unknown => id.to_owned(),
        }
    }

    fn kind(self) -> BoardCellKind {
        match self {
            Self::Up | Self::Down | Self::Left | Self::Right => BoardCellKind::Joystick,
            // Start and Coin are 24mm on essentially every cabinet; the action
            // switches are 30mm. The distinction is real hardware, and it is
            // what makes the drawn panel recognisable as your own.
            Self::Start | Self::Coin => BoardCellKind::Button24,
            Self::Switch(_) | Self::Unknown => BoardCellKind::Button30,
        }
    }

    /// Where this control sits inside its player band, in cell pitches.
    ///
    /// A joystick diamond on the left, the eight action switches as the usual
    /// two rows of four, then Start over Coin at the right. Anything unplaced
    /// is parked past the right edge in arrival order, so it never lands on top
    /// of a control that IS placed.
    fn offset(self, unplaced: usize) -> (f32, f32) {
        match self {
            Self::Up => (1.0, 0.0),
            Self::Left => (0.0, 1.0),
            Self::Right => (2.0, 1.0),
            Self::Down => (1.0, 2.0),
            Self::Switch(n @ 1..=4) => (3.5 + f32::from(n - 1), 0.5),
            Self::Switch(n) if (5..=8).contains(&n) => (3.5 + f32::from(n - 5), 1.5),
            Self::Start => (8.0, 0.5),
            Self::Coin => (8.0, 1.5),
            Self::Switch(_) | Self::Unknown => (10.0 + unplaced as f32, 0.5),
        }
    }
}

/// Split a terminal id into the player it belongs to and what it does.
///
/// Deliberately total: anything unparseable comes back `(None, Unknown)` and is
/// still drawn. See [`TerminalRole::Unknown`].
fn parse_terminal(id: &str) -> (Option<u8>, TerminalRole) {
    let lower = id.trim().to_ascii_lowercase();
    let mut chars = lower.chars();
    let Some(digit) = chars.next().and_then(|c| c.to_digit(10)) else {
        return (None, TerminalRole::Unknown);
    };
    let player = u8::try_from(digit).ok().filter(|p| (1..=4).contains(p));
    let rest = chars.as_str();
    let role = match rest {
        "up" => TerminalRole::Up,
        "down" => TerminalRole::Down,
        "left" => TerminalRole::Left,
        "right" => TerminalRole::Right,
        "start" => TerminalRole::Start,
        "coin" => TerminalRole::Coin,
        _ => rest
            .strip_prefix("sw")
            .and_then(|n| n.parse::<u8>().ok())
            .filter(|n| (1..=8).contains(n))
            .map_or(TerminalRole::Unknown, TerminalRole::Switch),
    };
    (player, role)
}

impl Board {
    /// **An arcade panel, drawn from a layout the user saved.**
    ///
    /// The whole board is the profile. `panel_profiles` already stores one row
    /// per terminal with the key that terminal emits, so there is nothing to
    /// invent here and no second store to keep in step — this reads what the
    /// backend already owns and decides only where to draw it.
    ///
    /// # Why a saved layout is required
    ///
    /// ksx cannot guess what a panel emits. An encoder is switches wired to a
    /// board, and the host learns only that a key arrived. No factory chart is
    /// compiled in anywhere in this repo, and writing one from memory would be
    /// a confident claim about somebody else hardware. So a panel with no saved
    /// layout gets no encoder board, and the picker says why rather than
    /// offering an empty plate.
    ///
    /// A terminal with no key is Unassigned — drawn, labelled, and not
    /// bindable, which is a real state on a panel rather than an error. The
    /// key itself is passed through unvetted on purpose: this crate does not
    /// link the key vocabulary at runtime, and the backend already refuses a
    /// terminal it cannot store when the layout is saved.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn encoder_from_profile(profile: &ksx_api::PanelHardwareProfile) -> Self {
        let mut cells = Vec::with_capacity(profile.terminals.len());
        let mut unplaced = 0usize;
        let mut width: f32 = 0.0;
        let mut height: f32 = 0.0;

        for terminal in &profile.terminals {
            let (player, role) = parse_terminal(&terminal.terminal_id);
            let (dx, dy) = role.offset(unplaced);
            if matches!(role, TerminalRole::Unknown) {
                unplaced += 1;
            }
            // An unrecognised player still gets a band of its own, after the
            // four this build knows, for the same reason an unknown role is
            // still drawn.
            let band = player.map_or(4, |p| p - 1);
            let x = dx * STEP;
            let y = (f32::from(band) * BAND_PITCH + dy) * STEP;
            // Passed through, never vetted here. This crate 'renders and
            // routes and knows nothing about the key vocabulary at runtime'
            // (its Cargo.toml, which keeps ksx-core a DEV dependency for
            // exactly this reason). The vocabulary lives where the keys come
            // from: the backend refuses a terminal it cannot store when the
            // layout is saved. Re-deciding it here would put a second, older
            // opinion about what a key is into the one crate that was built
            // not to have one.
            //
            // Absent means Unassigned — a real state on a panel, and the
            // reason this is an Option rather than an empty string upstream.
            let key = terminal
                .normal_key
                .as_deref()
                .unwrap_or_default()
                .trim()
                .to_owned();

            width = width.max(x + UNIT);
            height = height.max(y + UNIT);
            cells.push(BoardCell {
                id: format!("terminal:{}", terminal.terminal_id),
                cap: role.cap(&terminal.terminal_id),
                key,
                kind: role.kind(),
                x,
                y,
                w: UNIT,
                h: UNIT,
                player,
                ghost: false,
                // One row per player while the page still renders rows. The
                // diamond and the button cluster live in x/y above, ready for
                // absolute rendering without a second pass over this.
                row: band + 1,
                unit: String::new(),
                sp: false,
            });
        }

        Board {
            id: format!("panel:{}", profile.profile_id),
            name: if profile.name.trim().is_empty() {
                "Arcade panel".to_owned()
            } else {
                profile.name.clone()
            },
            origin: BoardOrigin::Recognized,
            bounds: (width, height),
            cells,
        }
    }
}

// ───────────────────────────────────────────────────────────────────────────
// The roster
// ───────────────────────────────────────────────────────────────────────────

/// The shipped board id, and the ONE spelling of it.
///
/// [`Board::shipped_qwerty`] and [`Board::roster`] must agree on this exactly:
/// the picker marks a row by comparing its id against the drawn board, so two
/// spellings would leave the keyboard row never lighting up as chosen — the
/// same "the control does nothing" shape as the theme picker's hidden rows,
/// and it is what `the_roster_offers_the_keyboard_and_every_saved_layout`
/// caught. Stored in `[settings] board`; empty means "decide
/// from the staged device", so this is written only when someone picks it.
pub(crate) const QWERTY_ID: &str = "qwerty-104";

/// One board the user may pick, as the picker says it.
///
/// Every row here is one you can actually pick. A board that CANNOT be drawn is
/// not rendered as a dead row: a submit button that refuses to do anything is
/// the greyed-out-step antipattern, and this one would post the empty id, which
/// already means something else. What is missing is said in the sentence under
/// the picker instead — `NocturneDerived::board_line`, which can tell "none
/// saved yet" apart from "the store would not answer".
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct BoardChoice {
    pub(crate) id: String,
    pub(crate) name: String,
    /// The whole sentence: what this board is.
    pub(crate) detail: String,
}

impl Board {
    /// Every board this machine could draw right now, in picker order.
    ///
    /// The shipped keyboard is always first — it is the one picture that needs
    /// nothing but the build. Saved panel layouts follow, in store order.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn roster(profiles: &[ksx_api::PanelHardwareProfile]) -> Vec<BoardChoice> {
        let mut rows = vec![BoardChoice {
            id: QWERTY_ID.to_owned(),
            name: "Keyboard".to_owned(),
            detail: "The usual key layout. Every key ksx can bind, where you \
                     expect it."
                .to_owned(),
        }];

        rows.extend(profiles.iter().map(|profile| BoardChoice {
            id: format!("panel:{}", profile.profile_id),
            name: if profile.name.trim().is_empty() {
                "Arcade panel".to_owned()
            } else {
                profile.name.clone()
            },
            detail: format!(
                "Your saved panel layout — {} controls, drawn as a cabinet.",
                profile.terminals.len()
            ),
        }));

        rows
    }

    /// The board to draw, given what was chosen and what is staged.
    ///
    /// An empty choice is not indecision — it is "follow the hardware", the
    /// same absence-means-follow rule the theme uses for System. A recognised
    /// encoder with a saved layout gets its panel; anything else gets the
    /// keyboard.
    ///
    /// **An id this build cannot draw falls back to the keyboard rather than
    /// rendering nothing.** A config written by a newer Studio, or naming a
    /// panel layout since deleted, must not leave the page with no picture on
    /// it — the picker still shows what the config says, so the choice is
    /// visible even when it cannot be honoured.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn resolve(
        chosen: &str,
        profiles: &[ksx_api::PanelHardwareProfile],
        encoder_staged: bool,
    ) -> Self {
        let panel_for = |id: &str| {
            profiles
                .iter()
                .find(|p| p.profile_id == id)
                .map(Self::encoder_from_profile)
        };

        match chosen.trim() {
            "" => {
                if encoder_staged {
                    if let Some(first) = profiles.first() {
                        return Self::encoder_from_profile(first);
                    }
                }
                Self::shipped_qwerty()
            }
            QWERTY_ID => Self::shipped_qwerty(),
            other => other
                .strip_prefix("panel:")
                .and_then(panel_for)
                .unwrap_or_else(Self::shipped_qwerty),
        }
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

    // ───────────────────────────────────────────────────────────────────
    // The encoder board
    // ───────────────────────────────────────────────────────────────────

    /// The 56 terminal ids an I-PAC 4 profile carries, in the backend order.
    /// Spelled out rather than imported because `IPAC4_TERMINALS` is
    /// `pub(crate)` in `ksx-backend` and this crate deliberately does not
    /// depend on it — the Studio reaches the machine only through
    /// `ksx-api` traits. `every_shipped_terminal_id_parses` is what keeps
    /// this list honest against the real vocabulary.
    fn ipac4_ids() -> Vec<String> {
        let mut ids = Vec::new();
        for player in 1..=4 {
            for role in ["up", "down", "left", "right"] {
                ids.push(format!("{player}{role}"));
            }
            for sw in 1..=8 {
                ids.push(format!("{player}sw{sw}"));
            }
            ids.push(format!("{player}start"));
            ids.push(format!("{player}coin"));
        }
        ids
    }

    fn profile_of(rows: Vec<(&str, Option<&str>)>) -> ksx_api::PanelHardwareProfile {
        ksx_api::PanelHardwareProfile {
            profile_id: "cab-01".to_owned(),
            name: "Upright cab".to_owned(),
            terminals: rows
                .into_iter()
                .map(|(id, key)| ksx_api::PanelHardwareTerminal {
                    terminal_id: id.to_owned(),
                    normal_key: key.map(str::to_owned),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }
    }

    /// A full panel: four bands, fourteen controls each, and every key the
    /// profile carries arriving intact.
    #[test]
    fn a_panel_is_drawn_from_the_saved_layout() {
        let ids = ipac4_ids();
        let profile = profile_of(ids.iter().map(|id| (id.as_str(), Some("A"))).collect());
        let board = Board::encoder_from_profile(&profile);

        assert_eq!(board.cells.len(), 56, "every terminal must get a cell");
        assert_eq!(board.origin, BoardOrigin::Recognized);
        assert_eq!(board.id, "panel:cab-01");
        assert_eq!(board.name, "Upright cab");

        let rows = board.rows();
        assert_eq!(rows.len(), 4, "one band per player, got {}", rows.len());
        for (index, row) in rows.iter().enumerate() {
            assert_eq!(
                row.len(),
                14,
                "player {} band has {} controls",
                index + 1,
                row.len()
            );
        }
        assert!(
            board.cells.iter().all(|c| c.key == "A"),
            "a key the profile carries must reach the cell unchanged"
        );
        assert!(
            board.cells.iter().all(|c| c.player.is_some()),
            "every control on a known panel belongs to a player"
        );
    }

    /// Each band is one joystick, eight action switches, Start and Coin —
    /// named the way somebody standing at the cabinet would name them.
    #[test]
    fn a_band_is_a_stick_eight_buttons_start_and_coin() {
        let profile = profile_of(ipac4_ids().iter().map(|id| (id.as_str(), None)).collect());
        let board = Board::encoder_from_profile(&profile);
        let band: Vec<&BoardCell> = board.cells.iter().filter(|c| c.player == Some(2)).collect();

        let sticks = band
            .iter()
            .filter(|c| c.kind == BoardCellKind::Joystick)
            .count();
        let actions = band
            .iter()
            .filter(|c| c.kind == BoardCellKind::Button30)
            .count();
        let small = band
            .iter()
            .filter(|c| c.kind == BoardCellKind::Button24)
            .count();
        assert_eq!((sticks, actions, small), (4, 8, 2), "band was {band:?}");

        let caps: Vec<&str> = band.iter().map(|c| c.cap.as_str()).collect();
        for want in [
            "\u{25b2}", "\u{25bc}", "\u{25c0}", "\u{25b6}", "Start", "Coin", "1", "8",
        ] {
            assert!(caps.contains(&want), "band is missing {want:?}: {caps:?}");
        }
    }

    /// **An id this build does not know is still drawn.**
    ///
    /// A terminal that vanishes from the picture is a control the user owns
    /// and cannot map, with nothing on screen to explain the absence. It gets
    /// a cell, keeps its key, and is captioned with its own id.
    #[test]
    fn an_unrecognised_terminal_is_drawn_not_dropped() {
        let profile = profile_of(vec![
            ("1up", Some("Up")),
            ("1sw9", Some("B")),
            ("9zz", Some("C")),
            ("", Some("D")),
        ]);
        let board = Board::encoder_from_profile(&profile);

        assert_eq!(board.cells.len(), 4, "no terminal may be silently dropped");
        let odd: Vec<&BoardCell> = board
            .cells
            .iter()
            .filter(|c| c.kind == BoardCellKind::Button30)
            .collect();
        assert_eq!(odd.len(), 3, "unknown roles draw as buttons: {odd:?}");
        assert!(
            odd.iter().all(|c| !c.key.is_empty()),
            "an unknown terminal still emits its key and stays bindable"
        );
        assert!(
            odd.iter().any(|c| c.cap == "1sw9"),
            "an unrecognised terminal is captioned with its own id: {odd:?}"
        );
        // The three unplaced controls are parked in arrival order, never
        // stacked on each other.
        let xs: Vec<i32> = odd.iter().map(|c| c.x as i32).collect();
        let mut unique = xs.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), xs.len(), "unplaced controls overlap: {xs:?}");
    }

    /// **The picture reports the key; it does not decide it.**
    ///
    /// This crate does not link the key vocabulary at runtime — its Cargo.toml
    /// keeps `ksx-core` a dev dependency and says why — so a key arrives from
    /// the saved layout and leaves for `bind` unchanged. Re-deciding it here
    /// would put a second opinion about what a key is into the one crate built
    /// not to have one, and a stale Studio would then quietly drop keys a newer
    /// backend can honour.
    ///
    /// Absence is the one thing it does read, because Unassigned is a real
    /// state on a panel: that terminal is wired to nothing and cannot bind.
    #[test]
    fn a_key_is_carried_not_judged() {
        let profile = profile_of(vec![
            ("1sw1", Some("A")),
            ("1sw2", None),
            ("1sw3", Some("  B  ")),
            ("1sw4", Some("SomethingOnlyANewerBackendKnows")),
        ]);
        let board = Board::encoder_from_profile(&profile);

        assert_eq!(board.cells.len(), 4, "the control stays on the picture");
        let keys: Vec<&str> = board.cells.iter().map(|c| c.key.as_str()).collect();
        assert_eq!(
            keys,
            vec!["A", "", "B", "SomethingOnlyANewerBackendKnows"],
            "keys are trimmed and otherwise untouched"
        );

        // The test build CAN see the vocabulary, so it pins the real claim:
        // what this build recognises survives the trip byte-for-byte.
        for name in ["A", "B"] {
            assert!(
                ksx_core::Key::from_name(name).is_some(),
                "{name:?} should be a key this build receives"
            );
        }
    }

    /// Two controls that share a cell are one control the user cannot press.
    /// The shipped board has [`cells_in_a_row_never_overlap`]; a panel has to
    /// hold across the whole plate, because its bands are laid out by hand.
    #[test]
    fn panel_controls_never_overlap() {
        let profile = profile_of(ipac4_ids().iter().map(|id| (id.as_str(), None)).collect());
        let board = Board::encoder_from_profile(&profile);

        for (i, a) in board.cells.iter().enumerate() {
            for b in board.cells.iter().skip(i + 1) {
                let apart = a.x + a.w <= b.x + 0.01
                    || b.x + b.w <= a.x + 0.01
                    || a.y + a.h <= b.y + 0.01
                    || b.y + b.h <= a.y + 0.01;
                assert!(apart, "{} overlaps {}", a.id, b.id);
            }
        }
        let (w, h) = board.bounds;
        assert!(
            w > 0.0 && h > 0.0 && h > w,
            "a four-player plate is taller than it is wide: {w}x{h}"
        );
    }

    /// The id scheme is the backend vocabulary, and this crate parses it.
    /// If `panel_programming` ever renames a terminal, this is where it shows.
    #[test]
    fn every_shipped_terminal_id_parses() {
        for id in ipac4_ids() {
            let (player, role) = parse_terminal(&id);
            assert!(player.is_some(), "{id} has no player");
            assert_ne!(role, TerminalRole::Unknown, "{id} did not parse to a role");
        }
        assert_eq!(parse_terminal("1UP"), (Some(1), TerminalRole::Up));
        assert_eq!(parse_terminal("3sw7"), (Some(3), TerminalRole::Switch(7)));
        assert_eq!(parse_terminal("nonsense").1, TerminalRole::Unknown);
    }

    /// A board swap must not change what the backend sees. Same keys, two
    /// pictures — this is the claim the whole plan rests on.
    #[test]
    fn two_boards_can_offer_the_same_keys() {
        let qwerty = Board::shipped_qwerty();
        let letter = |b: &Board| {
            b.cells
                .iter()
                .find(|c| c.key == "A")
                .map(|c| (c.key.clone(), c.cap.clone()))
        };
        let panel = Board::encoder_from_profile(&profile_of(vec![("1sw1", Some("A"))]));

        let (qk, qc) = letter(&qwerty).expect("the shipped board has A");
        let (pk, pc) = letter(&panel).expect("the panel emits A");
        assert_eq!(qk, pk, "identity is the same on both pictures");
        assert_ne!(qc, pc, "the caption is not: {qc:?} vs {pc:?}");
    }

    // ───────────────────────────────────────────────────────────────────
    // The roster and what gets drawn
    // ───────────────────────────────────────────────────────────────────

    fn saved(id: &str, name: &str) -> ksx_api::PanelHardwareProfile {
        let mut p = profile_of(
            ipac4_ids()
                .iter()
                .map(|i| (i.as_str(), Some("A")))
                .collect(),
        );
        p.profile_id = id.to_owned();
        p.name = name.to_owned();
        p
    }

    /// **A recognised encoder opens on its own panel.** That is the whole point
    /// of recognising it — somebody who plugged in a cabinet should see a
    /// cabinet, not have to go and find it.
    #[test]
    fn an_encoder_with_a_saved_layout_opens_on_it() {
        let profiles = vec![saved("cab-01", "Upright")];
        let board = Board::resolve("", &profiles, true);
        assert_eq!(board.id, "panel:cab-01");
        assert_eq!(board.origin, BoardOrigin::Recognized);
    }

    /// **And a keyboard never does.** A keyboard stays a keyboard: there is
    /// nothing about plugging one in that should turn the picture into an
    /// arcade panel, which was the backwards half of the original design.
    #[test]
    fn a_keyboard_never_opens_on_a_panel() {
        let profiles = vec![saved("cab-01", "Upright")];
        let board = Board::resolve("", &profiles, false);
        assert_eq!(board.id, Board::shipped_qwerty().id);
    }

    /// An encoder with nothing saved gets the keyboard, because ksx cannot draw
    /// a panel it has never been told about. The picker says why in its own
    /// sentence rather than showing an empty plate.
    #[test]
    fn an_encoder_without_a_layout_gets_the_keyboard() {
        let board = Board::resolve("", &[], true);
        assert_eq!(board.id, Board::shipped_qwerty().id);
        assert!(!board.cells.is_empty(), "the fallback must draw something");
    }

    /// **A choice this build cannot honour falls back rather than blanking.**
    ///
    /// A config written by a newer Studio, or naming a layout deleted since it
    /// was chosen, must not leave the page with no picture on it. The keyboard
    /// is the one board that always works.
    #[test]
    fn a_board_that_no_longer_exists_falls_back_to_the_keyboard() {
        let profiles = vec![saved("cab-01", "Upright")];
        for choice in ["panel:deleted", "panel:", "something-newer"] {
            let board = Board::resolve(choice, &profiles, true);
            assert_eq!(
                board.id,
                Board::shipped_qwerty().id,
                "{choice:?} should have fallen back to the keyboard"
            );
        }

        // Whitespace is not a broken id — it trims to empty, which means
        // "follow the hardware" and is a real answer, not a fallback.
        assert_eq!(Board::resolve("  ", &profiles, true).id, "panel:cab-01");
    }

    /// Either board can be asked for outright, whatever is plugged in. Nothing
    /// is forced and nothing is hidden.
    #[test]
    fn every_board_can_be_picked_against_any_hardware() {
        let profiles = vec![saved("cab-01", "Upright")];
        for staged in [true, false] {
            assert_eq!(
                Board::resolve(QWERTY_ID, &profiles, staged).id,
                Board::shipped_qwerty().id
            );
            assert_eq!(
                Board::resolve("panel:cab-01", &profiles, staged).id,
                "panel:cab-01"
            );
        }
    }

    /// The roster offers the keyboard plus every saved layout, in that order,
    /// with ids the picker can post back.
    #[test]
    fn the_roster_offers_the_keyboard_and_every_saved_layout() {
        let profiles = vec![saved("cab-01", "Upright"), saved("cab-02", "Cocktail")];
        let rows = Board::roster(&profiles);

        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec![QWERTY_ID, "panel:cab-01", "panel:cab-02"]);
        assert_eq!(rows[1].name, "Upright");
        assert!(
            rows.iter()
                .all(|r| !r.id.is_empty() && !r.detail.is_empty()),
            "every row must be postable and must say what it is"
        );
        // Every id the roster offers must actually resolve to that board —
        // a picker row that cannot be honoured is a control that does nothing.
        for row in &rows {
            assert_eq!(
                Board::resolve(&row.id, &profiles, true).id,
                row.id,
                "the roster offered {:?} but resolve would not draw it",
                row.id
            );
        }
    }

    /// With nothing saved there is exactly one board, and it is the keyboard.
    /// The arcade case is a SENTENCE, never a dead row: a submit button that
    /// refuses to do anything is the greyed-out-step antipattern, and this one
    /// would post the empty id, which already means something else.
    #[test]
    fn an_unavailable_board_is_not_offered_as_a_dead_row() {
        let rows = Board::roster(&[]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, QWERTY_ID);
    }
}
