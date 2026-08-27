//! **Boards somebody drew.** Pictures to map on, stored under `<root>\boards`.
//!
//! # Why this is not `panel_profiles`
//!
//! The obvious move is to reuse the saved-encoder-layout store, and it cannot
//! work. That store answers *"what does terminal `1sw3` emit on this physical
//! I-PAC 4"*, and its whole contract is that a layout can be **programmed onto**
//! a board — which is why `normalize_terminals` refuses anything that is not
//! exactly the 56 real terminal ids, and why nothing in
//! [`ksx_api::PanelHardwareTerminal`] carries geometry.
//!
//! A drawn board answers a different question: *"there is a 30mm button here,
//! labelled 1, that sends LeftCtrl"*. Arbitrary controls at arbitrary places,
//! which no encoder can be programmed with. Putting one in the other store
//! would either be refused outright or would quietly corrupt what a saved
//! layout means.
//!
//! What the two DO share is the discipline, so that is what is reused rather
//! than reimplemented: [`crate::panel_profiles::StoreLease`] for the
//! cross-process compare-and-replace, and
//! [`crate::panel_profiles::write_atomic`] so a reader never sees a torn
//! document.
//!
//! # What a board is worth checking for
//!
//! Little, and deliberately — but the KEY is checked here, and that is not a
//! detail. The Studio owns the drawing vocabulary (which shapes exist) and
//! cannot own the key one: it does not link `ksx-core` at runtime, by design.
//! So a key that resolves to nothing has to be refused at this door, or it is
//! stored, drawn, looks bound, and matches nothing forever. That is the exact
//! hole `controlSurface.ts`'s `cleanInput` leaves open today, and closing it
//! here closes it for every client at once.
//!
//! The rest is only what would make a document unreadable or unrenderable
//! LATER: a name it cannot file, bounds that would make every percentage
//! divide by zero, a control outside the bounds it claims, and duplicate
//! control ids — which would make two controls indistinguishable to every
//! later edit.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use ksx_api::{
    BoardControl, BoardDeleteSpec, BoardDocument, BoardMutationView, BoardSaveSpec, BoardsView,
    Refusal,
};
use ksx_config::{ConfigRoot, Timestamp};
use ksx_platform::sha256::{hex_upper, Sha256};

use crate::panel_profiles::{write_atomic, StoreLease};

/// The noun a lease refusal uses for this store.
const DRAWN_BOARDS: &str = "boards you drew";

const BOARD_SCHEMA: &str = "ksx.board/1";
const BOARD_EXTENSION: &str = ".ksxboard.json";

/// A board with no controls is a blank picture; one with thousands is a
/// document nothing can render. Neither is worth storing, and the ceiling is
/// what stops a runaway client filling the config root.
const MAX_CONTROLS: usize = 512;

fn bad_request(message: impl Into<String>, remedy: impl Into<String>) -> Refusal {
    Refusal::with_remedy(ksx_api::codes::BAD_REQUEST, message, remedy)
}

fn store_refusal(message: impl Into<String>) -> Refusal {
    Refusal::with_remedy(
        ksx_api::codes::REFUSED,
        message,
        "make sure KSX can read and write its boards folder, then try again",
    )
}

fn root() -> Result<ConfigRoot, Refusal> {
    // The same resolution the saved encoder layouts use, so both stores land
    // under one config root and a portable install keeps its boards with it.
    ConfigRoot::discover().map_err(|error| {
        store_refusal(format!(
            "KSX could not resolve the configuration root for drawn boards: {error}"
        ))
    })
}

/// Every drawn board on this machine.
pub fn boards() -> Result<BoardsView, Refusal> {
    boards_at(&root()?)
}

/// Create or stale-safely update one drawn board.
pub fn save(spec: &BoardSaveSpec) -> Result<BoardMutationView, Refusal> {
    save_at(&root()?, spec, Timestamp::now_utc())
}

