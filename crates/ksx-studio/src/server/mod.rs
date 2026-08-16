//! The blocking axum server around the render seam.
//!
//! GET / renders the page (SSR + island props); GET /api/status serves the
//! same [`StatusPayload`] as JSON for the island's 2 s poller (same-origin
//! only — the CSP's `connect-src 'self'` is exactly what permits the fetch).
//! The three POST routes each perform one [`ControlSource`] verb and
//! 303-redirect back to /, carrying the outcome in a `flash` query parameter
//! — plain HTML forms remain the baseline (`form-action 'self'`), which the
//! client optionally upgrades to fetch-submits that read the redirect's
//! flash without a reload.
//!
//! v15 adds `/pads`, and it takes its facts from a THIRD provider:
//! [`ksx_api::MachineSource`], beside the existing status and control ones.
//! Neither of those could answer it — `StatusSource` reads the config store
//! and `ControlSource` the daemon pipe, and a ViGEm bus is neither. Its two
//! verbs keep the CLI's consent shape rather than inventing one: a spawn is
//! bounded (it unplugs itself, because a page has no Ctrl+C) and a prune is a
//! DRY RUN unless the form carries `confirm=yes`.
//!
//! v9 gives the MAPPER the same baseline: `/map/*` are form-encoded twins of
//! the `/api/*` mapper verbs (bind, clear, restore, clear-all, pause), each
//! calling the identical [`ControlSource`] method and 303-ing back to
//! `/map?slot=N&flash=…`. With JavaScript the island intercepts the submit
//! and reports through its toast stack instead; with JavaScript off the page
//! is still fully operable, which is the whole point of the shape.

// ── One module per page, mirroring `render_*.rs` ───────────────────────
//
// `server.rs` reached 4,241 lines carrying 72 routes and 62 handlers, which
// is the size at which two handlers quietly grow two different opinions
// about the same thing. The split is BY PAGE because that is how the render
// seams already split, so a change to one screen now touches one
// `render_*.rs` and one `server/*.rs` with the same name.
//
// Each child does `use super::*` and reaches the shared plumbing kept here:
// `AppState`, `flash_of`, `act`, `urlencode`, the session verbs. The glob
// re-exports let the router keep naming handlers unqualified, which is what
// made this a move rather than a rewrite — no route changed.

mod check;
mod devices;
mod map;
mod pads;
mod profiles;
mod session;
mod setup;
mod start;
mod status;
mod workspace;

use check::*;
use devices::*;
use map::*;
use pads::*;
use profiles::*;
use session::*;
use setup::*;
use start::*;
use status::*;
use workspace::*;

use std::net::SocketAddr;

use std::sync::Arc;

use axum::extract::{Form, Query, State};

use axum::http::{header, HeaderValue, StatusCode};

use axum::response::{IntoResponse, Redirect, Response};

use axum::routing::{get, post};

use axum::Router;

use serde::Deserialize;

use crate::control::{BindOutcome, BindRequest, ControlSource, SessionView};

use crate::error::StudioError;

use crate::render::{render_status, Assets, BrandAssets, EmbeddedPage};

use crate::render_check::render_check;

use crate::render_devices::render_devices;

use crate::render_map::render_map;

use crate::render_setup::render_setup;

use crate::render_start::render_start;

use crate::render_workspace::render_workspace;

use crate::snapshot::{
    CheckPayload, DevicesPayload, MapPayload, PadsPayload, ProfilesPayload, SetupPayload,
    SetupSnapshot, StartPayload, StatusPayload, StatusSnapshot, StatusSource, WorkspacePayload,
};

struct AppState {
    page: EmbeddedPage,
    workspace_page: EmbeddedPage,
    map_page: EmbeddedPage,
    check_page: EmbeddedPage,
    pads_page: EmbeddedPage,
    devices_page: EmbeddedPage,
    profiles_page: EmbeddedPage,
    setup_page: EmbeddedPage,
    start_page: EmbeddedPage,
    source: Box<dyn StatusSource>,
    control: Box<dyn ControlSource>,
    /// The MACHINE reads and writes that are not a `DaemonCommand`: the
    /// device enumeration and the two `[[device]]` writes behind `/devices`,
    /// the ViGEm bus report and the two pad verbs behind `/pads`, the
    /// preflighted profile list, the preset list with its templates, the
    /// two creates behind `/profiles`, and the config in and out plus the
    /// first-run state behind `/setup`. A THIRD provider rather than more
    /// methods on the other two, because that is the split `ksx-api` already
    /// draws — status is what the box looks like, control is what the daemon
    /// can be told, and this is what is on the machine itself (the USB tree,
    /// the config store, the bus device), readable while the pipe is dead,
    /// exactly as the read-only mapper is.
    machine: Box<dyn ksx_api::MachineSource>,
    /// The FOURTH provider: the live input feed
    /// (`ksx_api::LiveSource` over the `ksx-live` named pipe).
    ///
    /// Not a method on any of the other three, because it is not their shape.
    /// Status is a point-in-time snapshot, control is one verb per call and
    /// machine is what is on this box — all three are *questions with an
    /// answer*. This is a subscription that outlives any answer, on its own
    /// channel, for a reason [`ksx_api::LiveSource`] spells out: the control
    /// pipe serves connections one at a time, so a stream on it would take the
    /// daemon's whole control surface down with the tab.
    ///
    /// `Arc`, not `Box`, because every SSE connection hands a handle to its own
    /// blocking bridge thread.
    live: Arc<dyn ksx_api::LiveSource>,
}

