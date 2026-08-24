//! The daemon's external control channel: `\\.\pipe\ksx-daemon`.
//!
//! One JSON request line in, one JSON response line out, per connection —
//! that is the whole protocol. Verbs: `status`, `start` (optional `profile`),
//! `stop`, `reload`, plus the M7 mapper slice: `map` (edit one preset binding
//! through the same [`crate::mapping::apply`] the CLI verb uses — no
//! pipe-private editor), `learn-key` / `learn-poll` / `learn-cancel` (the
//! asynchronous "press the panel key" recorder, [`super::learn`]), and the
//! bounded `input-test-*` diagnostic. `ksx session`, `ksx input-test`, and
//! Studio are thin clients of this; docs/CONTROL-SURFACE.md carries the
//! request/response examples.
//!
//! # Reach
//!
//! Session verbs have exactly the tray's reach: they enqueue the same
//! [`DaemonCommand`] values and read the same [`DaemonState`] snapshot. Editor
//! verbs delegate to the daemon-owned mapping and observer services. Those
//! observers may briefly own a Raw Input window or panel tap, but start is
//! asynchronous and every attempt is bounded; the pipe still has no path to a
//! factory or time-critical pipeline thread. A wedged pipe client costs other
//! clients their turn on the pipe, never an unbounded keyboard claim.
//!
//! # Trust model
//!
//! The control pipe uses an explicit protected DACL: object owner (the account
//! that launched the daemon), SYSTEM, and Administrators have full control;
//! there is no Users, Authenticated Users or Everyone ACE. That lets a
//! credentialed administrator run the uninstaller for a standard user while
//! an unrelated low-privilege account still gets ERROR_ACCESS_DENIED before
//! ksx sees a request. No caller-supplied token or application auth layer.
//!
//! # Concurrency
//!
//! One server thread serves connections **sequentially**. The next pipe
//! instance is created *before* the current connection is served, so a second
//! client (two Studio processes, a `ksx session` racing a page load) connects
//! and simply waits its turn instead of seeing ERROR_FILE_NOT_FOUND; the
//! client side additionally retries briefly on FILE_NOT_FOUND and
//! ERROR_PIPE_BUSY as belt and braces.

use std::time::{Duration, Instant};

use crossbeam_channel::Sender;

use super::{DaemonCommand, DaemonState, RunState, SharedState};

/// The one well-known name. Tests use throwaway names; everything else uses
/// this. It is defined with the rest of the protocol in `ksx-api`: the name a
/// client dials is as much a part of the contract as the verbs it carries.
pub const PIPE_NAME: &str = ksx_api::PIPE_NAME;

/// The one shutdown rendezvous shared by daemon main and the control-pipe
/// thread.
///
/// A pipe `quit` must not answer from the enqueue point: at that point a live
/// session may still own pads, the panel may still be muted, and the daemon's
/// WinUSB handle may still be open. The handler marks `requested`, sends the
/// ordinary [`DaemonCommand::Quit`], then waits. Daemon main joins the control
/// loop (and the tray pump when present), releases the claim, and only then
/// marks `daemon_stopped`. The server may now answer, close both its current
/// and pre-created next pipe instances, and mark `pipe_closed`; main waits for
/// that last mark before returning from the process.
///
/// Every wait is bounded. Poisoning or timeout is a refusal, never success.
#[derive(Clone, Default)]
pub struct ShutdownHandshake {
    inner: std::sync::Arc<(std::sync::Mutex<ShutdownPhase>, std::sync::Condvar)>,
}

#[derive(Default)]
struct ShutdownPhase {
    requested: bool,
    daemon_stopped: bool,
    pipe_closed: bool,
}

impl ShutdownHandshake {
    fn request(&self) -> bool {
        let (lock, wake) = &*self.inner;
        let Ok(mut phase) = lock.lock() else {
            return false;
        };
        phase.requested = true;
        wake.notify_all();
        true
    }

    fn wait_daemon_stopped(&self, budget: Duration) -> bool {
        self.wait_for(budget, |phase| phase.daemon_stopped)
    }

    fn was_requested(&self) -> bool {
        let (lock, _) = &*self.inner;
        lock.lock().is_ok_and(|phase| phase.requested)
    }

    fn pipe_closed(&self) {
        let (lock, wake) = &*self.inner;
        if let Ok(mut phase) = lock.lock() {
            phase.pipe_closed = true;
            wake.notify_all();
        }
    }

    /// Mark the point after the control loop/tray have joined and the panel
    /// claim has been explicitly released, then (only for a pipe-originated
    /// quit) wait for the response pipe to close.
    pub(crate) fn daemon_stopped_and_wait_for_pipe(&self, budget: Duration) -> bool {
        let Some(requested) = self.mark_daemon_stopped() else {
            return false;
        };
        !requested || self.wait_for(budget, |phase| phase.pipe_closed)
    }

    fn mark_daemon_stopped(&self) -> Option<bool> {
        let (lock, wake) = &*self.inner;
        let mut phase = lock.lock().ok()?;
        phase.daemon_stopped = true;
        let requested = phase.requested;
        wake.notify_all();
        Some(requested)
    }

    fn wait_for(&self, budget: Duration, done: impl Fn(&ShutdownPhase) -> bool) -> bool {
        let (lock, wake) = &*self.inner;
        let Ok(phase) = lock.lock() else {
            return false;
        };
        if done(&phase) {
            return true;
        }
        let Ok((phase, _)) = wake.wait_timeout_while(phase, budget, |phase| !done(phase)) else {
            return false;
        };
        done(&phase)
    }
}

/// `(title, detail)` rows from games.toml, read on demand so `status` reflects
/// what is on disk now — the same freshness rule as `Reload`.
pub type ProfilesFn = Box<dyn Fn() -> Vec<(String, String)> + Send>;

/// The `map` verb's writer — [`crate::mapping::apply`] over the daemon's
/// config root, injected so protocol tests need no disk.
pub type MapFn = Box<
    dyn Fn(&crate::mapping::MapSpec) -> Result<crate::mapping::AppliedMap, crate::mapping::MapError>
        + Send,
>;

/// The `map-macro` verb's writer — [`crate::mapping::save_macro`], same
/// injection rule as [`MapFn`].
pub type MacroFn = Box<
    dyn Fn(
            &crate::mapping::MacroSpec,
        ) -> Result<crate::mapping::AppliedMacro, crate::mapping::MapError>
        + Send,
>;

/// The `map-restore` verb's writer — [`crate::mapping::restore`], same
/// injection rule as [`MapFn`].
pub type RestoreFn = Box<
    dyn Fn(
            &str,
            crate::mapping::RestoreKind,
        ) -> Result<crate::mapping::AppliedRestore, crate::mapping::MapError>
        + Send,
>;

/// The `map-clear-all` verb's writer — [`crate::mapping::clear_all`], same
/// injection rule as [`MapFn`].
pub type ClearAllFn =
    Box<dyn Fn(&str) -> Result<crate::mapping::AppliedRestore, crate::mapping::MapError> + Send>;

/// The `map-backups` verb's reader — [`crate::mapping::list_backups`], same
/// injection rule as [`MapFn`].
pub type BackupsFn =
    Box<dyn Fn(&str) -> Result<Vec<crate::mapping::PresetBackup>, crate::mapping::MapError> + Send>;

/// The `slot-assign` verb's writer — [`crate::slots::assign`], same injection
/// rule as [`MapFn`].
pub type SlotAssignFn = Box<
    dyn Fn(&crate::slots::SlotSpec) -> Result<crate::slots::AppliedSlot, crate::slots::SlotError>
        + Send,
>;

/// The `stage-commit` verb's writer — [`crate::stage::apply`], same injection
/// rule as [`MapFn`].
///
/// It is a `Fn` over the whole [`ksx_core::CommitSpec`] rather than a config
/// root, so the protocol tests exercise every refusal above it with no disk at
/// all — and so the ONE act that turns a staged setup into files is visible in
/// this list beside the other writers, instead of hidden inside a handler.
pub type StageCommitFn = Box<
    dyn Fn(&ksx_core::CommitSpec) -> Result<crate::stage::Committed, ksx_config::ConfigError>
        + Send,
>;

/// Live driver/device readiness, injected so protocol tests never construct a
/// capture context or enumerate hardware.  Both staged exits call it before a
/// writer or queue send is reachable.
pub type StageCapturePreflightFn =
    Box<dyn Fn(&ksx_core::CommitSpec) -> Result<(), ksx_api::Refusal> + Send>;

/// The reverse of [`StageCommitFn`]: build a stage from the saved
/// configuration (`stage-adopt`). A READ — it takes a profile title and
/// returns the setup or the refusal, and touches no daemon state itself, so
/// protocol tests exercise the empty-stage guard above it with no disk.
pub type StageAdoptFn =
    Box<dyn Fn(Option<&str>) -> Result<ksx_core::StagedSetup, ksx_api::Refusal> + Send>;

/// Everything a pipe request can reach. One struct so the transport, the
/// tests and future verbs share a single wiring point.
pub struct PipeDeps {
    pub tx: Sender<DaemonCommand>,
    pub state: SharedState,
    pub profiles: ProfilesFn,
    pub map: MapFn,
    /// The whole-macro writer (`map-macro`).
    pub save_macro: MacroFn,
    pub restore: RestoreFn,
    pub clear_all: ClearAllFn,
    pub backups: BackupsFn,
    /// The one verb here that is not a preset write: which preset a slot uses
    /// (`slot-assign`, docs/CONTROL-SURFACE.md honest gaps 1 and 5).
    pub slot_assign: SlotAssignFn,
    /// The ONE act that turns the staged setup into files (`stage-commit`).
    /// Everything else about staging is memory (docs/FIRST-RUN.md §2).
    pub stage_commit: StageCommitFn,
    /// Its reverse (`stage-adopt`): the saved configuration read into a fresh
    /// stage, so the everyday screen can show what this machine already has.
    pub stage_adopt: StageAdoptFn,
    pub stage_capture_preflight: StageCapturePreflightFn,
    pub learn: super::learn::LearnService,
    pub input_test: super::input_test::InputTestService,
}

/// The real [`MapFn`] and [`MacroFn`]: [`crate::mapping::apply`] and
/// [`crate::mapping::save_macro`] against `root`'s store, both behind the
/// session-backup hook — before this daemon lifetime's FIRST write to a
/// preset, the current file is snapshotted to `<file>.session-bak`, which is
/// exactly what `map-restore session-backup` ("undo this session") restores.
/// Once per (daemon lifetime × preset).
///
/// The two are built TOGETHER, and that is the point: they share ONE
/// session-backup set.
///
/// Shared rather than one set each because "the snapshot taken before the
/// FIRST write of this daemon lifetime" has to mean the first write by EITHER
/// of them: a set per writer would let the second one overwrite the undo point
/// with state the user had already changed, and `map-restore session-backup`
/// would then restore a file that was never the starting point.
///
/// The macro writer is otherwise the same shape as the binding writer — a
/// macro body IS a preset write — so neither can drift from the other.
pub fn preset_writers(root: ksx_config::ConfigRoot) -> (MapFn, MacroFn) {
    let backed_up = std::sync::Arc::new(std::sync::Mutex::new(
        std::collections::BTreeSet::<String>::new(),
    ));
    // Best-effort ordering: the backup is taken before the write so a
    // successful write can always be undone; if the copy itself fails the
    // write proceeds (a missing undo must not block mapping) and restore will
    // say "no session backup".
    let once = |backed_up: std::sync::Arc<std::sync::Mutex<std::collections::BTreeSet<String>>>| {
        move |store: &ksx_config::Store, preset: &str| {
            let mut backed = backed_up.lock().expect("session-backup set poisoned");
            if !backed.contains(preset)
                && crate::mapping::take_session_backup(store, preset).is_ok()
            {
                backed.insert(preset.to_owned());
            }
        }
    };
    let (map_root, macro_root) = (root.clone(), root);
    let (map_once, macro_once) = (once(backed_up.clone()), once(backed_up));
    (
        Box::new(move |spec| {
            let store = ksx_config::Store::new(map_root.clone());
            map_once(&store, &spec.preset);
            crate::mapping::apply(&store, spec)
        }),
        Box::new(move |spec| {
            let store = ksx_config::Store::new(macro_root.clone());
            macro_once(&store, &spec.preset);
            crate::mapping::save_macro(&store, spec)
        }),
    )
}

/// The real [`RestoreFn`]: [`crate::mapping::restore`] against `root`'s store.
pub fn restore_fn(root: ksx_config::ConfigRoot) -> RestoreFn {
    Box::new(move |preset, kind| {
        crate::mapping::restore(&ksx_config::Store::new(root.clone()), preset, kind)
    })
}

/// The real [`ClearAllFn`]: [`crate::mapping::clear_all`] against `root`'s
/// store.
pub fn clear_all_fn(root: ksx_config::ConfigRoot) -> ClearAllFn {
    Box::new(move |preset| crate::mapping::clear_all(&ksx_config::Store::new(root.clone()), preset))
}

/// The real [`BackupsFn`]: [`crate::mapping::list_backups`] against `root`'s
/// store. Read-only — the one mapper verb that never writes.
pub fn backups_fn(root: ksx_config::ConfigRoot) -> BackupsFn {
    Box::new(move |preset| {
        crate::mapping::list_backups(&ksx_config::Store::new(root.clone()), preset)
    })
}

/// The real [`SlotAssignFn`]: [`crate::slots::assign`] against `root`'s store.
///
/// No session-backup hook, unlike the preset writers: this writes `config.toml`
/// or `games.toml`, and the store's own `backup()` already copies the file to
/// `<file>.bak-YYYYMMDD-HHMMSS` before every write. The once-per-lifetime
/// `.session-bak` belongs to presets, where a mapping session makes many small
/// edits and "undo everything since the daemon started" is a thing people want.
/// A slot assignment is one deliberate act.
pub fn slot_assign_fn(root: ksx_config::ConfigRoot) -> SlotAssignFn {
    Box::new(move |spec| crate::slots::assign(&ksx_config::Store::new(root.clone()), spec))
}

/// The real [`StageCommitFn`]: [`crate::stage::apply`] against `root`'s store —
/// presets first, then one config write behind one timestamped backup.
pub fn stage_commit_fn(root: ksx_config::ConfigRoot) -> StageCommitFn {
    Box::new(move |spec| crate::stage::apply(&ksx_config::Store::new(root.clone()), spec))
}

/// The real [`StageAdoptFn`]: [`crate::stage::adopt`] against `root`'s store.
pub fn stage_adopt_fn(root: ksx_config::ConfigRoot) -> StageAdoptFn {
    Box::new(move |profile| crate::stage::adopt(&ksx_config::Store::new(root.clone()), profile))
}

/// games.toml rows for the status response. Unreadable configuration reports
/// itself as a row rather than vanishing — same honesty rule as Studio.
pub fn profile_rows(root: &ksx_config::ConfigRoot) -> Vec<(String, String)> {
    match ksx_config::Store::new(root.clone()).load_games() {
        Ok(loaded) => loaded
            .value
            .games
            .iter()
            .map(|g| {
                let detail = match g.slots.len() {
                    1 => format!("{} — 1 slot", g.path),
                    n => format!("{} — {n} slots", g.path),
                };
                (g.title.clone(), detail)
            })
            .collect(),
        Err(err) => vec![("(games.toml unreadable)".to_owned(), err.to_string())],
    }
}

/// How long an action verb polls the snapshot for the command's outcome
/// before answering "requested". Long enough for pads to plug; short enough
/// that a client is never parked behind a wedged start.
const SETTLE_TIMEOUT: Duration = Duration::from_secs(5);
const SETTLE_POLL: Duration = Duration::from_millis(25);
/// A cancelled Learn answers before its observer finishes destroying the Raw
/// Input window. Let that cleanup tail finish so the next user action does not
/// spuriously bounce; never wait on a generation that is still listening.
const OBSERVER_HANDOFF_GRACE: Duration = Duration::from_millis(250);
/// A request line longer than this is an attack or a bug, not a verb.
const MAX_REQUEST: usize = 64 * 1024;

// ---------------------------------------------------------------------------
// Verb handling — pure with respect to the transport, so the protocol is
// testable without a pipe (and without Windows).
// ---------------------------------------------------------------------------

fn snapshot(state: &SharedState) -> DaemonState {
    state.lock().map(|s| s.clone()).unwrap_or_default()
}

fn run_word(run: &RunState) -> &'static str {
    match run {
        RunState::Stopped => "stopped",
        RunState::Starting => "starting",
        RunState::Running { .. } => "running",
        RunState::Failed { .. } => "failed",
        RunState::Quitting => "quitting",
    }
}

fn status_json(state: &SharedState, profiles: &ProfilesFn) -> serde_json::Value {
    let snap = snapshot(state);
    let (slots, message) = match &snap.run {
        RunState::Running { slots } => (Some(*slots), None),
        RunState::Failed { message } => (None, Some(message.clone())),
        _ => (None, None),
    };
    let rows: Vec<serde_json::Value> = profiles()
        .into_iter()
        .map(|(title, detail)| serde_json::json!({ "title": title, "detail": detail }))
        .collect();
    let active = snap.active.as_ref().map(|active| {
        serde_json::json!({
            "elapsed_ms": u64::try_from(active.started.elapsed().as_millis())
                .unwrap_or(u64::MAX),
            "keyboards": active.facts.keyboards,
            "capture": &active.facts.capture,
            "controllers": &active.facts.controllers,
        })
    });
    serde_json::json!({
        "ok": true,
        "run": run_word(&snap.run),
        "slots": slots,
        "message": message,
        "game": snap.game,
        // What the running (or last) session was built FROM. Only the daemon
        // can answer it — a config session and a staged one are
        // indistinguishable from outside — and `resume` is the verb that acts
        // on it.
        "origin": snap.origin.as_str(),
        "active": active,
        "tooltip": snap.tooltip(),
        "profiles": rows,
        "last": snap.last.as_ref().map(|l| serde_json::json!({
            "stop_code": l.stop_code,
            "message": l.message,
            "exit_code": l.exit_code,
            "reboot_required": l.reboot_required,
            "watchdog_tripped": l.watchdog_tripped,
            "dropped_events": l.dropped_events,
        })),
        "live": snap.live.as_ref().map(|h| serde_json::json!({
            "reboot_required": h.reboot_required,
            "watchdog_tripped": h.watchdog_tripped,
            "dropped_events": h.dropped_events,
        })),
    })
}

fn ok_msg(message: String) -> serde_json::Value {
    serde_json::json!({ "ok": true, "message": message })
}

fn err_msg(error: impl Into<String>) -> serde_json::Value {
    serde_json::json!({ "ok": false, "error": error.into() })
}

fn err_code(code: &'static str, error: impl Into<String>) -> serde_json::Value {
    serde_json::json!({ "ok": false, "code": code, "error": error.into() })
}

/// Poll the snapshot until a start (or reload) settles. `baseline` is the run
/// state from before the command was enqueued: a `Failed` identical to the
/// baseline is old news unless `Starting` was seen in between.
fn await_start(state: &SharedState, baseline: &RunState, settle: Duration) -> serde_json::Value {
    let deadline = Instant::now() + settle;
    let mut saw_starting = false;
    loop {
        let snap = snapshot(state);
        match &snap.run {
            // A reload's baseline is already Running: the OLD session must
            // not be reported as the new one, so Running only settles once
            // the state has visibly moved off the baseline.
            RunState::Running { slots } if saw_starting || snap.run != *baseline => {
                return ok_msg(format!("running ({slots} slot(s))"));
            }
            RunState::Starting => saw_starting = true,
            RunState::Failed { message } if saw_starting || snap.run != *baseline => {
                return err_msg(message.clone());
            }
            RunState::Stopped if saw_starting => {
                return err_msg("the session ended as soon as it started");
            }
            RunState::Quitting => return err_msg("the daemon is shutting down"),
            _ => {}
        }
        if Instant::now() >= deadline {
            return ok_msg(
                "requested; the daemon has not reported a new state yet — \
                 check `ksx session status`"
                    .to_owned(),
            );
        }
        std::thread::sleep(SETTLE_POLL);
    }
}

fn await_stop(state: &SharedState, settle: Duration) -> serde_json::Value {
    let deadline = Instant::now() + settle;
    loop {
        let snap = snapshot(state);
        match &snap.run {
            RunState::Stopped => return ok_msg("stopped".to_owned()),
            // The session is over either way; a nonzero summary is its
            // verdict, not a failure of the stop.
            RunState::Failed { message } => return ok_msg(format!("stopped ({message})")),
            RunState::Quitting => return err_msg("the daemon is shutting down"),
            _ => {}
        }
        if Instant::now() >= deadline {
            return ok_msg(
                "stop requested; the session has not reported ending yet — \
                 check `ksx session status`"
                    .to_owned(),
            );
        }
        std::thread::sleep(SETTLE_POLL);
    }
}

/// One request line → one response value. Everything the pipe can do, with
/// the transport factored out.
pub fn handle_request(line: &str, deps: &PipeDeps, settle: Duration) -> serde_json::Value {
    handle_request_with_shutdown(line, deps, settle, None)
}

/// [`handle_request`] with the process-owned shutdown rendezvous present.
/// Only the real control-pipe server supplies one; an in-process adapter has
/// no process boundary to close and therefore must not claim it completed a
/// daemon shutdown.
fn handle_request_with_shutdown(
    line: &str,
    deps: &PipeDeps,
    settle: Duration,
    shutdown: Option<&ShutdownHandshake>,
) -> serde_json::Value {
    let tx = &deps.tx;
    let state = &deps.state;
    let request: serde_json::Value = match serde_json::from_str(line.trim()) {
        Ok(value) => value,
        Err(err) => return err_msg(format!("request is not a JSON object: {err}")),
    };
    let Some(verb) = request.get("verb").and_then(|v| v.as_str()) else {
        return err_msg(
            r#"request has no "verb" (status | start | stop | resume | reload | quit | map | map-macro | map-restore | map-clear-all | map-backups | slot-assign | stage | stage-edit | stage-bind | stage-macro | stage-commit | stage-play | stage-apply | learn-key | learn-poll | learn-cancel | input-test-start | input-test-poll | input-test-cancel)"#,
        );
    };
    match verb {
        "status" => status_json(state, &deps.profiles),
        "start" => {
            if !deps
                .input_test
                .wait_for_terminal_observer_release(OBSERVER_HANDOFF_GRACE)
            {
                return err_code(
                    "observer-busy",
                    "Play cannot start while the simultaneous-input test is listening or releasing; stop the test first",
                );
            }
            let profile = request
                .get("profile")
                .and_then(|p| p.as_str())
                .filter(|p| !p.trim().is_empty())
                .map(str::to_owned);
            start_from_disk(deps, profile, settle)
        }
        // **Put back what `stop` stopped.** Not `start` with an argument: see
        // [`handle_resume`], and `ksx_api::ControlSource::resume`.
        "resume" => {
            if !deps
                .input_test
                .wait_for_terminal_observer_release(OBSERVER_HANDOFF_GRACE)
            {
                return err_code(
                    "observer-busy",
                    "Play cannot resume while the simultaneous-input test is listening or releasing; stop the test first",
                );
            }
            handle_resume(deps, settle)
        }
        "stop" => {
            let baseline = snapshot(state).run;
            if !matches!(baseline, RunState::Running { .. } | RunState::Starting) {
                return err_msg("not running");
            }
            if tx.send(DaemonCommand::Stop).is_err() {
                return err_msg("the daemon is shutting down");
            }
            await_stop(state, settle)
        }
        "reload" => {
            if !deps
                .input_test
                .wait_for_terminal_observer_release(OBSERVER_HANDOFF_GRACE)
            {
                return err_code(
                    "observer-busy",
                    "Play cannot reload while the simultaneous-input test is listening or releasing; stop the test first",
                );
            }
            let baseline = snapshot(state).run;
            if tx.send(DaemonCommand::Reload).is_err() {
                return err_msg("the daemon is shutting down");
            }
            await_start(state, &baseline, settle)
        }
        "quit" => {
            if request.as_object().is_none_or(|fields| fields.len() != 1) {
                return err_code(
                    "bad-request",
                    "quit accepts no fields other than its fixed verb",
                );
            }
            let Some(shutdown) = shutdown else {
                return err_code(
                    "shutdown-unavailable",
                    "quit is available only through the daemon's owned control pipe",
                );
            };
            if !shutdown.request() {
                return err_code(
                    "shutdown-handshake-failed",
                    "the daemon shutdown handshake could not be locked",
                );
            }
            if tx.send(DaemonCommand::Quit).is_err() {
                return err_code(
                    "daemon-shutting-down",
                    "the daemon is already shutting down",
                );
            }
            if !shutdown.wait_daemon_stopped(settle) {
                return err_code(
                    "shutdown-timeout",
                    "the daemon did not finish stopping within the shutdown budget",
                );
            }
            ok_msg("daemon stopped".to_owned())
        }
        "map" => handle_map(&request, deps, settle),
        "map-macro" => handle_map_macro(&request, deps, settle),
        "map-restore" => handle_map_restore(&request, deps, settle),
        "map-clear-all" => handle_map_clear_all(&request, deps, settle),
        "map-backups" => handle_map_backups(&request, deps),
        "slot-assign" => handle_slot_assign(&request, deps, settle),
        // The staged setup (docs/FIRST-RUN.md §2). `stage` and `stage-edit`
        // touch one value in the daemon's own state and NOTHING else — no
        // file, no driver, no session — which is what makes exploring free.
        "stage" => stage_view(&deps.state),
        "stage-edit" => handle_stage_edit(&request, deps),
        "stage-bind" => handle_stage_bind(&request, &deps.state),
        "stage-macro" => handle_stage_macro(&request, &deps.state),
        "stage-commit" => handle_stage_commit(deps),
        "stage-play" => {
            if !deps
                .input_test
                .wait_for_terminal_observer_release(OBSERVER_HANDOFF_GRACE)
            {
                return err_code(
                    "observer-busy",
                    "Play cannot start while the simultaneous-input test is listening or releasing; stop the test first",
                );
            }
            handle_stage_play(deps, settle)
        }
        "stage-apply" => handle_stage_apply(deps, settle),
        "stage-adopt" => handle_stage_adopt(&request, deps),
        // Learn needs an IDLE daemon, and this refusal is deliberate — it was
        // re-examined in full on 2026-08-05 and kept.
        //
        // The mechanical reason USED to be that a running session's bound
        // keyboards are captured below win32k, so a Raw Input observer never
        // saw them. That reason is gone: `daemon::observe` listens on the
        // claim as well, and a claimed panel keeps producing events while a
        // session runs. Reasons 2-4 below are why the refusal stays anyway —
        // they were always the load-bearing ones, and they are about what
        // learning mid-session would DO, not about what it could hear.
        //
        // The reason we did NOT "fix" it by tapping our own capture stream —
        // which we demonstrably could, since the pipeline is holding those very
        // keystrokes — is worth writing down, because it looks like an obvious
        // win from the outside:
        //
        //   1. the capture thread is the one thread on this machine where a bug
        //      freezes every keyboard until reboot. It is time-critical,
        //      allocation-free and lock-free ON PURPOSE. A convenience feature
        //      does not get a code path in it;
        //   2. a key pressed to be LEARNED would also fire its current binding,
        //      on every slot it fans out to — mapping would inject real
        //      gameplay input into whatever is running;
        //   3. rebinding a key while it is physically held could leave a
        //      virtual button pressed under the old binding and released under
        //      the new one: exactly the stuck-key class the engine's
        //      all-keys-up rule and `swap_tables`' release-on-swap exist to
        //      prevent;
        //   4. mapping is a between-games activity in every tool in the field
        //      study (MAME's TAB menu pauses the machine, RetroArch binds from
        //      its menu). Nobody remaps mid-fight.
        //
        // So the refusal stays — and Studio turns it into one click ("Pause
        // emulation & map", then "Resume emulation") instead of a dead end.
        // docs/CONTROL-SURFACE.md "learn-key semantics".
        "learn-key" => {
            if matches!(
                snapshot(state).run,
                RunState::Running { .. } | RunState::Starting
            ) {
                return err_msg(
                    "learn-key is unavailable while a session is running — the key you \
                     press to bind would also fire its current binding; stop the session first \
                     (`ksx session stop`, or Studio's \"Pause emulation & map\"), \
                     or bind directly with `ksx map`",
                );
            }
            if !deps
                .input_test
                .wait_for_terminal_observer_release(OBSERVER_HANDOFF_GRACE)
            {
                return err_code(
                    "observer-busy",
                    "learn-key is unavailable while the simultaneous-input test is listening or releasing; stop that test first",
                );
            }
            deps.learn.start()
        }
        "learn-poll" => deps.learn.poll(),
        "learn-cancel" => {
            let generation = match request.get("generation") {
                None => None,
                Some(value) => match value.as_u64() {
                    Some(value) => Some(value),
                    None => {
                        return err_code(
                            "bad-request",
                            "learn-cancel generation must be an unsigned integer",
                        )
                    }
                },
            };
            deps.learn.cancel(generation)
        }
        "input-test-start" => {
            if matches!(
                snapshot(state).run,
                RunState::Running { .. } | RunState::Starting
            ) {
                return err_code(
                    "session-running",
                    "the simultaneous-input test is unavailable while Play is running or starting; stop the session first",
                );
            }
            if !deps
                .learn
                .wait_for_terminal_observer_release(OBSERVER_HANDOFF_GRACE)
            {
                return err_code(
                    "observer-busy",
                    "the simultaneous-input test is unavailable while Learn is listening or releasing; cancel Learn first",
                );
            }
            if !deps
                .input_test
                .wait_for_terminal_observer_release(OBSERVER_HANDOFF_GRACE)
            {
                return err_code(
                    "observer-busy",
                    "the previous simultaneous-input test is still listening or releasing; cancel it and try again",
                );
            }
            let Some(fields) = request.as_object() else {
                return err_code("bad-request", "input-test-start must be a JSON object");
            };
            if fields
                .keys()
                .any(|field| !matches!(field.as_str(), "verb" | "selector" | "duration_ms"))
            {
                return err_code(
                    "bad-request",
                    "input-test-start accepts only selector and duration_ms",
                );
            }
            let spec = match serde_json::from_value::<ksx_api::Request>(request.clone()) {
                Ok(ksx_api::Request::InputTestStart(spec)) => spec,
                Ok(_) => unreachable!("the fixed verb was checked above"),
                Err(err) => {
                    return err_code(
                        "bad-request",
                        format!("input-test-start could not be read: {err}"),
                    )
                }
            };
            deps.input_test.start(spec)
        }
        "input-test-poll" => {
            if request.as_object().is_none_or(|fields| fields.len() != 1) {
                return err_code(
                    "bad-request",
                    "input-test-poll accepts no fields other than its fixed verb",
                );
            }
            deps.input_test.poll()
        }
        "input-test-cancel" => {
            let Some(fields) = request.as_object() else {
                return err_code("bad-request", "input-test-cancel must be a JSON object");
            };
            if fields
                .keys()
                .any(|field| !matches!(field.as_str(), "verb" | "generation"))
            {
                return err_code("bad-request", "input-test-cancel accepts only generation");
            }
            let generation = match request.get("generation") {
                None => None,
                Some(value) => match value.as_u64() {
                    Some(value) => Some(value),
                    None => {
                        return err_code(
                            "bad-request",
                            "input-test-cancel generation must be an unsigned integer",
                        )
                    }
                },
            };
            deps.input_test.cancel(generation)
        }
        other => err_msg(format!(
            "unknown verb '{other}' (status | start | stop | reload | quit | map | map-macro | \
             map-restore | map-clear-all | map-backups | slot-assign | stage | stage-edit | \
             stage-commit | stage-play | stage-apply | learn-key | learn-poll | learn-cancel | \
             input-test-start | input-test-poll | input-test-cancel)"
        )),
    }
}

