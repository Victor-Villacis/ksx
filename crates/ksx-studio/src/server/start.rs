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
    let theme = page_theme(&state).await;
    let out = crate::render::with_theme(
        render_start(&state.start_page, &payload, flash.as_deref()),
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

// `Discard` left this enum on 2026-08-17: "Start over" and the sign-in task
// both MOVED to `server/nocturne.rs` with the configuration-menu migration —
// `/start/discard` and `/start/autostart` point at the moved handlers and
// answer on `/nocturne`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum StartAction {
    Edit,
    Save,
    Play,
}

pub(super) const START_EDIT_OK: &str = "Setup updated. Nothing has been saved or started.";

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

pub(super) const START_FLASH_ALLOWLIST: [&str; 12] = [
    START_EDIT_OK,
    START_SAVE_OK,
    START_PLAY_OK,
    START_EDIT_ERROR,
    START_EDIT_NO_PLAYER_BLOCK,
    START_SAVE_NOT_READY,
    START_SAVE_ERROR,
    START_PLAY_NOT_READY,
    START_PLAY_OUTPUT_BLOCKED,
    START_PLAY_ACTIVE,
    START_PLAY_ERROR,
    START_UNKNOWN_FLASH_ERROR,
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

// The sign-in task (`/start/autostart`) and "Start over" (`/start/discard`)
// MOVED to `server/nocturne.rs` on 2026-08-17 with the configuration-menu
// migration. The routes are unchanged and this page's cards keep rendering;
// pressing their buttons lands the answer on `/nocturne`.

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
        return start_redirect(StartAction::Save, Err(current.lines.save_status));
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
        return start_redirect(StartAction::Play, Err(current.lines.play_status));
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
