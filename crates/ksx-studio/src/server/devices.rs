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
/// Whether this collection pays for the receipt reconcile.
///
/// `Reconcile::Skip` exists because the read is EXPENSIVE and SLOW-MOVING, a
/// combination the 2 s poller turns into a process spawn every two seconds:
/// `reconcile_report` shells out to `pnputil` to enumerate the driver store,
/// which measured 157 ms on `/api/devices` against 1 ms on `/api/map`.
///
/// Receipts change when somebody prepares or releases a board — an action that
/// goes through this very page and re-renders it. Nothing else moves them. So
/// the page render pays, and the poll does not.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Reconcile {
    /// Read it: a page render, where the card is about to be drawn from nothing.
    Now,
    /// Leave it alone: a poll, which has no new information about receipts and
    /// should not spend a subprocess pretending otherwise.
    Skip,
}

pub(super) async fn collect_devices(state: &Arc<AppState>, reconcile: Reconcile) -> DevicesPayload {
    let scan_state = Arc::clone(state);
    tokio::task::spawn_blocking(move || {
        let session = scan_state.control.session();
        // Read whatever it will give: an unreadable receipt store is its own
        // sentence on the card, never silence, and never inherited from the
        // scan beside it.
        let residue = if reconcile == Reconcile::Skip {
            // NOT the unreadable view — that would render "could not be read"
            // on every poll. `readable: true` with no drift is the honest
            // shape for "this poll did not look", and the island keeps the
            // values the page render gave it (see `applyDevices`).
            ksx_api::WinusbResidueView {
                readable: true,
                ..ksx_api::WinusbResidueView::default()
            }
        } else {
            scan_state
                .machine
                .winusb_residue()
                .unwrap_or_else(|refusal| ksx_api::WinusbResidueView {
                    readable: false,
                    error: refusal.message,
                    line: "What ksx has left behind could not be read.".to_owned(),
                    detail:
                        "This says nothing about whether anything is wrong. Reload to ask again."
                            .to_owned(),
                    ..ksx_api::WinusbResidueView::default()
                })
        };
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
    let mut payload = collect_devices(&state, Reconcile::Now).await;
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
    let payload = collect_devices(&state, Reconcile::Skip).await;
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

#[derive(Deserialize)]
pub(super) struct CertificateSweepForm {
    /// Present only when the explicit confirmation box was ticked. No
    /// subject, thumbprint, store, package or filesystem path is accepted by
    /// this route.
    #[serde(default)]
    confirm: Option<String>,
}

const CERTIFICATE_SWEEP_OK: &str = "Removed the leftover KSX signing certificates and stranded one-time signing keys. Any certificate still signing an installed driver was left in place, so the live driver keeps working.";
const CERTIFICATE_SWEEP_CONSENT: &str =
    "error: Confirm the certificate cleanup first. Nothing was removed.";
const CERTIFICATE_SWEEP_UNVERIFIED: &str = "error: The certificate cleanup could not be verified. KSX will not assume what changed; reopen Devices to read the machine again.";

fn certificate_sweep_redirect(message: &'static str) -> Response {
    Redirect::to(&format!("/devices?flash={}", urlencode(message))).into_response()
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

/// POST /devices/certificates/sweep — remove only orphaned KSX signing
/// certificates through the installed fixed-purpose elevated helper.
///
/// This presentation boundary accepts one bit of consent and nothing else,
/// never reflects helper/provider text, and licenses success only from the
/// typed provider's fresh post-operation residue view. The router-wide
/// loopback Host + same-origin guard applies before this handler, exactly as it
/// does to the config writers above.
pub(super) async fn devices_form_sweep_certificates(
    State(state): State<Arc<AppState>>,
    Form(form): Form<CertificateSweepForm>,
) -> Response {
    if form.confirm.as_deref() != Some("yes") {
        return certificate_sweep_redirect(CERTIFICATE_SWEEP_CONSENT);
    }

    let verified = tokio::task::spawn_blocking(move || {
        // Ignore every helper/provider word. Even the typed action's return is
        // not the proof used by this presentation boundary: ask the existing
        // read side again after it completes, so a stale or optimistic action
        // result cannot license the success flash.
        let _ = state
            .machine
            .winusb_sweep_certificates(&ksx_api::WinusbCertificateSweepSpec { confirm: true })
            .map_err(|_| ())?;
        let after = state.machine.winusb_residue().map_err(|_| ())?;
        if after.readable
            && after.leftover_certificates == 0
            && after.certificates_unknown.trim().is_empty()
        {
            Ok(())
        } else {
            Err(())
        }
    })
    .await
    .is_ok_and(|result| result.is_ok());

    certificate_sweep_redirect(if verified {
        CERTIFICATE_SWEEP_OK
    } else {
        CERTIFICATE_SWEEP_UNVERIFIED
    })
}
