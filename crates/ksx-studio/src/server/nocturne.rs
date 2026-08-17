//! `/nocturne` — the Nocturne front end, now growing its REAL backend.
//!
//! The keyboard section migrated here from `/start` on 2026-08-17 — MOVED,
//! not copied: the device pick (`ChooseDevice`), identify-by-key, the
//! split-or-freeze answer, and the WinUSB prepare/release transactions with
//! their exact-identity guards all live in this module now, and `/start`'s
//! own routes for them point at these handlers. `/start` keeps rendering its
//! frames untouched, but pressing its keyboard buttons lands the answer on
//! `/nocturne` — the old page hollows out one section at a time while the new
//! one becomes the product surface.
//!
//! The rest of the page (rack, binding list, session) is still the design
//! proof's placeholder until its own migration pass.

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

pub(super) const N_UNKNOWN_FLASH_ERROR: &str =
    "error: That request could not be finished. Reopen ksx and try again.";

pub(super) const N_FLASH_ALLOWLIST: [&str; 30] = [
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
pub(super) async fn collect_nocturne(state: &Arc<AppState>) -> NocturnePayload {
    let state = Arc::clone(state);
    tokio::task::spawn_blocking(move || {
        let staged = state.control.staged();
        let session = state.control.session();
        let (scan, unavailable) = match state.machine.device_scan() {
            Ok(scan) => (scan, String::new()),
            Err(refusal) => (ksx_api::DeviceScanView::default(), flash_of(refusal)),
        };
        NocturnePayload {
            staged,
            scan,
            session,
            unavailable,
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
            view: Default::default(),
        }
        .derived()
    })
}

/// `GET /nocturne` — the page, server-rendered from the real keyboard facts.
pub(super) async fn nocturne_page_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<PageQuery>,
) -> Response {
    let payload = collect_nocturne(&state).await;
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
pub(super) async fn api_nocturne(State(state): State<Arc<AppState>>) -> Response {
    let payload = collect_nocturne(&state).await;
    (
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        axum::Json(payload),
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

/// POST /nocturne/controller/remove (and /workspace/controller/remove).
pub(super) async fn nocturne_form_remove(
    State(state): State<Arc<AppState>>,
    Form(form): Form<NocturneSlotForm>,
) -> Response {
    nocturne_stage_edit(
        state,
        ksx_api::StageEdit::RemoveSlot {
            number: form.number,
        },
    )
    .await
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
