//! `/workspace` — the Nocturne workspace (M2: the left pane's verbs).
//!
//! One collector shared by the page and `/api/workspace`, so the SSR paint
//! and the poll are the same bytes — plus the left pane's form twins, each a
//! thin wrapper over ONE `ControlSource` staging method (= one pipe verb; no
//! GUI-only code paths), each answering 303 → `/workspace?flash=` with a
//! sentence from this module's own allowlist. The center and right panes'
//! verbs arrive with M3–M4.

use super::*;

// ── The flash allowlist — /start's discipline, this page's copy ─────────────
//
// A query string is user-controlled even when our own POST produced it; only
// copy this module can emit is reflected back onto the page.

pub(super) const WS_EDIT_OK: &str = "Draft updated. Nothing has been saved or started.";

pub(super) const WS_EDIT_ERROR: &str =
    "error: The draft could not be updated. Reopen ksx and try again; nothing was changed.";

pub(super) const WS_MOVE_AT_END: &str =
    "That controller is already at that end of the order. Nothing changed.";

pub(super) const WS_ADOPT_OK: &str =
    "Showing the saved setup. Edits stay on this screen until Save or Play.";

pub(super) const WS_ADOPT_BLOCKED: &str =
    "error: There is already a draft on this screen, so the saved setup was not loaded over it.";

pub(super) const WS_UNKNOWN_FLASH_ERROR: &str =
    "error: The workspace could not finish that request. Reopen ksx and try again.";

pub(super) const WS_IDENTIFY_OK: &str =
    "Keyboard identified and selected. Nothing has been captured, saved, or started.";

pub(super) const WS_IDENTIFY_TIMEOUT: &str =
    "error: No keyboard answered in time. Nothing changed; try Identify again and press one key.";

pub(super) const WS_IDENTIFY_ERROR: &str = "error: That key press could not be matched to one \
     selectable keyboard. Nothing changed; try again.";

pub(super) const WS_FLASH_ALLOWLIST: [&str; 9] = [
    WS_EDIT_OK,
    WS_EDIT_ERROR,
    WS_MOVE_AT_END,
    WS_ADOPT_OK,
    WS_ADOPT_BLOCKED,
    WS_IDENTIFY_OK,
    WS_IDENTIFY_TIMEOUT,
    WS_IDENTIFY_ERROR,
    WS_UNKNOWN_FLASH_ERROR,
];

pub(super) fn workspace_flash_from_query(flash: Option<&str>) -> Option<String> {
    let flash = flash?.trim();
    if flash.is_empty() {
        return None;
    }
    Some(
        WS_FLASH_ALLOWLIST
            .into_iter()
            .find(|safe| *safe == flash)
            .unwrap_or(WS_UNKNOWN_FLASH_ERROR)
            .to_owned(),
    )
}

fn workspace_redirect(flash: &str) -> Response {
    Redirect::to(&format!("/workspace?flash={}", urlencode(flash))).into_response()
}

/// Run one staging edit off the async workers (the pipe client blocks) and
/// 303 back to the workspace. Every one of these touches ONE value in the
/// daemon and nothing else — no file, no driver, no session
/// (`FIRST-RUN.md` §2) — which is why there is no confirm step: there is
/// nothing to undo, because there is nothing to have done.
async fn workspace_stage_edit(state: Arc<AppState>, edit: ksx_api::StageEdit) -> Response {
    let ok = tokio::task::spawn_blocking(move || state.control.stage_edit(&edit).ok)
        .await
        .unwrap_or(false);
    workspace_redirect(if ok { WS_EDIT_OK } else { WS_EDIT_ERROR })
}

#[derive(Deserialize)]
pub(super) struct WorkspaceBlockingForm {
    blocking: String,
}

/// POST /workspace/blocking — the capture answer, changed as often as wanted.
pub(super) async fn workspace_form_blocking(
    State(state): State<Arc<AppState>>,
    Form(form): Form<WorkspaceBlockingForm>,
) -> Response {
    workspace_stage_edit(
        state,
        ksx_api::StageEdit::SetBlocking {
            blocking: form.blocking,
        },
    )
    .await
}

#[derive(Deserialize)]
pub(super) struct WorkspaceMoveForm {
    /// Kept for the honest already-there sentence; the ORDER is what moves.
    #[allow(dead_code)]
    number: u8,
    /// The whole new order, space-separated — PRECOMPOSED by the server into
    /// the row's hidden field (snapshot.rs `WorkspaceSlotRow`), so the page
    /// never derives slot order. Empty means the row was already at that end.
    order: String,
}

