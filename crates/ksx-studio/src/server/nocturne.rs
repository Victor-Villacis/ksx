//! `/nocturne` — the design proof (see `render_nocturne.rs`).
//!
//! One GET, no state read, no verbs, no API twin: the page is entirely
//! build-time constants, so serving it is rendering the embedded IR from
//! defaults and nothing else. Registered above the guard layer like every
//! page route; the standard loopback + Origin/Host guards still apply.

use super::*;

use crate::render_nocturne::render_nocturne;

/// `GET /nocturne` — the whole prototype, statically.
pub(super) async fn nocturne_page_handler(State(state): State<Arc<AppState>>) -> Response {
    let out = render_nocturne(&state.nocturne_page);
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