/// Serve the page until the process is killed (Ctrl+C included — no
/// graceful-shutdown plumbing).
///
/// Blocking on purpose: the caller owns no runtime, and this function keeps
/// its own multi-threaded tokio runtime at NORMAL priority, fully isolated
/// from anything time-critical (docs/ENHANCEMENTS.md E7 "own runtime, normal
/// priority").
///
/// Refuses any non-loopback `bind` before a socket exists.
pub fn serve(
    bind: SocketAddr,
    source: Box<dyn StatusSource>,
    control: Box<dyn ControlSource>,
    machine: Box<dyn ksx_api::MachineSource>,
    live: Arc<dyn ksx_api::LiveSource>,
) -> Result<(), StudioError> {
    if !bind.ip().is_loopback() {
        return Err(StudioError::NonLoopbackBind { bind });
    }
    let page = EmbeddedPage::load("/")?;
    let workspace = EmbeddedPage::load("/workspace")?;
    let mapper = EmbeddedPage::load("/map")?;
    let check = EmbeddedPage::load("/check")?;
    let pads = EmbeddedPage::load("/pads")?;
    let devices = EmbeddedPage::load("/devices")?;
    let profiles = EmbeddedPage::load("/profiles")?;
    let setup = EmbeddedPage::load("/setup")?;
    let start = EmbeddedPage::load("/start")?;
    let state = Arc::new(AppState {
        page,
        workspace_page: workspace,
        map_page: mapper,
        check_page: check,
        pads_page: pads,
        devices_page: devices,
        profiles_page: profiles,
        setup_page: setup,
        start_page: start,
        source,
        control,
        machine,
        live,
    });

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("ksx-studio")
        .enable_io()
        .enable_time()
        .build()
        .map_err(StudioError::Runtime)?;

    runtime.block_on(async move {
        let listener = tokio::net::TcpListener::bind(bind)
            .await
            .map_err(|source| StudioError::Bind { bind, source })?;
        let app = Router::new()
            .route("/", get(status_page))
            .route("/api/status", get(api_status))
            // ── /workspace — the Nocturne workspace (M2: left-pane verbs) ─
            // The reads, plus the left pane's form twins — each ONE staging
            // verb, 303 → /workspace?flash=. The center and right panes'
            // verbs arrive with M3–M4.
            .route("/workspace", get(workspace_page))
            .route("/api/workspace", get(api_workspace))
            .route("/workspace/blocking", post(workspace_form_blocking))
            .route("/workspace/controller/move", post(workspace_form_move))
            .route("/workspace/controller/remove", post(workspace_form_remove))
            .route("/workspace/controller/socd", post(workspace_form_socd))
            .route("/workspace/controller", post(workspace_form_add))
            .route("/workspace/device/identify", post(workspace_form_identify))
            .route("/workspace/adopt", post(workspace_form_adopt))
            .route("/session/start", post(session_start))
            .route("/session/stop", post(session_stop))
            .route("/config/reload", post(config_reload))
            // The mapper (v5): page + poll payload + the learn/bind verbs,
            // each a thin wrapper over one ControlSource method (= one pipe
            // verb — no GUI-only code paths).
            .route("/map", get(map_page))
            .route("/api/map", get(api_map))
            .route("/api/learn", get(api_learn_poll))
            .route("/api/learn/start", post(api_learn_start))
            .route("/api/learn/cancel", post(api_learn_cancel))
            .route("/api/bind", post(api_bind))
            // v10: write a control's WHOLE key list (many keys → one
            // control). The island computes the new set from the payload it
            // is already polling — add = ∪ {k}, per-key ✕ = ∖ {k} — and posts
            // it here; `bind_keys` is what knows how to spell that on the
            // wire. Not a new daemon verb: today it composes the same `map`
            // the button beside it uses.
            .route("/api/bind/keys", post(api_bind_keys))
            // v11: the macro editor's SAVE — one whole `[macros.<name>]`
            // table per call, through `ControlSource::save_macro` (= the
            // daemon's `map-macro` verb, = the `ksx macro` CLI's writer). No
            // GUI-only path, and no second macro schema: the steps on the wire
            // are the MacroStepView rows the read side already served.
            .route("/api/macro/save", post(api_macro_save))
            .route("/api/preset/restore", post(api_preset_restore))
            .route("/api/preset/clear-all", post(api_preset_clear_all))
            // The mapper's own session controls (FIX 0): "Pause emulation &
            // map" and "Resume emulation" are the SAME ControlSource verbs
            // the status page's forms use — one pipe verb each, no GUI-only
            // path — served as JSON so the mapper never navigates away and
            // loses the user's place.
            .route("/api/session/stop", post(api_session_stop))
            .route("/api/session/start", post(api_session_start))
            // ...and Resume is `ControlSource::resume`, NOT a start with a
            // remembered profile. This page cannot know whether it paused a
            // games.toml profile or an unsaved staged setup — a staged session
            // has no profile at all — and a start is defined as the config on
            // disk, so resuming that way put back the wrong session (or none).
            // The daemon knows what it started; this route asks it.
            .route("/api/session/resume", post(api_session_resume))
            // v9 — the NO-JAVASCRIPT write path. Same verbs, same
            // ControlSource methods as the /api/* routes beside them; the
            // only difference is the wire shape (form-encoded in, 303 out
            // instead of JSON in and JSON back). A browser with scripting
            // switched off can bind, clear, restore and pause with these,
            // and the island fetch-enhances them on top (map.ts) so a page
            // WITH scripting never navigates.
            .route("/map/bind", post(map_form_bind))
            // v10 — MANY KEYS → ONE CONTROL, without JavaScript. Same row
            // form, same key picker, two more submits: `add` appends the
            // picked key to the control's list, `key/remove` takes just that
            // one off it. Both are read-modify-write on the key SET and land
            // through `ControlSource::bind_keys` — no new daemon verb.
            .route("/map/add", post(map_form_add))
            .route("/map/key/remove", post(map_form_remove_key))
            .route("/map/clear", post(map_form_clear))
            .route("/map/turbo", post(map_form_turbo))
            .route("/map/preset/restore", post(map_form_restore))
            .route("/map/preset/clear-all", post(map_form_clear_all))
            .route("/map/session/stop", post(map_form_session_stop))
            // v15 — the PADS page: what is on the ViGEm bus, a bounded pad
            // test, and the prune that clears ghosts. Three routes, one
            // `MachineSource` verb each, and the arming step is a GET
            // (`/pads?confirm=1`) because showing someone what a destructive
            // button will remove must not itself be a POST.
            // BUILD C — the button check, one click from the mapper. Two
            // routes and no verbs: the page is a READ of the slot roster, and
            // the lighting-up arrives on /api/live beside it rather than
            // through either of these. Nothing here writes, so nothing here
            // needs the guard's mutating arm — the Host check still covers it,
            // which is what stops a rebound origin watching the panel.
            .route("/check", get(check_page))
            .route("/api/check", get(api_check))
            // ── THE LIVE FEED ─────────────────────────────────────────────
            // One route, and it is the keystone the button check stands on:
            // the daemon's input fan-out as Server-Sent Events. Read-only and
            // one-directional by construction — the browser has nothing to say
            // back, and everything it might want to say is already a verb on a
            // route above. `crate::live` carries why SSE and not a WebSocket,
            // and how a stalled tab is made to cost the pipeline nothing.
            .route("/api/live", get(api_live))
            .route("/pads", get(pads_page))
            .route("/api/pads", get(api_pads))
            .route("/pads/spawn", post(pads_form_spawn))
            .route("/pads/prune", post(pads_form_prune))
            // v17: the DEVICE PICKER — `ksx device scan` as a page, plus the
            // two config writes it exists for. Read is
            // `MachineSource::device_scan` (boards, not devnodes); the writes
            // are `device_pick` and `device_remove`, which are the CLI's own
            // plan/apply pair and need no daemon. Exact-device prepare/release
            // stay in the guarded Setup flow. The separate certificate sweep
            // below is machine-wide, accepts no identity/path from the browser
            // and can reach only the installed fixed-purpose helper.
            .route("/devices", get(devices_page))
            .route("/api/devices", get(api_devices))
            .route("/devices/pick", post(devices_form_pick))
            .route("/devices/remove", post(devices_form_remove))
            .route(
                "/devices/certificates/sweep",
                post(devices_form_sweep_certificates),
            )
            // PROFILES & PRESETS. The read is `MachineSource::profiles`
            // (games.toml with `ksx_games::preflight` already run, so a
            // profile whose .exe moved is a broken ROW instead of a cabinet
            // that does nothing when the button is pressed) plus
            // `MachineSource::presets`. The three writes are one backend verb
            // each: `profile_new`, `preset_new`, and — for "switch to this" —
            // the SAME `ControlSource::start` the status page's forms post,
            // 303-ing back here so the user keeps their place, exactly as
            // `/map/session/stop` reuses `stop`.
            .route("/profiles", get(profiles_page))
            .route("/api/profiles", get(api_profiles))
            .route("/profiles/new", post(profiles_form_new))
            .route("/profiles/update", post(profiles_form_update))
            .route("/profiles/delete", post(profiles_form_delete))
            .route("/profiles/switch", post(profiles_form_switch))
            .route("/profiles/stop", post(profiles_form_stop))
            .route("/profiles/preset/new", post(profiles_form_preset_new))
            .route("/profiles/preset/rename", post(profiles_form_preset_rename))
            .route("/profiles/preset/delete", post(profiles_form_preset_delete))
            // ── /setup — the CONFIG FIRST, and the first run ───────────────
            // Two verbs a person sees (Export, Import) and three steps, each
            // one backend verb. No route here takes a filesystem path, in or
            // out: the export IS the bytes and the import IS the document, so
            // nothing on this page ever asks anyone to name a file.
            .route("/setup", get(setup_screen))
            .route("/api/setup", get(api_setup))
            // A GET on purpose: it writes nothing, and `guard.rs` decides what
            // to police by METHOD — a read wearing a POST would be a lie the
            // guard then has to work around. The Host check still covers it.
            .route("/setup/export.json", get(setup_export))
            // DRY RUN unless the form's "write it" box is ticked
            // (`ksx_api::ImportRequest::apply`), which is the CLI's consent
            // shape and not a web-only ceremony.
            //
            // The one route with its own body limit. axum's default is 2 MB,
            // and a whole cabinet — config, every games.toml profile and every
            // preset in one interop document — can exceed it; the cost of the
            // default was a bare 413 with no way back to the page. 8 MB is
            // roomy for a configuration and still a bound, and the handler
            // turns the rejection into a flashed sentence either way.
            .route(
                "/setup/import",
                post(setup_form_import)
                    .layer(axum::extract::DefaultBodyLimit::max(8 * 1024 * 1024)),
            )
            // Step 2: one `ControlSource::assign_slot` — the same pipe verb
            // `ksx slot assign` performs. It BOUNCES the pads, which the page
            // says before the click, not after it.
            .route("/setup/slot", post(setup_form_slot))
            .route("/setup/blocking", post(setup_form_blocking))
            // Step 3: the daemon's own learner, the two verbs the mapper
            // already uses. The page renders `learn_poll` per request, so this
            // step works with scripting switched off.
            .route("/setup/prove", post(setup_form_prove))
            .route("/setup/prove/cancel", post(setup_form_prove_cancel))
            // ── /start — THE FIRST RUN (docs/FIRST-RUN.md moments 4–7) ─────
            //
            // A new page rather than a rebuilt `/setup`, and the split is the
            // contract, not the layout: every `/setup` step reads config.toml
            // and writes to it, and NOTHING here touches a file until
            // `/start/save`. One screen holding both rules would be a screen
            // where the user cannot tell which controls commit — which is the
            // whole thing staging exists to fix (`render_start.rs` has the
            // longer version).
            //
            // Thirteen routes. The seven staging ones are ONE `ControlSource`
            // verb each and reach nothing outside the daemon's own memory — no
            // file, no driver, no session — which is what makes exploring free.
            // `/start/save` is one config write (the same shape as
            // `/setup/slot`) and `/start/play` starts a session from a plan
            // built in memory. The two capture routes are the deliberately
            // narrow exception to the old browser claim prohibition: an
            // exact served interface, three explicit consents, and the local
            // MachineSource's installed UAC helper. Studio never receives a
            // backend choice or helper output from the browser.
            //
            // The RESCAN is deliberately not here. It is a link back to
            // `/start`, because re-reading the machine writes nothing and a
            // read wearing a POST is a lie the guard then has to work around
            // (the same argument `/setup/export.json` makes).
            .route("/start", get(start_page))
            .route("/api/start", get(api_start))
            .route("/start/device", post(start_form_device))
            .route("/start/device/identify", post(start_form_identify))
            .route("/start/capture/prepare", post(start_form_capture_prepare))
            .route("/start/capture/release", post(start_form_capture_release))
            .route("/start/controller", post(start_form_controller))
            .route(
                "/start/controller/persona",
                post(start_form_controller_persona),
            )
            // Moment 6 IN THE STAGE: dress a staged controller in one of
            // ksx's in-box layouts. One `stage-edit`, so it reaches nothing
            // outside the daemon's memory — the bindings a first-run user
            // needs arrive without a file write and without the mapper, which
            // edits FILES and could therefore never have been step 3 of a flow
            // that has not saved anything yet.
            .route("/start/controller/layout", post(start_form_layout))
            .route("/start/controller/remove", post(start_form_remove))
            .route("/start/blocking", post(start_form_blocking))
            .route("/start/autostart", post(start_form_autostart))
            .route("/start/discard", post(start_form_discard))
            .route("/start/save", post(start_form_save))
            .route("/start/play", post(start_form_play))
            // Canon helper: correct no-cache + Service-Worker-Allowed
            // headers for free (replaced a hand-rolled handler).
            .route("/sw.js", get(forma_server::sw::serve_sw::<Assets>))
            .route(
                "/_assets/{filename}",
                get(forma_server::assets::serve_asset::<Assets>),
            )
            // The brand icons, at the ROOT paths their consumers hard-code.
            // Not under `/_assets/`: a browser asks for `/favicon.ico` with
            // no prompting from the markup, and iOS probes
            // `/apple-touch-icon.png` the same way — a link tag pointing
            // elsewhere is an optimisation on top of those defaults, never a
            // replacement for them.
            .route("/favicon.ico", get(favicon_ico))
            .route("/favicon.svg", get(favicon_svg))
            .route("/apple-touch-icon.png", get(apple_touch_icon))
            // ONE layer over every route, not a check per handler. The routes
            // above arrived in three separate milestones and the mapper alone
            // contributed eight form endpoints; a guard you have to remember to
            // add to each new one is a guard that will be missing from the
            // ninth. See `crate::guard` for what this refuses and why an
            // absent `Origin` is deliberately allowed through.
            .layer(axum::middleware::from_fn(move |req, next| {
                crate::guard::same_origin(bind, req, next)
            }))
            .with_state(state);
        tracing::info!(%bind, "ksx Studio listening");
        axum::serve(listener, app).await.map_err(StudioError::Serve)
    })
}