/// The pipe `map-clear-all` verb: `{"verb":"map-clear-all","preset":…}` plus
/// the same optional `"reload"` as `map`. Unbinds every function of one preset
/// (leaving each one listed and inert), after taking a timestamped backup —
/// so the most destructive mapper button is still one click from undone.
fn handle_map_clear_all(
    request: &serde_json::Value,
    deps: &PipeDeps,
    settle: Duration,
) -> serde_json::Value {
    let Some(preset) = request
        .get("preset")
        .and_then(|v| v.as_str())
        .filter(|v| !v.trim().is_empty())
    else {
        return err_msg(r#"map-clear-all needs a "preset""#);
    };
    match (deps.clear_all)(preset) {
        Ok(applied) => {
            let mut message = applied.message();
            let outcome = apply_after_write(request, deps, settle, &mut message);
            serde_json::json!({
                "ok": true,
                "message": message,
                "path": applied.path.display().to_string(),
                "preset": applied.preset,
                "mode": applied.kind.as_str(),
                "wrote": applied.kind.destination(),
                "backup": applied.backup.as_ref().map(|b| serde_json::json!({
                    "stamp": b.stamp,
                    "label": b.label(),
                    "path": b.path.display().to_string(),
                })),
                "reloaded": outcome.reloaded,
                "hot_swap": outcome.hot,
            })
        }
        Err(err) => err_msg(err.to_string()),
    }
}

/// The pipe `map-backups` verb: `{"verb":"map-backups","preset":…}` → the
/// timestamped restore points on disk, newest first. Read-only, so it never
/// touches the session and never reports a reload.
fn handle_map_backups(request: &serde_json::Value, deps: &PipeDeps) -> serde_json::Value {
    let Some(preset) = request
        .get("preset")
        .and_then(|v| v.as_str())
        .filter(|v| !v.trim().is_empty())
    else {
        return err_msg(r#"map-backups needs a "preset""#);
    };
    match (deps.backups)(preset) {
        Ok(backups) => serde_json::json!({
            "ok": true,
            "preset": preset,
            "backups": backups.iter().map(|b| serde_json::json!({
                "stamp": b.stamp,
                "label": b.label(),
                "path": b.path.display().to_string(),
            })).collect::<Vec<_>>(),
        }),
        Err(err) => err_msg(err.to_string()),
    }
}

/// The pipe `map` verb: same fields as `ksx map` — including `"keys":
/// ["S","Enter"]`, the whole key list for one control (`"key"` is its one-key
/// spelling; exactly one of the two) — plus `"reload": true` to
/// bounce a RUNNING session onto the new binding (a clean `Reload` — stop,
/// re-read from disk, start — never a hot-patch; the CONTROL-SURFACE
/// invariant). With nothing running there is nothing to bounce: the next
/// start reads the file.
fn handle_map(request: &serde_json::Value, deps: &PipeDeps, settle: Duration) -> serde_json::Value {
    // ONE reader, shared with every client (`ksx_api::MapRequest`): which
    // combinations of "key" / "keys" / "clear" are legal, and what each field
    // is called, is answered in the crate both sides link — so a caller can be
    // refused before a round trip, in these exact words, and a field added to
    // the verb cannot reach only one side of it.
    let spec = match ksx_api::MapRequest::from_json(request) {
        Ok(map) => crate::mapping::MapSpec {
            preset: map.preset,
            function: map.function,
            key: map.key,
            keys: map.keys,
            // "force" is now ONLY about a cross-slot duplicate (another slot's
            // preset in a profile that uses this one). It removes nothing: a key
            // already used by another control of THIS preset is a multi-bind and
            // needs no flag at all (docs/INPUT-TRANSFORMS.md §1a).
            force: map.force,
            // "move_from": "B" — the explicit move, the one way this verb unbinds
            // a function the caller did not name in "function".
            move_from: map.move_from,
            when: map.when,
            unless: map.unless,
            // AUTO-FIRE: absent means "not asked about" and leaves the rate alone;
            // 0 clears it (docs/INPUT-TRANSFORMS.md §3).
            turbo_hz: map.turbo_hz,
            // TOGGLE-HOLD: the same absent-means-untouched rule (§2 item 8).
            toggle: map.toggle,
        },
        Err(refusal) => return err_msg(refusal.message),
    };
    match (deps.map)(&spec) {
        Ok(applied) => {
            let mut message = applied.message();
            let outcome = apply_after_write(request, deps, settle, &mut message);
            serde_json::json!({
                "ok": true,
                "message": message,
                "path": applied.path.display().to_string(),
                "preset": applied.preset,
                "function": applied.function,
                // "key" is the FIRST key (null for a clear): unchanged for
                // every one-key write. "keys" is the control's WHOLE list as
                // the file now holds it — what a key-list write reports back.
                "key": applied.key,
                "keys": applied.keys,
                "when": applied.when,
                "unless": applied.unless,
                // AUTO-FIRE (§3): the rate the control now holds and the rate
                // it will actually deliver. Studio shows the second one on the
                // legend row, because it is the one the game will see.
                "turbo_hz": applied.turbo_hz,
                "turbo_effective_hz": applied.turbo_effective_hz,
                // TOGGLE-HOLD (§2 item 8): the control is now latched.
                "toggle": applied.toggle,
                // MULTI-BIND: the other controls of this preset this key also
                // drives. Studio renders it as the legend's "also A · B"
                // badges (ksx-studio/src/render_map.rs `shared_labels`), which
                // it re-derives from disk — this field is the same truth in
                // the write's own answer.
                "also_drives": applied.also_drives,
                // What "move_from" unbound, or null.
                "moved_from": crate::mapping::moved_from_json(applied.moved_from.as_ref()),
                "conflicts": crate::mapping::conflicts_json(&applied.overridden),
                "flash": crate::mapping::flash_json(&applied.flash),
                "reloaded": outcome.reloaded,
                // true = the live session took it with the pads left plugged.
                "hot_swap": outcome.hot,
            })
        }
        Err(crate::mapping::MapError::Conflicts {
            ref key,
            ref conflicts,
        }) => {
            let err = crate::mapping::MapError::Conflicts {
                key: key.clone(),
                conflicts: conflicts.clone(),
            };
            serde_json::json!({
                "ok": false,
                "code": "conflict",
                "error": err.to_string(),
                "conflicts": crate::mapping::conflicts_json(conflicts),
            })
        }
        Err(err) => err_msg(err.to_string()),
    }
}

/// The pipe `map-macro` verb: one preset's WHOLE `[macros.<name>]` table.
///
/// ```json
/// {"verb":"map-macro","preset":"Panel P1","name":"hadouken",
///  "steps":[{"hold":["dpad.down"],"ms":50},
///           {"hold":["dpad.down","dpad.right"],"ms":50},
///           {"hold":["dpad.right"],"ms":50},
///           {"hold":["A"],"frames":3}],
///  "on_release":"finish","retrigger":"ignore","interrupt":"none",
///  "repeat":"turbo","turbo_hz":10,
///  "reload":true}
/// ```
///
/// The body's field names ARE `ksx_config::MacroFile`'s: this verb hands the
/// object straight to the same serde types the preset file uses, so the wire
/// shape and the file shape cannot drift and `frames` survives as `frames`.
/// `{"delete": true}` removes the table (and the `macro.<name>` trigger rows
/// that would otherwise dangle) — an explicit word, never an empty step list.
///
/// `"enabled"` is the one field that means two things, and which one is decided
/// by whether a BODY came with it:
///
/// - `{"steps":[…], "enabled":false}` — an ordinary whole-table write that
///   happens to land disabled. `enabled` is a `MacroFile` field like any other.
/// - `{"name":"hadouken","enabled":false}` with NO `steps` — a TOGGLE. The
///   table on disk keeps every step and every policy and only the flag moves,
///   which is the whole promise of disabling instead of deleting: what comes
///   back is exactly what went away. (`ksx macro --disable` sends this.)
///
/// `"reload": true` applies it to a RUNNING session, and a macro body is a
/// BINDING change: it changes no slot, persona, device or capture backend, so
/// [`crate::run::supervisor::SessionShape::bounce_reason`] finds nothing and
/// the control loop hot-swaps it with the pads left plugged — the same
/// [`super::DaemonCommand::ApplyBindings`] path `map` takes, through the same
/// [`apply_after_write`].
fn handle_map_macro(
    request: &serde_json::Value,
    deps: &PipeDeps,
    settle: Duration,
) -> serde_json::Value {
    // ONE reader again (`ksx_api::MapMacroRequest`), and here it is not just
    // tidiness: the body half IS `ksx_config::MacroFile`, so every field of a
    // macro table travels by construction. The reader this replaced carried an
    // ALLOWLIST of body fields, `repeat` was missing from it, and a card that
    // set `while-held` saved `once` under a "saved" toast. A list that has to
    // be remembered is a bug with a delay on it; there is no list now.
    let spec = match ksx_api::MapMacroRequest::from_json(request) {
        Ok(macro_request) => crate::mapping::MacroSpec {
            preset: macro_request.preset.clone(),
            name: macro_request.name.clone(),
            body: macro_request.body(),
            delete: macro_request.is_delete(),
            set_enabled: macro_request.set_enabled(),
        },
        Err(refusal) => return err_msg(refusal.message),
    };
    match (deps.save_macro)(&spec) {
        Ok(applied) => {
            let mut message = applied.message();
            let outcome = apply_after_write(request, deps, settle, &mut message);
            serde_json::json!({
                "ok": true,
                "message": message,
                "path": applied.path.display().to_string(),
                "preset": applied.preset,
                "name": applied.name,
                "steps": applied.steps,
                "total_ms": applied.total_ms,
                "deleted": applied.deleted,
                // Does the table RUN, and was this write nothing BUT that flag?
                "enabled": applied.enabled,
                "toggled": applied.toggled,
                // The keys that START it — unchanged by this verb (`map` with
                // "macro.<name>" is what writes those), except on a delete,
                // where these are the rows that had to go with the table.
                "triggers": applied.triggers,
                // Advisories, never swallowed: a step below the sampling floor
                // is raised, or run as written and possibly missed.
                "warnings": applied.warnings,
                "backup": applied.backup.as_ref().map(|b| serde_json::json!({
                    "stamp": b.stamp,
                    "label": b.label(),
                    "path": b.path.display().to_string(),
                })),
                "reloaded": outcome.reloaded,
                "hot_swap": outcome.hot,
            })
        }
        Err(err) => {
            let problems = match &err {
                crate::mapping::MapError::BadMacro { problems, .. } => problems.clone(),
                _ => Vec::new(),
            };
            serde_json::json!({
                "ok": false,
                "code": crate::map::error_code(&err),
                "error": err.to_string(),
                // The refusals one by one, so a UI can put each on its own row
                // instead of parsing the sentence apart.
                "problems": problems,
            })
        }
    }
}

/// The pipe `slot-assign` verb: `{"verb":"slot-assign","slot":3,"preset":"IPAC
/// P3","profile":"Example Launcher","reload":true}` — which preset a slot uses
/// (docs/CONTROL-SURFACE.md honest gaps 1 and 5).
///
/// **This is the one write verb that never claims a hot swap.** Every other one
/// enqueues [`DaemonCommand::ApplyBindings`] and lets the control loop pick the
/// cheapest correct answer; a slot assignment enqueues the blunt
/// [`DaemonCommand::Reload`] and reports `restarted`. The reasoning is on
/// [`ksx_api::SlotOutcome::restarted`] and it is deliberate: this verb writes
/// the slot ENTRY, and one predictable answer beats a cheaper one that is only
/// sometimes true.
fn handle_slot_assign(
    request: &serde_json::Value,
    deps: &PipeDeps,
    settle: Duration,
) -> serde_json::Value {
    // ONE reader, shared with every client — the same rule `map` follows: a
    // caller is refused in these exact words before a round trip.
    let assign = match ksx_api::SlotAssignRequest::from_json(request) {
        Ok(assign) => assign,
        Err(refusal) => {
            return serde_json::json!({
                "ok": false, "code": refusal.code, "error": refusal.message,
            })
        }
    };
    // The persona NAME becomes a persona HERE, in the daemon, through
    // `ksx_core`'s one lenient `FromStr` — the parser `ksx pads --persona` and
    // every config file already go through, aliases and all. Not in
    // `SlotAssignRequest::from_json`: ksx-api would then need a persona
    // vocabulary of its own, which is the second copy of the alias table the
    // wire field's doc comment refuses. An unknown name is refused in
    // `UnknownPersona`'s own words, which list every valid one.
    let persona = match assign
        .persona
        .as_deref()
        .map(str::parse::<ksx_core::Persona>)
    {
        None => None,
        Some(Ok(persona)) => Some(persona),
        Some(Err(unknown)) => {
            return serde_json::json!({
                "ok": false,
                "code": "unknown-persona",
                "error": unknown.to_string(),
            })
        }
    };
    // Same rule, same reason as the persona above: `ksx-core` owns the one
    // lenient parser, and an unknown name is refused in its own words rather
    // than silently becoming the default (which is `off`, and would turn a
    // fighting cabinet's SOCD off by typo).
    let socd = match assign.socd.as_deref().map(str::parse::<ksx_core::Socd>) {
        None => None,
        Some(Ok(socd)) => Some(socd),
        Some(Err(unknown)) => {
            return serde_json::json!({
                "ok": false,
                "code": "unknown-socd",
                "error": unknown.to_string(),
            })
        }
    };
    let applied = match (deps.slot_assign)(&crate::slots::SlotSpec {
        slot: assign.slot,
        preset: assign.preset.clone(),
        profile: assign.profile.clone(),
        persona,
        socd,
    }) {
        Ok(applied) => applied,
        Err(err) => {
            return serde_json::json!({
                "ok": false, "code": err.code(), "error": err.to_string(),
            })
        }
    };

    let mut message = applied.message();
    let bounce = bounce_after_slot_write(&assign, &applied, deps, settle, &mut message);
    serde_json::json!({
        "ok": true,
        "message": message,
        "path": applied.path.display().to_string(),
        "slot": applied.slot,
        "preset": applied.preset,
        "previous_preset": applied.previous,
        // Canonical spelling, from `Persona::as_str` — so a surface that
        // echoes this straight back into the next request cannot introduce a
        // second spelling of one persona.
        "persona": applied.persona.as_str(),
        "previous_persona": applied.previous_persona.map(|p| p.as_str()),
        "profile": applied.profile,
        "created": applied.created,
        "unchanged": applied.unchanged,
        "backup": applied.backup.as_ref().map(|path| serde_json::json!({
            "stamp": backup_stamp(path),
            "label": backup_stamp(path),
            "path": path.display().to_string(),
        })),
        "restarted": bounce.restarted,
        // What the daemon DID, not what the caller asked for. `SlotOutcome`'s
        // field is documented as "`reload` was asked for and the daemon acted
        // on it", and echoing the request made that documentation false in the
        // one case it mattered: a running session that was asked to restart and
        // did not come back reported `reloaded: true, restarted: false`, which
        // reads as "nothing was running".
        "reloaded": bounce.reconciled,
    })
}

// ---------------------------------------------------------------------------
// The staged setup — docs/FIRST-RUN.md §2
// ---------------------------------------------------------------------------

/// One [`ksx_api::StageOutcome`] as the JSON line the pipe carries.
///
/// Serialized from the api type rather than hand-built, unlike the older verbs
/// on this module: the outcome already IS the wire shape (it is what a surface
/// deserializes), so writing the object out by hand here would be a second
/// description of it — and the client would deserialize whichever one drifted.
fn stage_json(outcome: &ksx_api::StageOutcome) -> serde_json::Value {
    serde_json::to_value(outcome)
        .unwrap_or_else(|err| err_msg(format!("the staged setup could not be described: {err}")))
}

fn bind_json(outcome: &ksx_api::BindOutcome) -> serde_json::Value {
    serde_json::to_value(outcome).unwrap_or_else(|err| {
        err_msg(format!(
            "the staged binding answer could not be described: {err}"
        ))
    })
}

fn macro_json(outcome: &ksx_api::MacroOutcome) -> serde_json::Value {
    serde_json::to_value(outcome).unwrap_or_else(|err| {
        err_msg(format!(
            "the staged macro answer could not be described: {err}"
        ))
    })
}

/// The visit metadata, stamped onto an outcome's view. The daemon owns it —
/// `StagedSetupView::of` composes honest defaults, and this is the one place
/// the truth is written over them.
fn stamp_stage_meta(
    mut outcome: ksx_api::StageOutcome,
    meta: &super::StageMeta,
) -> ksx_api::StageOutcome {
    outcome.setup.dirty = meta.dirty;
    outcome.setup.origin = meta.origin.clone();
    stamp_stage_target_revisions(&mut outcome.setup, meta);
    outcome
}

/// Replace the content-only fallback tokens composed by `ksx-api` with the
/// daemon-owned draft incarnation and mutation generation. The content hash
/// remains useful for diagnostics, but the prefix is what makes an exact
/// remove/recreate an ABA-safe new target.
fn stamp_stage_target_revisions(setup: &mut ksx_api::StagedSetupView, meta: &super::StageMeta) {
    for slot in &mut setup.slots {
        let content = ksx_api::staged_slot_revision(slot);
        slot.target_revision = format!("d1-{}-{:016x}-{content}", meta.incarnation, meta.revision);
    }
}

/// The staged setup as it stands. **A read: it changes nothing.**
fn stage_view(state: &SharedState) -> serde_json::Value {
    let Ok(s) = state.lock() else {
        // A poisoned lock is a failed READ, and a failed read is not an
        // absence (docs/SURFACES.md §1b). Rendering an empty setup here would
        // tell a user they had staged nothing.
        return stage_json(&ksx_api::StageOutcome::unavailable(
            "the daemon's state lock is poisoned, so the staged setup could not be read — \
             this is not the same as having staged nothing",
        ));
    };
    let mut outcome = ksx_api::StageOutcome::ok(&s.staged, "the staged setup");
    // A pure read reports no verb having happened.
    outcome.message = None;
    stage_json(&stamp_stage_meta(outcome, &s.stage_meta))
}

/// `{"verb":"stage-adopt"}` (optionally `"profile":"<title>"`) — the saved
/// configuration, read into a fresh stage.
///
/// **Refused on a non-empty stage**, before any disk read: adoption must
/// never overwrite a proposal, so a surface that means to replace one sends
/// `discard` first, behind its own confirmation. The read itself is
/// [`crate::stage::adopt`] behind [`PipeDeps::stage_adopt`]; nothing is
/// written anywhere.
fn handle_stage_adopt(request: &serde_json::Value, deps: &PipeDeps) -> serde_json::Value {
    let profile = request
        .get("profile")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_owned);
    let Ok(mut s) = deps.state.lock() else {
        return stage_json(&ksx_api::StageOutcome::unavailable(
            "the daemon's state lock is poisoned, so the saved configuration could not be adopted",
        ));
    };
    if !s.staged.is_empty() {
        return stage_json(&stamp_stage_meta(
            ksx_api::StageOutcome::refused(
                &s.staged,
                &ksx_api::Refusal::with_remedy(
                    "stage-not-empty",
                    "there is already a setup on this screen, and adopting the saved one would \
                     overwrite it",
                    "start over first (discard), then adopt — or keep editing what is here",
                ),
            ),
            &s.stage_meta,
        ));
    }
    match (deps.stage_adopt)(profile.as_deref()) {
        Ok(setup) => {
            s.staged = setup;
            s.stage_meta = super::StageMeta::default();
            s.stage_meta.origin = profile
                .as_deref()
                .map_or_else(|| "config".to_owned(), |title| format!("profile:{title}"));
            let message = profile.map_or_else(
                || {
                    "Showing the saved setup. Edits stay on this screen until Save or Play."
                        .to_owned()
                },
                |title| {
                    format!("Showing \"{title}\". Edits stay on this screen until Save or Play.")
                },
            );
            stage_json(&stamp_stage_meta(
                ksx_api::StageOutcome::ok(&s.staged, message),
                &s.stage_meta,
            ))
        }
        Err(refusal) => stage_json(&stamp_stage_meta(
            ksx_api::StageOutcome::refused(&s.staged, &refusal),
            &s.stage_meta,
        )),
    }
}

/// `{"verb":"stage-edit","edit":"add-slot","persona":"playstation",…}` — one
/// edit to the staged setup.
///
/// **Nothing here writes.** The edit is validated by `ksx_api::StageEdit::apply`
/// (which is `ksx_core`'s own operations behind a string parser), and the new
/// value replaces the old one in the daemon's state — or, on a refusal, does
/// not, and the answer carries the setup the caller still has.
fn handle_stage_edit(request: &serde_json::Value, deps: &PipeDeps) -> serde_json::Value {
    // The whole request object IS the edit: the `verb` field is ignored by
    // serde's tag (`edit`), so a surface sends one flat object.
    let edit: ksx_api::StageEdit = match serde_json::from_value(request.clone()) {
        Ok(edit) => edit,
        Err(err) => {
            return serde_json::json!({
                "ok": false,
                "code": ksx_api::codes::BAD_REQUEST,
                "error": format!(
                    "stage-edit needs an \"edit\" naming one of choose-device | add-slot | \
                     set-persona | set-layout | set-bindings | remove-slot | reorder-slots | \
                     set-socd | set-blocking | discard: {err}"
                ),
            })
        }
    };
    let Ok(mut s) = deps.state.lock() else {
        return stage_json(&ksx_api::StageOutcome::unavailable(
            "the daemon's state lock is poisoned, so the staged setup could not be edited",
        ));
    };
    stage_json(&apply_stage_edit(&edit, &mut s))
}

/// Apply one already-typed stage edit while the caller owns the daemon state
/// lock. Keeping this tail separate lets the staged binding/macro transactions
/// prepare against and apply to the same snapshot without a read/write gap.
fn apply_stage_edit(edit: &ksx_api::StageEdit, state: &mut DaemonState) -> ksx_api::StageOutcome {
    match edit.apply(&state.staged) {
        Ok(next) => {
            state.staged = next;
            // The visit metadata moves with the write, at this one site:
            // Start over IS the fresh state (clean, no origin); every other
            // edit is a proposal the origin has not seen.
            match edit {
                ksx_api::StageEdit::Discard => state.stage_meta = super::StageMeta::default(),
                _ => {
                    state.stage_meta.dirty = true;
                    state.stage_meta.bump_revision();
                }
            }
            stamp_stage_meta(
                ksx_api::StageOutcome::ok(&state.staged, describe(edit)),
                &state.stage_meta,
            )
        }
        // The setup is handed back UNCHANGED, which is the whole promise: a
        // user told "no" is still looking at a true screen.
        Err(refusal) => stamp_stage_meta(
            ksx_api::StageOutcome::refused(&state.staged, &refusal),
            &state.stage_meta,
        ),
    }
}

fn bind_refusal(code: &str, error: impl Into<String>) -> ksx_api::BindOutcome {
    ksx_api::BindOutcome {
        ok: false,
        error: Some(error.into()),
        code: Some(code.to_owned()),
        ..ksx_api::BindOutcome::default()
    }
}

fn macro_refusal(code: &str, error: impl Into<String>) -> ksx_api::MacroOutcome {
    ksx_api::MacroOutcome {
        ok: false,
        error: Some(error.into()),
        code: Some(code.to_owned()),
        ..ksx_api::MacroOutcome::default()
    }
}

/// Prepare, conflict-check, and apply one staged binding while holding the one
/// staged-state lock. This closes both races in the former `stage` +
/// `stage-edit` composition: two same-slot writers now merge serially, and two
/// different slots cannot both win an unforced duplicate-key check.
fn stage_bind(request: &ksx_api::StagedBindRequest, state: &SharedState) -> ksx_api::BindOutcome {
    let Ok(mut state) = state.lock() else {
        return bind_refusal(
            ksx_api::codes::NOT_HERE,
            "the daemon's state lock is poisoned, so the staged binding could not be edited",
        );
    };
    let mut setup = ksx_api::StagedSetupView::of(&state.staged);
    stamp_stage_target_revisions(&mut setup, &state.stage_meta);
    let prepared = match ksx_api::staged_bind_edit(&setup, request) {
        Ok(prepared) => prepared,
        Err(outcome) => return outcome,
    };
    let outcome = apply_stage_edit(&prepared.edit, &mut state);
    prepared.finish(&outcome)
}

fn handle_stage_bind(request: &serde_json::Value, state: &SharedState) -> serde_json::Value {
    let request: ksx_api::StagedBindRequest = match serde_json::from_value(request.clone()) {
        Ok(request) => request,
        Err(err) => {
            return bind_json(&bind_refusal(
                ksx_api::codes::BAD_REQUEST,
                format!(
                "stage-bind needs an exact slot number, a function, and its whole key list: {err}"
            ),
            ))
        }
    };
    if request.preset.trim().is_empty() {
        return bind_json(&bind_refusal(
            ksx_api::codes::BAD_REQUEST,
            "stage-bind needs the controller layout name observed with its exact player number",
        ));
    }
    bind_json(&stage_bind(&request, state))
}

/// The macro counterpart of [`stage_bind`], with exact-slot selection and
/// whole-table validation inside the same critical section as application.
fn stage_macro(
    request: &ksx_api::StagedMacroRequest,
    state: &SharedState,
) -> ksx_api::MacroOutcome {
    let Ok(mut state) = state.lock() else {
        return macro_refusal(
            ksx_api::codes::NOT_HERE,
            "the daemon's state lock is poisoned, so the staged macro could not be edited",
        );
    };
    let setup = ksx_api::StagedSetupView::of(&state.staged);
    let prepared = match ksx_api::staged_macro_edit_for_setup(&setup, request) {
        Ok(prepared) => prepared,
        Err(outcome) => return outcome,
    };
    let outcome = apply_stage_edit(&prepared.edit, &mut state);
    prepared.finish(&outcome)
}

fn handle_stage_macro(request: &serde_json::Value, state: &SharedState) -> serde_json::Value {
    let request: ksx_api::StagedMacroRequest = match serde_json::from_value(request.clone()) {
        Ok(request) => request,
        Err(err) => {
            return macro_json(&macro_refusal(
                ksx_api::codes::BAD_REQUEST,
                format!(
                    "stage-macro needs an exact slot number and one complete macro write: {err}"
                ),
            ))
        }
    };
    macro_json(&stage_macro(&request, state))
}

/// The one line a successful edit prints. Composed here, once, so the browser
/// and the cabinet describe the same act identically.
fn describe(edit: &ksx_api::StageEdit) -> String {
    match edit {
        ksx_api::StageEdit::ChooseDevice { label, .. } => {
            format!("Using \"{label}\". This choice stays on this screen until Save or Play.")
        }
        ksx_api::StageEdit::SetDeviceBackend { backend, .. } => format!(
            "This keyboard will use {backend}. Save and Play will check the live driver again before doing anything."
        ),
        ksx_api::StageEdit::AddSlot { layout, .. } => match layout {
            Some(_) => "Controller added with its layout. It will appear only when you press Play."
                .to_owned(),
            // Said out loud, because it is the state `commit()` refuses: the
            // pad would plug and do nothing, and the flash is where a user
            // finds that out while it is still one click to fix.
            None => "Controller added without controls. Choose a layout or map its controls \
                     before Play."
                .to_owned(),
        },
        ksx_api::StageEdit::SetLayout { number, layout, .. } => {
            format!(
                "Player {number} now uses the \"{layout}\" layout. This change is still on this screen."
            )
        }
        ksx_api::StageEdit::SetPersona { number, .. } => {
            format!("Player {number}'s controller changed. This change is still on this screen.")
        }
        ksx_api::StageEdit::SetBindings { number, .. } => {
            format!("Player {number}'s controls were updated.")
        }
        ksx_api::StageEdit::RemoveSlot { number } => {
            format!("Player {number} was removed from this setup.")
        }
        ksx_api::StageEdit::ReorderSlots { numbers } => {
            format!(
                "Players reordered ({} of them). Each controller kept its layout and settings; \
                 only the numbers changed.",
                numbers.len()
            )
        }
        ksx_api::StageEdit::SetSocd { number, .. } => {
            format!(
                "Player {number}'s opposite-directions rule changed. This change is still on \
                 this screen."
            )
        }
        ksx_api::StageEdit::SetBlocking { .. } => {
            "Answered. LeftCtrl five times always frees or recaptures the keyboard without ending Play; Stop or Ctrl+Alt+Del ends Play."
                .to_owned()
        }
        ksx_api::StageEdit::Discard => "Started over.".to_owned(),
    }
}

/// `{"verb":"stage-commit"}` — **save** the staged setup.
///
/// The only verb on this module that turns staging into files. It does not
/// start anything and does not claim anything: `docs/FIRST-RUN.md` §2's
/// "saving and playing are separate acts", and `SURFACES.md` §3's rule that
/// claiming is always explicit and separately confirmed.
fn handle_stage_commit(deps: &PipeDeps) -> serde_json::Value {
    let Ok(mut s) = deps.state.lock() else {
        return stage_json(&ksx_api::StageOutcome::unavailable(
            "the daemon's state lock is poisoned, so the staged setup could not be saved",
        ));
    };
    // `commit()` is where ksx-core refuses an incomplete setup, in the same
    // words `StagedSetupView::not_ready` already showed on screen — so pressing
    // Save cannot produce a surprise the page had not already stated.
    let spec = match s.staged.commit() {
        Ok(spec) => spec,
        Err(refusal) => {
            return stage_json(&ksx_api::StageOutcome::refused(
                &s.staged,
                &ksx_api::Refusal::from_wire(Some(refusal.code()), refusal.to_string()),
            ))
        }
    };
    if let Err(refusal) = (deps.stage_capture_preflight)(&spec) {
        return stage_json(&ksx_api::StageOutcome::refused(&s.staged, &refusal));
    }
    match (deps.stage_commit)(&spec) {
        Ok(written) => {
            // The operate-only cabinet and the tray's saved-setup Start action
            // become meaningful at this exact boundary: before it, the setup
            // exists only as a Studio draft; after it, disk has a runnable
            // configuration. Keep the first-run tray honest immediately,
            // without requiring a daemon restart.
            s.cabinet_ready = true;
            // The draft now IS the saved config: clean, and its origin is the
            // file it just became.
            s.stage_meta.dirty = false;
            s.stage_meta.origin = "config".to_owned();
            let mut outcome = ksx_api::StageOutcome::ok(&s.staged, written.message());
            outcome.saved = Some(written.config.display().to_string());
            outcome.backup = written.backup.map(|path| path.display().to_string());
            stage_json(&stamp_stage_meta(outcome, &s.stage_meta))
        }
        Err(err) => stage_json(&ksx_api::StageOutcome::refused(
            &s.staged,
            &ksx_api::Refusal::new(ksx_api::codes::REFUSED, err.to_string()),
        )),
    }
}

/// What starting the staged setup did, before it is dressed for a caller.
///
/// Two verbs ask for it — `stage-play` (moment 7's Play button) and `resume`
/// (the mapper's road back from a pause) — and they answer in two different
/// shapes: a [`ksx_api::StageOutcome`] carrying the whole setup, and the plain
/// action line every session verb answers with. What must NOT differ is the
/// starting itself, so it happens once, here.
struct StagedStart {
    /// The setup as it stood, for an answer that shows it. `None` only when it
    /// could not be READ at all — which is not the same as an empty setup
    /// (docs/SURFACES.md §1b) and is dressed differently.
    setup: Option<ksx_core::StagedSetup>,
    outcome: Result<String, ksx_api::Refusal>,
}

/// **Play the staged setup with nothing written** — the body behind
/// `stage-play` and behind a `resume` of a staged session.
///
/// The plan is built in memory (`crate::stage::plan`) and handed to the control
/// loop as [`DaemonCommand::PlayStaged`], which takes the ordinary start path.
/// No config file is read and none is written, which is what makes
/// `FIRST-RUN.md` §2's "the user may leave without saving and lose only what
/// they typed" true.
///
/// **The spec is committed from the setup as it stands NOW**, per call. That is
/// what makes a resume carry the edits somebody made while emulation was
/// paused: the control loop's copy is a snapshot taken when the session
/// started, and re-sending that would put back the setup as it was before they
/// walked over to change it.
fn play_staged(deps: &PipeDeps, settle: Duration) -> StagedStart {
    let refused = |setup: &ksx_core::StagedSetup, refusal: ksx_api::Refusal| StagedStart {
        setup: Some(setup.clone()),
        outcome: Err(refusal),
    };

    let (spec, staged) = {
        let Ok(s) = deps.state.lock() else {
            return StagedStart {
                setup: None,
                outcome: Err(ksx_api::Refusal::new(
                    ksx_api::codes::PIPE_ERROR,
                    "the daemon's state lock is poisoned, so the staged setup could not be \
                     started",
                )),
            };
        };
        match s.staged.commit() {
            Ok(spec) => (spec, s.staged.clone()),
            Err(refusal) => {
                return refused(
                    &s.staged,
                    ksx_api::Refusal::from_wire(Some(refusal.code()), refusal.to_string()),
                )
            }
        }
    };

    if let Err(refusal) = (deps.stage_capture_preflight)(&spec) {
        return refused(&staged, refusal);
    }

    // Build the plan HERE, before anything is enqueued: a setup that cannot
    // plan must be refused with the planner's own sentence — which names the
    // slot and the preset — rather than as a session that starts and dies with
    // the reason only in the daemon's log.
    //
    // `plan`, not `resolve`: this is the pure half, so a refusal costs no USB
    // enumeration. The factory runs the resolution pass on the same spec when
    // the session actually starts.
    if let Err(err) = crate::stage::plan(&spec) {
        return refused(
            &staged,
            ksx_api::Refusal::new(ksx_api::codes::REFUSED, err.to_string()),
        );
    }

    // `PlayStaged` is one control-loop replacement operation. If a session is
    // already live, the loop tears it down completely and starts this setup;
    // it never asks the browser to coordinate a stop/start race.
    let baseline = snapshot(&deps.state).run;
    if deps
        .tx
        .send(DaemonCommand::PlayStaged(Box::new(spec)))
        .is_err()
    {
        return refused(
            &staged,
            ksx_api::Refusal::new(ksx_api::codes::REFUSED, "the daemon is shutting down"),
        );
    }
    let started = await_start(&deps.state, &baseline, settle);
    if started["ok"] == serde_json::Value::Bool(true) {
        StagedStart {
            setup: Some(staged),
            outcome: Ok(started["message"]
                .as_str()
                .unwrap_or("the staged setup is playing")
                .to_owned()),
        }
    } else {
        refused(
            &staged,
            ksx_api::Refusal::new(
                ksx_api::codes::REFUSED,
                started["error"]
                    .as_str()
                    .unwrap_or("the staged setup did not start"),
            ),
        )
    }
}

/// `{"verb":"stage-play"}` — moment 7's Play button, as a staging answer.
fn handle_stage_play(deps: &PipeDeps, settle: Duration) -> serde_json::Value {
    let started = play_staged(deps, settle);
    let Some(setup) = started.setup else {
        // The setup could not be read. "I could not read this" is not "you
        // staged nothing" (docs/SURFACES.md §1b), and `unavailable` is the
        // shape that says the first one.
        return stage_json(&ksx_api::StageOutcome::unavailable(
            started
                .outcome
                .err()
                .map_or_else(String::new, |refusal| refusal.message),
        ));
    };
    let mut outcome = match started.outcome {
        Ok(message) => {
            let mut ok = ksx_api::StageOutcome::ok(&setup, message);
            ok.playing = true;
            ok
        }
        Err(refusal) => ksx_api::StageOutcome::refused(&setup, &refusal),
    };
    // NEVER a path. Playing writes nothing, and reporting one would be a claim
    // about the disk this verb did not make.
    outcome.saved = None;
    outcome.backup = None;
    stage_json(&outcome)
}

/// `{"verb":"stage-apply"}` — the draft's BINDINGS into the running session in
/// place: pads stay plugged, nothing re-enumerates, nothing is written.
///
/// The dirty flag deliberately does not move: applying is not saving, and the
/// draft still differs from its origin on disk exactly as much as it did. What
/// changes is the session's ORIGIN — the control loop repoints it at the
/// applied spec on success, so pause + resume brings back what is actually
/// playing.
///
/// Refusals keep the session untouched, every one of them: an unsaved draft
/// never tears a session down. Structural difference answers `needs-restart`
/// with [`SessionShape::bounce_reason`]'s sentence naming what changed, and
/// the remedy is the verb that IS allowed to replace the session —
/// `stage-play`, behind the surface's own confirmation.
///
/// [`SessionShape::bounce_reason`]: crate::run::supervisor::SessionShape::bounce_reason
fn handle_stage_apply(deps: &PipeDeps, settle: Duration) -> serde_json::Value {
    // Committed from the setup as it stands NOW — `play_staged`'s rule, for
    // the same reason: the whole point is carrying the edits somebody just
    // made into the live session.
    let (spec, staged, meta) = {
        let Ok(s) = deps.state.lock() else {
            return stage_json(&ksx_api::StageOutcome::unavailable(
                "the daemon's state lock is poisoned, so the staged setup could not be applied",
            ));
        };
        match s.staged.commit() {
            Ok(spec) => (spec, s.staged.clone(), s.stage_meta.clone()),
            Err(refusal) => {
                return stage_json(&stamp_stage_meta(
                    ksx_api::StageOutcome::refused(
                        &s.staged,
                        &ksx_api::Refusal::from_wire(Some(refusal.code()), refusal.to_string()),
                    ),
                    &s.stage_meta,
                ));
            }
        }
    };
    let refused = |refusal: ksx_api::Refusal| {
        stage_json(&stamp_stage_meta(
            ksx_api::StageOutcome::refused(&staged, &refusal),
            &meta,
        ))
    };

    // The pure preflight, before anything is enqueued (`play_staged`'s rule):
    // a draft that cannot even plan is refused with the planner's own
    // sentence, which names the slot and the preset.
    if let Err(err) = crate::stage::plan(&spec) {
        return refused(ksx_api::Refusal::new(
            ksx_api::codes::REFUSED,
            err.to_string(),
        ));
    }
    if !matches!(
        snapshot(&deps.state).run,
        RunState::Running { .. } | RunState::Starting
    ) {
        return refused(ksx_api::Refusal::with_remedy(
            ksx_api::codes::REFUSED,
            "nothing is running to apply the draft into",
            "Play starts it (`stage-play`)",
        ));
    }

    let baseline = snapshot(&deps.state)
        .apply
        .map_or(0, |report| report.generation);
    if deps
        .tx
        .send(DaemonCommand::ApplyStaged(Box::new(spec)))
        .is_err()
    {
        return refused(ksx_api::Refusal::new(
            ksx_api::codes::REFUSED,
            "the daemon is shutting down",
        ));
    }
    match await_apply(&deps.state, baseline, settle) {
        Some(report) if report.ok => {
            let mut outcome = ksx_api::StageOutcome::ok(&staged, report.message);
            outcome.playing = true;
            // NEVER a path: applying writes nothing (`stage-play`'s rule).
            outcome.saved = None;
            outcome.backup = None;
            stage_json(&stamp_stage_meta(outcome, &meta))
        }
        Some(report) if report.needs_restart => refused(ksx_api::Refusal::with_remedy(
            ksx_api::codes::NEEDS_RESTART,
            report.message,
            "Play replaces the running session with the draft (`stage-play`)",
        )),
        Some(report) => refused(ksx_api::Refusal::new(
            ksx_api::codes::REFUSED,
            report.message,
        )),
        None => refused(ksx_api::Refusal::new(
            ksx_api::codes::PIPE_ERROR,
            "the daemon has not reported applying the draft yet — the session may still be \
             starting",
        )),
    }
}

/// `{"verb":"start"}` — a session from **the config on disk**, optionally under
/// a games.toml profile.
///
/// Factored out so that [`handle_resume`]'s config half is this exact call and
/// not a second one that could start it differently.
fn start_from_disk(
    deps: &PipeDeps,
    profile: Option<String>,
    settle: Duration,
) -> serde_json::Value {
    let baseline = snapshot(&deps.state).run;
    if matches!(baseline, RunState::Running { .. } | RunState::Starting) {
        return err_msg("already running");
    }
    if deps
        .tx
        .send(DaemonCommand::Start { game: profile })
        .is_err()
    {
        return err_msg("the daemon is shutting down");
    }
    await_start(&deps.state, &baseline, settle)
}

/// `{"verb":"resume"}` — **put back the session that was stopped.**
///
/// # Why this is not `start`
///
/// `start` means the config on disk. It says so, the control loop enforces it
/// by clearing any staged override, and that rule is right: a tray Start after
/// somebody played an unsaved setup must run what is SAVED.
///
/// It is therefore the wrong verb for coming back from a pause, and the mapper
/// used to send it anyway — with the games.toml profile it had remembered, or
/// with nothing when there was none. For a session played from a staged setup
/// (`docs/FIRST-RUN.md` §2) there is no profile to remember and no file to
/// re-read, so "start again" found nothing to run and dropped the daemon's
/// pointer at the unsaved setup on the way past. The user pressed Resume and
/// got "the daemon refused"; the setup they were playing was still staged, but
/// nothing on the mapper said so or offered it back.
///
/// # What it does instead
///
/// The daemon knows what it started ([`super::DaemonState::origin`]), which is
/// the one fact no surface can hold, so the decision is made here and the
/// surface sends no argument at all:
///
/// - **staged** → play the staged setup again, re-committed from the setup as
///   it stands now, so edits made while paused are in what comes back;
/// - **config** → the ordinary start, which keeps the factory's current
///   games.toml profile — so pausing a profile session and resuming still
///   resumes that profile;
/// - **unknown** → the daemon has started nothing this lifetime, and says so
///   rather than starting something and calling it a resume.
///
/// Every refusal here leaves the staged setup exactly where it was: this verb
/// has no path to `DaemonState::staged` except reading it.
fn handle_resume(deps: &PipeDeps, settle: Duration) -> serde_json::Value {
    let snap = snapshot(&deps.state);
    if matches!(snap.run, RunState::Running { .. } | RunState::Starting) {
        return err_msg("already running");
    }
    match snap.origin {
        ksx_api::SessionOrigin::Staged => {
            let started = play_staged(deps, settle);
            match started.outcome {
                Ok(message) => ok_msg(message),
                // The refusal carries ksx-core's own sentence for what is
                // missing — the words the staging screen was already showing —
                // and then says what this verb did NOT do. It must not read
                // like a resume that destroyed something; and it must not
                // claim the setup is intact either, because "Start over" while
                // paused is legal (§2) and after one there is nothing staged
                // to be intact. What is always true is that THIS verb changed
                // nothing.
                Err(refusal) => err_msg(format!(
                    "the setup that was playing could not be started again: {} — this changed \
                     nothing: no file was written and nothing staged was discarded. ksx's first \
                     screen holds the setup exactly as it stands; `ksx session start` runs what \
                     is saved in config.toml instead",
                    refusal.message
                )),
            }
        }
        // `None`: whatever games.toml profile the daemon is already pointed at,
        // which for a paused session is the one that was running. Naming it
        // here would be this module deciding what the factory already knows.
        ksx_api::SessionOrigin::Config => start_from_disk(deps, None, settle),
        ksx_api::SessionOrigin::Unknown => err_msg(
            "there is nothing to resume — this daemon has not started a session yet, so \
             there is no session to put back. Press Play on ksx's first screen, or \
             `ksx session start` to run what is saved in config.toml",
        ),
    }
}

/// What [`bounce_after_slot_write`] did.
struct Bounce {
    /// The session was torn down and came back on the new wiring.
    restarted: bool,
    /// The running session (if any) now matches what is on disk — either
    /// because it restarted, or because there was nothing running to restart.
    /// `false` means a session is running on the OLD wiring, or was stopped
    /// and could not be started again; the appended message says which.
    reconciled: bool,
}

/// `<file>.bak-YYYYMMDD-HHMMSS` → `YYYYMMDD-HHMMSS`, or the whole file name
/// when it does not carry one. The store names these; this only reads them.
fn backup_stamp(path: &std::path::Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.rsplit_once(".bak-").map(|(_, stamp)| stamp.to_owned()))
        .unwrap_or_else(|| path.display().to_string())
}

