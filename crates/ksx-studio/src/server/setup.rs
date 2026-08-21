//! `/setup` — editing a configuration that is already on disk.
//!
//! Split out of the 4,241-line `server.rs`. Every item here moved
//! verbatim: the router, the routes and the behaviour are unchanged.

use super::*;

// ── /setup: the config first, and the first run ────────────────────────────
//
// Two verbs a user sees. EXPORT hands back a file; IMPORT takes a document.
// Neither takes a path — `ksx_api::MachineSource::{config_export,
// config_import}` are in-memory on purpose, so no screen has to put a
// filesystem in front of someone who asked for their configuration.
//
// Three steps, each ONE backend verb, and each independently resumable: none of
// them is a wizard step, so there is no half-written state to come back to.
// Step 1 belongs to `/devices` and is a link. Steps 2 and 3 are the POSTs
// below.

/// One fresh setup payload. The machine read hits the config store and the two
/// control calls hit the daemon pipe — blocking work, kept off the async
/// workers exactly like [`collect`].
pub(super) async fn collect_setup(state: &Arc<AppState>) -> SetupPayload {
    let setup_state = Arc::clone(state);
    tokio::task::spawn_blocking(move || {
        let setup = match setup_state.machine.setup_state() {
            Ok(view) => SetupSnapshot::ready(view),
            // A refusal is a FACT to render, not a blank page: "this build has
            // no machine provider" and "this machine has nothing configured"
            // want opposite advice.
            Err(refusal) => SetupSnapshot::unavailable(&refusal.message),
        };
        SetupPayload {
            setup,
            session: setup_state.control.session(),
            // Step 3's whole read. Doing it here rather than in client code is
            // what makes "press a button and watch it land" work with
            // scripting off — the <noscript> refresh repaints the key.
            learn: setup_state.control.learn_poll(),
            flash: None,
            ..SetupPayload::default()
        }
        // The page's sentences and its show booleans, composed from the three
        // reads above (snapshot.rs). Composed HERE means the poller's JSON and
        // the server paint carry the identical words — the client derives
        // none of them.
        .composed()
    })
    .await
    .unwrap_or_else(|_| {
        SetupPayload {
            setup: SetupSnapshot::unavailable("the setup collection panicked"),
            session: SessionView::unreachable("the setup collection panicked"),
            learn: crate::control::LearnView::unavailable("the setup collection panicked"),
            flash: None,
            ..SetupPayload::default()
        }
        .composed()
    })
}

