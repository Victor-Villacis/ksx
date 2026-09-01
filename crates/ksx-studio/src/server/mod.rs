//! The blocking axum server around the render seam.
//!
//! GET /redesign renders the product workbench as SSR plus island props; GET
//! /api/redesign serves its same-origin poll payload. The retired `/nocturne`
//! bookmark redirects to it; `/` stays unclaimed and the legacy API and write
//! routes do not exist. GET /api/health is the small, product-independent
//! contract used by launchers and managed environment gates.
//! Every mutating route is still same-origin guarded and plain HTML forms
//! remain the baseline (`form-action 'self'`).
//!
//! Three tool pages sit beside it: /check (the button check), /pads (the
//! ViGEm bus) and /devices (the picker). `/`, `/map`, `/start`, `/setup`,
//! `/profiles` and `/workspace` were deleted in the 2026-08-25 cutover and
//! now 404; so did `/api/status`, `/api/map`, `/api/setup`, `/api/profiles`
//! and `/api/workspace`.
//!
//! v15 adds `/pads`, and it takes its facts from a THIRD provider:
//! [`ksx_api::MachineSource`], beside the existing status and control ones.
//! Neither of those could answer it — `StatusSource` reads the config store
//! and `ControlSource` the daemon pipe, and a ViGEm bus is neither. Its two
//! verbs keep the CLI's consent shape rather than inventing one: a spawn is
//! bounded (it unplugs itself, because a page has no Ctrl+C) and a prune is a
//! DRY RUN unless the form carries `confirm=yes`.
//!
//! The product's mapper forms are form-encoded twins of the JSON verbs and call
//! the identical [`ControlSource`] methods. With JavaScript the island
//! intercepts them and reports through its toast stack; without JavaScript the
//! essential selection and lifecycle forms still submit to `/redesign`.

// ── Live pages plus route-neutral product operations ───────────────────
//
// The three tool modules and `redesign` own URLs. `workbench` owns shared
// device, capture, controller, mapper and lifecycle operations so the product
// route does not grow a second opinion about a backend act.
//
// Each child reaches the shared plumbing kept here: `AppState`, `flash_of`,
// `act` and `urlencode`. The router names only the four live surfaces plus the
// narrow retired-bookmark redirect.

mod check;
mod devices;
mod health;
mod pads;
mod redesign;
mod session;
mod workbench;

use check::*;
use devices::*;
use health::*;
use pads::*;
use redesign::*;

use std::net::SocketAddr;

use std::sync::Arc;

use axum::extract::{Form, Query, State};

use axum::http::{header, HeaderValue, StatusCode};

use axum::response::{IntoResponse, Redirect, Response};

use axum::routing::{get, post};

use axum::Router;

use serde::Deserialize;

use crate::control::{BindOutcome, ControlSource, SessionView};

use crate::error::StudioError;

use crate::render::{Assets, BrandAssets, LivePage};

use crate::render_check::render_check;

use crate::render_devices::render_devices;

use crate::render_redesign::render_redesign;

use crate::snapshot::{
    CheckPayload, DevicesPayload, PadsPayload, RedesignPayload, StatusSource, StudioHealthPayload,
    StudioHealthSetup, StudioHealthStaged,
};

