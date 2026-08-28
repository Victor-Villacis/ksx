//! `/redesign` — the transplant rebuild's workbench.
//!
//! The same shape as every page module here: one collector on a blocking
//! worker, one GET that renders it themed, one JSON twin the island polls —
//! and, since the theme menu transplanted in, the page's first verb:
//! `POST /redesign/theme`, `/nocturne`'s theme verb re-homed with its own
//! 303 target and the same allowlisted `?flash=` outcome channel.

use super::*;

#[derive(Deserialize)]
pub(super) struct RedesignQuery {
    flash: Option<String>,
}

/// The sentences this page may be asked to repeat after a redirect, resolved
/// against an allowlist exactly like `/nocturne` — never reflected. The theme
/// verb's sentences ARE nocturne's constants: one wording, two pages, so the
/// copy cannot drift between the surfaces (the cutover's "provider text"
/// lesson, applied in advance).
const RD_FLASH_ALLOWLIST: [&str; 4] =
    [N_THEME_OK, N_THEME_UNKNOWN, N_EDIT_ERROR, N_UNKNOWN_FLASH_ERROR];

pub(super) fn redesign_flash_from_query(flash: Option<&str>) -> Option<String> {
    let flash = flash?.trim();
    if flash.is_empty() {
        return None;
    }
    Some(
        RD_FLASH_ALLOWLIST
            .into_iter()
            .find(|safe| *safe == flash)
            .unwrap_or(N_UNKNOWN_FLASH_ERROR)
            .to_owned(),
    )
}

fn redesign_redirect(flash: &str) -> Response {
    Redirect::to(&format!("/redesign?flash={}", urlencode(flash))).into_response()
}

/// One fresh [`RedesignPayload`]: the machine provenance and the theme
/// roster, on a blocking worker like every other collector read. The setup
/// read is the SAME `machine_cache` read `page_theme` stamps the page from,
/// so the menu's marked row and the `<html data-theme>` stamp cannot
/// disagree within a render.
pub(super) async fn collect_redesign(state: &Arc<AppState>) -> RedesignPayload {
    let redesign_state = Arc::clone(state);
    tokio::task::spawn_blocking(move || {
        let setup = redesign_state
            .machine_cache
            .setup_state(&*redesign_state.machine)
            .ok();
        crate::render_redesign::payload(&redesign_state.source.environment(), setup)
    })
    .await
    .unwrap_or_default()
}

/// `GET /redesign` — the redesign lane's canvas workbench.
pub(super) async fn redesign_page(
    State(state): State<Arc<AppState>>,
    Query(query): Query<RedesignQuery>,
) -> Response {
    let payload = collect_redesign(&state).await;
    let flash = redesign_flash_from_query(query.flash.as_deref());
    let theme = page_theme(&state).await;
    let out = crate::render::with_theme(
        render_redesign(&state.redesign_page.get(), &payload, flash.as_deref()),
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

#[derive(Deserialize)]
pub(super) struct RedesignThemeForm {
    theme: Option<String>,
}

/// POST /redesign/theme — `nocturne_form_theme`, re-homed for this page's
/// menu (the handler body is that verb's, verbatim; only the redirect target
/// differs). A config write like blocking, but read per page render rather
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
        return redesign_redirect("the form did not say which theme — pick one on the page");
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