/// One blocking ControlSource call → JSON, shared by the learn/bind routes.
async fn control_json<T, F>(state: Arc<AppState>, call: F) -> Response
where
    T: serde::Serialize + Send + 'static,
    F: FnOnce(&dyn ControlSource) -> T + Send + 'static,
{
    let value = tokio::task::spawn_blocking(move || call(state.control.as_ref())).await;
    match value {
        Ok(value) => (
            [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))],
            axum::Json(value),
        )
            .into_response(),
        Err(_) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "the control call panicked",
        )
            .into_response(),
    }
}

/// One [`crate::control::SlotOutcome`] as the sentence this page flashes.
///
/// **The canonical formatters, not a second reconstruction.**
/// [`ksx_api::SlotOutcome::headline`] is the designated one-line renderer and
/// is what the cabinet (`ksx-cabinet/src/app.rs`) and the daemon
/// (`ksx-backend/src/daemon/pipe.rs`) print; `refusal()` is the matching one for
/// the error arm, and it carries the CODE and the remedy that a hand-built
/// `unwrap_or` throws away.
///
/// This used to rebuild the sentence from flags — `message` then `if restarted
/// { push(" The pads replugged.") }` — which is the exact re-derivation
/// `control.rs::a_slot_outcome_prints_what_the_daemon_said_rather_than_re_deriving_it`
/// forbids by name. It went wrong three ways: it double-named the bounce when
/// the daemon's own sentence already named it, it lost slot/preset/`unchanged`
/// when there was no sentence, and it had no way to say "nothing was running,
/// so nothing had to restart" — which is the state this page's own wire form is
/// offered in, because it turns on `reachable`, not `running`.
fn slot_flash(outcome: crate::control::SlotOutcome) -> Result<String, String> {
    match outcome.refusal() {
        Some(refusal) => Err(refusal.message),
        None => Ok(outcome.headline()),
    }
}

