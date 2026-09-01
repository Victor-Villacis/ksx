//! `/redesign` — the transplant rebuild's workbench.
//!
//! The same shape as every page module here: one collector on a blocking
//! worker, one GET that renders it themed, one JSON twin the island polls —
//! plus thin route adapters over the shared workbench application layer.
//! Each form keeps its own 303 target and the same allowlisted `?flash=`
//! outcome channel without depending on another surface's handlers.

use super::workbench::{
    self as wb, bind_clear_source_flash, bind_toggle_source_flash, bind_turbo_source_flash,
    blocking_write_flash, checked, clear_all_source_flash, duplicate_slot_flash,
    identify_and_stage_for_redesign, key_clear_source_flash, macro_new_source_flash,
    macro_write_source_flash, restore_slot_routes, stash_removed_slot, undo_chip_label,
    undo_removal_flash, upsert_device_preserving_preparation, DeviceChoice, StartIdentifyResult,
    N_ADD_LAYOUT_ERROR, N_ADOPT_BLOCKED, N_ADOPT_OK, N_APPLY_ERROR, N_APPLY_OK, N_APPLY_RESTART,
    N_BLOCKING_OK, N_CAPTURE_ALREADY_PREPARED, N_CAPTURE_ALREADY_RELEASED, N_CAPTURE_PREPARED_OK,
    N_CAPTURE_PREPARED_STAGE_CHANGED, N_CAPTURE_PREPARE_CONSENT, N_CAPTURE_PREPARE_ERROR,
    N_CAPTURE_PREPARE_RECOVERY, N_CAPTURE_RELEASED_OK, N_CAPTURE_RELEASED_STAGE_CHANGED,
    N_CAPTURE_RELEASE_CONSENT, N_CAPTURE_RELEASE_ERROR, N_CAPTURE_RELEASE_RECOVERY,
    N_CAPTURE_TARGET_CHANGED, N_CLEAR_ALL_OK, N_DEVICE_ALREADY_OK, N_DEVICE_OK, N_DISCARD_OK,
    N_DUP_FULL, N_DUP_OK, N_EDIT_ERROR, N_EDIT_OK, N_FORM_UNREADABLE, N_IDENTIFY_ERROR,
    N_IDENTIFY_OK, N_IDENTIFY_TIMEOUT, N_KEY_CLEAR_NONE, N_KEY_CLEAR_OK, N_MACRO_BADNAME,
    N_MACRO_DELETED, N_MACRO_NAME, N_MACRO_NEW, N_MACRO_OK, N_MACRO_TAKEN, N_MOVE_AT_END,
    N_PLAY_BLOCKING, N_PLAY_CAPTURE, N_PLAY_ERROR, N_PLAY_NO_BINDINGS, N_PLAY_NO_DEVICE,
    N_PLAY_NO_SLOTS, N_PLAY_OK, N_PLAY_OUTPUT_BLOCKED, N_PLAY_OUTPUT_UNKNOWN, N_READ_SCAN_ERROR,
    N_READ_SETUP_ERROR, N_SAVE_BLOCKING, N_SAVE_CAPTURE, N_SAVE_ERROR, N_SAVE_NO_BINDINGS,
    N_SAVE_NO_DEVICE, N_SAVE_NO_SLOTS, N_SAVE_OK, N_STOP_ERROR, N_STOP_OK, N_THEME_OK,
    N_THEME_UNKNOWN, N_TOGGLE_OK, N_TOGGLE_OLD_DAEMON, N_TOGGLE_UNBOUND_ERROR, N_TURBO_INPUT_ERROR,
    N_TURBO_OK, N_TURBO_UNBOUND_ERROR, N_UNDO_FULL, N_UNDO_GONE, N_UNDO_OK, N_UNKNOWN_FLASH_ERROR,
};
use super::*;

const RD_DISCARD_CONFIRM: &str =
    "error: Confirm Start over before discarding unsaved changes. Nothing was changed.";
const RD_DISCARD_CHANGED: &str =
    "error: This draft changed since Start over was opened. Review it and confirm again; nothing was changed.";
const RD_LIFECYCLE_CHANGED: &str =
    "error: This draft changed or could not be verified. Refresh the workbench before continuing; nothing was changed.";
const RD_IDENTIFY_CANCELLED: &str = "Keyboard identification cancelled. Nothing changed.";
const RD_IDENTIFY_ALREADY_ANSWERED: &str =
    "error: That keyboard identification has already answered. Check the current input source before trying again.";
const RD_IDENTIFY_BUSY: &str =
    "error: Another keyboard identification is already listening. Finish or cancel it there; nothing changed.";
const RD_DEVICE_REMOVED: &str =
    "Keyboard removed from the workbench. Its controller routes were removed with it; saved files were not changed.";
const RD_DEVICE_REMOVE_CONFIRM: &str =
    "error: This keyboard has controller mappings. Confirm Remove to discard those unsaved routes; nothing was changed.";

#[derive(Deserialize)]
pub(super) struct RedesignQuery {
    flash: Option<String>,
    /// The selected controller slot — the nocturne selection rule: an
    /// explicit `?slot=` wins, otherwise the first staged controller speaks
    /// for the inspector panel.
    slot: Option<u8>,
    /// Exact staged keyboard route selected beneath that controller.
    source: Option<String>,
    /// The macro the step editor opens on (the nocturne door: ?slot&macro).
    #[serde(rename = "macro")]
    macro_selected: Option<String>,
    /// The bind-pane filter, resolved server-side like nocturne.
    q: Option<String>,
    /// Explicit cache bust for the user-facing Rescan action. Kept as a
    /// string so the stable `fresh=1` URL contract stays shared with the
    /// diagnostic surfaces instead of depending on serde's bool spelling.
    fresh: Option<String>,
}

fn redesign_fresh_requested(fresh: Option<&str>) -> bool {
    fresh.is_some_and(|value| value.trim() == "1")
}

fn invalidate_redesign_cache_for_fresh(state: &AppState, fresh: Option<&str>) {
    if redesign_fresh_requested(fresh) {
        state.machine_cache.invalidate();
    }
}

/// The sentences this page may be asked to repeat after a redirect, resolved
/// against an allowlist exactly like `/nocturne` — never reflected. Every
/// verb's sentences ARE nocturne's constants: one wording, two pages, so the
/// copy cannot drift between the surfaces (the cutover's "provider text"
/// lesson, applied in advance).
const RD_FLASH_ALLOWLIST: &[&str] = &[
    N_THEME_OK,
    N_THEME_UNKNOWN,
    N_DEVICE_OK,
    N_DEVICE_ALREADY_OK,
    N_IDENTIFY_OK,
    N_IDENTIFY_TIMEOUT,
    N_IDENTIFY_ERROR,
    RD_IDENTIFY_CANCELLED,
    RD_IDENTIFY_ALREADY_ANSWERED,
    RD_IDENTIFY_BUSY,
    RD_DEVICE_REMOVED,
    RD_DEVICE_REMOVE_CONFIRM,
    N_FORM_UNREADABLE,
    N_EDIT_OK,
    N_EDIT_ERROR,
    N_MOVE_AT_END,
    N_ADD_LAYOUT_ERROR,
    N_UNKNOWN_FLASH_ERROR,
    N_CLEAR_ALL_OK,
    N_UNDO_OK,
    N_UNDO_GONE,
    N_UNDO_FULL,
    N_DUP_OK,
    N_DUP_FULL,
    N_TURBO_OK,
    N_TURBO_INPUT_ERROR,
    N_TURBO_UNBOUND_ERROR,
    N_TOGGLE_OK,
    N_TOGGLE_OLD_DAEMON,
    N_TOGGLE_UNBOUND_ERROR,
    N_KEY_CLEAR_OK,
    N_KEY_CLEAR_NONE,
    N_BLOCKING_OK,
    N_MACRO_OK,
    N_MACRO_NEW,
    N_MACRO_NAME,
    N_MACRO_TAKEN,
    N_MACRO_BADNAME,
    N_MACRO_DELETED,
    // The operational shell aliases. These remain the workbench's ONE set of
    // customer sentences; only each route's redirect home changes.
    N_SAVE_OK,
    N_SAVE_ERROR,
    N_SAVE_BLOCKING,
    N_SAVE_NO_BINDINGS,
    N_SAVE_NO_DEVICE,
    N_SAVE_NO_SLOTS,
    N_SAVE_CAPTURE,
    N_PLAY_OK,
    N_PLAY_ERROR,
    N_PLAY_BLOCKING,
    N_PLAY_NO_BINDINGS,
    N_PLAY_NO_DEVICE,
    N_PLAY_NO_SLOTS,
    N_PLAY_CAPTURE,
    N_PLAY_OUTPUT_BLOCKED,
    N_PLAY_OUTPUT_UNKNOWN,
    N_STOP_OK,
    N_STOP_ERROR,
    N_APPLY_OK,
    N_APPLY_RESTART,
    N_APPLY_ERROR,
    N_ADOPT_OK,
    N_ADOPT_BLOCKED,
    N_DISCARD_OK,
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
    RD_DISCARD_CONFIRM,
    RD_DISCARD_CHANGED,
    RD_LIFECYCLE_CHANGED,
];