/// Delete one drawn board. Touches no hardware — there is none behind it.
pub fn delete(spec: &BoardDeleteSpec) -> Result<BoardMutationView, Refusal> {
    delete_at(&root()?, spec)
}

// ───────────────────────────────────────────────────────────────────────────
// Naming and identity
// ───────────────────────────────────────────────────────────────────────────

fn slug(name: &str) -> String {
    let mut out = String::new();
    let mut separator = false;
    for character in name.chars() {
        if character.is_ascii_alphanumeric() {
            if separator && !out.is_empty() {
                out.push('-');
            }
            separator = false;
            out.push(character.to_ascii_lowercase());
        } else {
            separator = true;
        }
        if out.len() >= 48 {
            break;
        }
    }
    let out = out.trim_matches('-');
    if out.is_empty() {
        "board".to_owned()
    } else {
        out.to_owned()
    }
}

fn safe_board_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn next_board_id(name: &str, occupied: &BTreeSet<String>) -> String {
    let base = slug(name);
    if !occupied.contains(&base) {
        return base;
    }
    for suffix in 2usize.. {
        let candidate = format!("{base}-{suffix}");
        if !occupied.contains(&candidate) && candidate.len() <= 64 {
            return candidate;
        }
    }
    unreachable!("the finite boards directory cannot occupy every usize suffix")
}

fn board_path(dir: &Path, board_id: &str) -> Result<PathBuf, Refusal> {
    if !safe_board_id(board_id) {
        return Err(bad_request(
            format!("'{board_id}' is not a board id"),
            "refresh the board list and choose the board again",
        ));
    }
    Ok(dir.join(format!("{board_id}{BOARD_EXTENSION}")))
}

fn normalize_name(name: &str) -> Result<String, Refusal> {
    let name = name.trim();
    if name.is_empty() {
        return Err(bad_request(
            "a board needs a name",
            "type a name for the board and save it again",
        ));
    }
    if name.chars().count() > 64 {
        return Err(bad_request(
            "a board name is at most 64 characters",
            "shorten the name and save it again",
        ));
    }
    if name.chars().any(|c| c.is_control()) {
        return Err(bad_request(
            "a board name cannot contain control characters",
            "retype the name and save it again",
        ));
    }
    Ok(name.to_owned())
}

// ───────────────────────────────────────────────────────────────────────────
// The document
// ───────────────────────────────────────────────────────────────────────────

fn finite(value: f32) -> bool {
    value.is_finite()
}

