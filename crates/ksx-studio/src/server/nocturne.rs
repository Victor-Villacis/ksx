//! `/nocturne` — the legacy product surface retained for the settings and
//! library blocks that have not yet been redesigned.
//!
//! Shared device selection, identify-by-key, capture, controller mapping,
//! learner, macro, and session lifecycle behavior lives in [`super::workbench`].
//! This module owns Nocturne's route adapters plus the deferred games, layouts,
//! import/export, autostart, and custom-board operations. Keeping that boundary
//! explicit lets `/redesign` evolve without depending on legacy handlers.

use super::workbench::{
    self as wb, checked, StartIdentifyResult, N_ADD_LAYOUT_ERROR, N_ADOPT_BLOCKED, N_ADOPT_OK,
    N_APPLY_ERROR, N_APPLY_OK, N_APPLY_RESTART, N_BLOCKING_OK, N_CAPTURE_ALREADY_PREPARED,
    N_CAPTURE_ALREADY_RELEASED, N_CAPTURE_PREPARED_OK, N_CAPTURE_PREPARED_STAGE_CHANGED,
    N_CAPTURE_PREPARE_CONSENT, N_CAPTURE_PREPARE_ERROR, N_CAPTURE_PREPARE_RECOVERY,
    N_CAPTURE_RELEASED_OK, N_CAPTURE_RELEASED_STAGE_CHANGED, N_CAPTURE_RELEASE_CONSENT,
    N_CAPTURE_RELEASE_ERROR, N_CAPTURE_RELEASE_RECOVERY, N_CAPTURE_TARGET_CHANGED, N_CLEAR_ALL_OK,
    N_DEVICE_ALREADY_OK, N_DEVICE_OK, N_DISCARD_OK, N_DUP_FULL, N_DUP_OK, N_EDIT_ERROR, N_EDIT_OK,
    N_FORM_UNREADABLE, N_IDENTIFY_ERROR, N_IDENTIFY_OK, N_IDENTIFY_TIMEOUT, N_KEY_CLEAR_NONE,
    N_KEY_CLEAR_OK, N_MACRO_BADNAME, N_MACRO_DELETED, N_MACRO_NAME, N_MACRO_NEW, N_MACRO_OK,
    N_MACRO_TAKEN, N_MOVE_AT_END, N_PLAY_BLOCKING, N_PLAY_CAPTURE, N_PLAY_ERROR,
    N_PLAY_NO_BINDINGS, N_PLAY_NO_DEVICE, N_PLAY_NO_SLOTS, N_PLAY_OK, N_PLAY_OUTPUT_BLOCKED,
    N_PLAY_OUTPUT_UNKNOWN, N_READ_SCAN_ERROR, N_READ_SETUP_ERROR, N_SAVE_BLOCKING, N_SAVE_CAPTURE,
    N_SAVE_ERROR, N_SAVE_NO_BINDINGS, N_SAVE_NO_DEVICE, N_SAVE_NO_SLOTS, N_SAVE_OK, N_STOP_ERROR,
    N_STOP_OK, N_THEME_OK, N_THEME_UNKNOWN, N_TOGGLE_OK, N_TOGGLE_OLD_DAEMON,
    N_TOGGLE_UNBOUND_ERROR, N_TURBO_INPUT_ERROR, N_TURBO_OK, N_TURBO_UNBOUND_ERROR, N_UNDO_FULL,
    N_UNDO_GONE, N_UNDO_OK, N_UNKNOWN_FLASH_ERROR,
};
use super::*;

use crate::render_nocturne::render_nocturne;
use crate::snapshot::NocturnePayload;

// ── The flash allowlist — /start's discipline, this page's copy ─────────────
//
// A query string is user-controlled even when our own POST produced it; only
// copy this module can emit is reflected back onto the page. The capture
// sentences moved verbatim from `/start` — they were written for exactly
// these transactions and renaming the page does not change what happened.

pub(super) const N_BOARD_OK: &str = "Board updated.";
pub(super) const N_BOARD_MISSING: &str = "the form did not say which board — pick one on the page";
/// Shown when the board store itself refuses — the folder is unreadable, a
/// saved board is corrupt, or another writer holds it. Authored here because
/// the store's own text for those carries an absolute path and raw io/serde
/// detail, and this string is announced through an aria-live region.
pub(super) const N_BOARD_STORE_ERROR: &str =
    "The board could not be published — ksx could not use its boards folder.";

/// Success lines for the migrated saved-game and layout verbs. Named rather
/// than written at the call site so they can sit in [`N_FLASH_ALLOWLIST`] —
/// a flash that is not on that list renders as the generic fallback with
/// scripting off, which is how every one of these verbs silently lost its
/// sentence when it moved onto /nocturne.
pub(super) const N_GAME_ADD_OK: &str = "Saved game added.";
pub(super) const N_GAME_UPDATE_OK: &str = "Saved game updated.";
pub(super) const N_GAME_DELETE_OK: &str = "Saved game removed.";
pub(super) const N_LAYOUT_RENAME_OK: &str = "Layout renamed.";
pub(super) const N_LAYOUT_DELETE_OK: &str = "Layout deleted.";
pub(super) const N_IMPORT_UNREADABLE: &str =
    "error: That document could not be read — it may be larger than this page accepts (8 MB).";
pub(super) const N_IMPORT_EMPTY: &str =
    "error: Nothing to import — paste a configuration into the box first.";

/// Owned copy for the saved-game and layout verbs. Every one of these was a
/// constant on the deleted /profiles page, and they come back with the verbs:
/// a surface presents its OWN sentence for an outcome, never the provider's.
pub(super) const N_GAME_ADD_ERROR: &str = "error: Saved game could not be added. Check the game \
     name, program location, players, and controller layout; nothing was changed.";
pub(super) const N_GAME_UPDATE_ERROR: &str = "error: Saved game could not be updated. Reopen this \
     screen, then check its details; nothing was changed.";
pub(super) const N_GAME_DELETE_ERROR: &str = "error: Saved game could not be removed. Reopen this \
     screen and try again; nothing was changed.";
pub(super) const N_LAYOUT_RENAME_ERROR: &str = "error: Controller layout could not be renamed. \
     Choose a new name that is not already taken; nothing was changed.";
/// Names the guard, not a generic failure: with no force on this form, a
/// delete that fails is a delete something still uses, and "point those
/// controllers elsewhere" is the step that unblocks it.
pub(super) const N_LAYOUT_DELETE_ERROR: &str = "error: Controller layout could not be deleted. \
     Controllers still using it must be pointed at another layout first; nothing was changed.";

pub(super) const N_BOARD_UNKNOWN: &str = "error: That is not a board this build can draw. Pick \
     one from the list; nothing was changed.";

/// Tick-box refusals for the two destructive configuration verbs. Server-side,
/// because a browser dialog is an interaction nicety and not a boundary.
pub(super) const N_GAME_DELETE_UNCONFIRMED: &str =
    "error: Tick the confirmation box to remove a saved game. Nothing was changed.";
pub(super) const N_LAYOUT_DELETE_UNCONFIRMED: &str =
    "error: Tick the confirmation box to delete a layout. Nothing was changed.";

// The sign-in task's five sentences, moved VERBATIM from `/start` — they were
// written for exactly this transaction and the menu does not change what
// happens at sign-in.

pub(super) const N_AUTOSTART_ON: &str =
    "ksx will now start when you sign in. Restart once to see it come up on its own.";

pub(super) const N_AUTOSTART_OFF: &str =
    "ksx will no longer start on its own. Open it yourself after a restart.";

pub(super) const N_AUTOSTART_CONSENT: &str =
    "error: Nothing was changed. Tick the box first to confirm what happens at sign-in.";

/// Windows accepted the registration and it is STILL pointing somewhere else.
/// Its own sentence, not folded into the error: the task now exists, so
/// "nothing was changed" would be false, and so would "done".
pub(super) const N_AUTOSTART_STILL_STALE: &str =
    "error: The sign-in task was written, but it is still out of date. Reload this page to see what it says now.";

pub(super) const N_AUTOSTART_ERROR: &str =
    "error: What happens at sign-in could not be changed. Nothing was changed; try again.";

pub(super) const N_AUTOSTART_DEV_RUNTIME: &str = "error: This development build cannot change the installed sign-in task. Nothing was changed; install the complete candidate to test startup behavior.";

/// "How many players" arrives as TEXT so an empty box can be answered in
/// words rather than by the extractor. Two things the migrated version lost:
/// the `error:` marker (`applyFlash` picks the red side on that alone, so a
/// rejected player count painted in the SUCCESS colour) and a place on
/// [`N_FLASH_ALLOWLIST`] (without which a browser with scripting off reads
/// the generic "could not be finished" instead of the one thing that is
/// actually wrong with the form in front of it).
pub(super) const N_GAME_SLOTS_ERROR: &str =
    "error: How many players must be a whole number. Nothing was changed.";

// ── Save and Play refuse in THIS page's words ──────────────────────────────
//
// The daemon composes a refusal with an `error`, a stable `code` and often a
// `remedy`, and all three are written for an operator: `StageRefusal` names
// `slot 1`, `Persona::backend()`, `ksx_core::MAX_SLOTS` and file paths. Those
// are right for a log and wrong for the sentence under a button. Worse, they
// are not on the allowlist, so with scripting off the specific reason
// degraded to the generic "could not be finished" anyway — the boundary was
// costing us the sentence AND leaking the internals.
//
// So the CODE selects one of this page's own sentences. Save and Play get
// separate copy for every code deliberately: the promise at the end differs
// ("nothing was written" / "nothing was started"), and a shared line would
// have to drop the half that says what did not happen.