struct AppState {
    check_page: LivePage,
    pads_page: LivePage,
    devices_page: LivePage,
    /// The transplant lane's blank workbench (see render_redesign.rs).
    redesign_page: LivePage,
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
    /// The redesign workbench's PARKED controllers ("No player"), keyed by
    /// the browser's ghost id: each entry is the removed slot's full view —
    /// authoring included — so re-slotting restores its bindings, the same
    /// resurrection material the rack's undo holds. Its OWN store, not the
    /// undo's one-deep stash: several boards park at once, and a removal must
    /// not evict a parked workbench controller. In-memory like the undo — a
    /// daemon restart forgets parks,
    /// and the page says so on the ghost (`server/redesign.rs`).
    redesign_parked: std::sync::Mutex<Vec<(String, ksx_api::StagedSlotView)>>,
    /// The redesign workbench's own removal-undo stash — the same
    /// server-held six-second window used by the controller rack.
    redesign_undo: std::sync::Mutex<Option<workbench::RemovedSlotUndo>>,
    /// The browser attempt and exact learner generation currently owned by
    /// the redesign identify-by-key transaction. Both parts are load-bearing:
    /// the generation qualifies the daemon cancel, while the browser nonce
    /// prevents a delayed Cancel from an older tab taking a newer tab's
    /// generation. The identify worker changes the lease to `Resolving` after
    /// a non-Escape hit wins, making "cancelled" and "selected" mutually
    /// exclusive outcomes at one server-owned boundary.
    redesign_identify: std::sync::Mutex<RedesignIdentifyRegistry>,
    /// Supplies an opaque owner for a no-JS identify submit. Enhanced clients
    /// provide their own nonce; the static form cannot, and must still never
    /// share a cancellable identity with a later request.
    redesign_identify_sequence: std::sync::atomic::AtomicU64,
    /// The machine-read cache: the poller asks every 2 s, but a USB tree
    /// enumeration and three TOML parses per poll is work the machine did
    /// not ask for. TTL-bounded, invalidated by every mutating request and
    /// by Rescan's `fresh=1` — so nothing the studio itself changed can
    /// ever be served stale.
    machine_cache: MachineCache,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum RedesignIdentifyLease {
    /// The HTTP start verb has reserved this browser attempt, before the
    /// blocking daemon call can be scheduled.
    Pending { attempt: String },
    /// The daemon learner has returned the exact generation this attempt owns.
    Active { attempt: String, generation: u64 },
    /// A hit has won the cancellation boundary and is being resolved/staged.
    /// Keeping this terminal owner visible prevents a late Cancel from being
    /// reported as "nothing changed" while the blocking worker can still
    /// commit the exact device.
    Resolving { attempt: String, generation: u64 },
    /// Cancel reached a Pending reservation while its blocking worker was
    /// about to open the daemon learner. The worker consumes this marker and
    /// exact-cancels any generation that appeared in the meantime.
    Cancelled { attempt: String },
}

#[derive(Debug, Default)]
struct RedesignIdentifyRegistry {
    lease: Option<RedesignIdentifyLease>,
    /// Cancel HTTP can overtake Start for more than one tab. Preserve each
    /// nonce independently; a single tombstone lets cancel B overwrite cancel
    /// A and allows A's delayed start to open invisibly. This queue is bounded
    /// because same-origin callers can abandon requests forever.
    pre_cancelled: std::collections::VecDeque<String>,
}

impl RedesignIdentifyRegistry {
    const PRE_CANCELLED_LIMIT: usize = 64;

    fn remember_pre_cancelled(&mut self, attempt: String) {
        if let Some(index) = self
            .pre_cancelled
            .iter()
            .position(|saved| saved == &attempt)
        {
            self.pre_cancelled.remove(index);
        }
        self.pre_cancelled.push_back(attempt);
        while self.pre_cancelled.len() > Self::PRE_CANCELLED_LIMIT {
            self.pre_cancelled.pop_front();
        }
    }

    fn take_pre_cancelled(&mut self, attempt: &str) -> bool {
        let Some(index) = self.pre_cancelled.iter().position(|saved| saved == attempt) else {
            return false;
        };
        self.pre_cancelled.remove(index);
        true
    }
}

/// A TTL cache over the machine reads the redesign poll repeats: the device
/// scan (a Config-Manager walk of the USB tree) and setup state. NOT a
/// `MachineSource` wrapper on
/// purpose — a trait impl would let a forgotten forward silently answer
/// with a trait default (the SharedControl lesson); collectors opt in per
/// call instead.
struct MachineCache {
    scan: std::sync::Mutex<
        Option<(
            std::time::Instant,
            Result<ksx_api::DeviceScanView, ksx_api::Refusal>,
        )>,
    >,
    setup: std::sync::Mutex<
        Option<(
            std::time::Instant,
            Result<ksx_api::SetupView, ksx_api::Refusal>,
        )>,
    >,
}

/// Long enough to skip most polls, short enough that an EXTERNAL change
/// (a device plugged, a file edited by hand) paints within a breath — and
/// Rescan busts it outright.
const MACHINE_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(10);

impl MachineCache {
    fn new() -> Self {
        Self {
            scan: std::sync::Mutex::new(None),
            setup: std::sync::Mutex::new(None),
        }
    }

    fn invalidate(&self) {
        *self.scan.lock().unwrap() = None;
        *self.setup.lock().unwrap() = None;
    }