pub(super) fn redesign_flash_from_query(flash: Option<&str>) -> Option<String> {
    let flash = flash?.trim();
    if flash.is_empty() {
        return None;
    }
    Some(
        RD_FLASH_ALLOWLIST
            .iter()
            .copied()
            .find(|safe| *safe == flash)
            .unwrap_or(N_UNKNOWN_FLASH_ERROR)
            .to_owned(),
    )
}

fn redesign_redirect(flash: &str) -> Response {
    Redirect::to(&format!("/redesign?flash={}", urlencode(flash))).into_response()
}

/// The native fallback submits to a verb URL, so the browser's current
/// workbench query is not part of the form target. Recover only the three
/// durable navigation fields from a same-origin `/redesign` referrer. The
/// redirect destination itself remains server-owned and fixed below; this is
/// context preservation, never a browser-supplied return URL.
fn redesign_return_context(request: &axum::extract::Request) -> Option<String> {
    if request.method() != axum::http::Method::POST
        || !request.uri().path().starts_with("/redesign/")
    {
        return None;
    }

    let host = request.headers().get(header::HOST)?.to_str().ok()?.trim();
    let referer: axum::http::Uri = request
        .headers()
        .get(header::REFERER)?
        .to_str()
        .ok()?
        .parse()
        .ok()?;
    if referer.scheme_str() != Some("http")
        || referer
            .authority()
            .is_none_or(|authority| !authority.as_str().eq_ignore_ascii_case(host))
        || referer.path() != "/redesign"
    {
        return None;
    }

    let Query(query) = Query::<RedesignQuery>::try_from_uri(&referer).ok()?;
    let mut context = Vec::new();
    if let Some(slot) = query
        .slot
        .filter(|slot| (1..=ksx_api::MAX_SLOTS).contains(slot))
    {
        context.push(format!("slot={slot}"));
    }
    for (name, value) in [
        ("source", query.source),
        ("macro", query.macro_selected),
        ("q", query.q),
    ] {
        if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
            context.push(format!("{name}={}", urlencode(&value)));
        }
    }
    (!context.is_empty()).then(|| context.join("&"))
}

/// Add the validated native-page context only to our own 303 back to the
/// workbench. API responses, refusals, external redirects and future routes
/// are left byte-for-byte alone.
pub(super) async fn preserve_redesign_redirect_context(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let context = redesign_return_context(&request);
    let mut response = next.run(request).await;
    let Some(context) = context else {
        return response;
    };
    if response.status() != StatusCode::SEE_OTHER {
        return response;
    }
    let Some(current) = response
        .headers()
        .get(header::LOCATION)
        .and_then(|value| value.to_str().ok())
    else {
        return response;
    };
    let Ok(target) = current.parse::<axum::http::Uri>() else {
        return response;
    };
    if target.scheme().is_some() || target.authority().is_some() || target.path() != "/redesign" {
        return response;
    }

    let separator = if target.query().is_some() { '&' } else { '?' };
    let location = format!("{current}{separator}{context}");
    if let Ok(location) = HeaderValue::from_str(&location) {
        response.headers_mut().insert(header::LOCATION, location);
    }
    response
}

fn redesign_identify_redirect(flash: &str, selector: Option<&str>) -> Response {
    let mut location = format!("/redesign?flash={}", urlencode(flash));
    if let Some(selector) = selector.filter(|selector| !selector.trim().is_empty()) {
        location.push_str("&identified_selector=");
        location.push_str(&urlencode(selector));
    }
    Redirect::to(&location).into_response()
}

/// One fresh [`RedesignPayload`]: the machine provenance and the theme
/// roster, on a blocking worker like every other collector read. The page
/// derives its `<html data-theme>` stamp from the chosen row in this payload,
/// so the stamp and the menu cannot disagree within a render.
pub(super) async fn collect_redesign(
    state: &Arc<AppState>,
    selected_slot: Option<u8>,
    selected_source: Option<String>,
    macro_selected: Option<String>,
    q: Option<String>,
) -> RedesignPayload {
    let redesign_state = Arc::clone(state);
    let environment = state.source.environment();
    let fallback_environment = environment.clone();
    tokio::task::spawn_blocking(move || {
        let (setup, setup_error) = match redesign_state
            .machine_cache
            .setup_state(&*redesign_state.machine)
        {
            Ok(setup) => (Some(setup), String::new()),
            Err(_) => (None, N_READ_SETUP_ERROR.to_owned()),
        };
        // The device scan, through the MACHINE CACHE now that this page
        // polls (the mapper migration brought nocturne's 2 s tick): a USB
        // tree enumeration per tick is work the machine did not ask for.
        // The cache is TTL-bounded and invalidated by every mutating
        // request, so nothing the studio itself changed is ever stale; an
        // unplugged board leaves the roster at the TTL, exactly like
        // /nocturne's. The refusal keeps its remedy (the `/devices`
        // composition): it is going onto a page, and "run `ksx devices`"
        // is the whole value of the message.
        let scan = redesign_state
            .machine_cache
            .device_scan(&*redesign_state.machine)
            // The provider refusal remains diagnostic. This sentence is
            // customer copy in the device picker and capture recovery card.
            .map_err(|_| N_READ_SCAN_ERROR.to_owned());
        // The staged device — the daemon's answer to "which board does ksx
        // split", marked onto the picker rows and the bench cards.
        let staged = redesign_state.control.staged();
        let session = redesign_state.control.session();
        // Play has a stricter gate than Save. Ask the machine about exactly
        // the output stacks this draft requires; a refused read defaults to
        // UNKNOWN and therefore cannot license Play.
        let outputs = redesign_state
            .machine
            .controller_outputs(&staged)
            .unwrap_or_default();
        // The undo chip label off this page's OWN stash (the shared helper
        // also sweeps an expired stash).
        let undo_label = undo_chip_label(&redesign_state.redesign_undo);
        let mut payload = crate::render_redesign::payload(crate::render_redesign::PayloadInput {
            environment: &environment,
            setup,
            setup_error: &setup_error,
            scan,
            staged: &staged,
            session: &session,
            outputs: &outputs,
            selected_slot,
            selected_source: selected_source.as_deref(),
            undo_label: undo_label.as_deref(),
            macro_selected: macro_selected.as_deref(),
            q: q.as_deref(),
        });
        // Which parked ghosts the studio still HOLDS (authoring included),
        // so a ghost card can say "bindings kept" vs "staged fresh" before
        // the press. Studio state, not a daemon read — set here like the
        // staging line, not composed in the pure payload fn.
        payload.controllers.parked_held = redesign_state
            .redesign_parked
            .lock()
            .unwrap()
            .iter()
            .map(|(id, _)| id.clone())
            .collect();
        payload
    })
    .await
    .unwrap_or_else(|_| {
        let staged = ksx_api::StagedSetupView::unreachable("the redesign collection panicked");
        let session = SessionView::unreachable("the redesign collection panicked");
        crate::render_redesign::payload(crate::render_redesign::PayloadInput {
            environment: &fallback_environment,
            setup: None,
            setup_error: N_READ_SETUP_ERROR,
            scan: Err(N_READ_SCAN_ERROR.to_owned()),
            staged: &staged,
            session: &session,
            outputs: &ksx_api::ControllerOutputsView::default(),
            selected_slot: None,
            selected_source: None,
            undo_label: None,
            macro_selected: None,
            q: None,
        })
    })
}