pub(super) const N_FLASH_ALLOWLIST: [&str; 95] = [
    // Save and Play's own refusals. They are composed from a stable daemon
    // CODE rather than from the daemon's sentence, precisely so they can sit
    // on this list — a refusal that only exists at runtime cannot be
    // reflected, and every one of these was invisible with scripting off.
    N_SAVE_BLOCKING,
    N_PLAY_BLOCKING,
    N_SAVE_NO_BINDINGS,
    N_PLAY_NO_BINDINGS,
    N_SAVE_NO_DEVICE,
    N_PLAY_NO_DEVICE,
    N_SAVE_NO_SLOTS,
    N_PLAY_NO_SLOTS,
    N_SAVE_CAPTURE,
    N_PLAY_CAPTURE,
    N_PLAY_OUTPUT_BLOCKED,
    N_PLAY_OUTPUT_UNKNOWN,
    N_GAME_SLOTS_ERROR,
    N_FORM_UNREADABLE,
    // The verbs migrated from /setup and /profiles. Absent from this list,
    // each rendered as N_UNKNOWN_FLASH_ERROR with scripting off — the page
    // said "that request could not be finished" after a write that had in
    // fact succeeded.
    N_GAME_ADD_OK,
    N_GAME_UPDATE_OK,
    N_GAME_DELETE_OK,
    N_LAYOUT_RENAME_OK,
    N_LAYOUT_DELETE_OK,
    N_THEME_OK,
    N_BOARD_OK,
    N_BOARD_MISSING,
    N_GAME_ADD_ERROR,
    N_GAME_UPDATE_ERROR,
    N_GAME_DELETE_ERROR,
    N_LAYOUT_RENAME_ERROR,
    N_LAYOUT_DELETE_ERROR,
    N_GAME_DELETE_UNCONFIRMED,
    N_LAYOUT_DELETE_UNCONFIRMED,
    N_THEME_UNKNOWN,
    N_BOARD_UNKNOWN,
    N_IMPORT_UNREADABLE,
    N_IMPORT_EMPTY,
    N_MOVE_AT_END,
    N_TOGGLE_OLD_DAEMON,
    N_CLEAR_ALL_OK,
    N_KEY_CLEAR_OK,
    N_KEY_CLEAR_NONE,
    N_UNDO_OK,
    N_UNDO_GONE,
    N_UNDO_FULL,
    N_APPLY_OK,
    N_APPLY_RESTART,
    N_APPLY_ERROR,
    N_MACRO_OK,
    N_MACRO_NEW,
    N_MACRO_NAME,
    N_MACRO_TAKEN,
    N_MACRO_BADNAME,
    N_MACRO_DELETED,
    N_ADOPT_OK,
    N_ADOPT_BLOCKED,
    N_DISCARD_OK,
    N_AUTOSTART_ON,
    N_AUTOSTART_OFF,
    N_AUTOSTART_CONSENT,
    N_AUTOSTART_STILL_STALE,
    N_AUTOSTART_ERROR,
    N_AUTOSTART_DEV_RUNTIME,
    N_TURBO_OK,
    N_TURBO_INPUT_ERROR,
    N_TURBO_UNBOUND_ERROR,
    N_TOGGLE_OK,
    N_TOGGLE_UNBOUND_ERROR,
    N_DEVICE_OK,
    N_DEVICE_ALREADY_OK,
    N_BLOCKING_OK,
    N_EDIT_OK,
    N_ADD_LAYOUT_ERROR,
    N_DUP_OK,
    N_DUP_FULL,
    N_SAVE_OK,
    N_SAVE_ERROR,
    N_PLAY_OK,
    N_PLAY_ERROR,
    N_STOP_OK,
    N_STOP_ERROR,
    N_EDIT_ERROR,
    N_IDENTIFY_OK,
    N_IDENTIFY_TIMEOUT,
    N_IDENTIFY_ERROR,
    N_CAPTURE_PREPARED_OK,
    N_CAPTURE_RELEASED_OK,
    N_CAPTURE_PREPARE_CONSENT,
    N_CAPTURE_RELEASE_CONSENT,
    N_CAPTURE_TARGET_CHANGED,
    N_CAPTURE_ALREADY_PREPARED,
    N_CAPTURE_ALREADY_RELEASED,
    N_CAPTURE_PREPARE_ERROR,
    N_CAPTURE_RELEASE_ERROR,
    N_CAPTURE_PREPARE_RECOVERY,
    N_CAPTURE_RELEASE_RECOVERY,
    N_CAPTURE_PREPARED_STAGE_CHANGED,
    N_CAPTURE_RELEASED_STAGE_CHANGED,
    N_UNKNOWN_FLASH_ERROR,
];

pub(super) fn nocturne_flash_from_query(flash: Option<&str>) -> Option<String> {
    let flash = flash?.trim();
    if flash.is_empty() {
        return None;
    }
    Some(
        N_FLASH_ALLOWLIST
            .into_iter()
            .find(|safe| *safe == flash)
            .unwrap_or(N_UNKNOWN_FLASH_ERROR)
            .to_owned(),
    )
}

/// A form this page might not be able to read.
///
/// **Not pedantry.** The island fetch-submits and reads its outcome out of the
/// redirect's `?flash=`; axum's own rejection is a 422 with NO `Location`, so
/// the page shows nothing whatsoever and the user is left pressing a button
/// that appears to do nothing. And the bodies that take that arm are ones
/// this page SERVES: `<input type="hidden" name="number" value="">` on the
/// clear-all fold whenever no slot is selected, the same on the macro
/// lifecycle forms and the SOCD editor. Every handler whose form has a
/// required field takes this instead of `Form<T>` and answers in a sentence.
type NocturneForm<T> = Result<Form<T>, axum::extract::rejection::FormRejection>;

fn nocturne_redirect(flash: &str) -> Response {
    Redirect::to(&format!("/nocturne?flash={}", urlencode(flash))).into_response()
}

// ── The page's own words for a read that refused ───────────────────────────
//
// A refused read is NOT an empty machine, and it is not a place to print the
// provider's diagnostics either. `flash_of` composes an operator's line —
// it appends the refusal's `remedy` to a `message` that, for
// `Refusal::not_here`, already ENDS in that same remedy, so the config menu
// read `… is not available on this surface — run \`ksx setup\` — run \`ksx
// setup\`` on screen. A TOML parse failure printed `expected \`=\` at line 4`
// under the saved-games list. Both are the same defect: the provider's text
// crossing the presentation boundary (`verb_flash`'s rule, applied to the
// READS as well as to the writes).
//
// These sentences say which resource could not be read and what to do, and
// nothing else. The typed detail stays available to the poller through the
// payload's own `scan` / `setup` / `games` / `autostart_read` being empty or
// null beside a non-empty `*_error`, which is how a machine tells a refused
// read from an empty one.

pub(super) const N_READ_GAMES_ERROR: &str =
    "Saved games could not be read. Reopen ksx and try again.";
pub(super) const N_READ_AUTOSTART_ERROR: &str =
    "What happens at sign-in could not be read. Reopen ksx and try again.";
/// Rendered as customer copy under the board picker, so it says what could
/// not be read rather than carrying a store diagnostic onto the page.
pub(super) const N_READ_PANELS_ERROR: &str =
    "Saved panel layouts could not be read, so only the keyboard is offered here.";
/// Rendered under the board picker when the drawn-board store refuses. Its own
/// sentence, because it is its own store: the saved panel layouts can be
/// perfectly readable while this one is not.
pub(super) const N_READ_BOARDS_ERROR: &str =
    "Boards you drew could not be read, so they are missing from this list.";

/// The daemon-down banner, in the page's one status region.
///
/// FIX 1's rule survived the cutover as a requirement and not as code: quit
/// the helper and `/nocturne` still opened onto a live-looking device list, an
/// empty rack, and one collapsed `<details>` chip reading "Draft unavailable".
/// Nothing above the fold said the thing the whole page edits is gone. This
/// sentence is served into `nFlashLine` — `role="status"`, immediately above
/// `<main>` — whenever the draft cannot be reached and no action flash of its
/// own is competing for the slot.
pub(super) const N_DAEMON_DOWN: &str = "error: This screen needs the ksx background helper, and \
     it is not answering. Close and reopen ksx; nothing on this page has been changed, and \
     nothing you do here can take effect until it is back.";

// ── The reads ───────────────────────────────────────────────────────────────