fn learn_flash(view: crate::control::LearnView, done: &str) -> Result<String, String> {
    match view.refusal() {
        Some(refusal) => Err(refusal.message),
        None => Ok(done.to_owned()),
    }
}

#[derive(Deserialize)]
struct StartForm {
    profile: Option<String>,
}

async fn session_start(
    State(state): State<Arc<AppState>>,
    Form(form): Form<StartForm>,
) -> Response {
    // "" is the dropdown's "(config default)" sentinel — no override.
    let profile = form
        .profile
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_owned);
    act(state, move |control| {
        control.start(profile.as_deref()).map_err(flash_of)
    })
    .await
}

async fn session_stop(State(state): State<Arc<AppState>>) -> Response {
    act(state, |control| control.stop().map_err(flash_of)).await
}

async fn config_reload(State(state): State<Arc<AppState>>) -> Response {
    act(state, |control| control.reload().map_err(flash_of)).await
}

/// One [`ksx_api::Refusal`] as the sentence a page flashes — message AND
/// remedy.
///
/// It used to drop the remedy, justified by "the page already has a place for
/// it: the no-daemon banner, which prints the exact `ksx daemon` command".
/// That is true of the CONTROL refusals this function was written for, and
/// false of every machine verb the Profiles page added, which is where review
/// caught it. `preset-exists` is the sharpest case: the message names the
/// preset it protected, and the remedy — "--force overwrites it (a timestamped
/// backup is taken first)" — is the only path forward that exists anywhere on
/// that page. Same for `unknown-template` ("`ksx preset list --templates`
/// names the ones that ship") and `NoSuchPreset` ("`ksx preset new …` makes
/// one"). A refusal with its way out deleted is just an error message.
///
/// One line still, joined with an em dash: `urlencode` caps the flash at 300
/// characters and the page renders it in a wrapping `<p>`.
fn flash_of(refusal: ksx_api::Refusal) -> String {
    match refusal.remedy {
        Some(remedy) => format!("{} — {remedy}", refusal.message),
        None => refusal.message,
    }
}