/// The root stamp for one already-collected payload. System is represented by
/// the absence of `data-theme`, just as it is everywhere else; an unreadable
/// setup has no chosen row and therefore also renders without a claim.
///
/// Deliberately do not read setup again here. The chosen row was composed from
/// the collector's one cached `SetupView`, making it the page's single theme
/// truth for both SSR chrome and the document root.
fn theme_from_payload(payload: &RedesignPayload) -> Option<&str> {
    payload
        .theme_rows
        .iter()
        .find(|row| row.chosen)
        .map(|row| row.name.as_str())
        .filter(|theme| *theme != "system")
}

/// `GET /redesign` — the redesign lane's canvas workbench.
pub(super) async fn redesign_page(
    State(state): State<Arc<AppState>>,
    Query(query): Query<RedesignQuery>,
) -> Response {
    invalidate_redesign_cache_for_fresh(&state, query.fresh.as_deref());
    let payload = collect_redesign(
        &state,
        query.slot,
        query.source,
        query.macro_selected,
        query.q,
    )
    .await;
    let flash = redesign_flash_from_query(query.flash.as_deref());
    let out = crate::render::with_theme(
        render_redesign(&state.redesign_page.get(), &payload, flash.as_deref()),
        theme_from_payload(&payload),
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

/// The poller's endpoint — the same [`RedesignPayload`] the /redesign page
/// embeds as island props (parity unit-tested in render_redesign.rs).
pub(super) async fn api_redesign(
    State(state): State<Arc<AppState>>,
    Query(query): Query<RedesignQuery>,
) -> Response {
    invalidate_redesign_cache_for_fresh(&state, query.fresh.as_deref());
    let payload = collect_redesign(
        &state,
        query.slot,
        query.source,
        query.macro_selected,
        query.q,
    )
    .await;
    (
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        axum::Json(payload),
    )
        .into_response()
}

// ── Operational-shell aliases ─────────────────────────────────────────────
//
// These call the route-neutral workbench core after redesign's served-revision
// and fail-closed-capture preflights. The presentations own redirects; the
// staged setup capability owns mutations and provider/refusal mapping.

#[derive(Deserialize)]
pub(super) struct RedesignRevisionForm {
    #[serde(default)]
    expected_revision: Option<String>,
}

async fn redesign_revision_matches(state: &Arc<AppState>, expected: Option<&str>) -> bool {
    let expected = expected
        .map(str::trim)
        .filter(|revision| !revision.is_empty())
        .map(str::to_owned);
    let inspect = Arc::clone(state);
    tokio::task::spawn_blocking(move || {
        let staged = inspect.control.staged();
        staged.reachable
            && !staged.revision.trim().is_empty()
            && expected.as_deref() == Some(staged.revision.trim())
    })
    .await
    .unwrap_or(false)
}

pub(super) async fn redesign_form_save(
    state: State<Arc<AppState>>,
    form: RedesignForm<RedesignRevisionForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    if !redesign_revision_matches(&state.0, form.expected_revision.as_deref()).await {
        return redesign_redirect(RD_LIFECYCLE_CHANGED);
    }
    if !redesign_capture_ready(&state.0).await {
        return redesign_redirect(N_SAVE_CAPTURE);
    }
    redesign_redirect(wb::stage_save(state.0).await)
}

pub(super) async fn redesign_form_play(
    state: State<Arc<AppState>>,
    form: RedesignForm<RedesignRevisionForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    if !redesign_revision_matches(&state.0, form.expected_revision.as_deref()).await {
        return redesign_redirect(RD_LIFECYCLE_CHANGED);
    }
    if !redesign_capture_ready(&state.0).await {
        return redesign_redirect(N_PLAY_CAPTURE);
    }
    redesign_redirect(wb::stage_play(state.0).await)
}

/// The redesign promises that unresolved exact-device state is fail-closed,
/// including a refused or incomplete live scan. Keep that promise at the
/// mutation door as well as in the served button. A no-device draft falls
/// through so the shared stage core retains its more specific domain refusal.
async fn redesign_capture_ready(state: &Arc<AppState>) -> bool {
    let inspect = Arc::clone(state);
    tokio::task::spawn_blocking(move || {
        let staged = inspect.control.staged();
        if !staged.reachable || !crate::snapshot::staged_has_routed_devices(&staged) {
            return true;
        }
        let Ok(scan) = inspect.machine.device_scan() else {
            return false;
        };
        crate::snapshot::RedesignCaptureState::of(&staged, Some(&scan), "").ready_for_commit()
    })
    .await
    .unwrap_or(false)
}

pub(super) async fn redesign_form_stop(state: State<Arc<AppState>>) -> Response {
    redesign_redirect(wb::stage_stop(state.0).await)
}

pub(super) async fn redesign_form_apply(
    state: State<Arc<AppState>>,
    form: RedesignForm<RedesignRevisionForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    if !redesign_revision_matches(&state.0, form.expected_revision.as_deref()).await {
        return redesign_redirect(RD_LIFECYCLE_CHANGED);
    }
    redesign_redirect(wb::stage_apply_flash(state.0).await)
}

pub(super) async fn redesign_api_apply(
    state: State<Arc<AppState>>,
    form: RedesignForm<RedesignRevisionForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return axum::Json(serde_json::json!({
            "done": false,
            "code": "bad-request",
            "flash": N_FORM_UNREADABLE,
        }))
        .into_response();
    };
    if !redesign_revision_matches(&state.0, form.expected_revision.as_deref()).await {
        return axum::Json(serde_json::json!({
            "done": false,
            "code": "stale-draft",
            "flash": RD_LIFECYCLE_CHANGED,
        }))
        .into_response();
    }
    wb::stage_apply_json(state.0).await
}

pub(super) async fn redesign_form_adopt(
    state: State<Arc<AppState>>,
    form: RedesignForm<wb::AdoptForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    redesign_redirect(wb::stage_adopt(state.0, form.profile).await)
}

#[derive(Deserialize)]
pub(super) struct RedesignDiscardForm {
    #[serde(default)]
    confirm_discard: Option<String>,
    /// Whole-draft concurrency token served with the confirmation. It is
    /// required only for a dirty draft; a clean Start over stays one-click.
    #[serde(default)]
    expected_revision: Option<String>,
}

pub(super) async fn redesign_form_discard(
    state: State<Arc<AppState>>,
    form: RedesignForm<RedesignDiscardForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let inspect = Arc::clone(&state.0);
    let staged = tokio::task::spawn_blocking(move || {
        let staged = inspect.control.staged();
        (
            staged.reachable && staged.dirty,
            staged.revision.trim().to_owned(),
        )
    })
    .await
    .unwrap_or((true, String::new()));
    let (dirty, current_revision) = staged;
    if dirty && !checked(form.confirm_discard.as_deref()) {
        return redesign_redirect(RD_DISCARD_CONFIRM);
    }
    if dirty
        && form
            .expected_revision
            .as_deref()
            .map(str::trim)
            .filter(|revision| !revision.is_empty())
            != Some(current_revision.as_str())
    {
        return redesign_redirect(RD_DISCARD_CHANGED);
    }
    redesign_redirect(wb::stage_discard(state.0).await)
}

pub(super) async fn redesign_form_capture_prepare(
    state: State<Arc<AppState>>,
    form: RedesignForm<wb::CapturePrepareForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let result = wb::capture_prepare(state.0, form).await;
    redesign_redirect(wb::capture_flash(wb::CaptureMutation::Prepare, result))
}

pub(super) async fn redesign_form_capture_release(
    state: State<Arc<AppState>>,
    form: RedesignForm<wb::CaptureReleaseForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let result = wb::capture_release(state.0, form).await;
    redesign_redirect(wb::capture_flash(wb::CaptureMutation::Release, result))
}

#[derive(Deserialize)]
pub(super) struct RedesignThemeForm {
    theme: Option<String>,
}

/// POST /redesign/theme — update the shared theme and return to this surface.
/// A config write like blocking, but read per page render rather
/// than by the daemon, so "saved" IS "in effect" — the router-wide layer
/// invalidates `machine_cache` around every non-GET, which is what lets the
/// redirect's own render stamp the new choice.
///
/// `system` is stored as the EMPTY id deliberately: absence means "follow the
/// operating system", so there is no third state to keep in step, and an id
/// this build does not ship is refused rather than written.
pub(super) async fn redesign_form_theme(
    State(state): State<Arc<AppState>>,
    Form(form): Form<RedesignThemeForm>,
) -> Response {
    let Some(field) = form.theme else {
        // Keep the scripted and no-JavaScript paths on the same allowlisted
        // feedback channel. A literal here would be read directly from the
        // redirect URL by fetch enhancement but replaced on a full render.
        return redesign_redirect(N_THEME_UNKNOWN);
    };
    let wanted = field.trim().to_owned();
    let stored = if wanted == "system" {
        String::new()
    } else if let Some(meta) = crate::theme_tokens::THEMES.iter().find(|t| t.id == wanted) {
        meta.id.to_owned()
    } else {
        return redesign_redirect(N_THEME_UNKNOWN);
    };
    let ok = tokio::task::spawn_blocking(move || {
        state
            .machine
            .set_theme(&ksx_api::ThemeSpec { theme: stored })
            .is_ok()
    })
    .await
    .unwrap_or(false);
    redesign_redirect(if ok { N_THEME_OK } else { N_EDIT_ERROR })
}

/// A form this page might not be able to read — the nocturne rule: axum's
/// own rejection is a 422 with no Location, which a fetch-submitting page
/// renders as nothing at all. Answer in a sentence instead.
type RedesignForm<T> = Result<Form<T>, axum::extract::rejection::FormRejection>;

#[derive(Deserialize)]
pub(super) struct RedesignDeviceForm {
    /// The `ksx_core::DeviceSelector` the bench card carried (served).
    /// **Never a path anybody typed** — the card has no text input.
    selector: String,
    alias: String,
    label: String,
}

/// POST /redesign/device — stage the input selected from the workbench card.
/// Unlike the legacy Nocturne chooser this is additive: another keyboard
/// joins the staged roster. Re-adding an existing selector updates its
/// metadata while the domain preserves its prepared capture backend.
pub(super) async fn redesign_form_device(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignDeviceForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let outcome = tokio::task::spawn_blocking(move || {
        upsert_device_preserving_preparation(&state, form.selector, form.alias, form.label)
    })
    .await
    .unwrap_or(DeviceChoice::Refused);
    redesign_redirect(match outcome {
        // Not a refusal: the user asked for a state the page is already in,
        // and it is in it (and the preparation survived — the sentence's
        // second half is the part that matters).
        DeviceChoice::Unchanged => N_DEVICE_ALREADY_OK,
        DeviceChoice::Chosen => N_DEVICE_OK,
        DeviceChoice::Refused => N_EDIT_ERROR,
    })
}

#[derive(Deserialize)]
pub(super) struct RedesignDeviceRemoveForm {
    selector: String,
    #[serde(default)]
    confirm_remove: Option<String>,
}

fn device_has_mappings(staged: &ksx_api::StagedSetupView, selector: &str) -> bool {
    staged.slots.iter().any(|slot| {
        slot.sources
            .iter()
            .find(|source| source.selector.eq_ignore_ascii_case(selector.trim()))
            .is_some_and(|source| {
                source.bindings > 0
                    || source.authoring.is_none()
                    || !ksx_api::staged_source_macro_snapshot(source)
                        .macros
                        .is_empty()
            })
    })
}

/// POST /redesign/device/remove — remove exactly one keyboard and all of its
/// source routes. A roster-only keyboard removes immediately; a keyboard with
/// authored routes needs an explicit confirmation from this exact form.
pub(super) async fn redesign_form_device_remove(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignDeviceRemoveForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let flash = tokio::task::spawn_blocking(move || {
        let staged = state.control.staged();
        let selector = form.selector.trim();
        if selector.is_empty()
            || !staged
                .devices
                .iter()
                .any(|device| device.selector.eq_ignore_ascii_case(selector))
        {
            return N_EDIT_ERROR;
        }
        if device_has_mappings(&staged, selector) && !checked(form.confirm_remove.as_deref()) {
            return RD_DEVICE_REMOVE_CONFIRM;
        }
        if state
            .control
            .stage_edit(&ksx_api::StageEdit::RemoveDevice {
                selector: selector.to_owned(),
            })
            .ok
        {
            RD_DEVICE_REMOVED
        } else {
            N_EDIT_ERROR
        }
    })
    .await
    .unwrap_or(N_EDIT_ERROR);
    redesign_redirect(flash)
}

/// POST /redesign/device/identify — the existing exact-device transaction,
/// with a redesign redirect and an exact-generation cancellation handle. A
/// successful answer additively upserts that board into the mapping-source
/// roster; there is no identify-only preview that could stage it without
/// consent.
#[derive(Deserialize)]
pub(super) struct RedesignIdentifyForm {
    #[serde(default)]
    attempt: String,
}

fn redesign_identify_attempt(attempt: String) -> Result<Option<String>, ()> {
    let attempt = attempt.trim();
    if attempt.is_empty() {
        return Ok(None);
    }
    if attempt.len() > 128
        || !attempt
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(());
    }
    Ok(Some(attempt.to_owned()))
}

