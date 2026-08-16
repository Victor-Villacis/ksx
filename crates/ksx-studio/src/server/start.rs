//! `/start` — first run, `FIRST-RUN.md`'s seven moments end to end.
//!
//! Split out of the 4,241-line `server.rs`. Every item here moved
//! verbatim: the router, the routes and the behaviour are unchanged.

use super::*;

// ── /start: the first run (docs/FIRST-RUN.md moments 4–7) ──────────────────

/// One fresh first-run payload: the staged setup, the device enumeration, the
/// presets on disk and whether the currently staged controller personas can
/// be materialized by their required output backends.
///
/// Independent reads with independent failure modes, kept apart all the way to the page —
/// `SURFACES.md` §1b. A dead daemon must not read as "you have staged
/// nothing", a refused enumeration must not read as "you have no keyboards",
/// an unreadable presets folder must not read as "nothing would be replaced",
/// and an output check that did not answer must not read as a working backend.
/// Each
/// degrades to the honest value its own type provides
/// (`StagedSetupView::unreachable`, `DeviceScanView::default`, a non-empty
/// `presets_error`, `ControllerOutputsView::unreadable`) and never to a
/// success-shaped default.
///
/// Never cached, and that is `FIRST-RUN.md` §5's visible-rescan requirement
/// met by construction: a user who plugs a keyboard in while this page is open
/// sees it at the next 2 s poll, without knowing a scan exists.
pub(super) async fn collect_start(state: &Arc<AppState>) -> StartPayload {
    let start_state = Arc::clone(state);
    tokio::task::spawn_blocking(move || {
        let staged = start_state.control.staged();
        let session = start_state.control.session();
        let (scan, unavailable) = match start_state.machine.device_scan() {
            Ok(scan) => (scan, String::new()),
            Err(refusal) => (ksx_api::DeviceScanView::default(), flash_of(refusal)),
        };
        let (presets, presets_error) = match start_state.machine.presets() {
            Ok(view) => (view.presets, String::new()),
            Err(refusal) => (Vec::new(), flash_of(refusal)),
        };
        // Requirements come from the live stage, so an Xbox/PlayStation setup
        // probes only ViGEmBus, a DualSense-only setup probes only HIDMaestro,
        // and an empty stage probes neither. A refusal preserves those
        // requirements as UNKNOWN rows rather than painting them healthy.
        let controller_outputs = start_state
            .machine
            .controller_outputs(&staged)
            .unwrap_or_else(|refusal| {
                ksx_api::ControllerOutputsView::unreadable(&staged, flash_of(refusal))
            });
        // A refusal leaves the card UNREADABLE rather than "off": a scheduler
        // nobody could ask has not told us the cabinet is unconfigured.
        let (autostart_read, autostart_error) = match start_state.machine.autostart() {
            Ok(view) => (Some(view), String::new()),
            Err(refusal) => (None, flash_of(refusal)),
        };
        StartPayload {
            staged,
            scan,
            session,
            controller_outputs,
            unavailable,
            presets,
            presets_error,
            autostart_read,
            autostart_error,
            flash: None,
            ..StartPayload::default()
        }
        .composed()
    })
    .await
    .unwrap_or_else(|_| {
        let staged = ksx_api::StagedSetupView::unreachable("the first-run collection panicked");
        StartPayload {
            controller_outputs: ksx_api::ControllerOutputsView::unreadable(
                &staged,
                "the first-run collection panicked",
            ),
            staged,
            scan: ksx_api::DeviceScanView::default(),
            session: SessionView::unreachable("the first-run collection panicked"),
            unavailable: "the device scan panicked — nothing below is a reading of this machine"
                .to_owned(),
            presets_error: "the preset read panicked".to_owned(),
            autostart_error: "the sign-in read panicked".to_owned(),
            ..StartPayload::default()
        }
        .composed()
    })
}

