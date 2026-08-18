//! `/nocturne` — the Nocturne front end, the product surface.
//!
//! Grown one migration pass at a time through 2026-08-17, each MOVING (never
//! copying) a section's backend here while the old page keeps rendering its
//! frames and its buttons land their answers on `/nocturne`: the keyboard
//! section from `/start` (device pick, identify-by-key, split-or-freeze,
//! the WinUSB capture transactions with every guard), the rack and session
//! verbs from `/workspace`, the learner's JSON trio and the macro editor
//! verb from `/map` (same routes — one daemon-owned surface per verb for
//! every door), the configuration menu (adopt grown a per-game field, Start
//! over, the sign-in task), the staged bind verb with its turbo/toggle
//! twins, and the macro lifecycle twins. The live input echo rides
//! `/api/live` client-side.
//!
//! What deliberately remains elsewhere: macro STEP editing (the Controls
//! grid, linked from each macro row until its own pass).

use super::*;

use crate::render_nocturne::render_nocturne;
use crate::snapshot::NocturnePayload;

// ── The flash allowlist — /start's discipline, this page's copy ─────────────
//
// A query string is user-controlled even when our own POST produced it; only
// copy this module can emit is reflected back onto the page. The capture
// sentences moved verbatim from `/start` — they were written for exactly
// these transactions and renaming the page does not change what happened.

pub(super) const N_DEVICE_OK: &str = "Keyboard selected. Nothing has been saved or started.";

pub(super) const N_BLOCKING_OK: &str =
    "Capture behaviour updated. Nothing has been saved or started.";

pub(super) const N_EDIT_OK: &str = "Draft updated. Nothing has been saved or started.";

pub(super) const N_MOVE_AT_END: &str =
    "That controller is already at that end of the order. Nothing changed.";

pub(super) const N_APPLY_OK: &str = "Changes applied to the running session in place — the pads \
     stayed plugged. Nothing has been saved.";

pub(super) const N_APPLY_RESTART: &str = "error: The draft changed more than bindings, so the \
     running session cannot take it in place. Press Play to replace the session; nothing was \
     changed.";

pub(super) const N_APPLY_ERROR: &str = "error: The changes could not be applied. The running \
     session was not changed; reopen ksx and try again.";

pub(super) const N_UNDO_OK: &str =
    "Controller restored with its bindings. Nothing has been saved or started.";

pub(super) const N_UNDO_GONE: &str = "error: That removal can no longer be undone — the short      undo window has passed. Nothing was changed.";

pub(super) const N_UNDO_FULL: &str = "error: Every controller slot is staged again, so the      removed controller has nowhere to return. Nothing was changed.";

pub(super) const N_ADD_LAYOUT_ERROR: &str = "error: That starting layout has no key block for this player number, so the controller was not added. Try another layout or Empty; nothing was changed.";

pub(super) const N_DUP_OK: &str =
    "Controller duplicated — same layout, same rules, next free slot. Nothing has been saved.";

pub(super) const N_DUP_FULL: &str =
    "error: Every controller slot is staged, so there is nothing free to duplicate into. \
     Remove one first.";

pub(super) const N_SAVE_OK: &str = "Setup saved for later. Play has not started.";

pub(super) const N_SAVE_ERROR: &str =
    "error: The setup could not be saved. Check the draft on this screen; nothing was written.";

pub(super) const N_PLAY_OK: &str = "Play started. Use Stop to return the keyboard to normal.";

pub(super) const N_PLAY_ERROR: &str =
    "error: Play could not start. Check the draft on this screen; nothing was started.";

pub(super) const N_STOP_OK: &str = "Play stopped. Keyboards type normally again.";

pub(super) const N_STOP_ERROR: &str =
    "error: Play could not be stopped. Try again, or use L-Ctrl five times.";

pub(super) const N_EDIT_ERROR: &str =
    "error: The change could not be made. Reopen ksx and try again; nothing was changed.";

pub(super) const N_IDENTIFY_OK: &str =
    "Keyboard identified and selected. Nothing has been captured, saved, or started.";

pub(super) const N_IDENTIFY_TIMEOUT: &str =
    "error: No keyboard answered in time. Nothing changed; try Identify again and press one key.";

pub(super) const N_IDENTIFY_ERROR: &str = "error: That key press could not be matched to one \
     selectable keyboard. Nothing changed; try again.";

pub(super) const N_CAPTURE_PREPARED_OK: &str =
    "Keyboard prepared. Windows verified this exact keyboard and ksx is ready to use it.";

pub(super) const N_CAPTURE_RELEASED_OK: &str =
    "Keyboard released. It can type normally again; prepare it again before Play if needed.";

pub(super) const N_CAPTURE_PREPARE_CONSENT: &str =
    "error: Confirm all three keyboard safety checks before continuing. Nothing was changed.";

pub(super) const N_CAPTURE_RELEASE_CONSENT: &str =
    "error: Confirm that you want to release this keyboard. Nothing was changed.";

pub(super) const N_CAPTURE_TARGET_CHANGED: &str = "error: The selected keyboard changed or could \
     not be verified. Nothing was changed; Rescan and choose it again.";

pub(super) const N_CAPTURE_ALREADY_PREPARED: &str = "This keyboard is already prepared. Nothing \
     was changed — use Release if you want it to type normally again.";

pub(super) const N_CAPTURE_ALREADY_RELEASED: &str = "This keyboard is already a normal keyboard. \
     Nothing was changed — use Prepare if you want ksx to take it.";

pub(super) const N_CAPTURE_PREPARE_ERROR: &str = "error: Windows could not prepare this \
     keyboard. Nothing was changed; keep the spare keyboard connected and try again.";

pub(super) const N_CAPTURE_RELEASE_ERROR: &str = "error: Windows could not release this \
     keyboard. Nothing was changed; keep the spare keyboard connected and try again.";

pub(super) const N_CAPTURE_PREPARE_RECOVERY: &str = "error: Windows could not finish preparing \
     this keyboard and it may need recovery. Keep the spare keyboard connected, reopen ksx, and \
     use Release if it is offered. Nothing else was changed.";