pub(super) async fn redesign_form_identify(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignIdentifyForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let Ok(attempt) = redesign_identify_attempt(form.attempt) else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let attempt = attempt.unwrap_or_else(|| {
        let sequence = state
            .redesign_identify_sequence
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!("server-attempt-{sequence}")
    });
    {
        let mut registry = state.redesign_identify.lock().unwrap();
        if registry.take_pre_cancelled(&attempt) {
            return redesign_redirect(RD_IDENTIFY_CANCELLED);
        }
        if registry.lease.is_some() {
            return redesign_redirect(RD_IDENTIFY_BUSY);
        }
        registry.lease = Some(super::RedesignIdentifyLease::Pending {
            attempt: attempt.clone(),
        });
    }
    match identify_and_stage_for_redesign(state, attempt).await {
        StartIdentifyResult::Selected(selector) => {
            redesign_identify_redirect(N_IDENTIFY_OK, Some(&selector))
        }
        StartIdentifyResult::TimedOut => redesign_identify_redirect(N_IDENTIFY_TIMEOUT, None),
        StartIdentifyResult::Failed => redesign_identify_redirect(N_IDENTIFY_ERROR, None),
        StartIdentifyResult::Busy => redesign_identify_redirect(RD_IDENTIFY_BUSY, None),
        StartIdentifyResult::Cancelled => redesign_identify_redirect(RD_IDENTIFY_CANCELLED, None),
    }
}