pub(super) async fn start_page(
    State(state): State<Arc<AppState>>,
    Query(query): Query<PageQuery>,
) -> Response {
    let mut payload = collect_start(&state).await;
    let flash = start_flash_from_query(query.flash.as_deref());
    payload.flash = flash.clone();
    let out = render_start(&state.start_page, &payload, flash.as_deref());
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

/// The poller's endpoint — the SAME [`StartPayload`] the page embeds (parity
/// pinned in render_start.rs). `flash` is always null: a poll is not an action.
pub(super) async fn api_start(State(state): State<Arc<AppState>>) -> Response {
    let payload = collect_start(&state).await;
    (
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        axum::Json(payload),
    )
        .into_response()
}

#[derive(Deserialize)]
pub(super) struct StartDeviceForm {
    /// The `ksx_core::DeviceSelector` the row carried
    /// (`ksx_api::BoardRow::selector`, served). **Never a path anybody typed**
    /// — `FIRST-RUN.md` §6 forbids asking, and the page has no text input.
    selector: String,
    alias: String,
    label: String,
}

#[derive(Deserialize)]
pub(super) struct StartCapturePrepareForm {
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
pub(super) struct StartCaptureReleaseForm {
    #[serde(default)]
    expected_selector: String,
    #[serde(default)]
    instance_id: String,
    #[serde(default)]
    confirm_release: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct StartControllerForm {
    persona: String,
    /// The preset name, from `StagedSetupView::next_preset`. Served rather than
    /// typed, because it becomes a file name.
    preset: String,
    /// The in-box layout it starts from — a `TemplateRow::id` off the SERVED
    /// roster (`StagedSetupView::layouts`), never a name anybody typed.
    ///
    /// Optional on the wire because a form without the field is a legal thing
    /// for a client to send, and the backend has one honest answer for it: a
    /// controller that binds nothing, which `commit()` then refuses by name.
    #[serde(default)]
    layout: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct StartLayoutForm {
    number: u8,
    layout: String,
}

#[derive(Deserialize)]
pub(super) struct StartPersonaForm {
    number: u8,
    persona: String,
}

#[derive(Deserialize)]
pub(super) struct StartSlotForm {
    number: u8,
}

#[derive(Deserialize)]
pub(super) struct StartBlockingForm {
    blocking: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum StartAction {
    Edit,
    Discard,
    Save,
    Play,
}

pub(super) const START_EDIT_OK: &str = "Setup updated. Nothing has been saved or started.";

pub(super) const START_IDENTIFY_OK: &str =
    "Keyboard identified and selected. Nothing has been captured, saved, or started.";

pub(super) const START_IDENTIFY_TIMEOUT: &str =
    "error: No keyboard answered in time. Nothing changed; try Identify again and press one key.";

pub(super) const START_IDENTIFY_ERROR: &str =
    "error: That key press could not be matched to one selectable keyboard. Nothing changed; Rescan and try again.";

pub(super) const START_DISCARD_OK: &str = "Setup cleared. Nothing was saved or started.";

pub(super) const START_SAVE_OK: &str = "Setup saved for later. Play has not started.";

pub(super) const START_PLAY_OK: &str = "Play started. Use Stop to return the keyboard to normal.";

pub(super) const START_EDIT_ERROR: &str =
    "error: Setup could not be updated. Reopen ksx and try again; nothing was changed.";

/// The one staging refusal whose remedy is an action on THIS page rather than
/// "try again" - and the one a four-player panel hits every time.
///
/// A template's player block is chosen by slot number, so adding a third
/// controller on a two-block layout is REFUSED, not merely a poor fit. The
/// domain composes the exact list of layouts that would work
/// (`ksx_api::stage::blocks_at_least`), and this page cannot reflect it: the
/// flash is a query parameter, and `START_FLASH_ALLOWLIST` exists precisely so
/// that nothing but this module's own copy can land there. So it points at the
/// served list on the page that carries the same fact.
pub(super) const START_EDIT_NO_PLAYER_BLOCK: &str =
    "error: That layout has no keys for this player, so the controller was not added. Pick a layout that covers more players - the list under 'What each layout expects' on this page says how many each one carries. Nothing was changed.";

pub(super) const START_DISCARD_ERROR: &str =
    "error: Setup could not be cleared. Reopen ksx and try again; nothing was changed.";

pub(super) const START_SAVE_NOT_READY: &str =
    "error: This setup is not ready to save. Complete the highlighted steps, then try again.";

pub(super) const START_SAVE_ERROR: &str =
    "error: Setup could not be saved. Reopen ksx and try again; nothing was changed.";

pub(super) const START_PLAY_NOT_READY: &str =
    "error: This setup is not ready to play. Complete the highlighted steps, then try again.";

/// Play blocked by a controller-output problem while Save still works — the
/// one refusal that must SAY the half that succeeded, or a user with a missing
/// driver concludes their whole setup is lost.
pub(super) const START_PLAY_OUTPUT_BLOCKED: &str =
    "error: This setup is ready to save, and Save still works. Play is blocked until the \
     highlighted controller-output problem is fixed.";

pub(super) const START_PLAY_ACTIVE: &str =
    "error: The active game could not be replaced. Open Home, stop Play, then try again.";

pub(super) const START_PLAY_ERROR: &str =
    "error: Play could not start. Reopen ksx and try again; nothing was saved.";

pub(super) const START_UNKNOWN_FLASH_ERROR: &str =
    "error: Setup could not finish that request. Reopen ksx and try again.";

pub(super) const START_CAPTURE_PREPARED_OK: &str =
    "Keyboard prepared. Windows verified this exact keyboard and Setup is ready to use it.";

pub(super) const START_CAPTURE_RELEASED_OK: &str =
    "Keyboard released. It can type normally again; prepare it again before Play if needed.";

pub(super) const START_CAPTURE_PREPARE_CONSENT: &str =
    "error: Confirm all three keyboard safety checks before continuing. Nothing was changed.";

pub(super) const START_CAPTURE_RELEASE_CONSENT: &str =
    "error: Confirm that you want to release this keyboard. Nothing was changed.";

pub(super) const START_CAPTURE_TARGET_CHANGED: &str =
    "error: The selected keyboard changed or could not be verified. Nothing was changed; Rescan and choose it again.";

pub(super) const START_CAPTURE_ALREADY_PREPARED: &str =
    "This keyboard is already prepared. Nothing was changed — use Release if you want it to type normally again.";

pub(super) const START_CAPTURE_ALREADY_RELEASED: &str =
    "This keyboard is already a normal keyboard. Nothing was changed — use Prepare if you want ksx to take it.";

pub(super) const START_CAPTURE_PREPARE_ERROR: &str =
    "error: Windows could not prepare this keyboard. Nothing in Setup was changed; keep the spare keyboard connected and try again.";

pub(super) const START_CAPTURE_RELEASE_ERROR: &str =
    "error: Windows could not release this keyboard. Nothing in Setup was changed; keep the spare keyboard connected and try again.";

pub(super) const START_CAPTURE_PREPARE_RECOVERY: &str =
    "error: Windows could not finish preparing this keyboard and it may need recovery. Keep the spare keyboard connected, reopen ksx, and use Release if it is offered. Setup was not changed.";

pub(super) const START_CAPTURE_RELEASE_RECOVERY: &str =
    "error: Windows could not finish releasing this keyboard and it may need recovery. Keep the spare keyboard connected and reopen ksx before trying again. Setup was not changed.";

pub(super) const START_CAPTURE_PREPARED_STAGE_CHANGED: &str =
    "error: Windows prepared the keyboard, but your Setup selection changed while permission was open. Choose the keyboard again to finish Setup.";

pub(super) const START_CAPTURE_RELEASED_STAGE_CHANGED: &str =
    "error: Windows released the keyboard, but your Setup selection changed while permission was open. Choose the keyboard again before Play.";

pub(super) const START_AUTOSTART_ON: &str =
    "ksx will now start when you sign in. Restart once to see it come up on its own.";

pub(super) const START_AUTOSTART_OFF: &str =
    "ksx will no longer start on its own. Open it yourself after a restart.";

pub(super) const START_AUTOSTART_CONSENT: &str =
    "error: Nothing was changed. Tick the box first to confirm what happens at sign-in.";

/// Windows accepted the registration and it is STILL pointing somewhere else.
/// Its own sentence, not folded into the error: the task now exists, so
/// "nothing was changed" would be false, and so would "done".
pub(super) const START_AUTOSTART_STILL_STALE: &str =
    "error: The sign-in task was written, but it is still out of date. Reload this page to see what it says now.";

pub(super) const START_AUTOSTART_ERROR: &str =
    "error: What happens at sign-in could not be changed. Nothing was changed; try again.";

pub(super) const START_FLASH_ALLOWLIST: [&str; 35] = [
    START_EDIT_OK,
    START_IDENTIFY_OK,
    START_IDENTIFY_TIMEOUT,
    START_IDENTIFY_ERROR,
    START_AUTOSTART_ON,
    START_AUTOSTART_OFF,
    START_AUTOSTART_CONSENT,
    START_AUTOSTART_STILL_STALE,
    START_AUTOSTART_ERROR,
    START_DISCARD_OK,
    START_SAVE_OK,
    START_PLAY_OK,
    START_EDIT_ERROR,
    START_EDIT_NO_PLAYER_BLOCK,
    START_DISCARD_ERROR,
    START_SAVE_NOT_READY,
    START_SAVE_ERROR,
    START_PLAY_NOT_READY,
    START_PLAY_OUTPUT_BLOCKED,
    START_PLAY_ACTIVE,
    START_PLAY_ERROR,
    START_UNKNOWN_FLASH_ERROR,
    START_CAPTURE_PREPARED_OK,
    START_CAPTURE_RELEASED_OK,
    START_CAPTURE_PREPARE_CONSENT,
    START_CAPTURE_RELEASE_CONSENT,
    START_CAPTURE_TARGET_CHANGED,
    START_CAPTURE_ALREADY_PREPARED,
    START_CAPTURE_ALREADY_RELEASED,
    START_CAPTURE_PREPARE_ERROR,
    START_CAPTURE_RELEASE_ERROR,
    START_CAPTURE_PREPARE_RECOVERY,
    START_CAPTURE_RELEASE_RECOVERY,
    START_CAPTURE_PREPARED_STAGE_CHANGED,
    START_CAPTURE_RELEASED_STAGE_CHANGED,
];

/// A query string is user-controlled even when our own POST produced it. Only
/// presentation copy this module can emit is allowed back onto `/start`; a
/// hand-written raw error becomes a generic remedy rather than customer text.
pub(super) fn start_flash_from_query(flash: Option<&str>) -> Option<String> {
    let flash = flash?.trim();
    if flash.is_empty() {
        return None;
    }
    Some(
        START_FLASH_ALLOWLIST
            .into_iter()
            .find(|safe| *safe == flash)
            .unwrap_or(START_UNKNOWN_FLASH_ERROR)
            .to_owned(),
    )
}

/// Translate provider outcomes at the Studio presentation boundary. The raw
/// sentence may contain commands, channel names, paths, or internal nouns; it
/// is used only to select a safe, useful state and is never reflected.
pub(super) fn start_action_flash(
    action: StartAction,
    outcome: &Result<String, String>,
) -> &'static str {
    match outcome {
        Ok(_) => match action {
            StartAction::Edit => START_EDIT_OK,
            StartAction::Discard => START_DISCARD_OK,
            StartAction::Save => START_SAVE_OK,
            StartAction::Play => START_PLAY_OK,
        },
        Err(error) => {
            let lower = error.to_ascii_lowercase();
            // The prerequisite family: every `setup_prerequisite` sentence
            // (snapshot.rs) ends "…before saving or playing", which is the
            // stable half this classifier keys off — matched, never
            // reflected. The other keywords cover the domain's own commit
            // refusals when a hand-made POST reaches the daemon anyway.
            let not_ready = lower.contains("not ready")
                || lower.contains("before saving or playing")
                || lower.contains("split-or-freeze")
                || lower.contains("no controls")
                || lower.contains("no device")
                || lower.contains("slot ");
            match action {
                // "player block(s)" is this workspace's own wording, out of
                // `TemplateError::NoSuchPlayer` - matched on, never reflected.
                StartAction::Edit if lower.contains("player block") => START_EDIT_NO_PLAYER_BLOCK,
                StartAction::Edit => START_EDIT_ERROR,
                StartAction::Discard => START_DISCARD_ERROR,
                StartAction::Save if not_ready => START_SAVE_NOT_READY,
                StartAction::Save => START_SAVE_ERROR,
                StartAction::Play
                    if lower.contains("already running")
                        || (lower.contains("session") && lower.contains("running")) =>
                {
                    START_PLAY_ACTIVE
                }
                // "ready to save, but…" is `play_status`'s own wording for a
                // controller-output problem: Save works, Play does not, and
                // the flash must keep saying both halves.
                StartAction::Play if lower.contains("ready to save") => START_PLAY_OUTPUT_BLOCKED,
                StartAction::Play if not_ready => START_PLAY_NOT_READY,
                StartAction::Play => START_PLAY_ERROR,
            }
        }
    }
}

/// 303 back to the first-run page with customer-facing action feedback.
pub(super) fn start_redirect(action: StartAction, outcome: Result<String, String>) -> Response {
    let flash = start_action_flash(action, &outcome);
    Redirect::to(&format!("/start?flash={}", urlencode(flash))).into_response()
}

/// Run one staging edit off the async workers (the pipe client blocks) and
/// 303 back.
///
/// Every one of these touches ONE value in the daemon and nothing else — no
/// file, no driver, no session. That is `FIRST-RUN.md` §2, and it is why this
/// helper has no confirm step, no backup and no dry run: there is nothing to
/// undo, because there is nothing to have done.
pub(super) async fn stage_edit(
    state: Arc<AppState>,
    edit: ksx_api::StageEdit,
    action: StartAction,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || {
        let outcome = state.control.stage_edit(&edit);
        if outcome.ok {
            Ok(outcome.headline())
        } else {
            Err(outcome.headline())
        }
    })
    .await
    .unwrap_or_else(|_| Err("the staging edit panicked".to_owned()));
    start_redirect(action, outcome)
}

/// POST /start/device — moment 4. Replaces any earlier choice, freely.
pub(super) async fn start_form_device(
    State(state): State<Arc<AppState>>,
    Form(form): Form<StartDeviceForm>,
) -> Response {
    stage_edit(
        state,
        ksx_api::StageEdit::ChooseDevice {
            selector: form.selector,
            alias: form.alias,
            label: form.label,
        },
        StartAction::Edit,
    )
    .await
}

/// POST /start/device/identify — ask the daemon-owned panel tap to listen for
/// one real key press, resolve that exact generation's device identity against
/// the current board inventory, then make the same reversible staged choice as
/// `/start/device`. It never opens a competing capture source, claims a driver,
/// writes a file, or starts a controller. Raw device identity and provider
/// errors never cross the presentation boundary.
pub(super) async fn start_form_identify(State(state): State<Arc<AppState>>) -> Response {
    let result = tokio::task::spawn_blocking(move || {
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
                    let outcome =
                        state
                            .control
                            .stage_edit(&ksx_api::StageEdit::ChooseDevice {
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
    .unwrap_or(StartIdentifyResult::Failed);
    let flash = match result {
        StartIdentifyResult::Selected => START_IDENTIFY_OK,
        StartIdentifyResult::TimedOut => START_IDENTIFY_TIMEOUT,
        StartIdentifyResult::Failed => START_IDENTIFY_ERROR,
    };
    Redirect::to(&format!("/start?flash={}", urlencode(flash))).into_response()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StartIdentifyResult {
    Selected,
    TimedOut,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum StartCaptureMutation {
    Prepare,
    Release,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum StartCaptureResult {
    Prepared,
    Released,
    ConsentMissing,
    TargetChanged,
    MutationFailed,
    /// The keyboard is already in the state that was asked for. Not a failure:
    /// the machine is fine, the request was simply redundant, and the useful
    /// answer names the state and offers the action that follows from it.
    AlreadyInState,
    RecoveryRequired,
    StageChanged,
}

/// Which refusals mean "already in that state".
///
/// Matched on the stable code, never on the sentence: refusal text is written
/// for an operator and can name paths and commands, so it is used to SELECT a
/// safe answer and is never reflected to the browser.
pub(super) fn already_in_state(refusal: &ksx_api::Refusal) -> bool {
    matches!(
        refusal.code.as_str(),
        "winusb-already-prepared" | "winusb-already-released"
    )
}

pub(super) fn start_capture_redirect(
    action: StartCaptureMutation,
    result: StartCaptureResult,
) -> Response {
    let flash = match (action, result) {
        (StartCaptureMutation::Prepare, StartCaptureResult::Prepared) => START_CAPTURE_PREPARED_OK,
        (StartCaptureMutation::Release, StartCaptureResult::Released) => START_CAPTURE_RELEASED_OK,
        (StartCaptureMutation::Prepare, StartCaptureResult::ConsentMissing) => {
            START_CAPTURE_PREPARE_CONSENT
        }
        (StartCaptureMutation::Release, StartCaptureResult::ConsentMissing) => {
            START_CAPTURE_RELEASE_CONSENT
        }
        (_, StartCaptureResult::TargetChanged) => START_CAPTURE_TARGET_CHANGED,
        (StartCaptureMutation::Prepare, StartCaptureResult::AlreadyInState) => {
            START_CAPTURE_ALREADY_PREPARED
        }
        (StartCaptureMutation::Release, StartCaptureResult::AlreadyInState) => {
            START_CAPTURE_ALREADY_RELEASED
        }
        (StartCaptureMutation::Prepare, StartCaptureResult::MutationFailed) => {
            START_CAPTURE_PREPARE_ERROR
        }
        (StartCaptureMutation::Release, StartCaptureResult::MutationFailed) => {
            START_CAPTURE_RELEASE_ERROR
        }
        (StartCaptureMutation::Prepare, StartCaptureResult::RecoveryRequired) => {
            START_CAPTURE_PREPARE_RECOVERY
        }
        (StartCaptureMutation::Release, StartCaptureResult::RecoveryRequired) => {
            START_CAPTURE_RELEASE_RECOVERY
        }
        (StartCaptureMutation::Prepare, StartCaptureResult::StageChanged) => {
            START_CAPTURE_PREPARED_STAGE_CHANGED
        }
        (StartCaptureMutation::Release, StartCaptureResult::StageChanged) => {
            START_CAPTURE_RELEASED_STAGE_CHANGED
        }
        // A success variant paired with the wrong action is an internal bug,
        // never a provider sentence suitable for a customer redirect.
        _ => START_UNKNOWN_FLASH_ERROR,
    };
    Redirect::to(&format!("/start?flash={}", urlencode(flash))).into_response()
}

/// Resolve the exact interface a capture mutation names, again, on the server.
///
/// The browser's hidden values are stale-action guards, not authority. An
/// absent, duplicate, ineligible, or differently-selected target refuses
/// before the elevated provider is called. Instance ids are Windows
/// case-insensitive, while selectors use their canonical exact spelling.
///
/// # Prepare goes through the stage; Release goes through the machine
///
/// Preparing takes a keyboard OUT of the keyboard stack, and the only reason
/// to do that is the setup being staged right now — so it stays gated on the
/// staged selection, unchanged.
///
/// Releasing is the UNDO, and gating the undo on the stage is the 2026-08-11
/// QA defect: the stage is per-visit daemon memory, so on a fresh install
/// there is none, after choosing another keyboard it names something else,
/// and after choosing the held keyboard itself it says `interception`
/// (`StageEdit::ChooseDevice` always does). In all three the board is off the
/// Windows keyboard stack and cannot type, and the one control that would
/// give it back refused. `docs/FIRST-RUN.md` §6: the only way out of a mistake
/// is never a shell command.
///
/// So Release resolves purely by identity, against the same live scan — one
/// board answering to this selector, one interface answering to this instance,
/// WinUSB-eligible, and actually claimed. Nothing weaker than before: what is
/// dropped is a stage comparison, not a machine one. The blast radius of the
/// difference is a loopback caller (already past `guard.rs`'s Host and Origin
/// checks) putting a ksx-held keyboard back on the keyboard stack — the safe
/// direction, and one the provider still refuses unless ksx owns the receipt.
pub(super) fn start_capture_target(
    state: &AppState,
    action: StartCaptureMutation,
    expected_selector: &str,
    instance_id: &str,
) -> Result<(String, String), StartCaptureResult> {
    if action == StartCaptureMutation::Prepare {
        let staged = state.control.staged();
        let device = staged
            .device
            .as_ref()
            .filter(|device| staged.reachable && device.selector == expected_selector)
            .ok_or(StartCaptureResult::TargetChanged)?;
        if device.backend != "interception" && device.backend != "winusb" {
            return Err(StartCaptureResult::TargetChanged);
        }
    }
    if expected_selector.trim().is_empty() || instance_id.trim().is_empty() {
        return Err(StartCaptureResult::TargetChanged);
    }

    let scan = state
        .machine
        .device_scan()
        .map_err(|_| StartCaptureResult::TargetChanged)?;
    let mut matches = scan
        .boards
        .iter()
        .filter(|board| board.selector.as_deref() == Some(expected_selector));
    let board = matches.next().ok_or(StartCaptureResult::TargetChanged)?;
    if matches.next().is_some() || !board.winusb_eligible {
        return Err(StartCaptureResult::TargetChanged);
    }
    let current_instance = board
        .keyboard
        .as_ref()
        .filter(|current| current.eq_ignore_ascii_case(instance_id))
        .ok_or(StartCaptureResult::TargetChanged)?;
    if scan
        .boards
        .iter()
        .flat_map(|candidate| candidate.interfaces.iter())
        .filter(|row| row.instance_id.eq_ignore_ascii_case(current_instance))
        .count()
        != 1
    {
        return Err(StartCaptureResult::TargetChanged);
    }
    if action == StartCaptureMutation::Release && !board.claimed {
        return Err(StartCaptureResult::TargetChanged);
    }
    Ok((
        board
            .selector
            .clone()
            .ok_or(StartCaptureResult::TargetChanged)?,
        current_instance.clone(),
    ))
}

pub(super) fn checked(value: Option<&str>) -> bool {
    value == Some("yes")
}

/// POST /start/capture/prepare — one exact keyboard, through the installed
/// MachineSource helper. Studio never starts a process, parses helper output,
/// or accepts a backend name from the browser. Only an authoritative
/// `prepared` result for the submitted exact instance licenses the guarded
/// in-memory backend transition.
pub(super) async fn start_form_capture_prepare(
    State(state): State<Arc<AppState>>,
    Form(form): Form<StartCapturePrepareForm>,
) -> Response {
    if !checked(form.confirm_spare_keyboard.as_deref())
        || !checked(form.confirm_rebind.as_deref())
        || !checked(form.confirm_machine_certificate.as_deref())
    {
        return start_capture_redirect(
            StartCaptureMutation::Prepare,
            StartCaptureResult::ConsentMissing,
        );
    }
    let outcome = tokio::task::spawn_blocking(move || {
        let (expected_selector, instance_id) = start_capture_target(
            &state,
            StartCaptureMutation::Prepare,
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
                StartCaptureResult::AlreadyInState
            } else {
                StartCaptureResult::MutationFailed
            }
        })?;
        if mutation.state == "recovery-required"
            && mutation.instance_id.eq_ignore_ascii_case(&instance_id)
        {
            return Err(StartCaptureResult::RecoveryRequired);
        }
        if mutation.state != "prepared" || !mutation.instance_id.eq_ignore_ascii_case(&instance_id)
        {
            return Err(StartCaptureResult::MutationFailed);
        }
        let staged = state
            .control
            .stage_edit(&ksx_api::StageEdit::SetDeviceBackend {
                expected_selector,
                backend: "winusb".to_owned(),
            });
        if !staged.ok {
            return Err(StartCaptureResult::StageChanged);
        }
        Ok(StartCaptureResult::Prepared)
    })
    .await
    .unwrap_or(Err(StartCaptureResult::MutationFailed));
    start_capture_redirect(
        StartCaptureMutation::Prepare,
        outcome.unwrap_or_else(|failure| failure),
    )
}

/// POST /start/capture/release — the inverse transition, with the same exact
/// identity and stale-stage guards. A raw helper/provider message never
/// crosses this presentation boundary.
pub(super) async fn start_form_capture_release(
    State(state): State<Arc<AppState>>,
    Form(form): Form<StartCaptureReleaseForm>,
) -> Response {
    if !checked(form.confirm_release.as_deref()) {
        return start_capture_redirect(
            StartCaptureMutation::Release,
            StartCaptureResult::ConsentMissing,
        );
    }
    let outcome = tokio::task::spawn_blocking(move || {
        let (expected_selector, instance_id) = start_capture_target(
            &state,
            StartCaptureMutation::Release,
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
                StartCaptureResult::AlreadyInState
            } else {
                StartCaptureResult::MutationFailed
            }
        })?;
        if mutation.state == "recovery-required"
            && mutation.instance_id.eq_ignore_ascii_case(&instance_id)
        {
            return Err(StartCaptureResult::RecoveryRequired);
        }
        if mutation.state != "released" || !mutation.instance_id.eq_ignore_ascii_case(&instance_id)
        {
            return Err(StartCaptureResult::MutationFailed);
        }
        // **Only the STAGED board's backend follows the release.** A held
        // keyboard that is not this visit's selection has no staged backend to
        // correct, and posting one would refuse (`set_device_backend` compares
        // selectors) — turning a release that actually happened into an error
        // flash, which is `SURFACES.md` §1b's failure with the two halves
        // swapped: reporting failure over a success.
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
                return Err(StartCaptureResult::StageChanged);
            }
        }
        Ok(StartCaptureResult::Released)
    })
    .await
    .unwrap_or(Err(StartCaptureResult::MutationFailed));
    start_capture_redirect(
        StartCaptureMutation::Release,
        outcome.unwrap_or_else(|failure| failure),
    )
}

/// POST /start/controller — moment 5. `number: None` so the backend picks the
/// lowest free slot: a first-run user must never be asked for a slot number.
pub(super) async fn start_form_controller(
    State(state): State<Arc<AppState>>,
    Form(form): Form<StartControllerForm>,
) -> Response {
    stage_edit(
        state,
        ksx_api::StageEdit::AddSlot {
            number: None,
            persona: form.persona,
            preset: form.preset,
            layout: form.layout,
        },
        StartAction::Edit,
    )
    .await
}

/// POST /start/controller/persona — change a staged controller freely. This
/// is still an in-memory StageEdit: no pad is replugged and no file is written.
pub(super) async fn start_form_controller_persona(
    State(state): State<Arc<AppState>>,
    Form(form): Form<StartPersonaForm>,
) -> Response {
    stage_edit(
        state,
        ksx_api::StageEdit::SetPersona {
            number: form.number,
            persona: form.persona,
        },
        StartAction::Edit,
    )
    .await
}

/// POST /start/controller/layout — moment 6's menu half.
///
/// The surface names a layout; ksx-core builds the preset. Nothing here writes
/// a file: the bindings land in the staged slot, which is what makes "map it"
/// a step this flow can actually perform before anything has been saved. The
/// player block follows the slot number, so nobody is asked what a player block
/// is.
pub(super) async fn start_form_layout(
    State(state): State<Arc<AppState>>,
    Form(form): Form<StartLayoutForm>,
) -> Response {
    stage_edit(
        state,
        ksx_api::StageEdit::SetLayout {
            number: form.number,
            layout: form.layout,
            player: None,
        },
        StartAction::Edit,
    )
    .await
}

/// POST /start/controller/remove — moment 5's other half. Free and complete.
pub(super) async fn start_form_remove(
    State(state): State<Arc<AppState>>,
    Form(form): Form<StartSlotForm>,
) -> Response {
    stage_edit(
        state,
        ksx_api::StageEdit::RemoveSlot {
            number: form.number,
        },
        StartAction::Edit,
    )
    .await
}

/// POST /start/blocking — moment 6's one question (`FIRST-RUN.md` §3).
pub(super) async fn start_form_blocking(
    State(state): State<Arc<AppState>>,
    Form(form): Form<StartBlockingForm>,
) -> Response {
    stage_edit(
        state,
        ksx_api::StageEdit::SetBlocking {
            blocking: form.blocking,
        },
        StartAction::Edit,
    )
    .await
}

/// What POST /start/autostart carries. `enable` is the DIRECTION, served on
/// the card, never inferred here from the current state: a form submitted
/// against a page that has since gone stale must do what its user read, or
/// nothing.
#[derive(Debug, Deserialize)]
pub(super) struct StartAutostartForm {
    #[serde(default)]
    enable: Option<String>,
    #[serde(default)]
    confirm_autostart: Option<String>,
}

/// POST /start/autostart - the commissioning step, and the only machine
/// lifecycle write on this page that needs no elevation.
///
/// A per-user scheduled task: nothing outside the signed-in account changes,
/// no driver moves, no keyboard leaves the stack. That is why it takes one
/// tick box rather than the three-confirmation-plus-UAC ceremony
/// `/start/capture/prepare` carries - the consent ceremonies here are sized to
/// what is actually at risk, not applied uniformly.
pub(super) async fn start_form_autostart(
    State(state): State<Arc<AppState>>,
    Form(form): Form<StartAutostartForm>,
) -> Response {
    if !checked(form.confirm_autostart.as_deref()) {
        return start_autostart_redirect(START_AUTOSTART_CONSENT);
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
            Ok(view) if view.registered && !view.stale => START_AUTOSTART_ON,
            Ok(view) if view.registered => START_AUTOSTART_STILL_STALE,
            Ok(_) => START_AUTOSTART_OFF,
            Err(_) => START_AUTOSTART_ERROR,
        }
    })
    .await
    .unwrap_or(START_AUTOSTART_ERROR);
    start_autostart_redirect(flash)
}

pub(super) fn start_autostart_redirect(flash: &'static str) -> Response {
    Redirect::to(&format!("/start?flash={}", urlencode(flash))).into_response()
}

/// POST /start/discard — "Start over". §2 requires that it always works.
pub(super) async fn start_form_discard(State(state): State<Arc<AppState>>) -> Response {
    stage_edit(state, ksx_api::StageEdit::Discard, StartAction::Discard).await
}

/// POST /start/save — moment 7, half one. **One config write.**
///
/// The same shape `/setup/slot` and `/devices/pick` use: a backend verb that
/// takes a timestamped backup and hands the I/O to the store's atomic save.
/// It starts nothing — `Committed::message` says so in words, because "saved"
/// and "playing" are the two states this flow must never let anyone confuse.
pub(super) async fn start_form_save(State(state): State<Arc<AppState>>) -> Response {
    // The domain validates the staged shape; the Studio seam additionally
    // validates that its selected capture backend is usable on this machine
    // now. A hand-authored POST must not bypass the disabled button.
    let current = collect_start(&state).await;
    if !current.flags.can_save {
        return start_redirect(
            StartAction::Save,
            Err(current.lines.save_status),
        );
    }
    let outcome = tokio::task::spawn_blocking(move || {
        let outcome = state.control.stage_commit();
        if outcome.ok {
            Ok(outcome.headline())
        } else {
            Err(outcome.headline())
        }
    })
    .await
    .unwrap_or_else(|_| Err("the save panicked".to_owned()));
    start_redirect(StartAction::Save, outcome)
}

/// POST /start/play — moment 7, half two. **Starts a session and writes
/// nothing.**
///
/// Separate from Save on purpose (§2: "saving and playing are separate acts"),
/// and not a flag on it: a combined button would make the two indistinguishable
/// at the moment a user is deciding whether to commit to anything at all. The
/// plan is built in the daemon from the staged value with no file read
/// (`ksx-backend`'s `stage::plan`), so a session that starts here means exactly
/// what the screen showed.
pub(super) async fn start_form_play(State(state): State<Arc<AppState>>) -> Response {
    let current = collect_start(&state).await;
    if !current.flags.can_play {
        return start_redirect(
            StartAction::Play,
            Err(current.lines.play_status),
        );
    }
    let outcome = tokio::task::spawn_blocking(move || {
        let outcome = state.control.stage_play();
        if outcome.ok {
            Ok(outcome.headline())
        } else {
            Err(outcome.headline())
        }
    })
    .await
    .unwrap_or_else(|_| Err("the staged start panicked".to_owned()));
    start_redirect(StartAction::Play, outcome)
}