/// One fresh payload: the staged setup and the device enumeration, each
/// degrading to its own honest value (`SURFACES.md` §1b). Never cached — a
/// keyboard plugged in while the page is open appears at the next poll.
pub(super) async fn collect_nocturne(
    state: &Arc<AppState>,
    slot: Option<u8>,
    q: Option<String>,
    macro_selected: Option<String>,
) -> NocturnePayload {
    let state = Arc::clone(state);
    // Provenance is the one fact a failed collection must retain. Capturing it
    // before the blocking task means a fixture-side panic keeps its exact
    // fixture id instead of degrading to unknown provenance in the title bar.
    let environment = state.source.environment();
    let fallback_environment = environment.clone();
    tokio::task::spawn_blocking(move || {
        let staged = state.control.staged();
        let session = state.control.session();
        let (scan, unavailable) = match state.machine_cache.device_scan(&*state.machine) {
            Ok(scan) => (scan, String::new()),
            // Same boundary as the three reads below: `unavailable` non-empty
            // is what makes every count on the left pane say "unavailable"
            // instead of zero, and its TEXT is printed under the device list.
            Err(_) => (
                ksx_api::DeviceScanView::default(),
                N_READ_SCAN_ERROR.to_owned(),
            ),
        };
        // The configuration menu's three reads, each degrading to its own
        // honest sentence rather than an empty pane (SURFACES.md §1b).
        // The refusal itself is dropped on purpose: it is a diagnostic, and
        // every one of these strings is rendered as primary customer copy
        // (the config-menu meta line, the note under the saved-games list,
        // the sign-in fold). See the three constants above.
        let (setup, setup_error) = match state.machine_cache.setup_state(&*state.machine) {
            Ok(view) => (Some(view), String::new()),
            Err(_) => (None, N_READ_SETUP_ERROR.to_owned()),
        };
        let (games, games_error) = match state.machine_cache.profiles(&*state.machine) {
            Ok(view) => (Some(view), String::new()),
            Err(_) => (None, N_READ_GAMES_ERROR.to_owned()),
        };
        let (autostart_read, autostart_error) = match state.machine_cache.autostart(&*state.machine)
        {
            Ok(view) => (Some(view), String::new()),
            Err(_) => (None, N_READ_AUTOSTART_ERROR.to_owned()),
        };
        // The saved panel layouts. An arcade board is drawn from one of these
        // and from nothing else, so a page that cannot read them must say so
        // rather than render a picker with the arcade option quietly missing.
        let (panels, panels_error) = match state.machine_cache.panel_profiles(&*state.machine) {
            Ok(view) => (Some(view), String::new()),
            Err(_) => (None, N_READ_PANELS_ERROR.to_owned()),
        };
        // Boards somebody drew. A separate store from the saved panel layouts
        // above, and a separate refusal: one holds pictures, the other holds
        // what a physical terminal emits.
        let (drawn, drawn_error) = match state.machine_cache.drawn_boards(&*state.machine) {
            Ok(view) => (Some(view), String::new()),
            Err(_) => (None, N_READ_BOARDS_ERROR.to_owned()),
        };
        // The undo chip: composed from the SERVER-held stash while its
        // window is open (the shared helper also sweeps an expired stash so
        // a late click cannot find it either).
        let undo_label = wb::undo_chip_label(&state.nocturne_undo);
        let payload = NocturnePayload {
            environment,
            staged,
            scan,
            session,
            unavailable,
            selected: slot,
            q,
            macro_selected,
            undo_label,
            setup,
            setup_error,
            games,
            games_error,
            autostart_read,
            autostart_error,
            panels,
            panels_error,
            drawn,
            drawn_error,
            view: Default::default(),
        };
        offer_held_release(payload.derived())
    })
    .await
    .unwrap_or_else(|_| {
        NocturnePayload {
            environment: fallback_environment,
            staged: ksx_api::StagedSetupView::unreachable("the nocturne collection panicked"),
            scan: ksx_api::DeviceScanView::default(),
            session: SessionView::unreachable("the nocturne collection panicked"),
            // A collection that panicked is still a read that did not
            // happen, and these four strings are rendered as customer copy —
            // "the games read panicked" under the saved-games list is the
            // same boundary violation as printing a TOML parse error there.
            // The `staged`/`session` unreachable reasons above stay diagnostic
            // because nothing paints them as prose.
            unavailable: N_READ_SCAN_ERROR.to_owned(),
            setup: None,
            setup_error: N_READ_SETUP_ERROR.to_owned(),
            games: None,
            games_error: N_READ_GAMES_ERROR.to_owned(),
            autostart_read: None,
            autostart_error: N_READ_AUTOSTART_ERROR.to_owned(),
            panels: None,
            panels_error: N_READ_PANELS_ERROR.to_owned(),
            drawn: None,
            drawn_error: N_READ_BOARDS_ERROR.to_owned(),
            selected: None,
            q: None,
            macro_selected: None,
            undo_label: None,
            view: Default::default(),
        }
        .derived()
    })
}

/// **The way back does not go through the staged setup.**
///
/// A keyboard Windows has bound to `winusb.sys` does not type. Until it is
/// released it is not a keyboard at all — and on a fresh install, or after a
/// QA reset that moves `config.toml` aside, NOTHING is staged, because the
/// binding is Windows's and not the configuration's. The capture card is
/// composed from the STAGE (`StartCaptureView::from_parts`), so in that state
/// its release control is not merely hidden: it does not exist, and the only
/// documented exit is `docs/RECOVERY.md` and an elevated shell
/// (`docs/FIRST-RUN.md` §6). That is the 2026-08-11 QA report verbatim: "the
/// release button only comes up once I select a keyboard to bind... but the
/// ipac was already bound and it was not showing the unrelease."
///
/// The deleted `/start` page answered it with a second, MACHINE-keyed list
/// (`StartRows::prepared`). This page has one capture card, so the card is
/// re-pointed instead: when it is offering neither action of its own and the
/// scan says some board is held, it becomes that board's way back. Prepare
/// stays stage-keyed — it edits the draft — while Release is machine-keyed,
/// which is exactly how [`capture_target`] already resolves the release
/// direction on the POST side. The two halves now agree.
fn offer_held_release(mut payload: NocturnePayload) -> NocturnePayload {
    // The stage is already offering something for this keyboard; a machine
    // fact must not silently replace an action the user was reading.
    if payload.view.cap_prepare || payload.view.cap_release {
        return payload;
    }
    let held = payload.scan.boards.iter().find(|board| {
        board.claimed
            && board
                .selector
                .as_deref()
                .is_some_and(|selector| !selector.trim().is_empty())
            && board
                .keyboard
                .as_deref()
                .is_some_and(|instance| !instance.trim().is_empty())
    });
    let Some(board) = held else {
        return payload;
    };
    let selector = board.selector.clone().unwrap_or_default();
    payload.view.cap_instance = board.keyboard.clone().unwrap_or_default();
    payload.view.cap_line = format!(
        "Keyboards ksx is holding: {} ({selector}). It cannot type until it is released here.",
        board.name
    );
    payload.view.cap_selector = selector;
    payload.view.cap_release = true;
    payload.view.capd_cls = "n-capd".to_owned();
    payload.view.cap_sw_cls = "n-capsw on".to_owned();
    payload
}

/// `GET /nocturne` — the page, server-rendered from the real keyboard facts.
/// The page's query: the action flash, and WHICH controller the page is
/// looking at — selection is a server-resolved link (the workspace's rule),
/// so it works with no JavaScript and survives a reload.
#[derive(Deserialize)]
pub(super) struct NocturneQuery {
    flash: Option<String>,
    slot: Option<u8>,
    /// The binding filter — SERVER-resolved like the selection, so the
    /// pane's rows filter with no JavaScript and survive a reload.
    q: Option<String>,
    /// Rescan's cache-bust: a fresh read IS the promise, so the machine
    /// cache is dropped before this request collects.
    fresh: Option<String>,
    /// Which macro the step editor is open on. `macro` is a Rust keyword, so
    /// the field is spelled out and renamed for the wire.
    #[serde(rename = "macro")]
    macro_name: Option<String>,
}

pub(super) async fn nocturne_page_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<NocturneQuery>,
) -> Response {
    if query.fresh.is_some() {
        state.machine_cache.invalidate();
    }
    let payload = collect_nocturne(
        &state,
        query.slot,
        query.q.clone(),
        query.macro_name.clone(),
    )
    .await;
    // FIX 1, kept: an unreachable draft is announced ABOVE `<main>`, in the
    // page's one `role="status"` region, and not left to a collapsed chip
    // three folds down. An action flash always wins the slot — it is the
    // answer to something the user just did, and this state is still visible
    // in every inert control underneath.
    let flash = nocturne_flash_from_query(query.flash.as_deref())
        .or_else(|| (!payload.staged.reachable).then(|| N_DAEMON_DOWN.to_owned()));
    let theme = page_theme(&state).await;
    let out = crate::render::with_theme(
        render_nocturne(&state.nocturne_page.get(), &payload, flash.as_deref()),
        theme.as_deref(),
    );
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=utf-8"),
            ),
            (
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_str(&out.csp)
                    .unwrap_or_else(|_| HeaderValue::from_static("default-src 'none'")),
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
        out.html,
    )
        .into_response()
}

/// The 2 s poller's endpoint — the SAME payload the page embeds.
pub(super) async fn api_nocturne(
    State(state): State<Arc<AppState>>,
    Query(query): Query<NocturneQuery>,
    headers: axum::http::HeaderMap,
) -> Response {
    if query.fresh.is_some() {
        state.machine_cache.invalidate();
    }
    let payload = collect_nocturne(
        &state,
        query.slot,
        query.q.clone(),
        query.macro_name.clone(),
    )
    .await;
    // ETag over the serialized payload: an unchanged answer costs a header
    // comparison instead of a body — `no-cache` (NOT no-store) so the
    // browser revalidates with If-None-Match and reuses its held copy.
    let body = serde_json::to_string(&payload).unwrap_or_default();
    let etag = {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        body.hash(&mut hasher);
        format!("\"{:x}\"", hasher.finish())
    };
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        == Some(etag.as_str())
    {
        return (
            StatusCode::NOT_MODIFIED,
            [
                (header::CACHE_CONTROL, HeaderValue::from_static("no-cache")),
                (header::ETAG, HeaderValue::from_str(&etag).unwrap()),
            ],
        )
            .into_response();
    }
    (
        [
            (header::CACHE_CONTROL, HeaderValue::from_static("no-cache")),
            (header::ETAG, HeaderValue::from_str(&etag).unwrap()),
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            ),
        ],
        body,
    )
        .into_response()
}

// ── The device pick (moved from /start, moment 4) ───────────────────────────

