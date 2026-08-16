//! `/workspace` — the Nocturne workspace shell (M0 skeleton).
//!
//! Read-only in M0: the page and its poll payload, one collector shared by
//! both so the SSR paint and `/api/workspace` are the same bytes. The editing
//! verbs (device, rack, bindings, session) arrive with M2–M4 as form twins
//! beside `/api/*` routes, exactly as `/map` and `/start` are shaped today.

use super::*;

/// One fresh [`WorkspacePayload`]: the daemon-held draft and the session, on
/// a blocking worker like every other collector read, derived on the way out
/// so no caller can serve sentences that contradict the facts beside them.
pub(super) async fn collect_workspace(state: &Arc<AppState>) -> WorkspacePayload {
    let ws_state = Arc::clone(state);
    tokio::task::spawn_blocking(move || {
        WorkspacePayload {
            staged: ws_state.control.staged(),
            session: ws_state.control.session(),
            view: Default::default(),
        }
        .derived()
    })
    .await
    .unwrap_or_else(|_| {
        WorkspacePayload {
            staged: ksx_api::StagedSetupView::unreachable("reading the draft panicked"),
            session: SessionView::unreachable("reading the draft panicked"),
            view: Default::default(),
        }
        .derived()
    })
}

/// `GET /workspace` — the three-pane shell, server-rendered.
pub(super) async fn workspace_page(State(state): State<Arc<AppState>>) -> Response {
    let payload = collect_workspace(&state).await;
    let out = render_workspace(&state.workspace_page, &payload);
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
/// as island props (parity unit-tested in render_workspace.rs).
pub(super) async fn api_workspace(State(state): State<Arc<AppState>>) -> Response {
    let payload = collect_workspace(&state).await;
    (
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        axum::Json(payload),
    )
        .into_response()
}