pub(super) async fn setup_screen(
    State(state): State<Arc<AppState>>,
    Query(query): Query<PageQuery>,
) -> Response {
    let payload = collect_setup(&state).await;
    let flash = query.flash.as_deref().filter(|f| !f.trim().is_empty());
    let theme = page_theme(&state).await;
    let out = crate::render::with_theme(
        render_setup(&state.setup_page, &payload, flash),
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

/// The setup poller's endpoint — the same [`SetupPayload`] the page embeds
/// (parity pinned in render_setup.rs).
pub(super) async fn api_setup(State(state): State<Arc<AppState>>) -> Response {
    let payload = collect_setup(&state).await;
    (
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        axum::Json(payload),
    )
        .into_response()
}

/// 303 back to /setup with the outcome as the flash. Errors flash too — this
/// page must never fail silently, and its no-JS path has nowhere else to look.
pub(super) fn setup_redirect(outcome: Result<String, String>) -> Response {
    let flash = match outcome {
        Ok(message) => message,
        Err(error) => format!("error: {error}"),
    };
    Redirect::to(&format!("/setup?flash={}", urlencode(&flash))).into_response()
}

/// Comma-separated form words → the `what` list the api verbs take. Empty means
/// "whatever the document carries" / "the whole root", which is what both verbs
/// already document.
pub(super) fn what_words(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect()
}

#[derive(Deserialize)]
pub(super) struct ExportQuery {
    /// `config,games,presets` — absent means the whole root.
    what: Option<String>,
}

/// GET /setup/export.json — the configuration as a download.
///
/// A GET because it writes nothing (see the route comment). The response is the
/// document itself with a `Content-Disposition`, which is what makes an
/// ordinary `<a download>` work with scripting switched off — no blob, no
/// clipboard, no path to type.
pub(super) async fn setup_export(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ExportQuery>,
) -> Response {
    let what = what_words(query.what.as_deref());
    let outcome = tokio::task::spawn_blocking(move || {
        state
            .machine
            .config_export(&ksx_api::ExportRequest { what })
    })
    .await
    .unwrap_or_else(|_| {
        Err(ksx_api::Refusal::new(
            ksx_api::codes::REFUSED,
            "the export panicked",
        ))
    });

    let export = match outcome {
        Ok(export) => export,
        // Back to the page with the reason, rather than a bare error body: the
        // user clicked a link on a page, so the page is where the answer goes.
        Err(refusal) => return setup_redirect(Err(refusal.message)),
    };

    let disposition = format!("attachment; filename=\"{}\"", export.filename);
    let mut response = export.document.into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&disposition)
            .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

/// Every field optional on purpose. A missing one is a REFUSAL WITH A SENTENCE
/// (303 + `?flash=error: …`), not axum's 422 — this page's whole feedback
/// channel with scripting off is the flash, and a bare status page would
/// dead-end the user with nothing to read.
#[derive(Deserialize)]
pub(super) struct ImportForm {
    #[serde(default)]
    document: Option<String>,
    #[serde(default)]
    what: Option<String>,
    /// The "write it" box. Present at all = ticked (HTML omits an unchecked box
    /// entirely), so an absent field is a DRY RUN — which is the consent shape
    /// `ksx config import` has always had, arriving here for free.
    #[serde(default)]
    apply: Option<String>,
    #[serde(default)]
    force: Option<String>,
}

/// POST /setup/import — one `MachineSource::config_import`.
///
/// The report is structured; the flash is one line (`urlencode` caps at 300
/// characters). What the line carries is chosen rather than truncated: a
/// refusal names the FIRST fault and how many more there are, because the
/// commonest way an import fails is a document that will not validate, and
/// telling the owner of this page to go and run a CLI to read a list the page
/// is already holding is the dead end this screen exists to remove.
///
/// The extractor is a `Result` on purpose. Every refusal on this route is a
/// flashed sentence — that is the whole feedback channel with scripting off —
/// so an over-large paste or a wrong content type has to arrive as one too,
/// rather than as axum's bare 413/415 with no way back to the page.
pub(super) async fn setup_form_import(
    State(state): State<Arc<AppState>>,
    form: Result<Form<ImportForm>, axum::extract::rejection::FormRejection>,
) -> Response {
    let Ok(Form(form)) = form else {
        return setup_redirect(Err(
            "that document could not be read — it may be larger than this page accepts \
             (8 MB). Import it with `ksx config import <file>` instead"
                .to_owned(),
        ));
    };
    let request = ksx_api::ImportRequest {
        document: form.document.unwrap_or_default(),
        what: what_words(form.what.as_deref()),
        apply: form.apply.is_some(),
        force: form.force.is_some(),
    };
    if request.document.trim().is_empty() {
        return setup_redirect(Err(
            "nothing to import — paste a configuration into the box first".to_owned(),
        ));
    }
    let outcome = tokio::task::spawn_blocking(move || state.machine.config_import(&request))
        .await
        .unwrap_or_else(|_| {
            Err(ksx_api::Refusal::new(
                ksx_api::codes::REFUSED,
                "the import panicked",
            ))
        });
    setup_redirect(match outcome {
        Ok(report) if report.ok => Ok(import_flash(&report)),
        Ok(report) => Err(import_flash(&report)),
        Err(refusal) => Err(refusal.message),
    })
}

/// One [`ksx_api::ImportReport`] as the sentence this page flashes.
///
/// The backend composes the fact and names no control (`onboard::import`); each
/// surface adds its own. Here that is two things the report cannot know: the
/// label on THIS page's consent box, and the first of the faults it is holding.
pub(super) fn import_flash(report: &ksx_api::ImportReport) -> String {
    let mut line = report.summary.clone();
    if let Some(first) = report.faults.first() {
        line.push_str(&format!(" First: {first}"));
        let rest = report.faults.len() - 1;
        if rest > 0 {
            line.push_str(&format!(" (+{rest} more)"));
        }
    } else if report.ok && !report.applied {
        // A clean dry run. The backend said what it WOULD do and that nothing
        // was written; "write it" is the name of the box on this page and
        // nowhere else.
        line.push_str(" Tick \"write it\" and import again to apply.");
    }
    line
}

#[derive(Deserialize)]
pub(super) struct SetupSlotForm {
    /// Optional so a malformed post is a flashed refusal rather than a 422 —
    /// same rule as [`ImportForm`].
    #[serde(default)]
    slot: Option<u8>,
    #[serde(default)]
    preset: Option<String>,
    /// The `<select>`'s "(this cabinet's config)" sentinel is the empty string:
    /// no profile, so `config.toml`'s `[[slot]]` list.
    #[serde(default)]
    profile: Option<String>,
    /// The SOCD `<select>`. Blank means "not asked about", which is what the
    /// form posts when the row is left alone.
    #[serde(default)]
    socd: Option<String>,
    /// The persona `<select>`, whose "(leave it as it is)" sentinel is the
    /// empty string. Blank never means `xbox360`: it means the form was not
    /// asked about the persona, and the slot keeps whatever it presents itself
    /// as today. See [`ksx_api::SlotAssignRequest::persona`].
    #[serde(default)]
    persona: Option<String>,
}

/// POST /setup/slot — step 2, one `ControlSource::assign_slot` (pipe
/// `slot-assign`, the same verb `ksx slot assign` performs).
///
/// `reload` is asked for, and unlike every other reload on this protocol it is
/// a BOUNCE: the pads replug. The page says so above the button, because after
/// the click is too late to be told.
/// What POST /setup/blocking carries: one served answer name.
#[derive(Debug, Deserialize)]
pub(super) struct SetupBlockingForm {
    blocking: String,
}

/// POST /setup/blocking - change split-or-freeze on a config already on disk.
///
/// The question `FIRST-RUN.md` §3 asks once had exactly one writer in the whole
/// product (`stage::apply`), so the answer given while commissioning a cabinet
/// was permanent. It is not a one-time question: freeze suits a tournament
/// night, split suits the same panel on a desk an hour later.
///
/// No confirm step. Every other write on this page has none either, and the
/// reason holds here: this one changes a FILE, and the file is the thing the
/// next session reads - nothing about the machine moves, no driver rebinds, and
/// the keyboard in the user's hands keeps doing exactly what it was doing.
pub(super) async fn setup_form_blocking(
    State(state): State<Arc<AppState>>,
    Form(form): Form<SetupBlockingForm>,
) -> Response {
    let outcome = tokio::task::spawn_blocking(move || {
        let session = state.control.session();
        state
            .machine
            .set_blocking(
                &ksx_api::BlockingSpec {
                    blocking: form.blocking,
                },
                session.running,
            )
            .map(|view| {
                // Composed here, from the view's own facts. "Saved" and "in
                // effect" are different claims, and a running game is the one
                // case where they come apart: the daemon reads settings at
                // start, so it keeps the old answer until it is restarted.
                if view.session_running {
                    format!(
                        "Saved: {}. The game running right now keeps the old setting until you \
                         stop it and start it again.",
                        view.title
                    )
                } else {
                    format!(
                        "Saved: {}. It takes effect the next time you play.",
                        view.title
                    )
                }
            })
            .map_err(|refusal| refusal.message)
    })
    .await
    .unwrap_or_else(|_| Err("the change did not complete".to_owned()));
    setup_redirect(outcome)
}

/// What POST /setup/theme carries: a theme id from the roster, or `system`.
#[derive(Debug, Deserialize)]
pub(super) struct SetupThemeForm {
    theme: String,
}

/// POST /setup/theme - remember which theme the Studio renders in.
///
/// Validated HERE against the generated [`crate::theme_tokens::THEMES`]
/// roster, not in the machine provider: the roster is a Studio artifact (its
/// stylesheet ships the theme blocks), so the surface that renders the
/// choices is the one that knows which choices exist. `system` clears the
/// stored id — System is the ABSENCE of a choice, not a theme.
///
/// No confirm step, same reasoning as blocking — and unlike blocking there is
/// no session caveat: the theme is read per page render, never by the daemon,
/// so the redirect this returns already renders in the new theme.
pub(super) async fn setup_form_theme(
    State(state): State<Arc<AppState>>,
    Form(form): Form<SetupThemeForm>,
) -> Response {
    let wanted = form.theme.trim().to_owned();
    let stored = if wanted == "system" {
        String::new()
    } else if let Some(meta) = crate::theme_tokens::THEMES.iter().find(|t| t.id == wanted) {
        meta.id.to_owned()
    } else {
        return setup_redirect(Err(format!(
            "'{wanted}' is not a theme this build ships - pick one on the page"
        )));
    };
    let outcome = tokio::task::spawn_blocking(move || {
        state
            .machine
            .set_theme(&ksx_api::ThemeSpec { theme: stored })
            .map(|view| {
                let label = crate::theme_tokens::THEMES
                    .iter()
                    .find(|t| t.id == view.theme)
                    .map(|t| t.label)
                    .unwrap_or("System - follow the operating system");
                format!("Saved: {label}. Every page renders in it from now on.")
            })
            .map_err(|refusal| refusal.message)
    })
    .await
    .unwrap_or_else(|_| Err("the change did not complete".to_owned()));
    setup_redirect(outcome)
}

pub(super) async fn setup_form_slot(
    State(state): State<Arc<AppState>>,
    Form(form): Form<SetupSlotForm>,
) -> Response {
    let preset = form.preset.unwrap_or_default().trim().to_owned();
    if preset.is_empty() {
        return setup_redirect(Err(
            "no preset picked — a slot has to point at one".to_owned()
        ));
    }
    let Some(slot) = form.slot else {
        return setup_redirect(Err(
            "no slot picked — choose which player this preset is for".to_owned(),
        ));
    };
    let request = ksx_api::SlotAssignRequest {
        slot,
        preset: Some(preset),
        profile: form
            .profile
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(str::to_owned),
        // Verbatim, blank dropped — the persona NAME is the backend's to
        // parse and to refuse. A page that validated it here would be the
        // second copy of `Persona::FromStr` docs/SURFACES.md §1 forbids, and
        // it would go stale against ksx-core silently.
        persona: form
            .persona
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(str::to_owned),
        // Same rule, same reason: verbatim, blank dropped, parsed and refused
        // by the backend. `Socd::FromStr` is ksx-core's and stays there.
        socd: form
            .socd
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
        reload: true,
    };
    let outcome = tokio::task::spawn_blocking(move || state.control.assign_slot(&request))
        .await
        .unwrap_or_else(|_| {
            crate::control::SlotOutcome::failed(
                "the control call panicked",
                "run `ksx slot assign --slot N --preset NAME`",
            )
        });
    setup_redirect(slot_flash(outcome))
}

/// POST /setup/prove — step 3, `ControlSource::learn_start` (pipe `learn-key`).
///
/// The daemon's own learner, unchanged: the mapper's "press a key" dialog is
/// the same two verbs. Nothing new is listening to a keyboard here.
pub(super) async fn setup_form_prove(State(state): State<Arc<AppState>>) -> Response {
    let outcome = tokio::task::spawn_blocking(move || state.control.learn_start())
        .await
        .unwrap_or_else(|_| crate::control::LearnView::unavailable("the control call panicked"));
    setup_redirect(learn_flash(
        outcome,
        "Listening — press a button on the panel.",
    ))
}

#[derive(Default, Deserialize)]
pub(super) struct SetupLearnCancelForm {
    #[serde(default)]
    generation: String,
}

/// POST /setup/prove/cancel — cancel only the listener generation rendered in
/// this form, so a stale page cannot stop a newer Identify/Mapping attempt.
pub(super) async fn setup_form_prove_cancel(
    State(state): State<Arc<AppState>>,
    Form(form): Form<SetupLearnCancelForm>,
) -> Response {
    let Ok(generation) = form.generation.trim().parse::<u64>() else {
        return setup_redirect(Err(
            "this listening window is stale — start listening again".to_owned(),
        ));
    };
    let outcome = tokio::task::spawn_blocking(move || {
        state.control.learn_cancel_generation(Some(generation))
    })
    .await
    .unwrap_or_else(|_| crate::control::LearnView::unavailable("the control call panicked"));
    setup_redirect(learn_flash(outcome, "Stopped listening."))
}