pub(super) const N_CAPTURE_RELEASE_RECOVERY: &str = "error: Windows could not finish releasing \
     this keyboard and it may need recovery. Keep the spare keyboard connected and reopen ksx \
     before trying again. Nothing else was changed.";

pub(super) const N_CAPTURE_PREPARED_STAGE_CHANGED: &str = "error: Windows prepared the keyboard, \
     but the selection changed while permission was open. Choose the keyboard again to finish.";

pub(super) const N_CAPTURE_RELEASED_STAGE_CHANGED: &str = "error: Windows released the keyboard, \
     but the selection changed while permission was open. Choose the keyboard again before Play.";

pub(super) const N_TURBO_OK: &str = "Auto-fire updated — the row shows the rate that will \
     actually be delivered. Nothing has been saved or started.";

pub(super) const N_TURBO_INPUT_ERROR: &str = "error: Type a number of presses a second into the \
     turbo box (0 turns auto-fire off). Nothing was changed.";

pub(super) const N_TURBO_UNBOUND_ERROR: &str = "error: That control has no keys, so there is \
     nothing to auto-fire. Bind a key first; nothing was changed.";

pub(super) const N_TOGGLE_OK: &str = "Press behaviour updated. Nothing has been saved or started.";

pub(super) const N_TOGGLE_UNBOUND_ERROR: &str = "error: That control has no keys, so there is \
     nothing to hold. Bind a key first; nothing was changed.";

pub(super) const N_MACRO_OK: &str = "Macro updated. Nothing has been saved or started.";

pub(super) const N_MACRO_DELETED: &str = "Macro removed from this draft — its trigger keys are \
     unbound with it. Nothing saved was touched.";

pub(super) const N_ADOPT_OK: &str =
    "Loaded into this draft — review it, then Play. Nothing has been saved or started.";

pub(super) const N_ADOPT_BLOCKED: &str = "error: This draft already has content, and loading \
     never overwrites edits. Start over first, then load. Nothing was changed.";

pub(super) const N_DISCARD_OK: &str = "Draft discarded. Saved files were not touched.";

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

pub(super) const N_UNKNOWN_FLASH_ERROR: &str =
    "error: That request could not be finished. Reopen ksx and try again.";

pub(super) const N_FLASH_ALLOWLIST: [&str; 52] = [
    N_MOVE_AT_END,
    N_UNDO_OK,
    N_UNDO_GONE,
    N_UNDO_FULL,
    N_APPLY_OK,
    N_APPLY_RESTART,
    N_APPLY_ERROR,
    N_MACRO_OK,
    N_MACRO_DELETED,
    N_ADOPT_OK,
    N_ADOPT_BLOCKED,
    N_DISCARD_OK,
    N_AUTOSTART_ON,
    N_AUTOSTART_OFF,
    N_AUTOSTART_CONSENT,
    N_AUTOSTART_STILL_STALE,
    N_AUTOSTART_ERROR,
    N_TURBO_OK,
    N_TURBO_INPUT_ERROR,
    N_TURBO_UNBOUND_ERROR,
    N_TOGGLE_OK,
    N_TOGGLE_UNBOUND_ERROR,
    N_DEVICE_OK,
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

fn nocturne_redirect(flash: &str) -> Response {
    Redirect::to(&format!("/nocturne?flash={}", urlencode(flash))).into_response()
}

// ── The reads ───────────────────────────────────────────────────────────────

/// One fresh payload: the staged setup and the device enumeration, each
/// degrading to its own honest value (`SURFACES.md` §1b). Never cached — a
/// keyboard plugged in while the page is open appears at the next poll.
pub(super) async fn collect_nocturne(
    state: &Arc<AppState>,
    slot: Option<u8>,
    q: Option<String>,
) -> NocturnePayload {
    let state = Arc::clone(state);
    tokio::task::spawn_blocking(move || {
        let staged = state.control.staged();
        let session = state.control.session();
        let (scan, unavailable) = match state.machine_cache.device_scan(&*state.machine) {
            Ok(scan) => (scan, String::new()),
            Err(refusal) => (ksx_api::DeviceScanView::default(), flash_of(refusal)),
        };
        // The configuration menu's three reads, each degrading to its own
        // honest sentence rather than an empty pane (SURFACES.md §1b).
        let (setup, setup_error) = match state.machine_cache.setup_state(&*state.machine) {
            Ok(view) => (Some(view), String::new()),
            Err(refusal) => (None, flash_of(refusal)),
        };
        let (games, games_error) = match state.machine_cache.profiles(&*state.machine) {
            Ok(view) => (Some(view), String::new()),
            Err(refusal) => (None, flash_of(refusal)),
        };
        let (autostart_read, autostart_error) = match state.machine_cache.autostart(&*state.machine)
        {
            Ok(view) => (Some(view), String::new()),
            Err(refusal) => (None, flash_of(refusal)),
        };
        // The undo chip: composed from the SERVER-held stash while its
        // window is open; an expired stash is dropped here so a late click
        // cannot find it either.
        let undo_label = {
            let mut held = state.nocturne_undo.lock().unwrap();
            if held
                .as_ref()
                .is_some_and(|stash| stash.at.elapsed() > NOCTURNE_UNDO_WINDOW)
            {
                *held = None;
            }
            held.as_ref().map(|stash| {
                format!(
                    "P{} ({}) removed — its bindings are held for a moment",
                    stash.slot.number, stash.slot.persona_label
                )
            })
        };
        NocturnePayload {
            staged,
            scan,
            session,
            unavailable,
            selected: slot,
            q,
            undo_label,
            setup,
            setup_error,
            games,
            games_error,
            autostart_read,
            autostart_error,
            view: Default::default(),
        }
        .derived()
    })
    .await
    .unwrap_or_else(|_| {
        NocturnePayload {
            staged: ksx_api::StagedSetupView::unreachable("the nocturne collection panicked"),
            scan: ksx_api::DeviceScanView::default(),
            session: SessionView::unreachable("the nocturne collection panicked"),
            unavailable: "the device scan panicked — nothing below is a reading of this machine"
                .to_owned(),
            setup: None,
            setup_error: "the configuration read panicked".to_owned(),
            games: None,
            games_error: "the games read panicked".to_owned(),
            autostart_read: None,
            autostart_error: "the sign-in read panicked".to_owned(),
            selected: None,
            q: None,
            undo_label: None,
            view: Default::default(),
        }
        .derived()
    })
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
}

pub(super) async fn nocturne_page_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<NocturneQuery>,
) -> Response {
    if query.fresh.is_some() {
        state.machine_cache.invalidate();
    }
    let payload = collect_nocturne(&state, query.slot, query.q.clone()).await;
    let flash = nocturne_flash_from_query(query.flash.as_deref());
    let out = render_nocturne(&state.nocturne_page, &payload, flash.as_deref());
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
    let payload = collect_nocturne(&state, query.slot, query.q.clone()).await;
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
    Form(form): Form<NocturneDeviceForm>,
) -> Response {
    let ok = tokio::task::spawn_blocking(move || {
        state
            .control
            .stage_edit(&ksx_api::StageEdit::ChooseDevice {
                selector: form.selector,
                alias: form.alias,
                label: form.label,
            })
            .ok
    })
    .await
    .unwrap_or(false);
    nocturne_redirect(if ok { N_DEVICE_OK } else { N_EDIT_ERROR })
}