/// Run one control verb off the async workers (the pipe client blocks), then
/// 303 back to / with the outcome as the flash. Errors are flashed too —
/// never a silent failure, never an error page dead-ending the refresh loop.
async fn act<F>(state: Arc<AppState>, verb: F) -> Response
where
    F: FnOnce(&dyn ControlSource) -> Result<String, String> + Send + 'static,
{
    let outcome = tokio::task::spawn_blocking(move || verb(state.control.as_ref()))
        .await
        .unwrap_or_else(|_| Err("the control call panicked".to_owned()));
    let flash = match outcome {
        Ok(message) => message,
        Err(error) => format!("error: {error}"),
    };
    Redirect::to(&format!("/?flash={}", urlencode(&flash))).into_response()
}

/// One embedded brand icon, with a real content type.
///
/// `forma_server::assets::serve_asset` is deliberately NOT reused for these.
/// Two of its behaviours are right for hashed build output and wrong here:
///
/// - its `mime_for` knows js/css/woff2/wasm/json/html/svg and answers
///   `application/octet-stream` for everything else, so the `.ico` and the
///   `.png` would arrive as downloads rather than as icons;
/// - it stamps `Cache-Control: public, max-age=31536000, immutable`, which is
///   correct for `studio.485e0edb.css` and actively harmful for a file called
///   `favicon.ico` — regenerate the brand and every browser that ever loaded
///   the page keeps the old mark for a year.
///
/// A day is the compromise: browsers cache favicons aggressively anyway, and
/// a cabinet's Studio page is opened from a bookmark most days.
fn brand(name: &str, mime: &'static str) -> Response {
    let Some(file) = BrandAssets::get(name) else {
        // Only reachable if the crate was compiled without
        // `crates/ksx-studio/brand/`, which `brand_embed_carries_the_trio`
        // turns into a test failure rather than a 404 nobody sees.
        tracing::error!(name, "brand asset missing from the embed");
        return StatusCode::NOT_FOUND.into_response();
    };
    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(mime)),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=86400"),
            ),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
        ],
        file.data.to_vec(),
    )
        .into_response()
}