#[derive(Deserialize)]
pub(super) struct NocturneDeviceForm {
    /// The `ksx_core::DeviceSelector` the row carried (served). **Never a
    /// path anybody typed** — `FIRST-RUN.md` §6 forbids asking, and the page
    /// has no text input.
    selector: String,
    alias: String,
    label: String,
}

/// POST /nocturne/device (and /start/device) — replaces any earlier choice,
/// freely. One staged value in the daemon and nothing else.
pub(super) async fn nocturne_form_device(
    State(state): State<Arc<AppState>>,
    form: NocturneForm<NocturneDeviceForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return nocturne_redirect(N_FORM_UNREADABLE);
    };
    let outcome = tokio::task::spawn_blocking(move || {
        wb::choose_device_preserving_preparation(&state, form.selector, form.alias, form.label)
    })
    .await
    .unwrap_or(wb::DeviceChoice::Refused);
    nocturne_redirect(match outcome {
        // Not a refusal: the user asked for a state the page is already in,
        // and it is in it. Saying so is the honest answer, and it is the one
        // the no-JS reader needs — with scripting off this sentence is the
        // ONLY evidence that the press did anything at all.
        wb::DeviceChoice::Unchanged => N_DEVICE_ALREADY_OK,
        wb::DeviceChoice::Chosen => N_DEVICE_OK,
        wb::DeviceChoice::Refused => N_EDIT_ERROR,
    })
}

/// POST /nocturne/device/identify (and /start/device/identify) — one
/// daemon-owned listen, one machine-inventory resolution, one reversible
/// staged choice, via the shared [`identify_and_stage`] transaction.
pub(super) async fn nocturne_form_identify(State(state): State<Arc<AppState>>) -> Response {
    let flash = match wb::identify_and_stage(state).await {
        StartIdentifyResult::Selected(_) => N_IDENTIFY_OK,
        StartIdentifyResult::TimedOut => N_IDENTIFY_TIMEOUT,
        StartIdentifyResult::Failed
        | StartIdentifyResult::Busy
        | StartIdentifyResult::Cancelled => N_IDENTIFY_ERROR,
    };
    nocturne_redirect(flash)
}

// ── The split-or-freeze answer (moved from /start, FIRST-RUN §3) ────────────

#[derive(Deserialize)]
pub(super) struct NocturneBlockingForm {
    blocking: String,
}

// ── Outlived their pages ───────────────────────────────────────────────────
//
// These import/export shapes outlived /map and /setup and remain the legacy
// configuration menu's. Mapping operations now live in `server::workbench`.

/// Comma-separated form words → the `what` list the api verbs take. Empty means
/// "whatever the document carries" / "the whole root", which is what both verbs
/// already document.
pub(super) fn what_words(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect()
}

/// One [`ksx_api::ImportReport`] as the sentence this page flashes.
///
/// The backend composes the fact and names no control (`onboard::import`); each
/// surface adds its own. Here that is two things the report cannot know: the
/// label on THIS page's consent box, and the first of the faults it is holding.
pub(super) fn import_flash(report: &ksx_api::ImportReport) -> String {
    let mut line = report.summary.clone();
    if let Some(first) = report.faults.first() {
        line.push_str(&format!(" First: {first}"));
        let rest = report.faults.len() - 1;
        if rest > 0 {
            line.push_str(&format!(" (+{rest} more)"));
        }
    } else if report.ok && !report.applied {
        // A clean dry run. The backend said what it WOULD do and that nothing
        // was written; "write it" is the name of the box on this page and
        // nowhere else.
        line.push_str(" Tick \"write it\" and import again to apply.");
    }
    line
}

#[derive(Deserialize)]
pub(super) struct ExportQuery {
    /// `config,games,presets` — absent means the whole root.
    pub(super) what: Option<String>,
}

/// Every field optional on purpose. A missing one is a REFUSAL WITH A SENTENCE
/// (303 + `?flash=error: …`), not axum's 422 — this page's whole feedback
/// channel with scripting off is the flash, and a bare status page would
/// dead-end the user with nothing to read.
#[derive(Deserialize)]
pub(super) struct ImportForm {
    #[serde(default)]
    pub(super) document: Option<String>,
    #[serde(default)]
    pub(super) what: Option<String>,
    /// The "write it" box. Present at all = ticked (HTML omits an unchecked box
    /// entirely), so an absent field is a DRY RUN — which is the consent shape
    /// `ksx config import` has always had, arriving here for free.
    #[serde(default)]
    pub(super) apply: Option<String>,
    #[serde(default)]
    pub(super) force: Option<String>,
}

// ── Saved games and layouts ────────────────────────────────────────────────
//
// Moved from `/profiles` when `/nocturne` became the product. Two differences
// from that page, both deliberate:
//
//  - The refusal SENTENCE survives. `/profiles` ran every verb through
//    `machine_act`, which kept only `is_ok()` and flashed a canned line per
//    action. Here the backend's own words reach the page, because a refusal
//    that names its reason is the only kind worth showing.
//  - Numbers arrive as text and are parsed here. An empty `<input
//    type="number">` must become a worded refusal, never an extractor-level
//    422 that dead-ends someone with nothing to read.

/// Parse a player count that the form carries as text.
fn game_slots(raw: &str) -> Result<u8, &'static str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        // Not a default this layer may pick: "how many players" is the user's
        // answer, and the planner refuses 0 by name.
        return Ok(0);
    }
    trimmed.parse::<u8>().map_err(|_| N_GAME_SLOTS_ERROR)
}

#[derive(Deserialize)]
pub(super) struct NocturneGameForm {
    #[serde(default)]
    original_title: String,
    #[serde(default)]
    revision: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    arguments: String,
    #[serde(default)]
    slots: String,
    #[serde(default)]
    preset: String,
    #[serde(default)]
    rebase_devices: bool,
}

/// POST /nocturne/game — save a new launch target.
pub(super) async fn nocturne_form_game_new(
    State(state): State<Arc<AppState>>,
    Form(form): Form<NocturneGameForm>,
) -> Response {
    let slots = match game_slots(&form.slots) {
        Ok(value) => value,
        Err(message) => return nocturne_redirect(message),
    };
    let outcome = tokio::task::spawn_blocking(move || {
        state.machine.profile_new(&ksx_api::NewProfile {
            title: form.title,
            path: form.path,
            arguments: form.arguments,
            slots,
            preset: form.preset,
        })
    })
    .await;
    nocturne_redirect(&verb_flash(outcome, N_GAME_ADD_OK, N_GAME_ADD_ERROR))
}

/// POST /nocturne/game/update — edit one in place.
pub(super) async fn nocturne_form_game_update(
    State(state): State<Arc<AppState>>,
    Form(form): Form<NocturneGameForm>,
) -> Response {
    let slots = match game_slots(&form.slots) {
        Ok(value) => value,
        Err(message) => return nocturne_redirect(message),
    };
    let outcome = tokio::task::spawn_blocking(move || {
        state.machine.profile_update(&ksx_api::UpdateProfile {
            original_title: form.original_title,
            revision: form.revision,
            title: form.title,
            path: form.path,
            arguments: form.arguments,
            slots,
            preset: form.preset,
            rebase_devices: form.rebase_devices,
        })
    })
    .await;
    nocturne_redirect(&verb_flash(outcome, N_GAME_UPDATE_OK, N_GAME_UPDATE_ERROR))
}

#[derive(Deserialize)]
pub(super) struct NocturneGameDeleteForm {
    #[serde(default)]
    title: String,
    #[serde(default)]
    revision: String,
    #[serde(default)]
    confirm_delete: String,
}

/// POST /nocturne/game/delete — the served revision is the stale-screen guard.
///
/// The confirmation is SERVER-side. A browser dialog and a `required` checkbox
/// improve the interaction, but neither is an authorization boundary for a
/// destructive POST — a hand-written form reaches this handler directly. This
/// guard was dropped when the verb moved off `/profiles`; it is back.
pub(super) async fn nocturne_form_game_delete(
    State(state): State<Arc<AppState>>,
    Form(form): Form<NocturneGameDeleteForm>,
) -> Response {
    if form.confirm_delete != "yes" {
        return nocturne_redirect(N_GAME_DELETE_UNCONFIRMED);
    }
    let outcome = tokio::task::spawn_blocking(move || {
        state.machine.profile_delete(&ksx_api::DeleteProfile {
            title: form.title,
            revision: form.revision,
        })
    })
    .await;
    nocturne_redirect(&verb_flash(outcome, N_GAME_DELETE_OK, N_GAME_DELETE_ERROR))
}

#[derive(Deserialize)]
pub(super) struct NocturnePresetRenameForm {
    #[serde(default)]
    from: String,
    #[serde(default)]
    to: String,
}

/// POST /nocturne/layout/rename — renaming REPOINTS every controller that uses
/// the layout, so nothing is left naming a layout that is not there.
pub(super) async fn nocturne_form_preset_rename(
    State(state): State<Arc<AppState>>,
    Form(form): Form<NocturnePresetRenameForm>,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || {
        state.machine.preset_rename(&ksx_api::RenamePreset {
            from: form.from,
            to: form.to,
        })
    })
    .await;
    nocturne_redirect(&verb_flash(
        outcome,
        N_LAYOUT_RENAME_OK,
        N_LAYOUT_RENAME_ERROR,
    ))
}

#[derive(Deserialize)]
pub(super) struct NocturnePresetDeleteForm {
    #[serde(default)]
    name: String,
    #[serde(default)]
    confirm_delete: String,
}