/// POST /nocturne/device/identify (and /start/device/identify) — one
/// daemon-owned listen, one machine-inventory resolution, one reversible
/// staged choice, via the shared [`identify_and_stage`] transaction.
pub(super) async fn nocturne_form_identify(State(state): State<Arc<AppState>>) -> Response {
    let flash = match identify_and_stage(state).await {
        StartIdentifyResult::Selected => N_IDENTIFY_OK,
        StartIdentifyResult::TimedOut => N_IDENTIFY_TIMEOUT,
        StartIdentifyResult::Failed => N_IDENTIFY_ERROR,
    };
    nocturne_redirect(flash)
}

// ── The split-or-freeze answer (moved from /start, FIRST-RUN §3) ────────────

#[derive(Deserialize)]
pub(super) struct NocturneBlockingForm {
    blocking: String,
}

/// POST /nocturne/blocking (and /start/blocking) — the capture answer,
/// changed as often as wanted.
pub(super) async fn nocturne_form_blocking(
    State(state): State<Arc<AppState>>,
    Form(form): Form<NocturneBlockingForm>,
) -> Response {
    let ok = tokio::task::spawn_blocking(move || {
        state
            .control
            .stage_edit(&ksx_api::StageEdit::SetBlocking {
                blocking: form.blocking,
            })
            .ok
    })
    .await
    .unwrap_or(false);
    nocturne_redirect(if ok { N_BLOCKING_OK } else { N_EDIT_ERROR })
}

// ── WinUSB prepare/release (moved from /start, with every guard intact) ─────