/// Cancel only the listener generation opened by the redesign identify
/// transaction. Taking it from the registry is the outcome boundary: the
/// identify worker cannot stage after this returns the cancellation sentence.
pub(super) async fn redesign_form_identify_cancel(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignIdentifyForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(RD_IDENTIFY_ALREADY_ANSWERED);
    };
    let Ok(Some(attempt)) = redesign_identify_attempt(form.attempt) else {
        return redesign_redirect(RD_IDENTIFY_ALREADY_ANSWERED);
    };
    let generation = {
        let mut registry = state.redesign_identify.lock().unwrap();
        match registry.lease.as_ref() {
            Some(super::RedesignIdentifyLease::Pending { attempt: owner }) if owner == &attempt => {
                registry.lease = Some(super::RedesignIdentifyLease::Cancelled { attempt });
                return redesign_redirect(RD_IDENTIFY_CANCELLED);
            }
            Some(super::RedesignIdentifyLease::Active {
                attempt: owner,
                generation,
            }) if owner == &attempt => {
                let generation = *generation;
                registry.lease = None;
                Some(generation)
            }
            Some(super::RedesignIdentifyLease::Cancelled { attempt: owner })
                if owner == &attempt =>
            {
                return redesign_redirect(RD_IDENTIFY_CANCELLED);
            }
            Some(super::RedesignIdentifyLease::Resolving { attempt: owner, .. })
                if owner == &attempt =>
            {
                return redesign_redirect(RD_IDENTIFY_ALREADY_ANSWERED);
            }
            Some(_) | None => {
                // This nonce is not the active lease. It may be a stale tab,
                // or its Cancel may have overtaken Start; remembering it is
                // harmless to the current generation and makes the latter
                // ordering deterministic for every tab, not only the latest.
                registry.remember_pre_cancelled(attempt);
                return redesign_redirect(RD_IDENTIFY_CANCELLED);
            }
        }
    };
    let Some(generation) = generation else {
        return redesign_redirect(RD_IDENTIFY_ALREADY_ANSWERED);
    };
    // Taking Active above is the outcome boundary: the worker will refuse to
    // stage even if the daemon reports a simultaneous hit or the best-effort
    // pipe cancel itself fails. Only Resolving means the hit already won.
    let _ = tokio::task::spawn_blocking(move || {
        state.control.learn_cancel_generation(Some(generation))
    })
    .await;
    redesign_redirect(RD_IDENTIFY_CANCELLED)
}

// ── The controller verbs: the rack's add / reorder / remove ────────────────
// The daemon owns every consequence — slot numbering, the XInput ceiling, persona
// availability — and the picker re-reads the whole staged view afterwards, so
// the workbench can never hold a slot the daemon does not.

#[derive(Deserialize)]
pub(super) struct RedesignAddForm {
    /// A persona `name` off the served roster.
    persona: String,
    /// From the served `next_preset` — served, because it becomes a file name.
    preset: String,
    /// The served default layout, so a fresh slot binds keys and is playable
    /// without a mapper. Optional like nocturne's — an empty value adds bare.
    #[serde(default)]
    layout: Option<String>,
    /// Canonical multi-keyboard authority. Older one-device callers omit
    /// these fields and keep the legacy AddSlot path.
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    expected_revision: Option<String>,
    #[serde(default)]
    expected_source_revision: Option<String>,
}

/// POST /redesign/controller — stage the next slot, dressed in the served
/// layout. The workbench edits SOCD later, where the slot already exists.
pub(super) async fn redesign_form_ctrl_add(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignAddForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let flash = tokio::task::spawn_blocking(move || {
        let before = state.control.staged();
        let source = form
            .source
            .as_deref()
            .map(str::trim)
            .filter(|source| !source.is_empty())
            .map(str::to_owned);
        let expected_revision = form
            .expected_revision
            .as_deref()
            .map(str::trim)
            .filter(|revision| !revision.is_empty())
            .map(str::to_owned);
        let expected_source_revision = form
            .expected_source_revision
            .as_deref()
            .map(str::trim)
            .filter(|revision| !revision.is_empty())
            .map(str::to_owned);
        let exact_requested = source.is_some()
            || expected_revision.is_some()
            || expected_source_revision.is_some()
            || before.devices.len() > 1;
        if exact_requested {
            let (Some(source), Some(expected_revision), Some(expected_source_revision)) = (
                source.as_deref(),
                expected_revision.as_deref(),
                expected_source_revision.as_deref(),
            ) else {
                return N_EDIT_ERROR;
            };
            let Some(device) = before
                .devices
                .iter()
                .find(|device| device.selector.eq_ignore_ascii_case(source))
            else {
                return N_EDIT_ERROR;
            };
            if before.revision.trim() != expected_revision
                || ksx_api::staged_device_revision(device) != expected_source_revision
            {
                return N_EDIT_ERROR;
            }
            let added = state
                .control
                .stage_edit(&ksx_api::StageEdit::AddSourceSlot {
                    number: None,
                    persona: form.persona,
                    preset: form.preset,
                    layout: form.layout,
                    source: source.to_owned(),
                    expected_revision: expected_revision.to_owned(),
                    expected_source_revision: expected_source_revision.to_owned(),
                });
            return if added.ok { N_EDIT_OK } else { N_EDIT_ERROR };
        }

        // Compatibility for older zero/one-device forms. New redesign markup
        // always posts the exact-source arm above; a multi-device draft can
        // never reach this legacy first-roster-keyboard mutation.
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
            // The nocturne dressing chain, verbatim: a layout dresses the
            // slot's own player block when it has one; past the blocks it was
            // authored for, fall back to the player-1 block. A slot that
            // cannot be dressed at all is removed rather than left bare and
            // unplayable behind a success sentence.
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
        N_EDIT_OK
    })
    .await
    .unwrap_or(N_EDIT_ERROR);
    redesign_redirect(flash)
}

#[derive(Deserialize)]
pub(super) struct RedesignSlotForm {
    number: u8,
}

/// POST /redesign/controller/remove — drop one staged slot, then close the
/// gap. `RemoveSlot` alone leaves a HOLE (survivors keep their numbers and
/// `next_slot` fills it later — the nocturne rack's choice); the workbench's
/// law is the player line instead: survivors move UP in arrival order, so a
/// card's number always IS its play position. One `ReorderSlots` over the
/// surviving order renumbers 1..N — the daemon's own compaction, not ours.
/// No undo stash here (the nocturne rack's short undo window is its own
/// feature); the refreshed payload is the whole answer.
pub(super) async fn redesign_form_ctrl_remove(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignSlotForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let ok = tokio::task::spawn_blocking(move || {
        // The nocturne chip's contract on this page's own stash: the
        // resurrection material is read BEFORE the removal, server-held for
        // the short window, and never handed to the browser.
        let stash = stash_removed_slot(&state.control.staged(), form.number);
        let removed = state
            .control
            .stage_edit(&ksx_api::StageEdit::RemoveSlot {
                number: form.number,
            })
            .ok;
        if !removed {
            return false;
        }
        *state.redesign_undo.lock().unwrap() = stash;
        compact_staged_slots(&state);
        true
    })
    .await
    .unwrap_or(false);
    redesign_redirect(if ok { N_EDIT_OK } else { N_EDIT_ERROR })
}

/// Close any number gap: one `ReorderSlots` over the surviving order
/// renumbers 1..N. Best-effort past the initiating edit (a daemon too old
/// to reorder simply keeps the hole, and the flash reports the edit that
/// DID happen). The workbench's law: a card's number IS its play position.
fn compact_staged_slots(state: &AppState) {
    let survivors: Vec<u8> = state
        .control
        .staged()
        .slots
        .iter()
        .map(|slot| slot.number)
        .collect();
    let contiguous = survivors
        .iter()
        .enumerate()
        .all(|(at, number)| usize::from(*number) == at + 1);
    if survivors.is_empty() || contiguous {
        return;
    }
    let _ = state
        .control
        .stage_edit(&ksx_api::StageEdit::ReorderSlots { numbers: survivors });
}

