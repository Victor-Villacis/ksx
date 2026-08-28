//! ksx-studio — the optional Forma-powered local application: one product page
//! that owns first run, mapping, saved games and configuration, plus three
//! tools that diagnose the machine around it.
//!
//! **Four routes serve a page.** `/nocturne` **is** the product — setup,
//! mapping, macros, saved games and the configuration menu are stages and panes
//! *within* it, not a sequence of URLs. `/check`, `/pads` and `/devices` are
//! the tools, each one deliberate action away.
//!
//! This header described eight routes until 2026-08-25, and five of those eight
//! are now **404**: `/`, `/start`, `/map`, `/setup` and `/profiles` were deleted
//! in the single-product-page cutover, as was `/workspace`. The router has no
//! fallback and no redirect, which is a decision and not an omission — a
//! silently redirecting `/start` would let a stale bookmark, a stale doc or a
//! stale launcher keep *looking* correct. It also means a caller that still
//! spells one of them is a live defect rather than a cosmetic one, which is
//! exactly how `ksx open` shipped a chrome-less window on a 404 with no address
//! bar (`ksx-backend/src/studio_launch.rs`, fixed in `ad520b4`; see
//! `docs/SURFACES.md` §6). Grep before you cite a route from prose.
//!
//! Rendering model — SSR first paint + one live island per route:
//! forma-server 0.2.0 renders the embedded FMIR per request (a complete page,
//! no JS required), and each screen's Forma island seeds its signals from
//! server props BEFORE adoption (the islands protocol; dogfood ledger #5).
//! Route clients then use the same-origin APIs and streams to update those
//! signals in place. With JavaScript disabled the server-rendered screens
//! remain usable; every polling page also carries a `<noscript>` meta refresh
//! (`render::body_prefix`, suppressed on `/pads` when a refresh would fight the
//! page). Client bundles load under Forma's strict nonce'd CSP
//! (`connect-src 'self'` covers live data, `form-action 'self'` the forms).
//!
//! **Configuration is a menu on the product page, not a screen of its own.**
//! The two verbs a person performs on a configuration are **Export**
//! (`GET /nocturne/export.json`, the whole root as one JSON document, a
//! download rather than a page) and **Import** (`POST /nocturne/import`, dry
//! run unless the write box is ticked, under an 8 MB body limit that has to be
//! re-stated on the route because it does not travel with the verb). Neither
//! takes a filesystem path: `ksx_api::MachineSource::{config_export,
//! config_import}` work in memory, so no screen has to put a directory in front
//! of someone who asked for their configuration. Both moved here from `/setup`;
//! the routes changed, the reasoning did not.
//!
//! First run is the same story. The checklist is still decided by the BACKEND
//! (`ksx-backend::onboard::plan_steps`, pure and total over three counts) and
//! still has one backend verb per step — but the steps are now stages of
//! `/nocturne` rather than `POST /setup/slot` and `POST /setup/prove`, and the
//! learner behind the proving step is read back per render so it works with
//! scripting switched off. That last property is why the migration is worth
//! watching: a verb that moves onto this page and loses its no-JS path has
//! silently stopped being reachable for the audience the page was built for.
//!
//! Session state and the three POST routes go through [`ControlSource`] —
//! ksx-backend implements it over the daemon's `\\.\pipe\ksx-daemon` control
//! channel, so every button maps to the same `DaemonCommand` the tray
//! enqueues (docs/CONTROL-SURFACE.md: no GUI-only code paths). When no
//! daemon answers the pipe, the controls render visibly disabled with the
//! reason and the way out ("start the daemon — tray or `ksx daemon`").
//! Action outcomes — failures included — come back as a `flash` query
//! parameter after a 303 redirect, rendered escaped; nothing fails silently.
//!
//! # Committed UI artifacts — Node is never required to build or run ksx
//!
//! `assets/` holds the **committed** output of the `studio-ui/` npm project
//! (FMIR module, manifest, CSS, service worker), embedded via `rust-embed`.
//! `cargo build` needs nothing but Rust. The exact Node/npm versions in
//! `.node-version` and `studio-ui/package.json` are needed only to regenerate
//! the UI after editing `studio-ui/src/`. From the repository root run:
//!
//! ```text
//! powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/build-assets.ps1
//! ```
//!
//! # Data injection
//!
//! The same per-request route data is emitted twice, deliberately: server-side
//! FMIR slot injection for the SSR first paint (scalars, lists AND
//! `createShow` booleans, all by slot name since compiler 0.3.1), and a
//! typed JSON payload in the `__ksx-payload` script block for client
//! hydration — the same shape each route's live endpoint returns, pinned by
//! parity tests. forma-ir additionally emits its own
//! `data-forma-props` from the island's slot_ids, carrying the rendered slot
//! values. See `render.rs` for the mechanism, the rationale, and the E7
//! dogfood history — cycle one closed when `@getforma/compiler` 0.2.0
//! shipped per-list naming, cycle two when 0.3.1 shipped named shows,
//! island slot_ids and island-file signal extraction.
//!
//! # Boundaries (docs/ENHANCEMENTS.md E7, enforced)
//!
//! - **Localhost only.** [`serve`] refuses any non-loopback bind; there is no
//!   LAN option. That option arrives with the CSPRNG pairing token, not
//!   before.
//! - **Own tokio runtime, normal priority** — created inside [`serve`], never
//!   shared with (or visible to) anything session- or pipeline-related.
//! - This crate depends on **exactly one other ksx crate: `ksx-api`**, the
//!   typed control API every ksx front end consumes (docs/M9-DECISION.md §6).
//!   Data arrives through its [`StatusSource`] and [`ControlSource`] traits;
//!   ksx-backend supplies the implementations (collectors and pipe client
//!   respectively). Nothing here can touch capture, output, or a live session
//!   — a control implementation is a client of the daemon's pipe, never a
//!   second control loop. `ksx-api` links no axum, no forma and no tokio, so
//!   the default build is unaffected by this crate existing.
//!
//!   The traits used to live HERE, which was wrong in one specific way: a
//!   contract cannot be owned by the surface that happens to have been written
//!   first. `ksx session` performs the same verbs with no HTTP anywhere, and a
//!   native shell would too.

// The mapper's scalar-slot object is one `serde_json::json!` literal per page
// (render_map.rs `scalar_slots`), and that macro recurses once per field. The
// object is deliberately flat and deliberately long — every state on the page
// is a named scalar — so it outgrew the default 128.
#![recursion_limit = "512"]

mod board;
mod control;
mod error;
mod guard;
mod keyboard_layout;
mod live;
mod macro_draft;
mod macro_editor;
mod render;
mod render_check;
mod render_devices;
mod render_map;
mod render_nocturne;
mod render_pads;
mod render_redesign;
mod server;
mod snapshot;
// GENERATED by studio-ui/tokens/build-tokens.mjs (regenerate through
// tools/studio-env/build-assets.ps1); skipped here because an inner
// #![rustfmt::skip] in the file
// itself is unstable (rust #54726). The CI byte-diff is the file's oracle.
#[rustfmt::skip]
mod theme_tokens;

pub use control::{
    BindConflict, BindOutcome, BindRequest, ControlSource, LearnView, MacroOutcome, MacroWrite,
    RestoreMode, SessionView,
};
pub use error::StudioError;
pub use server::serve;
pub use snapshot::{
    CheckPayload, DevicesPayload, MacroSnapshot, MacroStepView, MacroView, MapperSlot,
    MapperSnapshot, PadRow, PadsPayload, ProfileRow, SetupFlags, SetupRows, SetupSnapshot,
    StatusSnapshot, StatusSource,
};