/// POST /workspace/controller/move — one whole-order reorder per click.
pub(super) async fn workspace_form_move(
    State(state): State<Arc<AppState>>,
    Form(form): Form<WorkspaceMoveForm>,
) -> Response {
    let numbers: Vec<u8> = form
        .order
        .split_whitespace()
        .filter_map(|n| n.parse().ok())
        .collect();
    if numbers.is_empty() {
        // The first row's "Move up": not an error, and not a write either.
        return workspace_redirect(WS_MOVE_AT_END);
    }
    workspace_stage_edit(state, ksx_api::StageEdit::ReorderSlots { numbers }).await
}

#[derive(Deserialize)]
pub(super) struct WorkspaceSocdForm {
    number: u8,
    socd: String,
}

/// POST /workspace/controller/socd — the shared opposite-directions form.
pub(super) async fn workspace_form_socd(
    State(state): State<Arc<AppState>>,
    Form(form): Form<WorkspaceSocdForm>,
) -> Response {
    workspace_stage_edit(
        state,
        ksx_api::StageEdit::SetSocd {
            number: form.number,
            socd: form.socd,
        },
    )
    .await
}

/// POST /workspace/device/identify — the shared identify transaction
/// (`server/start.rs::identify_and_stage`), flashed in this page's words.
pub(super) async fn workspace_form_identify(State(state): State<Arc<AppState>>) -> Response {
    let flash = match identify_and_stage(state).await {
        StartIdentifyResult::Selected => WS_IDENTIFY_OK,
        StartIdentifyResult::TimedOut => WS_IDENTIFY_TIMEOUT,
        StartIdentifyResult::Failed => WS_IDENTIFY_ERROR,
    };
    workspace_redirect(flash)
}

/// POST /workspace/adopt — the saved configuration into an EMPTY stage. The
/// daemon refuses over a proposal (adoption never overwrites edits), and that
/// refusal gets its own sentence because its remedy is different.
pub(super) async fn workspace_form_adopt(State(state): State<Arc<AppState>>) -> Response {
    let outcome = tokio::task::spawn_blocking(move || state.control.stage_adopt(None))
        .await
        .ok();
    let flash = match outcome {
        Some(outcome) if outcome.ok => WS_ADOPT_OK,
        Some(outcome) if outcome.code.as_deref() == Some("stage-not-empty") => WS_ADOPT_BLOCKED,
        _ => WS_EDIT_ERROR,
    };
    workspace_redirect(flash)
}

/// The workspace page's query: the action flash, and WHICH controller the
/// page is looking at — selection is a server-resolved link, so it works
/// with no JavaScript and survives a reload.
#[derive(Deserialize)]
pub(super) struct WorkspaceQuery {
    pub(super) flash: Option<String>,
    pub(super) slot: Option<u8>,
}

/// One fresh [`WorkspacePayload`]: the daemon-held draft and the session, on
/// a blocking worker like every other collector read, derived on the way out
/// so no caller can serve sentences that contradict the facts beside them.
pub(super) async fn collect_workspace(state: &Arc<AppState>, slot: Option<u8>) -> WorkspacePayload {
    let ws_state = Arc::clone(state);
    tokio::task::spawn_blocking(move || {
        WorkspacePayload {
            staged: ws_state.control.staged(),
            session: ws_state.control.session(),
            selected: slot,
            view: Default::default(),
        }
        .derived()
    })
    .await
    .unwrap_or_else(|_| {
        WorkspacePayload {
            staged: ksx_api::StagedSetupView::unreachable("reading the draft panicked"),
            session: SessionView::unreachable("reading the draft panicked"),
            selected: slot,
            view: Default::default(),
        }
        .derived()
    })
}

/// `GET /workspace` — the three-pane shell, server-rendered.
pub(super) async fn workspace_page(
    State(state): State<Arc<AppState>>,
    Query(query): Query<WorkspaceQuery>,
) -> Response {
    let payload = collect_workspace(&state, query.slot).await;
    let flash = workspace_flash_from_query(query.flash.as_deref());
    let out = render_workspace(&state.workspace_page, &payload, flash.as_deref());
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

/// The 2 s poller's endpoint — the same [`WorkspacePayload`] the page embeds
/// as island props (parity unit-tested in render_workspace.rs). The client
/// echoes the page's own query string, so the poll looks at the same slot
/// the paint did.
pub(super) async fn api_workspace(
    State(state): State<Arc<AppState>>,
    Query(query): Query<WorkspaceQuery>,
) -> Response {
    let payload = collect_workspace(&state, query.slot).await;
    (
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        axum::Json(payload),
    )
        .into_response()
}