/// POST /nocturne/layout/delete — a layout still in use cannot be deleted
/// until those controllers point somewhere else; the backend says so by name.
///
/// **`force` is not the browser's to send.** `ksx preset delete --force` will
/// delete a layout controllers still use and leave them pointing at nothing;
/// a web form must not, so this handler hardcodes `force: false` rather than
/// reading it from the request. The migrated version took it off the form,
/// which handed a hand-authored POST the power to strand a cabinet in one
/// request. Confirmation is server-side for the same reason.
pub(super) async fn nocturne_form_preset_delete(
    State(state): State<Arc<AppState>>,
    Form(form): Form<NocturnePresetDeleteForm>,
) -> Response {
    if form.confirm_delete != "yes" {
        return nocturne_redirect(N_LAYOUT_DELETE_UNCONFIRMED);
    }
    let outcome = tokio::task::spawn_blocking(move || {
        state.machine.preset_delete(&ksx_api::DeletePreset {
            name: form.name,
            force: false,
        })
    })
    .await;
    nocturne_redirect(&verb_flash(
        outcome,
        N_LAYOUT_DELETE_OK,
        N_LAYOUT_DELETE_ERROR,
    ))
}

/// One machine outcome as the sentence this page flashes: the backend's own
/// words on refusal, a short confirmation on success, and an honest line when
/// the blocking task itself died.
fn verb_flash(
    outcome: Result<Result<String, ksx_api::Refusal>, tokio::task::JoinError>,
    ok_line: &str,
    error_line: &str,
) -> String {
    match outcome {
        Ok(Ok(_)) => ok_line.to_owned(),
        // **Provider text is not customer copy.** A refusal message names
        // paths, files and verbs — `C:\…\games.toml`, `--force`, "daemon" —
        // which is right for a log and wrong for a sentence under a form. The
        // deleted /profiles page owned one line per action for exactly this
        // reason; carrying the verb over lost the boundary, and a hostile or
        // merely chatty provider could write straight onto the page.
        Ok(Err(_)) | Err(_) => error_line.to_owned(),
    }
}

/// Mark a flash as a REFUSAL.
///
/// `applyFlash` in NocturneIsland.ts picks the red side on `startsWith("error")`
/// and nothing else, so a refusal that arrives without this prefix renders in
/// the success colour. Every hand-written refusal constant in this file already
/// carries it; these two helpers compose their line at runtime and so have to
/// add it here.
fn as_error(line: String) -> String {
    if line.trim_start().starts_with("error") {
        return line;
    }
    format!("error: {line}")
}

/// GET /nocturne/export.json — the whole configuration as one file.
///
/// Moved from `/setup` when `/nocturne` became the product. A download, not a
/// page: the browser saves it and the user keeps it. On refusal the answer
/// goes back to the page the link was on, because that is where someone can
/// read it — a bare error body would dead-end them.
pub(super) async fn nocturne_export(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ExportQuery>,
) -> Response {
    let what = what_words(query.what.as_deref());
    let outcome = tokio::task::spawn_blocking(move || {
        state
            .machine
            .config_export(&ksx_api::ExportRequest { what })
    })
    .await
    .unwrap_or_else(|_| {
        Err(ksx_api::Refusal::new(
            ksx_api::codes::REFUSED,
            "the export panicked",
        ))
    });
    let export = match outcome {
        Ok(export) => export,
        Err(refusal) => return nocturne_redirect(&refusal.message),
    };
    let disposition = format!("attachment; filename=\"{}\"", export.filename);
    let mut response = export.document.into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&disposition)
            .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

/// POST /nocturne/import — bring a configuration back.
///
/// The consent shape is inherited whole and is worth restating: the "write it"
/// box absent means DRY RUN, because HTML omits an unchecked box entirely. So
/// the default action of this form reports what it WOULD do and writes
/// nothing, which is the same contract `ksx config import` has always had.
pub(super) async fn nocturne_form_import(
    State(state): State<Arc<AppState>>,
    form: Result<Form<ImportForm>, axum::extract::rejection::FormRejection>,
) -> Response {
    let Ok(Form(form)) = form else {
        return nocturne_redirect(N_IMPORT_UNREADABLE);
    };
    let request = ksx_api::ImportRequest {
        document: form.document.unwrap_or_default(),
        what: what_words(form.what.as_deref()),
        apply: form.apply.is_some(),
        force: form.force.is_some(),
    };
    if request.document.trim().is_empty() {
        return nocturne_redirect(N_IMPORT_EMPTY);
    }
    let outcome = tokio::task::spawn_blocking(move || state.machine.config_import(&request))
        .await
        .unwrap_or_else(|_| {
            Err(ksx_api::Refusal::new(
                ksx_api::codes::REFUSED,
                "the import panicked",
            ))
        });
    nocturne_redirect(&match outcome {
        // A dry run that reports faults is not a success, and the backend's
        // own summary opens with "refused:" — which `applyFlash` does not
        // recognise. Mark it, or a failed import renders in the success colour.
        Ok(report) if report.ok => import_flash(&report),
        Ok(report) => as_error(import_flash(&report)),
        Err(refusal) => as_error(refusal.message),
    })
}

#[derive(Deserialize)]
pub(super) struct NocturneThemeForm {
    theme: Option<String>,
}

/// POST /nocturne/theme — the Studio theme, moved here from `/setup` when
/// `/nocturne` became the product. A config write like blocking, but read per
/// page render rather than by the daemon, so "saved" IS "in effect".
///
/// `system` is stored as the EMPTY id deliberately: absence means "follow the
/// operating system", so there is no third state to keep in step, and an id
/// this build does not ship is refused rather than written.
pub(super) async fn nocturne_form_theme(
    State(state): State<Arc<AppState>>,
    Form(form): Form<NocturneThemeForm>,
) -> Response {
    let Some(field) = form.theme else {
        return nocturne_redirect("the form did not say which theme — pick one on the page");
    };
    let wanted = field.trim().to_owned();
    let stored = if wanted == "system" {
        String::new()
    } else if let Some(meta) = crate::theme_tokens::THEMES.iter().find(|t| t.id == wanted) {
        meta.id.to_owned()
    } else {
        return nocturne_redirect(N_THEME_UNKNOWN);
    };
    let ok = tokio::task::spawn_blocking(move || {
        state
            .machine
            .set_theme(&ksx_api::ThemeSpec { theme: stored })
            .is_ok()
    })
    .await
    .unwrap_or(false);
    nocturne_redirect(if ok { N_THEME_OK } else { N_EDIT_ERROR })
}

#[derive(Deserialize)]
pub(super) struct NocturneBoardForm {
    board: Option<String>,
}

/// POST /nocturne/board — which picture the keys are drawn on.
///
/// **This can never change what a controller does.** A board is the picture;
/// a binding carries the canonical key name and nothing else, so the same key
/// drives the same control whichever board is on screen. That is why there is
/// no session guard here and no confirmation: the worst outcome of a misclick
/// is a layout you did not want to look at.
///
/// The empty id is stored as absence, exactly as `system` is for the theme:
/// "decide from the staged device" is a real answer, and keeping it as absence
/// means there is no third state to hold in step with the device list.
///
/// An id this build cannot draw is REFUSED here rather than written, so the
/// config cannot be wedged with a board nothing can render. A board that is
/// merely unavailable right now — a panel layout deleted since it was chosen —
/// is a different case and is handled at render time by falling back to the
/// keyboard, because refusing to draw anything would be worse than drawing the
/// one board that always works.
pub(super) async fn nocturne_form_board(
    State(state): State<Arc<AppState>>,
    Form(form): Form<NocturneBoardForm>,
) -> Response {
    nocturne_redirect(board_write_flash(&state, form.board).await)
}

/// The board write, shared with `/redesign`: validate the id shape, then one
/// config write. `panel:` is a saved encoder layout, `board:` is one somebody
/// drew — both are refused if the id half is empty, so the config can never
/// be wedged with a prefix that names nothing. A board that merely does not
/// exist RIGHT NOW is a different case, handled at render time by falling
/// back to the keyboard.
pub(super) async fn board_write_flash(
    state: &Arc<AppState>,
    board: Option<String>,
) -> &'static str {
    let Some(field) = board else {
        return N_BOARD_MISSING;
    };
    let wanted = field.trim().to_owned();
    let known = wanted.is_empty()
        || wanted == crate::board::AUTO_ID
        || wanted == crate::board::QWERTY_ID
        || ["panel:", "board:"]
            .iter()
            .any(|prefix| wanted.strip_prefix(prefix).is_some_and(|id| !id.is_empty()));
    if !known {
        return N_BOARD_UNKNOWN;
    }
    let state = Arc::clone(state);
    let ok = tokio::task::spawn_blocking(move || {
        state
            .machine
            .set_board(&ksx_api::BoardSpec { board: wanted })
            .is_ok()
    })
    .await
    .unwrap_or(false);
    if ok {
        N_BOARD_OK
    } else {
        N_EDIT_ERROR
    }
}

/// POST /nocturne/blocking (and /start/blocking) — the capture answer,
/// changed as often as wanted.
pub(super) async fn nocturne_form_blocking(
    State(state): State<Arc<AppState>>,
    form: NocturneForm<NocturneBlockingForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return nocturne_redirect(N_FORM_UNREADABLE);
    };
    nocturne_redirect(wb::blocking_write_flash(&state, form.blocking).await)
}

// ── WinUSB prepare/release ────────────────────────────────────────────────

pub(super) async fn nocturne_form_capture_prepare(
    State(state): State<Arc<AppState>>,
    Form(form): Form<wb::CapturePrepareForm>,
) -> Response {
    let result = wb::capture_prepare(state, form).await;
    nocturne_redirect(wb::capture_flash(wb::CaptureMutation::Prepare, result))
}