/// What this store refuses, and nothing more.
///
/// The Studio owns which SHAPES exist, so an unrecognised kind is stored as
/// written and drawn as a button — a newer Studio may invent one. The KEY is
/// different: the Studio cannot check it (no runtime `ksx-core`), and a key
/// that resolves to nothing would look bound forever. Everything else here is
/// what makes a document unreadable LATER.
fn normalize_controls(
    controls: &[BoardControl],
    bounds_w: f32,
    bounds_h: f32,
) -> Result<Vec<BoardControl>, Refusal> {
    if controls.is_empty() {
        return Err(bad_request(
            "a board needs at least one control",
            "add a control to the board and save it again",
        ));
    }
    if controls.len() > MAX_CONTROLS {
        return Err(bad_request(
            format!(
                "a board holds at most {MAX_CONTROLS} controls; this one has {}",
                controls.len()
            ),
            "split the panel into separate boards and save them one at a time",
        ));
    }

    let mut seen = BTreeSet::new();
    let mut out = Vec::with_capacity(controls.len());
    for control in controls {
        let id = control.id.trim();
        if id.is_empty() || id.len() > 64 {
            return Err(bad_request(
                "every control on a board needs a short id of its own",
                "redraw the control and save the board again",
            ));
        }
        // Two controls sharing an id are one control to every later edit —
        // a rename or a rebind would silently land on whichever came first.
        if !seen.insert(id.to_owned()) {
            return Err(bad_request(
                format!("two controls on this board are both called '{id}'"),
                "redraw the duplicate control and save the board again",
            ));
        }
        if !finite(control.x) || !finite(control.y) || !finite(control.w) || !finite(control.h) {
            return Err(bad_request(
                format!("control '{id}' has no place on the board"),
                "move the control back onto the board and save it again",
            ));
        }
        if control.w <= 0.0 || control.h <= 0.0 {
            return Err(bad_request(
                format!("control '{id}' has no size, so nothing could be pressed"),
                "give the control a size and save the board again",
            ));
        }
        // Outside the bounds means outside the picture: it would be stored,
        // listed, and invisible — which reads as a control that vanished.
        if control.x < 0.0
            || control.y < 0.0
            || control.x + control.w > bounds_w + 0.5
            || control.y + control.h > bounds_h + 0.5
        {
            return Err(bad_request(
                format!("control '{id}' sits outside the board it is on"),
                "move the control back onto the board and save it again",
            ));
        }
        // **The key gate.** Empty is Unassigned, a real state on a panel.
        // Anything else must be a key this build can actually receive, and
        // is stored in the canonical spelling so two boards never disagree
        // about how to write the same key.
        let key = control.key.trim();
        let key = if key.is_empty() {
            String::new()
        } else {
            match ksx_core::Key::from_name(key) {
                Some(resolved) => resolved.name().to_owned(),
                None => {
                    return Err(bad_request(
                        format!(
                            "control '{id}' sends '{key}', which is not a key ksx can receive"
                        ),
                        "press the control again to learn what it really sends, then save the board",
                    ));
                }
            }
        };
        out.push(BoardControl {
            id: id.to_owned(),
            kind: control.kind.trim().to_ascii_lowercase(),
            label: control.label.trim().to_owned(),
            key,
            player: control.player,
            x: control.x,
            y: control.y,
            w: control.w,
            h: control.h,
        });
    }
    Ok(out)
}

fn board_revision(board: &BoardDocument) -> String {
    let mut content = board.clone();
    content.revision.clear();
    let bytes =
        serde_json::to_vec(&content).unwrap_or_else(|_| format!("{content:?}").into_bytes());
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    format!("bd1-{}", hex_upper(&hasher.finish()))
}

fn validate_loaded(board: BoardDocument) -> Result<BoardDocument, Refusal> {
    if board.schema != BOARD_SCHEMA
        || !safe_board_id(&board.board_id)
        || board.created_at.trim().is_empty()
        || board.name.trim().is_empty()
        || !finite(board.bounds_w)
        || !finite(board.bounds_h)
        || board.bounds_w <= 0.0
        || board.bounds_h <= 0.0
    {
        return Err(store_refusal(format!(
            "'{}' is not a board this build can read",
            board.board_id
        )));
    }
    Ok(board)
}

fn read_board(path: &Path) -> Result<BoardDocument, Refusal> {
    let bytes = fs::read(path).map_err(|error| {
        store_refusal(format!(
            "a saved board could not be read ({}): {error}",
            path.display()
        ))
    })?;
    let board: BoardDocument = serde_json::from_slice(&bytes).map_err(|error| {
        store_refusal(format!(
            "a saved board is not readable JSON ({}): {error}",
            path.display()
        ))
    })?;
    validate_loaded(board)
}

fn list_dir(dir: &Path) -> Result<Vec<BoardDocument>, Refusal> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(dir)
        .map_err(|error| store_refusal(format!("the boards folder could not be read: {error}")))?;
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            store_refusal(format!("the boards folder could not be read: {error}"))
        })?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.ends_with(BOARD_EXTENSION) {
            continue;
        }
        out.push(read_board(&path)?);
    }
    // Alphabetical, case-insensitively: the picker shows these in order and
    // a store that reordered itself between reads would move rows under the
    // pointer.
    out.sort_by_key(|board| board.name.to_lowercase());
    Ok(out)
}

fn duplicate_name(boards: &[BoardDocument], name: &str, except_id: Option<&str>) -> bool {
    boards.iter().any(|board| {
        board.name.eq_ignore_ascii_case(name) && Some(board.board_id.as_str()) != except_id
    })
}