#[derive(Deserialize)]
pub(super) struct NocturneCapturePrepareForm {
    /// Both identifiers are served hidden values and both are treated only as
    /// stale-action guards. The current stage + inventory are authoritative.
    #[serde(default)]
    expected_selector: String,
    #[serde(default)]
    instance_id: String,
    #[serde(default)]
    confirm_spare_keyboard: Option<String>,
    #[serde(default)]
    confirm_rebind: Option<String>,
    #[serde(default)]
    confirm_machine_certificate: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct NocturneCaptureReleaseForm {
    #[serde(default)]
    expected_selector: String,
    #[serde(default)]
    instance_id: String,
    #[serde(default)]
    confirm_release: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CaptureMutation {
    Prepare,
    Release,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CaptureResult {
    Prepared,
    Released,
    ConsentMissing,
    TargetChanged,
    MutationFailed,
    /// The keyboard is already in the state that was asked for. Not a
    /// failure: the machine is fine, the request was simply redundant, and
    /// the useful answer names the state and the action that follows from it.
    AlreadyInState,
    RecoveryRequired,
    StageChanged,
}

/// Which refusals mean "already in that state". Matched on the stable code,
/// never on the sentence: refusal text is written for an operator and can
/// name paths and commands, so it is used to SELECT a safe answer and is
/// never reflected to the browser.
pub(super) fn already_in_state(refusal: &ksx_api::Refusal) -> bool {
    matches!(
        refusal.code.as_str(),
        "winusb-already-prepared" | "winusb-already-released"
    )
}

fn capture_redirect(action: CaptureMutation, result: CaptureResult) -> Response {
    let flash = match (action, result) {
        (CaptureMutation::Prepare, CaptureResult::Prepared) => N_CAPTURE_PREPARED_OK,
        (CaptureMutation::Release, CaptureResult::Released) => N_CAPTURE_RELEASED_OK,
        (CaptureMutation::Prepare, CaptureResult::ConsentMissing) => N_CAPTURE_PREPARE_CONSENT,
        (CaptureMutation::Release, CaptureResult::ConsentMissing) => N_CAPTURE_RELEASE_CONSENT,
        (_, CaptureResult::TargetChanged) => N_CAPTURE_TARGET_CHANGED,
        (CaptureMutation::Prepare, CaptureResult::AlreadyInState) => N_CAPTURE_ALREADY_PREPARED,
        (CaptureMutation::Release, CaptureResult::AlreadyInState) => N_CAPTURE_ALREADY_RELEASED,
        (CaptureMutation::Prepare, CaptureResult::MutationFailed) => N_CAPTURE_PREPARE_ERROR,
        (CaptureMutation::Release, CaptureResult::MutationFailed) => N_CAPTURE_RELEASE_ERROR,
        (CaptureMutation::Prepare, CaptureResult::RecoveryRequired) => N_CAPTURE_PREPARE_RECOVERY,
        (CaptureMutation::Release, CaptureResult::RecoveryRequired) => N_CAPTURE_RELEASE_RECOVERY,
        (CaptureMutation::Prepare, CaptureResult::StageChanged) => N_CAPTURE_PREPARED_STAGE_CHANGED,
        (CaptureMutation::Release, CaptureResult::StageChanged) => N_CAPTURE_RELEASED_STAGE_CHANGED,
        // A success variant paired with the wrong action is an internal bug,
        // never a provider sentence suitable for a customer redirect.
        _ => N_UNKNOWN_FLASH_ERROR,
    };
    nocturne_redirect(flash)
}

/// Resolve the exact interface a capture mutation names, again, on the
/// server. The browser's hidden values are stale-action guards, not
/// authority. Prepare stays gated on the staged selection; Release resolves
/// purely by identity against the live scan — the full reasoning moved with
/// this function from `/start` (2026-08-11 QA defect: gating the undo on the
/// stage stranded held keyboards on a fresh visit).
pub(super) fn capture_target(
    state: &AppState,
    action: CaptureMutation,
    expected_selector: &str,
    instance_id: &str,
) -> Result<(String, String), CaptureResult> {
    if action == CaptureMutation::Prepare {
        let staged = state.control.staged();
        let device = staged
            .device
            .as_ref()
            .filter(|device| staged.reachable && device.selector == expected_selector)
            .ok_or(CaptureResult::TargetChanged)?;
        if device.backend != "interception" && device.backend != "winusb" {
            return Err(CaptureResult::TargetChanged);
        }
    }
    if expected_selector.trim().is_empty() || instance_id.trim().is_empty() {
        return Err(CaptureResult::TargetChanged);
    }

    let scan = state
        .machine
        .device_scan()
        .map_err(|_| CaptureResult::TargetChanged)?;
    let mut matches = scan
        .boards
        .iter()
        .filter(|board| board.selector.as_deref() == Some(expected_selector));
    let board = matches.next().ok_or(CaptureResult::TargetChanged)?;
    if matches.next().is_some() || !board.winusb_eligible {
        return Err(CaptureResult::TargetChanged);
    }
    let current_instance = board
        .keyboard
        .as_ref()
        .filter(|current| current.eq_ignore_ascii_case(instance_id))
        .ok_or(CaptureResult::TargetChanged)?;
    if scan
        .boards
        .iter()
        .flat_map(|candidate| candidate.interfaces.iter())
        .filter(|row| row.instance_id.eq_ignore_ascii_case(current_instance))
        .count()
        != 1
    {
        return Err(CaptureResult::TargetChanged);
    }
    if action == CaptureMutation::Release && !board.claimed {
        return Err(CaptureResult::TargetChanged);
    }
    Ok((
        board.selector.clone().ok_or(CaptureResult::TargetChanged)?,
        current_instance.clone(),
    ))
}

pub(super) fn checked(value: Option<&str>) -> bool {
    value == Some("yes")
}

/// POST /nocturne/capture/prepare (and /start/capture/prepare) — one exact
/// keyboard, through the installed MachineSource helper. Studio never starts
/// a process, parses helper output, or accepts a backend name from the
/// browser. Only an authoritative `prepared` result for the submitted exact
/// instance licenses the guarded in-memory backend transition.
pub(super) async fn nocturne_form_capture_prepare(
    State(state): State<Arc<AppState>>,
    Form(form): Form<NocturneCapturePrepareForm>,
) -> Response {
    if !checked(form.confirm_spare_keyboard.as_deref())
        || !checked(form.confirm_rebind.as_deref())
        || !checked(form.confirm_machine_certificate.as_deref())
    {
        return capture_redirect(CaptureMutation::Prepare, CaptureResult::ConsentMissing);
    }
    let outcome = tokio::task::spawn_blocking(move || {
        let (expected_selector, instance_id) = capture_target(
            &state,
            CaptureMutation::Prepare,
            &form.expected_selector,
            &form.instance_id,
        )?;
        let spec = ksx_api::WinusbPrepareSpec {
            expected_selector: expected_selector.clone(),
            instance_id: instance_id.clone(),
            confirm_spare_keyboard: true,
            confirm_rebind: true,
            confirm_machine_certificate: true,
        };
        let mutation = state.machine.winusb_prepare(&spec).map_err(|refusal| {
            if already_in_state(&refusal) {
                CaptureResult::AlreadyInState
            } else {
                CaptureResult::MutationFailed
            }
        })?;
        if mutation.state == "recovery-required"
            && mutation.instance_id.eq_ignore_ascii_case(&instance_id)
        {
            return Err(CaptureResult::RecoveryRequired);
        }
        if mutation.state != "prepared" || !mutation.instance_id.eq_ignore_ascii_case(&instance_id)
        {
            return Err(CaptureResult::MutationFailed);
        }
        let staged = state
            .control
            .stage_edit(&ksx_api::StageEdit::SetDeviceBackend {
                expected_selector,
                backend: "winusb".to_owned(),
            });
        if !staged.ok {
            return Err(CaptureResult::StageChanged);
        }
        Ok(CaptureResult::Prepared)
    })
    .await
    .unwrap_or(Err(CaptureResult::MutationFailed));
    capture_redirect(
        CaptureMutation::Prepare,
        outcome.unwrap_or_else(|failure| failure),
    )
}

/// POST /nocturne/capture/release (and /start/capture/release) — the inverse
/// transition, with the same exact identity and stale-stage guards. A raw
/// helper/provider message never crosses this presentation boundary.
pub(super) async fn nocturne_form_capture_release(
    State(state): State<Arc<AppState>>,
    Form(form): Form<NocturneCaptureReleaseForm>,
) -> Response {
    if !checked(form.confirm_release.as_deref()) {
        return capture_redirect(CaptureMutation::Release, CaptureResult::ConsentMissing);
    }
    let outcome = tokio::task::spawn_blocking(move || {
        let (expected_selector, instance_id) = capture_target(
            &state,
            CaptureMutation::Release,
            &form.expected_selector,
            &form.instance_id,
        )?;
        let spec = ksx_api::WinusbReleaseSpec {
            expected_selector: expected_selector.clone(),
            instance_id: instance_id.clone(),
            confirm_release: true,
        };
        let mutation = state.machine.winusb_release(&spec).map_err(|refusal| {
            if already_in_state(&refusal) {
                CaptureResult::AlreadyInState
            } else {
                CaptureResult::MutationFailed
            }
        })?;
        if mutation.state == "recovery-required"
            && mutation.instance_id.eq_ignore_ascii_case(&instance_id)
        {
            return Err(CaptureResult::RecoveryRequired);
        }
        if mutation.state != "released" || !mutation.instance_id.eq_ignore_ascii_case(&instance_id)
        {
            return Err(CaptureResult::MutationFailed);
        }
        // **Only the STAGED board's backend follows the release.** A held
        // keyboard that is not this visit's selection has no staged backend
        // to correct, and posting one would refuse — turning a release that
        // actually happened into an error flash (`SURFACES.md` §1b with the
        // two halves swapped).
        if state
            .control
            .staged()
            .device
            .as_ref()
            .is_some_and(|device| device.selector == expected_selector)
        {
            let staged = state
                .control
                .stage_edit(&ksx_api::StageEdit::SetDeviceBackend {
                    expected_selector,
                    backend: "interception".to_owned(),
                });
            if !staged.ok {
                return Err(CaptureResult::StageChanged);
            }
        }
        Ok(CaptureResult::Released)
    })
    .await
    .unwrap_or(Err(CaptureResult::MutationFailed));
    capture_redirect(
        CaptureMutation::Release,
        outcome.unwrap_or_else(|failure| failure),
    )
}

// ── The rack (moved from /workspace) and the session verbs ─────────────────

/// Everything needed to put a removed controller back: held in
/// `AppState.nocturne_undo` for [`NOCTURNE_UNDO_WINDOW`], SERVER-side —
/// the design's 6-second undo chip, without ever handing the browser an
/// authoring table it could edit.
pub(super) struct NocturneUndoStash {
    /// The removed slot's whole served view — this crate deliberately knows
    /// nothing about the preset vocabulary at runtime (`ksx-config` is
    /// test-only here), so the stash speaks `ksx_api` types wholesale.
    pub slot: ksx_api::StagedSlotView,
    pub at: std::time::Instant,
}

pub(super) const NOCTURNE_UNDO_WINDOW: std::time::Duration = std::time::Duration::from_secs(6);

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

/// POST /nocturne/controller (and /workspace/controller) — add the next
/// controller, with the create form's opposite-directions answer applied to
/// the fresh slot in the same request.
pub(super) async fn nocturne_form_add(
    State(state): State<Arc<AppState>>,
    Form(form): Form<NocturneAddForm>,
) -> Response {
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
    Form(form): Form<NocturneSlotForm>,
) -> Response {
    let flash = tokio::task::spawn_blocking(move || {
        let staged = state.control.staged();
        let stash = staged
            .slots
            .iter()
            .find(|slot| slot.number == form.number && slot.authoring.is_some())
            .map(|slot| NocturneUndoStash {
                slot: slot.clone(),
                at: std::time::Instant::now(),
            });
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
    let flash = tokio::task::spawn_blocking(move || {
        let Some(stash) = state.nocturne_undo.lock().unwrap().take() else {
            return N_UNDO_GONE;
        };
        if stash.at.elapsed() > NOCTURNE_UNDO_WINDOW {
            return N_UNDO_GONE;
        }
        let Some(authoring) = stash.slot.authoring else {
            return N_UNDO_GONE;
        };
        let staged = state.control.staged();
        let number = if staged
            .slots
            .iter()
            .any(|slot| slot.number == stash.slot.number)
        {
            match staged.next_slot {
                Some(next) => next,
                None => return N_UNDO_FULL,
            }
        } else {
            stash.slot.number
        };
        let added = state.control.stage_edit(&ksx_api::StageEdit::AddSlot {
            number: Some(number),
            persona: stash.slot.persona,
            preset: stash.slot.preset,
            layout: None,
        });
        if !added.ok {
            return N_EDIT_ERROR;
        }
        let bound = state.control.stage_edit(&ksx_api::StageEdit::SetBindings {
            number,
            preset: Box::new(authoring),
        });
        if !bound.ok {
            let _ = state
                .control
                .stage_edit(&ksx_api::StageEdit::RemoveSlot { number });
            return N_EDIT_ERROR;
        }
        if !stash.slot.socd.is_empty() && stash.slot.socd != "off" {
            let _ = state.control.stage_edit(&ksx_api::StageEdit::SetSocd {
                number,
                socd: stash.slot.socd,
            });
        }
        N_UNDO_OK
    })
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
    Form(form): Form<NocturneMoveForm>,
) -> Response {
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
    Form(form): Form<NocturneSocdForm>,
) -> Response {
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
    let flash = tokio::task::spawn_blocking(move || {
        let outcome = state.control.stage_apply();
        if outcome.ok {
            N_APPLY_OK
        } else if outcome.code.as_deref() == Some("needs-restart") {
            N_APPLY_RESTART
        } else {
            N_APPLY_ERROR
        }
    })
    .await
    .unwrap_or(N_APPLY_ERROR);
    nocturne_redirect(flash)
}

/// POST /nocturne/api/apply — the scripted twin of `/nocturne/apply`: the
/// same verb, but the browser gets the DAEMON'S OWN WORDS back, so a
/// `needs-restart` refusal opens a dialog quoting exactly what differs —
/// the flash allowlist only reflects fixed sentences, which is why the
/// no-JS door keeps its generic one.
pub(super) async fn nocturne_api_apply(State(state): State<Arc<AppState>>) -> Response {
    let outcome = tokio::task::spawn_blocking(move || state.control.stage_apply())
        .await
        .ok();
    let json = match outcome {
        Some(outcome) if outcome.ok => serde_json::json!({
            "done": true,
            "flash": N_APPLY_OK,
        }),
        Some(outcome) if outcome.code.as_deref() == Some("needs-restart") => serde_json::json!({
            "done": false,
            "code": "needs-restart",
            // The daemon's sentence naming the difference, verbatim.
            "message": outcome.error.unwrap_or_default(),
            "flash": N_APPLY_RESTART,
        }),
        _ => serde_json::json!({ "done": false, "flash": N_APPLY_ERROR }),
    };
    axum::Json(json).into_response()
}

/// POST /nocturne/controller/duplicate (and /workspace/controller/duplicate)
/// — the same controller again, in the next free slot. A COMPOSITION of
/// existing staging verbs: add + set-bindings + set-socd, with the fresh slot
/// removed again if the middle step refuses. Moved from /workspace verbatim.
pub(super) async fn nocturne_form_duplicate(
    State(state): State<Arc<AppState>>,
    Form(form): Form<NocturneSlotForm>,
) -> Response {
    let flash = tokio::task::spawn_blocking(move || {
        let staged = state.control.staged();
        let Some(source) = staged.slots.iter().find(|slot| slot.number == form.number) else {
            return N_EDIT_ERROR;
        };
        let (Some(new_number), Some(new_preset)) = (staged.next_slot, staged.next_preset.clone())
        else {
            return N_DUP_FULL;
        };
        let Some(mut authoring) = source.authoring.clone() else {
            // An older daemon serves no authoring table; there is nothing
            // honest to copy from.
            return N_EDIT_ERROR;
        };
        let persona = source.persona.clone();
        let socd = source.socd.clone();

        let added = state.control.stage_edit(&ksx_api::StageEdit::AddSlot {
            number: Some(new_number),
            persona,
            preset: new_preset.clone(),
            layout: None,
        });
        if !added.ok {
            return N_EDIT_ERROR;
        }
        // The copy keeps everything except the NAME, which must be the served
        // fresh one — a save writes one preset file per slot, and two slots
        // pointing at one file would alias their edits forever after.
        authoring.name = new_preset;
        let bound = state.control.stage_edit(&ksx_api::StageEdit::SetBindings {
            number: new_number,
            preset: Box::new(authoring),
        });
        if !bound.ok {
            let _ = state
                .control
                .stage_edit(&ksx_api::StageEdit::RemoveSlot { number: new_number });
            return N_EDIT_ERROR;
        }
        if !socd.is_empty() && socd != "off" {
            let _ = state.control.stage_edit(&ksx_api::StageEdit::SetSocd {
                number: new_number,
                socd,
            });
        }
        N_DUP_OK
    })
    .await
    .unwrap_or(N_EDIT_ERROR);
    nocturne_redirect(flash)
}

// ── The learner (moved from /map 2026-08-17, rebind-editor migration) ──────
// One daemon-owned listening surface for every door: /map's island, the
// identify-by-key transaction, and this page's rebind flow all speak to the
// same generation-stamped learner, so no two of them can mistake each
// other's key press for their own.

pub(super) async fn api_learn_poll(State(state): State<Arc<AppState>>) -> Response {
    control_json(state, |control| control.learn_poll()).await
}

pub(super) async fn api_learn_start(State(state): State<Arc<AppState>>) -> Response {
    control_json(state, |control| control.learn_start()).await
}

#[derive(Deserialize)]
pub(super) struct LearnCancelBody {
    generation: u64,
}

pub(super) async fn api_learn_cancel(
    State(state): State<Arc<AppState>>,
    axum::Json(body): axum::Json<LearnCancelBody>,
) -> Response {
    control_json(state, move |control| {
        control.learn_cancel_generation(Some(body.generation))
    })
    .await
}

// ── The staged bind verb (JSON) — what a learned key writes ────────────────

/// POST /nocturne/api/bind. The body names a SLOT NUMBER and ONE KEY; the
/// server resolves the preset identity and the control's current key list
/// from the staged setup it just read, so a hand-made POST can only address a
/// slot this draft actually has and no browser is ever trusted with a key
/// list it made up (the `/map` form twins' rule, kept).
///
/// `mode: "add"` joins the control's list (MAME-style OR-chain, a deliberate
/// fan-out — force is implied, exactly like /map's Add); anything else
/// replaces it. A cross-slot duplicate on replace comes back as the typed
/// `conflicts` rows for the consequence dialog; resubmitting with
/// `force: true` is the dialog's "Use here too".
#[derive(Deserialize)]
pub(super) struct NocturneBindBody {
    slot: u8,
    function: String,
    key: String,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    force: bool,
}

pub(super) async fn nocturne_api_bind(
    State(state): State<Arc<AppState>>,
    axum::Json(body): axum::Json<NocturneBindBody>,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || {
        let staged = state.control.staged();
        let Some(slot) = staged.slots.iter().find(|s| s.number == body.slot) else {
            return BindOutcome {
                ok: false,
                error: Some(format!(
                    "Player {} is no longer in this unsaved setup. Nothing changed.",
                    body.slot
                )),
                code: Some(ksx_api::codes::BAD_SLOT.to_owned()),
                ..BindOutcome::default()
            };
        };
        let key = body.key.trim();
        if key.is_empty() {
            return BindOutcome {
                ok: false,
                error: Some("No key was captured. Nothing changed.".to_owned()),
                code: Some(ksx_api::codes::BAD_REQUEST.to_owned()),
                ..BindOutcome::default()
            };
        }
        let (keys, force) = if body.mode.as_deref() == Some("add") {
            let current = nocturne_current_keys(&staged, slot, &body.function);
            if current.iter().any(|k| k.eq_ignore_ascii_case(key)) {
                return BindOutcome {
                    ok: false,
                    error: Some(format!("That control already has {key} — nothing to add.")),
                    code: Some(ksx_api::codes::BAD_REQUEST.to_owned()),
                    ..BindOutcome::default()
                };
            }
            let mut next = current;
            next.push(key.to_owned());
            (next, true)
        } else {
            (vec![key.to_owned()], body.force)
        };
        // Only the PROVIDER's outcome crosses the presentation boundary
        // through `consumerize_bind`; the guards above are this module's own
        // authored customer copy and pass through untouched.
        consumerize_bind(state.control.stage_bind(&ksx_api::StagedBindRequest {
            number: slot.number,
            preset: slot.preset.clone(),
            function: body.function,
            keys,
            force,
            turbo_hz: None,
            toggle: None,
        }))
    })
    .await
    .unwrap_or_else(|_| BindOutcome {
        ok: false,
        error: Some("That control could not be changed. Nothing changed.".to_owned()),
        code: Some(ksx_api::codes::REFUSED.to_owned()),
        ..BindOutcome::default()
    });
    (
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        axum::Json(outcome),
    )
        .into_response()
}

/// The control's current key list, read from the same staged mapper table
/// the page's rows render — never from anything a browser sent.
fn nocturne_current_keys(
    staged: &ksx_api::StagedSetupView,
    slot: &ksx_api::StagedSlotView,
    function: &str,
) -> Vec<String> {
    let keyboard = staged
        .device
        .as_ref()
        .map(|device| device.label.as_str())
        .unwrap_or("(none)");
    ksx_api::staged_mapper_slot(slot, keyboard)
        .ok()
        .and_then(|mapper| mapper.bindings.get(function).cloned())
        .unwrap_or_default()
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
    Form(form): Form<NocturneTurboForm>,
) -> Response {
    let raw = form.turbo_hz.as_deref().map(str::trim).unwrap_or("");
    let Ok(hz) = raw.parse::<u32>() else {
        return nocturne_redirect(N_TURBO_INPUT_ERROR);
    };
    let flash = tokio::task::spawn_blocking(move || {
        let staged = state.control.staged();
        let Some(slot) = staged.slots.iter().find(|s| s.number == form.slot) else {
            return N_EDIT_ERROR;
        };
        let current = nocturne_current_keys(&staged, slot, &form.function);
        if current.is_empty() {
            // An unbound control has no rate to set OR clear; saying
            // "updated" would claim a write that never happened.
            return N_TURBO_UNBOUND_ERROR;
        }
        let outcome = state.control.stage_bind(&ksx_api::StagedBindRequest {
            number: slot.number,
            preset: slot.preset.clone(),
            function: form.function,
            keys: current,
            // The key list is exactly what the control already holds, so no
            // NEW fan-out is being consented to — without this, a key that
            // was deliberately shared across players would re-trip the
            // conflict refusal on every rate edit.
            force: true,
            turbo_hz: Some(hz),
            toggle: None,
        });
        if outcome.ok {
            N_TURBO_OK
        } else {
            N_EDIT_ERROR
        }
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
    Form(form): Form<NocturneToggleForm>,
) -> Response {
    let latch = match form.mode.as_str() {
        "toggle" => true,
        "hold" => false,
        _ => return nocturne_redirect(N_EDIT_ERROR),
    };
    let flash = tokio::task::spawn_blocking(move || {
        let staged = state.control.staged();
        let Some(slot) = staged.slots.iter().find(|s| s.number == form.slot) else {
            return N_EDIT_ERROR;
        };
        let current = nocturne_current_keys(&staged, slot, &form.function);
        if current.is_empty() {
            return N_TOGGLE_UNBOUND_ERROR;
        }
        let outcome = state.control.stage_bind(&ksx_api::StagedBindRequest {
            number: slot.number,
            preset: slot.preset.clone(),
            function: form.function,
            keys: current,
            // Unchanged key list — re-affirmed, not newly shared (see the
            // turbo twin's note).
            force: true,
            turbo_hz: None,
            toggle: Some(latch),
        });
        if outcome.ok {
            N_TOGGLE_OK
        } else {
            N_EDIT_ERROR
        }
    })
    .await
    .unwrap_or(N_EDIT_ERROR);
    nocturne_redirect(flash)
}

// ── The macro machinery (moved from /map 2026-08-17, macro migration) ──────

/// POST /api/macro/save — write (or delete) one whole `[macros.<name>]`
/// table. Moved here with the macro-lifecycle migration; the target
/// resolution and the presentation boundary stay in map.rs beside their bind
/// twins, and this handler is the one door both pages' editors go through.
///
/// `reload` is forced on, exactly like the restore route: the daemon only
/// applies to a session that is actually RUNNING, and a macro body is a
/// binding change — the session hot-swaps it with the pads left plugged.
pub(super) async fn api_macro_save(
    State(state): State<Arc<AppState>>,
    axum::Json(request): axum::Json<TargetedMacroWrite>,
) -> Response {
    let write = crate::control::MacroWrite {
        reload: true,
        ..request.write
    };
    control_json(state, move |control| {
        consumerize_macro(macro_for_target(
            control,
            request.target.as_deref(),
            request.slot,
            &write,
        ))
    })
    .await
}

#[derive(Deserialize)]
pub(super) struct TargetedMacroWrite {
    #[serde(flatten)]
    write: crate::control::MacroWrite,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    slot: Option<u8>,
}

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
    let flash = tokio::task::spawn_blocking(move || {
        let staged = state.control.staged();
        let Some(found) = staged.slots.iter().find(|s| s.number == slot) else {
            return N_EDIT_ERROR;
        };
        let write = crate::control::MacroWrite {
            preset: found.preset.clone(),
            ..write
        };
        let outcome = state.control.stage_macro(&ksx_api::StagedMacroRequest {
            number: slot,
            write,
        });
        if outcome.ok {
            ok_flash
        } else {
            N_EDIT_ERROR
        }
    })
    .await
    .unwrap_or(N_EDIT_ERROR);
    nocturne_redirect(flash)
}

/// POST /nocturne/macro/toggle — disable (or re-enable) one macro. The table
/// keeps everything; only the flag moves — that is the whole promise of
/// disabling instead of deleting.
pub(super) async fn nocturne_form_macro_toggle(
    State(state): State<Arc<AppState>>,
    Form(form): Form<NocturneMacroForm>,
) -> Response {
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

/// POST /nocturne/macro/delete — remove one macro table (and the trigger
/// rows that would otherwise dangle) from THIS DRAFT. The row's fold states
/// the consequence before this verb is reachable; saved files are untouched
/// until Save.
pub(super) async fn nocturne_form_macro_delete(
    State(state): State<Arc<AppState>>,
    Form(form): Form<NocturneMacroForm>,
) -> Response {
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

/// POST /nocturne/bind/clear (and /workspace/bind/clear) — one control back
/// to unbound on the staged slot, via the daemon's own staged-bind verb with
/// the canonical clear placeholder. Moved from /workspace verbatim.
pub(super) async fn nocturne_form_bind_clear(
    State(state): State<Arc<AppState>>,
    Form(form): Form<NocturneClearForm>,
) -> Response {
    let ok = tokio::task::spawn_blocking(move || {
        let staged = state.control.staged();
        let Some(slot) = staged.slots.iter().find(|s| s.number == form.slot) else {
            return false;
        };
        state
            .control
            .stage_bind(&ksx_api::StagedBindRequest {
                number: form.slot,
                preset: slot.preset.clone(),
                function: form.function,
                keys: vec!["none".to_owned()],
                force: false,
                turbo_hz: None,
                toggle: None,
            })
            .ok
    })
    .await
    .unwrap_or(false);
    nocturne_redirect(if ok { N_EDIT_OK } else { N_EDIT_ERROR })
}

/// POST /nocturne/save — the ONE writing verb: stage-commit.
pub(super) async fn nocturne_form_save(State(state): State<Arc<AppState>>) -> Response {
    let ok = tokio::task::spawn_blocking(move || state.control.stage_commit().ok)
        .await
        .unwrap_or(false);
    nocturne_redirect(if ok { N_SAVE_OK } else { N_SAVE_ERROR })
}

/// POST /nocturne/play — start a session from the staged setup, writing
/// nothing. The daemon gates readiness; a refusal flashes without a start.
pub(super) async fn nocturne_form_play(State(state): State<Arc<AppState>>) -> Response {
    let ok = tokio::task::spawn_blocking(move || state.control.stage_play().ok)
        .await
        .unwrap_or(false);
    nocturne_redirect(if ok { N_PLAY_OK } else { N_PLAY_ERROR })
}

/// POST /nocturne/stop — end the session; keyboards type normally again.
pub(super) async fn nocturne_form_stop(State(state): State<Arc<AppState>>) -> Response {
    let ok = tokio::task::spawn_blocking(move || state.control.stop().is_ok())
        .await
        .unwrap_or(false);
    nocturne_redirect(if ok { N_STOP_OK } else { N_STOP_ERROR })
}

// ── The configuration menu's verbs (moved from /workspace and /start) ──────

/// POST /nocturne/adopt (and /workspace/adopt) — the saved configuration, or
/// one saved game, into an EMPTY draft. Moved from /workspace and extended
/// with the per-game form field. The daemon refuses over a non-empty stage
/// (adoption never overwrites edits) and that refusal is the feature: the
/// flash names Start over as the deliberate first step. LOAD only — Play is
/// its own decision, never welded onto this one.
#[derive(Deserialize)]
pub(super) struct NocturneAdoptForm {
    /// A games.toml profile title, or absent for the saved config.toml.
    /// Trimmed-empty means absent: a form with a blank field is a legal
    /// thing for a browser to send.
    #[serde(default)]
    profile: Option<String>,
}

pub(super) async fn nocturne_form_adopt(
    State(state): State<Arc<AppState>>,
    Form(form): Form<NocturneAdoptForm>,
) -> Response {
    let profile = form
        .profile
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_owned);
    let outcome =
        tokio::task::spawn_blocking(move || state.control.stage_adopt(profile.as_deref()))
            .await
            .ok();
    let flash = match outcome {
        Some(outcome) if outcome.ok => N_ADOPT_OK,
        Some(outcome) if outcome.code.as_deref() == Some("stage-not-empty") => N_ADOPT_BLOCKED,
        _ => N_EDIT_ERROR,
    };
    nocturne_redirect(flash)
}

/// POST /nocturne/discard (and /start/discard) — "Start over". FIRST-RUN §2
/// requires that it always works; the menu's fold carries the dirty-aware
/// warning BEFORE this verb is reachable, and saved files are never touched.
pub(super) async fn nocturne_form_discard(State(state): State<Arc<AppState>>) -> Response {
    let ok = tokio::task::spawn_blocking(move || {
        state.control.stage_edit(&ksx_api::StageEdit::Discard).ok
    })
    .await
    .unwrap_or(false);
    nocturne_redirect(if ok { N_DISCARD_OK } else { N_EDIT_ERROR })
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
            Err(_) => N_AUTOSTART_ERROR,
        }
    })
    .await
    .unwrap_or(N_AUTOSTART_ERROR);
    nocturne_redirect(flash)
}

// ── Identify (moved from /start; the one transaction, shared by every door) ─

/// The identify transaction itself, shared by `/nocturne`, `/start` and
/// `/workspace`: one daemon-owned listen, one machine-inventory resolution,
/// one reversible staged choice. The caller only decides where the flash
/// goes. Moved here with the rest of the keyboard backend.
pub(super) async fn identify_and_stage(state: Arc<AppState>) -> StartIdentifyResult {
    tokio::task::spawn_blocking(move || {
        let mut learn = state.control.learn_start();
        let Some(generation) = learn.generation else {
            return StartIdentifyResult::Failed;
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(11);
        loop {
            if !learn.ok || learn.generation != Some(generation) {
                return StartIdentifyResult::Failed;
            }
            match learn.state.as_str() {
                "hit" => {
                    let Some(observed_instance) = learn
                        .device
                        .as_deref()
                        .filter(|instance| !instance.trim().is_empty())
                    else {
                        return StartIdentifyResult::Failed;
                    };
                    let identified = match state.machine.device_identify(observed_instance) {
                        Ok(identified) => identified,
                        Err(_) => return StartIdentifyResult::Failed,
                    };
                    let outcome = state.control.stage_edit(&ksx_api::StageEdit::ChooseDevice {
                        selector: identified.selector,
                        alias: identified.alias,
                        label: identified.label,
                    });
                    return if outcome.ok {
                        StartIdentifyResult::Selected
                    } else {
                        StartIdentifyResult::Failed
                    };
                }
                "listening" => {
                    if std::time::Instant::now() >= deadline {
                        let _ = state.control.learn_cancel_generation(Some(generation));
                        return StartIdentifyResult::TimedOut;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    learn = state.control.learn_poll();
                }
                "timeout" => return StartIdentifyResult::TimedOut,
                "idle" | "cancelled" | "failed" | "unavailable" | "unknown" => {
                    return StartIdentifyResult::Failed;
                }
                _ => return StartIdentifyResult::Failed,
            }
        }
    })
    .await
    .unwrap_or(StartIdentifyResult::Failed)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum StartIdentifyResult {
    Selected,
    TimedOut,
    Failed,
}