/// How many parked controllers the store holds before the OLDEST park is
/// forgotten — enough for any real bench, small enough to stay nothing.
const REDESIGN_PARKED_CAP: usize = 32;

#[derive(Deserialize)]
pub(super) struct RedesignParkForm {
    number: u8,
    /// The browser's ghost id — the key re-slotting hands back.
    ghost: String,
}

/// POST /redesign/controller/park — "No player": take the slot OFF the
/// draft but keep its resurrection material (the full slot view, authoring
/// included) server-side under the ghost's id, then close the number gap.
/// The rack undo's pattern grown a KEYED store: several boards park at
/// once, and re-slotting restores bindings instead of staging fresh.
pub(super) async fn redesign_form_ctrl_park(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignParkForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    // The ghost id is browser-minted and becomes a server-held key: bound
    // it, so a buggy client cannot grow the store's keys without limit.
    if form.ghost.trim().is_empty() || form.ghost.len() > 64 {
        return redesign_redirect(N_EDIT_ERROR);
    }
    let ok = tokio::task::spawn_blocking(move || {
        let Some(slot) = state
            .control
            .staged()
            .slots
            .iter()
            .find(|slot| slot.number == form.number)
            .cloned()
        else {
            return false;
        };
        if !state
            .control
            .stage_edit(&ksx_api::StageEdit::RemoveSlot {
                number: form.number,
            })
            .ok
        {
            return false;
        }
        compact_staged_slots(&state);
        let mut parked = state.redesign_parked.lock().unwrap();
        parked.retain(|(id, _)| *id != form.ghost);
        if parked.len() >= REDESIGN_PARKED_CAP {
            parked.remove(0);
        }
        parked.push((form.ghost, slot));
        true
    })
    .await
    .unwrap_or(false);
    redesign_redirect(if ok { N_EDIT_OK } else { N_EDIT_ERROR })
}

#[derive(Deserialize)]
pub(super) struct RedesignAssignForm {
    ghost: String,
    position: u8,
    /// The fallback facts for a ghost the store no longer holds (a daemon
    /// restart forgets parks): stage it fresh instead, exactly like the
    /// picker's add. The card said which outcome the press buys BEFORE the
    /// press (`parked_held`).
    persona: String,
    preset: String,
    #[serde(default)]
    layout: Option<String>,
}