pub(super) async fn nocturne_form_capture_release(
    State(state): State<Arc<AppState>>,
    Form(form): Form<wb::CaptureReleaseForm>,
) -> Response {
    let result = wb::capture_release(state, form).await;
    nocturne_redirect(wb::capture_flash(wb::CaptureMutation::Release, result))
}

// ── The rack (moved from /workspace) and the session verbs ─────────────────

/// Run one staging edit off the async workers and 303 back with this page's
/// sentence. One value in the daemon and nothing else — no file, no driver,
/// no session (`FIRST-RUN.md` §2), which is why there is no confirm step.
async fn nocturne_stage_edit(state: Arc<AppState>, edit: ksx_api::StageEdit) -> Response {
    let ok = tokio::task::spawn_blocking(move || state.control.stage_edit(&edit).ok)
        .await
        .unwrap_or(false);
    nocturne_redirect(if ok { N_EDIT_OK } else { N_EDIT_ERROR })
}

#[derive(Deserialize)]
pub(super) struct NocturneSlotForm {
    number: u8,
}

#[derive(Deserialize)]
pub(super) struct NocturneAddForm {
    persona: String,
    /// From `StagedSetupView::next_preset` — served, because it becomes a
    /// file name.
    preset: String,
    /// A `TemplateRow::id` off the served roster.
    #[serde(default)]
    layout: Option<String>,
    /// A `Socd` name off the served roster; absent keeps the engine default.
    #[serde(default)]
    socd: Option<String>,
}

/// POST /nocturne/controller — add the next
/// controller, with the create form's opposite-directions answer applied to
/// the fresh slot in the same request.
pub(super) async fn nocturne_form_add(
    State(state): State<Arc<AppState>>,
    form: NocturneForm<NocturneAddForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return nocturne_redirect(N_FORM_UNREADABLE);
    };
    let flash = tokio::task::spawn_blocking(move || {
        let added = state.control.stage_edit(&ksx_api::StageEdit::AddSlot {
            number: None,
            persona: form.persona,
            preset: form.preset,
            layout: None,
        });
        if !added.ok {
            return N_EDIT_ERROR;
        }
        let Some(number) = added.setup.slots.iter().map(|slot| slot.number).max() else {
            return N_EDIT_ERROR;
        };
        if let Some(layout) = form.layout.filter(|layout| !layout.trim().is_empty()) {
            // A layout dresses the slot's own player block when it has one;
            // past the blocks it was authored for, fall back to the player-1
            // block — the same keys as P1, which the shared-keys accounting
            // treats as the first-class state it is.
            let dressed = state.control.stage_edit(&ksx_api::StageEdit::SetLayout {
                number,
                layout: layout.clone(),
                player: None,
            });
            if !dressed.ok {
                let redressed = state.control.stage_edit(&ksx_api::StageEdit::SetLayout {
                    number,
                    layout,
                    player: Some(1),
                });
                if !redressed.ok {
                    let _ = state
                        .control
                        .stage_edit(&ksx_api::StageEdit::RemoveSlot { number });
                    return N_ADD_LAYOUT_ERROR;
                }
            }
        }
        if let Some(socd) = form.socd.filter(|socd| !socd.trim().is_empty()) {
            // Best-effort: the controller exists and binds; a refusal here is
            // an older daemon, and the rule stays editable afterwards.
            let _ = state
                .control
                .stage_edit(&ksx_api::StageEdit::SetSocd { number, socd });
        }
        N_EDIT_OK
    })
    .await
    .unwrap_or(N_EDIT_ERROR);
    nocturne_redirect(flash)
}

/// POST /nocturne/controller/remove (and /workspace/controller/remove) —
/// the slot's resurrection material is stashed BEFORE the removal, so the
/// rack can offer the short undo window. An older daemon serves no
/// authoring table; then nothing is stashed and no chip makes a promise
/// the server cannot keep.
pub(super) async fn nocturne_form_remove(
    State(state): State<Arc<AppState>>,
    form: NocturneForm<NocturneSlotForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return nocturne_redirect(N_FORM_UNREADABLE);
    };
    let flash = tokio::task::spawn_blocking(move || {
        let staged = state.control.staged();
        let stash = wb::stash_removed_slot(&staged, form.number);
        let removed = state.control.stage_edit(&ksx_api::StageEdit::RemoveSlot {
            number: form.number,
        });
        if removed.ok {
            *state.nocturne_undo.lock().unwrap() = stash;
            N_EDIT_OK
        } else {
            N_EDIT_ERROR
        }
    })
    .await
    .unwrap_or(N_EDIT_ERROR);
    nocturne_redirect(flash)
}

/// POST /nocturne/controller/undo — put the last removed controller back:
/// add + set-bindings + set-socd from the SERVER-held stash (the
/// duplicate's composition), at its own number when that is still free.
/// One shot: the stash is consumed whatever happens next.
pub(super) async fn nocturne_form_undo(State(state): State<Arc<AppState>>) -> Response {
    let flash =
        tokio::task::spawn_blocking(move || wb::undo_removal_flash(&state, &state.nocturne_undo))
            .await
            .unwrap_or(N_EDIT_ERROR);
    nocturne_redirect(flash)
}

#[derive(Deserialize)]
pub(super) struct NocturneMoveForm {
    order: String,
}

/// POST /nocturne/controller/move (and /workspace/controller/move) — one
/// whole-order reorder per click; the renumbering is the daemon's. The end
/// rows precompose an EMPTY order, which is not an error and not a write
/// either — just the honest sentence. Moved from /workspace on 2026-08-17
/// with the rack-ordering migration; the old route posts here and its answer
/// lands on /nocturne.
pub(super) async fn nocturne_form_move(
    State(state): State<Arc<AppState>>,
    form: NocturneForm<NocturneMoveForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return nocturne_redirect(N_FORM_UNREADABLE);
    };
    let numbers: Vec<u8> = form
        .order
        .split_whitespace()
        .filter_map(|n| n.parse().ok())
        .collect();
    if numbers.is_empty() {
        return nocturne_redirect(N_MOVE_AT_END);
    }
    nocturne_stage_edit(state, ksx_api::StageEdit::ReorderSlots { numbers }).await
}

#[derive(Deserialize)]
pub(super) struct NocturneSocdForm {
    number: u8,
    socd: String,
}

/// POST /nocturne/controller/socd (and /workspace/controller/socd) — the
/// selected slot's opposite-directions rule, a name off the served roster.
/// Moved from /workspace with the move verb above.
pub(super) async fn nocturne_form_socd(
    State(state): State<Arc<AppState>>,
    form: NocturneForm<NocturneSocdForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return nocturne_redirect(N_FORM_UNREADABLE);
    };
    nocturne_stage_edit(
        state,
        ksx_api::StageEdit::SetSocd {
            number: form.number,
            socd: form.socd,
        },
    )
    .await
}

/// POST /nocturne/apply — hand the draft's binding changes to the RUNNING
/// session in place (`stage_apply`, M1b F3): pads stay plugged, nothing is
/// written. A structural difference refuses (`needs-restart`) and the
/// sentence names Play as the verb that replaces the session.
pub(super) async fn nocturne_form_apply(State(state): State<Arc<AppState>>) -> Response {
    nocturne_redirect(wb::stage_apply_flash(state).await)
}

/// POST /nocturne/api/apply — the scripted twin of `/nocturne/apply`: the
/// same verb, but the browser gets the DAEMON'S OWN WORDS back, so a
/// `needs-restart` refusal opens a dialog quoting exactly what differs —
/// the flash allowlist only reflects fixed sentences, which is why the
/// no-JS door keeps its generic one.
pub(super) async fn nocturne_api_apply(State(state): State<Arc<AppState>>) -> Response {
    wb::stage_apply_json(state).await
}

/// POST /nocturne/bind/clear-all — unbind EVERY key of one slot's draft in
/// a single write: the slot's authoring table with its bindings emptied
/// (macro trigger keys are bindings, so they unbind too; the macros keep
/// their steps). One SetBindings, so a refusal changes nothing.
pub(super) async fn nocturne_form_clear_all(
    State(state): State<Arc<AppState>>,
    form: NocturneForm<NocturneSlotForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return nocturne_redirect(N_FORM_UNREADABLE);
    };
    let flash = tokio::task::spawn_blocking(move || wb::clear_all_flash(&state, form.number))
        .await
        .unwrap_or(N_EDIT_ERROR);
    nocturne_redirect(flash)
}

#[derive(Deserialize)]
pub(super) struct NocturneKeyClearForm {
    number: u8,
    key: String,
}

/// POST /nocturne/key/clear — take ONE key away from everything it drives on
/// one slot's draft. The list of touched functions comes from the same staged
/// mapper inversion the By-key rows render — never from anything a browser
/// sent — and each rewrite goes through the daemon's own staged-bind verb
/// (force: shrinking a key list consents to nothing new).
pub(super) async fn nocturne_form_key_clear(
    State(state): State<Arc<AppState>>,
    form: NocturneForm<NocturneKeyClearForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return nocturne_redirect(N_FORM_UNREADABLE);
    };
    let flash =
        tokio::task::spawn_blocking(move || wb::key_clear_flash(&state, form.number, form.key))
            .await
            .unwrap_or(N_EDIT_ERROR);
    nocturne_redirect(flash)
}

/// POST /nocturne/controller/duplicate (and /workspace/controller/duplicate)
/// — the same controller again, in the next free slot. A COMPOSITION of
/// existing staging verbs: add + set-bindings + set-socd, with the fresh slot
/// removed again if the middle step refuses. Moved from /workspace verbatim.
pub(super) async fn nocturne_form_duplicate(
    State(state): State<Arc<AppState>>,
    form: NocturneForm<NocturneSlotForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return nocturne_redirect(N_FORM_UNREADABLE);
    };
    let flash = tokio::task::spawn_blocking(move || wb::duplicate_slot_flash(&state, form.number))
        .await
        .unwrap_or(N_EDIT_ERROR);
    nocturne_redirect(flash)
}

