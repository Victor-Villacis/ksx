//! `/check` — press a button, watch it land. Read-only, plus the live feed.
//!
//! Split out of the 4,241-line `server.rs`. Every item here moved
//! verbatim: the router, the routes and the behaviour are unchanged.

use super::*;

/// One fresh [`CheckPayload`]: the slot roster and the session, on a blocking
/// worker like every other collector read.
///
/// Deliberately the SAME `StatusSource::mapper()` the mapper page calls. The
/// button check's control roster is a preset's binding table — there is no
/// second read of it and no second shape for it, so a preset edit made on
/// /map is on /check at the next roster poll with nothing to keep in step.
pub(super) async fn collect_check(state: &Arc<AppState>) -> CheckPayload {
    let check_state = Arc::clone(state);
    tokio::task::spawn_blocking(move || {
        crate::render_check::payload(check_state.source.mapper(), check_state.control.session())
    })
    .await
    .unwrap_or_else(|_| {
        crate::render_check::payload(
            ksx_api::MapperSnapshot::unavailable("reading the slots panicked"),
            SessionView::unreachable("reading the slots panicked"),
        )
    })
}

/// `GET /check` — BUILD C, the button check (docs/MAPPER-UX.md).
///
/// The document is the binding table, read from disk; the lighting-up is
/// `/api/live` beside it. Both halves are needed and only one of them is here
/// — see `crate::render_check` for why that split IS the page.
pub(super) async fn check_page(State(state): State<Arc<AppState>>) -> Response {
    let payload = collect_check(&state).await;
    let out = render_check(&state.check_page, &payload);
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

/// The roster poller's endpoint — the same [`CheckPayload`] the /check page
/// embeds as island props (parity unit-tested in render_check.rs).
///
/// Polled every few SECONDS, not at display rate: this is the structure, and
/// the structure only changes when somebody edits a preset.
pub(super) async fn api_check(State(state): State<Arc<AppState>>) -> Response {
    let payload = collect_check(&state).await;
    (
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        axum::Json(payload),
    )
        .into_response()
}

/// `GET /api/live` — the daemon's input fan-out, as Server-Sent Events.
///
/// The one endpoint on this server that is a SUBSCRIPTION rather than an
/// answer. It never touches the other three providers: it hands the request's
/// own bridge thread a handle to [`AppState::live`] and gets out of the way.
/// `crate::live` holds the design — why SSE, why the channel is one slot deep
/// and blocking, and why "no daemon" is a 200 with a refusal event rather than
/// a status code.
pub(super) async fn api_live(State(state): State<Arc<AppState>>) -> Response {
    crate::live::stream(Arc::clone(&state.live))
}