async fn favicon_ico() -> Response {
    brand("favicon.ico", "image/x-icon")
}

async fn favicon_svg() -> Response {
    brand("favicon.svg", "image/svg+xml")
}

async fn apple_touch_icon() -> Response {
    brand("apple-touch-icon.png", "image/png")
}

/// Query-string percent-encoding (RFC 3986 unreserved set kept literal).
/// Local, tiny, and total — not worth a dependency.
fn urlencode(text: &str) -> String {
    // The flash is a one-line human sentence; cap it (on a char boundary, so
    // the encoded query decodes as valid UTF-8) so a pathological daemon
    // error cannot mint an absurd URL.
    let mut out = String::new();
    let mut utf8 = [0u8; 4];
    for c in text.chars().take(300) {
        for byte in c.encode_utf8(&mut utf8).bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    out.push(byte as char);
                }
                _ => out.push_str(&format!("%{byte:02X}")),
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ledger #13, closed upstream: ksx ships forma's CSP verbatim now.
    ///
    /// This replaces a test that pinned the OLD workaround. It asserts the
    /// three properties that made deleting it safe, against the header a real
    /// request produces — not against a hand-written string, because the point
    /// is that upstream's policy is what reaches the browser.
    #[test]
    fn the_served_csp_is_forma_own_and_permits_style_attributes() {
        let csp = forma_server::build_csp_header(&forma_server::generate_csp_nonce());

        // 1. The reason the workaround existed. `style-src-attr 'unsafe-inline'`
        //    is what lets the mapper's compiled `style:` bindings apply — the
        //    25 hit zones' geometry, and the countdown bar's width.
        assert!(
            csp.contains("style-src-attr 'unsafe-inline'"),
            "without this every inline style=\"\" is dropped and the mapper's zones \
             collapse into a pile: {csp}"
        );

        // 2. What the workaround cost, and no longer does. A nonce in style-src
        //    is what makes `<style>` blocks and stylesheets attacker-proof;
        //    relax_style_src stripped it to buy attribute styles.
        assert!(
            csp.contains("style-src 'nonce-"),
            "style-src must stay nonce-locked — attribute styles are permitted by \
             style-src-attr, not by weakening this: {csp}"
        );

        // 3. The trap that made keeping the workaround dangerous rather than
        //    merely redundant. It matched `starts_with("style-src")`, so it
        //    caught style-src-attr too — destroying the new directive AND
        //    stripping the nonce, while the page still rendered perfectly.
        assert_eq!(
            csp.split(';')
                .filter(|d| d.trim().starts_with("style-src"))
                .count(),
            2,
            "two directives share the style-src prefix; any prefix-matching \
             rewrite of this header silently mangles one of them: {csp}"
        );
        assert!(csp.contains("script-src 'nonce-"), "{csp}");
    }

    struct NullSource;
    impl StatusSource for NullSource {
        fn snapshot(&self) -> StatusSnapshot {
            StatusSnapshot::default()
        }
    }

    struct NullControl;
    impl ControlSource for NullControl {
        fn session(&self) -> SessionView {
            SessionView::unreachable("test")
        }
        fn start(&self, _profile: Option<&str>) -> Result<String, ksx_api::Refusal> {
            Err(ksx_api::Refusal::new(ksx_api::codes::REFUSED, "test"))
        }
        fn stop(&self) -> Result<String, ksx_api::Refusal> {
            Err(ksx_api::Refusal::new(ksx_api::codes::REFUSED, "test"))
        }
        fn reload(&self) -> Result<String, ksx_api::Refusal> {
            Err(ksx_api::Refusal::new(ksx_api::codes::REFUSED, "test"))
        }
    }

    /// Every method defaulted: the trait refuses in words and names the CLI
    /// verb that works, which is the honest provider for a test that never
    /// gets as far as binding.
    struct NullMachine;
    impl ksx_api::MachineSource for NullMachine {}

    /// Rule C: no code path may open a non-loopback listener. The refusal
    /// happens before any socket exists.
    #[test]
    fn serve_refuses_non_loopback_binds() {
        for addr in ["0.0.0.0:4460", "192.168.1.10:4460", "[::]:4460"] {
            let bind: SocketAddr = addr.parse().unwrap();
            let err = serve(
                bind,
                Box::new(NullSource),
                Box::new(NullControl),
                Box::new(NullMachine),
                Arc::new(ksx_api::NoLiveSource::new("no live feed in this test")),
            )
            .unwrap_err();
            assert!(
                matches!(err, StudioError::NonLoopbackBind { .. }),
                "{addr}: {err}"
            );
        }
    }

    /// The flash round-trips through a URL: encoding must cover everything a
    /// daemon error message can contain, and the length cap must hold.
    #[test]
    fn urlencode_is_query_safe_and_capped() {
        assert_eq!(
            urlencode("started (4 slot(s))"),
            "started%20%284%20slot%28s%29%29"
        );
        assert_eq!(urlencode("a&b=c?d#e"), "a%26b%3Dc%3Fd%23e");
        assert_eq!(urlencode("naïve"), "na%C3%AFve");
        assert_eq!(urlencode(&"x".repeat(1000)).len(), 300, "capped");
    }

    /// The one Edit refusal that carries an action the user can take, end to
    /// end: from the domain that writes it to the copy the page shows.
    ///
    /// The refusal is TAKEN FROM `StageEdit::apply`, never typed here. The
    /// classifier matches on this workspace's own wording ("player block"),
    /// so a reword upstream has to fail this test rather than quietly demote a
    /// four-player user back to "Reopen ksx and try again" - which is what
    /// shipped, and what made the third controller on a four-player panel
    /// look like a broken app instead of a menu with a better answer in it.
    #[test]
    fn a_layout_with_no_block_for_this_player_says_so_instead_of_try_again() {
        let setup = ksx_api::StageEdit::ChooseDevice {
            selector: "usb:d209:0430:00".to_owned(),
            alias: "panel".to_owned(),
            label: "Ultimarc I-PAC 4".to_owned(),
        }
        .apply(&ksx_core::stage::StagedSetup::new())
        .expect("staging the panel");

        let refusal = ksx_api::StageEdit::AddSlot {
            number: Some(3),
            persona: "xbox360".to_owned(),
            preset: "Player 3".to_owned(),
            layout: Some("keyboard-2p".to_owned()),
        }
        .apply(&setup)
        .expect_err("a two-block layout has nothing for player 3");

        assert!(
            refusal.message.contains("player block"),
            "the classifier keys off this wording: {}",
            refusal.message
        );
        assert_eq!(
            start_action_flash(StartAction::Edit, &Err(refusal.message.clone())),
            START_EDIT_NO_PLAYER_BLOCK,
        );
        // And it still survives the query-string round trip, which is the only
        // way a flash ever reaches the page.
        assert_eq!(
            start_flash_from_query(Some(START_EDIT_NO_PLAYER_BLOCK)).as_deref(),
            Some(START_EDIT_NO_PLAYER_BLOCK)
        );
    }
    #[test]
    fn start_action_feedback_never_reflects_provider_or_query_text() {
        let raw = r#"daemon pipe refused --preset C:\Users\TestUser\.ksx\claim.toml"#;
        let edit = Err(raw.to_owned());
        assert_eq!(
            start_action_flash(StartAction::Edit, &edit),
            START_EDIT_ERROR
        );
        let play = Err("a session is already running in the daemon".to_owned());
        assert_eq!(
            start_action_flash(StartAction::Play, &play),
            START_PLAY_ACTIVE
        );
        let incomplete = Err("slot 1 has no controls mapped".to_owned());
        assert_eq!(
            start_action_flash(StartAction::Play, &incomplete),
            START_PLAY_NOT_READY
        );

        assert_eq!(
            start_flash_from_query(Some(raw)).as_deref(),
            Some(START_UNKNOWN_FLASH_ERROR)
        );
        assert_eq!(
            start_flash_from_query(Some(START_SAVE_OK)).as_deref(),
            Some(START_SAVE_OK)
        );

        for safe in START_FLASH_ALLOWLIST {
            let lower = safe.to_ascii_lowercase();
            for forbidden in ["daemon", "pipe", "--", r"c:\", "preset", "claim"] {
                assert!(
                    !lower.contains(forbidden),
                    "customer action feedback exposed {forbidden:?}: {safe}"
                );
            }
        }
    }

    #[test]
    fn start_redirect_location_contains_only_presented_copy() {
        let raw = r#"daemon pipe at C:\Users\TestUser\.ksx refused `ksx daemon`"#;
        let response = start_redirect(StartAction::Play, Err(raw.to_owned()));
        let location = response
            .headers()
            .get(header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .expect("start redirect location");
        assert!(location.starts_with("/start?flash=error"), "{location}");
        for leaked in ["daemon", "pipe", "TestUser", "preset", "claim"] {
            assert!(!location.contains(leaked), "{leaked} leaked: {location}");
        }
    }

    #[test]
    fn map_feedback_never_reflects_unmodeled_provider_text() {
        let fallback = "That change could not be completed. Nothing changed.";
        for hostile in [
            r"C:\Users\TestUser\secret",
            r"HID\VID_D209&PID_0430",
            r"HKLM\SYSTEM\CurrentControlSet",
            "expected a sequence at line 4 column 9",
            r#"{"verb":"map","key":"A"}"#,
        ] {
            assert_eq!(consumer_map_detail(hostile, fallback), fallback);
        }
    }
}