/// `slot-assign`'s tail: bounce a RUNNING session onto the new wiring, and say
/// what happened either way.
///
/// Deliberately NOT [`apply_after_write`]: that one asks the control loop for
/// the cheapest correct answer, and for a preset-only re-point the answer would
/// be a hot swap with the pads left plugged. A caller that was told "the pads
/// replug" and then saw them not replug has been lied to in the harmless
/// direction, which is still a surface nobody can predict.
fn bounce_after_slot_write(
    assign: &ksx_api::SlotAssignRequest,
    applied: &crate::slots::AppliedSlot,
    deps: &PipeDeps,
    settle: Duration,
    message: &mut String,
) -> Bounce {
    let nothing_to_do = Bounce {
        restarted: false,
        reconciled: true,
    };
    let left_stale = Bounce {
        restarted: false,
        reconciled: false,
    };
    if applied.unchanged {
        return nothing_to_do;
    }
    let baseline = snapshot(&deps.state).run;
    let running = matches!(baseline, RunState::Running { .. } | RunState::Starting);
    if !running {
        message.push_str(" — nothing is running, so the next start reads it");
        return nothing_to_do;
    }
    if !assign.reload {
        message.push_str(" — a session is running on the old wiring; `reload` to restart it");
        return left_stale;
    }
    if deps.tx.send(DaemonCommand::Reload).is_err() {
        message.push_str(" — written, but the daemon is shutting down (not restarted)");
        return left_stale;
    }
    let answer = await_start(&deps.state, &baseline, settle);
    let restarted = answer
        .get("ok")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if let Some(line) = answer.get("message").or_else(|| answer.get("error")) {
        if let Some(line) = line.as_str() {
            message.push_str(" — ");
            message.push_str(line);
        }
    }
    Bounce {
        restarted,
        reconciled: restarted,
    }
}

/// What [`apply_after_write`] did to the running session — the pipe's half of
/// FIX 3's split.
struct Applied {
    /// The running session now has the change (either way it got there).
    reloaded: bool,
    /// It got there WITHOUT the pads being unplugged.
    hot: bool,
}

/// The shared tail of every write verb (`map`, `map-restore`): honour
/// `"reload": true` against a RUNNING session, and append the honest status
/// note either way.
///
/// The verb enqueued is [`DaemonCommand::ApplyBindings`], not `Reload`. The
/// control loop then decides: a binding-only edit is hot-swapped into the live
/// engine (pads stay plugged — the "why does it need to disconnect to
/// reconnect?"), anything structural bounces the session exactly as before.
/// The pipe keeps the tray's reach and no more: it enqueues a command and
/// reads the [`DaemonState`] snapshot the control loop wrote the verdict into,
/// identified by generation so a concurrent client's answer is never mistaken
/// for this one.
fn apply_after_write(
    request: &serde_json::Value,
    deps: &PipeDeps,
    settle: Duration,
    message: &mut String,
) -> Applied {
    let running = matches!(
        snapshot(&deps.state).run,
        RunState::Running { .. } | RunState::Starting
    );
    let want_reload = request
        .get("reload")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !running {
        message.push_str(" — the next session start reads it");
        return Applied {
            reloaded: false,
            hot: false,
        };
    }
    if !want_reload {
        message.push_str(" — a session is running; `reload` to apply now");
        return Applied {
            reloaded: false,
            hot: false,
        };
    }

    let baseline = snapshot(&deps.state)
        .apply
        .map_or(0, |report| report.generation);
    if deps.tx.send(DaemonCommand::ApplyBindings).is_err() {
        message.push_str(" — saved, but the daemon is shutting down (not applied)");
        return Applied {
            reloaded: false,
            hot: false,
        };
    }
    match await_apply(&deps.state, baseline, settle) {
        Some(report) => {
            message.push_str(&format!(" — {}", report.message));
            Applied {
                reloaded: report.ok && (report.hot || report.restarted),
                hot: report.hot,
            }
        }
        None => {
            message.push_str(" — saved; the daemon has not reported applying it yet");
            Applied {
                reloaded: false,
                hot: false,
            }
        }
    }
}