    fn fetch<T: Clone>(
        slot: &std::sync::Mutex<Option<(std::time::Instant, Result<T, ksx_api::Refusal>)>>,
        read: impl FnOnce() -> Result<T, ksx_api::Refusal>,
    ) -> Result<T, ksx_api::Refusal> {
        let mut held = slot.lock().unwrap();
        if let Some((at, value)) = held.as_ref() {
            if at.elapsed() < MACHINE_CACHE_TTL {
                return value.clone();
            }
        }
        let fresh = read();
        *held = Some((std::time::Instant::now(), fresh.clone()));
        fresh
    }

    fn device_scan(
        &self,
        machine: &dyn ksx_api::MachineSource,
    ) -> Result<ksx_api::DeviceScanView, ksx_api::Refusal> {
        Self::fetch(&self.scan, || machine.device_scan())
    }

    fn setup_state(
        &self,
        machine: &dyn ksx_api::MachineSource,
    ) -> Result<ksx_api::SetupView, ksx_api::Refusal> {
        Self::fetch(&self.setup, || machine.setup_state())
    }
}

/// Harmless context an old product bookmark may carry into the redesigned
/// workbench. Flash text is intentionally absent: it is server-authored status,
/// not durable navigation state, and reflecting an arbitrary old query would
/// reopen the injection class the flash allowlist closes.
#[derive(Default, Deserialize)]
struct RetiredNocturneQuery {
    slot: Option<u8>,
    #[serde(rename = "macro")]
    macro_name: Option<String>,
    q: Option<String>,
}

async fn retired_nocturne_bookmark(Query(query): Query<RetiredNocturneQuery>) -> Redirect {
    let mut context = Vec::new();
    if let Some(slot) = query
        .slot
        .filter(|slot| (1..=ksx_api::MAX_SLOTS).contains(slot))
    {
        context.push(format!("slot={slot}"));
    }
    for (name, value) in [("macro", query.macro_name), ("q", query.q)] {
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            context.push(format!("{name}={}", urlencode(&value)));
        }
    }
    let target = if context.is_empty() {
        "/redesign".to_owned()
    } else {
        format!("/redesign?{}", context.join("&"))
    };
    Redirect::permanent(&target)
}