/// POST /redesign/controller/assign — re-slot a parked ghost at `position`
/// in ONE server transaction: restore (the undo verb's add → bindings →
/// socd chain, rollback on a failed bind) or fresh-stage when the store
/// lost it, then seat with one whole-order reorder. Restoring renames ONLY
/// when the old name is now worn by another slot — the duplicate verb's
/// aliasing rule: a save writes one preset file per name — and the
/// authoring's own name field moves with it.
pub(super) async fn redesign_form_ctrl_assign(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignAssignForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let flash = tokio::task::spawn_blocking(move || {
        let held = {
            let parked = state.redesign_parked.lock().unwrap();
            parked
                .iter()
                .find(|(id, _)| *id == form.ghost)
                .map(|(_, slot)| slot.clone())
        };
        let staged = state.control.staged();
        let number = match held {
            Some(slot) => {
                let name_taken = staged.slots.iter().any(|candidate| {
                    std::iter::once(candidate.preset.as_str())
                        .chain(
                            candidate
                                .sources
                                .iter()
                                .map(|source| source.preset.as_str()),
                        )
                        .any(|name| name.eq_ignore_ascii_case(&slot.preset))
                });
                let name = if name_taken {
                    match staged.next_preset.clone() {
                        Some(fresh) => fresh,
                        None => return N_EDIT_ERROR,
                    }
                } else {
                    slot.preset.clone()
                };
                let added = state.control.stage_edit(&ksx_api::StageEdit::AddSlot {
                    number: None,
                    persona: slot.persona.clone(),
                    preset: name.clone(),
                    layout: None,
                });
                if !added.ok {
                    return N_EDIT_ERROR;
                }
                let Some(number) = added.setup.slots.iter().map(|s| s.number).max() else {
                    return N_EDIT_ERROR;
                };
                let primary_override = name_taken.then_some(name.as_str());
                if !restore_slot_routes(&state, number, &slot, primary_override, false) {
                    let _ = state
                        .control
                        .stage_edit(&ksx_api::StageEdit::RemoveSlot { number });
                    return N_EDIT_ERROR;
                }
                if !slot.socd.is_empty() && slot.socd != "off" {
                    let _ = state.control.stage_edit(&ksx_api::StageEdit::SetSocd {
                        number,
                        socd: slot.socd.clone(),
                    });
                }
                number
            }
            None => {
                let added = state.control.stage_edit(&ksx_api::StageEdit::AddSlot {
                    number: None,
                    persona: form.persona,
                    preset: form.preset,
                    layout: None,
                });
                if !added.ok {
                    return N_EDIT_ERROR;
                }
                let Some(number) = added.setup.slots.iter().map(|s| s.number).max() else {
                    return N_EDIT_ERROR;
                };
                if let Some(layout) = form.layout.filter(|l| !l.trim().is_empty()) {
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
                number
            }
        };
        // Seat it: the whole order with the fresh number at `position`.
        let mut order: Vec<u8> = state
            .control
            .staged()
            .slots
            .iter()
            .map(|slot| slot.number)
            .filter(|n| *n != number)
            .collect();
        let at = usize::from(form.position.max(1) - 1).min(order.len());
        order.insert(at, number);
        let seated = order
            .iter()
            .enumerate()
            .all(|(idx, n)| usize::from(*n) == idx + 1);
        if !seated {
            let _ = state
                .control
                .stage_edit(&ksx_api::StageEdit::ReorderSlots { numbers: order });
        }
        state
            .redesign_parked
            .lock()
            .unwrap()
            .retain(|(id, _)| *id != form.ghost);
        N_EDIT_OK
    })
    .await
    .unwrap_or(N_EDIT_ERROR);
    redesign_redirect(flash)
}

#[derive(Deserialize)]
pub(super) struct RedesignMoveForm {
    /// The whole slot order, space-joined — precomposed server-side onto the
    /// card (`RedesignControllerCard::up_order`/`down_order`), one reorder
    /// per click; the renumbering is the daemon's. Empty means the card is
    /// already at that end: not an error and not a write.
    order: String,
}

/// POST /redesign/controller/move — move a staged controller.
pub(super) async fn redesign_form_ctrl_move(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignMoveForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let numbers: Vec<u8> = form
        .order
        .split_whitespace()
        .filter_map(|n| n.parse().ok())
        .collect();
    if numbers.is_empty() {
        return redesign_redirect(N_MOVE_AT_END);
    }
    let ok = tokio::task::spawn_blocking(move || {
        state
            .control
            .stage_edit(&ksx_api::StageEdit::ReorderSlots { numbers })
            .ok
    })
    .await
    .unwrap_or(false);
    redesign_redirect(if ok { N_EDIT_OK } else { N_EDIT_ERROR })
}

// ── The inspector's controller verbs ──────────────────────────────────────
// The shared core does the work and answers the same sentence; only the 303
// target belongs to this page.

#[derive(Deserialize)]
pub(super) struct RedesignSocdForm {
    number: u8,
    socd: String,
}

/// POST /redesign/controller/socd — the selected slot's opposite-directions
/// rule, using a name from the served roster.
pub(super) async fn redesign_form_ctrl_socd(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignSocdForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let ok = tokio::task::spawn_blocking(move || {
        state
            .control
            .stage_edit(&ksx_api::StageEdit::SetSocd {
                number: form.number,
                socd: form.socd,
            })
            .ok
    })
    .await
    .unwrap_or(false);
    redesign_redirect(if ok { N_EDIT_OK } else { N_EDIT_ERROR })
}

/// POST /redesign/controller/duplicate — the same controller again, next
/// free slot, bindings and rule copied (the shared composition).
pub(super) async fn redesign_form_ctrl_duplicate(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignSlotForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let flash = tokio::task::spawn_blocking(move || duplicate_slot_flash(&state, form.number))
        .await
        .unwrap_or(N_EDIT_ERROR);
    redesign_redirect(flash)
}

/// POST /redesign/controller/undo — put the last ✕-removed controller back
/// from THIS page's server-held stash. After the workbench's compaction its
/// old number is usually re-occupied, so the shared core seats it at the
/// next free slot — the arrival law's own answer.
pub(super) async fn redesign_form_ctrl_undo(State(state): State<Arc<AppState>>) -> Response {
    let flash =
        tokio::task::spawn_blocking(move || undo_removal_flash(&state, &state.redesign_undo))
            .await
            .unwrap_or(N_EDIT_ERROR);
    redesign_redirect(flash)
}

#[derive(Deserialize)]
pub(super) struct RedesignBindForm {
    slot: u8,
    #[serde(default)]
    source: String,
    #[serde(default)]
    expected_target_revision: String,
    function: String,
}

/// POST /redesign/bind/clear — one control back to unbound.
pub(super) async fn redesign_form_bind_clear(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignBindForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let flash = tokio::task::spawn_blocking(move || {
        bind_clear_source_flash(
            &state,
            form.slot,
            &form.source,
            &form.expected_target_revision,
            form.function,
        )
    })
    .await
    .unwrap_or(N_EDIT_ERROR);
    redesign_redirect(flash)
}

#[derive(Deserialize)]
pub(super) struct RedesignSourceSlotForm {
    number: u8,
    #[serde(default)]
    source: String,
    #[serde(default)]
    expected_target_revision: String,
}

/// POST /redesign/bind/clear-all — every key unbound on one slot's draft.
pub(super) async fn redesign_form_clear_all(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignSourceSlotForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let flash = tokio::task::spawn_blocking(move || {
        clear_all_source_flash(
            &state,
            form.number,
            &form.source,
            &form.expected_target_revision,
        )
    })
    .await
    .unwrap_or(N_EDIT_ERROR);
    redesign_redirect(flash)
}

#[derive(Deserialize)]
pub(super) struct RedesignBlockingForm {
    blocking: String,
}

/// POST /redesign/blocking — how the staged input's keys behave while Play
/// runs (freeze / split / take nothing), through the shared core. One
/// staged edit in the daemon; nothing saved or started.
pub(super) async fn redesign_form_blocking(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignBlockingForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    redesign_redirect(blocking_write_flash(&state, form.blocking).await)
}

// NO /redesign/board verb, deliberately (Victor, 2026-08-29): the plate
// always draws the standard keyboard on this page — a keyboard looks like a
// keyboard. Alternate pictures (saved panels, drawn boards) stay a 4460
// affair until an "advanced" home earns its place here.

#[derive(Deserialize)]
pub(super) struct RedesignMacroForm {
    slot: u8,
    #[serde(default)]
    source: String,
    #[serde(default)]
    expected_target_revision: String,
    name: String,
    #[serde(default)]
    enable: Option<String>,
}

/// POST /redesign/macro/toggle — disable (or re-enable) one macro on the
/// staged slot, through the shared macro-write core.
pub(super) async fn redesign_form_macro_toggle(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignMacroForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let enable = checked(form.enable.as_deref());
    redesign_redirect(
        macro_write_source_flash(
            state,
            form.slot,
            form.source,
            form.expected_target_revision,
            crate::control::MacroWrite {
                name: form.name,
                enabled: Some(enable),
                ..crate::control::MacroWrite::default()
            },
            N_MACRO_OK,
        )
        .await,
    )
}

/// POST /redesign/macro/new — author one empty-stepped table in THIS draft
/// (validation, taken-check and the smallest acceptable table all in the
/// shared core), so the editor can open on it.
pub(super) async fn redesign_form_macro_new(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignMacroForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    redesign_redirect(
        macro_new_source_flash(
            state,
            form.slot,
            form.source,
            form.expected_target_revision,
            &form.name,
        )
        .await,
    )
}

/// POST /redesign/macro/delete — remove one macro table (and the trigger
/// rows that would otherwise dangle) from THIS draft.
pub(super) async fn redesign_form_macro_delete(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignMacroForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    redesign_redirect(
        macro_write_source_flash(
            state,
            form.slot,
            form.source,
            form.expected_target_revision,
            crate::control::MacroWrite {
                name: form.name,
                delete: true,
                ..crate::control::MacroWrite::default()
            },
            N_MACRO_DELETED,
        )
        .await,
    )
}

#[derive(Deserialize)]
pub(super) struct RedesignKeyClearForm {
    number: u8,
    #[serde(default)]
    source: String,
    #[serde(default)]
    expected_target_revision: String,
    key: String,
}

/// POST /redesign/key/clear — take one key away from EVERYTHING it drives
/// on one slot's draft (the Keys tab's row ✕).
pub(super) async fn redesign_form_key_clear(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignKeyClearForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let flash = tokio::task::spawn_blocking(move || {
        key_clear_source_flash(
            &state,
            form.number,
            &form.source,
            &form.expected_target_revision,
            form.key,
        )
    })
    .await
    .unwrap_or(N_EDIT_ERROR);
    redesign_redirect(flash)
}

#[derive(Deserialize)]
pub(super) struct RedesignTurboForm {
    slot: u8,
    #[serde(default)]
    source: String,
    #[serde(default)]
    expected_target_revision: String,
    function: String,
    #[serde(default)]
    turbo_hz: Option<String>,
}

/// POST /redesign/bind/turbo — a control's auto-fire rate (0 clears).
pub(super) async fn redesign_form_bind_turbo(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignTurboForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let flash = tokio::task::spawn_blocking(move || {
        bind_turbo_source_flash(
            &state,
            form.slot,
            &form.source,
            &form.expected_target_revision,
            form.function,
            form.turbo_hz.as_deref(),
        )
    })
    .await
    .unwrap_or(N_EDIT_ERROR);
    redesign_redirect(flash)
}

#[derive(Deserialize)]
pub(super) struct RedesignToggleForm {
    slot: u8,
    #[serde(default)]
    source: String,
    #[serde(default)]
    expected_target_revision: String,
    function: String,
    mode: String,
}

/// POST /redesign/bind/toggle — the Hold|Toggle pill pair's write.
pub(super) async fn redesign_form_bind_toggle(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignToggleForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let flash = tokio::task::spawn_blocking(move || {
        bind_toggle_source_flash(
            &state,
            form.slot,
            &form.source,
            &form.expected_target_revision,
            form.function,
            &form.mode,
        )
    })
    .await
    .unwrap_or(N_EDIT_ERROR);
    redesign_redirect(flash)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every sentence a handler in THIS module can answer must resolve to
    /// itself through the allowlist — a missing entry silently renders as
    /// the unknown-flash sentence on the no-JS path, which is exactly the
    /// drift this pairing exists to catch. Adding a verb sentence means
    /// adding it in BOTH arrays, and the reviewer sees the pairing.
    #[test]
    fn every_verb_sentence_survives_the_allowlist() {
        for sentence in [
            // theme + device (the first transplants)
            N_THEME_OK,
            N_THEME_UNKNOWN,
            N_DEVICE_OK,
            N_DEVICE_ALREADY_OK,
            RD_DEVICE_REMOVED,
            RD_DEVICE_REMOVE_CONFIRM,
            // the staging verbs' shared answers
            N_FORM_UNREADABLE,
            N_EDIT_OK,
            N_EDIT_ERROR,
            N_MOVE_AT_END,
            N_ADD_LAYOUT_ERROR,
            // the inspector's controller verbs
            N_CLEAR_ALL_OK,
            N_UNDO_OK,
            N_UNDO_GONE,
            N_UNDO_FULL,
            N_DUP_OK,
            N_DUP_FULL,
            N_TURBO_OK,
            N_TURBO_INPUT_ERROR,
            N_TURBO_UNBOUND_ERROR,
            N_TOGGLE_OK,
            N_TOGGLE_OLD_DAEMON,
            N_TOGGLE_UNBOUND_ERROR,
            // the Keys tab's row ✕
            N_KEY_CLEAR_OK,
            N_KEY_CLEAR_NONE,
            // the keyboard widget: the While-playing picker
            N_BLOCKING_OK,
            // the inspector macro section
            N_MACRO_OK,
            N_MACRO_NEW,
            N_MACRO_NAME,
            N_MACRO_TAKEN,
            N_MACRO_BADNAME,
            N_MACRO_DELETED,
            // the operational shell and exact-device recovery aliases
            N_SAVE_OK,
            N_SAVE_ERROR,
            N_SAVE_BLOCKING,
            N_SAVE_NO_BINDINGS,
            N_SAVE_NO_DEVICE,
            N_SAVE_NO_SLOTS,
            N_SAVE_CAPTURE,
            N_PLAY_OK,
            N_PLAY_ERROR,
            N_PLAY_BLOCKING,
            N_PLAY_NO_BINDINGS,
            N_PLAY_NO_DEVICE,
            N_PLAY_NO_SLOTS,
            N_PLAY_CAPTURE,
            N_PLAY_OUTPUT_BLOCKED,
            N_PLAY_OUTPUT_UNKNOWN,
            N_STOP_OK,
            N_STOP_ERROR,
            N_APPLY_OK,
            N_APPLY_RESTART,
            N_APPLY_ERROR,
            N_ADOPT_OK,
            N_ADOPT_BLOCKED,
            N_DISCARD_OK,
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
            RD_DISCARD_CONFIRM,
            RD_DISCARD_CHANGED,
            RD_LIFECYCLE_CHANGED,
        ] {
            assert_eq!(
                redesign_flash_from_query(Some(sentence)).as_deref(),
                Some(sentence),
                "a verb can answer this sentence but the allowlist would \
                 render it as the unknown-flash text"
            );
        }
    }

    fn theme_row(name: &str, chosen: bool) -> crate::snapshot::NocturneChoiceRow {
        crate::snapshot::NocturneChoiceRow {
            name: name.to_owned(),
            chosen,
            ..Default::default()
        }
    }

    #[test]
    fn root_theme_comes_from_the_payloads_chosen_row() {
        let mut payload = RedesignPayload {
            theme_rows: vec![theme_row("system", true), theme_row("matrix", false)],
            ..Default::default()
        };
        assert_eq!(
            theme_from_payload(&payload),
            None,
            "System has no root stamp"
        );

        payload.theme_rows[0].chosen = false;
        payload.theme_rows[1].chosen = true;
        assert_eq!(theme_from_payload(&payload), Some("matrix"));

        for row in &mut payload.theme_rows {
            row.chosen = false;
        }
        assert_eq!(
            theme_from_payload(&payload),
            None,
            "an unreadable setup makes no root-theme claim"
        );
    }

    #[test]
    fn only_the_explicit_rescan_token_busts_machine_reads() {
        assert!(redesign_fresh_requested(Some("1")));
        assert!(redesign_fresh_requested(Some(" 1 ")));
        for value in [None, Some(""), Some("0"), Some("true"), Some("01")] {
            assert!(!redesign_fresh_requested(value), "{value:?}");
        }
    }

    fn native_request(
        method: axum::http::Method,
        host: &str,
        referer: &str,
    ) -> axum::extract::Request {
        axum::extract::Request::builder()
            .method(method)
            .uri("/redesign/stop")
            .header(header::HOST, host)
            .header(header::REFERER, referer)
            .body(axum::body::Body::empty())
            .unwrap()
    }

    #[test]
    fn native_return_context_is_same_origin_allowlisted_and_reencoded() {
        let request = native_request(
            axum::http::Method::POST,
            "127.0.0.1:4460",
            "http://127.0.0.1:4460/redesign?slot=2&source=usb%3A1111%3A2222%3A00&macro=dash+loop&q=face%20buttons\
             &flash=hostile&fresh=1&identified_selector=private",
        );
        assert_eq!(
            redesign_return_context(&request).as_deref(),
            Some("slot=2&source=usb%3A1111%3A2222%3A00&macro=dash%20loop&q=face%20buttons"),
            "only durable navigation state crosses the native POST"
        );

        let encoded_attack = native_request(
            axum::http::Method::POST,
            "127.0.0.1:4460",
            "http://127.0.0.1:4460/redesign?slot=99&macro=%0D%0ALocation%3A%20https%3A%2F%2Fevil.example&q=%20",
        );
        assert_eq!(
            redesign_return_context(&encoded_attack).as_deref(),
            Some("macro=%0D%0ALocation%3A%20https%3A%2F%2Fevil.example"),
            "an invalid slot and blank search are dropped, while a macro name is encoded data"
        );
    }

    #[test]
    fn native_return_context_rejects_every_non_workbench_referrer() {
        for (method, host, referer) in [
            (
                axum::http::Method::GET,
                "127.0.0.1:4460",
                "http://127.0.0.1:4460/redesign?slot=2",
            ),
            (
                axum::http::Method::POST,
                "127.0.0.1:4460",
                "http://evil.example/redesign?slot=2",
            ),
            (
                axum::http::Method::POST,
                "127.0.0.1:4460",
                "https://127.0.0.1:4460/redesign?slot=2",
            ),
            (
                axum::http::Method::POST,
                "127.0.0.1:4460",
                "http://127.0.0.1:4460/devices?slot=2",
            ),
        ] {
            assert_eq!(
                redesign_return_context(&native_request(method, host, referer)),
                None,
                "must reject {referer}"
            );
        }
    }

    #[test]
    fn device_removal_confirmation_is_exact_and_only_for_authored_routes() {
        let selector = "usb:1111:2222:00";
        let other = "usb:3333:4444:00";
        let mut staged = ksx_api::StagedSetupView {
            reachable: true,
            devices: vec![ksx_api::StagedDeviceView {
                selector: selector.to_owned(),
                ..ksx_api::StagedDeviceView::default()
            }],
            slots: vec![ksx_api::StagedSlotView {
                number: 1,
                sources: vec![ksx_api::StagedSourceView {
                    selector: selector.to_owned(),
                    preset: "Player 1".to_owned(),
                    authoring: Some(ksx_config::PresetFile {
                        name: "Player 1".to_owned(),
                        bindings: Default::default(),
                        macros: Default::default(),
                    }),
                    routed: true,
                    ..ksx_api::StagedSourceView::default()
                }],
                ..ksx_api::StagedSlotView::default()
            }],
            ..ksx_api::StagedSetupView::default()
        };
        assert!(!device_has_mappings(&staged, selector));
        assert!(!device_has_mappings(&staged, other));

        staged.slots[0].sources[0].bindings = 1;
        assert!(device_has_mappings(&staged, selector));
        assert!(!device_has_mappings(&staged, other));

        staged.slots[0].sources[0].bindings = 0;
        staged.slots[0].sources[0]
            .authoring
            .as_mut()
            .unwrap()
            .macros
            .insert("kept-body".to_owned(), ksx_config::MacroFile::default());
        assert!(device_has_mappings(&staged, selector));
    }
}
