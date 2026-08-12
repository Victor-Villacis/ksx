//! `/devices` — what is plugged in, what ksx is configured for, what it left behind.
//!
//! Split out of the 4,241-line `server.rs`. Every item here moved
//! verbatim: the router, the routes and the behaviour are unchanged.

use super::*;

// ---------------------------------------------------------------------------
// /devices — enumerate, pick, remove
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(super) struct DevicesQuery {
    flash: Option<String>,
}

/// One fresh device scan + session view.
///
/// Blocking on both halves and then some: this walks the whole USB tree,
/// re-reads config.toml and games.toml, and dials the daemon pipe for the
/// session line. Never cached, for the reason `sources.rs` gives — a board
/// that was unplugged ten minutes ago must stop being offered.
///
/// A panic here renders a page that SAYS the scan failed rather than a 500,
/// the same contract `collect` and `collect_map` keep: a dead-end error page
/// stops the refresh loop, and the user is then looking at a browser error
/// instead of at their cabinet.
pub(super) async fn collect_devices(state: &Arc<AppState>) -> DevicesPayload {
    let scan_state = Arc::clone(state);
    tokio::task::spawn_blocking(move || {
        let session = scan_state.control.session();
        // Read whatever it will give: an unreadable receipt store is its own
        // sentence on the card, never silence, and never inherited from the
        // scan beside it.
        let residue = scan_state
            .machine
            .winusb_residue()
            .unwrap_or_else(|refusal| ksx_api::WinusbResidueView {
                readable: false,
                error: refusal.message,
                line: "What ksx has left behind could not be read.".to_owned(),
                detail: "This says nothing about whether anything is wrong. Reload to ask again."
                    .to_owned(),
                ..ksx_api::WinusbResidueView::default()
            });
        match scan_state.machine.device_scan() {
            Ok(scan) => DevicesPayload {
                scan,
                session,
                residue,
                unavailable: String::new(),
                flash: None,
            },
            Err(refusal) => DevicesPayload {
                scan: ksx_api::DeviceScanView::default(),
                session,
                // The two reads are independent: a scan that refused says
                // nothing about whether the receipt store could be read.
                residue,
                // The refusal's own sentence, plus its way out. This is the
                // one place the remedy is NOT dropped: it is going onto a
                // page, not into a 300-character flash, and "run `ksx
                // devices`" is the whole value of the message.
                unavailable: match &refusal.remedy {
                    Some(remedy) => format!("{} — {remedy}", refusal.message),
                    None => refusal.message.clone(),
                },
                flash: None,
            },
        }
    })
    .await
    .unwrap_or_else(|_| DevicesPayload {
        scan: ksx_api::DeviceScanView::default(),
        session: SessionView::unreachable("the device scan panicked"),
        residue: ksx_api::WinusbResidueView {
            readable: false,
            error: "the device page panicked".to_owned(),
            line: "What ksx has left behind could not be read.".to_owned(),
            ..ksx_api::WinusbResidueView::default()
        },
        unavailable: "the device scan panicked — nothing below is a reading of this machine"
            .to_owned(),
        flash: None,
    })
}

pub(super) async fn devices_page(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DevicesQuery>,
) -> Response {
    let mut payload = collect_devices(&state).await;
    let flash = query
        .flash
        .as_deref()
        .filter(|f| !f.trim().is_empty())
        .map(str::to_owned);
    payload.flash = flash.clone();
    let out = render_devices(&state.devices_page, &payload, flash.as_deref());
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

/// The poller's endpoint: the SAME [`DevicesPayload`] shape the page embeds
/// (parity unit-tested in render_devices.rs). `flash` is always null — a poll
/// is not an action.
pub(super) async fn api_devices(State(state): State<Arc<AppState>>) -> Response {
    let payload = collect_devices(&state).await;
    (
        [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        axum::Json(payload),
    )
        .into_response()
}

#[derive(Deserialize)]
pub(super) struct PickForm {
    /// The interface the row's hidden field carries — an instance path. The
    /// backend's own resolver accepts an alias or a unique substring too, and
    /// this posts whatever the user's row held, so the two verbs cannot
    /// disagree about what an argument means.
    query: String,
    /// The name `[[slot]]` entries will use. Blank means "derive one from the
    /// board", exactly like the absent `--alias` flag — a web form always
    /// submits the field, so the emptiness has to survive to the writer as
    /// `None` rather than as an empty alias it would then refuse.
    alias: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct RemoveForm {
    alias: String,
    /// The row's checkbox. Present at all = ticked (HTML omits an unchecked
    /// box entirely) — the same shape the mapper's cross-slot panel uses.
    #[serde(default)]
    force: Option<String>,
}

/// 303 back to the picker, carrying the outcome as the flash.
///
/// Errors flash exactly like successes: this page's whole job is deciding
/// which board drives which slot, and a Remove that silently did nothing is
/// how someone ends up debugging a cabinet that was never changed.
pub(super) fn devices_redirect(outcome: Result<String, String>) -> Response {
    let flash = match outcome {
        Ok(message) => message,
        Err(error) => format!("error: {error}"),
    };
    Redirect::to(&format!("/devices?flash={}", urlencode(&flash))).into_response()
}

/// POST /devices/pick — write one `[[device]]` entry.
///
/// One backend verb, and deliberately the typed one: `device_edit::pick` (the
/// CLI entry point) routes refusals through a function that calls
/// `std::process::exit`, which would take the whole server down on a mistyped
/// alias. `MachineSource::device_pick` is the same plan/apply pair with a
/// `Refusal` on the error arm.
pub(super) async fn devices_form_pick(
    State(state): State<Arc<AppState>>,
    Form(form): Form<PickForm>,
) -> Response {
    let spec = ksx_api::DevicePickSpec {
        query: form.query,
        alias: form.alias,
    };
    let outcome = tokio::task::spawn_blocking(move || {
        state
            .machine
            .device_pick(&spec)
            .map(|view| view.summary)
            .map_err(flash_of)
    })
    .await
    .unwrap_or_else(|_| Err("the device pick panicked".to_owned()));
    devices_redirect(outcome)
}

/// POST /devices/remove — delete one `[[device]]` entry.
///
/// The narrowest of ksx's three removals, and the page says so beside the
/// button. `RemoveOutcome`'s summary is what flashes, and it carries the one
/// fact that surprises people: deleting the entry did not release a claimed
/// board.
pub(super) async fn devices_form_remove(
    State(state): State<Arc<AppState>>,
    Form(form): Form<RemoveForm>,
) -> Response {
    let spec = ksx_api::DeviceRemoveSpec {
        alias: form.alias,
        force: form.force.is_some(),
    };
    let outcome = tokio::task::spawn_blocking(move || {
        state
            .machine
            .device_remove(&spec)
            .map(|view| view.summary)
            .map_err(flash_of)
    })
    .await
    .unwrap_or_else(|_| Err("the device removal panicked".to_owned()));
    devices_redirect(outcome)
}