// ───────────────────────────────────────────────────────────────────────────
// The verbs
// ───────────────────────────────────────────────────────────────────────────

fn boards_at(root: &ConfigRoot) -> Result<BoardsView, Refusal> {
    let dir = root.boards_dir();
    let _lease = StoreLease::acquire(&dir, DRAWN_BOARDS)?;
    let boards = list_dir(&dir)?;
    Ok(BoardsView {
        summary: match boards.len() {
            0 => "No boards drawn yet.".to_owned(),
            1 => "1 board drawn.".to_owned(),
            n => format!("{n} boards drawn."),
        },
        config_root: dir.display().to_string(),
        boards,
    })
}

fn save_at(
    root: &ConfigRoot,
    spec: &BoardSaveSpec,
    timestamp: Timestamp,
) -> Result<BoardMutationView, Refusal> {
    let dir = root.boards_dir();
    let _lease = StoreLease::acquire(&dir, DRAWN_BOARDS)?;
    let existing = list_dir(&dir)?;
    let name = normalize_name(&spec.name)?;

    if !finite(spec.bounds_w)
        || !finite(spec.bounds_h)
        || spec.bounds_w <= 0.0
        || spec.bounds_h <= 0.0
    {
        return Err(bad_request(
            "a board needs a size before anything can be placed on it",
            "redraw the board and save it again",
        ));
    }
    let controls = normalize_controls(&spec.controls, spec.bounds_w, spec.bounds_h)?;
    let now = timestamp_rfc3339(timestamp);

    let (board_id, created_at, state) =
        match (spec.board_id.as_deref(), spec.expected_revision.as_deref()) {
            (None, None) => {
                if duplicate_name(&existing, &name, None) {
                    return Err(bad_request(
                        format!("a board called '{name}' already exists"),
                        "choose a distinct name, or update the existing board",
                    ));
                }
                let occupied = existing
                    .iter()
                    .map(|board| board.board_id.clone())
                    .collect();
                (next_board_id(&name, &occupied), now.clone(), "created")
            }
            (Some(board_id), Some(expected_revision)) => {
                let path = board_path(&dir, board_id)?;
                let current = read_board(&path)?;
                // The whole point of the lease plus this check: two editors
                // must not both accept revision A and let the last write win.
                if current.revision != expected_revision {
                    return Err(Refusal::with_remedy(
                        ksx_api::codes::REFUSED,
                        format!(
                            "board '{}' changed while this edit was open; nothing was written",
                            current.name
                        ),
                        "refresh the board list, review the newer board, and apply the edit again",
                    ));
                }
                if duplicate_name(&existing, &name, Some(board_id)) {
                    return Err(bad_request(
                        format!("a board called '{name}' already exists"),
                        "choose a distinct name, or update that board instead",
                    ));
                }
                (
                    current.board_id.clone(),
                    current.created_at.clone(),
                    "updated",
                )
            }
            _ => {
                return Err(bad_request(
                    "updating a board needs both its id and exact revision",
                    "refresh the board list and save the board again",
                ));
            }
        };

    let mut board = BoardDocument {
        schema: BOARD_SCHEMA.to_owned(),
        board_id,
        name: name.clone(),
        description: spec.description.trim().to_owned(),
        revision: String::new(),
        created_at,
        updated_at: now,
        bounds_w: spec.bounds_w,
        bounds_h: spec.bounds_h,
        controls,
    };
    board.revision = board_revision(&board);

    fs::create_dir_all(&dir).map_err(|error| {
        store_refusal(format!("the boards folder could not be created: {error}"))
    })?;
    let bytes = serde_json::to_vec_pretty(&board)
        .map_err(|error| store_refusal(format!("the board could not be written: {error}")))?;
    write_atomic(&board_path(&dir, &board.board_id)?, &bytes)?;

    Ok(BoardMutationView {
        state: state.to_owned(),
        board_id: board.board_id.clone(),
        name: board.name.clone(),
        revision: board.revision.clone(),
        summary: format!(
            "Board '{}' {state} with {} controls.",
            board.name,
            board.controls.len()
        ),
    })
}