/// Poll [`DaemonState::apply`] until its generation moves past `baseline`.
fn await_apply(state: &SharedState, baseline: u64, settle: Duration) -> Option<super::ApplyReport> {
    let deadline = Instant::now() + settle;
    loop {
        if let Some(report) = snapshot(state).apply {
            if report.generation > baseline {
                return Some(report);
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(SETTLE_POLL);
    }
}

/// The api's restore destination as the WRITER's own enum. Two enums, one set
/// of words: `ksx-api` names what a caller may ask for, `mapping::RestoreKind`
/// names what the writer does, and this is the one place they meet — so a
/// destination that a typed caller can express and this daemon cannot is a
/// compile error rather than a refusal in the field.
fn restore_kind(mode: ksx_api::RestoreMode) -> crate::mapping::RestoreKind {
    match mode {
        ksx_api::RestoreMode::Defaults => crate::mapping::RestoreKind::Defaults,
        ksx_api::RestoreMode::SessionBackup => crate::mapping::RestoreKind::SessionBackup,
        ksx_api::RestoreMode::LatestBackup => crate::mapping::RestoreKind::LatestBackup,
    }
}

/// The pipe `map-restore` verb: `{"verb":"map-restore","preset":…,"mode":
/// "defaults"|"session-backup"|"latest-backup"}` plus the same optional
/// `"reload"` as `map`.
///
/// The three destinations, spelled out because "defaults" is the one that
/// surprises people: `defaults` writes the KSX KEYBOARD layout (WASD movement,
/// arrows aim, Space=A), not "this preset as it shipped"; `session-backup` restores the
/// snapshot taken before this daemon lifetime's first `map` write ("undo this
/// session"); `latest-backup` restores the newest
/// `<preset>.toml.bak-YYYYMMDD-HHMMSS`, which is the undo for a previous
/// restore. Every one of them copies the current file to a fresh timestamped
/// backup first, and the response names it.
fn handle_map_restore(
    request: &serde_json::Value,
    deps: &PipeDeps,
    settle: Duration,
) -> serde_json::Value {
    let Some(preset) = request
        .get("preset")
        .and_then(|v| v.as_str())
        .filter(|v| !v.trim().is_empty())
    else {
        return err_msg(r#"map-restore needs a "preset""#);
    };
    let Some(kind) = request
        .get("mode")
        .and_then(|v| v.as_str())
        .and_then(ksx_api::RestoreMode::parse)
        .map(restore_kind)
    else {
        return err_msg(
            r#"map-restore needs a "mode": "defaults" | "session-backup" | "latest-backup""#,
        );
    };
    match (deps.restore)(preset, kind) {
        Ok(applied) => {
            let mut message = applied.message();
            let outcome = apply_after_write(request, deps, settle, &mut message);
            serde_json::json!({
                "ok": true,
                "message": message,
                "path": applied.path.display().to_string(),
                "preset": applied.preset,
                "mode": applied.kind.as_str(),
                // What the caller's confirm dialog promised, echoed back.
                "wrote": applied.kind.destination(),
                "backup": applied.backup.as_ref().map(|b| serde_json::json!({
                    "stamp": b.stamp,
                    "label": b.label(),
                    "path": b.path.display().to_string(),
                })),
                "reloaded": outcome.reloaded,
                "hot_swap": outcome.hot,
            })
        }
        Err(err) => err_msg(err.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Client — moved to `ksx-api` (docs/M9-DECISION.md §6).
//
// The transport was never the daemon's: `ksx session`, Studio and any future
// shell all dial the same pipe, and the crate that owns the request types owns
// the line they travel on. What stays here is the NAME, so every existing
// `pipe::client::request(pipe::PIPE_NAME, …)` call site still reads the way it
// always did — and so a caller that wants the TYPED client asks for
// `ksx_api::Client::new(ksx_api::PipeTransport::new())` instead of hand-rolling
// a second one.
// ---------------------------------------------------------------------------

pub mod client {
    pub use ksx_api::pipe::{
        request_json as request, wait_until_closed, TransportError as ClientError,
    };
}

// ---------------------------------------------------------------------------
// Server — Win32 named pipe, plain threads. No async runtime anywhere: E7
// rule A (`cargo tree -p ksx-app` shows no tokio) holds by construction.
// ---------------------------------------------------------------------------

#[cfg(windows)]
pub mod server {
    use super::*;

    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::{
        FlushFileBuffers, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX,
    };
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
        PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };

    /// Exact control-pipe authority: the creating account (object owner),
    /// SYSTEM, and any enabled Administrators token get full control. There is
    /// deliberately no Authenticated Users / Everyone / Users ACE.
    ///
    /// The Administrators ACE is required for uninstall under credentials
    /// different from the standard user who launched the daemon. OWNER RIGHTS
    /// keeps ordinary same-user Studio/CLI access without broadening it to a
    /// second low-privilege account.
    pub(crate) const CONTROL_PIPE_SDDL: &str = "D:P(A;;GA;;;OW)(A;;GA;;;SY)(A;;GA;;;BA)";

    struct PipeSecurity {
        descriptor: *mut core::ffi::c_void,
        attributes: SECURITY_ATTRIBUTES,
    }

    impl PipeSecurity {
        fn new() -> Result<Self, u32> {
            let sddl: Vec<u16> = CONTROL_PIPE_SDDL
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let mut descriptor = std::ptr::null_mut();
            // SAFETY: `sddl` is NUL-terminated and live for the call;
            // LocalAlloc returns the descriptor through `descriptor`, which
            // this owner releases with LocalFree.
            let ok = unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 || descriptor.is_null() {
                // SAFETY: immediately after the failed Win32 call.
                return Err(unsafe { GetLastError() });
            }
            Ok(Self {
                descriptor,
                attributes: SECURITY_ATTRIBUTES {
                    nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                    lpSecurityDescriptor: descriptor,
                    bInheritHandle: 0,
                },
            })
        }

        fn attributes(&self) -> *const SECURITY_ATTRIBUTES {
            &self.attributes
        }
    }

    impl Drop for PipeSecurity {
        fn drop(&mut self) {
            // SAFETY: ConvertStringSecurityDescriptor... allocated this exact
            // descriptor with LocalAlloc; this owner frees it once.
            unsafe { LocalFree(self.descriptor) };
        }
    }

    /// One pipe instance. Closes on drop; [`Instance::finish`] is the
    /// graceful path (flush → disconnect) for a served connection.
    ///
    /// `pub(crate)` because the LIVE feed's channel
    /// (`crate::daemon::live_pipe`) is a second named pipe with different
    /// *semantics* — outbound-only, thread per connection, many lines per
    /// connection — but identical Win32 *mechanics*. One copy of these unsafe
    /// blocks, two protocols on top of it: a second hand-rolled
    /// `CreateNamedPipeW` is how two pipes come to disagree about the
    /// security descriptor. The control pipe deliberately supplies its own
    /// descriptor; the outbound-only live pipe retains the default one.
    pub(crate) struct Instance(HANDLE);

    // SAFETY: a pipe HANDLE is a kernel object reference, valid on any thread
    // of the owning process; only the raw-pointer typedef blocks the auto
    // impl.
    unsafe impl Send for Instance {}

    impl Drop for Instance {
        fn drop(&mut self) {
            // SAFETY: the handle came from CreateNamedPipeW and is closed
            // exactly once (drop consumes self).
            unsafe { CloseHandle(self.0) };
        }
    }

    impl Instance {
        /// `first` asserts sole ownership of the pipe name: a second daemon
        /// must fail here, not silently split the client stream with the
        /// first.
        fn create(wide_name: &[u16], first: bool, security: &PipeSecurity) -> Result<Self, u32> {
            Self::create_raw(wide_name, first, PIPE_ACCESS_DUPLEX, security.attributes())
        }

        /// [`Instance::create`] with the access mode named.
        ///
        /// The control pipe is `PIPE_ACCESS_DUPLEX` — it answers questions.
        /// The live feed's pipe is `PIPE_ACCESS_OUTBOUND`, so a client cannot
        /// write to it at all: one-directionality enforced by the object
        /// manager rather than by everyone remembering.
        pub(crate) fn create_with(
            wide_name: &[u16],
            first: bool,
            access: u32,
        ) -> Result<Self, u32> {
            Self::create_raw(wide_name, first, access, std::ptr::null())
        }

        fn create_raw(
            wide_name: &[u16],
            first: bool,
            access: u32,
            security: *const SECURITY_ATTRIBUTES,
        ) -> Result<Self, u32> {
            let mut open_mode = access;
            if first {
                open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
            }
            // SAFETY: `wide_name` is NUL-terminated and outlives the call;
            // `security` is either null (the live pipe) or points to the
            // control server's live descriptor.
            let handle = unsafe {
                CreateNamedPipeW(
                    wide_name.as_ptr(),
                    open_mode,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                    PIPE_UNLIMITED_INSTANCES,
                    64 * 1024,
                    64 * 1024,
                    0,
                    security,
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                // SAFETY: immediately after the failed call, same thread.
                return Err(unsafe { GetLastError() });
            }
            Ok(Self(handle))
        }

        /// Block until a client connects. A client that raced ahead of us
        /// (ERROR_PIPE_CONNECTED) is already connected — success.
        pub(crate) fn connect(&self) -> bool {
            // SAFETY: `self.0` is a live pipe handle; a null OVERLAPPED means
            // synchronous, which is this server's whole design.
            let ok = unsafe { ConnectNamedPipe(self.0, std::ptr::null_mut()) };
            // SAFETY: immediately after the call, same thread.
            ok != 0 || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED
        }

        /// Read until `\n`, EOF, or the size cap.
        fn read_line(&self) -> Option<String> {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 512];
            loop {
                let mut read: u32 = 0;
                // SAFETY: `chunk` outlives the call and its length is passed;
                // `read` receives the byte count.
                let ok = unsafe {
                    ReadFile(
                        self.0,
                        chunk.as_mut_ptr(),
                        chunk.len() as u32,
                        &mut read,
                        std::ptr::null_mut(),
                    )
                };
                if ok == 0 || read == 0 {
                    return None;
                }
                buf.extend_from_slice(&chunk[..read as usize]);
                if buf.contains(&b'\n') {
                    break;
                }
                if buf.len() > MAX_REQUEST {
                    return None;
                }
            }
            String::from_utf8(buf).ok()
        }

        pub(crate) fn write_all(&self, mut bytes: &[u8]) -> bool {
            while !bytes.is_empty() {
                let mut written: u32 = 0;
                // SAFETY: `bytes` outlives the call and its length is passed;
                // `written` receives the byte count.
                let ok = unsafe {
                    WriteFile(
                        self.0,
                        bytes.as_ptr(),
                        bytes.len() as u32,
                        &mut written,
                        std::ptr::null_mut(),
                    )
                };
                if ok == 0 || written == 0 {
                    return false;
                }
                bytes = &bytes[written as usize..];
            }
            true
        }

        /// Flush + disconnect, so the client reads the full response before
        /// the handle goes away. Drop then closes it.
        pub(crate) fn finish(self) {
            // SAFETY: live handle; flush-then-disconnect is the documented
            // graceful server-side teardown for byte pipes.
            unsafe {
                FlushFileBuffers(self.0);
                DisconnectNamedPipe(self.0);
            }
        }
    }

    /// Serve `name` until the process exits. Returns immediately; the thread
    /// logs and dies (leaving tray/stdin untouched) if the name cannot be
    /// owned — e.g. a second daemon is already serving it.
    pub fn spawn(name: String, deps: PipeDeps) {
        spawn_with(name, deps, SETTLE_TIMEOUT);
    }

    /// The production server: unlike [`spawn`], this one participates in the
    /// process-level quit handshake owned by daemon main.
    pub(crate) fn spawn_shutdown(name: String, deps: PipeDeps, shutdown: ShutdownHandshake) {
        spawn_with_shutdown(name, deps, SETTLE_TIMEOUT, shutdown);
    }

    /// [`spawn`] with the settle timeout exposed, so tests are not 5 s each.
    pub fn spawn_with(name: String, deps: PipeDeps, settle: Duration) {
        spawn_with_shutdown(name, deps, settle, ShutdownHandshake::default());
    }

    /// Spawn the process-owned server with the rendezvous daemon main will
    /// complete after its control loop, tray and panel claim are down.
    pub(crate) fn spawn_with_shutdown(
        name: String,
        deps: PipeDeps,
        settle: Duration,
        shutdown: ShutdownHandshake,
    ) {
        let result = std::thread::Builder::new()
            .name("ksx-daemon-pipe".into())
            .spawn(move || serve(&name, &deps, settle, &shutdown));
        if let Err(err) = result {
            tracing::error!("could not spawn the control-pipe thread: {err}");
        }
    }

    fn serve(name: &str, deps: &PipeDeps, settle: Duration, shutdown: &ShutdownHandshake) {
        let wide_name: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let security = match PipeSecurity::new() {
            Ok(security) => security,
            Err(code) => {
                tracing::error!(
                    "control pipe {name} security descriptor unavailable (WinError {code})"
                );
                return;
            }
        };
        let mut instance = match Instance::create(&wide_name, true, &security) {
            Ok(instance) => instance,
            Err(code) => {
                tracing::error!(
                    "control pipe {name} unavailable (WinError {code}); \
                     is another ksx daemon already running?"
                );
                return;
            }
        };
        tracing::info!("control pipe listening on {name}");
        loop {
            if !instance.connect() {
                // A failed accept on a healthy handle is transient; recreate
                // rather than spin on it.
                drop(instance);
                match Instance::create(&wide_name, false, &security) {
                    Ok(fresh) => instance = fresh,
                    Err(code) => {
                        tracing::error!("control pipe died (WinError {code})");
                        return;
                    }
                }
                continue;
            }
            // The NEXT instance exists before this connection is served:
            // clients arriving mid-request queue on it instead of finding no
            // pipe at all.
            let next = Instance::create(&wide_name, false, &security);
            if let Some(line) = instance.read_line() {
                let mut response =
                    handle_request_with_shutdown(&line, deps, settle, Some(shutdown)).to_string();
                response.push('\n');
                instance.write_all(response.as_bytes());
            }
            instance.finish();
            if shutdown.was_requested() {
                // `next` is a real listening instance created before the
                // request was served. Drop it too: pipe absence, not merely
                // EOF on this conversation, is the uninstall-safe boundary.
                drop(next);
                shutdown.pipe_closed();
                return;
            }
            match next {
                Ok(fresh) => instance = fresh,
                Err(code) => {
                    tracing::error!("control pipe died (WinError {code})");
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier, Mutex};

    use crossbeam_channel::unbounded;

    /// THE REGRESSION, pinned where it happened: a `map-macro` request that
    /// SAYS `repeat`/`turbo_hz` produces a spec that HAS them.
    ///
    /// What this used to test was an ALLOWLIST of body fields kept in this
    /// file. `repeat` was missing from it, so a macro card that set
    /// `while-held` saved `once` — with a "saved" toast, because a dropped
    /// field looks exactly like a field the user never set. The list is gone:
    /// the body half of the request IS `ksx_config::MacroFile`
    /// (`ksx_api::MapMacroRequest`), so a field added to the table is on the
    /// wire and in this spec the moment it compiles, and the only list left is
    /// the ENVELOPE's — a closed set, whose failure mode is a loud refusal
    /// rather than a silent drop.
    #[test]
    fn a_macro_request_carries_every_field_of_the_table_into_the_spec() {
        let request = serde_json::json!({
            "verb": "map-macro",
            "preset": "Panel P1",
            "name": "hadouken",
            "steps": [{"hold": ["A"], "ms": 50, "allow_short": true},
                      {"hold": ["dpad.down"], "frames": 2}],
            "on_release": "abort",
            "retrigger": "restart",
            "interrupt": "opposing",
            "repeat": "turbo",
            "turbo_hz": 10,
            "enabled": false,
            "reload": true,
        });
        let parsed = ksx_api::MapMacroRequest::from_json(&request).expect("a whole-table write");
        let body = parsed.body();
        assert_eq!(body.repeat, ksx_core::Repeat::Turbo);
        assert_eq!(body.turbo_hz, Some(10));
        assert_eq!(body.gap_ms, None, "the other unit is not invented");
        assert_eq!(body.on_release, ksx_core::OnRelease::Abort);
        assert_eq!(body.retrigger, ksx_core::Retrigger::Restart);
        assert_eq!(body.interrupt, ksx_core::Interrupt::Opposing);
        assert!(!body.enabled, "a write may land disabled");
        assert!(body.steps[0].allow_short);
        // A duration authored in frames survives the wire as frames.
        assert_eq!(body.steps[1].frames, Some(2));
        assert_eq!(body.steps[1].ms, None);
        // ...and a body write is not a toggle, whatever `enabled` says.
        assert_eq!(parsed.set_enabled(), None);
        assert!(!parsed.is_delete());
        assert!(parsed.reload);
    }

    /// Every field `MacroFile` will EVER serialize reaches the spec, because
    /// nothing in this daemon enumerates them. Pinned against the type's own
    /// serde shape, with every field set to a non-default so nothing is
    /// skipped on write.
    #[test]
    fn no_field_of_a_macro_table_can_be_dropped_on_the_way_in() {
        let full: ksx_config::MacroFile = toml::from_str(
            r#"
on_release = "abort"
retrigger = "restart"
interrupt = "opposing"
repeat = "turbo"
turbo_hz = 10
enabled = false
steps = [{ hold = ["A"], ms = 50, allow_short = true }]
"#,
        )
        .unwrap();
        let mut request = serde_json::to_value(&full).expect("a macro table is an object");
        request["verb"] = serde_json::json!("map-macro");
        request["preset"] = serde_json::json!("Panel P1");
        request["name"] = serde_json::json!("hadouken");
        let parsed = ksx_api::MapMacroRequest::from_json(&request).expect("a whole-table write");
        assert_eq!(
            parsed.body(),
            full,
            "a field of the macro table did not survive the request reader"
        );
    }

    /// The toggle and the delete are still told apart by what is ABSENT, and
    /// still refuse rather than guess.
    #[test]
    fn a_macro_request_without_steps_is_a_toggle_a_delete_or_a_refusal() {
        let toggle = ksx_api::MapMacroRequest::from_json(&serde_json::json!({
            "verb": "map-macro", "preset": "P", "name": "m", "enabled": false
        }))
        .expect("a toggle");
        assert_eq!(toggle.set_enabled(), Some(false));

        let deleted = ksx_api::MapMacroRequest::from_json(&serde_json::json!({
            "verb": "map-macro", "preset": "P", "name": "m", "delete": true
        }))
        .expect("a delete");
        assert!(deleted.is_delete());

        let refused = ksx_api::MapMacroRequest::from_json(&serde_json::json!({
            "verb": "map-macro", "preset": "P", "name": "m"
        }))
        .unwrap_err();
        assert!(refused.message.contains("map-macro needs"), "{refused}");
    }

    /// Every destination a typed caller can ask for is one this daemon writes.
    #[test]
    fn every_api_restore_destination_maps_onto_a_writer_destination() {
        for mode in ksx_api::RestoreMode::ALL {
            assert_eq!(restore_kind(mode).as_str(), mode.as_str());
        }
    }

    // -- the drift pin --------------------------------------------------------

    /// Every field the daemon SAYS, `ksx-api` reads. Recursive, and a missing
    /// key is the failure: a client that cannot see a field is a client that
    /// silently loses it, which is the exact shape of the `repeat` bug in the
    /// other direction.
    ///
    /// A `null` the daemon emits and the type omits is not information lost —
    /// absent and null are the same fact here — so that one case passes.
    fn assert_nothing_dropped(
        verb: &str,
        path: &str,
        said: &serde_json::Value,
        read_back: &serde_json::Value,
    ) {
        match said {
            serde_json::Value::Object(fields) => {
                for (key, value) in fields {
                    match read_back.get(key) {
                        Some(mirror) => {
                            assert_nothing_dropped(verb, &format!("{path}/{key}"), value, mirror);
                        }
                        None if value.is_null() => {}
                        None => panic!(
                            "the daemon answers `{verb}` with `{path}/{key}` and ksx-api's \
                             response type does not model it — every client reading that answer \
                             loses the field silently. Add it to the response type in \
                             ksx-api/src/wire.rs."
                        ),
                    }
                }
            }
            serde_json::Value::Array(items) => {
                let mirror = read_back.as_array().unwrap_or_else(|| {
                    panic!("`{verb}` answers `{path}` with an array; the type reads {read_back}")
                });
                assert_eq!(items.len(), mirror.len(), "`{verb}` {path}: row count");
                for (i, (said, mirror)) in items.iter().zip(mirror).enumerate() {
                    assert_nothing_dropped(verb, &format!("{path}/{i}"), said, mirror);
                }
            }
            scalar => assert_eq!(scalar, read_back, "`{verb}` {path}"),
        }
    }

    /// **THE DRIFT PIN.** Every verb, both directions, against the REAL
    /// dispatch — no pipe, no daemon, no mocks of the thing under test.
    ///
    /// For each verb: build the TYPED request (`ksx_api::Request`), serialize
    /// it exactly as a client would, hand the line to `handle_request`, then
    /// read the daemon's answer back through the TYPED response and check that
    /// nothing the daemon said was dropped on the way in.
    ///
    /// This is the test the `repeat` regression needed. That bug was a client
    /// and a daemon holding two descriptions of one message, 3,000 lines
    /// apart, and nothing that failed when they disagreed. Now there is one
    /// description — and this asserts the daemon is still answering it.
    #[test]
    fn every_typed_request_is_answered_by_a_response_ksx_api_models_completely() {
        use ksx_api::{Request, Response};

        let dir = std::env::temp_dir().join(format!(
            "ksx-pipe-drift-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = ksx_config::ConfigRoot::at(&dir);
        let store = ksx_config::Store::new(root.clone());
        let file: ksx_config::PresetFile = toml::from_str(
            r#"
name = "Panel P1"
[bindings]
A = "S"
B = "D"
macro.hadouken = "P"

[macros.hadouken]
steps = [{ hold = ["A"], ms = 50 }]
"#,
        )
        .unwrap();
        store.save_preset(&file).unwrap();

        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let mut d = deps(tx, state, fixed_profiles());
        let (map, save_macro) = preset_writers(root.clone());
        d.map = map;
        d.save_macro = save_macro;
        d.restore = restore_fn(root.clone());
        d.clear_all = clear_all_fn(root.clone());
        d.backups = backups_fn(root.clone());
        d.slot_assign = slot_assign_fn(root.clone());
        // `slot-assign` writes config.toml, so the file has to exist.
        store
            .save_config(&ksx_config::ConfigFile::default())
            .unwrap();
        let _ = root;

        // Every verb, in an order that leaves real data behind for the ones
        // that read it (the restores take timestamped backups, so `map-backups`
        // answers with rows rather than an empty list).
        let requests = vec![
            Request::Status,
            // Both ACTION shapes: one that enqueues and settles into an honest
            // "requested", one the daemon refuses outright.
            Request::Start { profile: None },
            Request::Stop,
            // The resume this daemon refuses (it has started nothing), which
            // is still an ACTION answer and still has to model completely.
            Request::Resume,
            Request::Map(ksx_api::MapRequest {
                preset: "Panel P1".into(),
                function: "A".into(),
                keys: vec!["S".into(), "Enter".into()],
                ..ksx_api::MapRequest::default()
            }),
            // A chord, so `when` / `flash` are exercised too.
            Request::Map(ksx_api::MapRequest {
                preset: "Panel P1".into(),
                function: "rt".into(),
                key: Some("D".into()),
                when: vec!["S".into()],
                ..ksx_api::MapRequest::default()
            }),
            Request::MapMacro(ksx_api::MapMacroRequest {
                preset: "Panel P1".into(),
                name: "hadouken".into(),
                write: ksx_api::MacroWriteKind::Body(Box::new(
                    toml::from_str(
                        r#"
repeat = "turbo"
turbo_hz = 10
steps = [{ hold = ["dpad.down"], ms = 50 }, { hold = ["A"], frames = 2 }]
"#,
                    )
                    .unwrap(),
                )),
                reload: false,
            }),
            // The toggle and the delete are the same verb with a different
            // meaning, and both answer with the same shape.
            Request::MapMacro(ksx_api::MapMacroRequest {
                preset: "Panel P1".into(),
                name: "hadouken".into(),
                write: ksx_api::MacroWriteKind::Toggle(false),
                reload: false,
            }),
            Request::MapRestore(ksx_api::RestoreRequest {
                preset: "Panel P1".into(),
                mode: ksx_api::RestoreMode::Defaults,
                reload: false,
            }),
            Request::MapClearAll(ksx_api::ClearAllRequest {
                preset: "Panel P1".into(),
                reload: false,
            }),
            Request::MapBackups(ksx_api::BackupsRequest {
                preset: "Panel P1".into(),
            }),
            Request::SlotAssign(ksx_api::SlotAssignRequest {
                slot: 1,
                preset: Some("Panel P1".into()),
                profile: None,
                persona: None,
                socd: None,
                reload: false,
            }),
            // The staged setup, in the order a first-run visit walks it:
            // choose a keyboard, add a controller, answer split-or-freeze,
            // read it back. `stage-commit` and `stage-play` are deliberately
            // NOT here — this fixture's writer refuses and there is no control
            // loop to reap a session from — and both are covered above by
            // their own tests, with the assertions those cases need.
            Request::StageEdit(Box::new(ksx_api::StageEdit::ChooseDevice {
                selector: "usb:d209:0430:00".into(),
                alias: "panel".into(),
                label: "Ultimarc I-PAC 4".into(),
            })),
            Request::StageEdit(Box::new(ksx_api::StageEdit::AddSlot {
                number: None,
                persona: "playstation".into(),
                preset: "Panel P1".into(),
                layout: Some("arcade-6button".into()),
            })),
            Request::StageEdit(Box::new(ksx_api::StageEdit::SetLayout {
                number: 1,
                layout: "keyboard-wasd".into(),
                player: None,
            })),
            Request::StageBind(Box::new(ksx_api::StagedBindRequest {
                number: 1,
                preset: "Panel P1".into(),
                function: "Guide".into(),
                keys: vec!["LeftWindows".into()],
                ..ksx_api::StagedBindRequest::default()
            })),
            Request::StageMacro(Box::new(ksx_api::StagedMacroRequest {
                number: 1,
                write: ksx_api::MacroWrite {
                    preset: "Panel P1".into(),
                    name: "coin-pulse".into(),
                    steps: vec![ksx_api::MacroStepView {
                        hold: vec!["A".into()],
                        ms: Some(50),
                        ..ksx_api::MacroStepView::default()
                    }],
                    ..ksx_api::MacroWrite::default()
                },
            })),
            Request::StageEdit(Box::new(ksx_api::StageEdit::SetBlocking {
                blocking: "bound-keys".into(),
            })),
            Request::Stage,
            Request::LearnKey,
            Request::LearnPoll,
            Request::LearnCancel { generation: None },
            Request::InputTestStart(ksx_api::InputTestSpec {
                selector: "usb:d209:0430:00".into(),
                duration_ms: 5_000,
            }),
            Request::InputTestPoll,
            Request::InputTestCancel { generation: None },
            // The pure dispatcher has no process-owned rendezvous and must
            // refuse rather than pretending an in-process call closed a pipe.
            Request::Quit,
        ];

        for request in requests {
            let verb = request.verb();
            // The line a client actually sends — serialized from the shared
            // type, not hand-written here.
            let line = request.to_line();
            let said = handle_request(&line, &d, FAST);
            assert!(
                said.get("ok").is_some(),
                "`{verb}` answered without an `ok`: {said}"
            );
            let typed = Response::parse(&request, said.clone())
                .unwrap_or_else(|err| panic!("`{verb}` → {said}\n  unreadable: {err}"));
            assert_nothing_dropped(verb, "", &said, &typed.to_json());

            // ...and the answer is the SHAPE this verb promises, not merely a
            // parseable object.
            let right_shape = matches!(
                (&request, &typed),
                (Request::Status, Response::Status(_))
                    | (
                        Request::Start { .. }
                            | Request::Stop
                            | Request::Resume
                            | Request::Reload
                            | Request::Quit,
                        Response::Action(_)
                    )
                    | (Request::Map(_), Response::Map(_))
                    | (Request::StageBind(_), Response::Map(_))
                    | (Request::MapMacro(_), Response::Macro(_))
                    | (Request::StageMacro(_), Response::Macro(_))
                    | (
                        Request::MapRestore(_) | Request::MapClearAll(_),
                        Response::Restore(_)
                    )
                    | (Request::MapBackups(_), Response::Backups(_))
                    | (Request::SlotAssign(_), Response::SlotAssign(_))
                    | (
                        Request::Stage
                            | Request::StageEdit(_)
                            | Request::StageCommit
                            | Request::StagePlay,
                        Response::Stage(_)
                    )
                    | (
                        Request::LearnKey | Request::LearnPoll | Request::LearnCancel { .. },
                        Response::Learn(_)
                    )
                    | (
                        Request::InputTestStart(_)
                            | Request::InputTestPoll
                            | Request::InputTestCancel { .. },
                        Response::InputTest(_)
                    )
            );
            assert!(right_shape, "`{verb}` was read as the wrong response kind");

            // The verbs whose answers a surface RENDERS get their content
            // checked, so "modelled" cannot mean "modelled as all defaults".
            match (&request, &typed) {
                (_, Response::Status(status)) => {
                    assert_eq!(status.run, "stopped");
                    assert_eq!(status.profiles.len(), 2, "games.toml rows");
                    assert!(status.tooltip.is_some());
                }
                (Request::Map(map), Response::Map(answer)) => {
                    assert!(answer.ok, "{said}");
                    assert_eq!(answer.keys, map.key_list());
                    assert_eq!(answer.preset.as_deref(), Some("Panel P1"));
                    assert!(answer.path.is_some());
                }
                (Request::MapMacro(_), Response::Macro(answer)) => {
                    assert!(answer.ok, "{said}");
                    assert_eq!(answer.name.as_deref(), Some("hadouken"));
                    assert!(answer.backup.is_some(), "every macro write leaves an undo");
                }
                (Request::StageBind(_), Response::Map(answer)) => {
                    assert!(answer.ok, "{said}");
                    assert!(!answer.reloaded, "staging cannot claim a live reload");
                }
                (Request::StageMacro(_), Response::Macro(answer)) => {
                    assert!(answer.ok, "{said}");
                    assert!(
                        answer.backup.is_none(),
                        "memory-only staging has no file backup"
                    );
                    assert!(!answer.reloaded, "staging cannot claim a live reload");
                }
                (_, Response::Restore(answer)) => {
                    assert!(answer.ok, "{said}");
                    assert!(answer.mode.is_some() && answer.wrote.is_some());
                }
                (_, Response::Backups(answer)) => {
                    assert!(answer.ok, "{said}");
                    assert!(
                        !answer.backups.is_empty(),
                        "the restores above each left one: {said}"
                    );
                    assert!(!answer.backups[0].label.is_empty());
                }
                (_, Response::SlotAssign(answer)) => {
                    assert!(answer.ok, "{said}");
                    assert_eq!(answer.slot, Some(1));
                    assert_eq!(answer.preset.as_deref(), Some("Panel P1"));
                    assert!(answer.created, "slot 1 did not exist in this fixture");
                    assert!(answer.path.is_some());
                    // The pad bounce is in the sentence, always — with nothing
                    // running that reads "the next start reads it".
                    let message = answer.message.clone().unwrap_or_default();
                    assert!(message.contains("pads replugged"), "{message}");
                    assert!(!answer.restarted, "nothing was running to restart");
                }
                (_, Response::Stage(answer)) => {
                    assert!(answer.ok, "{said}");
                    // The setup is HELD across requests, so by the last one
                    // every earlier edit is still there — and the ceilings and
                    // the roster are served on every answer, so a surface
                    // never has to know a number.
                    assert!(answer.setup.reachable);
                    assert_eq!(answer.setup.max_slots, ksx_core::MAX_SLOTS);
                    assert_eq!(
                        answer.setup.personas.len(),
                        ksx_core::Persona::ALL.len(),
                        "the persona roster is served, never hardcoded by a surface"
                    );
                    // Nothing staging does may claim a write.
                    assert_eq!(answer.saved, None);
                    assert!(!answer.playing);
                }
                (_, Response::Learn(answer)) => {
                    assert!(answer.ok, "{said}");
                    assert!(!answer.state.is_empty());
                }
                // Every other pairing was refused by `right_shape` above.
                _ => {}
            }
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn shared(run: RunState) -> SharedState {
        Arc::new(Mutex::new(DaemonState {
            run,
            ..DaemonState::default()
        }))
    }

    fn no_profiles() -> ProfilesFn {
        Box::new(Vec::new)
    }

    fn fixed_profiles() -> ProfilesFn {
        Box::new(|| {
            vec![
                (
                    "Example Game".to_owned(),
                    r"C:\example-game.exe — 2 slots".to_owned(),
                ),
                ("Metal Slug".to_owned(), r"C:\ms.exe — 1 slot".to_owned()),
            ]
        })
    }

    /// A `map` that refuses everything — protocol tests that never map.
    fn no_map() -> MapFn {
        Box::new(|spec| {
            Err(crate::mapping::MapError::UnknownPreset {
                name: spec.preset.clone(),
                known: Vec::new(),
            })
        })
    }

    /// A `map-macro` that refuses everything — protocol tests that never write
    /// a macro body.
    fn no_macro() -> MacroFn {
        Box::new(|spec| {
            Err(crate::mapping::MapError::UnknownPreset {
                name: spec.preset.clone(),
                known: Vec::new(),
            })
        })
    }

    /// A learn service whose observer parks until cancelled (protocol tests
    /// drive phases through the service API, not a keyboard).
    fn idle_learn() -> super::super::learn::LearnService {
        super::super::learn::LearnService::new(Arc::new(|timeout, cancel| {
            let deadline = Instant::now() + timeout;
            while Instant::now() < deadline {
                if cancel.load(std::sync::atomic::Ordering::SeqCst) {
                    return Ok(None);
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            Ok(None)
        }))
    }

    fn idle_input_test() -> super::super::input_test::InputTestService {
        super::super::input_test::InputTestService::new(Arc::new(
            |_selector, deadline, cancel, _emit| {
                while Instant::now() < deadline {
                    if cancel.load(std::sync::atomic::Ordering::SeqCst) {
                        return Ok(0);
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
                Ok(0)
            },
        ))
    }

    /// A `map-restore` that refuses everything — protocol tests that never
    /// restore.
    fn no_restore() -> RestoreFn {
        Box::new(|preset, _kind| {
            Err(crate::mapping::MapError::UnknownPreset {
                name: preset.to_owned(),
                known: Vec::new(),
            })
        })
    }

    /// A `map-backups` that always answers "none".
    fn no_backups() -> BackupsFn {
        Box::new(|_preset| Ok(Vec::new()))
    }

    /// A `slot-assign` that refuses everything — protocol tests that never
    /// re-wire. The refusal is the real one, so a test that DOES exercise the
    /// verb sees the shape a cabinet would.
    fn no_slot_assign() -> SlotAssignFn {
        Box::new(|spec| {
            Err(crate::slots::SlotError::UnknownPreset {
                preset: spec.preset.clone().unwrap_or_default(),
                available: Vec::new(),
            })
        })
    }

    /// A `stage-commit` writer that always refuses, so a test that reaches it
    /// says so loudly instead of touching a real config root.
    fn no_stage_commit() -> StageCommitFn {
        Box::new(|_spec| {
            Err(ksx_config::ConfigError::UnknownDeviceAlias(
                "this test daemon has no config root".to_owned(),
            ))
        })
    }

    fn no_stage_adopt() -> StageAdoptFn {
        Box::new(|_profile| {
            Err(ksx_api::Refusal::new(
                ksx_api::codes::REFUSED,
                "this test daemon has no config root to adopt from",
            ))
        })
    }

    fn deps(tx: Sender<DaemonCommand>, state: SharedState, profiles: ProfilesFn) -> PipeDeps {
        PipeDeps {
            tx,
            state,
            profiles,
            map: no_map(),
            save_macro: no_macro(),
            restore: no_restore(),
            clear_all: Box::new(|preset| {
                Err(crate::mapping::MapError::UnknownPreset {
                    name: preset.to_owned(),
                    known: Vec::new(),
                })
            }),
            backups: no_backups(),
            slot_assign: no_slot_assign(),
            // Records the spec it was handed and writes nothing, so every
            // staging refusal above it is exercised with no disk at all — and
            // so a test can assert that a REFUSED commit never reached the
            // writer, which "no file appeared" cannot prove.
            stage_commit: no_stage_commit(),
            stage_adopt: no_stage_adopt(),
            stage_capture_preflight: Box::new(|_| Ok(())),
            learn: idle_learn(),
            input_test: idle_input_test(),
        }
    }

    /// Play the control loop's `ApplyBindings` half: consume the command and
    /// write the verdict back into the snapshot, exactly as
    /// `daemon::apply_bindings` does.
    fn answer_apply(
        rx: crossbeam_channel::Receiver<DaemonCommand>,
        state: SharedState,
        report: super::super::ApplyReport,
    ) -> std::thread::JoinHandle<DaemonCommand> {
        std::thread::spawn(move || {
            let command = rx
                .recv_timeout(Duration::from_secs(2))
                .expect("a command was enqueued");
            if let Ok(mut s) = state.lock() {
                let generation = s.apply.as_ref().map_or(0, |a| a.generation) + 1;
                s.apply = Some(super::super::ApplyReport {
                    generation,
                    ..report
                });
            }
            command
        })
    }

    const FAST: Duration = Duration::from_millis(50);

    // -- protocol, no transport ---------------------------------------------

    #[test]
    fn status_reports_state_game_and_profiles() {
        let state = shared(RunState::Running { slots: 4 });
        {
            let mut snapshot = state.lock().unwrap();
            snapshot.game = Some("Example Game".into());
            snapshot.active = Some(super::super::ActiveSession {
                started: Instant::now() - Duration::from_secs(2),
                facts: super::super::ActiveSessionFacts {
                    keyboards: 2,
                    capture: "mapped keys captured · WinUSB + Interception".into(),
                    controllers: vec![
                        "P1 Xbox 360 (ViGEmBus)".into(),
                        "P2 DualSense (HIDMaestro)".into(),
                    ],
                },
            });
        }
        let (tx, _rx) = unbounded();
        let v = handle_request(
            r#"{"verb":"status"}"#,
            &deps(tx.clone(), state.clone(), fixed_profiles()),
            FAST,
        );
        assert_eq!(v["ok"], true);
        assert_eq!(v["run"], "running");
        assert_eq!(v["slots"], 4);
        assert_eq!(v["game"], "Example Game");
        assert_eq!(v["profiles"][1]["title"], "Metal Slug");
        assert!(v["active"]["elapsed_ms"].as_u64().unwrap() >= 2_000);
        assert_eq!(v["active"]["keyboards"], 2);
        assert_eq!(v["active"]["controllers"][1], "P2 DualSense (HIDMaestro)");
        assert!(v["tooltip"].as_str().unwrap().contains("running, 4 pad(s)"));
    }

    #[cfg(windows)]
    #[test]
    fn control_pipe_acl_is_creator_system_and_administrators_only() {
        let sddl = server::CONTROL_PIPE_SDDL;
        assert_eq!(sddl, "D:P(A;;GA;;;OW)(A;;GA;;;SY)(A;;GA;;;BA)");
        for broad_sid in ["WD", "AU", "BU", "IU"] {
            assert!(
                !sddl.contains(&format!(";;;{broad_sid})")),
                "unrelated low-privilege users must not drive daemon mutations: {sddl}"
            );
        }
        assert!(sddl.contains(";;;OW)"), "creator/owner access");
        assert!(sddl.contains(";;;SY)"), "SYSTEM access");
        assert!(
            sddl.contains(";;;BA)"),
            "a different credentialed administrator must be able to quiesce uninstall"
        );
    }

    #[test]
    fn quit_answers_only_after_daemon_main_marks_teardown_complete() {
        let state = shared(RunState::Running { slots: 4 });
        let (tx, rx) = unbounded();
        let shutdown = ShutdownHandshake::default();
        let worker_shutdown = shutdown.clone();
        let worker = std::thread::spawn(move || {
            handle_request_with_shutdown(
                r#"{"verb":"quit"}"#,
                &deps(tx, state, no_profiles()),
                Duration::from_secs(1),
                Some(&worker_shutdown),
            )
        });

        assert_eq!(
            rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            DaemonCommand::Quit
        );
        std::thread::sleep(Duration::from_millis(20));
        assert!(
            !worker.is_finished(),
            "enqueueing Quit must not be reported as completed teardown"
        );
        assert_eq!(shutdown.mark_daemon_stopped(), Some(true));
        let response = worker.join().unwrap();
        assert_eq!(response["ok"], true);
        assert_eq!(response["message"], "daemon stopped");
    }

    #[test]
    fn quit_timeout_and_nonfixed_payload_are_refusals() {
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let shutdown = ShutdownHandshake::default();
        let timed_out = handle_request_with_shutdown(
            r#"{"verb":"quit"}"#,
            &deps(tx.clone(), state.clone(), no_profiles()),
            Duration::from_millis(20),
            Some(&shutdown),
        );
        assert_eq!(timed_out["ok"], false);
        assert_eq!(timed_out["code"], "shutdown-timeout");

        let fixed = ShutdownHandshake::default();
        let extra = handle_request_with_shutdown(
            r#"{"verb":"quit","force":true}"#,
            &deps(tx, state, no_profiles()),
            FAST,
            Some(&fixed),
        );
        assert_eq!(extra["ok"], false);
        assert_eq!(extra["code"], "bad-request");
        assert!(!fixed.was_requested());
    }

    // -- the staged setup (docs/FIRST-RUN.md §2) ----------------------------

    /// Stage a device and a controller — with a real layout, so the pad it
    /// would plug does something — in the shape a surface sends.
    ///
    /// §3's question is deliberately NOT answered here: that is the state a
    /// visit is in between moments 5 and 6, and the tests below assert what it
    /// costs.
    fn stage_up(deps: &PipeDeps) {
        let chosen = handle_request(
            r#"{"verb":"stage-edit","edit":"choose-device","selector":"usb:d209:0430:00",
                "alias":"panel","label":"Ultimarc I-PAC 4"}"#,
            deps,
            FAST,
        );
        assert_eq!(chosen["ok"], true, "{chosen}");
        let added = handle_request(
            r#"{"verb":"stage-edit","edit":"add-slot","persona":"playstation",
                "preset":"Player 1","layout":"arcade-6button"}"#,
            deps,
            FAST,
        );
        assert_eq!(added["ok"], true, "{added}");
    }

    /// [`stage_up`] plus §3's answer — the smallest setup that may be saved or
    /// played.
    fn stage_ready(deps: &PipeDeps) {
        stage_up(deps);
        let answered = handle_request(
            r#"{"verb":"stage-edit","edit":"set-blocking","blocking":"bound-keys"}"#,
            deps,
            FAST,
        );
        assert_eq!(answered["ok"], true, "{answered}");
    }

    /// A one-slot setup the scripted [`StageAdoptFn`] hands back, standing in
    /// for `crate::stage::adopt`'s disk read (unit-tested in stage.rs).
    fn adopted_setup() -> ksx_core::StagedSetup {
        ksx_core::StagedSetup::new()
            .choose_device(ksx_core::stage::StagedDevice {
                selector: ksx_core::DeviceSelector::parse("usb:d209:0430:00").unwrap(),
                alias: "panel".to_owned(),
                label: "panel".to_owned(),
                backend: ksx_core::stage::StageCaptureBackend::Interception,
            })
            .unwrap()
            .add_slot(1, ksx_core::Persona::Xbox360, {
                ksx_core::Preset {
                    name: "Player 1".to_owned(),
                    entries: vec![(
                        ksx_core::Key::A,
                        ksx_core::preset::Binding::Button(ksx_core::pad::XButton::A),
                    )],
                    chords: Vec::new(),
                    macros: Default::default(),
                    turbo: Vec::new(),
                    toggle: Vec::new(),
                    protected: false,
                }
            })
            .unwrap()
            .set_blocking(ksx_core::Blocking::BoundKeys)
    }

    /// **`stage-adopt` fills an empty stage and refuses over a proposal.**
    ///
    /// The refusal half is the load-bearing one: the everyday screen adopts on
    /// arrival, and a daemon that let that adoption overwrite a half-made
    /// setup from another tab would eat the exact edits staging exists to
    /// protect. Fails against a handler that skipped the empty-stage guard.
    #[test]
    fn stage_adopt_fills_an_empty_stage_and_refuses_over_a_proposal() {
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let mut d = deps(tx, state.clone(), fixed_profiles());
        d.stage_adopt = Box::new(|profile| match profile {
            None => Ok(adopted_setup()),
            Some("Fight Night") => Ok(adopted_setup()),
            Some(other) => Err(ksx_api::Refusal::new(
                ksx_api::codes::REFUSED,
                format!("no saved game is called \"{other}\""),
            )),
        });

        let adopted = handle_request(r#"{"verb":"stage-adopt"}"#, &d, FAST);
        assert_eq!(adopted["ok"], true, "{adopted}");
        assert_eq!(adopted["setup"]["dirty"], false, "{adopted}");
        assert_eq!(adopted["setup"]["origin"], "config", "{adopted}");
        assert_eq!(adopted["setup"]["slots"][0]["preset"], "Player 1");

        // The stage is now a proposal; adopting again must refuse and hand
        // the proposal back untouched.
        let refused = handle_request(r#"{"verb":"stage-adopt"}"#, &d, FAST);
        assert_eq!(refused["ok"], false, "{refused}");
        assert_eq!(refused["code"], "stage-not-empty", "{refused}");
        assert_eq!(refused["setup"]["slots"][0]["preset"], "Player 1");

        // The profile spelling reaches the reader, and its origin says which
        // game the draft came from.
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let mut d = deps(tx, state, fixed_profiles());
        d.stage_adopt = Box::new(|profile| match profile {
            Some("Fight Night") => Ok(adopted_setup()),
            other => Err(ksx_api::Refusal::new(
                ksx_api::codes::REFUSED,
                format!("unexpected profile {other:?}"),
            )),
        });
        let by_game = handle_request(
            r#"{"verb":"stage-adopt","profile":"Fight Night"}"#,
            &d,
            FAST,
        );
        assert_eq!(by_game["ok"], true, "{by_game}");
        assert_eq!(
            by_game["setup"]["origin"], "profile:Fight Night",
            "{by_game}"
        );
    }

    /// **The dirty flag is the daemon's, and it moves with the writes**: an
    /// edit marks the draft dirty, Start over resets it, and a successful
    /// Save cleans it with the origin becoming the file the draft just
    /// became. Fails against a view that composed `dirty` client-side — the
    /// exact drift `StagedSetupView`'s field docs forbid.
    #[test]
    fn stage_edits_mark_the_draft_dirty_and_start_over_or_save_clean_it() {
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let mut d = deps(tx, state.clone(), fixed_profiles());
        d.stage_commit = Box::new(|spec| {
            Ok(crate::stage::Committed {
                config: std::path::PathBuf::from("C:/cfg/config.toml"),
                backup: None,
                presets: Vec::new(),
                preset_backups: Vec::new(),
                alias: spec.device.alias.clone(),
                slots: spec.slots.iter().map(|s| s.spec.number).collect(),
            })
        });

        let view = handle_request(r#"{"verb":"stage"}"#, &d, FAST);
        assert_eq!(view["setup"]["dirty"], false, "a fresh visit is clean");

        stage_ready(&d);
        let view = handle_request(r#"{"verb":"stage"}"#, &d, FAST);
        assert_eq!(
            view["setup"]["dirty"], true,
            "edits dirty the draft: {view}"
        );

        let saved = handle_request(r#"{"verb":"stage-commit"}"#, &d, FAST);
        assert_eq!(saved["ok"], true, "{saved}");
        assert_eq!(saved["setup"]["dirty"], false, "Save cleans: {saved}");
        assert_eq!(saved["setup"]["origin"], "config", "{saved}");

        let edited = handle_request(
            r#"{"verb":"stage-edit","edit":"set-blocking","blocking":"whole"}"#,
            &d,
            FAST,
        );
        assert_eq!(edited["setup"]["dirty"], true, "{edited}");
        assert_eq!(
            edited["setup"]["origin"], "config",
            "editing does not change where the draft came from: {edited}"
        );

        let fresh = handle_request(r#"{"verb":"stage-edit","edit":"discard"}"#, &d, FAST);
        assert_eq!(
            fresh["setup"]["dirty"], false,
            "Start over is clean: {fresh}"
        );
        assert_eq!(fresh["setup"]["origin"], "", "{fresh}");
    }

    /// SOCD and reorder land over the wire as ordinary stage edits, with the
    /// view carrying the canonical name AND its served label, and the refusal
    /// codes a surface routes on.
    #[test]
    fn socd_and_reorder_land_over_the_wire() {
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let d = deps(tx, state, fixed_profiles());
        stage_up(&d);
        let added = handle_request(
            r#"{"verb":"stage-edit","edit":"add-slot","persona":"xbox360",
                "preset":"Player 2","layout":"arcade-6button"}"#,
            &d,
            FAST,
        );
        assert_eq!(added["ok"], true, "{added}");

        let socd = handle_request(
            r#"{"verb":"stage-edit","edit":"set-socd","number":2,"socd":"up-priority"}"#,
            &d,
            FAST,
        );
        assert_eq!(socd["ok"], true, "{socd}");
        assert_eq!(socd["setup"]["slots"][1]["socd"], "up-priority", "{socd}");
        assert_eq!(socd["setup"]["slots"][1]["socd_label"], "Up wins", "{socd}");

        let unknown = handle_request(
            r#"{"verb":"stage-edit","edit":"set-socd","number":2,"socd":"sideways"}"#,
            &d,
            FAST,
        );
        assert_eq!(unknown["ok"], false, "{unknown}");
        assert_eq!(unknown["code"], ksx_api::codes::BAD_REQUEST, "{unknown}");

        let reordered = handle_request(
            r#"{"verb":"stage-edit","edit":"reorder-slots","numbers":[2,1]}"#,
            &d,
            FAST,
        );
        assert_eq!(reordered["ok"], true, "{reordered}");
        assert_eq!(
            reordered["setup"]["slots"][0]["preset"], "Player 2",
            "{reordered}"
        );
        assert_eq!(reordered["setup"]["slots"][0]["number"], 1, "{reordered}");
        assert_eq!(
            reordered["setup"]["slots"][0]["socd"], "up-priority",
            "SOCD moved with its controller: {reordered}"
        );

        let bad = handle_request(
            r#"{"verb":"stage-edit","edit":"reorder-slots","numbers":[1,1]}"#,
            &d,
            FAST,
        );
        assert_eq!(bad["ok"], false, "{bad}");
        assert_eq!(bad["code"], "bad-reorder", "{bad}");
    }

    /// Build N deliberately blank staged controllers. Blank layouts keep the
    /// concurrency assertions about only the keys each thread writes, while
    /// the normal stage-edit path still validates and owns the setup.
    fn stage_blank_slots(deps: &PipeDeps, count: u8) {
        let chosen = handle_request(
            r#"{"verb":"stage-edit","edit":"choose-device","selector":"usb:d209:0430:00",
                "alias":"panel","label":"I-PAC"}"#,
            deps,
            FAST,
        );
        assert_eq!(chosen["ok"], true, "{chosen}");
        for number in 1..=count {
            let added = handle_request(
                &format!(
                    r#"{{"verb":"stage-edit","edit":"add-slot","number":{number},
                        "persona":"playstation","preset":"P{number}"}}"#
                ),
                deps,
                FAST,
            );
            assert_eq!(added["ok"], true, "{added}");
        }
    }

    /// **The whole point of §2, over the wire: staging writes nothing and
    /// starts nothing.**
    ///
    /// Breaks against a daemon that answered a persona choice by calling
    /// `slot-assign` (which is what the pre-staging design did): the writer
    /// would be reached, and this fixture's writer refuses in a sentence naming
    /// the test daemon's missing config root, so the outcome would not be `ok`.
    /// It also breaks against any handler that enqueued a command — nothing
    /// about choosing a controller may reach the control loop.
    #[test]
    fn staging_holds_the_setup_in_the_daemon_and_touches_nothing_else() {
        let state = shared(RunState::Stopped);
        let (tx, rx) = unbounded();
        let deps = deps(tx, state.clone(), no_profiles());
        stage_up(&deps);

        // It is HELD: a second, independent request sees it.
        let view = handle_request(r#"{"verb":"stage"}"#, &deps, FAST);
        assert_eq!(view["ok"], true, "{view}");
        assert_eq!(view["setup"]["device"]["label"], "Ultimarc I-PAC 4");
        assert_eq!(view["setup"]["device"]["selector"], "usb:d209:0430:00");
        assert_eq!(view["setup"]["slots"][0]["number"], 1);
        assert_eq!(view["setup"]["slots"][0]["persona"], "playstation");
        // The layout came back as real bindings, held in the daemon, with no
        // file anywhere — §2's "the bindings so far" is a thing the stage can
        // actually hold rather than a field nobody fills.
        assert!(
            view["setup"]["slots"][0]["bindings"].as_u64().unwrap() > 10,
            "{view}"
        );
        // ...and it is still NOT ready, because §3 has not been asked. That is
        // the difference between "the setup is complete" and "the setup is
        // complete except for the one question that decides whether this
        // keyboard can still type".
        assert_eq!(view["setup"]["ready"], false);
        assert!(
            view["setup"]["not_ready"]
                .as_str()
                .unwrap()
                .contains("split-or-freeze"),
            "{view}"
        );
        // The ceilings and the roster are SERVED, so no surface has to know
        // them (docs/CLAUDE.md's one rule).
        assert_eq!(view["setup"]["max_slots"], ksx_core::MAX_SLOTS);
        assert_eq!(
            view["setup"]["max_xinput_slots"],
            ksx_core::MAX_XINPUT_SLOTS
        );
        assert_eq!(
            view["setup"]["personas"].as_array().unwrap().len(),
            ksx_core::Persona::ALL.len()
        );
        // §3 has not been asked, and that is not the same as "whole".
        assert_eq!(view["setup"]["blocking"], serde_json::Value::Null);

        // Answering it — and only that — completes the setup.
        handle_request(
            r#"{"verb":"stage-edit","edit":"set-blocking","blocking":"bound-keys"}"#,
            &deps,
            FAST,
        );
        let view = handle_request(r#"{"verb":"stage"}"#, &deps, FAST);
        assert_eq!(view["setup"]["ready"], true, "{view}");
        assert_eq!(view["setup"]["not_ready"], serde_json::Value::Null);

        // Nothing was enqueued and no session state moved.
        assert!(rx.try_recv().is_err(), "staging enqueues nothing");
        assert_eq!(state.lock().unwrap().run, RunState::Stopped);
    }

    /// A refused edit leaves the held setup exactly as it was, and says why in
    /// ksx-core's own words.
    ///
    /// Breaks against a handler that stored the edit before validating it (or
    /// that validated against a clone and stored anyway): the fifth Xbox slot
    /// would be in the daemon's state, and the next `stage` read would show a
    /// slot the user was just told they could not have.
    #[test]
    fn a_refused_edit_leaves_the_held_setup_untouched() {
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let deps = deps(tx, state.clone(), no_profiles());
        handle_request(
            r#"{"verb":"stage-edit","edit":"choose-device","selector":"usb:d209:0430:00",
                "alias":"panel","label":"I-PAC"}"#,
            &deps,
            FAST,
        );
        for n in 1..=4 {
            let added = handle_request(
                &format!(
                    r#"{{"verb":"stage-edit","edit":"add-slot","number":{n},
                        "persona":"xbox360","preset":"P{n}"}}"#
                ),
                &deps,
                FAST,
            );
            assert_eq!(added["ok"], true, "{added}");
        }
        let refused = handle_request(
            r#"{"verb":"stage-edit","edit":"add-slot","number":5,"persona":"xbox360","preset":"P5"}"#,
            &deps,
            FAST,
        );
        assert_eq!(refused["ok"], false, "{refused}");
        assert_eq!(refused["code"], "too-many-xinput-slots");
        assert!(
            refused["error"].as_str().unwrap().contains("is_xinput()"),
            "{refused}"
        );
        // The answer carries the setup the caller STILL HAS — four slots.
        assert_eq!(refused["setup"]["slots"].as_array().unwrap().len(), 4);
        assert_eq!(refused["setup"]["xinput_used"], 4);
        // ...and so does the daemon.
        assert_eq!(state.lock().unwrap().staged.slots().len(), 4);

        // A word this build cannot parse is a DIFFERENT failure, and carries a
        // different code.
        let typo = handle_request(
            r#"{"verb":"stage-edit","edit":"add-slot","persona":"gamecube","preset":"P5"}"#,
            &deps,
            FAST,
        );
        assert_eq!(typo["code"], ksx_api::codes::BAD_REQUEST, "{typo}");
    }

    #[test]
    fn stale_stage_bind_and_macro_slots_are_refused_without_touching_slot_one() {
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let deps = deps(tx, state.clone(), no_profiles());
        stage_blank_slots(&deps, 1);
        let before = state.lock().unwrap().staged.clone();

        let bind = handle_request(
            r#"{"verb":"stage-bind","number":9,"preset":"P9","function":"A","keys":["G"]}"#,
            &deps,
            FAST,
        );
        assert_eq!(bind["ok"], false, "{bind}");
        assert_eq!(bind["code"], ksx_api::codes::BAD_SLOT, "{bind}");

        let mac = handle_request(
            r#"{"verb":"stage-macro","number":9,"preset":"P1","name":"m",
                "steps":[{"hold":["A"],"ms":50}]}"#,
            &deps,
            FAST,
        );
        assert_eq!(mac["ok"], false, "{mac}");
        assert_eq!(mac["code"], ksx_api::codes::BAD_SLOT, "{mac}");
        assert_eq!(
            state.lock().unwrap().staged,
            before,
            "neither stale target may be redirected to the first slot"
        );
    }

    #[test]
    fn served_stage_target_revisions_track_incarnation_device_and_each_successful_bind() {
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let deps = deps(tx, state.clone(), no_profiles());
        stage_blank_slots(&deps, 1);
        let served = handle_request(r#"{"verb":"stage"}"#, &deps, FAST);
        let first = served["setup"]["slots"][0]["target_revision"]
            .as_str()
            .expect("served target revision")
            .to_owned();
        assert!(first.starts_with("d1-"), "{served}");

        let bound = handle_request(
            &serde_json::json!({
                "verb": "stage-bind",
                "number": 1,
                "expected_target_revision": first.clone(),
                "preset": "P1",
                "function": "A",
                "keys": ["G"],
            })
            .to_string(),
            &deps,
            FAST,
        );
        assert_eq!(bound["ok"], true, "{bound}");
        let served = handle_request(r#"{"verb":"stage"}"#, &deps, FAST);
        let second = served["setup"]["slots"][0]["target_revision"]
            .as_str()
            .expect("post-bind target revision")
            .to_owned();
        assert_ne!(second, first, "a chain needs a fresh post-write token");
        let chained = handle_request(
            &serde_json::json!({
                "verb": "stage-bind",
                "number": 1,
                "expected_target_revision": second.clone(),
                "preset": "P1",
                "function": "B",
                "keys": ["H"],
            })
            .to_string(),
            &deps,
            FAST,
        );
        assert_eq!(chained["ok"], true, "{chained}");

        let before_device = handle_request(r#"{"verb":"stage"}"#, &deps, FAST);
        let before_device = before_device["setup"]["slots"][0]["target_revision"]
            .as_str()
            .unwrap()
            .to_owned();
        let changed = handle_request(
            r#"{"verb":"stage-edit","edit":"choose-device","selector":"usb:1234:5678:00",
                "alias":"replacement","label":"Keyboard B"}"#,
            &deps,
            FAST,
        );
        assert_eq!(changed["ok"], true, "{changed}");
        assert_ne!(
            changed["setup"]["slots"][0]["target_revision"], before_device,
            "a device-only draft mutation must stale an armed mapping"
        );

        let removed = handle_request(
            r#"{"verb":"stage-edit","edit":"remove-slot","number":1}"#,
            &deps,
            FAST,
        );
        assert_eq!(removed["ok"], true, "{removed}");
        let recreated = handle_request(
            r#"{"verb":"stage-edit","edit":"add-slot","number":1,
                "persona":"playstation","preset":"P1"}"#,
            &deps,
            FAST,
        );
        assert_eq!(recreated["ok"], true, "{recreated}");
        assert_ne!(
            recreated["setup"]["slots"][0]["target_revision"], before_device,
            "an identical slot incarnation must never reuse its old token"
        );
        let stale = handle_request(
            &serde_json::json!({
                "verb": "stage-bind",
                "number": 1,
                "expected_target_revision": before_device.clone(),
                "preset": "P1",
                "function": "X",
                "keys": ["J"],
            })
            .to_string(),
            &deps,
            FAST,
        );
        assert_eq!(stale["ok"], false, "{stale}");
        assert_eq!(stale["code"], ksx_api::codes::BAD_SLOT, "{stale}");
    }

    #[test]
    fn concurrent_same_slot_stage_binds_merge_without_lost_updates() {
        // Repeated starts make thread scheduling irrelevant to the assertion:
        // every round begins empty and both writes must be present after the
        // two transactions complete, whichever lock acquisition wins first.
        for round in 0..16 {
            let state = shared(RunState::Stopped);
            let (tx, _rx) = unbounded();
            let deps = deps(tx, state.clone(), no_profiles());
            stage_blank_slots(&deps, 1);
            let barrier = Arc::new(Barrier::new(3));
            let spawn = |function: &'static str,
                         key: &'static str,
                         state: SharedState,
                         barrier: Arc<Barrier>| {
                std::thread::spawn(move || {
                    barrier.wait();
                    stage_bind(
                        &ksx_api::StagedBindRequest {
                            number: 1,
                            preset: "P1".into(),
                            function: function.into(),
                            keys: vec![key.into()],
                            ..ksx_api::StagedBindRequest::default()
                        },
                        &state,
                    )
                })
            };
            let a = spawn("A", "G", state.clone(), barrier.clone());
            let b = spawn("B", "H", state.clone(), barrier.clone());
            barrier.wait();
            assert!(a.join().unwrap().ok, "round {round}: A write refused");
            assert!(b.join().unwrap().ok, "round {round}: B write refused");

            let setup = ksx_api::StagedSetupView::of(&state.lock().unwrap().staged);
            let mapper = ksx_api::staged_mapper_snapshot(&setup);
            let bindings = &mapper.slots[0].bindings;
            assert_eq!(
                bindings.get("A"),
                Some(&vec!["G".to_owned()]),
                "round {round}"
            );
            assert_eq!(
                bindings.get("B"),
                Some(&vec!["H".to_owned()]),
                "round {round}"
            );
        }
    }

    #[test]
    fn concurrent_unforced_cross_slot_duplicate_allows_exactly_one_writer() {
        for round in 0..16 {
            let state = shared(RunState::Stopped);
            let (tx, _rx) = unbounded();
            let deps = deps(tx, state.clone(), no_profiles());
            stage_blank_slots(&deps, 2);
            let barrier = Arc::new(Barrier::new(3));
            let spawn =
                |number: u8, function: &'static str, state: SharedState, barrier: Arc<Barrier>| {
                    std::thread::spawn(move || {
                        barrier.wait();
                        stage_bind(
                            &ksx_api::StagedBindRequest {
                                number,
                                preset: format!("P{number}"),
                                function: function.into(),
                                keys: vec!["G".into()],
                                force: false,
                                ..ksx_api::StagedBindRequest::default()
                            },
                            &state,
                        )
                    })
                };
            let one = spawn(1, "A", state.clone(), barrier.clone());
            let two = spawn(2, "B", state.clone(), barrier.clone());
            barrier.wait();
            let outcomes = [one.join().unwrap(), two.join().unwrap()];
            assert_eq!(
                outcomes.iter().filter(|outcome| outcome.ok).count(),
                1,
                "round {round}: {outcomes:?}"
            );
            let refused = outcomes.iter().find(|outcome| !outcome.ok).unwrap();
            assert_eq!(refused.code.as_deref(), Some(ksx_api::codes::CONFLICT));

            let setup = ksx_api::StagedSetupView::of(&state.lock().unwrap().staged);
            let mapper = ksx_api::staged_mapper_snapshot(&setup);
            let owners = mapper
                .slots
                .iter()
                .flat_map(|slot| slot.bindings.values())
                .flatten()
                .filter(|key| key.eq_ignore_ascii_case("G"))
                .count();
            assert_eq!(owners, 1, "round {round}: duplicate crossed slots");
        }
    }

    /// Removing a staged controller is free and complete, and "Start over"
    /// always works.
    #[test]
    fn removing_and_discarding_leave_no_trace() {
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let deps = deps(tx, state.clone(), no_profiles());
        stage_up(&deps);

        let removed = handle_request(
            r#"{"verb":"stage-edit","edit":"remove-slot","number":1}"#,
            &deps,
            FAST,
        );
        assert_eq!(removed["ok"], true, "{removed}");
        assert!(
            removed["message"]
                .as_str()
                .unwrap()
                .contains("removed from this setup"),
            "{removed}"
        );
        assert!(removed["setup"]["slots"].as_array().unwrap().is_empty());
        // The device survives: deleting a controller is not starting over.
        assert_eq!(removed["setup"]["device"]["alias"], "panel");

        let over = handle_request(r#"{"verb":"stage-edit","edit":"discard"}"#, &deps, FAST);
        assert_eq!(over["ok"], true, "{over}");
        assert_eq!(over["setup"]["empty"], true);
        assert!(state.lock().unwrap().staged.is_empty());
    }

    /// Saving an incomplete setup is refused **before the writer is reached**,
    /// in the same sentence the view was already showing as `not_ready`.
    ///
    /// Breaks against a handler that called the writer first and let it fail:
    /// this fixture's writer refuses with "this test daemon has no config
    /// root", which is a true sentence about the wrong thing — and on a real
    /// machine that ordering writes a `[[device]]` for a setup with no
    /// controller in it.
    #[test]
    fn saving_an_incomplete_setup_never_reaches_the_writer() {
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let deps = deps(tx, state.clone(), no_profiles());

        // No device, no controller.
        let empty = handle_request(r#"{"verb":"stage-commit"}"#, &deps, FAST);
        assert_eq!(empty["ok"], false, "{empty}");
        assert_eq!(empty["code"], "no-device");
        assert_eq!(empty["saved"], serde_json::Value::Null);

        // A device but no controller — and the refusal is the sentence the
        // view was already carrying, so Save cannot surprise anyone.
        handle_request(
            r#"{"verb":"stage-edit","edit":"choose-device","selector":"usb:d209:0430:00",
                "alias":"panel","label":"I-PAC"}"#,
            &deps,
            FAST,
        );
        let view = handle_request(r#"{"verb":"stage"}"#, &deps, FAST);
        assert_eq!(view["setup"]["ready"], false);
        let refused = handle_request(r#"{"verb":"stage-commit"}"#, &deps, FAST);
        assert_eq!(refused["code"], "no-slots");
        assert_eq!(
            refused["error"], view["setup"]["not_ready"],
            "Save must refuse in the words the screen was already showing"
        );
    }

    /// A successful first-run Save immediately unlocks the operate-only tray
    /// actions. Requiring a daemon restart here would leave the cabinet item
    /// gray even though the setup it needs is already on disk.
    #[test]
    fn saving_the_first_setup_marks_cabinet_controls_ready() {
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let mut deps = deps(tx, state.clone(), no_profiles());
        deps.stage_commit = Box::new(|_| {
            Ok(crate::stage::Committed {
                config: std::path::PathBuf::from(r"C:\cfg\config.toml"),
                backup: None,
                presets: vec![std::path::PathBuf::from(r"C:\cfg\presets\P1.toml")],
                preset_backups: Vec::new(),
                alias: "panel".to_owned(),
                slots: vec![1],
            })
        });
        stage_ready(&deps);

        assert!(!state.lock().unwrap().cabinet_ready);
        let saved = handle_request(r#"{"verb":"stage-commit"}"#, &deps, FAST);
        assert_eq!(saved["ok"], true, "{saved}");
        let menu = state.lock().unwrap().menu();
        assert!(menu[1].2, "cabinet controls should unlock after Save");
        assert!(
            menu[2].2,
            "the saved setup should be startable from the tray"
        );
    }

    /// **Play without saving**: the staged setup reaches the control loop as
    /// `PlayStaged`, carrying the whole spec, and the answer claims no file.
    ///
    /// Breaks against two shortcuts. A `stage-play` that saved first and then
    /// sent an ordinary `Start` would enqueue the wrong command AND leave a
    /// config the user never asked for — §2's "the user may leave without
    /// saving and lose only what they typed" would be false. And a
    /// `PlayStaged` that carried only a flag would reach a control loop with
    /// nowhere to read the setup from, because it is not on disk.
    #[test]
    fn playing_a_staged_setup_carries_the_whole_spec_and_writes_nothing() {
        let state = shared(RunState::Stopped);
        let (tx, rx) = unbounded();
        let deps = deps(tx, state.clone(), no_profiles());
        stage_ready(&deps);

        let worker = std::thread::spawn({
            let state = state.clone();
            move || {
                let command = rx.recv_timeout(Duration::from_secs(1)).unwrap();
                state.lock().unwrap().run = RunState::Running { slots: 1 };
                command
            }
        });
        let played = handle_request(r#"{"verb":"stage-play"}"#, &deps, Duration::from_secs(2));
        assert_eq!(played["ok"], true, "{played}");
        assert_eq!(played["playing"], true);
        // NEVER a path: playing writes nothing, and saying otherwise would be a
        // claim about the disk this verb did not make.
        assert_eq!(played["saved"], serde_json::Value::Null);
        assert_eq!(played["backup"], serde_json::Value::Null);
        // ...and the staged setup is still staged, so a user can go on editing.
        assert_eq!(played["setup"]["slots"][0]["persona"], "playstation");

        let DaemonCommand::PlayStaged(spec) = worker.join().unwrap() else {
            panic!("stage-play must enqueue PlayStaged, not Start");
        };
        assert_eq!(spec.slots.len(), 1);
        assert_eq!(spec.slots[0].spec.persona, ksx_core::Persona::PlayStation);
        assert_eq!(
            spec.slots[0].spec.keyboard.as_ref().map(|k| k.as_str()),
            Some("usb:d209:0430:00"),
            "the staged slot names the staged board, by selector"
        );
    }

    // -- stage-apply: the draft into a LIVE session, hot or refused ----------

    /// The happy half: a running session, a ready draft, and a control loop
    /// that answers "hot". The verb enqueues `ApplyStaged` with the WHOLE spec
    /// (the setup is not on disk), claims no file, and leaves the stage staged
    /// — applying is not saving, and the dirty flag must not move.
    #[test]
    fn applying_a_staged_draft_enqueues_the_spec_and_claims_no_file() {
        let state = shared(RunState::Running { slots: 1 });
        let (tx, rx) = unbounded();
        let deps = deps(tx, state.clone(), no_profiles());
        stage_ready(&deps);
        // The stage has been edited, so the visit is dirty — and must STAY so.
        assert!(snapshot(&state).stage_meta.dirty);

        let loop_thread = answer_apply(
            rx,
            state.clone(),
            super::super::ApplyReport {
                generation: 0,
                ok: true,
                hot: true,
                restarted: false,
                needs_restart: false,
                message: "the draft's bindings are live — pads untouched".to_owned(),
            },
        );
        let applied = handle_request(r#"{"verb":"stage-apply"}"#, &deps, Duration::from_secs(2));
        assert_eq!(applied["ok"], true, "{applied}");
        assert_eq!(applied["playing"], true, "{applied}");
        assert!(
            applied["message"]
                .as_str()
                .unwrap()
                .contains("pads untouched"),
            "{applied}"
        );
        // NEVER a path: applying writes nothing.
        assert_eq!(applied["saved"], serde_json::Value::Null);
        assert_eq!(applied["backup"], serde_json::Value::Null);
        // Applying is not saving: the draft is still here, still unsaved.
        assert_eq!(applied["setup"]["empty"], false);
        assert_eq!(applied["setup"]["dirty"], true, "{applied}");

        let DaemonCommand::ApplyStaged(spec) = loop_thread.join().unwrap() else {
            panic!("stage-apply must enqueue ApplyStaged, not ApplyBindings or a start");
        };
        assert_eq!(spec.slots.len(), 1);
    }

    /// The structural refusal carries the stable `needs-restart` code, the
    /// difference in the message, and the replace verb as the remedy — the
    /// three things a surface needs to offer the honest next step.
    #[test]
    fn a_structural_apply_answers_needs_restart_with_the_replace_remedy() {
        let state = shared(RunState::Running { slots: 1 });
        let (tx, rx) = unbounded();
        let deps = deps(tx, state.clone(), no_profiles());
        stage_ready(&deps);

        let loop_thread = answer_apply(
            rx,
            state.clone(),
            super::super::ApplyReport {
                generation: 0,
                ok: false,
                hot: false,
                restarted: false,
                needs_restart: true,
                message: "the draft cannot go into the running session: the slot count changed \
                          (1 → 2), and that means replugging the pads — nothing changed; Play \
                          replaces the session"
                    .to_owned(),
            },
        );
        let refused = handle_request(r#"{"verb":"stage-apply"}"#, &deps, Duration::from_secs(2));
        assert_eq!(refused["ok"], false, "{refused}");
        assert_eq!(refused["code"], "needs-restart", "{refused}");
        assert!(
            refused["error"]
                .as_str()
                .unwrap()
                .contains("the slot count changed"),
            "{refused}"
        );
        assert!(
            refused["remedy"].as_str().unwrap().contains("stage-play"),
            "{refused}"
        );
        assert!(matches!(
            loop_thread.join().unwrap(),
            DaemonCommand::ApplyStaged(_)
        ));
    }

    /// With nothing running there is no session to apply into, and no disk
    /// for "the next start" to read the draft from — refused before anything
    /// is enqueued, with Play as the remedy.
    #[test]
    fn applying_with_nothing_running_is_refused_before_anything_is_enqueued() {
        let state = shared(RunState::Stopped);
        let (tx, rx) = unbounded();
        let deps = deps(tx, state, no_profiles());
        stage_ready(&deps);

        let refused = handle_request(r#"{"verb":"stage-apply"}"#, &deps, FAST);
        assert_eq!(refused["ok"], false, "{refused}");
        assert!(
            refused["error"]
                .as_str()
                .unwrap()
                .contains("nothing is running"),
            "{refused}"
        );
        assert!(
            refused["remedy"].as_str().unwrap().contains("stage-play"),
            "{refused}"
        );
        assert!(rx.try_recv().is_err(), "nothing may be enqueued");
    }

    /// An incomplete draft refuses with the stage's own sentence — same words
    /// as `stage-play` would give — and enqueues nothing.
    #[test]
    fn applying_an_incomplete_stage_is_refused_with_the_stages_own_words() {
        let state = shared(RunState::Running { slots: 1 });
        let (tx, rx) = unbounded();
        let deps = deps(tx, state, no_profiles());
        // Nothing staged at all: commit() has a refusal for that.

        let refused = handle_request(r#"{"verb":"stage-apply"}"#, &deps, FAST);
        assert_eq!(refused["ok"], false, "{refused}");
        assert!(rx.try_recv().is_err(), "nothing may be enqueued");
    }

    // -- pause and resume (docs/FIRST-RUN.md §2, §6) -------------------------
    //
    // The mapper refuses to learn while a session runs, and answers that with
    // one click: "Pause emulation & map", then "Resume emulation". Both of
    // these drive the REAL control loop, because the bug they pin is not in
    // any one handler — it is in which command comes out the other end.

    /// A session that blocks until the control loop stops it, like a real one.
    struct BlockingSession;

    impl super::super::SessionRunner for BlockingSession {
        fn run(
            &mut self,
            stop: Arc<std::sync::atomic::AtomicBool>,
            _out: &mut dyn std::io::Write,
        ) -> anyhow::Result<super::super::SessionSummary> {
            while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(5));
            }
            Ok(super::super::SessionSummary {
                stop_code: "daemon-stop".into(),
                message: "stopped from the pipe".into(),
                ..Default::default()
            })
        }

        fn slots(&self) -> usize {
            1
        }
    }

    /// A factory that CAN run a staged setup and records what it was last
    /// pointed at — which is the fact the whole pause/resume question is
    /// about. `LiveFactory` keeps the same value in the same field; this makes
    /// it readable from a test without a config root or a driver.
    struct RecordingFactory {
        staged: Arc<Mutex<Option<ksx_core::CommitSpec>>>,
        game: Arc<Mutex<Option<String>>>,
        /// How many sessions this factory has been asked to build. A refused
        /// resume must not move it — "the run state is still Stopped" would
        /// also be true of a session that started and died.
        makes: Arc<Mutex<u32>>,
    }

    impl super::super::SessionFactory for RecordingFactory {
        fn make(&mut self) -> anyhow::Result<Box<dyn super::super::SessionRunner>> {
            *self.makes.lock().unwrap() += 1;
            Ok(Box::new(BlockingSession))
        }

        fn config_dir(&self) -> std::path::PathBuf {
            std::path::PathBuf::from(r"C:\cfg\ksx")
        }

        fn game(&self) -> Option<String> {
            self.game.lock().unwrap().clone()
        }

        fn set_game(&mut self, game: Option<String>) {
            *self.game.lock().unwrap() = game;
        }

        fn set_staged(&mut self, spec: Option<ksx_core::CommitSpec>) -> bool {
            *self.staged.lock().unwrap() = spec;
            true
        }
    }

    /// A daemon whose control loop is really running, with the two values a
    /// pause/resume test has to read afterwards.
    struct RunningDaemon {
        deps: PipeDeps,
        state: SharedState,
        tx: Sender<DaemonCommand>,
        /// What the factory is pointed at: `Some` = a staged setup, `None` =
        /// the config on disk.
        staged: Arc<Mutex<Option<ksx_core::CommitSpec>>>,
        game: Arc<Mutex<Option<String>>>,
        makes: Arc<Mutex<u32>>,
        loop_thread: Option<std::thread::JoinHandle<()>>,
    }

    impl RunningDaemon {
        fn start(game: Option<String>) -> Self {
            let (tx, rx) = unbounded();
            let state: SharedState = Arc::new(Mutex::new(DaemonState::default()));
            let staged = Arc::new(Mutex::new(None));
            let game = Arc::new(Mutex::new(game));
            let makes = Arc::new(Mutex::new(0));
            let loop_thread = std::thread::spawn({
                let (state, staged, game) = (state.clone(), staged.clone(), game.clone());
                let makes = makes.clone();
                move || {
                    let mut factory = RecordingFactory {
                        staged,
                        game,
                        makes,
                    };
                    let mut out: Vec<u8> = Vec::new();
                    super::super::control_loop_with(
                        rx,
                        state,
                        &mut factory,
                        &mut super::super::NoPanel,
                        &super::super::NoUi,
                        &mut out,
                    );
                }
            });
            Self {
                deps: deps(tx.clone(), state.clone(), no_profiles()),
                state,
                tx,
                staged,
                game,
                makes,
                loop_thread: Some(loop_thread),
            }
        }

        fn ask(&self, line: &str) -> serde_json::Value {
            handle_request(line, &self.deps, Duration::from_secs(2))
        }
    }

    impl Drop for RunningDaemon {
        fn drop(&mut self) {
            let _ = self.tx.send(DaemonCommand::Quit);
            if let Some(thread) = self.loop_thread.take() {
                let _ = thread.join();
            }
        }
    }

    /// **THE PAUSE/RESUME TEST.** Play an unsaved staged setup, pause it in
    /// the mapper, change it while paused, resume — and what comes back is
    /// THAT setup, with the change in it, still unsaved and still staged.
    ///
    /// Breaks against the shipped Resume, which posted `start` with the
    /// games.toml profile the mapper had remembered — `None` for a staged
    /// session, because a staged session has no profile. `start` is defined as
    /// THE CONFIG ON DISK and its arm clears the staged override to keep that
    /// true, so against that version this test fails twice over: the factory
    /// ends up pointed at `None` rather than at the setup, and on a first-run
    /// machine with nothing in `config.toml` the start finds nothing to run at
    /// all — which is the toast the owner saw.
    ///
    /// It drives the real `control_loop_with`, because the defect is in which
    /// command reaches it: a test that only inspected this module's answer
    /// would have passed against the broken version.
    #[test]
    fn resuming_a_paused_staged_session_puts_that_setup_back_with_its_edits() {
        let daemon = RunningDaemon::start(None);
        stage_ready(&daemon.deps);

        // Moment 7: play it, with nothing written.
        let played = daemon.ask(r#"{"verb":"stage-play"}"#);
        assert_eq!(played["ok"], true, "{played}");
        assert_eq!(played["playing"], true, "{played}");
        assert_eq!(
            daemon.state.lock().unwrap().origin,
            ksx_api::SessionOrigin::Staged,
            "the daemon must record WHAT it started, or nothing can put it back"
        );

        // "Pause emulation & map".
        let paused = daemon.ask(r#"{"verb":"stop"}"#);
        assert_eq!(paused["ok"], true, "{paused}");

        // ...and an edit made while paused, which is the whole reason anyone
        // pauses: this one is visible in the spec the factory receives.
        let edited = daemon
            .ask(r#"{"verb":"stage-edit","edit":"set-persona","number":1,"persona":"xbox360"}"#);
        assert_eq!(edited["ok"], true, "{edited}");

        // "Resume emulation".
        let resumed = daemon.ask(r#"{"verb":"resume"}"#);
        assert_eq!(resumed["ok"], true, "{resumed}");

        // The session that came back is the staged one — and it carries the
        // edit, so resume re-commits the setup as it stands rather than
        // replaying the snapshot the session started with.
        let spec = daemon.staged.lock().unwrap().clone();
        let spec = spec.expect("resume must put the daemon back on the STAGED setup");
        assert_eq!(spec.slots.len(), 1);
        assert_eq!(
            spec.slots[0].spec.persona,
            ksx_core::Persona::Xbox360,
            "the edit made while paused must be in what comes back"
        );

        // Nothing was written and nothing was lost: the setup is still staged
        // and still says what the screen says.
        let view = daemon.ask(r#"{"verb":"stage"}"#);
        assert_eq!(view["setup"]["slots"][0]["persona"], "xbox360", "{view}");
        assert_eq!(view["setup"]["ready"], true, "{view}");
    }

    /// **The tray Start rule is not weakened by any of this.** Start still
    /// means the config on disk, and a Start after somebody played an unsaved
    /// setup still drops the override — the draft stays staged, but it is not
    /// what runs.
    ///
    /// This is the rule `resume` exists so as not to break. Breaks against a
    /// "fix" that made Start remember the staged setup instead: the override
    /// would still be set here, and the tray's Start would silently keep
    /// playing a draft that is not in any file.
    #[test]
    fn start_after_a_staged_session_still_means_the_config_on_disk() {
        let daemon = RunningDaemon::start(None);
        stage_ready(&daemon.deps);
        assert_eq!(daemon.ask(r#"{"verb":"stage-play"}"#)["ok"], true);
        assert_eq!(daemon.ask(r#"{"verb":"stop"}"#)["ok"], true);

        // The tray's Start — no profile, no staged setup, whatever is saved.
        let started = daemon.ask(r#"{"verb":"start"}"#);
        assert_eq!(started["ok"], true, "{started}");
        assert!(
            daemon.staged.lock().unwrap().is_none(),
            "Start means the config on disk: the staged override must be gone"
        );
        assert_eq!(
            daemon.state.lock().unwrap().origin,
            ksx_api::SessionOrigin::Config
        );

        // The DRAFT is untouched by that — what Start dropped is the pointer,
        // not the work. §2: the user may leave without saving and lose only
        // what they typed.
        let view = daemon.ask(r#"{"verb":"stage"}"#);
        assert_eq!(
            view["setup"]["slots"][0]["persona"], "playstation",
            "{view}"
        );
    }

    /// **Resuming a PROFILE session resumes that profile** — the case that
    /// already worked, pinned so the staged fix cannot regress it.
    ///
    /// The profile is not sent by the caller and never was the caller's to
    /// know: the daemon is still pointed at it, so the plain start the resume
    /// falls through to is the same session. Breaks against a resume that
    /// always played the staged setup, and against one that cleared the game.
    #[test]
    fn resuming_a_paused_profile_session_starts_that_profile_again() {
        let daemon = RunningDaemon::start(Some("Street Fighter".to_owned()));

        assert_eq!(
            daemon.ask(r#"{"verb":"start","profile":"Metal Slug"}"#)["ok"],
            true
        );
        assert_eq!(daemon.game.lock().unwrap().as_deref(), Some("Metal Slug"));
        assert_eq!(daemon.ask(r#"{"verb":"stop"}"#)["ok"], true);

        let resumed = daemon.ask(r#"{"verb":"resume"}"#);
        assert_eq!(resumed["ok"], true, "{resumed}");
        assert_eq!(
            daemon.game.lock().unwrap().as_deref(),
            Some("Metal Slug"),
            "resume must put back the profile that was playing"
        );
        assert!(
            daemon.staged.lock().unwrap().is_none(),
            "a profile session resumes from disk, not from a stage"
        );
    }

    /// **A resume that cannot happen says WHY, and destroys nothing.**
    ///
    /// "Start over" while paused is a legal thing to do (§2: it must always
    /// work), and it leaves nothing to resume. The answer has to name what is
    /// missing and where to go — not "the daemon refused" — and the setup, or
    /// what is left of it, must be exactly as the user left it.
    ///
    /// Breaks against a resume that started the config on disk anyway, which
    /// would report success while running a session the user never asked for.
    #[test]
    fn a_resume_with_nothing_left_to_resume_says_why_and_touches_nothing() {
        let daemon = RunningDaemon::start(None);
        stage_ready(&daemon.deps);
        assert_eq!(daemon.ask(r#"{"verb":"stage-play"}"#)["ok"], true);
        assert_eq!(daemon.ask(r#"{"verb":"stop"}"#)["ok"], true);

        // Start over, while paused.
        assert_eq!(
            daemon.ask(r#"{"verb":"stage-edit","edit":"discard"}"#)["ok"],
            true
        );

        let refused = daemon.ask(r#"{"verb":"resume"}"#);
        assert_eq!(refused["ok"], false, "{refused}");
        let error = refused["error"].as_str().unwrap_or_default();
        // ksx-core's own sentence for what is missing, in the words the
        // staging screen shows — here `StageRefusal::NoDevice`, because "Start
        // over" takes the keyboard with it.
        assert!(error.contains("no keyboard has been chosen"), "{error}");
        // ...and then what this verb did NOT do. Deliberately not "it is still
        // staged": after a Start over there is nothing staged, and a resume
        // that said otherwise would be inventing a fact. What is true in every
        // case is that resuming destroyed nothing.
        assert!(
            error.contains("no file was written") && error.contains("nothing staged was discarded"),
            "a refused resume must say what it did not do: {error}"
        );
        assert!(
            error.contains("ksx session start"),
            "and it must name a way forward: {error}"
        );
        assert_eq!(
            *daemon.makes.lock().unwrap(),
            1,
            "a refused resume must not build a session — only the one that was paused"
        );
        assert!(matches!(
            daemon.state.lock().unwrap().run,
            RunState::Stopped | RunState::Failed { .. }
        ));
    }

    /// A daemon that has started nothing has nothing to resume, and says so
    /// instead of starting whatever is on disk and calling it a resume.
    ///
    /// Breaks against a resume implemented as "Start unless a staged setup is
    /// around": a fresh daemon would start a session nobody asked for.
    #[test]
    fn a_daemon_that_started_nothing_refuses_to_resume_rather_than_start() {
        let daemon = RunningDaemon::start(None);
        let refused = daemon.ask(r#"{"verb":"resume"}"#);
        assert_eq!(refused["ok"], false, "{refused}");
        assert!(
            refused["error"]
                .as_str()
                .unwrap_or_default()
                .contains("has not started a session yet"),
            "{refused}"
        );
        assert!(daemon.staged.lock().unwrap().is_none());
        assert_eq!(*daemon.makes.lock().unwrap(), 0, "nothing was built");
        assert_eq!(daemon.state.lock().unwrap().run, RunState::Stopped);
    }

    /// **Play refuses a controller that binds nothing, and it refuses an
    /// unanswered split-or-freeze question — over the wire, before anything is
    /// enqueued.**
    ///
    /// This is the shipped bug, end to end: `add-slot` staged an empty preset,
    /// `stage` reported `ready: true`, and `stage-play` plugged a pad on which
    /// every button was dead — moments after a screen said the controller was
    /// ready. The refusal names the SLOT, so a four-player setup says which
    /// pad would be the dead one.
    ///
    /// Breaks against the shipped daemon on both arms: the empty-preset arm
    /// answered `ok: true` and enqueued `PlayStaged`, and the unanswered-
    /// question arm answered `ok: true` after silently resolving §3 to Freeze.
    #[test]
    fn playing_a_dead_pad_or_an_unanswered_question_is_refused_and_enqueues_nothing() {
        let state = shared(RunState::Stopped);
        let (tx, rx) = unbounded();
        let deps = deps(tx, state.clone(), no_profiles());

        handle_request(
            r#"{"verb":"stage-edit","edit":"choose-device","selector":"usb:d209:0430:00",
                "alias":"panel","label":"I-PAC"}"#,
            &deps,
            FAST,
        );
        // A controller with no layout: exactly what the shipped `add-slot`
        // staged for EVERY controller.
        let added = handle_request(
            r#"{"verb":"stage-edit","edit":"add-slot","persona":"xbox360","preset":"Player 1"}"#,
            &deps,
            FAST,
        );
        assert_eq!(added["ok"], true, "staging it is still free");
        assert_eq!(added["setup"]["slots"][0]["bindings"], 0);
        assert_eq!(added["setup"]["ready"], false, "{added}");

        for verb in [r#"{"verb":"stage-play"}"#, r#"{"verb":"stage-commit"}"#] {
            let refused = handle_request(verb, &deps, FAST);
            assert_eq!(refused["ok"], false, "{verb} → {refused}");
            assert_eq!(refused["code"], "no-bindings", "{refused}");
            assert!(
                refused["error"].as_str().unwrap().contains("slot 1"),
                "the refusal names the slot: {refused}"
            );
            // ...and it is the sentence the screen was ALREADY showing, so
            // neither button can produce a surprise.
            assert_eq!(refused["error"], refused["setup"]["not_ready"]);
        }
        assert!(
            rx.try_recv().is_err(),
            "a dead pad must not reach the control loop"
        );

        // Give it a real layout and the bindings gate opens — but §3's is
        // still shut, and Save must not write an answer nobody gave.
        let dressed = handle_request(
            r#"{"verb":"stage-edit","edit":"set-layout","number":1,"layout":"arcade-6button"}"#,
            &deps,
            FAST,
        );
        assert_eq!(dressed["ok"], true, "{dressed}");
        assert!(dressed["setup"]["slots"][0]["bindings"].as_u64().unwrap() > 10);
        let refused = handle_request(r#"{"verb":"stage-play"}"#, &deps, FAST);
        assert_eq!(refused["code"], "blocking-unanswered", "{refused}");
        assert_eq!(
            refused["setup"]["blocking"],
            serde_json::Value::Null,
            "a refusal must not answer the question on the user's behalf either"
        );
        assert!(rx.try_recv().is_err(), "nothing may be enqueued");
    }

    /// Playing an incomplete setup is refused before anything is enqueued.
    /// A live session is different: Play enqueues one replacement command.
    #[test]
    fn playing_refuses_before_enqueuing_anything() {
        let state = shared(RunState::Stopped);
        let (tx, rx) = unbounded();
        let deps = deps(tx, state.clone(), no_profiles());
        let refused = handle_request(r#"{"verb":"stage-play"}"#, &deps, FAST);
        assert_eq!(refused["ok"], false, "{refused}");
        assert_eq!(refused["code"], "no-device");
        assert!(rx.try_recv().is_err(), "nothing may be enqueued");

        stage_ready(&deps);
        state.lock().unwrap().run = RunState::Running { slots: 4 };
        let worker = std::thread::spawn({
            let state = state.clone();
            move || {
                let command = rx.recv_timeout(Duration::from_secs(1)).unwrap();
                state.lock().unwrap().run = RunState::Starting;
                std::thread::sleep(Duration::from_millis(20));
                state.lock().unwrap().run = RunState::Running { slots: 1 };
                command
            }
        });
        let replaced = handle_request(r#"{"verb":"stage-play"}"#, &deps, Duration::from_secs(1));
        assert_eq!(replaced["ok"], true, "{replaced}");
        assert_eq!(replaced["playing"], true, "{replaced}");
        assert!(
            matches!(worker.join().unwrap(), DaemonCommand::PlayStaged(_)),
            "a running session must be replaced by one staged-play command"
        );
    }

    #[test]
    fn start_enqueues_the_same_command_the_tray_produces() {
        let state = shared(RunState::Stopped);
        let (tx, rx) = unbounded();
        let worker = std::thread::spawn({
            let state = state.clone();
            move || {
                let command = rx.recv_timeout(Duration::from_secs(1)).unwrap();
                state.lock().unwrap().run = RunState::Running { slots: 2 };
                command
            }
        });
        let v = handle_request(
            r#"{"verb":"start","profile":"Metal Slug"}"#,
            &deps(tx.clone(), state.clone(), no_profiles()),
            Duration::from_secs(2),
        );
        assert_eq!(v["ok"], true, "{v}");
        assert!(v["message"].as_str().unwrap().contains("2 slot(s)"), "{v}");
        assert_eq!(
            worker.join().unwrap(),
            DaemonCommand::Start {
                game: Some("Metal Slug".into())
            }
        );
    }

    #[test]
    fn start_with_no_or_blank_profile_keeps_the_daemons_configured_game() {
        for request in [r#"{"verb":"start"}"#, r#"{"verb":"start","profile":" "}"#] {
            let state = shared(RunState::Stopped);
            let (tx, rx) = unbounded();
            let _ = handle_request(
                request,
                &deps(tx.clone(), state.clone(), no_profiles()),
                FAST,
            );
            assert_eq!(
                rx.try_recv().unwrap(),
                DaemonCommand::Start { game: None },
                "{request}"
            );
        }
    }

    #[test]
    fn start_while_running_is_refused_without_enqueuing() {
        let state = shared(RunState::Running { slots: 4 });
        let (tx, rx) = unbounded();
        let v = handle_request(
            r#"{"verb":"start"}"#,
            &deps(tx.clone(), state.clone(), no_profiles()),
            FAST,
        );
        assert_eq!(v["ok"], false);
        assert!(v["error"].as_str().unwrap().contains("already running"));
        assert!(rx.try_recv().is_err(), "nothing may be enqueued");
    }

    /// The same validation path as the tray: a bad profile fails in the
    /// factory's plan resolution, lands in `RunState::Failed`, and the pipe
    /// reports that message — no parallel validator in the pipe thread.
    #[test]
    fn a_start_that_fails_in_the_factory_reports_the_failure_message() {
        let state = shared(RunState::Stopped);
        let (tx, rx) = unbounded();
        std::thread::spawn({
            let state = state.clone();
            move || {
                let _ = rx.recv_timeout(Duration::from_secs(1)).unwrap();
                state.lock().unwrap().run = RunState::Starting;
                std::thread::sleep(Duration::from_millis(10));
                state.lock().unwrap().run = RunState::Failed {
                    message: "unknown game \"Typo Fighter\"".into(),
                };
            }
        });
        let v = handle_request(
            r#"{"verb":"start","profile":"Typo Fighter"}"#,
            &deps(tx.clone(), state.clone(), no_profiles()),
            Duration::from_secs(2),
        );
        assert_eq!(v["ok"], false, "{v}");
        assert!(v["error"].as_str().unwrap().contains("Typo Fighter"));
    }

    /// A make() that fails faster than the poll interval must still be
    /// reported: the baseline comparison catches a Stopped→Failed jump even
    /// when Starting was never observed.
    #[test]
    fn a_fast_failure_is_not_mistaken_for_stale_state() {
        let state = shared(RunState::Stopped);
        let (tx, rx) = unbounded();
        std::thread::spawn({
            let state = state.clone();
            move || {
                let _ = rx.recv_timeout(Duration::from_secs(1)).unwrap();
                state.lock().unwrap().run = RunState::Failed {
                    message: "cannot start".into(),
                };
            }
        });
        let v = handle_request(
            r#"{"verb":"start"}"#,
            &deps(tx.clone(), state.clone(), no_profiles()),
            Duration::from_secs(2),
        );
        assert_eq!(v["ok"], false, "{v}");
    }

    #[test]
    fn an_unprocessed_command_times_out_into_an_honest_requested_answer() {
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let v = handle_request(
            r#"{"verb":"start"}"#,
            &deps(tx.clone(), state.clone(), no_profiles()),
            FAST,
        );
        assert_eq!(v["ok"], true, "{v}");
        assert!(v["message"].as_str().unwrap().contains("requested"), "{v}");
    }

    #[test]
    fn stop_when_nothing_runs_is_refused() {
        let state = shared(RunState::Stopped);
        let (tx, rx) = unbounded();
        let v = handle_request(
            r#"{"verb":"stop"}"#,
            &deps(tx.clone(), state.clone(), no_profiles()),
            FAST,
        );
        assert_eq!(v["ok"], false);
        assert!(v["error"].as_str().unwrap().contains("not running"));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn stop_waits_for_the_session_to_end() {
        let state = shared(RunState::Running { slots: 4 });
        let (tx, rx) = unbounded();
        std::thread::spawn({
            let state = state.clone();
            move || {
                assert_eq!(
                    rx.recv_timeout(Duration::from_secs(1)).unwrap(),
                    DaemonCommand::Stop
                );
                state.lock().unwrap().run = RunState::Stopped;
            }
        });
        let v = handle_request(
            r#"{"verb":"stop"}"#,
            &deps(tx.clone(), state.clone(), no_profiles()),
            Duration::from_secs(2),
        );
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["message"], "stopped");
    }

    #[test]
    fn reload_enqueues_reload_and_reports_the_new_session() {
        let state = shared(RunState::Running { slots: 4 });
        let (tx, rx) = unbounded();
        std::thread::spawn({
            let state = state.clone();
            move || {
                assert_eq!(
                    rx.recv_timeout(Duration::from_secs(1)).unwrap(),
                    DaemonCommand::Reload
                );
                state.lock().unwrap().run = RunState::Starting;
                std::thread::sleep(Duration::from_millis(10));
                state.lock().unwrap().run = RunState::Running { slots: 6 };
            }
        });
        let v = handle_request(
            r#"{"verb":"reload"}"#,
            &deps(tx.clone(), state.clone(), no_profiles()),
            Duration::from_secs(2),
        );
        assert_eq!(v["ok"], true, "{v}");
        assert!(v["message"].as_str().unwrap().contains("6 slot(s)"));
    }

    // -- the mapper verbs: map / learn-key / learn-poll / learn-cancel ------

    /// A `map` that records what it was asked and reports a scripted result.
    fn scripted_map(
        result: fn(
            &crate::mapping::MapSpec,
        ) -> Result<crate::mapping::AppliedMap, crate::mapping::MapError>,
        seen: Arc<Mutex<Vec<crate::mapping::MapSpec>>>,
    ) -> MapFn {
        Box::new(move |spec| {
            seen.lock().unwrap().push(spec.clone());
            result(spec)
        })
    }

    fn applied_ok(
        spec: &crate::mapping::MapSpec,
    ) -> Result<crate::mapping::AppliedMap, crate::mapping::MapError> {
        Ok(crate::mapping::AppliedMap {
            path: std::path::PathBuf::from(r"C:\cfg\ksx\presets\Panel P1.toml"),
            preset: spec.preset.clone(),
            function: spec.function.to_ascii_uppercase(),
            key: spec.key.clone().or_else(|| spec.keys.first().cloned()),
            keys: spec
                .key
                .clone()
                .into_iter()
                .chain(spec.keys.iter().cloned())
                .collect(),
            when: spec.when.clone(),
            unless: spec.unless.clone(),
            also_drives: Vec::new(),
            moved_from: None,
            overridden: Vec::new(),
            flash: Vec::new(),
            shared_macros: Vec::new(),
            turbo_hz: spec.turbo_hz.filter(|hz| *hz > 0),
            turbo_effective_hz: spec.turbo_hz.filter(|hz| *hz > 0).map(|hz| {
                ksx_core::TurboBinding::new(ksx_core::Binding::Button(ksx_core::XButton::A), hz)
                    .effective_hz()
            }),
            toggle: spec.toggle == Some(true),
        })
    }

    /// A `map-macro` writer that records what it was handed and answers with a
    /// plausible write.
    fn scripted_macro(seen: Arc<Mutex<Vec<crate::mapping::MacroSpec>>>) -> MacroFn {
        Box::new(move |spec| {
            seen.lock().unwrap().push(spec.clone());
            Ok(crate::mapping::AppliedMacro {
                path: std::path::PathBuf::from(r"C:\cfg\ksx\presets\Panel P1.toml"),
                preset: spec.preset.clone(),
                name: spec.name.clone(),
                steps: spec.body.steps.len(),
                total_ms: 200,
                deleted: spec.delete,
                enabled: spec.set_enabled.unwrap_or(spec.body.enabled),
                toggled: spec.set_enabled.is_some(),
                triggers: vec!["P".to_owned()],
                backup: Some(crate::mapping::PresetBackup {
                    path: std::path::PathBuf::from(r"C:\cfg\ksx\presets\Panel P1.toml.bak-x"),
                    stamp: "20260805-143207".to_owned(),
                }),
                warnings: Vec::new(),
            })
        })
    }

    const HADOUKEN_BODY: &str = r#""steps":[{"hold":["dpad.down"],"ms":50},
        {"hold":["dpad.down","dpad.right"],"ms":50},
        {"hold":["dpad.right"],"ms":50},
        {"hold":["A"],"frames":3}]"#;

    /// The body's field names ARE the preset file's, so the wire and the file
    /// cannot drift — `frames` arrives as `frames`, not as milliseconds.
    #[test]
    fn map_macro_hands_the_file_shaped_body_to_the_writer() {
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let mut d = deps(tx, state, no_profiles());
        d.save_macro = scripted_macro(seen.clone());
        let v = handle_request(
            &format!(
                r#"{{"verb":"map-macro","preset":"Panel P1","name":"hadouken",{HADOUKEN_BODY},
                   "on_release":"abort","retrigger":"restart","interrupt":"opposing"}}"#
            ),
            &d,
            FAST,
        );
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["name"], "hadouken");
        assert_eq!(v["steps"], 4);
        assert_eq!(v["backup"]["stamp"], "20260805-143207", "{v}");
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        let spec = &seen[0];
        assert_eq!(spec.preset, "Panel P1");
        assert!(!spec.delete);
        assert_eq!(spec.body.steps.len(), 4);
        assert_eq!(spec.body.steps[1].hold, ["dpad.down", "dpad.right"]);
        assert_eq!(spec.body.steps[3].frames, Some(3), "frames stay frames");
        assert_eq!(spec.body.steps[3].ms, None);
        assert_eq!(spec.body.on_release, ksx_core::OnRelease::Abort);
        assert_eq!(spec.body.retrigger, ksx_core::Retrigger::Restart);
        assert_eq!(spec.body.interrupt, ksx_core::Interrupt::Opposing);
    }

    #[test]
    fn map_macro_validates_its_fields_before_touching_the_writer() {
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let mut d = deps(tx, state, no_profiles());
        d.save_macro = scripted_macro(seen.clone());
        for junk in [
            r#"{"verb":"map-macro"}"#.to_owned(),
            r#"{"verb":"map-macro","preset":"Panel P1"}"#.to_owned(),
            // No "steps" and no "delete": a misspelled field, not a deletion.
            r#"{"verb":"map-macro","preset":"Panel P1","name":"hadouken"}"#.to_owned(),
            // Bodies the preset file itself would refuse.
            r#"{"verb":"map-macro","preset":"P","name":"m","steps":[{"hold":["A"],"ms":"soon"}]}"#
                .to_owned(),
            r#"{"verb":"map-macro","preset":"P","name":"m","steps":[{"hold":["A"],"ms":50}],"on_release":"maybe"}"#
                .to_owned(),
            r#"{"verb":"map-macro","preset":"P","name":"m","steps":[{"hold":["A"],"ms":50,"nope":1}]}"#
                .to_owned(),
        ] {
            let v = handle_request(&junk, &d, FAST);
            assert_eq!(v["ok"], false, "{junk} → {v}");
        }
        assert!(
            seen.lock().unwrap().is_empty(),
            "no write may have happened"
        );
    }

    /// Deletion is an explicit word, and it reaches the writer as one.
    #[test]
    fn map_macro_delete_needs_no_steps_and_says_so_in_the_answer() {
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let mut d = deps(tx, state, no_profiles());
        d.save_macro = scripted_macro(seen.clone());
        let v = handle_request(
            r#"{"verb":"map-macro","preset":"Panel P1","name":"hadouken","delete":true}"#,
            &d,
            FAST,
        );
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["deleted"], true, "{v}");
        assert_eq!(v["triggers"][0], "P", "{v}");
        assert!(seen.lock().unwrap()[0].delete);
    }

    /// `"enabled"` with NO `steps` is the TOGGLE: it reaches the writer as
    /// `set_enabled` and carries no body, so the table on disk keeps
    /// everything. With `steps` it is an ordinary field of the table instead.
    #[test]
    fn map_macro_enabled_is_a_toggle_without_a_body_and_a_field_with_one() {
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let mut d = deps(tx, state, no_profiles());
        d.save_macro = scripted_macro(seen.clone());

        // No steps: a toggle. `steps` is absent, so the writer is told to move
        // the flag and nothing else.
        let v = handle_request(
            r#"{"verb":"map-macro","preset":"Panel P1","name":"hadouken","enabled":false}"#,
            &d,
            FAST,
        );
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["toggled"], true, "{v}");
        assert_eq!(v["enabled"], false, "{v}");
        assert_eq!(seen.lock().unwrap()[0].set_enabled, Some(false));
        assert!(
            seen.lock().unwrap()[0].body.steps.is_empty(),
            "a toggle carries no body"
        );

        // With steps: an ordinary whole-table write that lands disabled.
        let v = handle_request(
            r#"{"verb":"map-macro","preset":"Panel P1","name":"hadouken",
                "steps":[{"hold":["A"],"ms":50}],"enabled":false}"#,
            &d,
            FAST,
        );
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["toggled"], false, "{v}");
        assert_eq!(v["enabled"], false, "{v}");
        let seen = seen.lock().unwrap();
        assert_eq!(seen[1].set_enabled, None);
        assert!(!seen[1].body.enabled, "the field reached the body");
        assert_eq!(seen[1].body.steps.len(), 1);
    }

    /// The absent-steps refusal has to name the toggle now that one exists —
    /// otherwise the only documented way out of it is `delete`.
    #[test]
    fn map_macro_without_steps_names_both_ways_out() {
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let mut d = deps(tx, state, no_profiles());
        d.save_macro = scripted_macro(seen.clone());
        let v = handle_request(
            r#"{"verb":"map-macro","preset":"Panel P1","name":"hadouken"}"#,
            &d,
            FAST,
        );
        assert_eq!(v["ok"], false, "{v}");
        let text = v["error"].as_str().unwrap_or_default();
        for part in ["steps", "delete", "enabled"] {
            assert!(text.contains(part), "{text}");
        }
        assert!(seen.lock().unwrap().is_empty(), "nothing may be written");
    }

    /// A macro BODY is a binding change: `reload: true` enqueues
    /// `ApplyBindings` (never a blunt Reload), and when the control loop
    /// reports the in-place swap the response says the pads were left alone.
    /// Same wiring, same fields, same guarantee as `map`.
    #[test]
    fn map_macro_with_reload_hot_swaps_a_running_session() {
        let state = shared(RunState::Running { slots: 4 });
        let (tx, rx) = unbounded();
        let loop_thread = answer_apply(
            rx,
            state.clone(),
            super::super::ApplyReport {
                generation: 0,
                ok: true,
                hot: true,
                restarted: false,
                needs_restart: false,
                message: "bindings applied live — pads untouched".to_owned(),
            },
        );
        let mut d = deps(tx, state, no_profiles());
        d.save_macro = scripted_macro(Arc::new(Mutex::new(Vec::new())));
        let v = handle_request(
            &format!(
                r#"{{"verb":"map-macro","preset":"Panel P1","name":"hadouken",{HADOUKEN_BODY},"reload":true}}"#
            ),
            &d,
            Duration::from_secs(2),
        );
        assert_eq!(
            loop_thread.join().unwrap(),
            DaemonCommand::ApplyBindings,
            "a macro body must take the hot-swap path, not a pad bounce"
        );
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["reloaded"], true, "{v}");
        assert_eq!(v["hot_swap"], true, "{v}");
    }

    /// A refusal names its problems one by one AND carries the stable code.
    #[test]
    fn map_macro_reports_a_refusal_with_its_code_and_problem_list() {
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let mut d = deps(tx, state, no_profiles());
        d.save_macro = Box::new(|spec| {
            Err(crate::mapping::MapError::BadMacro {
                preset: spec.preset.clone(),
                name: spec.name.clone(),
                problems: vec!["step 0 holds 'warp'".to_owned()],
            })
        });
        let v = handle_request(
            r#"{"verb":"map-macro","preset":"P","name":"m","steps":[{"hold":["warp"],"ms":50}]}"#,
            &d,
            FAST,
        );
        assert_eq!(v["ok"], false, "{v}");
        assert_eq!(v["code"], "macro-invalid", "{v}");
        assert_eq!(v["problems"][0], "step 0 holds 'warp'", "{v}");
    }

    #[test]
    fn map_validates_its_fields_before_touching_the_writer() {
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let mut d = deps(tx, state, no_profiles());
        d.map = scripted_map(applied_ok, seen.clone());
        for junk in [
            r#"{"verb":"map"}"#,
            r#"{"verb":"map","preset":"Panel P1"}"#,
            r#"{"verb":"map","preset":"Panel P1","function":"A"}"#,
            r#"{"verb":"map","preset":"Panel P1","function":"A","key":"G","clear":true}"#,
            // "key" and "keys" are two spellings of one field: both together
            // would mean ignoring one, so the verb refuses instead.
            r#"{"verb":"map","preset":"Panel P1","function":"A","key":"G","keys":["S"]}"#,
            r#"{"verb":"map","preset":"Panel P1","function":"A","keys":["S"],"clear":true}"#,
        ] {
            let v = handle_request(junk, &d, FAST);
            assert_eq!(v["ok"], false, "{junk} → {v}");
        }
        assert!(
            seen.lock().unwrap().is_empty(),
            "no write may have happened"
        );
    }

    #[test]
    fn map_while_stopped_writes_and_says_the_next_start_reads_it() {
        let state = shared(RunState::Stopped);
        let (tx, rx) = unbounded();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let mut d = deps(tx, state, no_profiles());
        d.map = scripted_map(applied_ok, seen.clone());
        let v = handle_request(
            r#"{"verb":"map","preset":"Panel P1","function":"a","key":"G","reload":true}"#,
            &d,
            FAST,
        );
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["function"], "A");
        assert_eq!(v["key"], "G");
        assert_eq!(v["reloaded"], false);
        assert!(
            v["message"]
                .as_str()
                .unwrap()
                .contains("next session start"),
            "{v}"
        );
        assert!(rx.try_recv().is_err(), "nothing to reload when stopped");
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].preset, "Panel P1");
        assert!(!seen[0].force);
    }

    /// FIX 3, pipe half — the hot branch. `reload: true` with a running
    /// session enqueues `ApplyBindings` (NOT `Reload`), and when the control
    /// loop reports a hot swap the response says the pads were left alone.
    #[test]
    fn map_with_reload_hot_swaps_a_running_session() {
        let state = shared(RunState::Running { slots: 4 });
        let (tx, rx) = unbounded();
        let loop_thread = answer_apply(
            rx,
            state.clone(),
            super::super::ApplyReport {
                generation: 0,
                ok: true,
                hot: true,
                restarted: false,
                needs_restart: false,
                message: "bindings applied live — pads untouched".to_owned(),
            },
        );
        let seen = Arc::new(Mutex::new(Vec::new()));
        let mut d = deps(tx, state, no_profiles());
        d.map = scripted_map(applied_ok, seen);
        let v = handle_request(
            r#"{"verb":"map","preset":"Panel P1","function":"A","key":"G","reload":true}"#,
            &d,
            Duration::from_secs(2),
        );
        assert_eq!(
            loop_thread.join().unwrap(),
            DaemonCommand::ApplyBindings,
            "a binding save must not enqueue a blunt Reload any more"
        );
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["reloaded"], true, "{v}");
        assert_eq!(v["hot_swap"], true, "{v}");
        assert!(
            v["message"]
                .as_str()
                .unwrap()
                .contains("bindings applied live — pads untouched"),
            "{v}"
        );
    }

    /// …and the bounce branch: a structural change reports the restart, in the
    /// same field shape, so the caller can tell the two apart.
    #[test]
    fn map_with_reload_reports_a_restart_when_the_change_is_structural() {
        let state = shared(RunState::Running { slots: 4 });
        let (tx, rx) = unbounded();
        let loop_thread = answer_apply(
            rx,
            state.clone(),
            super::super::ApplyReport {
                generation: 0,
                ok: true,
                hot: false,
                restarted: true,
                needs_restart: false,
                message: "session restarted — slot 3 changed persona (Xbox 360 → PlayStation \
                          (DS4)) needs the pads replugged"
                    .to_owned(),
            },
        );
        let seen = Arc::new(Mutex::new(Vec::new()));
        let mut d = deps(tx, state, no_profiles());
        d.map = scripted_map(applied_ok, seen);
        let v = handle_request(
            r#"{"verb":"map","preset":"Panel P1","function":"A","key":"G","reload":true}"#,
            &d,
            Duration::from_secs(2),
        );
        assert_eq!(loop_thread.join().unwrap(), DaemonCommand::ApplyBindings);
        assert_eq!(v["reloaded"], true, "{v}");
        assert_eq!(v["hot_swap"], false, "{v}");
        assert!(
            v["message"].as_str().unwrap().contains("session restarted"),
            "{v}"
        );
    }

    #[test]
    fn map_without_reload_says_a_running_session_needs_one() {
        let state = shared(RunState::Running { slots: 4 });
        let (tx, rx) = unbounded();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let mut d = deps(tx, state, no_profiles());
        d.map = scripted_map(applied_ok, seen);
        let v = handle_request(
            r#"{"verb":"map","preset":"Panel P1","function":"A","key":"G"}"#,
            &d,
            FAST,
        );
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["reloaded"], false);
        assert!(
            v["message"].as_str().unwrap().contains("`reload` to apply"),
            "{v}"
        );
        assert!(rx.try_recv().is_err(), "no unasked reload");
    }

    #[test]
    fn map_conflicts_come_back_as_structured_rows() {
        fn conflicted(
            _spec: &crate::mapping::MapSpec,
        ) -> Result<crate::mapping::AppliedMap, crate::mapping::MapError> {
            Err(crate::mapping::MapError::Conflicts {
                key: "G".into(),
                conflicts: vec![crate::mapping::MapConflict {
                    key: "G".into(),
                    preset: "Panel P2".into(),
                    function: "A".into(),
                    scope: crate::mapping::ConflictScope::Profile,
                    file: "games.toml".into(),
                    profile: Some("Example Launcher".into()),
                    slot: Some(2),
                }],
            })
        }
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let mut d = deps(tx, state, no_profiles());
        d.map = scripted_map(conflicted, Arc::new(Mutex::new(Vec::new())));
        let v = handle_request(
            r#"{"verb":"map","preset":"Panel P1","function":"B","key":"G"}"#,
            &d,
            FAST,
        );
        assert_eq!(v["ok"], false, "{v}");
        assert_eq!(v["code"], "conflict");
        assert_eq!(v["conflicts"][0]["preset"], "Panel P2");
        assert_eq!(v["conflicts"][0]["function"], "A");
        assert_eq!(v["conflicts"][0]["profile"], "Example Launcher");
        assert_eq!(v["conflicts"][0]["slot"], 2);
        assert!(
            v["error"].as_str().unwrap().contains("\"Panel P2\"'s A"),
            "{v}"
        );
    }

    /// The mapper's "Map all to one key", through the real writer over the
    /// real verb: three ordinary `map` calls with one key, no `force`, and all
    /// three stick. The response carries the co-bindings (`also_drives`) so
    /// Studio can say what the key drives without waiting for its next poll.
    #[test]
    fn map_binds_one_key_to_several_functions_and_reports_the_co_bindings() {
        let dir = std::env::temp_dir().join(format!(
            "ksx-pipe-multibind-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = ksx_config::ConfigRoot::at(&dir);
        let store = ksx_config::Store::new(root.clone());
        let file: ksx_config::PresetFile =
            toml::from_str("name = \"Panel P1\"\n[bindings]\nA = \"S\"\nB = \"D\"\nrt = \"E\"\n")
                .unwrap();
        store.save_preset(&file).unwrap();

        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let mut d = deps(tx, state, no_profiles());
        d.map = preset_writers(root).0;

        let mut last = serde_json::Value::Null;
        for function in ["A", "B", "rt"] {
            let request = format!(
                r#"{{"verb":"map","preset":"Panel P1","function":"{function}","key":"P"}}"#
            );
            last = handle_request(&request, &d, FAST);
            assert_eq!(last["ok"], true, "{request} → {last}");
            assert_eq!(last["moved_from"], serde_json::Value::Null, "{last}");
        }
        assert_eq!(last["also_drives"], serde_json::json!(["A", "B"]), "{last}");
        assert!(
            last["message"].as_str().unwrap().contains("P also drives"),
            "{last}"
        );

        let on_disk = std::fs::read_to_string(store.preset_path("Panel P1").unwrap()).unwrap();
        for row in ["A = \"P\"", "B = \"P\"", "rt = \"P\""] {
            assert!(on_disk.contains(row), "missing {row} in:\n{on_disk}");
        }

        // …and the explicit move is reachable over the same verb, naming what
        // it unbound and leaving the other two alone.
        let v = handle_request(
            r#"{"verb":"map","preset":"Panel P1","function":"X","key":"P","move_from":"rt"}"#,
            &d,
            FAST,
        );
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["moved_from"]["function"], "rt", "{v}");
        assert_eq!(v["moved_from"]["unbound"], true, "{v}");
        assert_eq!(v["also_drives"], serde_json::json!(["A", "B"]), "{v}");
        let on_disk = std::fs::read_to_string(store.preset_path("Panel P1").unwrap()).unwrap();
        assert!(on_disk.contains("rt = \"None\""), "{on_disk}");
        assert!(on_disk.contains("A = \"P\""), "{on_disk}");
        assert!(on_disk.contains("X = \"P\""), "{on_disk}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// MANY KEYS → ONE CONTROL over the wire, through the REAL writer: one
    /// `map` call with `"keys"` writes the whole list, and the response says
    /// what the control now holds. This is Studio's "add another key" — one
    /// atomic write, not a read-modify-write.
    #[test]
    fn map_writes_a_whole_key_list_and_reports_it_back() {
        let dir = std::env::temp_dir().join(format!(
            "ksx-pipe-keylist-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = ksx_config::ConfigRoot::at(&dir);
        let store = ksx_config::Store::new(root.clone());
        let file: ksx_config::PresetFile =
            toml::from_str("name = \"Panel P1\"\n[bindings]\nA = \"S\"\nB = \"D\"\n").unwrap();
        store.save_preset(&file).unwrap();

        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let mut d = deps(tx, state, no_profiles());
        d.map = preset_writers(root).0;

        let v = handle_request(
            r#"{"verb":"map","preset":"Panel P1","function":"A","keys":["S","Enter","s"]}"#,
            &d,
            FAST,
        );
        assert_eq!(v["ok"], true, "{v}");
        // Order kept, the duplicate `s` gone, and "key" still the FIRST key
        // for every reader that predates the list.
        assert_eq!(v["keys"], serde_json::json!(["S", "Enter"]), "{v}");
        assert_eq!(v["key"], "S", "{v}");
        assert!(
            v["message"].as_str().unwrap().contains("A = S, Enter"),
            "{v}"
        );
        let on_disk = std::fs::read_to_string(store.preset_path("Panel P1").unwrap()).unwrap();
        assert!(on_disk.contains("A = [\"S\", \"Enter\"]"), "{on_disk}");
        assert!(on_disk.contains("B = \"D\""), "{on_disk}");

        // The per-key ✕ sends the remaining list — one write again.
        let v = handle_request(
            r#"{"verb":"map","preset":"Panel P1","function":"A","keys":["Enter"]}"#,
            &d,
            FAST,
        );
        assert_eq!(v["keys"], serde_json::json!(["Enter"]), "{v}");
        let on_disk = std::fs::read_to_string(store.preset_path("Panel P1").unwrap()).unwrap();
        assert!(on_disk.contains("A = \"Enter\""), "{on_disk}");

        // A single-key write still reports a one-entry list, so a caller can
        // read `keys` unconditionally.
        let v = handle_request(
            r#"{"verb":"map","preset":"Panel P1","function":"B","key":"G"}"#,
            &d,
            FAST,
        );
        assert_eq!(v["keys"], serde_json::json!(["G"]), "{v}");
        // …and a clear reports the empty one.
        let v = handle_request(
            r#"{"verb":"map","preset":"Panel P1","function":"B","clear":true}"#,
            &d,
            FAST,
        );
        assert_eq!(v["keys"], serde_json::json!([]), "{v}");
        assert_eq!(v["key"], serde_json::Value::Null, "{v}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // -- map-restore --------------------------------------------------------

    #[test]
    fn map_restore_validates_preset_and_mode() {
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let d = deps(tx, state, no_profiles());
        for junk in [
            r#"{"verb":"map-restore"}"#,
            r#"{"verb":"map-restore","preset":"Panel P1"}"#,
            r#"{"verb":"map-restore","preset":"Panel P1","mode":"yolo"}"#,
        ] {
            let v = handle_request(junk, &d, FAST);
            assert_eq!(v["ok"], false, "{junk} → {v}");
        }
        // The refusal must list all three spellings, or a caller cannot guess
        // the one it is missing.
        let v = handle_request(
            r#"{"verb":"map-restore","preset":"P","mode":"x"}"#,
            &d,
            FAST,
        );
        let error = v["error"].as_str().unwrap();
        for mode in ["defaults", "session-backup", "latest-backup"] {
            assert!(error.contains(mode), "{error}");
        }
    }

    fn restored(preset: &str, kind: crate::mapping::RestoreKind) -> crate::mapping::AppliedRestore {
        crate::mapping::AppliedRestore {
            path: std::path::PathBuf::from(r"C:\cfg\ksx\presets\Panel P1.toml"),
            preset: preset.to_owned(),
            kind,
            backup: Some(crate::mapping::PresetBackup {
                path: std::path::PathBuf::from(
                    r"C:\cfg\ksx\presets\Panel P1.toml.bak-20260805-143207",
                ),
                stamp: "20260805-143207".to_owned(),
            }),
        }
    }

    #[test]
    fn map_restore_defaults_reports_the_write_the_backup_and_honours_reload() {
        let state = shared(RunState::Stopped);
        let (tx, rx) = unbounded();
        let mut d = deps(tx, state, no_profiles());
        d.restore = Box::new(|preset, kind| {
            assert_eq!(kind, crate::mapping::RestoreKind::Defaults);
            Ok(restored(preset, kind))
        });
        let v = handle_request(
            r#"{"verb":"map-restore","preset":"Panel P1","mode":"defaults","reload":true}"#,
            &d,
            FAST,
        );
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["preset"], "Panel P1");
        assert_eq!(v["mode"], "defaults");
        assert_eq!(v["reloaded"], false, "nothing runs, nothing reloads");
        // FIX 2: the response says exactly what was written — never the bare
        // word "defaults" — and where the old file went.
        assert!(v["wrote"].as_str().unwrap().contains("KSX keyboard"), "{v}");
        assert_eq!(v["backup"]["stamp"], "20260805-143207", "{v}");
        assert_eq!(v["backup"]["label"], "2026-08-05 14:32:07 UTC", "{v}");
        let message = v["message"].as_str().unwrap();
        assert!(message.contains("KSX keyboard layout"), "{v}");
        assert!(message.contains("backed up as"), "{v}");
        assert!(rx.try_recv().is_err(), "no reload while stopped");
    }

    /// The third destination (FIX 2): undo the previous restore.
    #[test]
    fn map_restore_accepts_latest_backup() {
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let mut d = deps(tx, state, no_profiles());
        d.restore = Box::new(|preset, kind| {
            assert_eq!(kind, crate::mapping::RestoreKind::LatestBackup);
            Ok(restored(preset, kind))
        });
        let v = handle_request(
            r#"{"verb":"map-restore","preset":"Panel P1","mode":"latest-backup"}"#,
            &d,
            FAST,
        );
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["mode"], "latest-backup", "{v}");
    }

    /// `map-backups` is the read-only list the mapper labels its third button
    /// with ("Restore backup from …").
    #[test]
    fn map_backups_lists_the_restore_points_newest_first() {
        let state = shared(RunState::Stopped);
        let (tx, rx) = unbounded();
        let mut d = deps(tx, state, no_profiles());
        d.backups = Box::new(|preset| {
            assert_eq!(preset, "Panel P1");
            Ok(vec![
                crate::mapping::PresetBackup {
                    path: std::path::PathBuf::from("b.bak-20260805-143207"),
                    stamp: "20260805-143207".to_owned(),
                },
                crate::mapping::PresetBackup {
                    path: std::path::PathBuf::from("a.bak-20260804-090000"),
                    stamp: "20260804-090000".to_owned(),
                },
            ])
        });
        let v = handle_request(r#"{"verb":"map-backups","preset":"Panel P1"}"#, &d, FAST);
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["backups"][0]["label"], "2026-08-05 14:32:07 UTC", "{v}");
        assert_eq!(v["backups"][1]["stamp"], "20260804-090000", "{v}");
        assert!(rx.try_recv().is_err(), "a read-only verb touches nothing");

        let v = handle_request(r#"{"verb":"map-backups"}"#, &d, FAST);
        assert_eq!(v["ok"], false, "a preset is required: {v}");
    }

    #[test]
    fn map_restore_surfaces_the_no_backup_reason() {
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let mut d = deps(tx, state, no_profiles());
        d.restore = Box::new(|preset, _kind| {
            Err(crate::mapping::MapError::NoSessionBackup {
                preset: preset.to_owned(),
            })
        });
        let v = handle_request(
            r#"{"verb":"map-restore","preset":"Panel P1","mode":"session-backup"}"#,
            &d,
            FAST,
        );
        assert_eq!(v["ok"], false, "{v}");
        assert!(
            v["error"].as_str().unwrap().contains("nothing to undo"),
            "{v}"
        );
    }

    /// End-to-end through the REAL writers: the daemon-lifetime map_fn takes
    /// the session backup before its first write, and map-restore
    /// session-backup undoes every later write of that lifetime.
    #[test]
    fn map_fn_snapshots_once_and_session_backup_restores_it() {
        let dir = std::env::temp_dir().join(format!(
            "ksx-pipe-session-bak-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = ksx_config::ConfigRoot::at(&dir);
        let store = ksx_config::Store::new(root.clone());
        let file: ksx_config::PresetFile =
            toml::from_str("name = \"Panel P1\"\n[bindings]\nA = \"S\"\n").unwrap();
        store.save_preset(&file).unwrap();

        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let mut d = deps(tx, state, no_profiles());
        d.map = preset_writers(root.clone()).0;
        d.restore = restore_fn(root);

        for req in [
            r#"{"verb":"map","preset":"Panel P1","function":"A","key":"G"}"#,
            r#"{"verb":"map","preset":"Panel P1","function":"B","key":"F"}"#,
        ] {
            let v = handle_request(req, &d, FAST);
            assert_eq!(v["ok"], true, "{req} → {v}");
        }
        let edited = std::fs::read_to_string(store.preset_path("Panel P1").unwrap()).unwrap();
        assert!(edited.contains("A = \"G\""), "{edited}");

        let v = handle_request(
            r#"{"verb":"map-restore","preset":"Panel P1","mode":"session-backup"}"#,
            &d,
            FAST,
        );
        assert_eq!(v["ok"], true, "{v}");
        let restored = std::fs::read_to_string(store.preset_path("Panel P1").unwrap()).unwrap();
        assert!(
            restored.contains("A = \"S\""),
            "backup is the PRE-first-write state: {restored}"
        );
        assert!(!restored.contains("B = \"F\""), "{restored}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The reason `map` and `map-macro` are built together: they write the
    /// same files, so "undo everything since the daemon started" has to mean
    /// the snapshot taken before the first write by EITHER of them. A set per
    /// writer would let the macro write re-snapshot a file the bind had
    /// already changed, and the undo would restore a state that never existed.
    #[test]
    fn the_two_preset_writers_share_one_session_snapshot() {
        let dir = std::env::temp_dir().join(format!(
            "ksx-pipe-shared-bak-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = ksx_config::ConfigRoot::at(&dir);
        let store = ksx_config::Store::new(root.clone());
        let file: ksx_config::PresetFile = toml::from_str(
            "name = \"Panel P1\"\n[bindings]\nA = \"S\"\n\
             [macros.m]\nsteps = [{ hold = [\"A\"], ms = 50 }]\n",
        )
        .unwrap();
        store.save_preset(&file).unwrap();

        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let mut d = deps(tx, state, no_profiles());
        let (map, save_macro) = preset_writers(root.clone());
        d.map = map;
        d.save_macro = save_macro;
        d.restore = restore_fn(root);

        // A bind first (which takes the snapshot), then a macro body.
        for req in [
            r#"{"verb":"map","preset":"Panel P1","function":"A","key":"G"}"#,
            r#"{"verb":"map-macro","preset":"Panel P1","name":"m","steps":[{"hold":["B"],"ms":90}]}"#,
        ] {
            let v = handle_request(req, &d, FAST);
            assert_eq!(v["ok"], true, "{req} → {v}");
        }

        let v = handle_request(
            r#"{"verb":"map-restore","preset":"Panel P1","mode":"session-backup"}"#,
            &d,
            FAST,
        );
        assert_eq!(v["ok"], true, "{v}");
        let restored = std::fs::read_to_string(store.preset_path("Panel P1").unwrap()).unwrap();
        assert!(
            restored.contains("A = \"S\""),
            "the snapshot is the PRE-first-write state: {restored}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn learn_key_is_refused_while_a_session_runs() {
        for run in [RunState::Running { slots: 4 }, RunState::Starting] {
            let state = shared(run);
            let (tx, _rx) = unbounded();
            let v = handle_request(
                r#"{"verb":"learn-key"}"#,
                &deps(tx, state, no_profiles()),
                FAST,
            );
            assert_eq!(v["ok"], false, "{v}");
            let error = v["error"].as_str().unwrap();
            assert!(error.contains("while a session is running"), "{error}");
            assert!(error.contains("ksx map"), "the way out is named: {error}");
        }
    }

    #[test]
    fn learn_key_listens_with_a_countdown_then_cancel_stops_it() {
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let d = deps(tx, state, no_profiles());
        let v = handle_request(r#"{"verb":"learn-key"}"#, &d, FAST);
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["state"], "listening");
        assert!(v["remaining_ms"].as_u64().unwrap() <= 10_000, "{v}");

        let v = handle_request(r#"{"verb":"learn-poll"}"#, &d, FAST);
        assert_eq!(v["state"], "listening");

        let v = handle_request(r#"{"verb":"learn-cancel"}"#, &d, FAST);
        assert_eq!(v["state"], "cancelled");
        let v = handle_request(r#"{"verb":"learn-poll"}"#, &d, FAST);
        assert_eq!(v["state"], "cancelled");
    }

    #[test]
    fn simultaneous_input_test_is_bounded_typed_and_refused_during_play() {
        for run in [RunState::Running { slots: 1 }, RunState::Starting] {
            let state = shared(run);
            let (tx, _rx) = unbounded();
            let v = handle_request(
                r#"{"verb":"input-test-start","selector":"usb:d209:0430:00","duration_ms":5000}"#,
                &deps(tx, state, no_profiles()),
                FAST,
            );
            assert_eq!(v["ok"], false, "{v}");
            assert_eq!(v["code"], "session-running", "{v}");
        }

        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let d = deps(tx, state, no_profiles());
        for bad in [
            r#"{"verb":"input-test-start","selector":"","duration_ms":5000}"#,
            r#"{"verb":"input-test-start","selector":"usb:d209:0430:00","duration_ms":999}"#,
            r#"{"verb":"input-test-start","selector":"usb:d209:0430:00","duration_ms":5000,"guess":true}"#,
        ] {
            let v = handle_request(bad, &d, FAST);
            assert_eq!(v["ok"], false, "{bad} -> {v}");
            assert_eq!(v["code"], "bad-request", "{bad} -> {v}");
        }
    }

    #[test]
    fn simultaneous_input_test_reports_backend_reduced_held_seen_and_peak() {
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let mut d = deps(tx, state, no_profiles());
        d.input_test = super::super::input_test::InputTestService::new(Arc::new(
            |_selector, _timeout, _cancel, emit| {
                for event in [
                    super::super::input_test::InputTransition {
                        key: "A".into(),
                        down: true,
                    },
                    super::super::input_test::InputTransition {
                        key: "S".into(),
                        down: true,
                    },
                    super::super::input_test::InputTransition {
                        key: "A".into(),
                        down: false,
                    },
                ] {
                    emit(event);
                }
                Ok(0)
            },
        ));
        let started = handle_request(
            r#"{"verb":"input-test-start","selector":"usb:d209:0430:00","duration_ms":5000}"#,
            &d,
            FAST,
        );
        let generation = started["generation"].as_u64().expect("generation");
        let deadline = Instant::now() + Duration::from_secs(2);
        let view = loop {
            let view = handle_request(r#"{"verb":"input-test-poll"}"#, &d, FAST);
            if view["state"] != "listening" {
                break view;
            }
            assert!(Instant::now() < deadline, "observer did not settle: {view}");
            std::thread::sleep(Duration::from_millis(2));
        };
        assert_eq!(view["generation"], generation);
        assert_eq!(view["held"], serde_json::json!(["S"]));
        assert_eq!(view["seen"], serde_json::json!(["A", "S"]));
        assert_eq!(view["peak"], 2);
        assert_eq!(view["rollover_visibility"], "unavailable");
    }

    #[test]
    fn learn_and_simultaneous_test_cannot_own_the_observer_together() {
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let d = deps(tx, state, no_profiles());
        assert_eq!(
            handle_request(r#"{"verb":"learn-key"}"#, &d, FAST)["state"],
            "listening"
        );
        let refused = handle_request(
            r#"{"verb":"input-test-start","selector":"usb:d209:0430:00","duration_ms":5000}"#,
            &d,
            FAST,
        );
        assert_eq!(refused["code"], "observer-busy", "{refused}");
        handle_request(r#"{"verb":"learn-cancel"}"#, &d, FAST);
        let deadline = Instant::now() + Duration::from_secs(2);
        while d.learn.observer_active() {
            assert!(
                Instant::now() < deadline,
                "Learn did not release its observer"
            );
            std::thread::sleep(Duration::from_millis(2));
        }

        let test = handle_request(
            r#"{"verb":"input-test-start","selector":"usb:d209:0430:00","duration_ms":5000}"#,
            &d,
            FAST,
        );
        assert_eq!(test["state"], "listening", "{test}");
        let play = handle_request(r#"{"verb":"start"}"#, &d, FAST);
        assert_eq!(play["code"], "observer-busy", "{play}");
        let learn = handle_request(r#"{"verb":"learn-key"}"#, &d, FAST);
        assert_eq!(learn["code"], "observer-busy", "{learn}");
        handle_request(r#"{"verb":"input-test-cancel"}"#, &d, FAST);
    }

    /// Broken version caught: Learn cancel answered `cancelled` while its Raw
    /// Input thread was still releasing, so the immediately-following input
    /// test bounced with `observer-busy` even though the user had completed
    /// the required cancellation step.
    #[test]
    fn a_terminal_learn_cleanup_hands_off_to_input_test_within_a_bounded_grace() {
        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let mut d = deps(tx, state, no_profiles());
        let release_cleanup = Arc::new(std::sync::atomic::AtomicBool::new(false));
        d.learn = super::super::learn::LearnService::new(Arc::new({
            let release_cleanup = Arc::clone(&release_cleanup);
            move |_timeout, cancel| {
                while !cancel.load(std::sync::atomic::Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(2));
                }
                while !release_cleanup.load(std::sync::atomic::Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(2));
                }
                Ok(None)
            }
        }));

        assert_eq!(
            handle_request(r#"{"verb":"learn-key"}"#, &d, FAST)["state"],
            "listening"
        );
        assert_eq!(
            handle_request(r#"{"verb":"learn-cancel"}"#, &d, FAST)["state"],
            "cancelled"
        );
        assert!(d.learn.observer_active(), "cleanup tail was not held open");
        let release = Arc::clone(&release_cleanup);
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(40));
            release.store(true, std::sync::atomic::Ordering::SeqCst);
        });

        let started = handle_request(
            r#"{"verb":"input-test-start","selector":"usb:d209:0430:00","duration_ms":5000}"#,
            &d,
            FAST,
        );
        releaser.join().unwrap();
        assert_eq!(started["state"], "listening", "{started}");
        handle_request(r#"{"verb":"input-test-cancel"}"#, &d, FAST);
    }

    /// The reverse handoff has the same customer contract: Cancel is a
    /// terminal answer, so the next deliberate observer action must absorb the
    /// short OS-release tail rather than bounce with a misleading busy error.
    #[test]
    fn a_cancelled_input_test_hands_off_immediately_to_learn_and_a_new_test() {
        fn releasing_input_test(
            released: Arc<std::sync::atomic::AtomicBool>,
        ) -> super::super::input_test::InputTestService {
            super::super::input_test::InputTestService::new(Arc::new(
                move |_selector, _deadline, cancel, _emit| {
                    while !cancel.load(std::sync::atomic::Ordering::SeqCst) {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    while !released.load(std::sync::atomic::Ordering::SeqCst) {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Ok(0)
                },
            ))
        }

        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let mut d = deps(tx, state, no_profiles());
        let release = Arc::new(std::sync::atomic::AtomicBool::new(false));
        d.input_test = releasing_input_test(Arc::clone(&release));
        assert_eq!(
            handle_request(
                r#"{"verb":"input-test-start","selector":"usb:d209:0430:00","duration_ms":5000}"#,
                &d,
                FAST,
            )["state"],
            "listening"
        );
        assert_eq!(
            handle_request(r#"{"verb":"input-test-cancel"}"#, &d, FAST)["state"],
            "cancelled"
        );
        assert!(
            d.input_test.observer_active(),
            "cleanup tail was not held open"
        );
        let release_now = Arc::clone(&release);
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(40));
            release_now.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        let learned = handle_request(r#"{"verb":"learn-key"}"#, &d, FAST);
        releaser.join().unwrap();
        assert_eq!(learned["state"], "listening", "{learned}");
        handle_request(r#"{"verb":"learn-cancel"}"#, &d, FAST);

        let deadline = Instant::now() + Duration::from_secs(2);
        while d.learn.observer_active() {
            assert!(
                Instant::now() < deadline,
                "Learn did not release its observer"
            );
            std::thread::sleep(Duration::from_millis(2));
        }

        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let mut d = deps(tx, state, no_profiles());
        let release = Arc::new(std::sync::atomic::AtomicBool::new(false));
        d.input_test = releasing_input_test(Arc::clone(&release));
        let first = handle_request(
            r#"{"verb":"input-test-start","selector":"usb:d209:0430:00","duration_ms":5000}"#,
            &d,
            FAST,
        );
        let first_generation = first["generation"].as_u64().unwrap();
        handle_request(
            &format!(r#"{{"verb":"input-test-cancel","generation":{first_generation}}}"#),
            &d,
            FAST,
        );
        let release_now = Arc::clone(&release);
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(40));
            release_now.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        let second = handle_request(
            r#"{"verb":"input-test-start","selector":"usb:d209:0430:00","duration_ms":5000}"#,
            &d,
            FAST,
        );
        releaser.join().unwrap();
        assert_eq!(second["state"], "listening", "{second}");
        assert!(
            second["generation"].as_u64().unwrap() > first_generation,
            "a fresh generation was not opened: {second}"
        );
        handle_request(r#"{"verb":"input-test-cancel"}"#, &d, FAST);
    }

    #[test]
    fn junk_and_unknown_verbs_are_answered_not_dropped() {
        let state = shared(RunState::Stopped);
        let (tx, rx) = unbounded();
        for junk in ["not json", "{}", r#"{"verb":"launch nukes"}"#, ""] {
            let v = handle_request(junk, &deps(tx.clone(), state.clone(), no_profiles()), FAST);
            assert_eq!(v["ok"], false, "{junk:?} → {v}");
            assert!(v["error"].is_string(), "{junk:?} → {v}");
        }
        assert!(rx.try_recv().is_err());
    }

    // -- transport, Windows only --------------------------------------------

    #[cfg(windows)]
    mod transport {
        use super::*;

        fn unique_pipe(tag: &str) -> String {
            format!(r"\\.\pipe\ksx-test-{}-{tag}", std::process::id())
        }

        #[test]
        fn one_request_one_response_per_connection_served_sequentially() {
            let name = unique_pipe("roundtrip");
            let state = shared(RunState::Running { slots: 4 });
            let (tx, _rx) = unbounded();
            server::spawn_with(
                name.clone(),
                deps(tx, state, fixed_profiles()),
                Duration::from_millis(100),
            );

            // Sequential connections: each opens, asks, gets one line.
            for _ in 0..3 {
                let v = client::request(&name, &serde_json::json!({ "verb": "status" }))
                    .expect("round trip");
                assert_eq!(v["ok"], true);
                assert_eq!(v["run"], "running");
                assert_eq!(v["profiles"][0]["title"], "Example Game");
            }
        }

        #[test]
        fn concurrent_clients_all_get_served() {
            let name = unique_pipe("concurrent");
            let state = shared(RunState::Stopped);
            let (tx, _rx) = unbounded();
            server::spawn_with(
                name.clone(),
                deps(tx, state, no_profiles()),
                Duration::from_millis(10),
            );
            let handles: Vec<_> = (0..4)
                .map(|_| {
                    let name = name.clone();
                    std::thread::spawn(move || {
                        client::request(&name, &serde_json::json!({ "verb": "status" }))
                    })
                })
                .collect();
            for handle in handles {
                let v = handle.join().unwrap().expect("every client is answered");
                assert_eq!(v["ok"], true);
            }
        }

        #[test]
        fn no_daemon_means_not_running_not_a_hang() {
            let err = client::request(
                &unique_pipe("absent"),
                &serde_json::json!({ "verb": "status" }),
            )
            .unwrap_err();
            assert!(matches!(err, client::ClientError::NotRunning), "{err}");
        }

        #[test]
        fn quit_ack_closes_current_and_precreated_pipe_before_success() {
            let name = unique_pipe("quit-handshake");
            let state = shared(RunState::Stopped);
            let (tx, rx) = unbounded();
            let shutdown = ShutdownHandshake::default();
            server::spawn_with_shutdown(
                name.clone(),
                deps(tx, state, no_profiles()),
                Duration::from_secs(1),
                shutdown.clone(),
            );

            let client_name = name.clone();
            let client_thread = std::thread::spawn(move || {
                client::request(&client_name, &serde_json::json!({ "verb": "quit" }))
            });
            assert_eq!(
                rx.recv_timeout(Duration::from_secs(1)).unwrap(),
                DaemonCommand::Quit
            );

            // Stand in for daemon main *after* its control loop/tray join and
            // explicit panel release. This call itself waits for server-side
            // closure, pinning the no-deadlock order in both directions.
            let daemon_main = std::thread::spawn({
                let shutdown = shutdown.clone();
                move || shutdown.daemon_stopped_and_wait_for_pipe(Duration::from_secs(1))
            });
            let response = client_thread.join().unwrap().expect("Quit response");
            assert_eq!(response["ok"], true, "{response}");
            assert!(daemon_main.join().unwrap(), "server closed its pipe");
            client::wait_until_closed(&name, Duration::from_secs(1))
                .expect("neither current nor queued instance remains");
        }

        #[test]
        fn a_second_server_on_the_same_name_is_refused_but_the_first_keeps_serving() {
            let name = unique_pipe("dup");
            let state = shared(RunState::Stopped);
            let (tx, _rx) = unbounded();
            server::spawn_with(
                name.clone(),
                deps(tx.clone(), state.clone(), no_profiles()),
                Duration::from_millis(10),
            );
            // Let the first server own the name before the pretender tries.
            let v = client::request(&name, &serde_json::json!({ "verb": "status" })).unwrap();
            assert_eq!(v["ok"], true);
            server::spawn_with(
                name.clone(),
                deps(tx, state, no_profiles()),
                Duration::from_millis(10),
            );
            std::thread::sleep(Duration::from_millis(100));
            let v = client::request(&name, &serde_json::json!({ "verb": "status" }))
                .expect("the first server still answers");
            assert_eq!(v["ok"], true);
        }

        /// The full loop: pipe → channel → REAL control loop → factory, with
        /// the profile override landing in the factory and the response
        /// reporting the running session.
        #[test]
        fn the_pipe_drives_the_real_control_loop_end_to_end() {
            struct BlockingRunner;
            impl super::super::super::SessionRunner for BlockingRunner {
                fn run(
                    &mut self,
                    stop: Arc<std::sync::atomic::AtomicBool>,
                    _out: &mut dyn std::io::Write,
                ) -> anyhow::Result<super::super::super::SessionSummary> {
                    while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Ok(super::super::super::SessionSummary {
                        stop_code: "daemon-stop".into(),
                        message: "stopped from the pipe".into(),
                        ..Default::default()
                    })
                }
                fn slots(&self) -> usize {
                    3
                }
            }
            struct Factory {
                game: Arc<Mutex<Option<String>>>,
            }
            impl super::super::super::SessionFactory for Factory {
                fn make(&mut self) -> anyhow::Result<Box<dyn super::super::super::SessionRunner>> {
                    Ok(Box::new(BlockingRunner))
                }
                fn config_dir(&self) -> std::path::PathBuf {
                    std::path::PathBuf::from(r"C:\cfg\ksx")
                }
                fn game(&self) -> Option<String> {
                    self.game.lock().unwrap().clone()
                }
                fn set_game(&mut self, game: Option<String>) {
                    *self.game.lock().unwrap() = game;
                }
            }

            let name = unique_pipe("loop");
            let (tx, rx) = unbounded();
            let state: SharedState = Arc::new(Mutex::new(DaemonState::default()));
            let game = Arc::new(Mutex::new(None));
            server::spawn_with(
                name.clone(),
                deps(tx.clone(), state.clone(), no_profiles()),
                Duration::from_secs(2),
            );
            let loop_thread = std::thread::spawn({
                let state = state.clone();
                let game = game.clone();
                move || {
                    let mut factory = Factory { game };
                    let mut out: Vec<u8> = Vec::new();
                    super::super::super::control_loop_with(
                        rx,
                        state,
                        &mut factory,
                        &mut super::super::super::NoPanel,
                        &super::super::super::NoUi,
                        &mut out,
                    );
                }
            });

            let v = client::request(
                &name,
                &serde_json::json!({ "verb": "start", "profile": "Metal Slug" }),
            )
            .expect("start round trip");
            assert_eq!(v["ok"], true, "{v}");
            assert!(v["message"].as_str().unwrap().contains("3 slot(s)"), "{v}");
            assert_eq!(game.lock().unwrap().as_deref(), Some("Metal Slug"));

            let v = client::request(&name, &serde_json::json!({ "verb": "status" })).unwrap();
            assert_eq!(v["run"], "running");
            assert_eq!(v["game"], "Metal Slug");

            let v = client::request(&name, &serde_json::json!({ "verb": "stop" })).unwrap();
            assert_eq!(v["ok"], true, "{v}");

            tx.send(DaemonCommand::Quit).unwrap();
            loop_thread.join().unwrap();
        }
    }

    /// **A slot assignment whose restart FAILED must not report as an idle
    /// daemon.** `reloaded` is documented as "`reload` was asked for and the
    /// daemon acted on it"; echoing the REQUEST made it true in a case where
    /// the daemon had torn a session down and could not bring it back, and
    /// `SlotOutcome::headline` then printed "nothing was running, so nothing
    /// had to restart" at somebody whose four pads had just vanished.
    #[test]
    fn a_slot_assign_whose_restart_fails_says_so_and_never_claims_nothing_was_running() {
        let dir = std::env::temp_dir().join(format!(
            "ksx-slot-bounce-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = ksx_config::ConfigRoot::at(&dir);
        let store = ksx_config::Store::new(root.clone());
        let file: ksx_config::PresetFile =
            toml::from_str("name = \"Panel P1\"\n[bindings]\nA = \"S\"\n").unwrap();
        store.save_preset(&file).unwrap();
        store
            .save_config(&ksx_config::ConfigFile::default())
            .unwrap();

        let state = shared(RunState::Running { slots: 4 });
        let (tx, rx) = unbounded();
        let mut d = deps(tx, state.clone(), no_profiles());
        d.slot_assign = slot_assign_fn(root);

        // Stand in for the control loop's Reload: the session comes down and
        // the restart fails on the new wiring.
        let loop_thread = std::thread::spawn({
            let state = state.clone();
            move || {
                let command = rx.recv_timeout(Duration::from_secs(2)).expect("Reload");
                if let Ok(mut s) = state.lock() {
                    s.run = RunState::Starting;
                }
                std::thread::sleep(Duration::from_millis(10));
                if let Ok(mut s) = state.lock() {
                    s.run = RunState::Failed {
                        message: "cannot start: no usable slot".to_owned(),
                    };
                }
                command
            }
        });

        let v = handle_request(
            r#"{"verb":"slot-assign","slot":1,"preset":"Panel P1","reload":true}"#,
            &d,
            Duration::from_secs(2),
        );
        assert_eq!(loop_thread.join().unwrap(), DaemonCommand::Reload);

        assert_eq!(v["ok"], true, "the FILE was written: {v}");
        assert_eq!(v["restarted"], false, "the restart failed: {v}");
        assert_eq!(
            v["reloaded"], false,
            "the running session was NOT reconciled: {v}"
        );
        let message = v["message"].as_str().unwrap();
        assert!(message.contains("no usable slot"), "{message}");

        // ...and that is what a 10-foot surface prints, verbatim.
        let outcome: ksx_api::SlotOutcome =
            serde_json::from_value::<ksx_api::SlotAssignResponse>(v.clone())
                .expect("a slot-assign response")
                .into();
        let headline = outcome.headline();
        assert!(headline.contains("no usable slot"), "{headline}");
        assert!(
            !headline.contains("nothing was running"),
            "the lie this test exists for: {headline}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **The persona crosses the pipe and lands in the file** — the end of the
    /// wire that task #8 opened, exercised through `handle_request` rather than
    /// through the writer, because the parse happens HERE and nowhere else.
    ///
    /// Three things at once, each of which was a way to get this wrong:
    ///
    /// 1. an ALIAS (`ds4`) is accepted and canonicalized. The alias table lives
    ///    in one `Persona::FromStr`; a daemon that only took canonical names
    ///    would make every surface carry a copy of it to be useful;
    /// 2. an unknown name is refused in `UnknownPersona`'s own words, which
    ///    list every valid persona — so the answer to a typo is the menu;
    /// 3. a request with NO persona leaves the slot's persona alone, and says
    ///    so by reporting `previous_persona: null`.
    ///
    /// Breaks against: a `from_json` that parses the persona in ksx-api (which
    /// would put the alias table on the client side of the boundary), a
    /// handler that drops the field, and any writer that treats absent as
    /// `xbox360`.
    #[test]
    fn a_persona_crosses_the_pipe_by_alias_and_an_unknown_one_gets_the_menu() {
        let dir = std::env::temp_dir().join(format!(
            "ksx-slot-persona-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = ksx_config::ConfigRoot::at(&dir);
        let store = ksx_config::Store::new(root.clone());
        let file: ksx_config::PresetFile =
            toml::from_str("name = \"Panel P1\"\n[bindings]\nA = \"S\"\n").unwrap();
        store.save_preset(&file).unwrap();
        store
            .save_config(&ksx_config::ConfigFile::default())
            .unwrap();

        let state = shared(RunState::Stopped);
        let (tx, _rx) = unbounded();
        let mut d = deps(tx, state, no_profiles());
        d.slot_assign = slot_assign_fn(root);

        // 1 — an alias, on a slot this call creates.
        let v = handle_request(
            r#"{"verb":"slot-assign","slot":5,"preset":"Panel P1","persona":"ds4"}"#,
            &d,
            FAST,
        );
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["persona"], "playstation", "canonical, not the alias: {v}");
        assert_eq!(v["created"], true);
        assert_eq!(
            v["previous_persona"],
            serde_json::Value::Null,
            "a new slot presented itself as nothing before: {v}"
        );
        let text = std::fs::read_to_string(store.root().config_path()).unwrap();
        assert!(text.contains("persona = \"playstation\""), "{text}");

        // 2 — a name nothing knows. The refusal IS the menu.
        let bad = handle_request(
            r#"{"verb":"slot-assign","slot":5,"preset":"Panel P1","persona":"gamecube"}"#,
            &d,
            FAST,
        );
        assert_eq!(bad["ok"], false, "{bad}");
        assert_eq!(bad["code"], "unknown-persona");
        let error = bad["error"].as_str().unwrap();
        for persona in ksx_core::Persona::ALL {
            assert!(error.contains(persona.as_str()), "{error} omits {persona}");
        }

        // 3 — no persona at all: the slot keeps the PlayStation it just got,
        // and nothing claims a change.
        let kept = handle_request(
            r#"{"verb":"slot-assign","slot":5,"preset":"Panel P1"}"#,
            &d,
            FAST,
        );
        assert_eq!(kept["ok"], true, "{kept}");
        assert_eq!(kept["persona"], "playstation", "NOT re-personaed: {kept}");
        assert_eq!(kept["previous_persona"], serde_json::Value::Null);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
