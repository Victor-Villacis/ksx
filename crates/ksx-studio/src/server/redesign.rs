//! `/redesign` — the transplant rebuild's workbench.
//!
//! The same shape as every page module here: one collector on a blocking
//! worker, one GET that renders it themed, one JSON twin the island polls —
//! plus the theme and device-staging verbs transplanted from `/nocturne`,
//! each re-homed with its own 303 target and the same allowlisted `?flash=`
//! outcome channel.

use super::*;

#[derive(Deserialize)]
pub(super) struct RedesignQuery {
    flash: Option<String>,
}

/// The sentences this page may be asked to repeat after a redirect, resolved
/// against an allowlist exactly like `/nocturne` — never reflected. Every
/// verb's sentences ARE nocturne's constants: one wording, two pages, so the
/// copy cannot drift between the surfaces (the cutover's "provider text"
/// lesson, applied in advance).
const RD_FLASH_ALLOWLIST: [&str; 7] = [
    N_THEME_OK,
    N_THEME_UNKNOWN,
    N_DEVICE_OK,
    N_DEVICE_ALREADY_OK,
    N_FORM_UNREADABLE,
    N_EDIT_ERROR,
    N_UNKNOWN_FLASH_ERROR,
];

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
/// roster, on a blocking worker like every other collector read. The page
/// derives its `<html data-theme>` stamp from the chosen row in this payload,
/// so the stamp and the menu cannot disagree within a render.
pub(super) async fn collect_redesign(state: &Arc<AppState>) -> RedesignPayload {
    let redesign_state = Arc::clone(state);
    tokio::task::spawn_blocking(move || {
        let setup = redesign_state
            .machine_cache
            .setup_state(&*redesign_state.machine)
            .ok();
        // The device scan, for the workbench picker. Deliberately UNCACHED,
        // for the reason `/devices` gives — a board unplugged ten minutes ago
        // must stop being offered — and affordable here because this page has
        // no interval poller: the read runs on a page render and after a
        // verb, not every two seconds. The refusal keeps its remedy (the
        // `/devices` composition): it is going onto a page, and "run `ksx
        // devices`" is the whole value of the message.
        let scan = redesign_state
            .machine
            .device_scan()
            .map_err(|refusal| match &refusal.remedy {
                Some(remedy) => format!("{} — {remedy}", refusal.message),
                None => refusal.message.clone(),
            });
        // The staged device — the daemon's answer to "which board does ksx
        // split", marked onto the picker rows and the bench cards.
        let staged = redesign_state.control.staged();
        crate::render_redesign::payload(&redesign_state.source.environment(), setup, scan, &staged)
    })
    .await
    .unwrap_or_default()
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
    let payload = collect_redesign(&state).await;
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

/// POST /redesign/device — `nocturne_form_device`, re-homed for the bench
/// card's "Stage this board" action. The body is that verb's, through the
/// SAME [`choose_device_preserving_preparation`] guard — both doors to
/// staging keep the one preparation-preserving compare, so a WinUSB-prepared
/// board pressed again never silently drops back to interception.
pub(super) async fn redesign_form_device(
    State(state): State<Arc<AppState>>,
    form: RedesignForm<RedesignDeviceForm>,
) -> Response {
    let Ok(Form(form)) = form else {
        return redesign_redirect(N_FORM_UNREADABLE);
    };
    let outcome = tokio::task::spawn_blocking(move || {
        choose_device_preserving_preparation(&state, form.selector, form.alias, form.label)
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
