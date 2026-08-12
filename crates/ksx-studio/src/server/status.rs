//! `/` — the status page: what the daemon and the machine are doing right now.
//!
//! Split out of the 4,241-line `server.rs`. Every item here moved
//! verbatim: the router, the routes and the behaviour are unchanged.

use super::*;

#[derive(Deserialize)]
pub(super) struct PageQuery {
    pub(super) flash: Option<String>,
}

// DELETED at forma-server 0.2.0: `relax_style_src`.
//
// Dogfood ledger #13 — a nonce in `style-src` makes browsers drop
// `'unsafe-inline'` semantics per spec, so every inline `style=""` ATTRIBUTE
// was ignored; forma's own compiled bindings emit those (the mapper's zone
// geometry, the countdown bar's width), and all 25 hit zones collapsed into a
// pile at the stage's top-left. The workaround rewrote the directive to
// `style-src 'self' 'unsafe-inline'`.
//
// 0.2.0 fixes it properly: the policy now carries
// `style-src-attr 'unsafe-inline'` alongside a still-nonce-locked `style-src`,
// so attribute styles apply while `<style>` blocks and stylesheets keep their
// nonce. Nothing to work around.
//
// Keeping it would have been actively harmful, and invisibly so. It matched
// `directive.starts_with("style-src")`, which catches `style-src-attr` too —
// so it would have DESTROYED the new directive and stripped the nonce off the
// real one, leaving a strictly weaker policy than upstream ships. The page
// would have rendered perfectly throughout, because the relaxed `style-src` it
// substituted still permits the inline styles the mapper needs. A workaround
// that silently outlives its bug is worse than the bug.

/// One fresh (snapshot, session) pair. Collectors hit the registry, the
/// SCM, schtasks.exe and the daemon pipe — blocking work, kept off the
/// async workers.
pub(super) async fn collect(state: &Arc<AppState>) -> (StatusSnapshot, SessionView) {
    let snap_state = Arc::clone(state);
    tokio::task::spawn_blocking(move || {
        (snap_state.source.snapshot(), snap_state.control.session())
    })
    .await
    .unwrap_or_else(|_| {
        (
            StatusSnapshot::degraded("status collection panicked"),
            SessionView::unreachable("status collection panicked"),
        )
    })
}

pub(super) async fn status_page(
    State(state): State<Arc<AppState>>,
    Query(query): Query<PageQuery>,
) -> Response {
    let (snap, session) = collect(&state).await;

    let flash = query.flash.as_deref().filter(|f| !f.trim().is_empty());
    let out = render_status(&state.page, &snap, &session, flash);
    // No HTTP `Refresh` header any more: it would reload the page for JS
    // users too, defeating the island poller. The no-JS fallback is the
    // <noscript> meta refresh render.rs emits.
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

/// The island poller's endpoint: the SAME [`StatusPayload`] shape the page
/// embeds as island props (parity unit-tested in render.rs). `flash` is
/// always null here — a poll is not an action.
///
/// A loopback bind and no CORS headers keep this response body private from a
/// cross-origin `fetch`, and the page's `connect-src 'self'` is what allows its
/// own. Note what that does NOT cover: a cross-origin form POST needs no CORS
/// permission at all, and a rebound DNS name is same-origin by the browser's
/// reckoning. Both are handled in [`crate::guard`], not here.
pub(super) async fn api_status(State(state): State<Arc<AppState>>) -> Response {
    let (snapshot, session) = collect(&state).await;
    (
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        axum::Json(StatusPayload {
            snapshot,
            session,
            flash: None,
        }),
    )
        .into_response()
}