/// The theme id to stamp on a page render (`render::with_theme`), or `None`
/// for System.
///
/// Reads the TTL-cached `SetupView` — cheap at navigation rate, and the
/// invalidation layer below busts the cache before every mutating request,
/// so the render a POST /setup/theme redirects to always sees the new
/// choice. A refused machine read (or an unreadable config) is `None`: a
/// page that cannot know the choice renders as System rather than not at
/// all. Every page GET handler calls this; the tests/http.rs stamp oracle
/// is what keeps a new page from forgetting to.
async fn page_theme(state: &Arc<AppState>) -> Option<String> {
    let state = Arc::clone(state);
    tokio::task::spawn_blocking(move || {
        state
            .machine_cache
            .setup_state(&*state.machine)
            .ok()
            .map(|view| view.theme)
            .filter(|theme| !theme.is_empty())
    })
    .await
    .ok()
    .flatten()
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
    let check = LivePage::load("/check")?;
    let pads = LivePage::load("/pads")?;
    let devices = LivePage::load("/devices")?;
    let redesign = LivePage::load("/redesign")?;
    let state = Arc::new(AppState {
        check_page: check,
        pads_page: pads,
        devices_page: devices,
        redesign_page: redesign,
        source,
        control,
        machine,
        live,
        redesign_parked: std::sync::Mutex::new(Vec::new()),
        redesign_undo: std::sync::Mutex::new(None),
        redesign_identify: std::sync::Mutex::new(RedesignIdentifyRegistry::default()),
        redesign_identify_sequence: std::sync::atomic::AtomicU64::new(1),
        machine_cache: MachineCache::new(),
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
            // Stable operational provenance for launchers and managed lanes.
            // It is deliberately independent of both product payloads.
            .route("/api/health", get(api_health))
            // The retired product bookmark is the one compatibility door.
            // It is GET-only and forwards only harmless workbench context;
            // old APIs, downloads and POST verbs are deliberately absent, so
            // a stale form can never replay a mutation after the cutover.
            .route("/nocturne", get(retired_nocturne_bookmark))
            // The mapper (v5): page + poll payload + the learn/bind verbs,
            // each a thin wrapper over one ControlSource method (= one pipe
            // verb — no GUI-only code paths).
            .route("/api/learn", get(workbench::workbench_api_learn_poll))
            .route(
                "/api/learn/start",
                post(workbench::workbench_api_learn_start),
            )
            // **The one read that DOES wear POST, deliberately.** The rule
            // above holds for reads that only read memory. A chart read takes
            // the machine-wide programming lease and opens the board's
            // configuration collection exclusively — it is a hardware
            // transaction with a real exclusion and a real cost, and it must
            // not be reachable by a link, a prefetch, or a page load. The guard
            // policing by method is the point here, not the problem.
            .route(
                "/api/panel/chart",
                post(workbench::workbench_api_panel_chart),
            )
            .route(
                "/api/learn/cancel",
                post(workbench::workbench_api_learn_cancel),
            )
            .route(
                "/api/input-test",
                get(workbench::workbench_api_input_test_poll),
            )
            .route(
                "/api/input-test/start",
                post(workbench::workbench_api_input_test_start),
            )
            .route(
                "/api/input-test/cancel",
                post(workbench::workbench_api_input_test_cancel),
            )
            // v10: write a control's WHOLE key list (many keys → one
            // control). The island computes the new set from the payload it
            // is already polling — add = ∪ {k}, per-key ✕ = ∖ {k} — and posts
            // it here; `bind_keys` is what knows how to spell that on the
            // wire. Not a new daemon verb: today it composes the same `map`
            // the button beside it uses.
            // v11: the macro editor's SAVE — one whole `[macros.<name>]`
            // table per call, through `ControlSource::save_macro` (= the
            // daemon's `map-macro` verb, = the `ksx macro` CLI's writer). No
            // GUI-only path, and no second macro schema: the steps on the wire
            // are the MacroStepView rows the read side already served.
            .route("/api/macro/save", post(workbench::workbench_api_macro_save))
            // v10 — MANY KEYS → ONE CONTROL, without JavaScript. Same row
            // form, same key picker, two more submits: `add` appends the
            // picked key to the control's list, `key/remove` takes just that
            // one off it. Both are read-modify-write on the key SET and land
            // through `ControlSource::bind_keys` — no new daemon verb.
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
            // ── The redesign lane's workbench ────────────────────────────
            .route("/redesign", get(redesign_page))
            .route("/api/redesign", get(api_redesign))
            // Its verbs use the route-neutral workbench core and return to
            // /redesign. They stay in this chain so the origin guard and the machine-cache
            // invalidation layer cover them by construction — and
            // tests/http.rs proves both, once, like every new verb.
            .route("/redesign/theme", post(redesign_form_theme))
            .route("/redesign/device", post(redesign_form_device))
            .route("/redesign/device/remove", post(redesign_form_device_remove))
            .route("/redesign/device/identify", post(redesign_form_identify))
            .route(
                "/redesign/device/identify/cancel",
                post(redesign_form_identify_cancel),
            )
            .route(
                "/redesign/capture/prepare",
                post(redesign_form_capture_prepare),
            )
            .route(
                "/redesign/capture/release",
                post(redesign_form_capture_release),
            )
            .route("/redesign/controller", post(redesign_form_ctrl_add))
            .route(
                "/redesign/controller/remove",
                post(redesign_form_ctrl_remove),
            )
            .route("/redesign/controller/move", post(redesign_form_ctrl_move))
            .route("/redesign/controller/park", post(redesign_form_ctrl_park))
            .route(
                "/redesign/controller/assign",
                post(redesign_form_ctrl_assign),
            )
            .route("/redesign/controller/socd", post(redesign_form_ctrl_socd))
            .route(
                "/redesign/controller/duplicate",
                post(redesign_form_ctrl_duplicate),
            )
            .route("/redesign/controller/undo", post(redesign_form_ctrl_undo))
            .route("/redesign/bind/clear", post(redesign_form_bind_clear))
            .route("/redesign/bind/clear-all", post(redesign_form_clear_all))
            .route("/redesign/bind/turbo", post(redesign_form_bind_turbo))
            .route("/redesign/bind/toggle", post(redesign_form_bind_toggle))
            .route("/redesign/key/clear", post(redesign_form_key_clear))
            .route("/redesign/blocking", post(redesign_form_blocking))
            // The mapper's JSON verbs call the route-neutral workbench core;
            // the body names the slot and no operation reads the route path.
            .route("/redesign/api/bind", post(workbench::workbench_api_bind))
            .route("/redesign/macro/toggle", post(redesign_form_macro_toggle))
            .route("/redesign/macro/new", post(redesign_form_macro_new))
            .route("/redesign/macro/delete", post(redesign_form_macro_delete))
            .route(
                "/redesign/api/macro/edit",
                post(workbench::workbench_api_macro_edit_redesign),
            )
            // Final operational-shell block. Form doors preserve the no-JS
            // 303 contract and land back here; `/api/apply` is the existing
            // structured answer, behind the same revision guard, so a
            // needs-restart client never parses copy.
            .route("/redesign/save", post(redesign_form_save))
            .route("/redesign/play", post(redesign_form_play))
            .route("/redesign/stop", post(redesign_form_stop))
            .route("/redesign/apply", post(redesign_form_apply))
            .route("/redesign/api/apply", post(redesign_api_apply))
            .route("/redesign/adopt", post(redesign_form_adopt))
            .route("/redesign/discard", post(redesign_form_discard))
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
            // ── What used to be five pages ─────────────────────────────
            //
            // Saved games, controller layouts, the configuration verbs, the
            // theme, the first-run staging flow and the mapper all had their
            // own page and their own route block here. The staged core is now
            // only `/redesign`, backed by route-neutral operations in
            // `workbench.rs`. Settings/Library and advanced setup are recorded
            // deferrals, not hidden legacy routes. What follows is the
            // rationale that outlived the deleted pages.
            //
            // **Staging touches no file until Save.** Every staging verb is
            // one `ControlSource` call reaching nothing outside the daemon's
            // own memory — no file, no driver, no session — which is what
            // makes exploring free. That was the whole reason first-run was a
            // separate page from the configuration editor: one screen holding
            // both rules is a screen where the user cannot tell which controls
            // commit. On one page the rule has to be carried by the VERBS, so
            // only the shared Save operation writes staged state, through
            // `/redesign/save`.
            //
            // **The capture routes are the narrow exception** to the browser
            // claim prohibition: an exact served interface, three explicit
            // consents, and the local MachineSource's installed UAC helper.
            // Studio never receives a backend choice or helper output from the
            // browser.
            //
            // **Reads do not wear POST.** `guard.rs` polices by METHOD, and a
            // read wearing POST is a lie the guard then has to work around.
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
            // Native form targets intentionally name only their verb. Carry
            // the selected slot, macro and binding filter through the 303 at
            // one response seam, recovered from an exact same-origin
            // `/redesign` referrer. The middleware can only append encoded
            // fields to a server-authored relative `/redesign` Location; it
            // never accepts a return destination from the browser.
            .layer(axum::middleware::from_fn(
                preserve_redesign_redirect_context,
            ))
            // ONE layer over every route, not a check per handler. The routes
            // above arrived in three separate milestones and the mapper alone
            // contributed eight form endpoints; a guard you have to remember to
            // add to each new one is a guard that will be missing from the
            // ninth. See `crate::guard` for what this refuses and why an
            // absent `Origin` is deliberately allowed through.
            .layer(axum::middleware::from_fn(move |req, next| {
                crate::guard::same_origin(bind, req, next)
            }))
            // Every mutating request drops the machine-read cache BEFORE the
            // handler runs AND AFTER it returns — one layer, not a call per
            // handler (the guard's own rule), so nothing the studio changes
            // is ever served stale. The AFTER half is load-bearing
            // (review-caught): a cache-populating GET can overlap the
            // handler's write and store the PRE-write view with a fresh
            // timestamp, which the before-only wipe could never touch — the
            // redirect after POST /setup/theme would then stamp the old
            // theme for a TTL. `MachineCache::fetch` holds the slot mutex
            // across its read+store, so this second wipe strictly follows
            // any store that overlapped the handler.
            .layer(axum::middleware::from_fn({
                let state = Arc::clone(&state);
                move |req: axum::extract::Request, next: axum::middleware::Next| {
                    let state = Arc::clone(&state);
                    async move {
                        let mutating = req.method() != axum::http::Method::GET;
                        if mutating {
                            state.machine_cache.invalidate();
                        }
                        let response = next.run(req).await;
                        if mutating {
                            state.machine_cache.invalidate();
                        }
                        response
                    }
                }
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
pub(crate) fn urlencode(text: &str) -> String {
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
    // Read only by the null fixtures below; the lib itself no longer names it.
    use crate::snapshot::StatusSnapshot;

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
}
