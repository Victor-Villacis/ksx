//! `/redesign` — the transplant rebuild's blank workbench. Read-only.
//!
//! The same shape as every page module here: one collector on a blocking
//! worker, one GET that renders it themed, one JSON twin the island polls.

use super::*;

/// One fresh [`RedesignPayload`]: the machine provenance, on a blocking
/// worker like every other collector read.
pub(super) async fn collect_redesign(state: &Arc<AppState>) -> RedesignPayload {
    let redesign_state = Arc::clone(state);
    tokio::task::spawn_blocking(move || {
        crate::render_redesign::payload(&redesign_state.source.environment())
    })
    .await
    .unwrap_or_default()
}

/// `GET /redesign` — the redesign lane's canvas workbench.
pub(super) async fn redesign_page(State(state): State<Arc<AppState>>) -> Response {
    let payload = collect_redesign(&state).await;
    let theme = page_theme(&state).await;
    let out = crate::render::with_theme(
        render_redesign(&state.redesign_page.get(), &payload),
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

/// The poller's endpoint — the same [`RedesignPayload`] the /redesign page
/// embeds as island props (parity unit-tested in render_redesign.rs).
pub(super) async fn api_redesign(State(state): State<Arc<AppState>>) -> Response {
    let payload = collect_redesign(&state).await;
    (
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        axum::Json(payload),
    )
        .into_response()
}