/// What the Builder posts to publish the panel it has drawn.
///
/// Deliberately the store's own spec shape rather than the browser document:
/// the Builder keeps a rich editing document in `localStorage` (stage, theme,
/// selection, per-channel teach state) and none of that is a board. What
/// crosses is the picture — where each control sits, what it is, and what it
/// sends.
#[derive(Deserialize)]
pub(super) struct NocturneBoardSaveBody {
    #[serde(default)]
    board_id: Option<String>,
    #[serde(default)]
    expected_revision: Option<String>,
    name: String,
    #[serde(default)]
    description: String,
    bounds_w: f32,
    bounds_h: f32,
    controls: Vec<ksx_api::BoardControl>,
}

#[derive(Default, serde::Serialize)]
pub(super) struct NocturneBoardSaveOutcome {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    board_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    remedy: Option<String>,
}

/// POST /nocturne/api/board/save — publish the drawn panel as a board.
///
/// **Publishing, not saving.** The Builder goes on keeping its editing document
/// in browser storage, because that is what an editor needs: every drag is
/// local and instant. This is the separate, deliberate act of saying "this
/// picture is finished enough to map on", and only then does it become durable,
/// server-side, and visible to the board picker.
///
/// Every refusal is the STORE's, passed through with its own remedy. This
/// handler decides nothing: it does not vet keys, shapes or geometry, because
/// `boards::save` is the one door every client goes through and a second
/// opinion here could only ever disagree with it.
pub(super) async fn nocturne_api_board_save(
    State(state): State<Arc<AppState>>,
    axum::Json(body): axum::Json<NocturneBoardSaveBody>,
) -> Response {
    let cache = Arc::clone(&state);
    let outcome = tokio::task::spawn_blocking(move || {
        let spec = ksx_api::BoardSaveSpec {
            board_id: body.board_id,
            expected_revision: body.expected_revision,
            name: body.name,
            description: body.description,
            bounds_w: body.bounds_w,
            bounds_h: body.bounds_h,
            controls: body.controls,
        };
        match state.machine.board_save(&spec) {
            Ok(view) => NocturneBoardSaveOutcome {
                ok: true,
                board_id: Some(view.board_id),
                revision: Some(view.revision),
                summary: Some(view.summary),
                ..Default::default()
            },
            // **Only an authored refusal reaches the page.**
            //
            // `boards::save` refuses two very different ways. A BAD_REQUEST
            // is a sentence about what the user drew — "control 'x' sends
            // 'NotAKey'" — and is exactly what they need to read. Anything
            // else is a store diagnostic that embeds an absolute config path
            // and raw serde/io text, and one unreadable *.ksxboard.json was
            // enough to announce the user's whole config path through an
            // aria-live region. The code is the discriminator, so the page
            // never has to guess from the prose.
            Err(refusal) if refusal.code == ksx_api::codes::BAD_REQUEST => {
                NocturneBoardSaveOutcome {
                    ok: false,
                    error: Some(refusal.message),
                    remedy: refusal.remedy,
                    ..Default::default()
                }
            }
            Err(_) => NocturneBoardSaveOutcome {
                ok: false,
                error: Some(N_BOARD_STORE_ERROR.to_owned()),
                remedy: Some(
                    "make sure ksx can read and write its boards folder, then publish again"
                        .to_owned(),
                ),
                ..Default::default()
            },
        }
    })
    .await
    .unwrap_or_else(|_| NocturneBoardSaveOutcome {
        ok: false,
        error: Some("The board could not be published. Nothing was changed.".to_owned()),
        ..Default::default()
    });
    // The read cache holds the board list for ten seconds; a publish the user
    // cannot see in the picker reads as a publish that did not happen.
    cache.machine_cache.invalidate();
    axum::Json(outcome).into_response()
}

// ── The row editor's form twins: auto-fire and press behaviour ─────────────

#[derive(Deserialize)]
pub(super) struct NocturneTurboForm {
    slot: u8,
    function: String,
    #[serde(default)]
    turbo_hz: Option<String>,
}

/// POST /nocturne/bind/turbo — set (or clear, with `0`) a control's AUTO-FIRE
/// rate. The same three-state `turbo_hz` the staged bind verb carries, with
/// the control's CURRENT keys read server-side; a blank box is a refusal,
/// never a silent clear (docs/INPUT-TRANSFORMS.md §3, /map's rule kept).
pub(super) async fn nocturne_form_bind_turbo(
    State(state): State<Arc<AppState>>,
    form: NocturneForm<NocturneTurboForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return nocturne_redirect(N_FORM_UNREADABLE);
    };
    let flash = tokio::task::spawn_blocking(move || {
        wb::bind_turbo_flash(&state, form.slot, form.function, form.turbo_hz.as_deref())
    })
    .await
    .unwrap_or(N_EDIT_ERROR);
    nocturne_redirect(flash)
}

#[derive(Deserialize)]
pub(super) struct NocturneToggleForm {
    slot: u8,
    function: String,
    mode: String,
}

/// POST /nocturne/bind/toggle — the Hold|Toggle pill pair's twin. `mode` is
/// `hold` or `toggle`; anything else refuses. Writes the control's CURRENT
/// keys back with the three-state `toggle` field set, so the latch is the
/// only thing that changes (docs/INPUT-TRANSFORMS.md §3b).
pub(super) async fn nocturne_form_bind_toggle(
    State(state): State<Arc<AppState>>,
    form: NocturneForm<NocturneToggleForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return nocturne_redirect(N_FORM_UNREADABLE);
    };
    let flash = tokio::task::spawn_blocking(move || {
        wb::bind_toggle_flash(&state, form.slot, form.function, &form.mode)
    })
    .await
    .unwrap_or(N_EDIT_ERROR);
    nocturne_redirect(flash)
}

// ── The macro machinery (moved from /map 2026-08-17, macro migration) ──────

/// The lifecycle twins' form: the slot number and the table name — the two
/// identities a staged macro write needs. The server resolves the preset.
#[derive(Deserialize)]
pub(super) struct NocturneMacroForm {
    slot: u8,
    name: String,
    /// The toggle twin's direction: `yes` enables, anything else disables —
    /// served on the row, never inferred from a possibly-stale page.
    #[serde(default)]
    enable: Option<String>,
}

/// One staged macro write with the slot's preset resolved server-side, and
/// the outcome folded to a flash. The write shapes are `MacroWrite`'s own
/// contracts: `enabled` with NO steps is a pure toggle (the table keeps
/// every step and policy), and `delete` is an explicit flag so a lost grid
/// can never delete by omission.
async fn nocturne_macro_write(
    state: Arc<AppState>,
    slot: u8,
    write: crate::control::MacroWrite,
    ok_flash: &'static str,
) -> Response {
    nocturne_redirect(wb::macro_write_flash(state, slot, write, ok_flash).await)
}

/// POST /nocturne/macro/toggle — disable (or re-enable) one macro. The table
/// keeps everything; only the flag moves — that is the whole promise of
/// disabling instead of deleting.
pub(super) async fn nocturne_form_macro_toggle(
    State(state): State<Arc<AppState>>,
    form: NocturneForm<NocturneMacroForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return nocturne_redirect(N_FORM_UNREADABLE);
    };
    let enable = checked(form.enable.as_deref());
    nocturne_macro_write(
        state,
        form.slot,
        crate::control::MacroWrite {
            name: form.name,
            enabled: Some(enable),
            ..crate::control::MacroWrite::default()
        },
        N_MACRO_OK,
    )
    .await
}

/// POST /nocturne/macro/new — author one empty-stepped table in THIS DRAFT,
/// so a sequence can be started without leaving the page that owns it. One
/// step, holding nothing, is the smallest thing `save_macro` accepts; the
/// editor opens on it.
pub(super) async fn nocturne_form_macro_new(
    State(state): State<Arc<AppState>>,
    form: NocturneForm<NocturneMacroForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return nocturne_redirect(N_FORM_UNREADABLE);
    };
    nocturne_redirect(wb::macro_new_flash(state, form.slot, &form.name).await)
}

/// POST /nocturne/macro/delete — remove one macro table (and the trigger
/// rows that would otherwise dangle) from THIS DRAFT. The row's fold states
/// the consequence before this verb is reachable; saved files are untouched
/// until Save.
pub(super) async fn nocturne_form_macro_delete(
    State(state): State<Arc<AppState>>,
    form: NocturneForm<NocturneMacroForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return nocturne_redirect(N_FORM_UNREADABLE);
    };
    nocturne_macro_write(
        state,
        form.slot,
        crate::control::MacroWrite {
            name: form.name,
            delete: true,
            ..crate::control::MacroWrite::default()
        },
        N_MACRO_DELETED,
    )
    .await
}

#[derive(Deserialize)]
pub(super) struct NocturneClearForm {
    slot: u8,
    function: String,
}

/// POST /nocturne/bind/clear — one control back
/// to unbound on the staged slot, via the daemon's own staged-bind verb with
/// the canonical clear placeholder. Moved from /workspace verbatim.
pub(super) async fn nocturne_form_bind_clear(
    State(state): State<Arc<AppState>>,
    form: NocturneForm<NocturneClearForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return nocturne_redirect(N_FORM_UNREADABLE);
    };
    let flash =
        tokio::task::spawn_blocking(move || wb::bind_clear_flash(&state, form.slot, form.function))
            .await
            .unwrap_or(N_EDIT_ERROR);
    nocturne_redirect(flash)
}

