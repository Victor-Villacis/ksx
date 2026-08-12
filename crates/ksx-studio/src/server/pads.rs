//! `/pads` — the virtual controller bus: what is plugged, and the two writes.
//!
//! Split out of the 4,241-line `server.rs`. Every item here moved
//! verbatim: the router, the routes and the behaviour are unchanged.

use super::*;

// ---------------------------------------------------------------------------
// /pads — the ViGEm bus, a bounded pad test, and the prune (v15)
// ---------------------------------------------------------------------------
//
// Every fact and every refusal on this page arrives from ONE
// `ksx_api::MachineSource` call. Nothing here counts pads, decides whether a
// bus restart is allowed, or works out how many of eight Xbox pads a game
// could actually read — those are backend decisions with backend tests, and a
// second copy of any of them living in a web page is the failure
// docs/SURFACES.md §1 names by example.

#[derive(Deserialize)]
pub(super) struct PadsQuery {
    /// `1` ARMS the prune: the page re-reads the plan and renders every pad it
    /// would remove, beside a real submit. Deliberately a GET — showing
    /// someone what a destructive button will destroy must not itself change
    /// anything, so a reload, a bookmark or a back button are all harmless.
    confirm: Option<String>,
    flash: Option<String>,
}

/// One fresh pads payload. `MachineSource::pads_view` enumerates devnodes and
/// reads XInput — blocking work, kept off the async workers like [`collect`]
/// and [`collect_map`].
///
/// **The session is read ONCE and fed to the view.** It appears twice on this
/// screen — the header pill, and the spawn panel's refusal — and two separate
/// pipe round-trips inside one render are two separate points in time: a
/// session that starts between them paints "idle" beside "a session is
/// running", or offers a Spawn button the verb will refuse.
pub(super) async fn collect_pads(state: &Arc<AppState>, confirm: bool) -> PadsPayload {
    let pads_state = Arc::clone(state);
    tokio::task::spawn_blocking(move || {
        let session = pads_state.control.session();
        match pads_state.machine.pads_view(session.running) {
            Ok(pads) => PadsPayload {
                pads,
                session,
                confirm,
                unavailable: None,
                flash: None,
            },
            // A provider that cannot answer renders a banner, never a 500 and
            // never an empty pad list that reads as "your bus is clean" — and
            // `unreadable` is what makes the difference, because a
            // `PadsView::default()` here would render four empty pad tiles and
            // a devnode line asserting ViGEmBus is not installed, about a bus
            // ksx never managed to look at.
            Err(refusal) => {
                let reason = match refusal.remedy.as_deref() {
                    Some(remedy) => format!("{} — {remedy}", refusal.message),
                    None => refusal.message,
                };
                PadsPayload {
                    pads: ksx_api::PadsView::unreadable(&reason),
                    session,
                    confirm,
                    unavailable: Some(reason),
                    flash: None,
                }
            }
        }
    })
    .await
    .unwrap_or_else(|_| PadsPayload {
        pads: ksx_api::PadsView::unreadable("the pad collection panicked"),
        session: SessionView::unreachable("pad collection panicked"),
        confirm,
        unavailable: Some("the pad collection panicked".to_owned()),
        flash: None,
    })
}

pub(super) async fn pads_page(
    State(state): State<Arc<AppState>>,
    Query(query): Query<PadsQuery>,
) -> Response {
    let mut payload = collect_pads(&state, query.confirm.as_deref() == Some("1")).await;
    let flash = query.flash.as_deref().filter(|f| !f.trim().is_empty());
    payload.flash = flash.map(str::to_owned);
    let out = crate::render_pads::render_pads(&state.pads_page, &payload);
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

/// The pads poller's endpoint — the same [`PadsPayload`] the page embeds.
///
/// `confirm` is false here whatever the page is showing: a 2 s poll is not a
/// user arming a destructive action, and letting a poll re-arm it would mean
/// the confirm panel could reappear after the user had walked away from it.
pub(super) async fn api_pads(State(state): State<Arc<AppState>>) -> Response {
    let payload = collect_pads(&state, false).await;
    (
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        axum::Json(payload),
    )
        .into_response()
}

/// 303 back to /pads, carrying the outcome as the flash. Errors flash exactly
/// like successes — a page with no JavaScript must never fail silently.
pub(super) fn pads_redirect(outcome: Result<String, String>) -> Response {
    let flash = match outcome {
        Ok(message) => message,
        Err(error) => format!("error: {error}"),
    };
    Redirect::to(&format!("/pads?flash={}", urlencode(&flash))).into_response()
}

/// Run one machine verb off the async workers, then 303 back to /pads.
pub(super) async fn pads_act<F>(state: Arc<AppState>, verb: F) -> Response
where
    F: FnOnce(&dyn ksx_api::MachineSource) -> Result<String, String> + Send + 'static,
{
    let outcome = tokio::task::spawn_blocking(move || verb(state.machine.as_ref()))
        .await
        .unwrap_or_else(|_| {
            Err("That change could not be completed. Nothing was changed. Reopen ksx and try again."
                .to_owned())
        });
    pads_redirect(outcome)
}

#[derive(Deserialize)]
pub(super) struct SpawnForm {
    #[serde(default)]
    count: u8,
    #[serde(default)]
    persona: String,
    #[serde(default)]
    hold_secs: u64,
}

/// POST /pads/spawn — `ksx pads --count N --persona P`, bounded.
///
/// No validation here, on purpose: an absent field arrives as 0/"" and the
/// backend plan refuses it in words ("pad count must be 1..=16, got 0"). A
/// second copy of the bounds in this handler is a second thing to keep in step
/// with `ksx_core::MAX_SLOTS`.
pub(super) async fn pads_form_spawn(
    State(state): State<Arc<AppState>>,
    Form(form): Form<SpawnForm>,
) -> Response {
    pads_act(state, move |machine| {
        machine
            .pads(&ksx_api::PadsSpawnSpec {
                count: form.count,
                persona: form.persona,
                hold_secs: form.hold_secs,
            })
            .map_err(flash_of)
    })
    .await
}

#[derive(Deserialize)]
pub(super) struct PruneForm {
    /// The armed panel's hidden field, and the only thing that turns this from
    /// a dry run into a bus restart.
    ///
    /// Its absence is not an error: `pads_prune(false)` is the CLI's own dry
    /// run, so a POST that did not come from the confirm screen answers with
    /// what WOULD happen instead of doing it. The guard stops another site;
    /// this is what stops a stray submit from this one.
    #[serde(default)]
    confirm: Option<String>,
}

/// POST /pads/prune — `ksx pads --prune`, with `--yes` spelled `confirm=yes`.
pub(super) async fn pads_form_prune(
    State(state): State<Arc<AppState>>,
    Form(form): Form<PruneForm>,
) -> Response {
    let confirm = form.confirm.as_deref() == Some("yes");
    pads_act(state, move |machine| {
        machine.pads_prune(confirm).map_err(flash_of)
    })
    .await
}