fn delete_at(root: &ConfigRoot, spec: &BoardDeleteSpec) -> Result<BoardMutationView, Refusal> {
    let dir = root.boards_dir();
    let _lease = StoreLease::acquire(&dir, DRAWN_BOARDS)?;
    let path = board_path(&dir, &spec.board_id)?;
    let current = read_board(&path)?;
    if current.revision != spec.expected_revision {
        return Err(Refusal::with_remedy(
            ksx_api::codes::REFUSED,
            format!(
                "board '{}' changed since it was listed; nothing was deleted",
                current.name
            ),
            "refresh the board list and delete it again if that is still what you want",
        ));
    }
    fs::remove_file(&path)
        .map_err(|error| store_refusal(format!("the board could not be deleted: {error}")))?;
    Ok(BoardMutationView {
        state: "deleted".to_owned(),
        board_id: current.board_id.clone(),
        name: current.name.clone(),
        revision: current.revision.clone(),
        summary: format!("Board '{}' deleted.", current.name),
    })
}

/// The same spelling the saved layouts use, so the two stores never disagree
/// about what a timestamp looks like on disk.
fn timestamp_rfc3339(timestamp: Timestamp) -> String {
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        timestamp.year,
        timestamp.month,
        timestamp.day,
        timestamp.hour,
        timestamp.minute,
        timestamp.second
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn control(id: &str, key: &str, x: f32, y: f32) -> BoardControl {
        BoardControl {
            id: id.to_owned(),
            kind: "button30".to_owned(),
            label: id.to_owned(),
            key: key.to_owned(),
            player: Some(1),
            x,
            y,
            w: 40.0,
            h: 40.0,
        }
    }

    fn spec(name: &str) -> BoardSaveSpec {
        BoardSaveSpec {
            board_id: None,
            expected_revision: None,
            name: name.to_owned(),
            description: String::new(),
            bounds_w: 400.0,
            bounds_h: 200.0,
            controls: vec![control("a", "A", 0.0, 0.0), control("b", "B", 50.0, 0.0)],
        }
    }

    /// The same throwaway-directory shape `panel_profiles` uses, for the same
    /// reason: these tests take a real cross-process lease and write real
    /// files, so each needs a root nothing else is holding.
    static TEST_SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let serial = TEST_SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "ksx-boards-{}-{label}-{serial}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn temp_root(label: &str) -> (TestDir, ConfigRoot) {
        let dir = TestDir::new(label);
        let root = ConfigRoot::at(dir.0.clone());
        (dir, root)
    }

    fn at() -> Timestamp {
        Timestamp {
            year: 2026,
            month: 8,
            day: 26,
            hour: 12,
            minute: 0,
            second: 0,
        }
    }

    /// A board round-trips: saved, listed, and read back with everything that
    /// makes it drawable.
    #[test]
    fn a_drawn_board_round_trips() {
        let (_dir, root) = temp_root("round-trip");
        let created = save_at(&root, &spec("Cocktail"), at()).expect("the save");
        assert_eq!(created.state, "created");
        assert_eq!(created.board_id, "cocktail");

        let view = boards_at(&root).expect("the list");
        assert_eq!(view.boards.len(), 1);
        let board = &view.boards[0];
        assert_eq!(board.name, "Cocktail");
        assert_eq!(board.bounds_w, 400.0);
        assert_eq!(board.controls.len(), 2);
        assert_eq!(board.controls[0].key, "A");
        assert_eq!(board.revision, created.revision);
    }

    /// **The stale-write guard.** Two editors must not both accept revision A
    /// and let the last one silently win — the whole reason this store takes a
    /// lease AND a revision rather than either alone.
    #[test]
    fn an_edit_opened_against_an_older_board_is_refused() {
        let (_dir, root) = temp_root("stale");
        let created = save_at(&root, &spec("Cocktail"), at()).expect("the save");

        let mut first = spec("Cocktail");
        first.board_id = Some(created.board_id.clone());
        first.expected_revision = Some(created.revision.clone());
        first.description = "one".to_owned();
        let updated = save_at(&root, &first, at()).expect("the first update");
        assert_eq!(updated.state, "updated");

        // The second editor still holds the revision the first one replaced.
        let mut second = spec("Cocktail");
        second.board_id = Some(created.board_id.clone());
        second.expected_revision = Some(created.revision);
        second.description = "two".to_owned();
        let refusal = save_at(&root, &second, at()).expect_err("a stale write must refuse");
        assert!(
            refusal.message.contains("changed while this edit was open"),
            "unexpected refusal: {}",
            refusal.message
        );

        let view = boards_at(&root).expect("the list");
        assert_eq!(view.boards[0].description, "one", "the loser must not win");
    }

    /// **A control outside its board would be stored, listed and invisible** —
    /// which reads as a control that vanished, with nothing on screen to say
    /// why. It is refused at the door instead.
    #[test]
    fn a_control_off_the_board_is_refused() {
        let (_dir, root) = temp_root("off-board");
        let mut off = spec("Cocktail");
        off.controls[1].x = 900.0;
        let refusal = save_at(&root, &off, at()).expect_err("an off-board control must refuse");
        assert!(
            refusal.message.contains("outside the board"),
            "unexpected refusal: {}",
            refusal.message
        );
    }

    /// Two controls sharing an id are one control to every later edit: a
    /// rename or a rebind would silently land on whichever came first.
    #[test]
    fn two_controls_cannot_share_an_id() {
        let (_dir, root) = temp_root("dup-id");
        let mut clash = spec("Cocktail");
        clash.controls[1].id = "a".to_owned();
        let refusal = save_at(&root, &clash, at()).expect_err("a duplicate id must refuse");
        assert!(
            refusal.message.contains("both called"),
            "unexpected refusal: {}",
            refusal.message
        );
    }

    /// Zero bounds would make every percentage the page computes divide by
    /// zero, and the board would render as a pile in one corner.
    #[test]
    fn a_board_with_no_size_is_refused() {
        let (_dir, root) = temp_root("no-size");
        let mut flat = spec("Cocktail");
        flat.bounds_w = 0.0;
        assert!(
            save_at(&root, &flat, at()).is_err(),
            "zero width must refuse"
        );

        let mut empty = spec("Cocktail");
        empty.controls.clear();
        assert!(
            save_at(&root, &empty, at()).is_err(),
            "a board with nothing on it must refuse"
        );
    }

    /// Names are how a person tells two boards apart in the picker.
    #[test]
    fn two_boards_cannot_share_a_name() {
        let (_dir, root) = temp_root("dup-name");
        save_at(&root, &spec("Cocktail"), at()).expect("the first");
        let refusal = save_at(&root, &spec("cocktail"), at()).expect_err("a duplicate must refuse");
        assert!(
            refusal.message.contains("already exists"),
            "unexpected refusal: {}",
            refusal.message
        );
    }

    /// Delete takes the same revision guard as update: a board that changed
    /// since it was listed is not the board the user chose to remove.
    #[test]
    fn delete_refuses_a_board_that_changed_since_it_was_listed() {
        let (_dir, root) = temp_root("delete");
        let created = save_at(&root, &spec("Cocktail"), at()).expect("the save");

        let stale = BoardDeleteSpec {
            board_id: created.board_id.clone(),
            expected_revision: "bd1-NOPE".to_owned(),
        };
        assert!(
            delete_at(&root, &stale).is_err(),
            "a stale delete must refuse"
        );

        let good = BoardDeleteSpec {
            board_id: created.board_id,
            expected_revision: created.revision,
        };
        let done = delete_at(&root, &good).expect("the delete");
        assert_eq!(done.state, "deleted");
        assert!(boards_at(&root).expect("the list").boards.is_empty());
    }

    /// An empty store is not an error — it is somebody who has not drawn one.
    #[test]
    fn no_boards_yet_is_not_a_failure() {
        let (_dir, root) = temp_root("empty");
        let view = boards_at(&root).expect("an empty store still reads");
        assert!(view.boards.is_empty());
        assert!(view.summary.contains("No boards"));
    }

    /// **A board id becomes a filename**, so anything that could walk out of
    /// the boards folder is refused before it ever reaches a path.
    #[test]
    fn a_board_id_can_never_leave_its_folder() {
        let hostile = [
            "../escape",
            r"..\escape",
            "a/b",
            r"C:\evil",
            "",
            "UPPER",
            "sp ace",
        ];
        for hostile in hostile {
            assert!(
                !safe_board_id(hostile),
                "{hostile:?} was accepted as a board id"
            );
            assert!(
                board_path(Path::new("."), hostile).is_err(),
                "{hostile:?} was turned into a path"
            );
        }
        assert!(safe_board_id("tournament-cab-2"));
    }

    /// An update needs BOTH halves of its identity. One alone is a client that
    /// has lost track of what it is editing, and guessing would overwrite a
    /// board the user never opened.
    #[test]
    fn a_half_identified_update_is_refused() {
        let dir = TestDir::new("half");
        let root = ConfigRoot::at(&dir.0);
        let created = save_at(&root, &spec("Cab"), at()).unwrap();

        let mut only_id = spec("Cab");
        only_id.board_id = Some(created.board_id.clone());
        assert!(save_at(&root, &only_id, at())
            .unwrap_err()
            .message
            .contains("id and exact revision"));

        let mut only_revision = spec("Cab");
        only_revision.expected_revision = Some(created.revision);
        assert!(save_at(&root, &only_revision, at())
            .unwrap_err()
            .message
            .contains("id and exact revision"));
    }

    /// **A key that resolves to nothing is refused at this door.**
    ///
    /// It is the only vocabulary check this store makes, and it earns its place:
    /// the Studio cannot make it — ksx-studio deliberately does not link
    /// `ksx-core` at runtime — and `controlSurface.ts`'s `cleanInput` accepts any
    /// string at all. Without this a typo is stored, drawn, looks bound, and
    /// matches nothing for as long as the board exists.
    ///
    /// Empty is NOT a typo: Unassigned is a real state on a panel.
    #[test]
    fn a_key_nothing_can_receive_is_refused() {
        let dir = TestDir::new("keygate");
        let root = ConfigRoot::at(&dir.0);

        let mut typo = spec("Typo");
        typo.controls = vec![control("c1", "Ay", 0.0, 0.0)];
        let refusal = save_at(&root, &typo, at()).unwrap_err();
        assert!(
            refusal.message.contains("not a key ksx can receive"),
            "the refusal must name the problem: {}",
            refusal.message
        );
        assert!(
            boards_at(&root).unwrap().boards.is_empty(),
            "nothing stored"
        );

        // Unassigned is fine, and stays empty rather than becoming a guess.
        let mut unassigned = spec("Unassigned");
        unassigned.controls = vec![control("c1", "", 0.0, 0.0)];
        save_at(&root, &unassigned, at()).expect("Unassigned is a real state");
        let stored = &boards_at(&root).unwrap().boards[0];
        assert_eq!(stored.controls[0].key, "");
    }

    /// The stored key is the CANONICAL spelling, so two boards never disagree
    /// about how to write the same key.
    #[test]
    fn a_key_is_stored_the_one_way_ksx_spells_it() {
        let dir = TestDir::new("canonical");
        let root = ConfigRoot::at(&dir.0);
        let mut padded = spec("Padded");
        padded.controls = vec![control("c1", "  A  ", 0.0, 0.0)];
        save_at(&root, &padded, at()).unwrap();
        assert_eq!(boards_at(&root).unwrap().boards[0].controls[0].key, "A");
    }
}