/// POST /nocturne/save — the ONE writing verb: stage-commit.
///
/// Save's gate is deliberately the WEAKER one. Committing the staged files is
/// safe and useful on a machine whose controller driver is missing or could
/// not be read, so the output readiness Play consults is not consulted here;
/// only the capture disagreement is, because a saved draft that names the
/// wrong capture path would replay the same dead session tomorrow.
pub(super) async fn nocturne_form_save(State(state): State<Arc<AppState>>) -> Response {
    let disagrees = {
        let state = Arc::clone(&state);
        tokio::task::spawn_blocking(move || capture_disagrees(&state))
            .await
            .unwrap_or(false)
    };
    if disagrees {
        return nocturne_redirect(N_SAVE_CAPTURE);
    }
    nocturne_redirect(wb::stage_save(state).await)
}

/// **The capture gate, repeated in the handlers.**
///
/// The staged keyboard and the machine can disagree about who is holding it:
/// the draft names the ordinary Windows path over a board `winusb.sys` has
/// already taken, or names the built-in path over a board nothing has
/// prepared. Either way the pads plug and no key reaches them. This lived in
/// `SetupFlags::can_save`/`can_play` on the deleted `/start` page — i.e. in
/// the BUTTON — and a hand-authored POST walked straight past it. Both
/// writing verbs consult it now, before they touch the daemon.
///
/// A scan that could not be read does not gate anything: an unreadable
/// machine is not evidence of a disagreement, and refusing Play over it would
/// turn a temporary read failure into a locked-out cabinet.
fn capture_disagrees(state: &AppState) -> bool {
    let staged = state.control.staged();
    let Some(device) = staged.device.as_ref().filter(|_| staged.reachable) else {
        return false;
    };
    let Ok(scan) = state.machine.device_scan() else {
        return false;
    };
    let Some(board) = scan
        .boards
        .iter()
        .find(|board| board.selector.as_deref() == Some(device.selector.as_str()))
    else {
        return false;
    };
    match device.backend.as_str() {
        "winusb" => !board.claimed,
        "interception" => board.claimed,
        // Any other backend name is not a capture transition this page owns.
        _ => false,
    }
}

/// POST /nocturne/play — start a session from the staged setup, writing
/// nothing. Three gates, in the order that costs least: the capture
/// disagreement (a cheap re-read), the required controller OUTPUTS (Play's
/// own gate — see [`N_PLAY_OUTPUT_BLOCKED`]), and then the domain's.
pub(super) async fn nocturne_form_play(State(state): State<Arc<AppState>>) -> Response {
    let disagrees = {
        let state = Arc::clone(&state);
        tokio::task::spawn_blocking(move || capture_disagrees(&state))
            .await
            .unwrap_or(false)
    };
    if disagrees {
        return nocturne_redirect(N_PLAY_CAPTURE);
    }
    nocturne_redirect(wb::stage_play(state).await)
}

/// POST /nocturne/stop — end the session; keyboards type normally again.
pub(super) async fn nocturne_form_stop(State(state): State<Arc<AppState>>) -> Response {
    nocturne_redirect(wb::stage_stop(state).await)
}

// ── The configuration menu's verbs (moved from /workspace and /start) ──────

/// POST /nocturne/adopt (and /workspace/adopt) — the saved configuration, or
/// one saved game, into an EMPTY draft. Moved from /workspace and extended
/// with the per-game form field. The daemon refuses over a non-empty stage
/// (adoption never overwrites edits) and that refusal is the feature: the
/// flash names Start over as the deliberate first step. LOAD only — Play is
/// its own decision, never welded onto this one.
pub(super) async fn nocturne_form_adopt(
    State(state): State<Arc<AppState>>,
    Form(form): Form<wb::AdoptForm>,
) -> Response {
    nocturne_redirect(wb::stage_adopt(state, form.profile).await)
}

/// POST /nocturne/discard (and /start/discard) — "Start over". FIRST-RUN §2
/// requires that it always works; the menu's fold carries the dirty-aware
/// warning BEFORE this verb is reachable, and saved files are never touched.
pub(super) async fn nocturne_form_discard(State(state): State<Arc<AppState>>) -> Response {
    nocturne_redirect(wb::stage_discard(state).await)
}

/// What POST /nocturne/autostart carries. `enable` is the DIRECTION, served
/// on the fold, never inferred here from the current state: a form submitted
/// against a page that has since gone stale must do what its user read, or
/// nothing. Moved from /start with its whole consent shape.
#[derive(Debug, Deserialize)]
pub(super) struct NocturneAutostartForm {
    #[serde(default)]
    enable: Option<String>,
    #[serde(default)]
    confirm_autostart: Option<String>,
}

/// POST /nocturne/autostart (and /start/autostart) — the sign-in task, the
/// only machine lifecycle write on this page that needs no elevation. A
/// per-user scheduled task: nothing outside the signed-in account changes,
/// which is why it takes one tick box rather than the capture ceremony —
/// consent is sized to what is actually at risk.
pub(super) async fn nocturne_form_autostart(
    State(state): State<Arc<AppState>>,
    Form(form): Form<NocturneAutostartForm>,
) -> Response {
    if !checked(form.confirm_autostart.as_deref()) {
        return nocturne_redirect(N_AUTOSTART_CONSENT);
    }
    let enable = checked(form.enable.as_deref());
    let flash = tokio::task::spawn_blocking(move || {
        match state.machine.set_autostart(&ksx_api::AutostartSpec {
            enable,
            confirm: true,
        }) {
            // Trust the RE-READ, not the request: `set_autostart` returns the
            // view it read back after the change, so a task that did not
            // actually land cannot report success.
            Ok(view) if view.registered && !view.stale => N_AUTOSTART_ON,
            Ok(view) if view.registered => N_AUTOSTART_STILL_STALE,
            Ok(_) => N_AUTOSTART_OFF,
            Err(refusal) if refusal.code == ksx_api::codes::MANAGED_DEV_RUNTIME => {
                N_AUTOSTART_DEV_RUNTIME
            }
            Err(_) => N_AUTOSTART_ERROR,
        }
    })
    .await
    .unwrap_or(N_AUTOSTART_ERROR);
    nocturne_redirect(flash)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **The island reads the flash to tell identify's success from its two
    /// refusals, so the sentence is a contract between the two languages.**
    ///
    /// The flash string is this page's outcome channel — it is what survives
    /// the no-JS 303, and with scripting on it is the only thing `applyFlash`
    /// is handed. Identify's answer box (`.n-idbox.done`, wired 2026-08-26)
    /// opens on `N_IDENTIFY_OK` and on nothing else; the two `error:`
    /// sentences collapse it, because a reddened flash IS their answer.
    ///
    /// Matching a served sentence by literal is the cheap way to do that and
    /// the easy way to break it: reword `N_IDENTIFY_OK` and the box silently
    /// stops opening, with nothing failing and no error anywhere — identify
    /// would go back to answering only in a 32 px bar at the top of the page,
    /// which is the complaint the box exists to answer. So the two literals
    /// are pinned to each other here. If this fails, change BOTH.
    #[test]
    fn the_identify_success_sentence_is_the_one_the_island_matches() {
        const NOCTURNE_ISLAND_TS: &str =
            include_str!("../../../../studio-ui/src/NocturneIsland.ts");

        assert!(
            NOCTURNE_ISLAND_TS.contains(N_IDENTIFY_OK),
            "NocturneIsland.ts no longer carries N_IDENTIFY_OK verbatim ({N_IDENTIFY_OK:?}). \
             Its `IDENTIFY_OK_FLASH` compares against this exact string to decide whether \
             identify answered; a reworded sentence makes that comparison quietly false and \
             the answer box stops opening.",
        );
        // …and it is the one the COMPARISON uses, not merely a string that
        // happens to appear somewhere in a 12,000-line file.
        let at = NOCTURNE_ISLAND_TS
            .find("const IDENTIFY_OK_FLASH")
            .expect("NocturneIsland.ts to declare IDENTIFY_OK_FLASH");
        let decl = &NOCTURNE_ISLAND_TS[at..(at + 400).min(NOCTURNE_ISLAND_TS.len())];
        assert!(
            decl.contains(N_IDENTIFY_OK),
            "IDENTIFY_OK_FLASH is declared, but not from N_IDENTIFY_OK's words: {decl}",
        );

        // The refusals must stay refusals. `applyFlash` reddens on the
        // `error:` prefix alone, and identify's box reads the same prefix to
        // know it must NOT open — one dropped prefix would both paint a
        // failure green and pop an answer box naming whatever was staged
        // before.
        for refusal in [N_IDENTIFY_TIMEOUT, N_IDENTIFY_ERROR] {
            assert!(
                refusal.starts_with("error:"),
                "identify refusal {refusal:?} lost its prefix — it would render green and be \
                 indistinguishable from the success the answer box opens on",
            );
            assert_ne!(
                refusal, N_IDENTIFY_OK,
                "a refusal and the success sentence cannot be the same string",
            );
        }

        // All three still ride the no-JS path: the outcome of a verb has to
        // render with scripting off, and only allowlisted sentences survive
        // the 303 → `?flash=` round trip.
        for sentence in [N_IDENTIFY_OK, N_IDENTIFY_TIMEOUT, N_IDENTIFY_ERROR] {
            assert!(
                N_FLASH_ALLOWLIST.contains(&sentence),
                "{sentence:?} is not on N_FLASH_ALLOWLIST — with scripting off it would \
                 render as the generic error instead of identify's own answer",
            );
        }
    }
}
