//! Full HTTP round trips against the real server: GET / with the session
//! panel, and the POST → 303 → flash loop. Raw `TcpStream` HTTP/1.1 on
//! purpose — no client dependency, and what a browser sends is exactly this.

use std::io::{Read as _, Write as _};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Refusals are typed now (docs/M9-DECISION.md §6): a fake daemon refuses with
/// the same `Refusal` a real one does, so what the page renders here is what it
/// renders in the field.
use ksx_api::Refusal;
use ksx_studio::{
    BindConflict, BindOutcome, BindRequest, ControlSource, LearnView, MacroOutcome, MacroSnapshot,
    MacroStepView, MacroView, MacroWrite, MapperSlot, MapperSnapshot, PadRow, ProfileRow,
    RestoreMode, SessionView, StatusSnapshot, StatusSource,
};

/// The "nothing answers the pipe" refusal a real `PipeTransport` produces —
/// code, sentence and the way out, so the page under test sees exactly what a
/// cabinet sees.
fn no_channel(message: &str) -> Refusal {
    Refusal::with_remedy(ksx_api::codes::NO_CHANNEL, message, "ksx daemon")
}

struct FixedStatus;

/// A status provider that declares the synthetic machine explicitly. The
/// server harness adds its per-process generation marker around this provider,
/// exactly as the managed fixture launcher does.
struct DeclaredFixtureStatus;

impl StatusSource for DeclaredFixtureStatus {
    fn snapshot(&self) -> StatusSnapshot {
        FixedStatus.snapshot()
    }

    fn environment(&self) -> ksx_api::RuntimeEnvironmentView {
        ksx_api::RuntimeEnvironmentView::fixture(
            "fixture-health-contract",
            "FIXTURE · HEALTH CONTRACT",
            "Synthetic facts for the Studio health endpoint test.",
        )
    }
}

/// The newest timestamped backup this preset has, as `collect_mapper` reads
/// it off disk — the label the mapper's third restore button wears.
const BACKUP_LABEL: &str = "2026-08-05 14:32:07 UTC";

/// Remember every address handed to a test server for this process. The tests
/// run in parallel and `serve` owns its bind internally, so the port-0 probe
/// must be released first. The reservation keeps two in-process probes apart;
/// the nonce handshake below proves which provider won the remaining bind race.
static SERVER_ADDRS: Mutex<Vec<SocketAddr>> = Mutex::new(Vec::new());
static SERVER_NONCE: AtomicU64 = AtomicU64::new(1);

/// Decorate the ordinary status provider with a one-use startup marker. The
/// marker travels through the real `/api/health` handler, so observing it
/// proves much more than "something accepted TCP": this exact fixture's
/// provider, router and listener own the address returned to the test.
struct FixtureStatus {
    inner: Box<dyn StatusSource>,
    marker: String,
}

impl StatusSource for FixtureStatus {
    fn snapshot(&self) -> StatusSnapshot {
        let mut snapshot = self.inner.snapshot();
        snapshot.generated_at.clone_from(&self.marker);
        snapshot
    }

    /// `generation` already means "stable for one fixture process, empty for
    /// live providers", which is exactly a fixture nonce, and the independent
    /// health collector calls `environment()` — so the marker travels through
    /// the REAL handler rather than a test-only path.
    fn environment(&self) -> ksx_api::RuntimeEnvironmentView {
        let mut environment = self.inner.environment();
        environment.generation.clone_from(&self.marker);
        environment
    }

    fn mapper(&self) -> MapperSnapshot {
        self.inner.mapper()
    }

    fn macros(&self, preset: &str) -> MacroSnapshot {
        self.inner.macros(preset)
    }
}

impl StatusSource for FixedStatus {
    fn snapshot(&self) -> StatusSnapshot {
        StatusSnapshot {
            generated_at: "test".into(),
            vigem: "installed".into(),
            hidmaestro: ksx_api::ControllerOutputView::hidmaestro_inventory(
                true,
                false,
                Some("1.6.1".into()),
            ),
            interception: "installed".into(),
            daemon_running: true,
            daemon_detail: "test".into(),
            autostart: "not registered".into(),
            pads: vec![PadRow {
                persona: "Xbox 360 pad".into(),
                instance: "USB\\TEST\\1".into(),
            }],
            profiles: vec![ProfileRow {
                title: "Example Game".into(),
                detail: "C:\\example-game.exe — 2 slots".into(),
            }],
            config_root: "C:\\cfg".into(),
        }
    }

    fn mapper(&self) -> MapperSnapshot {
        let mut bindings = std::collections::BTreeMap::new();
        bindings.insert("A".to_owned(), vec!["G".to_owned()]);
        // MANY KEYS → ONE CONTROL, exactly as a preset file can hold it
        // (docs/INPUT-TRANSFORMS.md §1a) — the multi-bind preset shape
        // already had, and the one the add/remove-one routes are computed
        // against.
        bindings.insert("B".to_owned(), vec!["S".to_owned(), "Enter".to_owned()]);
        MapperSnapshot {
            generated_at: "test".into(),
            source: "slots of profile \"Example Launcher\" (games.toml)".into(),
            profile: Some("Example Launcher".into()),
            config_root: "C:\\cfg".into(),
            slots: vec![MapperSlot {
                number: 1,
                persona: "xbox360".into(),
                persona_label: "Xbox 360".into(),
                preset: "Panel P1".into(),
                keyboard: "HID\\TEST".into(),
                bindings,
                backup: Some(BACKUP_LABEL.to_owned()),
                session_backup: true,
                // One AUTO-FIRING control, so the legend badge is covered by
                // the ordinary page assertions.
                turbo: std::collections::BTreeMap::from([("B".to_owned(), 12)]),
                toggle: Default::default(),
                macros_off: false,
            }],
        }
    }

    /// The preset's `[macros]` tables, in the file's own shape — what
    /// ksx-backend's collector reads off disk (`ms` and `frames` kept apart, the
    /// `macro.<name>` rows resolved into `triggers`).
    fn macros(&self, preset: &str) -> MacroSnapshot {
        MacroSnapshot::read(
            preset,
            vec![MacroView {
                name: "hadouken".into(),
                steps: vec![
                    MacroStepView {
                        hold: vec!["dpad.down".into()],
                        ms: Some(50),
                        frames: None,
                        allow_short: false,
                    },
                    MacroStepView {
                        hold: vec!["A".into()],
                        ms: None,
                        frames: Some(3),
                        allow_short: false,
                    },
                ],
                on_release: "finish".into(),
                retrigger: "ignore".into(),
                interrupt: "none".into(),
                repeat: "once".into(),
                turbo_hz: None,
                gap_ms: None,
                triggers: vec!["P".into()],
                disabled: false,
            }],
        )
    }
}

struct FixedMapperStatus(MapperSnapshot);

impl StatusSource for FixedMapperStatus {
    fn snapshot(&self) -> StatusSnapshot {
        StatusSnapshot::default()
    }

    fn mapper(&self) -> MapperSnapshot {
        self.0.clone()
    }
}

/// Scriptable control: session() flips between idle and running; start()
/// records the profile it was given and either succeeds or refuses.
struct ScriptedControl {
    running: AtomicBool,
    refuse_start: bool,
    /// Every ControlSource call fails the way an absent daemon fails.
    no_daemon: bool,
    started_with: std::sync::Mutex<Option<Option<String>>>,
    /// How many times `resume` was asked for. The mapper's Resume must reach
    /// THIS and not `start` — see `ksx_api::ControlSource::resume`.
    resumes: AtomicUsize,
    /// The staged setup, held the way the daemon holds it — a real
    /// `ksx_core::StagedSetup` driven by real `StageEdit`s. A fake that stored
    /// the posted strings would let the page pass while the domain refused,
    /// which is the entire thing these routes are for.
    staged: Mutex<ksx_core::stage::StagedSetup>,
    /// Set when `stage_play` actually got as far as starting something. The
    /// assertion that matters is that it is still `false` after a Play the
    /// stage refuses.
    played: AtomicBool,
    /// Whether the session factory currently points at the staged setup, and
    /// the exact whole-draft token proven live by successful Play/Apply.
    session_staged: AtomicBool,
    active_stage_revision: Mutex<Option<String>>,
    committed: AtomicBool,
    learning: AtomicBool,
    learn_generation: AtomicUsize,
    input_test_generation: AtomicUsize,
    input_test_spec: Mutex<Option<ksx_api::InputTestSpec>>,
    input_test_cancelled: AtomicBool,
    /// Script the daemon-owned observer-release fence used before a chart
    /// opens the encoder's configuration collection.
    input_test_release_fence_refusal: Mutex<Option<Refusal>>,
    input_test_release_fence_calls: AtomicUsize,
    /// The daemon's StageMeta dirty stamp, scripted: set by the test that
    /// exercises the Apply button's running+dirty visibility.
    dirty: AtomicBool,
    /// Daemon-style staged mutation generation. Unlike the content fallback
    /// this changes even when a slot is removed and recreated identically.
    stage_revision: AtomicUsize,
    /// Scripts `stage_apply` to refuse with `needs-restart`.
    apply_needs_restart: AtomicBool,
    /// Emulate an older daemon whose staged slot predates the authoring table.
    without_authoring: bool,
    /// Keep macro tables readable while making the direct mapper projection
    /// fail, so persona labels and the two availability channels are tested
    /// independently.
    invalid_mapping_authoring: AtomicBool,
    /// Optional one-shot daemon learner hit: exact interface path plus the
    /// canonical key name the real observer returns. Ordinary mapper fixtures
    /// leave this empty and continue reporting `listening`.
    identify_hit: Mutex<Option<(String, String)>>,
    bound_with: std::sync::Mutex<Option<BindRequest>>,
    restored_with: std::sync::Mutex<Option<(String, String)>>,
    cleared: std::sync::Mutex<Option<String>>,
    saved_macro: std::sync::Mutex<Option<MacroWrite>>,
    /// Optional machine-guard lifetime probe used by the encoder bind tests.
    route_guard_probe: Mutex<Option<Arc<AtomicBool>>>,
    stage_bind_saw_route_guard: AtomicBool,
}

impl ScriptedControl {
    fn new(refuse_start: bool) -> Self {
        Self {
            running: AtomicBool::new(false),
            refuse_start,
            no_daemon: false,
            started_with: std::sync::Mutex::new(None),
            resumes: AtomicUsize::new(0),
            staged: Mutex::new(ksx_core::stage::StagedSetup::new()),
            played: AtomicBool::new(false),
            session_staged: AtomicBool::new(false),
            active_stage_revision: Mutex::new(None),
            committed: AtomicBool::new(false),
            learning: AtomicBool::new(false),
            learn_generation: AtomicUsize::new(0),
            input_test_generation: AtomicUsize::new(0),
            input_test_spec: Mutex::new(None),
            input_test_cancelled: AtomicBool::new(false),
            input_test_release_fence_refusal: Mutex::new(None),
            input_test_release_fence_calls: AtomicUsize::new(0),
            dirty: AtomicBool::new(false),
            stage_revision: AtomicUsize::new(0),
            apply_needs_restart: AtomicBool::new(false),
            without_authoring: false,
            invalid_mapping_authoring: AtomicBool::new(false),
            identify_hit: Mutex::new(None),
            bound_with: std::sync::Mutex::new(None),
            restored_with: std::sync::Mutex::new(None),
            cleared: std::sync::Mutex::new(None),
            saved_macro: std::sync::Mutex::new(None),
            route_guard_probe: Mutex::new(None),
            stage_bind_saw_route_guard: AtomicBool::new(false),
        }
    }

    /// Nothing answers the pipe — the reported state after quitting the tray
    /// daemon and then clicked around /map.
    fn dead() -> Self {
        Self {
            no_daemon: true,
            ..Self::new(true)
        }
    }

    fn with_identify_hit(self, device: impl Into<String>) -> Self {
        self.with_identify_key_hit(device, "A")
    }

    fn with_identify_key_hit(self, device: impl Into<String>, key: impl Into<String>) -> Self {
        *self.identify_hit.lock().unwrap() = Some((device.into(), key.into()));
        self
    }

    fn whole_stage_revision(&self) -> String {
        format!(
            "test-d1-{:016x}",
            self.stage_revision.load(Ordering::SeqCst)
        )
    }

    fn stamp_target_revisions(&self, view: &mut ksx_api::StagedSetupView) {
        let revision = self.stage_revision.load(Ordering::SeqCst);
        view.revision = self.whole_stage_revision();
        for slot in &mut view.slots {
            let content = ksx_api::staged_slot_revision(slot);
            slot.target_revision = format!("test-d1-{revision:016x}-{content}");
        }
    }
}

/// What every verb says when there is no daemon, matching the real
/// PipeControlSource's `NO_CHANNEL`.
const NO_CHANNEL: &str = "no daemon control channel — start the daemon (tray, or `ksx daemon`)";

impl ControlSource for ScriptedControl {
    /// The verb `/setup`'s step 2 performs. `restarted` is TRUE, because the
    /// real one bounces the pads — the flash has to say so, and a fake that
    /// quietly said otherwise would let that regression ship.
    fn assign_slot(&self, request: &ksx_api::SlotAssignRequest) -> ksx_api::SlotOutcome {
        if self.no_daemon {
            return ksx_api::SlotOutcome::failed(NO_CHANNEL, "ksx daemon");
        }
        // `None` is "keep the preset it has" (the persona-only write), which
        // this cabinet's slot 1 answers with the one preset it owns. Only a
        // NAMED preset that is not on disk is a refusal.
        let preset = request.preset.clone().unwrap_or_else(|| "Panel P1".into());
        if preset != "Panel P1" {
            return ksx_api::SlotOutcome {
                ok: false,
                error: Some(format!("no preset named \"{preset}\" on disk")),
                code: Some(ksx_api::codes::UNKNOWN_PRESET.into()),
                ..ksx_api::SlotOutcome::default()
            };
        }
        // The persona the request asked for, canonicalized the way the real
        // daemon canonicalizes it — a fake that echoed the alias back would
        // let a surface that re-sends what it was shown ship a second
        // spelling.
        let persona = request
            .persona
            .as_deref()
            .and_then(|name| name.parse::<ksx_core::Persona>().ok())
            .unwrap_or_default();
        // Faithful to `bounce_after_slot_write` (ksx-backend/src/daemon/pipe.rs):
        // the pads replug only when a session was RUNNING, and the daemon's own
        // sentence says which of the two happened. A fake that reported
        // `restarted` off the request rather than off the session is exactly
        // what let "The pads replugged." ship as an unconditional suffix.
        let running = self.running.load(Ordering::SeqCst);
        let mut message = format!(
            "slot {} now uses \"{preset}\" as a {} pad",
            request.slot,
            persona.label()
        );
        let (restarted, reloaded) = if !running {
            message.push_str(" — nothing is running, so the next start reads it");
            (false, true)
        } else if request.reload {
            message.push_str(" — the session restarted and the pads replugged");
            (true, true)
        } else {
            message.push_str(" — a session is running on the old wiring; `reload` to restart it");
            (false, false)
        };
        ksx_api::SlotOutcome {
            ok: true,
            message: Some(message),
            slot: Some(request.slot),
            preset: Some(preset),
            persona: Some(persona.as_str().to_owned()),
            profile: request.profile.clone(),
            restarted,
            reloaded,
            ..ksx_api::SlotOutcome::default()
        }
    }

    fn session(&self) -> SessionView {
        if self.no_daemon {
            // The profile still comes from the config, so the banner can print
            // a command that actually starts THIS cabinet.
            return SessionView {
                profile: Some("Example Launcher".into()),
                ..SessionView::unreachable(NO_CHANNEL)
            };
        }
        if self.running.load(Ordering::SeqCst) {
            SessionView {
                reachable: true,
                running: true,
                line: "running — 4 pad(s)".into(),
                profile: Some("Example Game".into()),
                origin: if self.session_staged.load(Ordering::SeqCst) {
                    ksx_api::SessionOrigin::Staged
                } else {
                    ksx_api::SessionOrigin::Config
                },
                active_stage_revision: self.active_stage_revision.lock().unwrap().clone(),
                active: None,
            }
        } else {
            SessionView {
                reachable: true,
                running: false,
                line: "idle".into(),
                profile: None,
                origin: ksx_api::SessionOrigin::Unknown,
                active_stage_revision: None,
                active: None,
            }
        }
    }

    fn start(&self, profile: Option<&str>) -> Result<String, Refusal> {
        *self.started_with.lock().unwrap() = Some(profile.map(str::to_owned));
        if self.refuse_start {
            Err(no_channel("no ksx daemon control channel at the pipe"))
        } else {
            self.session_staged.store(false, Ordering::SeqCst);
            *self.active_stage_revision.lock().unwrap() = None;
            self.running.store(true, Ordering::SeqCst);
            Ok("running (4 slot(s))".into())
        }
    }

    fn stop(&self) -> Result<String, Refusal> {
        if self.no_daemon {
            return Err(no_channel(NO_CHANNEL));
        }
        self.running.store(false, Ordering::SeqCst);
        *self.active_stage_revision.lock().unwrap() = None;
        Ok("stopped".into())
    }

    /// The daemon puts back whatever it was running, and takes no argument to
    /// do it. Recorded rather than delegated to `start`, so a page that
    /// "resumed" by starting something can be told apart from one that
    /// resumed.
    fn resume(&self) -> Result<String, Refusal> {
        if self.no_daemon {
            return Err(no_channel(NO_CHANNEL));
        }
        self.resumes.fetch_add(1, Ordering::SeqCst);
        self.running.store(true, Ordering::SeqCst);
        Ok("running (4 slot(s))".into())
    }

    fn reload(&self) -> Result<String, Refusal> {
        Ok("running (4 slot(s))".into())
    }

    fn learn_start(&self) -> LearnView {
        if self.no_daemon {
            return LearnView::unavailable(NO_CHANNEL);
        }
        self.learning.store(true, Ordering::SeqCst);
        let generation = self.learn_generation.fetch_add(1, Ordering::SeqCst) + 1;
        LearnView {
            ok: true,
            state: "listening".into(),
            generation: Some(generation as u64),
            remaining_ms: Some(10_000),
            device: None,
            key: None,
            error: None,
        }
    }

    fn learn_poll(&self) -> LearnView {
        if self.learning.load(Ordering::SeqCst) {
            if let Some((device, key)) = self.identify_hit.lock().unwrap().take() {
                self.learning.store(false, Ordering::SeqCst);
                return LearnView {
                    ok: true,
                    state: "hit".into(),
                    generation: Some(self.learn_generation.load(Ordering::SeqCst) as u64),
                    remaining_ms: None,
                    device: Some(device),
                    key: Some(key),
                    error: None,
                };
            }
            LearnView {
                ok: true,
                state: "listening".into(),
                generation: Some(self.learn_generation.load(Ordering::SeqCst) as u64),
                remaining_ms: Some(9_000),
                device: None,
                key: None,
                error: None,
            }
        } else {
            LearnView {
                ok: true,
                state: "idle".into(),
                generation: None,
                remaining_ms: None,
                device: None,
                key: None,
                error: None,
            }
        }
    }

    fn learn_cancel(&self) -> LearnView {
        self.learning.store(false, Ordering::SeqCst);
        LearnView {
            ok: true,
            state: "cancelled".into(),
            generation: Some(self.learn_generation.load(Ordering::SeqCst) as u64),
            remaining_ms: None,
            device: None,
            key: None,
            error: None,
        }
    }

    fn learn_cancel_generation(&self, generation: Option<u64>) -> LearnView {
        let current = self.learn_generation.load(Ordering::SeqCst) as u64;
        if generation.is_some_and(|generation| generation != current) {
            return self.learn_poll();
        }
        self.learn_cancel()
    }

    fn input_test_start(&self, spec: &ksx_api::InputTestSpec) -> ksx_api::InputTestView {
        let generation = self.input_test_generation.fetch_add(1, Ordering::SeqCst) + 1;
        *self.input_test_spec.lock().unwrap() = Some(spec.clone());
        self.input_test_cancelled.store(false, Ordering::SeqCst);
        ksx_api::InputTestView {
            ok: true,
            state: "listening".into(),
            generation: Some(generation as u64),
            selector: Some(spec.selector.clone()),
            remaining_ms: Some(spec.duration_ms),
            held: vec!["A".into(), "S".into()],
            seen: vec!["A".into(), "S".into(), "D".into()],
            peak: 3,
            events: 7,
            dropped: 0,
            rollover_visibility: "unavailable".into(),
            detail: "KSX observed three simultaneous signals.".into(),
            error: None,
        }
    }

    fn input_test_poll(&self) -> ksx_api::InputTestView {
        let Some(spec) = self.input_test_spec.lock().unwrap().clone() else {
            return ksx_api::InputTestView {
                ok: true,
                state: "idle".into(),
                rollover_visibility: "unavailable".into(),
                detail: "Release every key, then start the test.".into(),
                ..ksx_api::InputTestView::default()
            };
        };
        let cancelled = self.input_test_cancelled.load(Ordering::SeqCst);
        ksx_api::InputTestView {
            ok: true,
            state: if cancelled { "cancelled" } else { "listening" }.into(),
            generation: Some(self.input_test_generation.load(Ordering::SeqCst) as u64),
            selector: Some(spec.selector),
            remaining_ms: (!cancelled).then_some(spec.duration_ms.saturating_sub(1_000)),
            held: if cancelled {
                Vec::new()
            } else {
                vec!["S".into()]
            },
            seen: vec!["A".into(), "S".into(), "D".into()],
            peak: 3,
            events: 8,
            dropped: 0,
            rollover_visibility: "unavailable".into(),
            detail: "KSX observed three simultaneous signals.".into(),
            error: None,
        }
    }

    fn input_test_cancel_generation(&self, generation: Option<u64>) -> ksx_api::InputTestView {
        let current = self.input_test_generation.load(Ordering::SeqCst) as u64;
        if generation.is_some_and(|generation| generation != current) {
            return self.input_test_poll();
        }
        self.input_test_cancelled.store(true, Ordering::SeqCst);
        self.input_test_poll()
    }

    fn input_test_release_fence(&self) -> Result<(), Refusal> {
        self.input_test_release_fence_calls
            .fetch_add(1, Ordering::SeqCst);
        match self
            .input_test_release_fence_refusal
            .lock()
            .unwrap()
            .clone()
        {
            Some(refusal) => Err(refusal),
            None => Ok(()),
        }
    }

    // ── The staged setup, the way the daemon holds it ────────────────────

    fn staged(&self) -> ksx_api::StagedSetupView {
        if self.no_daemon {
            return ksx_api::StagedSetupView::unreachable(NO_CHANNEL);
        }
        let setup = self.staged.lock().unwrap();
        let mut view = ksx_api::StagedSetupView::of(&setup);
        self.stamp_target_revisions(&mut view);
        view.dirty = self.dirty.load(Ordering::SeqCst);
        if self.without_authoring {
            for slot in &mut view.slots {
                slot.authoring = None;
            }
        } else if self.invalid_mapping_authoring.load(Ordering::SeqCst) {
            for slot in &mut view.slots {
                if let Some(authoring) = &mut slot.authoring {
                    authoring.bindings.insert(
                        "not.a.controller.function".into(),
                        ksx_config::BindingEntry::Key("P".into()),
                    );
                }
            }
        }
        view
    }

    /// Apply-in-place, in the daemon's three shapes: refused when nothing
    /// runs, refused `needs-restart` when scripted to differ structurally,
    /// ok otherwise. Apply synchronizes the running session only: it never
    /// writes config.toml, so saved-file dirty state must remain unchanged.
    fn stage_apply(&self) -> ksx_api::StageOutcome {
        if self.no_daemon {
            return ksx_api::StageOutcome::unavailable(NO_CHANNEL);
        }
        let setup = self.staged.lock().unwrap();
        if !self.running.load(Ordering::SeqCst) {
            let refusal =
                ksx_api::Refusal::new("no-session", "nothing is running to apply the draft to");
            return ksx_api::StageOutcome::refused(&setup, &refusal);
        }
        if self.apply_needs_restart.load(Ordering::SeqCst) {
            let refusal =
                ksx_api::Refusal::new("needs-restart", "the draft changed the session's structure");
            return ksx_api::StageOutcome::refused(&setup, &refusal);
        }
        self.session_staged.store(true, Ordering::SeqCst);
        *self.active_stage_revision.lock().unwrap() = Some(self.whole_stage_revision());
        ksx_api::StageOutcome::ok(&setup, "applied in place")
    }

    fn stage_edit(&self, edit: &ksx_api::StageEdit) -> ksx_api::StageOutcome {
        if self.no_daemon {
            return ksx_api::StageOutcome::unavailable(NO_CHANNEL);
        }
        let mut setup = self.staged.lock().unwrap();
        match edit.apply(&setup) {
            Ok(next) => {
                *setup = next;
                self.stage_revision.fetch_add(1, Ordering::SeqCst);
                ksx_api::StageOutcome::ok(&setup, "staged")
            }
            Err(refusal) => ksx_api::StageOutcome::refused(&setup, &refusal),
        }
    }

    fn stage_bind(&self, request: &ksx_api::StagedBindRequest) -> BindOutcome {
        if self
            .route_guard_probe
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|active| active.load(Ordering::SeqCst))
        {
            self.stage_bind_saw_route_guard
                .store(true, Ordering::SeqCst);
        }
        let mut setup = self.staged.lock().unwrap();
        let mut view = ksx_api::StagedSetupView::of(&setup);
        self.stamp_target_revisions(&mut view);
        let prepared = match ksx_api::staged_bind_edit(&view, request) {
            Ok(prepared) => prepared,
            Err(outcome) => return outcome,
        };
        match prepared.edit.apply(&setup) {
            Ok(next) => {
                *setup = next;
                self.stage_revision.fetch_add(1, Ordering::SeqCst);
                let outcome = ksx_api::StageOutcome::ok(&setup, "staged");
                prepared.finish(&outcome)
            }
            Err(refusal) => {
                let outcome = ksx_api::StageOutcome::refused(&setup, &refusal);
                prepared.finish(&outcome)
            }
        }
    }

    /// Adoption with the daemon's exact refusal discipline (`stage-not-empty`
    /// over any content), built THROUGH the real staging edits like the
    /// daemon's own `stage::adopt` — a fake that skipped the engine would let
    /// the menu pass while the domain refused.
    fn stage_adopt(&self, profile: Option<&str>) -> ksx_api::StageOutcome {
        if self.no_daemon {
            return ksx_api::StageOutcome::unavailable(NO_CHANNEL);
        }
        let mut setup = self.staged.lock().unwrap();
        if !ksx_api::StagedSetupView::of(&setup).empty {
            let refusal = ksx_api::Refusal::new(
                "stage-not-empty",
                "this draft already has content; discard it before loading",
            );
            return ksx_api::StageOutcome::refused(&setup, &refusal);
        }
        let mut next = ksx_core::stage::StagedSetup::new();
        for edit in [
            ksx_api::StageEdit::ChooseDevice {
                selector: "usb:d209:0430:00".into(),
                alias: "panel".into(),
                label: "I-PAC".into(),
            },
            ksx_api::StageEdit::AddSlot {
                number: None,
                persona: "xbox360".into(),
                preset: profile.unwrap_or("Panel P1").to_owned(),
                layout: Some("arcade-6button".into()),
            },
        ] {
            match edit.apply(&next) {
                Ok(applied) => next = applied,
                Err(refusal) => return ksx_api::StageOutcome::refused(&setup, &refusal),
            }
        }
        *setup = next;
        self.stage_revision.fetch_add(1, Ordering::SeqCst);
        ksx_api::StageOutcome::ok(&setup, "adopted")
    }

    /// Save, gated by `commit()` exactly as the daemon gates it — the fake
    /// must not report a write for a setup ksx-core refuses.
    fn stage_commit(&self) -> ksx_api::StageOutcome {
        let setup = self.staged.lock().unwrap();
        match setup.commit() {
            Ok(_) => {
                self.committed.store(true, Ordering::SeqCst);
                let mut ok = ksx_api::StageOutcome::ok(&setup, "saved to config.toml");
                ok.saved = Some(r"C:\cfg\config.toml".to_owned());
                ok
            }
            Err(refusal) => ksx_api::StageOutcome::refused(
                &setup,
                &Refusal::from_wire(Some(refusal.code()), refusal.to_string()),
            ),
        }
    }

    /// Play, gated the same way — and it RECORDS whether it started anything,
    /// so a test can assert that a refused Play started nothing rather than
    /// only that the flash looked unhappy.
    fn stage_play(&self) -> ksx_api::StageOutcome {
        let setup = self.staged.lock().unwrap();
        match setup.commit() {
            Ok(_) => {
                self.played.store(true, Ordering::SeqCst);
                self.session_staged.store(true, Ordering::SeqCst);
                *self.active_stage_revision.lock().unwrap() = Some(self.whole_stage_revision());
                self.running.store(true, Ordering::SeqCst);
                let mut ok = ksx_api::StageOutcome::ok(&setup, "the staged setup is playing");
                ok.playing = true;
                ok
            }
            Err(refusal) => ksx_api::StageOutcome::refused(
                &setup,
                &Refusal::from_wire(Some(refusal.code()), refusal.to_string()),
            ),
        }
    }

    fn restore(&self, preset: &str, mode: RestoreMode) -> Result<String, Refusal> {
        *self.restored_with.lock().unwrap() = Some((preset.to_owned(), mode.as_str().to_owned()));
        if self.no_daemon {
            return Err(no_channel(NO_CHANNEL));
        }
        match mode.as_str() {
            "session-backup" => Err(Refusal::new(
                ksx_api::codes::UNKNOWN_PRESET,
                format!("no session backup for \"{preset}\""),
            )),
            "latest-backup" => Ok(format!(
                "\"{preset}\": bindings restored from the newest timestamped backup"
            )),
            _ => Ok(format!(
                "\"{preset}\": bindings reset to the KSX keyboard layout (WASD + arrows)"
            )),
        }
    }

    fn clear_all(&self, preset: &str) -> Result<String, Refusal> {
        *self.cleared.lock().unwrap() = Some(preset.to_owned());
        if self.no_daemon {
            return Err(no_channel(NO_CHANNEL));
        }
        Ok(format!("\"{preset}\": every binding cleared"))
    }

    fn save_macro(&self, request: &MacroWrite) -> MacroOutcome {
        *self.saved_macro.lock().unwrap() = Some(request.clone());
        if self.no_daemon {
            return MacroOutcome::failed(NO_CHANNEL);
        }
        // The one refusal the daemon answers with rows rather than a sentence.
        if request
            .steps
            .iter()
            .any(|s| s.hold.iter().any(|f| f == "warp"))
        {
            return MacroOutcome {
                code: Some("macro-invalid".into()),
                problems: vec!["macro 'hadouken' step 1 holds 'warp'".into()],
                ..MacroOutcome::failed("refusing to write macro \"hadouken\"")
            };
        }
        MacroOutcome {
            ok: true,
            message: Some(if request.delete {
                format!("\"{}\": macro \"{}\" deleted", request.preset, request.name)
            } else {
                format!(
                    "\"{}\": macro \"{}\" = {} step(s)",
                    request.preset,
                    request.name,
                    request.steps.len()
                )
            }),
            warnings: vec!["step 2 asks for 5 ms and was raised to 33 ms".into()],
            deleted: request.delete,
            backup: Some(BACKUP_LABEL.to_owned()),
            reloaded: request.reload,
            ..MacroOutcome::default()
        }
    }

    fn bind(&self, request: &BindRequest) -> BindOutcome {
        *self.bound_with.lock().unwrap() = Some(request.clone());
        if request.key.as_deref() == Some("G") && !request.force {
            BindOutcome {
                ok: false,
                message: None,
                error: Some("refusing to bind G: G is \"Panel P2\"'s A".into()),
                code: Some("conflict".into()),
                conflicts: vec![BindConflict {
                    scope: "profile".into(),
                    preset: "Panel P2".into(),
                    function: "A".into(),
                    file: "games.toml".into(),
                    profile: Some("Example Launcher".into()),
                    slot: Some(2),
                }],
                also_drives: Vec::new(),
                turbo_hz: None,
                turbo_effective_hz: None,
                toggle: false,
                reloaded: false,
            }
        } else {
            BindOutcome {
                ok: true,
                message: Some(format!(
                    "\"{}\": {} = {}",
                    request.preset,
                    request.function,
                    request.key.as_deref().unwrap_or("None")
                )),
                error: None,
                code: None,
                conflicts: Vec::new(),
                // A same-preset duplicate is a multi-bind, not a refusal: the
                // write succeeds and names the controls the key also drives.
                also_drives: match request.key.as_deref() {
                    Some("P") => vec!["A".into(), "B".into()],
                    _ => Vec::new(),
                },
                turbo_hz: None,
                turbo_effective_hz: None,
                toggle: false,
                reloaded: request.reload,
            }
        }
    }
}

/// The MACHINE provider, scripted with synthetic devices, and every write
/// RECORDED rather than performed.
///
/// Recorded rather than performed for the reason the cross-site test below
/// spells out — the assertion that matters about a refused write is not the
/// status code, it is that the writer never saw it. A fake that wrote to a real
/// config store could not tell those two apart.
///
/// The tree is a synthetic setup as `device_scan` shapes it: one I-PAC
/// wearing two devnodes with the keyboard on `MI_00`, one example gadget with
/// no keyboard interface at all, and one configured entry whose id is
/// PORT-PINNED.
struct ScriptedMachine {
    /// How many times the ROUTE layer actually asked for a device scan —
    /// the machine-cache tests count real enumerations, not requests.
    scans: AtomicUsize,
    /// The panel-capability probe is deliberately on-demand and outside the
    /// redesign poll cache. Calls and targets are recorded independently so a
    /// test can catch either accidental polling or browser-supplied authority.
    panel_status_calls: AtomicUsize,
    panel_status_devices: Mutex<Vec<Option<String>>>,
    panel_status_refuse: bool,
    panel_chart_specs: Mutex<Vec<ksx_api::PanelChartSpec>>,
    panel_chart_refusal: Option<Refusal>,
    panel_routing_specs: Mutex<Vec<ksx_api::PanelRoutingAuthoritySpec>>,
    /// 0 = ordinary/unwritable bypass; 1 = exact authority; 2 = recovery.
    panel_routing_mode: AtomicUsize,
    panel_routing_active: Arc<AtomicBool>,
    panel_routing_hold: AtomicBool,
    panel_routing_entered: AtomicBool,
    panel_backup_specs: Mutex<Vec<ksx_api::PanelBackupsSpec>>,
    panel_profile_reads: AtomicUsize,
    panel_profile_save_specs: Mutex<Vec<ksx_api::PanelHardwareProfileSaveSpec>>,
    panel_profile_delete_specs: Mutex<Vec<ksx_api::PanelHardwareProfileDeleteSpec>>,
    panel_program_plan_specs: Mutex<Vec<ksx_api::PanelProgramSpec>>,
    panel_plan_refusal: Option<Refusal>,
    panel_program_specs: Mutex<Vec<ksx_api::PanelProgramApplySpec>>,
    /// Hermetic gate for the epoch-ordering tests. When held, the provider has
    /// already been entered (so the server fence is Running) but has not yet
    /// returned its verified outcome.
    panel_program_hold: AtomicBool,
    panel_program_entered: AtomicBool,
    panel_restore_plan_specs: Mutex<Vec<ksx_api::PanelRestoreSpec>>,
    panel_restore_specs: Mutex<Vec<ksx_api::PanelRestoreApplySpec>>,
    /// Restore uses the same fence as program; keep an independent hermetic
    /// hold so that parity is proven rather than inferred from duplicated
    /// handler structure.
    panel_restore_hold: AtomicBool,
    panel_restore_entered: AtomicBool,
    picked: Mutex<Vec<(String, Option<String>)>>,
    removed: Mutex<Vec<(String, bool)>>,
    /// Raw daemon learner identities presented for safe inventory resolution.
    /// They never cross the HTTP response; this proves the route did not ask
    /// the machine provider to open a competing observer.
    identified_from: Mutex<Vec<String>>,
    /// Hold exact-device resolution after the learner hit, so cancellation at
    /// the hit-wins boundary can be asserted deterministically.
    identify_hold: AtomicBool,
    identify_entered: AtomicBool,
    /// Refuse the read — the "this surface cannot enumerate devices" path.
    refuse: bool,
    /// The scan ANSWERS but the USB enumeration inside it failed: empty lists
    /// that are not a reading of the machine. A third state, distinct from
    /// `refuse` and from an actually-empty cabinet, and the one the page
    /// shipped without a single test reaching it.
    blind: bool,
    /// The last `profile_new` spec this provider was asked for, so a test can
    /// prove the FORM's values reached the verb rather than a default.
    created_profile: Mutex<Option<ksx_api::NewProfile>>,
    /// The stored theme id ("" = System) the setup view reports, and every
    /// `set_theme` spec in arrival order, so a test can prove the form's
    /// value reached the verb and that a refused id never did.
    theme: Mutex<String>,
    set_theme_specs: Mutex<Vec<String>>,
    updated_profile: Mutex<Option<ksx_api::UpdateProfile>>,
    deleted_profile: Mutex<Option<ksx_api::DeleteProfile>>,
    created_preset: Mutex<Option<ksx_api::NewPreset>>,
    /// Both machine READS behind /profiles refuse — the state a machine with
    /// a syntax error in games.toml and a permission problem on the presets
    /// folder is in. Distinct from "the machine is empty", which is what the
    /// page used to render for it — and distinct from [`Self::refuse`], which
    /// is the DEVICE scan refusing.
    reads_refuse: bool,
    /// The production managed-dev fence, scripted without touching this
    /// process's environment or Windows Task Scheduler.
    autostart_dev_refuse: bool,
    /// Every Saved Games writer refuses with deliberately hostile internal
    /// vocabulary. Presentation tests prove none of it reaches a redirect.
    hostile_profile_writes: bool,
    /// Exact-device UAC mutations are fake only here. Calls and the resulting
    /// machine state are recorded so HTTP tests can distinguish "a safe flash"
    /// from "the privileged provider was never/actually called".
    prepared_with: Mutex<Vec<ksx_api::WinusbPrepareSpec>>,
    released_with: Mutex<Vec<ksx_api::WinusbReleaseSpec>>,
    winusb_claimed: AtomicBool,
    prepare_state: Mutex<Option<String>>,
    prepare_instance: Mutex<Option<String>>,
    release_state: Mutex<Option<String>>,
    release_instance: Mutex<Option<String>>,
    /// 0 = every required probe passes; 1 = each required backend is known
    /// missing; 2 = the required probes refuse. The stage still decides which
    /// rows exist, so this cannot accidentally make ViGEmBus universal again.
    output_mode: AtomicUsize,
}

impl Default for ScriptedMachine {
    fn default() -> Self {
        Self {
            scans: AtomicUsize::new(0),
            panel_status_calls: AtomicUsize::new(0),
            panel_status_devices: Mutex::new(Vec::new()),
            panel_status_refuse: false,
            panel_chart_specs: Mutex::new(Vec::new()),
            panel_chart_refusal: None,
            panel_routing_specs: Mutex::new(Vec::new()),
            panel_routing_mode: AtomicUsize::new(0),
            panel_routing_active: Arc::new(AtomicBool::new(false)),
            panel_routing_hold: AtomicBool::new(false),
            panel_routing_entered: AtomicBool::new(false),
            panel_backup_specs: Mutex::new(Vec::new()),
            panel_profile_reads: AtomicUsize::new(0),
            panel_profile_save_specs: Mutex::new(Vec::new()),
            panel_profile_delete_specs: Mutex::new(Vec::new()),
            panel_program_plan_specs: Mutex::new(Vec::new()),
            panel_plan_refusal: None,
            panel_program_specs: Mutex::new(Vec::new()),
            panel_program_hold: AtomicBool::new(false),
            panel_program_entered: AtomicBool::new(false),
            panel_restore_plan_specs: Mutex::new(Vec::new()),
            panel_restore_specs: Mutex::new(Vec::new()),
            panel_restore_hold: AtomicBool::new(false),
            panel_restore_entered: AtomicBool::new(false),
            picked: Mutex::new(Vec::new()),
            removed: Mutex::new(Vec::new()),
            identified_from: Mutex::new(Vec::new()),
            identify_hold: AtomicBool::new(false),
            identify_entered: AtomicBool::new(false),
            refuse: false,
            blind: false,
            created_profile: Mutex::new(None),
            theme: Mutex::new(String::new()),
            set_theme_specs: Mutex::new(Vec::new()),
            updated_profile: Mutex::new(None),
            deleted_profile: Mutex::new(None),
            created_preset: Mutex::new(None),
            reads_refuse: false,
            autostart_dev_refuse: false,
            hostile_profile_writes: false,
            prepared_with: Mutex::new(Vec::new()),
            released_with: Mutex::new(Vec::new()),
            // The long-standing fixture starts with the I-PAC already held by
            // WinUSB. New clean-machine tests explicitly release this flag.
            winusb_claimed: AtomicBool::new(true),
            prepare_state: Mutex::new(None),
            prepare_instance: Mutex::new(None),
            release_state: Mutex::new(None),
            release_instance: Mutex::new(None),
            output_mode: AtomicUsize::new(0),
        }
    }
}

const IPAC_KB: &str = r"USB\VID_D209&PID_0430&MI_00\7&1A2B3C4D&0&0000";
const IPAC_AUX: &str = r"USB\VID_D209&PID_0430&MI_01\7&1A2B3C4D&0&0001";
/// What Raw Input reports for the same I-PAC MI_00 collection. The real
/// backend resolves this HID child through its USB parent before returning a
/// canonical selector to Studio's learner endpoint.
const IPAC_RAW_HID: &str = r"HID\VID_D209&PID_0430&MI_00\8&2F8AC447&0&0000";
const EXAMPLE_AUX_HID: &str = r"USB\VID_F00D&PID_CAFE&MI_01\7&5A6B7C8&0&0001";
/// A paired Bluetooth keyboard with a shape-preserving synthetic identity.
const BT_KEYBOARD: &str = r"BTHENUM\{00001124-0000-1000-8000-00805F9B34FB}_VID&0002045E_PID&0800\7&B1C2D3E4&0&02A1B2C3D4E5_C00000000";

struct ScriptedPanelRoutingGuard(Arc<AtomicBool>);

impl ksx_api::PanelRoutingGuard for ScriptedPanelRoutingGuard {}

impl Drop for ScriptedPanelRoutingGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl ScriptedMachine {
    fn refusing() -> Self {
        Self {
            refuse: true,
            ..Self::default()
        }
    }

    /// The scan answers, and answers "I could not read the USB bus".
    fn blind() -> Self {
        Self {
            blind: true,
            ..Self::default()
        }
    }

    fn panel_backup() -> ksx_api::PanelBackupRow {
        ksx_api::PanelBackupRow {
            backup_id: "20260823-120000-A1B2C3D4E5F6".to_owned(),
            label: "Original chart · Aug 23, 2026".to_owned(),
            created_at: "2026-08-23 12:00:00 UTC".to_owned(),
            board_fingerprint: "ultimarc-ipac:D209:0430:board-4".to_owned(),
            image_sha256: "A".repeat(64),
            image_bytes: 256,
            reason: "chart-read".to_owned(),
        }
    }

    fn panel_chart_view() -> ksx_api::PanelChartView {
        let current_terminal = ksx_api::PanelTerminalRow {
            terminal_id: "1sw4".to_owned(),
            terminal_label: "Player 1 · Button 4".to_owned(),
            player: 1,
            kind: "button".to_owned(),
            normal: ksx_api::PanelKeyValue {
                code: 13,
                key: Some("J".to_owned()),
                label: "J".to_owned(),
                supported: true,
            },
            shifted: ksx_api::PanelKeyValue {
                code: 0,
                key: None,
                label: "Unassigned".to_owned(),
                supported: true,
            },
            shift_state: ksx_api::PanelShiftState::Disabled,
            is_shift: false,
            press_resolves: false,
        };
        let recommended_terminal = ksx_api::PanelTerminalRow {
            normal: ksx_api::PanelKeyValue {
                code: 4,
                key: Some("A".to_owned()),
                label: "A".to_owned(),
                supported: true,
            },
            ..current_terminal.clone()
        };
        ksx_api::PanelChartView {
            generated_at: "2026-08-23 12:00:00 UTC".to_owned(),
            shift: ksx_api::PanelShiftSummary::default(),
            summary: "Complete 256-byte I-PAC chart read and backed up.".to_owned(),
            board_id: r"USB\VID_D209&PID_0430\4".to_owned(),
            board_name: "Ultimarc I-PAC 4X".to_owned(),
            board_fingerprint: "ultimarc-ipac:D209:0430:board-4".to_owned(),
            driver: "ultimarc-ipac4".to_owned(),
            protocol_profile: "ipac4-pac256-v1".to_owned(),
            image_sha256: "A".repeat(64),
            image_bytes: 256,
            programming_state: "supervised".to_owned(),
            programming_detail:
                "Lossless backup, exact write, full readback, verification, and restore are available."
                    .to_owned(),
            qualification_state: "qualified".to_owned(),
            qualification_detail: "Writer qualification passed.".to_owned(),
            qualification_restore_backup_id: None,
            terminals: vec![current_terminal],
            recommended_terminals: vec![recommended_terminal],
            key_options: vec![ksx_api::PanelKeyOption {
                key: "J".to_owned(),
                label: "J".to_owned(),
                code: 13,
                safe_for_qualification: true,
            }],
            backup: Some(Self::panel_backup()),
            notes: Vec::new(),
        }
    }

    fn panel_plan_view() -> ksx_api::PanelProgramPlanView {
        ksx_api::PanelProgramPlanView {
            summary: "1 terminal assignment changes 1 byte; 255 bytes are preserved.".to_owned(),
            board_id: r"USB\VID_D209&PID_0430\4".to_owned(),
            board_name: "Ultimarc I-PAC 4X".to_owned(),
            board_fingerprint: "ultimarc-ipac:D209:0430:board-4".to_owned(),
            protocol_profile: "ipac4-pac256-v1".to_owned(),
            base_sha256: "A".repeat(64),
            desired_sha256: "B".repeat(64),
            image_bytes: 256,
            terminal_diff: vec![ksx_api::PanelTerminalDiffRow {
                terminal_id: "1sw4".to_owned(),
                terminal_label: "Player 1 · Button 4".to_owned(),
                layer: "normal".to_owned(),
                before: "J".to_owned(),
                after: "K".to_owned(),
            }],
            byte_diff: vec![ksx_api::PanelByteDiffRow {
                offset: 33,
                before: 13,
                after: 14,
                meaning: "1sw4 normal".to_owned(),
            }],
            preserved_byte_count: 255,
            confirmation: "Program Ultimarc I-PAC 4X".to_owned(),
            blockers: Vec::new(),
        }
    }

    fn panel_hardware_profile() -> ksx_api::PanelHardwareProfile {
        ksx_api::PanelHardwareProfile {
            schema: "ksx-panel-profile-v1".to_owned(),
            profile_id: "four-player-cabinet".to_owned(),
            name: "Four player cabinet".to_owned(),
            description: "The portable terminal chart, not a raw recovery image.".to_owned(),
            driver: "ultimarc-ipac4".to_owned(),
            protocol_profile: "ipac4-pac256-v1".to_owned(),
            terminal_signature: "terminal-signature-56".to_owned(),
            revision: "revision-A".to_owned(),
            created_at: "2026-08-23 12:00:00 UTC".to_owned(),
            updated_at: "2026-08-23 12:00:00 UTC".to_owned(),
            terminals: vec![ksx_api::PanelHardwareTerminal {
                terminal_id: "1sw4".to_owned(),
                normal_key: Some("J".to_owned()),
                shifted_key: None,
                is_shift: false,
                allow_shared_key: false,
            }],
        }
    }

    fn panel_program_outcome() -> ksx_api::PanelProgramOutcome {
        ksx_api::PanelProgramOutcome {
            state: "verified".to_owned(),
            summary: "The I-PAC chart was programmed and every byte verified.".to_owned(),
            board_fingerprint: "ultimarc-ipac:D209:0430:board-4".to_owned(),
            expected_sha256: "B".repeat(64),
            observed_sha256: Some("B".repeat(64)),
            backup: Self::panel_backup(),
            verified_at: "2026-08-23 12:00:02 UTC".to_owned(),
            next_step: "Teach each physical control to verify its Windows signal.".to_owned(),
        }
    }

    fn iface(id: &str, state: &str, boot: bool) -> ksx_api::UsbRow {
        ksx_api::UsbRow {
            instance_id: id.to_owned(),
            description: "USB Input Device".to_owned(),
            state: state.to_owned(),
            verdict: if state == "claimed" {
                "bound to winusb.sys — ksx can capture this"
            } else {
                "on the Windows keyboard stack — ksx can capture this"
            }
            .to_owned(),
            alias: None,
            selected: false,
            ready: false,
            vendor: Some("Ultimarc I-PAC 4X".to_owned()),
            board: Some(r"USB\VID_D209&PID_0430\4".to_owned()),
            boot_keyboard: boot,
            // The selector `scan` would write. A constant, not derived from `id`:
            // UsbRow::selector exists so no surface re-derives what the writer
            // decided (docs/SURFACES.md section 1), and a fixture that computed it
            // would be re-deriving it in a third place to test the other two.
            selector: Some("usb:d209:0430:00".to_owned()),
            // Backend eligibility from `ksx_core::Reach`, never spelled by
            // hand — a fixture that wrote its own answer could not disagree
            // with the page even when the page was wrong.
            ..Self::reach(
                ksx_api::Transport::Usb,
                boot || state == "claimed",
                state == "claimed",
            )
        }
    }

    fn example_aux_iface() -> ksx_api::UsbRow {
        ksx_api::UsbRow {
            instance_id: EXAMPLE_AUX_HID.to_owned(),
            description: "Example auxiliary HID interface".to_owned(),
            vendor: Some("Example Devices".to_owned()),
            board: Some(r"USB\VID_F00D&PID_CAFE\1".to_owned()),
            selector: Some("usb:f00d:cafe:01".to_owned()),
            ..Self::iface(EXAMPLE_AUX_HID, "not-a-keyboard", false)
        }
    }

    /// A paired Bluetooth keyboard: Interception-eligible, never claimable.
    fn bt_keyboard() -> ksx_api::UsbRow {
        ksx_api::UsbRow {
            instance_id: BT_KEYBOARD.to_owned(),
            description: "Bluetooth Keyboard".to_owned(),
            state: "interception-only".to_owned(),
            verdict: "a Bluetooth keyboard on the Windows input stack — ksx can capture it \
                      through Interception and split it into virtual pads"
                .to_owned(),
            board: Some(r"BTHENUM\02A1B2C3D4E5".to_owned()),
            boot_keyboard: true,
            selector: Some(BT_KEYBOARD.to_owned()),
            ..Self::reach(ksx_api::Transport::Bluetooth, true, false)
        }
    }

    fn reach(transport: ksx_api::Transport, keyboard: bool, claimed: bool) -> ksx_api::UsbRow {
        let reach = ksx_core::Reach {
            transport,
            keyboard,
            claimed,
            can_type: !claimed,
        };
        let eligibility = reach.eligibility();
        ksx_api::UsbRow {
            transport: transport.code().to_owned(),
            interception_eligible: eligibility.interception,
            winusb_eligible: eligibility.winusb,
            backends: eligibility.line,
            can_type: !claimed,
            ..ksx_api::UsbRow::default()
        }
    }
}

impl ksx_api::MachineSource for ScriptedMachine {
    fn controller_outputs(
        &self,
        staged: &ksx_api::StagedSetupView,
    ) -> Result<ksx_api::ControllerOutputsView, Refusal> {
        let mode = self.output_mode.load(Ordering::SeqCst);
        let rows = ksx_api::ControllerOutputsView::requirements(staged)
            .into_iter()
            .map(|requirement| {
                if mode == 2 {
                    return ksx_api::ControllerOutputView::unreadable(
                        requirement,
                        "the scripted machine refused the output read",
                    );
                }
                let backend = requirement.backend.clone();
                match backend.as_str() {
                    "vigem" => ksx_api::ControllerOutputView::vigem(
                        requirement,
                        if mode == 1 {
                            ksx_api::vigem_output_codes::MISSING
                        } else {
                            ksx_api::vigem_output_codes::HEALTHY
                        },
                        (mode == 0).then(|| "1.22.0.0".to_owned()),
                    ),
                    "hidmaestro" => ksx_api::ControllerOutputView::hidmaestro(
                        requirement,
                        mode == 0,
                        false,
                        (mode == 0).then(|| "1.6.1".to_owned()),
                    ),
                    other => ksx_api::ControllerOutputView::unreadable(
                        requirement,
                        format!("no scripted probe for {other}"),
                    ),
                }
            })
            .collect();
        Ok(ksx_api::ControllerOutputsView::from_required(rows))
    }

    fn device_scan(&self) -> Result<ksx_api::DeviceScanView, Refusal> {
        self.scans.fetch_add(1, Ordering::SeqCst);
        if self.refuse {
            return Err(Refusal::not_here("listing devices", "run `ksx devices`"));
        }
        if self.blind {
            // Empty lists with `usb_available: false` — nothing could be read.
            // Built through `read` like every other path, so the summary lines
            // and the `no_*` flags are the ones the real backend would send.
            return Ok(ksx_api::DeviceScanView::read(
                "test".to_owned(),
                true,
                false,
                false,
                Vec::new(),
                Vec::new(),
                vec!["the USB enumeration returned no interfaces".to_owned()],
            ));
        }
        // Through `DeviceScanView::read`, never a struct literal. A fixture
        // that wrote the summary lines, the counts and the health verdict as
        // literals would already contain the answers these tests ask about,
        // and could not disagree with the page even when the page was wrong.
        let winusb_claimed = self.winusb_claimed.load(Ordering::SeqCst);
        let winusb_state = if winusb_claimed {
            "claimed"
        } else {
            "claimable"
        };
        Ok(ksx_api::DeviceScanView::read(
            "test".to_owned(),
            true,
            true,
            true,
            vec![
                // A Bluetooth keyboard FIRST, so nothing downstream can be
                // right by accident about which row it looked at.
                ksx_api::BoardRow {
                    name: "Bluetooth Keyboard".to_owned(),
                    interfaces: vec![Self::bt_keyboard()],
                    keyboard: Some(BT_KEYBOARD.to_owned()),
                    keyboard_verdict: "a Bluetooth keyboard on the Windows input stack — ksx \
                                       can capture it through Interception and split it into \
                                       virtual pads"
                        .to_owned(),
                    looks_like_a_keyboard: true,
                    claimed: false,
                    alias: None,
                    // Never a claim command: on this transport a claim refuses
                    // every time it is run.
                    claim_command: None,
                    release_command: None,
                    ..ksx_api::BoardRow::default()
                },
                ksx_api::BoardRow {
                    name: "Ultimarc I-PAC 4X".to_owned(),
                    interfaces: vec![
                        Self::iface(IPAC_KB, winusb_state, true),
                        Self::iface(IPAC_AUX, "not-a-keyboard", false),
                    ],
                    keyboard: Some(IPAC_KB.to_owned()),
                    keyboard_verdict: if winusb_claimed {
                        "bound to winusb.sys — ksx can capture this"
                    } else {
                        "on the Windows keyboard stack — ksx can capture this"
                    }
                    .to_owned(),
                    looks_like_a_keyboard: true,
                    claimed: winusb_claimed,
                    alias: Some("panel".to_owned()),
                    claim_command: (!winusb_claimed).then(|| format!("ksx winusb claim {IPAC_KB}")),
                    release_command: winusb_claimed
                        .then(|| format!("ksx winusb release {IPAC_KB} --yes")),
                    ..ksx_api::BoardRow::default()
                },
                ksx_api::BoardRow {
                    name: "Example auxiliary controller".to_owned(),
                    interfaces: vec![Self::example_aux_iface()],
                    keyboard: None,
                    keyboard_verdict: "no keyboard interface — ksx cannot capture this board"
                        .to_owned(),
                    looks_like_a_keyboard: false,
                    claimed: false,
                    alias: None,
                    claim_command: None,
                    release_command: None,
                    ..ksx_api::BoardRow::default()
                },
            ],
            vec![ksx_api::ConfiguredDevice {
                alias: "panel".to_owned(),
                id: "port=7&1A2B3C4D&0&0000".to_owned(),
                backend: "winusb".to_owned(),
                rung: "port".to_owned(),
                survives_replug: false,
                means: "this exact USB socket".to_owned(),
                port_pinned_warning: Some(
                    "PORT-PINNED — nothing weaker than the Windows instance path separates this \
                     board from its twin, so this entry matches only while Windows keeps \
                     reporting that exact path. Moving the board to another USB socket is the \
                     usual way that changes, and the entry then stops matching. It is also \
                     specific to THIS machine, so do not copy this config to another cabinet — \
                     run `ksx device pick` there instead."
                        .to_owned(),
                ),
                present: true,
                board: Some("Ultimarc I-PAC 4X".to_owned()),
                instance_id: Some(IPAC_KB.to_owned()),
                claimed: winusb_claimed,
                claim_command: (!winusb_claimed).then(|| format!("ksx winusb claim {IPAC_KB}")),
                release_command: winusb_claimed
                    .then(|| format!("ksx winusb release {IPAC_KB} --yes")),
                used_by: vec!["slot 1 (keyboard)".to_owned()],
                ..ksx_api::ConfiguredDevice::default()
            }],
            Vec::new(),
        ))
    }

    fn panel_status(
        &self,
        spec: &ksx_api::PanelStatusSpec,
    ) -> Result<ksx_api::PanelStatusView, Refusal> {
        self.panel_status_calls.fetch_add(1, Ordering::SeqCst);
        self.panel_status_devices
            .lock()
            .unwrap()
            .push(spec.device.clone());
        if self.panel_status_refuse {
            return Err(Refusal::new(
                ksx_api::codes::REFUSED,
                "the scripted HID inventory could not be read",
            ));
        }
        Ok(ksx_api::PanelStatusView {
            generated_at: "test".to_owned(),
            summary: "One selected panel encoder was inspected.".to_owned(),
            inspection_note:
                "Inspection only. KSX did not program or change this encoder.".to_owned(),
            access_detail: "USB descriptors and passive HID collection metadata were readable."
                .to_owned(),
            usb_available: true,
            hid_available: true,
            panels: vec![ksx_api::PanelStatusRow {
                board_id: r"USB\VID_D209&PID_0430\4".to_owned(),
                name: "Ultimarc I-PAC 4X".to_owned(),
                identity: "USB D209:0430 · bcdDevice 0x0056".to_owned(),
                vendor_id: 0xd209,
                product_id: 0x0430,
                family_id: Some("ultimarc-ipac4".to_owned()),
                family_label: Some("Ultimarc I-PAC 4X".to_owned()),
                bcd_device: 0x0056,
                firmware_label: Some("1.56".to_owned()),
                firmware_detail: "Measured KSX I-PAC 4 release-0056 profile matched USB bcdDevice 0x0056; firmware was not queried from the board.".to_owned(),
                profile_terminal_count: Some(56),
                serial: None,
                driver: "ultimarc-ipac".to_owned(),
                driver_supported: true,
                driver_label: "Ultimarc I-PAC family".to_owned(),
                observed_mode: "keyboard-compatible".to_owned(),
                mode_detail: "Keyboard-compatible HID input was observed; exact vendor mode was not queried."
                    .to_owned(),
                observed_mode_label: "Keyboard-compatible input observed".to_owned(),
                mode_read_supported: false,
                capabilities: ksx_api::PanelDriverCapabilities {
                    can_identify: true,
                    can_report_mode: false,
                    can_read_chart: true,
                    can_write_chart: true,
                    write_is_persistent: true,
                },
                chart_state: "protocol-unverified".to_owned(),
                chart_attempted: false,
                chart_detail:
                    "Chart read-back protocol is unverified, so no report was sent.".to_owned(),
                chart_label: "Protocol unverified · Not attempted".to_owned(),
                configuration_collection_state: "candidate-unverified".to_owned(),
                configuration_collection: Some(
                    r"HID\VID_D209&PID_0430&MI_02&COL01\TEST".to_owned(),
                ),
                configuration_collection_detail:
                    "One passive 5-byte input/output candidate was observed; its protocol is unverified."
                        .to_owned(),
                recommendation:
                    "Keep this encoder in keyboard mode so Teach and Route retain KSX's dynamic transforms."
                        .to_owned(),
                programming_recovery_required: false,
                programming_recovery_detail: String::new(),
                interfaces: vec![ksx_api::PanelInterfaceRow {
                    instance_id: IPAC_KB.to_owned(),
                    interface_number: 0,
                    interface_class: 3,
                    interface_subclass: 1,
                    interface_protocol: 1,
                    binding: "hidusb.sys (keyboard stack)".to_owned(),
                    boot_keyboard: true,
                    description: "USB Input Device".to_owned(),
                }],
                hid_collections: vec![ksx_api::PanelHidCollectionRow {
                    instance_id: r"HID\VID_D209&PID_0430&MI_02&COL01\TEST".to_owned(),
                    state: "available".to_owned(),
                    vendor_id: Some(0xd209),
                    product_id: Some(0x0430),
                    version_number: Some(0x0056),
                    usage_page: Some(0xff00),
                    usage: Some(1),
                    input_report_bytes: Some(5),
                    output_report_bytes: Some(5),
                    feature_report_bytes: Some(0),
                    errors: Vec::new(),
                }],
            }],
            notes: Vec::new(),
        })
    }

    fn panel_chart(
        &self,
        spec: &ksx_api::PanelChartSpec,
    ) -> Result<ksx_api::PanelChartView, Refusal> {
        self.panel_chart_specs.lock().unwrap().push(spec.clone());
        if let Some(refusal) = &self.panel_chart_refusal {
            return Err(refusal.clone());
        }
        Ok(Self::panel_chart_view())
    }

    fn panel_routing_guard(
        &self,
        spec: &ksx_api::PanelRoutingAuthoritySpec,
    ) -> Result<Option<Box<dyn ksx_api::PanelRoutingGuard>>, Refusal> {
        self.panel_routing_specs.lock().unwrap().push(spec.clone());
        match self.panel_routing_mode.load(Ordering::SeqCst) {
            0 => Ok(None),
            2 => Err(Refusal::with_remedy(
                ksx_api::codes::RECOVERY_REQUIRED,
                "the scripted encoder has an unresolved hardware transaction",
                "read and recover its complete chart",
            )),
            _ => {
                let exact = spec.device.eq_ignore_ascii_case("usb:d209:0430:00")
                    && spec
                        .expected_selector
                        .as_deref()
                        .is_some_and(|value| value.eq_ignore_ascii_case("usb:d209:0430:00"))
                    && spec
                        .expected_instance
                        .as_deref()
                        .is_some_and(|value| value.eq_ignore_ascii_case(IPAC_KB))
                    && spec.expected_board_fingerprint.as_deref()
                        == Some("ultimarc-ipac:D209:0430:board-4")
                    && spec
                        .expected_chart_sha256
                        .as_deref()
                        .is_some_and(|value| value == "A".repeat(64));
                if !exact {
                    return Err(Refusal::with_remedy(
                        ksx_api::codes::BAD_REQUEST,
                        "the scripted encoder authority is missing or stale; nothing was mapped",
                        "read its complete chart and try again",
                    ));
                }
                if self
                    .panel_routing_active
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_err()
                {
                    return Err(Refusal::new(
                        ksx_api::codes::REFUSED,
                        "another scripted route owns the encoder",
                    ));
                }
                self.panel_routing_entered.store(true, Ordering::SeqCst);
                while self.panel_routing_hold.load(Ordering::SeqCst) {
                    std::thread::yield_now();
                }
                Ok(Some(Box::new(ScriptedPanelRoutingGuard(Arc::clone(
                    &self.panel_routing_active,
                )))))
            }
        }
    }

    fn panel_backups(
        &self,
        spec: &ksx_api::PanelBackupsSpec,
    ) -> Result<ksx_api::PanelBackupsView, Refusal> {
        self.panel_backup_specs.lock().unwrap().push(spec.clone());
        Ok(ksx_api::PanelBackupsView {
            summary: "1 lossless restore point.".to_owned(),
            board_fingerprint: "ultimarc-ipac:D209:0430:board-4".to_owned(),
            backups: vec![Self::panel_backup()],
        })
    }

    fn panel_hardware_profiles(&self) -> Result<ksx_api::PanelHardwareProfilesView, Refusal> {
        self.panel_profile_reads.fetch_add(1, Ordering::SeqCst);
        Ok(ksx_api::PanelHardwareProfilesView {
            summary: "1 saved encoder layout.".to_owned(),
            config_root: r"C:\cfg".to_owned(),
            terminal_signature: "terminal-signature-56".to_owned(),
            profiles: vec![Self::panel_hardware_profile()],
        })
    }

    fn panel_hardware_profile_save(
        &self,
        spec: &ksx_api::PanelHardwareProfileSaveSpec,
    ) -> Result<ksx_api::PanelHardwareProfileMutationView, Refusal> {
        self.panel_profile_save_specs
            .lock()
            .unwrap()
            .push(spec.clone());
        let mut profile = Self::panel_hardware_profile();
        profile.name.clone_from(&spec.name);
        profile.description.clone_from(&spec.description);
        profile.terminals.clone_from(&spec.terminals);
        let state = if let Some(profile_id) = &spec.profile_id {
            profile.profile_id.clone_from(profile_id);
            profile.revision = "revision-B".to_owned();
            "updated"
        } else {
            "created"
        };
        Ok(ksx_api::PanelHardwareProfileMutationView {
            state: state.to_owned(),
            summary: format!("{} saved encoder layout.", state),
            profile_id: profile.profile_id.clone(),
            profile: Some(profile),
        })
    }

    fn panel_hardware_profile_delete(
        &self,
        spec: &ksx_api::PanelHardwareProfileDeleteSpec,
    ) -> Result<ksx_api::PanelHardwareProfileMutationView, Refusal> {
        self.panel_profile_delete_specs
            .lock()
            .unwrap()
            .push(spec.clone());
        Ok(ksx_api::PanelHardwareProfileMutationView {
            state: "deleted".to_owned(),
            summary: "Deleted saved encoder layout; hardware was not changed.".to_owned(),
            profile_id: spec.profile_id.clone(),
            profile: None,
        })
    }

    fn panel_program_plan(
        &self,
        spec: &ksx_api::PanelProgramSpec,
    ) -> Result<ksx_api::PanelProgramPlanView, Refusal> {
        self.panel_program_plan_specs
            .lock()
            .unwrap()
            .push(spec.clone());
        if let Some(refusal) = &self.panel_plan_refusal {
            return Err(refusal.clone());
        }
        Ok(Self::panel_plan_view())
    }

    fn panel_program(
        &self,
        spec: &ksx_api::PanelProgramApplySpec,
    ) -> Result<ksx_api::PanelProgramOutcome, Refusal> {
        self.panel_program_entered.store(true, Ordering::SeqCst);
        while self.panel_program_hold.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(2));
        }
        self.panel_program_specs.lock().unwrap().push(spec.clone());
        Ok(Self::panel_program_outcome())
    }

    fn panel_restore_plan(
        &self,
        spec: &ksx_api::PanelRestoreSpec,
    ) -> Result<ksx_api::PanelProgramPlanView, Refusal> {
        self.panel_restore_plan_specs
            .lock()
            .unwrap()
            .push(spec.clone());
        if let Some(refusal) = &self.panel_plan_refusal {
            return Err(refusal.clone());
        }
        let mut plan = Self::panel_plan_view();
        plan.summary = "Restore 1 terminal assignment from the selected backup.".to_owned();
        Ok(plan)
    }

    fn panel_restore(
        &self,
        spec: &ksx_api::PanelRestoreApplySpec,
    ) -> Result<ksx_api::PanelProgramOutcome, Refusal> {
        self.panel_restore_entered.store(true, Ordering::SeqCst);
        while self.panel_restore_hold.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(2));
        }
        self.panel_restore_specs.lock().unwrap().push(spec.clone());
        let mut outcome = Self::panel_program_outcome();
        outcome.summary = "The backup was restored and every byte verified.".to_owned();
        Ok(outcome)
    }

    fn device_identify(
        &self,
        observed_instance: &str,
    ) -> Result<ksx_api::DeviceIdentifyView, Refusal> {
        self.identify_entered.store(true, Ordering::SeqCst);
        while self.identify_hold.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(2));
        }
        self.identified_from
            .lock()
            .unwrap()
            .push(observed_instance.to_owned());
        if !observed_instance.eq_ignore_ascii_case(IPAC_KB)
            && !observed_instance.eq_ignore_ascii_case(IPAC_RAW_HID)
        {
            return Err(Refusal::new(
                ksx_api::codes::IDENTIFY_UNMATCHED,
                "the observed interface did not match the scripted board",
            ));
        }
        Ok(ksx_api::DeviceIdentifyView {
            selector: "usb:d209:0430:00".to_owned(),
            alias: "panel".to_owned(),
            label: "Ultimarc I-PAC 4X".to_owned(),
        })
    }

    fn device_pick(
        &self,
        spec: &ksx_api::DevicePickSpec,
    ) -> Result<ksx_api::DevicePickView, Refusal> {
        self.picked
            .lock()
            .unwrap()
            .push((spec.query.clone(), spec.alias.clone()));
        let alias = spec
            .alias
            .clone()
            .unwrap_or_else(|| "Ultimarc I-PAC 4X".to_owned());
        Ok(ksx_api::DevicePickView {
            alias: alias.clone(),
            id: "model=d209:0430".to_owned(),
            backend: "winusb".to_owned(),
            board: "Ultimarc I-PAC 4X".to_owned(),
            instance_id: IPAC_KB.to_owned(),
            replaced: None,
            claimed: true,
            port_pinned: false,
            next_step: None,
            backup: None,
            summary: format!("wrote [[device]] \"{alias}\" — nothing was claimed"),
        })
    }

    fn device_remove(
        &self,
        spec: &ksx_api::DeviceRemoveSpec,
    ) -> Result<ksx_api::DeviceRemoveView, Refusal> {
        self.removed
            .lock()
            .unwrap()
            .push((spec.alias.clone(), spec.force));
        Ok(ksx_api::DeviceRemoveView {
            alias: spec.alias.clone(),
            id: "port=7&1A2B3C4D&0&0000".to_owned(),
            still_claimed: Some(IPAC_KB.to_owned()),
            release_command: Some(format!("ksx winusb release {IPAC_KB} --yes")),
            breaks: Vec::new(),
            backup: None,
            summary: format!(
                "removed [[device]] \"{}\" — the board is STILL CLAIMED; releasing it is a \
                 separate step",
                spec.alias
            ),
        })
    }

    fn winusb_prepare(
        &self,
        spec: &ksx_api::WinusbPrepareSpec,
    ) -> Result<ksx_api::WinusbMutationView, Refusal> {
        self.prepared_with.lock().unwrap().push(spec.clone());
        if spec.expected_selector != "usb:d209:0430:00"
            || !spec.instance_id.eq_ignore_ascii_case(IPAC_KB)
            || !spec.confirm_spare_keyboard
            || !spec.confirm_rebind
            || !spec.confirm_machine_certificate
        {
            return Err(Refusal::new(
                ksx_api::codes::REFUSED,
                r#"refused helper invocation at C:\secret\generated.inf -- unsafe consent"#,
            ));
        }
        let state = self
            .prepare_state
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| "prepared".to_owned());
        let instance_id = self
            .prepare_instance
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| spec.instance_id.clone());
        if state == "prepared" && instance_id.eq_ignore_ascii_case(&spec.instance_id) {
            self.winusb_claimed.store(true, Ordering::SeqCst);
        }
        Ok(ksx_api::WinusbMutationView {
            instance_id,
            hardware_id: r"HID\VID_D209&PID_0430&MI_00".to_owned(),
            state,
            message: r#"helper wrote C:\secret\generated.inf"#.to_owned(),
            warning: Some("private provider warning --repair".to_owned()),
        })
    }

    fn winusb_release(
        &self,
        spec: &ksx_api::WinusbReleaseSpec,
    ) -> Result<ksx_api::WinusbMutationView, Refusal> {
        self.released_with.lock().unwrap().push(spec.clone());
        if spec.expected_selector != "usb:d209:0430:00"
            || !spec.instance_id.eq_ignore_ascii_case(IPAC_KB)
            || !spec.confirm_release
        {
            return Err(Refusal::new(
                ksx_api::codes::REFUSED,
                r#"refused helper invocation at C:\secret\generated.inf -- unsafe release"#,
            ));
        }
        let state = self
            .release_state
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| "released".to_owned());
        let instance_id = self
            .release_instance
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| spec.instance_id.clone());
        if state == "released" && instance_id.eq_ignore_ascii_case(&spec.instance_id) {
            self.winusb_claimed.store(false, Ordering::SeqCst);
        }
        Ok(ksx_api::WinusbMutationView {
            instance_id,
            hardware_id: r"HID\VID_D209&PID_0430&MI_00".to_owned(),
            state,
            message: r#"helper restored C:\secret\generated.inf"#.to_owned(),
            warning: Some("private provider warning --release".to_owned()),
        })
    }

    /// Synthetic profiles covering a healthy program and a missing one. The
    /// provider — not the page — is what decides
    /// that, which is why the fixture states it as `state: "broken"` with the
    /// path, exactly as `LocalMachine::profiles` composes it from
    /// `ksx_games::preflight`.
    fn profiles(&self) -> Result<ksx_api::ProfilesView, Refusal> {
        if self.reads_refuse {
            return Err(Refusal::with_remedy(
                ksx_api::codes::REFUSED,
                "games.toml could not be read: expected `=` at line 4",
                "run `ksx config export --what games`",
            ));
        }
        Ok(ksx_api::ProfilesView {
            generated_at: "test".into(),
            config_root: "C:\\cfg".into(),
            games_path: "C:\\cfg\\games.toml".into(),
            profiles: vec![
                ksx_api::ProfileDetail {
                    revision: "g1-example".into(),
                    title: "Example Game".into(),
                    path: "C:\\Examples\\example-game.exe".into(),
                    arguments: String::new(),
                    slots: 2,
                    presets: vec!["Arcade".into()],
                    state: "ok".into(),
                    verdict: "the program is there".into(),
                    broken_path: None,
                },
                ksx_api::ProfileDetail {
                    revision: "g1-missing".into(),
                    title: "Missing Example Game".into(),
                    path: "X:\\Examples\\missing-game.exe".into(),
                    arguments: String::new(),
                    slots: 4,
                    presets: vec!["Arcade".into()],
                    state: "broken".into(),
                    verdict: "game profile 'Missing Example Game' points at 'X:\\Examples\\missing-game.exe', \
                              which does not exist"
                        .into(),
                    broken_path: Some("X:\\Examples\\missing-game.exe".into()),
                },
            ],
            notes: Vec::new(),
        })
    }

    fn autostart(&self) -> Result<ksx_api::AutostartView, Refusal> {
        if self.reads_refuse {
            return Err(Refusal::with_remedy(
                ksx_api::codes::REFUSED,
                "the scheduler could not be asked",
                "run `ksx doctor`",
            ));
        }
        if self.autostart_dev_refuse {
            return Ok(ksx_api::AutostartView {
                registered: true,
                line: "registered — installed ksx daemon".into(),
                mode: Some("daemon".into()),
                read_only: true,
                read_only_detail: Some(
                    "This managed development build shows the installed sign-in task read-only. \
                     Install a complete candidate to test startup."
                        .into(),
                ),
                ..ksx_api::AutostartView::default()
            });
        }
        Ok(ksx_api::AutostartView {
            registered: false,
            line: "not registered".into(),
            ..ksx_api::AutostartView::default()
        })
    }

    /// The re-read discipline: the answer is the state AFTER the write.
    fn set_autostart(
        &self,
        spec: &ksx_api::AutostartSpec,
    ) -> Result<ksx_api::AutostartView, Refusal> {
        if self.autostart_dev_refuse {
            return Err(Refusal::with_remedy(
                ksx_api::codes::MANAGED_DEV_RUNTIME,
                "this is a managed development runtime",
                "install the complete candidate",
            ));
        }
        Ok(ksx_api::AutostartView {
            registered: spec.enable,
            line: if spec.enable {
                "registered".into()
            } else {
                "not registered".into()
            },
            ..ksx_api::AutostartView::default()
        })
    }

    fn presets(&self) -> Result<ksx_api::PresetsView, Refusal> {
        if self.reads_refuse {
            return Err(Refusal::with_remedy(
                ksx_api::codes::REFUSED,
                "the presets folder could not be read: access is denied",
                "run `ksx doctor`",
            ));
        }
        Ok(ksx_api::PresetsView {
            config_root: "C:\\cfg\\presets".into(),
            presets: vec![ksx_api::PresetRow {
                name: "Arcade".into(),
                bound: 25,
                macros: 0,
                used_by: 1,
                protected: false,
                usable: true,
                problem: None,
                source: "C:\\cfg\\presets\\Arcade.toml".into(),
            }],
            templates: vec![ksx_api::TemplateRow {
                id: "keyboard-2p".into(),
                label: "Two players sharing ONE keyboard: WASD vs the arrows".into(),
                detail: "Two people on one ordinary keyboard, no encoder.".into(),
                players: vec![1, 2],
                blank: false,
            }],
        })
    }

    fn profile_new(&self, spec: &ksx_api::NewProfile) -> Result<String, Refusal> {
        *self.created_profile.lock().unwrap() = Some(spec.clone());
        if self.hostile_profile_writes {
            return Err(Refusal::with_remedy(
                ksx_api::codes::REFUSED,
                r#"profile slot preset failed at C:\secret\games.toml through daemon"#,
                "run `ksx profile --preset Hidden` in the CLI",
            ));
        }
        if spec.title.trim().is_empty() {
            return Err(Refusal::new(
                ksx_api::codes::REFUSED,
                "a saved game needs a game name",
            ));
        }
        Ok(format!(
            "created saved game \"{}\" — {} player(s) using controller layout \"{}\"",
            spec.title, spec.slots, spec.preset
        ))
    }

    fn profile_update(&self, spec: &ksx_api::UpdateProfile) -> Result<String, Refusal> {
        *self.updated_profile.lock().unwrap() = Some(spec.clone());
        if self.hostile_profile_writes {
            return Err(Refusal::with_remedy(
                ksx_api::codes::REFUSED,
                r#"profile slot preset failed at C:\secret\games.toml through daemon"#,
                "run `ksx profile --preset Hidden` in the CLI",
            ));
        }
        if spec.original_title.trim().is_empty() {
            return Err(Refusal::new(
                ksx_api::codes::REFUSED,
                "choose the saved game to change",
            ));
        }
        if spec.original_title == "Example Game" && spec.revision != "g1-example" {
            return Err(Refusal::with_remedy(
                ksx_api::codes::REFUSED,
                "that saved game changed while this form was open; nothing was written",
                "refresh Saved Games and try again",
            ));
        }
        Ok(format!("updated saved game \"{}\"", spec.title))
    }

    fn profile_delete(&self, spec: &ksx_api::DeleteProfile) -> Result<String, Refusal> {
        *self.deleted_profile.lock().unwrap() = Some(spec.clone());
        if self.hostile_profile_writes {
            return Err(Refusal::with_remedy(
                ksx_api::codes::REFUSED,
                r#"profile slot preset failed at C:\secret\games.toml through daemon"#,
                "run `ksx profile --preset Hidden` in the CLI",
            ));
        }
        if spec.title.trim().is_empty() {
            return Err(Refusal::new(
                ksx_api::codes::REFUSED,
                "choose the saved game to delete",
            ));
        }
        if spec.title == "Missing Example Game" && spec.revision != "g1-missing" {
            return Err(Refusal::with_remedy(
                ksx_api::codes::REFUSED,
                "that saved game changed while this form was open; nothing was written",
                "refresh Saved Games and try again",
            ));
        }
        Ok(format!("deleted saved game \"{}\"", spec.title))
    }

    fn preset_new(&self, spec: &ksx_api::NewPreset) -> Result<String, Refusal> {
        *self.created_preset.lock().unwrap() = Some(spec.clone());
        if self.hostile_profile_writes {
            return Err(Refusal::with_remedy(
                ksx_api::codes::REFUSED,
                r#"profile slot preset failed at C:\secret\games.toml through daemon"#,
                "run `ksx profile --preset Hidden` in the CLI",
            ));
        }
        // The refusal `LocalMachine` composes from
        // `preset_edit::PresetError::Exists` + its `advice()`, verbatim in
        // shape: a message that names the file it protected, and a remedy that
        // is the ONLY way forward. "Arcade" is the preset `presets()` lists.
        if spec.name == "Arcade" && !spec.force {
            return Err(Refusal::with_remedy(
                ksx_api::codes::REFUSED,
                "a controller layout called \"Arcade\" already exists",
                "choose a different name; Saved Games never overwrites a controller layout",
            ));
        }
        Ok(format!("created controller layout \"{}\"", spec.name))
    }

    // ── The M10 verbs behind /setup: the config in and out, and the first-run
    //    state. Synthetic, and deliberately just enough to prove the ROUTES —
    //    what the real provider does to a config root is `ksx-backend`'s to test
    //    (`onboard.rs` + `config_io.rs`), and testing it twice would only pin
    //    the fake.

    fn setup_state(&self) -> Result<ksx_api::SetupView, Refusal> {
        Ok(ksx_api::SetupView {
            generated_at: "test".into(),
            config_root: "C:\\cfg".into(),
            config_exists: true,
            devices: vec![ksx_api::SetupDeviceRow {
                alias: "P1 board".into(),
                id: "usb:d209:0430:00".into(),
                backend: "interception".into(),
            }],
            slots: vec![ksx_api::SetupSlotRow {
                number: 1,
                device: "P1 board".into(),
                preset: "Panel P1".into(),
                persona: "Xbox 360 pad".into(),
                socd: String::new(),
                source: "config.toml".into(),
            }],
            presets: vec!["Panel P1".into()],
            profiles: vec!["Example Game".into()],
            steps: vec![
                ksx_api::SetupStep {
                    id: ksx_api::setup_steps::BOARD.into(),
                    title: "Find your board and name it".into(),
                    detail: "One board is named.".into(),
                    state: ksx_api::setup_states::DONE.into(),
                },
                ksx_api::SetupStep {
                    id: ksx_api::setup_steps::SLOT.into(),
                    title: "Wire a slot".into(),
                    detail: "One slot is wired.".into(),
                    state: ksx_api::setup_states::DONE.into(),
                },
                ksx_api::SetupStep {
                    id: ksx_api::setup_steps::PROVE.into(),
                    title: "Press a button and watch it land".into(),
                    detail: "Start the listener and press a button.".into(),
                    state: ksx_api::setup_states::NOW.into(),
                },
            ],
            notes: Vec::new(),
            theme: self.theme.lock().unwrap().clone(),
            // The ceiling comes from the BACKEND (`ksx_core::MAX_SLOTS`); the
            // default carries it, which is the behaviour a real provider has.
            ..ksx_api::SetupView::default()
        })
    }

    fn set_theme(&self, spec: &ksx_api::ThemeSpec) -> Result<ksx_api::ThemeView, Refusal> {
        self.set_theme_specs
            .lock()
            .unwrap()
            .push(spec.theme.clone());
        *self.theme.lock().unwrap() = spec.theme.clone();
        Ok(ksx_api::ThemeView {
            theme: spec.theme.clone(),
            backup: None,
        })
    }

    fn config_export(
        &self,
        _request: &ksx_api::ExportRequest,
    ) -> Result<ksx_api::ConfigExport, Refusal> {
        let document = "{\n  \"ksx_interop\": 1,\n  \"schema_version\": 1\n}\n".to_owned();
        Ok(ksx_api::ConfigExport {
            filename: "ksx-config-20260807-120000.json".into(),
            bytes: document.len(),
            parts: vec!["config".into(), "games".into(), "presets".into()],
            presets: 1,
            warnings: Vec::new(),
            document,
        })
    }

    /// The consent shape, faithfully: no `apply`, no write.
    ///
    /// The summaries mirror `ksx-backend::onboard`'s after the review: the backend
    /// states the FACT and names no control, because the same sentence is read
    /// by the cabinet egui, which has no checkbox called "write it". Naming
    /// this page's box is `server.rs::import_flash`'s job and is asserted as
    /// such below.
    fn config_import(
        &self,
        request: &ksx_api::ImportRequest,
    ) -> Result<ksx_api::ImportReport, Refusal> {
        // A bare document with `what` supplied is the assistant-written case
        // the import card invites: the form's `what` select is how a person
        // says what it is when the document does not say for itself.
        if !request.document.contains("ksx_interop") && request.what.is_empty() {
            return Err(Refusal::new(
                ksx_api::codes::BAD_REQUEST,
                "the pasted document does not say what it is",
            ));
        }
        // A document that would not validate: the faults are STRUCTURED, and
        // the page is holding them.
        if request.document.contains("\"faulty\"") {
            return Ok(ksx_api::ImportReport {
                ok: false,
                applied: false,
                summary: "refused: importing this would leave 3 validation fault(s) in your \
                          configuration — nothing was written."
                    .to_owned(),
                faults: vec![
                    "slot 2 points at preset \"Nope\", which is not in this document".to_owned(),
                    "device \"P2 board\" has no id".to_owned(),
                    "game \"Example Launcher\" names slot 9".to_owned(),
                ],
                ..ksx_api::ImportReport::default()
            });
        }
        Ok(ksx_api::ImportReport {
            ok: true,
            applied: request.apply,
            summary: if request.apply {
                "imported config, games — 2 file(s) written, 2 backed up first".to_owned()
            } else {
                "nothing written yet — this would replace your settings. Nothing was written."
                    .to_owned()
            },
            ..ksx_api::ImportReport::default()
        })
    }

    // ── The /pads verbs, delegated to `FixedMachine` below ─────────────────
    //
    // The /pads tests run through the default `start_server`, which serves
    // THIS machine; the pad answers are the fixed fixture's, so every pads
    // assertion reads one fixture regardless of which harness built the
    // server.
    fn pads_view(&self, session_running: bool) -> Result<ksx_api::PadsView, Refusal> {
        FixedMachine.pads_view(session_running)
    }

    fn pads(&self, spec: &ksx_api::PadsSpawnSpec) -> Result<String, Refusal> {
        FixedMachine.pads(spec)
    }

    fn pads_prune(&self, confirm: bool) -> Result<String, Refusal> {
        FixedMachine.pads_prune(confirm)
    }
}

/// The machine, scripted: a restartable bus carrying two pads, and two verbs
/// that ECHO what they were asked for.
///
/// Echoing rather than recording is deliberate. Every /pads assertion below
/// reads the 303's `?flash=`, so a passing test proves the form values reached
/// the verb — `confirm=yes` in particular — with no shared mutable state
/// between a test and the server thread it started.
struct FixedMachine;

/// The setup store refuses with deliberately private diagnostic detail. The
/// health boundary must reduce that to its stable operational sentence.
struct RefusingHealthSetup;

impl ksx_api::MachineSource for RefusingHealthSetup {
    fn setup_state(&self) -> Result<ksx_api::SetupView, Refusal> {
        Err(Refusal::new(
            "health-setup-refused",
            r"could not open C:\secret\config.toml with token DEADBEEF",
        ))
    }
}

/// One count option over the ceiling, so the page's warning has something real
/// to render. The label is the PROVIDER's — the whole point of task #16's
/// warning is that the backend writes that sentence, not the page — and it
/// NAMES the persona it applies to, because the same click costs nothing on a
/// HID pad.
const OVER_CEILING_LABEL: &str = "8 pads — only 3 readable as xbox360, all 8 as playstation";

/// A machine whose read FAILS. Not an empty bus — a bus ksx never managed to
/// look at, which is a different page and a different sentence.
struct UnreadableMachine;

impl ksx_api::MachineSource for UnreadableMachine {}

impl ksx_api::MachineSource for FixedMachine {
    fn pads_view(&self, session_running: bool) -> Result<ksx_api::PadsView, Refusal> {
        Ok(ksx_api::PadsView {
            generated_at: "test".into(),
            summary: "2 virtual pads on the ViGEm bus:".into(),
            bus_instance_id: Some("ROOT\\SYSTEM\\0002".into()),
            pads: vec![
                ksx_api::VirtualPadRow {
                    instance_id: "USB\\TEST\\PAD1".into(),
                    hardware_id: "USB\\TEST".into(),
                    persona: "Xbox 360 pad".into(),
                    xinput: true,
                },
                ksx_api::VirtualPadRow {
                    instance_id: "USB\\TEST\\PAD2".into(),
                    hardware_id: "USB\\TEST".into(),
                    persona: "PlayStation (DS4) pad".into(),
                    xinput: false,
                },
            ],
            bus_line: "ROOT\\SYSTEM\\0002".into(),
            owners: vec!["ksx.exe (pid 1)".into()],
            owners_line: "ksx.exe (pid 1)".into(),
            // Echoed, so a test can prove ONE session read fed both the header
            // pill and the spawn panel rather than two round-trips that can
            // disagree inside a single render.
            session_running,
            xinput_ceiling: 4,
            xinput_in_use: Some(1),
            xinput_line: "Windows exposes exactly 4 XInput slots and no virtual bus can create \
                          a fifth."
                .into(),
            elevated: Some(false),
            elevation_line: "ksx is NOT running elevated, and ksx never self-elevates — this \
                             prune will be refused."
                .into(),
            confirm_line: "This removes 2 pad(s) by restarting the ViGEmBus devnode. Every pad \
                           listed here goes, at once:"
                .into(),
            // Empty: this fixture ANSWERS. Only `PadsView::unreadable` fills
            // the banner heading.
            unreadable_heading: String::new(),
            prune: ksx_api::PrunePlanView {
                kind: "restart".into(),
                count: 2,
                command: Some("pnputil /restart-device \"ROOT\\SYSTEM\\0002\"".into()),
                detail: "DRY RUN — would clear 2 virtual pad(s)".into(),
            },
            spawn: ksx_api::SpawnOffer {
                counts: vec![
                    ksx_api::SpawnOption {
                        value: "1".into(),
                        label: "1 pad".into(),
                    },
                    ksx_api::SpawnOption {
                        value: "8".into(),
                        label: OVER_CEILING_LABEL.into(),
                    },
                ],
                personas: vec![ksx_api::SpawnOption {
                    value: "xbox360".into(),
                    label: "xbox360 — takes one of the 4 XInput slots".into(),
                }],
                holds: vec![ksx_api::SpawnOption {
                    value: "10".into(),
                    label: "10 seconds".into(),
                }],
                note: "A spawn is a TEST".into(),
                refused: session_running.then(|| "a session is running".to_owned()),
            },
        })
    }

    fn pads(&self, spec: &ksx_api::PadsSpawnSpec) -> Result<String, Refusal> {
        if spec.count == 0 {
            return Err(Refusal::new(
                ksx_api::codes::REFUSED,
                "pad count must be 1..=16, got 0",
            ));
        }
        Ok(format!(
            "spawned {} {} pad(s) for {}s",
            spec.count, spec.persona, spec.hold_secs
        ))
    }

    fn pads_prune(&self, confirm: bool) -> Result<String, Refusal> {
        if confirm {
            Ok("cleared 2 virtual pad(s) — the bus was restarted.".to_owned())
        } else {
            Ok("dry run — 2 virtual pad(s) would be cleared. Nothing was changed.".to_owned())
        }
    }
}

/// A certificate-only machine for the `/devices` trust-store action. It can
/// model success, a hostile provider refusal, an incomplete cleanup and an
/// unattributable installed signer without touching the real certificate
/// stores on the test host.
struct CertificateMachine {
    leftovers: AtomicUsize,
    in_use: usize,
    blocked: bool,
    refuse: bool,
    keep_leftovers: bool,
    sweep_calls: AtomicUsize,
    residue_reads: AtomicUsize,
}

impl CertificateMachine {
    fn ready(leftovers: usize, in_use: usize) -> Self {
        Self {
            leftovers: AtomicUsize::new(leftovers),
            in_use,
            blocked: false,
            refuse: false,
            keep_leftovers: false,
            sweep_calls: AtomicUsize::new(0),
            residue_reads: AtomicUsize::new(0),
        }
    }

    fn view(&self) -> ksx_api::WinusbResidueView {
        let leftovers = self.leftovers.load(Ordering::SeqCst);
        let unknown = self.blocked.then(|| {
            "An installed KSX package has no attributable signer, so no certificate can be judged safe to remove."
                .to_owned()
        });
        let certificates_line = match (&unknown, leftovers) {
            (Some(message), _) => message.clone(),
            (None, 0) => String::new(),
            (None, 1) => format!(
                "1 signing certificate is left over. {} still sign an installed driver and are left alone.",
                self.in_use
            ),
            (None, count) => format!(
                "{count} signing certificates are left over. {} still sign an installed driver and are left alone.",
                self.in_use
            ),
        };
        ksx_api::WinusbResidueView {
            readable: true,
            receipts: 0,
            drifted: 0,
            bookkeeping_only: true,
            line: "Everything KSX prepared is accounted for.".to_owned(),
            detail: "Certificate residue is reported separately.".to_owned(),
            leftover_certificates: leftovers,
            certificates_in_use: self.in_use,
            certificates_unknown: unknown.unwrap_or_default(),
            certificates_line,
            ..ksx_api::WinusbResidueView::default()
        }
    }
}

impl ksx_api::MachineSource for CertificateMachine {
    fn device_scan(&self) -> Result<ksx_api::DeviceScanView, Refusal> {
        Ok(ksx_api::DeviceScanView::read(
            "test".to_owned(),
            true,
            true,
            true,
            Vec::new(),
            Vec::new(),
            Vec::new(),
        ))
    }

    fn winusb_residue(&self) -> Result<ksx_api::WinusbResidueView, Refusal> {
        self.residue_reads.fetch_add(1, Ordering::SeqCst);
        Ok(self.view())
    }

    fn winusb_sweep_certificates(
        &self,
        spec: &ksx_api::WinusbCertificateSweepSpec,
    ) -> Result<ksx_api::WinusbResidueView, Refusal> {
        if !spec.confirm {
            return Err(Refusal::new(
                ksx_api::codes::BAD_REQUEST,
                "certificate cleanup was not confirmed",
            ));
        }
        if self.blocked || self.leftovers.load(Ordering::SeqCst) == 0 {
            return Err(Refusal::new(
                ksx_api::codes::REFUSED,
                "certificate cleanup is not currently safe or necessary",
            ));
        }
        self.sweep_calls.fetch_add(1, Ordering::SeqCst);
        if self.refuse {
            return Err(Refusal::new(
                ksx_api::codes::REFUSED,
                r#"private helper failed at C:\secret\generated.inf --repair thumbprint DEADBEEF"#,
            ));
        }
        if !self.keep_leftovers {
            self.leftovers.store(0, Ordering::SeqCst);
        }
        // The typed action returns post-operation state, but the HTTP handler
        // must still call the independent read method above before it says
        // success. `residue_reads` is how the test proves that happened.
        Ok(self.view())
    }
}

/// Bind port 0 to learn a free port, release it, and serve there. Because the
/// production server owns its bind internally, startup is not considered
/// complete until the exact fixture provider answers a unique handshake.
fn start_server(control: Arc<ScriptedControl>) -> SocketAddr {
    start_server_with_machine(control, Arc::new(ScriptedMachine::default()))
}

fn start_server_with_status(
    control: Arc<ScriptedControl>,
    status: Box<dyn StatusSource>,
) -> SocketAddr {
    start_server_with_sources(control, status, Arc::new(ScriptedMachine::default()))
}

/// The same server with a chosen machine provider, boxed — the only axis any
/// /pads test needs to vary. Sugar over [`start_server_with_machine`], kept
/// because the pads fixtures are stateless and a `Box::new(UnreadableMachine)`
/// at the call site reads better than an `Arc` it will never share.
fn start_server_with(
    control: Arc<ScriptedControl>,
    machine: Box<dyn ksx_api::MachineSource>,
) -> SocketAddr {
    start_server_with_machine(control, Arc::from(machine))
}

/// …with a MACHINE provider of the caller's choosing — the seam a refused
/// read (a device scan, a profiles read, or the first-run state) arrives
/// through.
fn start_server_with_machine(
    control: Arc<ScriptedControl>,
    machine: Arc<dyn ksx_api::MachineSource>,
) -> SocketAddr {
    start_server_with_sources(control, Box::new(FixedStatus), machine)
}

fn start_server_with_sources(
    control: Arc<ScriptedControl>,
    status: Box<dyn StatusSource>,
    machine: Arc<dyn ksx_api::MachineSource>,
) -> SocketAddr {
    let mut addresses = SERVER_ADDRS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let addr = loop {
        let probe = TcpListener::bind("127.0.0.1:0").unwrap();
        let candidate = probe.local_addr().unwrap();
        if addresses.contains(&candidate) {
            continue;
        }
        addresses.push(candidate);
        break candidate;
    };
    drop(addresses);
    let marker = format!(
        "ksx-http-fixture-{}-{}-{}",
        std::process::id(),
        SERVER_NONCE.fetch_add(1, Ordering::Relaxed),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let status: Box<dyn StatusSource> = Box::new(FixtureStatus {
        inner: status,
        marker: marker.clone(),
    });
    struct SharedControl(Arc<ScriptedControl>);
    impl ControlSource for SharedControl {
        fn session(&self) -> SessionView {
            self.0.session()
        }
        fn start(&self, profile: Option<&str>) -> Result<String, Refusal> {
            self.0.start(profile)
        }
        fn stop(&self) -> Result<String, Refusal> {
            self.0.stop()
        }
        fn resume(&self) -> Result<String, Refusal> {
            self.0.resume()
        }
        fn reload(&self) -> Result<String, Refusal> {
            self.0.reload()
        }
        fn learn_start(&self) -> LearnView {
            self.0.learn_start()
        }
        fn learn_poll(&self) -> LearnView {
            self.0.learn_poll()
        }
        fn learn_cancel(&self) -> LearnView {
            self.0.learn_cancel()
        }
        fn learn_cancel_generation(&self, generation: Option<u64>) -> LearnView {
            self.0.learn_cancel_generation(generation)
        }
        fn input_test_start(&self, spec: &ksx_api::InputTestSpec) -> ksx_api::InputTestView {
            self.0.input_test_start(spec)
        }
        fn input_test_poll(&self) -> ksx_api::InputTestView {
            self.0.input_test_poll()
        }
        fn input_test_cancel_generation(&self, generation: Option<u64>) -> ksx_api::InputTestView {
            self.0.input_test_cancel_generation(generation)
        }
        fn input_test_release_fence(&self) -> Result<(), Refusal> {
            self.0.input_test_release_fence()
        }
        fn bind(&self, request: &BindRequest) -> BindOutcome {
            self.0.bind(request)
        }
        fn restore(&self, preset: &str, mode: RestoreMode) -> Result<String, Refusal> {
            self.0.restore(preset, mode)
        }
        fn clear_all(&self, preset: &str) -> Result<String, Refusal> {
            self.0.clear_all(preset)
        }
        fn save_macro(&self, request: &MacroWrite) -> MacroOutcome {
            self.0.save_macro(request)
        }
        fn assign_slot(&self, request: &ksx_api::SlotAssignRequest) -> ksx_api::SlotOutcome {
            self.0.assign_slot(request)
        }
        fn staged(&self) -> ksx_api::StagedSetupView {
            self.0.staged()
        }
        fn stage_edit(&self, edit: &ksx_api::StageEdit) -> ksx_api::StageOutcome {
            self.0.stage_edit(edit)
        }
        fn stage_bind(&self, request: &ksx_api::StagedBindRequest) -> BindOutcome {
            self.0.stage_bind(request)
        }
        fn stage_commit(&self) -> ksx_api::StageOutcome {
            self.0.stage_commit()
        }
        fn stage_play(&self) -> ksx_api::StageOutcome {
            self.0.stage_play()
        }
        fn stage_adopt(&self, profile: Option<&str>) -> ksx_api::StageOutcome {
            self.0.stage_adopt(profile)
        }
        fn stage_apply(&self) -> ksx_api::StageOutcome {
            self.0.stage_apply()
        }
    }
    struct SharedMachine(Arc<dyn ksx_api::MachineSource>);
    impl ksx_api::MachineSource for SharedMachine {
        fn controller_outputs(
            &self,
            staged: &ksx_api::StagedSetupView,
        ) -> Result<ksx_api::ControllerOutputsView, Refusal> {
            self.0.controller_outputs(staged)
        }
        fn device_scan(&self) -> Result<ksx_api::DeviceScanView, Refusal> {
            self.0.device_scan()
        }
        fn panel_status(
            &self,
            spec: &ksx_api::PanelStatusSpec,
        ) -> Result<ksx_api::PanelStatusView, Refusal> {
            self.0.panel_status(spec)
        }
        fn panel_chart(
            &self,
            spec: &ksx_api::PanelChartSpec,
        ) -> Result<ksx_api::PanelChartView, Refusal> {
            self.0.panel_chart(spec)
        }
        fn panel_routing_guard(
            &self,
            spec: &ksx_api::PanelRoutingAuthoritySpec,
        ) -> Result<Option<Box<dyn ksx_api::PanelRoutingGuard>>, Refusal> {
            self.0.panel_routing_guard(spec)
        }
        fn panel_backups(
            &self,
            spec: &ksx_api::PanelBackupsSpec,
        ) -> Result<ksx_api::PanelBackupsView, Refusal> {
            self.0.panel_backups(spec)
        }
        fn panel_hardware_profiles(&self) -> Result<ksx_api::PanelHardwareProfilesView, Refusal> {
            self.0.panel_hardware_profiles()
        }
        fn panel_hardware_profile_save(
            &self,
            spec: &ksx_api::PanelHardwareProfileSaveSpec,
        ) -> Result<ksx_api::PanelHardwareProfileMutationView, Refusal> {
            self.0.panel_hardware_profile_save(spec)
        }
        fn panel_hardware_profile_delete(
            &self,
            spec: &ksx_api::PanelHardwareProfileDeleteSpec,
        ) -> Result<ksx_api::PanelHardwareProfileMutationView, Refusal> {
            self.0.panel_hardware_profile_delete(spec)
        }
        fn panel_program_plan(
            &self,
            spec: &ksx_api::PanelProgramSpec,
        ) -> Result<ksx_api::PanelProgramPlanView, Refusal> {
            self.0.panel_program_plan(spec)
        }
        fn panel_program(
            &self,
            spec: &ksx_api::PanelProgramApplySpec,
        ) -> Result<ksx_api::PanelProgramOutcome, Refusal> {
            self.0.panel_program(spec)
        }
        fn panel_restore_plan(
            &self,
            spec: &ksx_api::PanelRestoreSpec,
        ) -> Result<ksx_api::PanelProgramPlanView, Refusal> {
            self.0.panel_restore_plan(spec)
        }
        fn panel_restore(
            &self,
            spec: &ksx_api::PanelRestoreApplySpec,
        ) -> Result<ksx_api::PanelProgramOutcome, Refusal> {
            self.0.panel_restore(spec)
        }
        fn device_identify(
            &self,
            observed_instance: &str,
        ) -> Result<ksx_api::DeviceIdentifyView, Refusal> {
            self.0.device_identify(observed_instance)
        }
        fn device_pick(
            &self,
            spec: &ksx_api::DevicePickSpec,
        ) -> Result<ksx_api::DevicePickView, Refusal> {
            self.0.device_pick(spec)
        }
        fn device_remove(
            &self,
            spec: &ksx_api::DeviceRemoveSpec,
        ) -> Result<ksx_api::DeviceRemoveView, Refusal> {
            self.0.device_remove(spec)
        }
        fn winusb_prepare(
            &self,
            spec: &ksx_api::WinusbPrepareSpec,
        ) -> Result<ksx_api::WinusbMutationView, Refusal> {
            self.0.winusb_prepare(spec)
        }
        fn winusb_release(
            &self,
            spec: &ksx_api::WinusbReleaseSpec,
        ) -> Result<ksx_api::WinusbMutationView, Refusal> {
            self.0.winusb_release(spec)
        }
        fn winusb_residue(&self) -> Result<ksx_api::WinusbResidueView, Refusal> {
            self.0.winusb_residue()
        }
        fn winusb_sweep_certificates(
            &self,
            spec: &ksx_api::WinusbCertificateSweepSpec,
        ) -> Result<ksx_api::WinusbResidueView, Refusal> {
            self.0.winusb_sweep_certificates(spec)
        }
        fn profiles(&self) -> Result<ksx_api::ProfilesView, Refusal> {
            self.0.profiles()
        }
        fn presets(&self) -> Result<ksx_api::PresetsView, Refusal> {
            self.0.presets()
        }
        fn profile_new(&self, spec: &ksx_api::NewProfile) -> Result<String, Refusal> {
            self.0.profile_new(spec)
        }
        fn profile_update(&self, spec: &ksx_api::UpdateProfile) -> Result<String, Refusal> {
            self.0.profile_update(spec)
        }
        fn profile_delete(&self, spec: &ksx_api::DeleteProfile) -> Result<String, Refusal> {
            self.0.profile_delete(spec)
        }
        fn preset_new(&self, spec: &ksx_api::NewPreset) -> Result<String, Refusal> {
            self.0.preset_new(spec)
        }
        fn setup_state(&self) -> Result<ksx_api::SetupView, Refusal> {
            self.0.setup_state()
        }
        fn set_theme(&self, spec: &ksx_api::ThemeSpec) -> Result<ksx_api::ThemeView, Refusal> {
            self.0.set_theme(spec)
        }
        fn autostart(&self) -> Result<ksx_api::AutostartView, Refusal> {
            self.0.autostart()
        }
        fn set_autostart(
            &self,
            spec: &ksx_api::AutostartSpec,
        ) -> Result<ksx_api::AutostartView, Refusal> {
            self.0.set_autostart(spec)
        }
        fn config_export(
            &self,
            request: &ksx_api::ExportRequest,
        ) -> Result<ksx_api::ConfigExport, Refusal> {
            self.0.config_export(request)
        }
        fn config_import(
            &self,
            request: &ksx_api::ImportRequest,
        ) -> Result<ksx_api::ImportReport, Refusal> {
            self.0.config_import(request)
        }
        // The /pads verbs. A wrapper that forgot these would hand every pads
        // test the trait's default refusals — the page would render its
        // banner and every assertion about the bus would fail against a
        // fixture that answered perfectly well.
        fn pads_view(&self, session_running: bool) -> Result<ksx_api::PadsView, Refusal> {
            self.0.pads_view(session_running)
        }
        fn pads(&self, spec: &ksx_api::PadsSpawnSpec) -> Result<String, Refusal> {
            self.0.pads(spec)
        }
        fn pads_prune(&self, confirm: bool) -> Result<String, Refusal> {
            self.0.pads_prune(confirm)
        }
    }
    let (startup_tx, startup_rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let result = ksx_studio::serve(
            addr,
            status,
            Box::new(SharedControl(control)),
            Box::new(SharedMachine(machine)),
            // These tests never open the feed; a source that refuses in words
            // is the honest stand-in, and `/api/live` under it is a real state
            // of the endpoint (no daemon) worth being able to assert against.
            std::sync::Arc::new(
                ksx_api::NoLiveSource::new("no live feed in this test")
                    .with_remedy("start the daemon"),
            ),
        );
        let _ = startup_tx.send(result);
    });
    // A TCP connect alone is not proof of ownership: another process can win
    // the bind between the port-0 probe and `serve`. Wait for this fixture's
    // nonce through the real router, while also surfacing `serve`'s bind error
    // instead of discarding it on the spawned thread.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match startup_rx.try_recv() {
            Ok(Ok(())) => panic!("test server exited before startup on {addr}"),
            Ok(Err(error)) => panic!("test server could not start on {addr}: {error}"),
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                panic!("test server thread ended before startup on {addr}")
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => {}
        }
        if fixture_owns_endpoint(addr, &marker) {
            return addr;
        }
        assert!(
            Instant::now() < deadline,
            "server never proved fixture ownership on {addr} (wanted {marker})"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn fixture_owns_endpoint(addr: SocketAddr, marker: &str) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(250)) else {
        return false;
    };
    let timeout = Some(Duration::from_millis(250));
    if stream.set_read_timeout(timeout).is_err() || stream.set_write_timeout(timeout).is_err() {
        return false;
    }
    if stream
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() || !response.starts_with("HTTP/1.1 200") {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(body_of(&response))
        .ok()
        .and_then(|payload| {
            payload["environment"]["generation"]
                .as_str()
                .map(str::to_owned)
        })
        .is_some_and(|observed| observed == marker)
}

/// Regression for the old readiness probe, which accepted any TCP listener
/// on the released port and could send a later test request to another fixture
/// (or an unrelated local process). HTTP 200 is still not ownership without
/// the nonce supplied by this invocation of `start_server_with_sources`.
#[test]
fn fixture_startup_handshake_rejects_a_foreign_listener() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let foreign = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0_u8; 256];
        let _ = stream.read(&mut request).unwrap();
        let body = r#"{"snapshot":{"generated_at":"some-other-fixture"}}"#;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
    });

    assert!(!fixture_owns_endpoint(addr, "the-fixture-we-started"));
    foreign.join().unwrap();
}

#[test]
fn the_health_endpoint_is_minimal_guarded_and_never_cached() {
    let addr = start_server_with_sources(
        Arc::new(ScriptedControl::new(false)),
        Box::new(DeclaredFixtureStatus),
        Arc::new(ScriptedMachine::default()),
    );

    let response = get(addr, "/api/health");
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(response.contains("cache-control: no-store"), "{response}");

    let payload: serde_json::Value = serde_json::from_str(body_of(&response)).unwrap();
    let mut top_level = payload.as_object().unwrap().keys().collect::<Vec<_>>();
    top_level.sort();
    assert_eq!(
        top_level,
        vec!["environment", "setup", "setup_error", "staged"]
    );

    let mut staged = payload["staged"]
        .as_object()
        .unwrap()
        .keys()
        .collect::<Vec<_>>();
    staged.sort();
    assert_eq!(staged, vec!["error", "reachable"]);

    let mut setup = payload["setup"]
        .as_object()
        .unwrap()
        .keys()
        .collect::<Vec<_>>();
    setup.sort();
    assert_eq!(setup, vec!["config_root"]);

    assert_eq!(payload["environment"]["id"], "fixture-health-contract");
    assert_eq!(payload["environment"]["fixture"], true);
    assert!(payload["environment"]["generation"]
        .as_str()
        .is_some_and(|generation| generation.starts_with("ksx-http-fixture-")));
    assert_eq!(payload["staged"]["reachable"], true);
    assert!(payload["staged"]["error"].is_null());
    assert_eq!(payload["setup"]["config_root"], r"C:\cfg");
    assert_eq!(payload["setup_error"], "");

    let rejected = http(
        addr,
        "GET /api/health HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n",
    );
    assert!(rejected.starts_with("HTTP/1.1 421"), "{rejected}");
}

#[test]
fn health_distinguishes_refusals_without_leaking_private_setup_diagnostics() {
    let addr = start_server_with_sources(
        Arc::new(ScriptedControl::dead()),
        Box::new(DeclaredFixtureStatus),
        Arc::new(RefusingHealthSetup),
    );

    let response = get(addr, "/api/health");
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(response.contains("cache-control: no-store"), "{response}");

    let payload: serde_json::Value = serde_json::from_str(body_of(&response)).unwrap();
    assert_eq!(payload["staged"]["reachable"], false);
    assert_eq!(payload["staged"]["error"], NO_CHANNEL);
    assert!(payload["setup"].is_null());
    assert_eq!(
        payload["setup_error"],
        "Configuration could not be read. Reopen ksx and try again."
    );
    assert!(!body_of(&response).contains(r"C:\secret"), "{response}");
    assert!(!body_of(&response).contains("DEADBEEF"), "{response}");
    assert!(
        !body_of(&response).contains("health-setup-refused"),
        "{response}"
    );
}

fn http(addr: SocketAddr, request: &str) -> String {
    let mut stream = TcpStream::connect(addr).unwrap();
    stream.write_all(request.as_bytes()).unwrap();
    let mut response = String::new();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream.read_to_string(&mut response).unwrap();
    response
}

fn get(addr: SocketAddr, path: &str) -> String {
    http(
        addr,
        &format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"),
    )
}

fn post_form(addr: SocketAddr, path: &str, body: &str) -> String {
    http(
        addr,
        &format!(
            "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\
             Content-Type: application/x-www-form-urlencoded\r\n\
             Content-Length: {}\r\n\r\n{body}",
            body.len()
        ),
    )
}

/// **Prove the path in a guard loop actually ROUTES.**
///
/// `guard::same_origin` is installed with `Router::layer`, not
/// `route_layer`, so it runs BEFORE axum matches a path. Every
/// "…_behind_the_guard" loop therefore has a silent failure mode: a path with
/// NO handler answers the hostile request 403 exactly like a real one, so the
/// 403 assertion passes while testing nothing at all.
///
/// That is not hypothetical — it has bitten this file twice. The cutover left
/// `/start/controller/persona` in `the_start_routes_are_behind_the_guard`, a
/// path with no handler anywhere, and the loop stayed green against a route
/// that did not exist. Removing the two bad entries fixed the symptom; this
/// helper is what stops the third.
///
/// The discriminator: a GET carries no `Origin`, so it passes the guard and
/// reaches the router, where a routed POST-only path answers **405** and an
/// unrouted one answers **404**. A GET also executes no verb, so this is safe
/// to call against `/redesign/play` or `/redesign/controller/remove`.
///
/// Measured 2026-08-26 on a live fixture:
/// ```text
/// GET /redesign/play              -> 405 Method Not Allowed
/// GET /redesign/controller        -> 405 Method Not Allowed
/// GET /start/controller/persona   -> 404 Not Found
/// GET /this/route/never/existed   -> 404 Not Found
/// ```
#[track_caller]
fn assert_route_is_real(addr: SocketAddr, path: &str) {
    let response = get(addr, path);
    assert!(
        !response.starts_with("HTTP/1.1 404"),
        "{path} has NO handler — the guard answers 403 before routing, so the \
         cross-origin assertion above passed against a route that does not \
         exist. Fix the path or drop the entry: {response}"
    );
}

fn post_json(addr: SocketAddr, path: &str, body: &str) -> String {
    http(
        addr,
        &format!(
            "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\
             Content-Type: application/json\r\n\
             Content-Length: {}\r\n\r\n{body}",
            body.len()
        ),
    )
}

fn staged_target_revision(control: &ScriptedControl, slot: u8) -> String {
    control
        .staged()
        .slots
        .into_iter()
        .find(|candidate| candidate.number == slot)
        .unwrap_or_else(|| panic!("no staged Player {slot}"))
        .target_revision
}

fn redesign_bind_body_with_revision(
    slot: u8,
    target_revision: &str,
    function: &str,
    key: &str,
    mode: Option<&str>,
    force: bool,
) -> String {
    serde_json::json!({
        "slot": slot,
        "expected_target_revision": target_revision,
        "function": function,
        "key": key,
        "mode": mode,
        "force": force,
    })
    .to_string()
}

fn redesign_bind_body(
    control: &ScriptedControl,
    slot: u8,
    function: &str,
    key: &str,
    mode: Option<&str>,
    force: bool,
) -> String {
    redesign_bind_body_with_revision(
        slot,
        &staged_target_revision(control, slot),
        function,
        key,
        mode,
        force,
    )
}

/// The response body (everything after the blank line).
fn body_of(response: &str) -> &str {
    response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .unwrap_or("")
}

/// Visible document markup with the hydration payload removed. Provider text
/// is allowed to remain data for support and polling; assertions about primary
/// customer copy must not pass merely because JSON contained the same words.
fn rendered_body(response: &str) -> String {
    let body = body_of(response);
    let Some(start) = body.find("<script id=\"__ksx-payload\"") else {
        return body.to_owned();
    };
    let end = body[start..]
        .find("</script>")
        .map_or(body.len(), |at| start + at + "</script>".len());
    format!("{}{}", &body[..start], &body[end..])
}

/// [`get`], for responses whose body is not UTF-8 — the brand icons.
/// Returns `(headers, body)` with the body left as bytes.
fn get_binary(addr: SocketAddr, path: &str) -> (String, Vec<u8>) {
    let mut stream = TcpStream::connect(addr).unwrap();
    stream
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).unwrap();
    let split = response
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .unwrap_or_else(|| panic!("{path}: no header/body separator in the response"));
    let headers = String::from_utf8_lossy(&response[..split]).into_owned();
    (headers, response[split + 4..].to_vec())
}

/// The brand icons are served at the ROOT paths their consumers hard-code —
/// a browser asks for `/favicon.ico` and iOS probes `/apple-touch-icon.png`
/// with no prompting from the markup — with content types that make them
/// icons rather than downloads.
///
/// Compared BYTE FOR BYTE against the embedded files. A 404 would be found by
/// anything; the failure worth a test is a 200 carrying a truncated or
/// re-encoded image, which renders as a perfectly normal page with a blank
/// tab and no error anywhere.
#[test]
fn the_brand_icons_are_served_at_their_root_paths() {
    let addr = start_server(Arc::new(ScriptedControl::new(true)));

    for (path, mime, expected) in [
        (
            "/favicon.ico",
            "image/x-icon",
            include_bytes!("../brand/favicon.ico").as_slice(),
        ),
        (
            "/favicon.svg",
            "image/svg+xml",
            include_bytes!("../brand/favicon.svg").as_slice(),
        ),
        (
            "/apple-touch-icon.png",
            "image/png",
            include_bytes!("../brand/apple-touch-icon.png").as_slice(),
        ),
    ] {
        let (headers, body) = get_binary(addr, path);
        assert!(headers.starts_with("HTTP/1.1 200"), "{path}: {headers}");
        assert!(
            headers.to_ascii_lowercase().contains(mime),
            "{path}: expected content-type {mime}\n{headers}"
        );
        assert_eq!(
            body.len(),
            expected.len(),
            "{path}: served {} bytes, embed has {}",
            body.len(),
            expected.len()
        );
        assert!(
            body == expected,
            "{path}: served bytes differ from the embed"
        );
    }

    // And the page points at all three, so the icons are not merely reachable
    // by luck of the browser's default probing.
    let page = get(addr, "/redesign");
    for link in [
        r#"href="/favicon.svg""#,
        r#"href="/favicon.ico""#,
        r#"href="/apple-touch-icon.png""#,
    ] {
        assert!(page.contains(link), "status page missing {link}");
    }
}

/// The hard cutover keeps one GET-only bookmark courtesy and no legacy
/// authority. Safe selection/search context survives; arbitrary flash text,
/// APIs, downloads and stale form posts do not.
#[test]
fn nocturne_is_only_a_sanitized_bookmark_redirect() {
    let control = Arc::new(ScriptedControl::new(true));
    let addr = start_server(control.clone());

    let bookmark = get(
        addr,
        "/nocturne?slot=1&macro=dash+loop&q=face&flash=hostile",
    );
    assert!(bookmark.starts_with("HTTP/1.1 308"), "{bookmark}");
    assert!(
        bookmark
            .to_ascii_lowercase()
            .contains("location: /redesign?slot=1&macro=dash%20loop&q=face"),
        "{bookmark}"
    );
    assert!(!bookmark.contains("hostile"), "{bookmark}");

    for path in ["/api/nocturne", "/nocturne/export.json"] {
        let response = get(addr, path);
        assert!(response.starts_with("HTTP/1.1 404"), "{path}: {response}");
    }
    for path in [
        "/nocturne/save",
        "/nocturne/import",
        "/nocturne/game",
        "/nocturne/api/bind",
    ] {
        let response = post_form(addr, path, "slot=1&function=A&key=H");
        assert!(response.starts_with("HTTP/1.1 404"), "{path}: {response}");
    }

    assert_eq!(control.stage_revision.load(Ordering::SeqCst), 0);
    assert!(control.bound_with.lock().unwrap().is_none());
    assert!(!control.committed.load(Ordering::SeqCst));
    assert!(!control.played.load(Ordering::SeqCst));
}

/// Plain HTML forms post to their verb URL, so a native browser's selected
/// controller, macro and binding filter can return only through the Referer.
/// Exercise the real middleware/guard/handler stack: exact same-origin
/// workbench context survives, transient/private fields do not, and neither a
/// foreign origin nor an encoded header payload can choose the destination.
#[test]
fn redesign_native_posts_preserve_only_validated_workbench_context() {
    let addr = start_server(Arc::new(ScriptedControl::new(true)));
    let post = |referer: &str| {
        http(
            addr,
            &format!(
                "POST /redesign/stop HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
                 Origin: http://127.0.0.1:{port}\r\nReferer: {referer}\r\n\
                 Connection: close\r\nContent-Type: application/x-www-form-urlencoded\r\n\
                 Content-Length: 0\r\n\r\n",
                port = addr.port(),
            ),
        )
    };
    let location = |response: &str| {
        response
            .lines()
            .find_map(|line| {
                line.split_once(':').and_then(|(name, value)| {
                    name.eq_ignore_ascii_case("location")
                        .then(|| value.trim().to_owned())
                })
            })
            .unwrap_or_else(|| panic!("response has no Location: {response}"))
    };

    let own = post(&format!(
        "http://127.0.0.1:{}/redesign?slot=2&macro=dash+loop&q=face%20buttons&flash=hostile&fresh=1&identified_selector=private",
        addr.port()
    ));
    assert!(own.starts_with("HTTP/1.1 303"), "{own}");
    let own_location = location(&own);
    assert!(
        own_location.starts_with("/redesign?flash="),
        "{own_location}"
    );
    assert!(
        own_location.ends_with("&slot=2&macro=dash%20loop&q=face%20buttons"),
        "{own_location}"
    );
    for private in ["hostile", "fresh=", "identified_selector"] {
        assert!(!own_location.contains(private), "{own_location}");
    }

    let foreign = post("http://evil.example/redesign?slot=3&macro=stolen&q=stolen");
    assert!(foreign.starts_with("HTTP/1.1 303"), "{foreign}");
    let foreign_location = location(&foreign);
    assert!(
        foreign_location.starts_with("/redesign?flash="),
        "{foreign_location}"
    );
    assert!(!foreign_location.contains("slot="), "{foreign_location}");
    assert!(!foreign_location.contains("stolen"), "{foreign_location}");

    let encoded = post(&format!(
        "http://127.0.0.1:{}/redesign?slot=99&macro=%0D%0ALocation%3A%20https%3A%2F%2Fevil.example&q=%20",
        addr.port()
    ));
    let encoded_location = location(&encoded);
    assert_eq!(
        encoded
            .lines()
            .filter(|line| line.to_ascii_lowercase().starts_with("location:"))
            .count(),
        1,
        "encoded data must not mint a second header: {encoded}"
    );
    assert!(
        encoded_location.starts_with("/redesign?flash="),
        "{encoded_location}"
    );
    assert!(!encoded_location.contains("slot=99"), "{encoded_location}");
    assert!(
        encoded_location.ends_with("&macro=%0D%0ALocation%3A%20https%3A%2F%2Fevil.example"),
        "{encoded_location}"
    );
}

#[test]
fn simultaneous_input_http_routes_share_one_typed_generation_stamped_contract() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control.clone());

    let idle = get(addr, "/api/input-test");
    assert!(idle.starts_with("HTTP/1.1 200"), "{idle}");
    assert!(
        idle.to_ascii_lowercase()
            .contains("cache-control: no-store"),
        "a held-key snapshot must never be cached: {idle}"
    );
    let idle: serde_json::Value = serde_json::from_str(body_of(&idle)).unwrap();
    assert_eq!(idle["state"], "idle");

    let unknown_start = post_json(
        addr,
        "/api/input-test/start",
        r#"{"selector":"usb:d209:0430:00","guess":true}"#,
    );
    assert!(
        !unknown_start.starts_with("HTTP/1.1 200"),
        "the HTTP seam accepted a field the daemon pipe refuses: {unknown_start}"
    );

    let started = post_json(
        addr,
        "/api/input-test/start",
        r#"{"selector":"usb:d209:0430:00"}"#,
    );
    assert!(started.starts_with("HTTP/1.1 200"), "{started}");
    let started: serde_json::Value = serde_json::from_str(body_of(&started)).unwrap();
    assert_eq!(started["state"], "listening");
    assert_eq!(started["selector"], "usb:d209:0430:00");
    assert_eq!(started["remaining_ms"], 30_000, "HTTP default is typed");
    assert_eq!(started["held"], serde_json::json!(["A", "S"]));
    assert_eq!(started["seen"], serde_json::json!(["A", "S", "D"]));
    assert_eq!(started["peak"], 3);
    assert_eq!(started["rollover_visibility"], "unavailable");
    assert_eq!(
        control.input_test_spec.lock().unwrap().as_ref().unwrap(),
        &ksx_api::InputTestSpec {
            selector: "usb:d209:0430:00".into(),
            duration_ms: 30_000,
        }
    );

    let generation = started["generation"].as_u64().unwrap();
    let unknown_cancel = post_json(
        addr,
        "/api/input-test/cancel",
        &format!(r#"{{"generation":{generation},"all":true}}"#),
    );
    assert!(
        !unknown_cancel.starts_with("HTTP/1.1 200"),
        "cancel accepted an unstamped authority field: {unknown_cancel}"
    );
    let stale = post_json(
        addr,
        "/api/input-test/cancel",
        &format!(r#"{{"generation":{}}}"#, generation + 1),
    );
    let stale: serde_json::Value = serde_json::from_str(body_of(&stale)).unwrap();
    assert_eq!(stale["state"], "listening", "stale cancel won: {stale}");
    assert_eq!(stale["generation"], generation);

    let cancelled = post_json(
        addr,
        "/api/input-test/cancel",
        &format!(r#"{{"generation":{generation}}}"#),
    );
    let cancelled: serde_json::Value = serde_json::from_str(body_of(&cancelled)).unwrap();
    assert_eq!(cancelled["state"], "cancelled");
    assert_eq!(cancelled["generation"], generation);

    let missing = post_json(addr, "/api/input-test/start", r#"{"duration_ms":5000}"#);
    assert!(
        !missing.starts_with("HTTP/1.1 200"),
        "a missing exact selector must fail closed: {missing}"
    );
}

/// The attack this guard exists to stop, executed over a real socket.
///
/// A page on another site cannot read ksx's responses — but it never needed to.
/// A cross-origin `<form method="post">` is a CORS *simple request*: no
/// preflight, no permission, and the side effect lands before anyone could
/// object. `/map/preset/clear-all` wipes a preset; `/map/session/stop` ends a
/// game. The port is 4460 and is not a secret.
///
/// So this posts exactly what `evil.example` would post, byte for byte, and
/// requires that the scripted control never sees it.
#[test]
fn a_cross_site_form_post_is_refused_before_it_reaches_the_control() {
    let control = Arc::new(ScriptedControl::new(true));
    let addr = start_server(control.clone());

    for path in [
        "/redesign/bind/clear-all",
        "/redesign/stop",
        "/redesign/controller/socd",
        "/redesign/bind/clear",
    ] {
        let body = "preset=Panel+P1&slot=1";
        let response = http(
            addr,
            &format!(
                "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\
                 Origin: https://evil.example\r\nConnection: close\r\n\
                 Content-Type: application/x-www-form-urlencoded\r\n\
                 Content-Length: {}\r\n\r\n{body}",
                body.len()
            ),
        );
        assert!(
            response.starts_with("HTTP/1.1 403"),
            "{path} must refuse a cross-site write, got: {response}"
        );
        assert!(
            response.contains("refused a request from another site"),
            "the refusal must say what happened: {response}"
        );
        assert_route_is_real(addr, path);
    }

    // Not "it returned 403" — that the write never happened. A refusal that
    // still performed the write would pass a status-code assertion and fail
    // the user, so assert on what the control surface actually recorded.
    assert!(
        control.cleared.lock().unwrap().is_none(),
        "clear-all must not have run"
    );
    assert!(
        control.bound_with.lock().unwrap().is_none(),
        "no cross-site request may reach the control surface"
    );
}

/// The same routes, from ksx Studio's own page, still work.
///
/// A guard that also blocks the real UI is not a fix, and this is the assertion
/// that would fail if the origin comparison were tightened past correctness.
#[test]
fn the_pages_own_origin_still_writes() {
    let control = Arc::new(ScriptedControl::new(true));
    let addr = start_server(control.clone());

    let body = "slot=1&function=A";
    let response = http(
        addr,
        &format!(
            "POST /redesign/bind/clear HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
             Origin: http://127.0.0.1:{port}\r\nConnection: close\r\n\
             Content-Type: application/x-www-form-urlencoded\r\n\
             Content-Length: {len}\r\n\r\n{body}",
            port = addr.port(),
            len = body.len(),
        ),
    );
    assert!(
        response.starts_with("HTTP/1.1 303"),
        "Studio's own form must still post: {response}"
    );
    // Reaching the HANDLER is the claim, not what the handler then decided:
    // the guard answers 403 with no `Location` (see the cross-site test
    // beside this one), so a 303 carrying this page's own flash is proof the
    // request got past it. The old assertion read a recorder belonging to
    // `/map/clear`'s preset-write verb; this route runs the staged one.
    assert!(
        response
            .to_ascii_lowercase()
            .contains("location: /redesign?flash="),
        "the post must have reached the handler, not stopped at the guard: {response}"
    );
    let _ = &control;
}

/// DNS rebinding: the packet really does arrive on 127.0.0.1, so the bind
/// cannot tell. Only the name the browser asked for can, and a rebound request
/// carries the attacker's.
#[test]
fn a_rebound_host_cannot_even_read() {
    let control = Arc::new(ScriptedControl::new(true));
    let addr = start_server(control);

    let response = http(
        addr,
        "GET /api/redesign HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n",
    );
    assert!(
        response.starts_with("HTTP/1.1 421"),
        "a rebound read must be refused, got: {response}"
    );
}

// ---------------------------------------------------------------------------
// /devices — the picker, end to end
// ---------------------------------------------------------------------------

/// The read. One PHYSICAL board per row (an I-PAC is one device to a human and
/// two devnodes here), the configured entry beside it, and the PORT-PINNED
/// paragraph in full — including the machine-specific half, which is the half
/// people miss and the reason a shared config silently stops matching.
#[test]
fn the_devices_page_lists_boards_not_devnodes_and_keeps_the_port_pinned_warning() {
    let addr = start_server(Arc::new(ScriptedControl::new(true)));
    let page = get(addr, "/devices");
    let body = body_of(&page);

    assert!(body.contains("Ultimarc I-PAC 4X"), "{body}");
    assert!(body.contains("2 keyboard-capable boards"), "{body}");
    assert!(body.contains("1 [[device]] entry in config.toml"), "{body}");
    // The board with no keyboard interface is LISTED, not hidden: "ksx cannot
    // see my board" is a real support question.
    assert!(body.contains("Example auxiliary controller"), "{body}");
    assert!(body.contains("PORT-PINNED"), "{body}");
    assert!(
        body.contains("do not copy this config to another cabinet"),
        "the machine-specific half of the warning must reach the page: {body}"
    );
    // The two words that decide whether the entry can capture anything. The
    // page carried `backend` in its row object and rendered it nowhere, so it
    // never said `winusb` or `interception` — the field the health pill above
    // is reasoning about — and `rung` was not carried at all.
    assert!(body.contains(">backend</span>"), "{body}");
    assert!(body.contains(">rung</span>"), "{body}");
    assert!(body.contains(">winusb<"), "{body}");
    assert!(body.contains(">port<"), "{body}");
    // Claiming needs elevation, so the command is TEXT and there is no form.
    assert!(body.contains("ksx winusb release"), "{body}");
    assert!(body.contains("ELEVATED shell"), "{body}");
    assert!(
        !body.contains(r#"action="/devices/claim""#),
        "a claim form on a surface that cannot elevate: {body}"
    );
}

/// A refused scan renders as a refusal, never as an empty machine. The two are
/// indistinguishable in the data and completely different to a person standing
/// at a cabinet with four boards plugged in.
#[test]
fn a_refused_scan_renders_the_refusal_rather_than_an_empty_list() {
    let addr = start_server_with_machine(
        Arc::new(ScriptedControl::new(true)),
        Arc::new(ScriptedMachine::refusing()),
    );
    let page = get(addr, "/devices");
    let body = body_of(&page);
    assert!(body.contains("could not be read"), "{body}");
    assert!(body.contains("run `ksx devices`"), "{body}");
    for claim in [
        ksx_api::NO_BOARDS_LINE,
        "no board it found exposes a",
        "No board is configured yet",
        "no [[device]] entries in config.toml",
    ] {
        assert!(
            !body.contains(claim),
            "a refused read printed an assertion of absence ({claim:?}): {body}"
        );
    }
}

/// **A scan that ANSWERS "I could not read the USB bus" is not an empty
/// cabinet either** — and this is the state nothing tested.
///
/// FAILS against the shipped page. `ScriptedMachine` only ever returned
/// `usb_available: true`, so no HTTP test could reach the path where the
/// enumeration itself failed; the page printed the banner "nothing could be
/// READ" and, directly beneath it, "No board here exposes a keyboard
/// interface". This is the shape of the failure that started the whole
/// project: a session reporting success while the arcade panel was dead
/// because a WinUSB board had fallen back to Interception. "I could not read
/// this" and "there is nothing here" are different sentences, and the user
/// acts on them differently.
#[test]
fn a_failed_enumeration_never_renders_as_an_empty_cabinet() {
    let addr = start_server_with_machine(
        Arc::new(ScriptedControl::new(true)),
        Arc::new(ScriptedMachine::blind()),
    );
    let body = body_of(&get(addr, "/devices")).to_owned();

    assert!(
        body.contains("nothing could be READ"),
        "the page must say the list is empty because nothing was read: {body}"
    );
    for claim in [ksx_api::NO_BOARDS_LINE, "no board it found exposes a"] {
        assert!(
            !body.contains(claim),
            "a failed enumeration printed the empty-machine sentence ({claim:?}): {body}"
        );
    }

    // The poller gets the same answer, in the field the island actually reads.
    // A page that got this right while `/api/devices` sent
    // `no_pickable_board_found: true` would go wrong two seconds later.
    let json: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/devices"))).unwrap();
    assert_eq!(
        json.pointer("/scan/no_pickable_board_found"),
        Some(&serde_json::json!(false)),
        "the poll licensed the island to draw an empty machine: {json}"
    );
    assert_eq!(
        json.pointer("/scan/usb_available"),
        Some(&serde_json::json!(false))
    );

    // And the ordinary cabinet is unaffected — it still has boards and says so.
    let ok = start_server(Arc::new(ScriptedControl::new(true)));
    assert!(body_of(&get(ok, "/devices")).contains("2 keyboard-capable boards"));
}

/// **The rule this page has to teach, rendered.** A Bluetooth keyboard is in
/// the SAME list as the USB boards, its row says Interception yes / WinUSB
/// never, and the "never" names the transport fact.
///
/// FAILS against the shipped page in three separate ways: the payload had no
/// transport at all, the row had no backend line, and the enumeration behind it
/// walked USB only so the device was not on the page to begin with.
#[test]
fn the_devices_page_states_which_backends_each_transport_can_use() {
    let addr = start_server(Arc::new(ScriptedControl::new(true)));
    let body = body_of(&get(addr, "/devices")).to_owned();

    assert!(body.contains("Bluetooth Keyboard"), "{body}");
    // The transport column, on BOTH rows — a label that only appears on the
    // surprising one reads as a special case rather than as the rule.
    assert!(body.contains(">Bluetooth<"), "{body}");
    assert!(body.contains(">USB<"), "{body}");
    // The backend line, and the reason.
    assert!(
        body.contains("winusb: never"),
        "the Bluetooth row must say WinUSB never applies: {body}"
    );
    assert!(
        body.contains("no USB interface to bind"),
        "and name the transport fact rather than refusing vaguely: {body}"
    );
    assert!(
        body.contains("not a missing feature"),
        "'not supported' invites waiting for a release that cannot come: {body}"
    );
    assert!(
        body.contains("interception: yes, now"),
        "and the backend that DOES capture it today: {body}"
    );
    // Never an elevated claim command on that row: a claim on this device
    // refuses every time it is run, and a page that printed one would be
    // handing out a command that cannot work. Asserted on the row the page
    // renders FROM, because the raw HTML also carries the hydration payload
    // and a substring search cannot tell the two apart.
    let json: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/devices"))).unwrap();
    let bt = json.pointer("/scan/boards/0").expect("the Bluetooth board");
    assert_eq!(
        bt.pointer("/name"),
        Some(&serde_json::json!("Bluetooth Keyboard"))
    );
    assert_eq!(bt.pointer("/claim_command"), Some(&serde_json::json!(null)));
    assert_eq!(bt.pointer("/command"), Some(&serde_json::json!("")));
    assert_eq!(bt.pointer("/command_lead"), Some(&serde_json::json!("")));
    // …but it IS pickable, which is the whole point.
    assert_eq!(bt.pointer("/pickable"), Some(&serde_json::json!(true)));
    assert!(
        body.contains(r#"action="/devices/pick""#),
        "and the pick form is on the page: {body}"
    );
}

/// A refusal degrades to `DeviceScanView::default()`, and that default must
/// license nothing. This is the invariant the `show:` flags depend on: they
/// read `no_pickable_board_found` / `no_configured_device` alone, with no
/// `&& unavailable.is_empty()` in either language, which is only sound while
/// every refusing path in `collect_devices` hands over a defaulted scan.
#[test]
fn a_refusal_serves_a_scan_that_asserts_nothing() {
    let addr = start_server_with_machine(
        Arc::new(ScriptedControl::new(true)),
        Arc::new(ScriptedMachine::refusing()),
    );
    let json: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/devices"))).unwrap();

    assert_ne!(
        json.pointer("/unavailable"),
        Some(&serde_json::json!("")),
        "the refusal itself must be on the wire: {json}"
    );
    assert_eq!(
        json.pointer("/scan/no_pickable_board_found"),
        Some(&serde_json::json!(false))
    );
    assert_eq!(
        json.pointer("/scan/no_configured_device"),
        Some(&serde_json::json!(false))
    );
    for line in ["/scan/boards_summary", "/scan/configured_summary"] {
        let value = json.pointer(line).and_then(|v| v.as_str()).unwrap_or("");
        assert!(
            value.contains("nothing could be READ"),
            "{line} must say why it is empty, got {value:?}"
        );
    }
}

/// The devices poller serves the facts the page needs, field by field.
///
/// RENAMED 2026-08-26 from `api_devices_serves_the_same_payload_the_page_embeds`.
/// The old name claimed a page/poller comparison this body never made: it
/// never requests `/devices` and never touches `__ksx-payload`, so replacing
/// the page's embedded block with `{}` left it green. The claim it advertised
/// is now actually tested, for all four pages, by
/// `every_page_embeds_the_payload_its_api_serves`.
#[test]
fn the_devices_api_serves_the_scan_fields_the_page_reads() {
    let addr = start_server(Arc::new(ScriptedControl::new(true)));
    let json: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/devices"))).unwrap();
    assert_eq!(
        json.pointer("/scan/boards/1/name"),
        Some(&serde_json::json!("Ultimarc I-PAC 4X"))
    );
    assert_eq!(
        json.pointer("/scan/configured/0/alias"),
        Some(&serde_json::json!("panel"))
    );
    // Both transports, in one list, each saying which backends reach it —
    // the poller and the SSR seam read the same fields off the same payload.
    assert_eq!(
        json.pointer("/scan/boards/0/transport"),
        Some(&serde_json::json!("bluetooth"))
    );
    assert_eq!(
        json.pointer("/scan/boards/0/winusb_eligible"),
        Some(&serde_json::json!(false))
    );
    assert_eq!(
        json.pointer("/scan/boards/0/interception_eligible"),
        Some(&serde_json::json!(true))
    );
    assert_eq!(
        json.pointer("/scan/boards/1/transport"),
        Some(&serde_json::json!("usb"))
    );
    // Two separate reads, two separate flags: a dead Bluetooth walk must not
    // hide behind a healthy USB one.
    assert_eq!(
        json.pointer("/scan/bluetooth_available"),
        Some(&serde_json::json!(true))
    );
    // A poll is not an action.
    assert_eq!(json.pointer("/flash"), Some(&serde_json::json!(null)));
}

/// **Every page embeds exactly the payload its `/api/*` route serves.**
///
/// One struct, one serializer — so the first paint and the 2 s poll can never
/// describe different worlds. This is the assertion three tests were NAMED
/// after and none of them made: `api_devices_serves_the_same_payload_the_page_embeds`
/// (renamed above), `the_payload_block_matches_the_api_payload_shape` on
/// `/devices` (which compared the serializer to itself).
///
/// The coverage existed once and was deleted WITH the pages it named:
/// `the_profiles_api_serves_the_pages_own_payload` and
/// `the_setup_api_serves_the_payload_the_page_embeds` went out in the cutover
/// and were never replaced on the surviving four.
///
/// The browser parity suite cannot see this: `ssr-hydration-parity.test.mjs`
/// captures ~300 ms after adoption, BEFORE the first poll lands. A page that
/// paints one thing and repaints another two seconds later is exactly the
/// failure that suite's own header describes, and this is the seam it happens
/// at.
///
/// Two divergences are normalized, and BOTH are deliberate production
/// behaviour rather than slack in the test:
///
///  - `flash` — a page renders the flash it was redirected with; a poll is not
///    an action, so `/api/*` always serves `flash: null`.
///  - `/devices`'s `residue` — the page collects with `Reconcile::Now` and the
///    poller with `Reconcile::Skip`, because `reconcile_report` shells out to
///    `pnputil` (157 ms measured) and receipts only move through this very
///    page. The poll therefore serves a NEUTRAL residue and `DevicesIsland.ts`
///    keeps the page's values behind its `looked` guard. That exemption is not
///    a hole here: the neutral shape is asserted below, because it is exactly
///    what makes the island's guard safe. If a poll ever served
///    `readable: false` or a real receipt count, the island WOULD overwrite the
///    page's card and the user would watch it change two seconds after load.
#[test]
fn every_page_embeds_the_payload_its_api_serves() {
    let addr = start_server(Arc::new(ScriptedControl::new(true)));

    for (page, api) in [
        ("/check", "/api/check"),
        ("/pads", "/api/pads"),
        ("/devices", "/api/devices"),
        ("/redesign", "/api/redesign"),
    ] {
        let body = body_of(&get(addr, page)).to_owned();
        let block = body
            .split_once(r#"<script id="__ksx-payload" type="application/json">"#)
            .and_then(|(_, rest)| rest.split_once("</script>"))
            .map(|(json, _)| json)
            .unwrap_or_else(|| panic!("{page} serves no hydration payload block"));
        assert!(
            !block.trim().is_empty(),
            "{page} serves an EMPTY payload block — the island seeds from nothing"
        );

        let mut embedded: serde_json::Value =
            serde_json::from_str(block).unwrap_or_else(|e| panic!("{page} payload json: {e}"));
        let mut served: serde_json::Value = serde_json::from_str(body_of(&get(addr, api)))
            .unwrap_or_else(|e| panic!("{api} json: {e}"));

        if page == "/devices" {
            // The poll must be the neutral "this poll did not look" shape —
            // `readable: true` and no facts — or the island's `looked` guard
            // stops protecting the page's card.
            let residue = &served["residue"];
            assert_eq!(
                residue["readable"],
                serde_json::json!(true),
                "{api} claims the receipt store is UNREADABLE on a poll that \
                 never looked; the island would repaint the page's card: {residue}"
            );
            for empty in ["receipts", "leftover_certificates", "certificates_in_use"] {
                assert_eq!(
                    residue[empty],
                    serde_json::json!(0),
                    "{api} serves a {empty} count from a poll that skipped the \
                     reconcile: {residue}"
                );
            }
            for value in [&mut embedded, &mut served] {
                if let Some(object) = value.as_object_mut() {
                    object.remove("residue");
                }
            }
        }

        for value in [&mut embedded, &mut served] {
            if let Some(object) = value.as_object_mut() {
                object.insert("flash".to_owned(), serde_json::Value::Null);
            }
        }
        assert_eq!(
            embedded, served,
            "{page} embeds a payload {api} does not serve — the paint and the \
             poll disagree, so the page will repaint on the first poll"
        );
    }
}

/// The pick write: 303 back to the page with the outcome as the flash, and the
/// spec that reached the backend is the KEYBOARD interface — not the board's
/// composite parent, which no resolver would accept.
#[test]
fn picking_a_board_calls_the_backend_and_redirects_with_the_outcome() {
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(Arc::new(ScriptedControl::new(true)), machine.clone());

    let response = post_form(
        addr,
        "/devices/pick",
        "query=USB%5CVID_D209%26PID_0430%26MI_00%5C7%261A2B3C4D%260%260000&alias=panel",
    );
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(response.contains("/devices?flash="), "{response}");

    let picked = machine.picked.lock().unwrap();
    assert_eq!(picked.len(), 1, "exactly one pick reached the backend");
    assert_eq!(picked[0].0, IPAC_KB);
    assert_eq!(picked[0].1.as_deref(), Some("panel"));
}

/// A blank name box is "derive one from the board", exactly like the absent
/// `--alias` flag. The form always submits the field, so the emptiness has to
/// survive the wire; `LocalMachine::device_pick` is what turns it back into
/// `None` before the writer sees it.
#[test]
fn a_blank_alias_still_posts_and_is_accepted() {
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(Arc::new(ScriptedControl::new(true)), machine.clone());

    let response = post_form(addr, "/devices/pick", "query=MI_00&alias=");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    let picked = machine.picked.lock().unwrap();
    assert_eq!(picked[0].1.as_deref(), Some(""), "the form sends it empty");
}

/// The remove write, and the fact that surprises people: deleting the entry did
/// not release the board. It has to be in the flash, because the flash is all
/// the user sees on the way back.
#[test]
fn removing_an_entry_says_the_board_is_still_claimed() {
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(Arc::new(ScriptedControl::new(true)), machine.clone());

    let response = post_form(addr, "/devices/remove", "alias=panel");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(
        response.contains("STILL%20CLAIMED"),
        "the flash must carry the claim warning: {response}"
    );

    let removed = machine.removed.lock().unwrap();
    assert_eq!(removed.len(), 1);
    assert_eq!(removed[0].0, "panel");
    assert!(
        !removed[0].1,
        "an unticked checkbox is not sent at all, so no --force"
    );
}

/// The checkbox is the consent, and HTML omits an unchecked box entirely — so
/// `force` is "present at all", never a parsed boolean.
#[test]
fn a_ticked_force_box_reaches_the_backend_as_force() {
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(Arc::new(ScriptedControl::new(true)), machine.clone());

    post_form(addr, "/devices/remove", "alias=panel&force=yes");
    assert!(machine.removed.lock().unwrap()[0].1, "--force must carry");
}

#[test]
fn certificate_cleanup_is_post_only_and_requires_explicit_confirmation() {
    let machine = Arc::new(CertificateMachine::ready(2, 2));
    let addr = start_server_with_machine(Arc::new(ScriptedControl::new(true)), machine.clone());

    let get_response = get(addr, "/devices/certificates/sweep");
    assert!(
        get_response.starts_with("HTTP/1.1 405"),
        "the trust-store mutation must have no GET route: {get_response}"
    );

    let response = post_form(addr, "/devices/certificates/sweep", "");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(
        response.contains("Confirm%20the%20certificate%20cleanup"),
        "the missing consent needs a fixed, useful sentence: {response}"
    );
    assert_eq!(
        machine.sweep_calls.load(Ordering::SeqCst),
        0,
        "an unconfirmed form must not reach the elevated action"
    );
    assert_eq!(machine.leftovers.load(Ordering::SeqCst), 2);
}

#[test]
fn certificate_cleanup_success_is_a_fresh_zero_read_and_keeps_live_signers() {
    let machine = Arc::new(CertificateMachine::ready(6, 2));
    let addr = start_server_with_machine(Arc::new(ScriptedControl::new(true)), machine.clone());

    let before_page = body_of(&get(addr, "/devices")).to_owned();
    assert!(
        before_page.contains(r#"action="/devices/certificates/sweep""#),
        "{before_page}"
    );
    assert!(
        before_page.contains("still signing an installed driver stays in place"),
        "the page must state the live-signer boundary before the click: {before_page}"
    );
    let reads_before = machine.residue_reads.load(Ordering::SeqCst);

    let response = post_form(addr, "/devices/certificates/sweep", "confirm=yes");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(
        response.contains("Removed%20the%20leftover%20KSX%20signing%20certificates"),
        "{response}"
    );
    assert!(
        response.contains("live%20driver%20keeps%20working"),
        "the success flash must repeat that live signers remain: {response}"
    );
    assert_eq!(machine.sweep_calls.load(Ordering::SeqCst), 1);
    assert_eq!(machine.leftovers.load(Ordering::SeqCst), 0);
    assert_eq!(
        machine.residue_reads.load(Ordering::SeqCst),
        reads_before + 1,
        "success must be licensed by a separate residue read after the action"
    );

    let after_page = body_of(&get(addr, "/devices")).to_owned();
    assert!(
        !after_page.contains(r#"action="/devices/certificates/sweep""#),
        "a zero-count action must disappear after the verified read: {after_page}"
    );
    assert!(
        !after_page.contains("Remove leftover certificates"),
        "{after_page}"
    );
}

#[test]
fn certificate_cleanup_never_claims_success_while_residue_remains() {
    let mut fixture = CertificateMachine::ready(2, 2);
    fixture.keep_leftovers = true;
    let machine = Arc::new(fixture);
    let addr = start_server_with_machine(Arc::new(ScriptedControl::new(true)), machine.clone());

    let response = post_form(addr, "/devices/certificates/sweep", "confirm=yes");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(
        response.contains("could%20not%20be%20verified"),
        "{response}"
    );
    assert!(
        !response.contains("Removed%20the%20leftover"),
        "an optimistic helper result must not become a success flash: {response}"
    );
    assert_eq!(machine.leftovers.load(Ordering::SeqCst), 2);
    assert_eq!(machine.residue_reads.load(Ordering::SeqCst), 1);
}

#[test]
fn blocked_certificate_cleanup_is_disabled_and_a_forged_post_still_refuses() {
    let mut fixture = CertificateMachine::ready(0, 0);
    fixture.blocked = true;
    let machine = Arc::new(fixture);
    let addr = start_server_with_machine(Arc::new(ScriptedControl::new(true)), machine.clone());

    let page = body_of(&get(addr, "/devices")).to_owned();
    assert!(page.contains("Certificate cleanup unavailable"), "{page}");
    assert!(page.contains("disabled"), "{page}");
    assert!(
        !page.contains(r#"action="/devices/certificates/sweep""#),
        "a blocked classifier must not render an actionable form: {page}"
    );

    let response = post_form(addr, "/devices/certificates/sweep", "confirm=yes");
    assert!(
        response.contains("could%20not%20be%20verified"),
        "{response}"
    );
    assert_eq!(
        machine.sweep_calls.load(Ordering::SeqCst),
        0,
        "a hand-authored POST must not bypass the blocked read state"
    );
}

#[test]
fn certificate_cleanup_is_same_origin_and_never_reflects_helper_output() {
    let mut fixture = CertificateMachine::ready(2, 0);
    fixture.refuse = true;
    let machine = Arc::new(fixture);
    let addr = start_server_with_machine(Arc::new(ScriptedControl::new(true)), machine.clone());
    let body = "confirm=yes";
    let cross_site = http(
        addr,
        &format!(
            "POST /devices/certificates/sweep HTTP/1.1\r\nHost: 127.0.0.1\r\n\
             Origin: https://evil.example\r\nConnection: close\r\n\
             Content-Type: application/x-www-form-urlencoded\r\n\
             Content-Length: {}\r\n\r\n{body}",
            body.len()
        ),
    );
    assert!(cross_site.starts_with("HTTP/1.1 403"), "{cross_site}");
    assert_eq!(machine.sweep_calls.load(Ordering::SeqCst), 0);

    let same_origin = post_form(addr, "/devices/certificates/sweep", body);
    assert!(same_origin.starts_with("HTTP/1.1 303"), "{same_origin}");
    assert!(
        same_origin.contains("could%20not%20be%20verified"),
        "{same_origin}"
    );
    for secret in ["secret", "generated.inf", "--repair", "DEADBEEF"] {
        assert!(
            !same_origin.contains(secret),
            "provider/helper output crossed the presentation boundary ({secret}): {same_origin}"
        );
    }
    assert_eq!(machine.sweep_calls.load(Ordering::SeqCst), 1);
}

/// Both writes are POST and both sit inside the guarded router. The assertion
/// that matters is not the status code — it is that the WRITER never saw the
/// request.
#[test]
fn a_cross_site_post_never_reaches_the_device_writer() {
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(Arc::new(ScriptedControl::new(true)), machine.clone());

    for (path, body) in [
        ("/devices/pick", "query=MI_00&alias=stolen"),
        ("/devices/remove", "alias=panel&force=yes"),
    ] {
        let response = http(
            addr,
            &format!(
                "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\
                 Origin: https://evil.example\r\nConnection: close\r\n\
                 Content-Type: application/x-www-form-urlencoded\r\n\
                 Content-Length: {}\r\n\r\n{body}",
                body.len()
            ),
        );
        assert!(
            response.starts_with("HTTP/1.1 403"),
            "{path} must refuse a cross-site write, got: {response}"
        );
        assert_route_is_real(addr, path);
    }
    assert!(
        machine.picked.lock().unwrap().is_empty(),
        "no cross-site request may reach the device writer"
    );
    assert!(machine.removed.lock().unwrap().is_empty());
}

/// DNS rebinding: the read is guarded too, on every request, by NAME.
#[test]
fn a_rebound_host_cannot_read_the_device_list() {
    let addr = start_server(Arc::new(ScriptedControl::new(true)));
    let response = http(
        addr,
        "GET /api/devices HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n",
    );
    assert!(
        response.starts_with("HTTP/1.1 421"),
        "a rebound read must be refused, got: {response}"
    );
}

/// Device selection has two deliberate no-JS entry points: exact-machine
/// selection in the operational picker and identify-by-key in the product.
/// Each destination contains a real FORM rather than merely borrowing a label.
///
/// RENAMED 2026-08-26 from `every_page_links_to_the_device_picker`, which
/// overclaimed: it checked two of the live pages, and neither by following a
/// link. `/redesign` identifies the intended keyboard while `/devices` IS the
/// operational exact-machine picker. Whether the OTHER pages can reach the flow is
/// a nav question, and it is pinned where nav belongs:
/// `render.rs::no_page_links_into_a_deleted_surface` asserts every tool page
/// carries the workflow link to `/redesign`.
#[test]
fn no_js_device_selection_forms_are_served_on_redesign_and_devices() {
    let addr = start_server(Arc::new(ScriptedControl::new(true)));

    for (page, action) in [
        ("/redesign", r#"action="/redesign/device/identify""#),
        ("/devices", r#"action="/devices/pick""#),
    ] {
        let body = body_of(&get(addr, page)).to_owned();
        assert!(
            body.contains(action),
            "{page} has no device picker form ({action}): {body}"
        );
        // A form is only a picker if it can POST. `method="post"` is what
        // separates the real control from a label that looks like one — and
        // the no-JS path depends on it entirely.
        let at = body.find(action).expect("just asserted");
        let tag_start = body[..at].rfind("<form").expect("the form tag");
        let tag_end = body[tag_start..]
            .find('>')
            .map_or(body.len(), |end| tag_start + end);
        let tag = &body[tag_start..tag_end];
        assert!(
            tag.contains(r#"method="post""#),
            "{page}'s picker form is not a POST — the no-JS picker cannot \
             submit: {tag}"
        );
    }
}

/// Identify is a real no-JS form, and its label states the staging
/// consequence before the listen begins. "Identify" alone would sound like a
/// passive flashlight while the shared transaction deliberately selects the
/// board that answers.
#[test]
fn the_redesign_identify_form_serves_its_explicit_consequence() {
    let addr = start_server(Arc::new(ScriptedControl::new(true)));
    let response = get(addr, "/redesign");
    let body = body_of(&response);
    assert!(
        body.contains(r#"action="/redesign/device/identify""#),
        "the redesign has no no-JS identify form: {body}"
    );
    assert!(
        body.contains("Identify and use as input source"),
        "the action does not disclose that a successful answer selects the input: {body}"
    );
    assert!(
        body.contains("nothing is captured, saved, or started"),
        "the safety boundary is not stated beside the action: {body}"
    );
}

// ---------------------------------------------------------------------------
// /profiles — the games.toml profiles and the presets (v15)
// ---------------------------------------------------------------------------

/// A missing program is called out before Play, without turning a machine path
/// into alarm copy. The editable value remains in the affected row's form.
/// TK2's stamp oracle: every page GET renders `<html lang="en">` with the
/// stored theme stamped — and ONLY ids this build ships. The stamp is applied
/// per handler (`page_theme` + `render::with_theme`) and the render-layer
/// tests cannot see it because the splice happens above them — so this loop
/// is the coverage, and PAGES is a HAND-KEPT list: a fifth page must be added
/// both to its handler and to this array, or its stamp ships untested.
///
/// It was ten entries until `/`, `/map`, `/start`, `/setup`, `/profiles` and
/// `/workspace` were deleted and `/redesign` became the product.
#[test]
fn every_page_stamps_the_stored_theme_and_only_a_shipped_one() {
    const PAGES: [&str; 4] = ["/check", "/pads", "/devices", "/redesign"];

    // No stored choice → no stamp: System is the ABSENCE of the attribute,
    // which is what hands the choice to the stylesheet's
    // `:root:not([data-theme])` system-follow guard.
    let addr = start_server(Arc::new(ScriptedControl::new(false)));
    for path in PAGES {
        let response = get(addr, path);
        let body = body_of(&response);
        assert!(
            body.contains("<html lang=\"en\">"),
            "{path}: the un-stamped opener is missing"
        );
        // The inline anti-flash CSS legitimately carries `data-theme=`
        // selectors on every page, so the check is the OPENER, not the token.
        assert!(
            !body.contains("<html lang=\"en\" data-theme="),
            "{path}: stamped with no stored choice"
        );
    }

    // A stored, shipped id → stamped on EVERY page.
    let machine = Arc::new(ScriptedMachine::default());
    *machine.theme.lock().unwrap() = "light".to_owned();
    let addr = start_server_with_machine(Arc::new(ScriptedControl::new(false)), machine);
    for path in PAGES {
        let response = get(addr, path);
        let body = body_of(&response);
        // Positional, not just present: the payload block escapes `<`, so a
        // body match cannot come from user data — but pinning the stamp
        // BEFORE </head> says it is the document opener, not a fluke.
        let at = body
            .find("<html lang=\"en\" data-theme=\"light\">")
            .unwrap_or_else(|| panic!("{path}: missing the light stamp"));
        assert!(
            at < body.find("</head>").unwrap_or(usize::MAX),
            "{path}: the stamp must sit on the document opener"
        );
    }

    // A stored id this build does NOT ship → renders as System. The config is
    // hand-editable, so this path is reachable — and stamping it would defeat
    // the system-follow guard
    // while styling nothing (a light-OS user silently gets base dark).
    let machine = Arc::new(ScriptedMachine::default());
    *machine.theme.lock().unwrap() = "matrix2".to_owned();
    let addr = start_server_with_machine(Arc::new(ScriptedControl::new(false)), machine);
    let response = get(addr, "/redesign");
    // Positive first (review-caught: a negative-only arm passes vacuously on
    // a broken page), then the absence claim.
    assert!(
        response.starts_with("HTTP/1.1 200"),
        "the page must still render under an unknown stored id, got: {response}"
    );
    let body = body_of(&response);
    assert!(
        body.contains("<html lang=\"en\">"),
        "the un-stamped opener must be present under an unknown stored id"
    );
    assert!(
        !body.contains("<html lang=\"en\" data-theme="),
        "an id this build does not ship must render as System"
    );
}

/// The theme round trip on `/redesign`. This pins all three pieces that must
/// move together: the 303 lands
/// back on `/redesign` carrying the allowlisted sentence, the very next
/// `/redesign` render stamps the choice (the invalidation layer covers the
/// new route), and an unshipped id is refused at the door.
#[test]
fn the_redesign_theme_form_round_trips() {
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(
        Arc::new(ScriptedControl::new(false)),
        Arc::clone(&machine) as Arc<dyn ksx_api::MachineSource>,
    );

    let response = post_form(addr, "/redesign/theme", "theme=matrix");
    assert!(response.starts_with("HTTP/1.1 303"), "got: {response}");
    assert!(
        response.contains("/redesign?flash=Studio%20theme%20updated."),
        "the outcome must ride back to THIS page, got: {response}"
    );
    assert_eq!(
        machine.set_theme_specs.lock().unwrap().as_slice(),
        ["matrix"],
        "the form's id must reach the verb"
    );
    let after = get(addr, "/redesign");
    assert!(
        body_of(&after).contains("data-theme=\"matrix\""),
        "the redirect's render must already stamp the new choice \
         (the POST busts the machine cache)"
    );
    // And the menu's marking follows the same read: the stamped id's row is
    // the one marked, on this page's own forms.
    assert!(
        body_of(&after).contains(r#"action="/redesign/theme""#),
        "the theme menu must serve its forms"
    );

    let response = post_form(addr, "/redesign/theme", "theme=system");
    assert!(response.starts_with("HTTP/1.1 303"), "got: {response}");
    assert_eq!(
        machine.set_theme_specs.lock().unwrap().as_slice(),
        ["matrix", ""],
        "`system` clears: the stored value is the empty string"
    );

    let response = post_form(addr, "/redesign/theme", "theme=matrix2");
    assert!(
        response.contains("flash=error"),
        "an unshipped id flashes an error, got: {response}"
    );
    assert_eq!(
        machine.set_theme_specs.lock().unwrap().len(),
        2,
        "a refused id must never reach the machine provider"
    );

    let response = post_form(addr, "/redesign/theme", "");
    assert!(
        response.contains("flash=error"),
        "a missing field uses the same allowlisted error in every client: {response}"
    );
    assert_eq!(
        machine.set_theme_specs.lock().unwrap().len(),
        2,
        "a missing field must never reach the machine provider"
    );
}

/// The workbench's Stage-this-board verb at its product route,
/// through the SAME preparation-preserving guard — staging writes, the 303
/// lands back on `/redesign` with the shared sentence, the redirect's render
/// marks the staged row, and pressing the staged board again writes nothing
/// and says "still" (the guard's whole point).
#[test]
fn the_redesign_device_verb_stages_through_the_preserving_guard() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control.clone());

    let body = "selector=usb%3Ad209%3A0430%3A00&alias=panel&label=I-PAC";
    let response = post_form(addr, "/redesign/device", body);
    assert!(response.starts_with("HTTP/1.1 303"), "got: {response}");
    assert!(
        response.contains("/redesign?flash=Keyboard%20selected."),
        "the outcome must ride back to THIS page, got: {response}"
    );
    assert_eq!(
        control
            .staged()
            .device
            .map(|device| device.selector)
            .as_deref(),
        Some("usb:d209:0430:00"),
        "the stage must hold the posted board"
    );
    // (The staged row's aria_current marking is composed and pinned in
    // render_redesign.rs's tier test; the scripted machine serves no boards,
    // so this transport-level test asserts the write and the sentences.)

    let again = post_form(addr, "/redesign/device", body);
    assert!(
        again.contains("flash=That%20keyboard%20is%20still"),
        "re-staging the staged board must answer with the preserved-preparation \
         sentence, got: {again}"
    );
}

/// Identify remains the proven one-shot transaction: the daemon observes the
/// key source, the machine resolves that exact instance, and only then does
/// the shared preparation-preserving chooser stage it. The redesign adds no
/// browser-supplied identity and redirects its answer back to its own surface.
#[test]
fn the_redesign_identify_verb_selects_the_exact_machine_board() {
    let control = Arc::new(ScriptedControl::new(false).with_identify_hit(IPAC_KB));
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(Arc::clone(&control), machine.clone());

    let response = post_form(
        addr,
        "/redesign/device/identify",
        "attempt=0123456789abcdef0123456789abcdef",
    );
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(
        response.contains("/redesign?flash=Keyboard%20identified"),
        "{response}"
    );
    assert!(
        response.contains("identified_selector=usb%3Ad209%3A0430%3A00"),
        "the response must bind this attempt to its canonical selector: {response}"
    );
    let selected = control
        .staged()
        .device
        .expect("the exact keyboard that answered must become the mapping input");
    assert_eq!(selected.selector, "usb:d209:0430:00");
    assert_eq!(selected.alias, "panel");
    assert_eq!(selected.label, "Ultimarc I-PAC 4X");
    assert_eq!(
        machine.identified_from.lock().unwrap().as_slice(),
        [IPAC_KB],
        "only the daemon-observed Windows instance reaches the resolver"
    );
}

/// Escape reaches Raw Input as well as the browser. Even if that physical hit
/// beats the cancel POST, the redesign transaction must settle as cancelled
/// before machine resolution and leave the prior mapping input untouched.
#[test]
fn redesign_identify_treats_an_escape_hit_as_cancellation_not_a_device() {
    let control = Arc::new(ScriptedControl::new(false).with_identify_key_hit(IPAC_KB, "Escape"));
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(Arc::clone(&control), machine.clone());
    post_form(
        addr,
        "/redesign/device",
        "selector=usb%3A046d%3Ac545%3A00&alias=g915&label=Logitech+G915",
    );

    let response = post_form(
        addr,
        "/redesign/device/identify",
        "attempt=esc00000000000000000000000000000",
    );
    assert!(
        response.contains("Keyboard%20identification%20cancelled"),
        "{response}"
    );
    assert_eq!(
        control
            .staged()
            .device
            .map(|device| device.selector)
            .as_deref(),
        Some("usb:046d:c545:00"),
        "Escape must preserve the prior mapping input"
    );
    assert!(
        machine.identified_from.lock().unwrap().is_empty(),
        "Escape must never reach exact-device resolution"
    );
}

/// Cancellation is generation-qualified and outcome-atomic. Once this route
/// says "cancelled", the held identify POST cannot later stage a board; and a
/// cancellation with no owned generation cannot stop some unrelated learner.
#[test]
fn redesign_identify_cancel_stops_only_its_pending_generation() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));
    post_form(
        addr,
        "/redesign/device",
        "selector=usb%3A046d%3Ac545%3A00&alias=g915&label=Logitech+G915",
    );

    let identify = std::thread::spawn(move || {
        post_form(
            addr,
            "/redesign/device/identify",
            "attempt=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !control.learning.load(Ordering::SeqCst) {
        assert!(
            std::time::Instant::now() < deadline,
            "the identify transaction never opened its learner"
        );
        std::thread::sleep(Duration::from_millis(2));
    }

    let competing = post_form(
        addr,
        "/redesign/device/identify",
        "attempt=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    assert!(
        competing.contains("Another%20keyboard%20identification%20is%20already%20listening"),
        "a second tab must not replace the generation owned by the first: {competing}"
    );

    let cancelled = post_form(
        addr,
        "/redesign/device/identify/cancel",
        "attempt=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    assert!(cancelled.starts_with("HTTP/1.1 303"), "{cancelled}");
    assert!(
        cancelled.contains("Keyboard%20identification%20cancelled"),
        "{cancelled}"
    );
    let identify = identify.join().expect("identify request joins");
    assert!(identify.contains("flash=error"), "{identify}");
    assert_eq!(
        control
            .staged()
            .device
            .map(|device| device.selector)
            .as_deref(),
        Some("usb:046d:c545:00"),
        "a cancelled identify must leave the prior mapping input untouched"
    );

    let late = post_form(
        addr,
        "/redesign/device/identify/cancel",
        "attempt=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    assert!(
        late.contains("Keyboard%20identification%20cancelled"),
        "a repeated cancel for the same nonce should be idempotent: {late}"
    );
}

/// A browser cancellation owns its nonce as well as the daemon generation.
/// A delayed request from completed tab A must not take tab B's newer lease,
/// even though B is the transaction currently stored by the server.
#[test]
fn redesign_identify_stale_cancel_cannot_stop_a_newer_browser_attempt() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));

    let first = std::thread::spawn(move || {
        post_form(
            addr,
            "/redesign/device/identify",
            "attempt=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
    });
    let first_deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !control.learning.load(Ordering::SeqCst) {
        assert!(std::time::Instant::now() < first_deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
    let first_cancel = post_form(
        addr,
        "/redesign/device/identify/cancel",
        "attempt=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    assert!(first_cancel.contains("Keyboard%20identification%20cancelled"));
    let _ = first.join().expect("first identify request joins");

    let second = std::thread::spawn(move || {
        post_form(
            addr,
            "/redesign/device/identify",
            "attempt=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        )
    });
    let second_deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !control.learning.load(Ordering::SeqCst) {
        assert!(std::time::Instant::now() < second_deadline);
        std::thread::sleep(Duration::from_millis(2));
    }

    let stale = post_form(
        addr,
        "/redesign/device/identify/cancel",
        "attempt=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    assert!(
        stale.contains("Keyboard%20identification%20cancelled"),
        "the old tab's own cancel remains idempotent: {stale}"
    );
    assert!(
        control.learning.load(Ordering::SeqCst),
        "tab A's delayed cancel stopped tab B's listener"
    );

    let second_cancel = post_form(
        addr,
        "/redesign/device/identify/cancel",
        "attempt=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    assert!(second_cancel.contains("Keyboard%20identification%20cancelled"));
    let _ = second.join().expect("second identify request joins");
}

/// Cancel can overtake the long-lived start request on a fast Escape. The
/// server records that nonce before a learner exists; when the matching start
/// arrives it consumes the tombstone without touching the shared daemon.
#[test]
fn redesign_identify_cancel_before_start_never_opens_a_listener() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));
    let cancelled = post_form(
        addr,
        "/redesign/device/identify/cancel",
        "attempt=cccccccccccccccccccccccccccccccc",
    );
    assert!(
        cancelled.contains("Keyboard%20identification%20cancelled"),
        "{cancelled}"
    );

    let start = post_form(
        addr,
        "/redesign/device/identify",
        "attempt=cccccccccccccccccccccccccccccccc",
    );
    assert!(
        start.contains("Keyboard%20identification%20cancelled"),
        "{start}"
    );
    assert_eq!(
        control.learn_generation.load(Ordering::SeqCst),
        0,
        "cancel-before-start still opened the daemon learner"
    );
    assert!(!control.learning.load(Ordering::SeqCst));
}

/// Pre-start cancellation belongs to every browser nonce, not merely the most
/// recent one. Two tabs can press Escape before either Start request reaches
/// the server; both delayed starts must settle cancelled without a learner.
#[test]
fn redesign_identify_preserves_multiple_pre_start_cancellations() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));
    let attempts = [
        "11111111111111111111111111111111",
        "22222222222222222222222222222222",
    ];
    for attempt in attempts {
        let cancelled = post_form(
            addr,
            "/redesign/device/identify/cancel",
            &format!("attempt={attempt}"),
        );
        assert!(
            cancelled.contains("Keyboard%20identification%20cancelled"),
            "{cancelled}"
        );
    }
    for attempt in attempts {
        let start = post_form(
            addr,
            "/redesign/device/identify",
            &format!("attempt={attempt}"),
        );
        assert!(
            start.contains("Keyboard%20identification%20cancelled"),
            "{start}"
        );
    }
    assert_eq!(
        control.learn_generation.load(Ordering::SeqCst),
        0,
        "one cancelled tab opened a hidden learner after another tab cancelled"
    );
}

/// Once a learner hit crosses into exact-device resolution, selection owns
/// the outcome. A late Cancel must say the answer already landed; it cannot
/// promise "nothing changed" while the worker still stages that device.
#[test]
fn redesign_identify_hit_wins_before_late_cancel_reports_outcome() {
    let control = Arc::new(ScriptedControl::new(false).with_identify_hit(IPAC_KB));
    let machine = Arc::new(ScriptedMachine::default());
    machine.identify_hold.store(true, Ordering::SeqCst);
    let machine_source: Arc<dyn ksx_api::MachineSource> = machine.clone();
    let addr = start_server_with_machine(Arc::clone(&control), machine_source);

    let identify = std::thread::spawn(move || {
        post_form(
            addr,
            "/redesign/device/identify",
            "attempt=ffffffffffffffffffffffffffffffff",
        )
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !machine.identify_entered.load(Ordering::SeqCst) {
        assert!(
            std::time::Instant::now() < deadline,
            "identify never entered exact-device resolution"
        );
        std::thread::sleep(Duration::from_millis(2));
    }

    let late = post_form(
        addr,
        "/redesign/device/identify/cancel",
        "attempt=ffffffffffffffffffffffffffffffff",
    );
    assert!(late.contains("already%20answered"), "{late}");
    assert!(
        !late.contains("Keyboard%20identification%20cancelled"),
        "late Cancel falsely promised that nothing would change: {late}"
    );

    machine.identify_hold.store(false, Ordering::SeqCst);
    let identified = identify.join().expect("identify request joins");
    assert!(identified.contains("Keyboard%20identified"), "{identified}");
    assert_eq!(
        control
            .staged()
            .device
            .map(|device| device.selector)
            .as_deref(),
        Some("usb:d209:0430:00")
    );
}

/// A daemon refusal before generation assignment is a settled failed attempt,
/// not a permanent Pending reservation. A retry must reach the control source
/// again instead of being refused as Busy forever.
#[test]
fn redesign_identify_unavailable_start_releases_pending_for_retry() {
    let control = Arc::new(ScriptedControl::dead());
    let addr = start_server(Arc::clone(&control));

    for attempt in [
        "dddddddddddddddddddddddddddddddd",
        "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    ] {
        let response = post_form(
            addr,
            "/redesign/device/identify",
            &format!("attempt={attempt}"),
        );
        assert!(response.contains("flash=error"), "{response}");
        assert!(
            !response.contains("already%20listening"),
            "a failed start leaked Pending into the next attempt: {response}"
        );
    }
    assert_eq!(control.learn_generation.load(Ordering::SeqCst), 0);
}

/// The workbench's controller verbs round-trip: add stages the next slot and
/// answers with the shared draft sentence, move applies the card's
/// precomposed whole-order (the renumbering is the daemon's), an empty order
/// is the honest at-that-end answer and never a write, and remove drops the
/// slot. Every redirect lands back on /redesign.
#[test]
fn the_redesign_controller_verbs_stage_reorder_and_remove() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control.clone());

    for body in [
        "persona=xbox360&preset=Player+1",
        "persona=playstation&preset=Player+2",
    ] {
        let response = post_form(addr, "/redesign/controller", body);
        assert!(response.starts_with("HTTP/1.1 303"), "got: {response}");
        assert!(
            response.contains("/redesign?flash=Draft%20updated."),
            "the outcome must ride back to THIS page, got: {response}"
        );
    }
    let staged = control.staged();
    assert_eq!(
        staged
            .slots
            .iter()
            .map(|slot| (slot.number, slot.persona.as_str().to_owned()))
            .collect::<Vec<_>>(),
        vec![(1, "xbox360".to_owned()), (2, "playstation".to_owned())],
        "two adds stage two slots, in order"
    );

    let response = post_form(addr, "/redesign/controller/move", "order=2+1");
    assert!(
        response.contains("flash=Draft%20updated."),
        "got: {response}"
    );
    assert_eq!(
        control
            .staged()
            .slots
            .iter()
            .map(|slot| slot.persona.as_str().to_owned())
            .collect::<Vec<_>>(),
        vec!["playstation".to_owned(), "xbox360".to_owned()],
        "the whole-order reorder took, and the daemon renumbered"
    );

    let response = post_form(addr, "/redesign/controller/move", "order=");
    assert!(
        response.contains("flash=That%20controller%20is%20already"),
        "an empty order is the at-that-end sentence, never a write: {response}"
    );

    let response = post_form(addr, "/redesign/controller/remove", "number=1");
    assert!(
        response.contains("flash=Draft%20updated."),
        "got: {response}"
    );
    assert_eq!(
        control
            .staged()
            .slots
            .iter()
            .map(|slot| (slot.number, slot.persona.as_str().to_owned()))
            .collect::<Vec<_>>(),
        vec![(1, "xbox360".to_owned())],
        "the removal closes the gap: the survivor moves UP to slot 1 — a \
         card's number IS its play position on the workbench"
    );
}

/// Park keeps the slot's resurrection material and re-slotting RESTORES it:
/// the bindings survive the round trip, the restored slot seats at the
/// asked position, and a name another slot took meanwhile is re-issued
/// fresh instead of aliasing two slots onto one preset file.
#[test]
fn park_holds_the_bindings_and_assign_restores_them_without_aliasing() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control.clone());

    // A dressed slot: the layout binds keys, which is the material at stake.
    post_form(
        addr,
        "/redesign/controller",
        "persona=xbox360&preset=Player+1&layout=keyboard-2p",
    );
    assert!(
        control.staged().slots[0].bindings > 0,
        "the layout bound something"
    );

    let response = post_form(addr, "/redesign/controller/park", "number=1&ghost=g1");
    assert!(
        response.contains("flash=Draft%20updated."),
        "got: {response}"
    );
    assert!(control.staged().slots.is_empty(), "parked = off the draft");

    let response = post_form(
        addr,
        "/redesign/controller/assign",
        "ghost=g1&position=1&persona=xbox360&preset=Player+9&layout=",
    );
    assert!(
        response.contains("flash=Draft%20updated."),
        "got: {response}"
    );
    let restored = control.staged();
    assert_eq!(restored.slots.len(), 1);
    assert_eq!(restored.slots[0].number, 1);
    assert_eq!(
        restored.slots[0].preset, "Player 1",
        "a name still free is kept, not re-issued"
    );
    assert!(
        restored.slots[0].bindings > 0,
        "the park round trip must not lose the bindings"
    );

    // The aliasing rule: park it again, let another slot take the name,
    // then re-slot — the restored preset is renamed to the served fresh
    // name, bindings intact.
    post_form(addr, "/redesign/controller/park", "number=1&ghost=g2");
    post_form(
        addr,
        "/redesign/controller",
        "persona=playstation&preset=Player+1&layout=keyboard-2p",
    );
    let response = post_form(
        addr,
        "/redesign/controller/assign",
        "ghost=g2&position=2&persona=xbox360&preset=Player+9&layout=",
    );
    assert!(
        response.contains("flash=Draft%20updated."),
        "got: {response}"
    );
    let after = control.staged();
    assert_eq!(after.slots.len(), 2);
    assert_eq!(after.slots[1].number, 2, "seated at the asked position");
    assert_eq!(after.slots[1].persona, "xbox360");
    assert_ne!(
        after.slots[1].preset, "Player 1",
        "two slots must never share a preset file name"
    );
    assert!(after.slots[1].bindings > 0, "renamed, not stripped");

    // A ghost the store no longer holds stages FRESH from the form's facts.
    let response = post_form(
        addr,
        "/redesign/controller/assign",
        "ghost=never-parked&position=1&persona=playstation&preset=Fresh+One&layout=keyboard-2p",
    );
    assert!(
        response.contains("flash=Draft%20updated."),
        "got: {response}"
    );
    let fresh = control.staged();
    assert_eq!(fresh.slots.len(), 3);
    assert_eq!(
        fresh.slots[0].preset, "Fresh One",
        "fresh-staged at position 1"
    );
    assert!(fresh.slots[0].bindings > 0, "dressed by the posted layout");
}

/// The inspector's re-homed controller verbs edit the selected slot end to
/// end — SOCD, press behaviour, auto-fire, one-control clear, unbind-all,
/// duplicate — and ✕ remove offers the server-held undo that restores the
/// bindings. Every outcome sentence rides this page's redirect (the shared
/// domain claim, proven per verb).
#[test]
fn the_inspector_verbs_edit_the_selected_slot_end_to_end() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control.clone());
    let response = post_form(
        addr,
        "/redesign/controller",
        "persona=xbox360&preset=Player+1&layout=keyboard-2p",
    );
    assert!(response.contains("flash=Draft%20updated."), "{response}");

    // The layout bound real controls — pick one from the staged mapper, the
    // SAME table the panel's rows are composed from.
    let staged = control.staged();
    let slot = staged.slots.first().expect("one staged slot").clone();
    let mapper = ksx_api::staged_mapper_slot(&slot, "(none)").expect("mapper");
    let (function, keys) = mapper
        .bindings
        .iter()
        .find(|(_, keys)| !keys.is_empty())
        .map(|(f, k)| (f.clone(), k.clone()))
        .expect("the layout bound at least one control");
    assert!(!keys.is_empty());

    // Press behaviour: Toggle latches, with the product's stable sentence.
    let response = post_form(
        addr,
        "/redesign/bind/toggle",
        &format!("slot=1&function={function}&mode=toggle"),
    );
    assert!(
        response.contains("/redesign?flash=Press%20behaviour%20updated."),
        "{response}"
    );
    let latched = ksx_api::staged_mapper_slot(&control.staged().slots[0], "(none)")
        .expect("mapper")
        .toggle
        .iter()
        .any(|f| f.eq_ignore_ascii_case(&function));
    assert!(latched, "the latch took on {function}");

    // Auto-fire: a rate lands; a blank box refuses without a silent clear.
    let response = post_form(
        addr,
        "/redesign/bind/turbo",
        &format!("slot=1&function={function}&turbo_hz=12"),
    );
    assert!(response.contains("flash=Auto-fire%20updated"), "{response}");
    let response = post_form(
        addr,
        "/redesign/bind/turbo",
        &format!("slot=1&function={function}&turbo_hz="),
    );
    assert!(
        response.contains("flash=error%3A%20Type%20a%20number"),
        "{response}"
    );

    // The opposite-directions rule, off the served roster.
    let response = post_form(
        addr,
        "/redesign/controller/socd",
        "number=1&socd=last-input",
    );
    assert!(response.contains("flash=Draft%20updated."), "{response}");
    assert_eq!(control.staged().slots[0].socd, "last-input");

    // Duplicate: same persona and rules in the next free slot, its OWN
    // preset name (one preset file per name — the aliasing rule).
    let response = post_form(addr, "/redesign/controller/duplicate", "number=1");
    assert!(
        response.contains("flash=Controller%20duplicated"),
        "{response}"
    );
    let staged = control.staged();
    assert_eq!(staged.slots.len(), 2);
    assert_eq!(staged.slots[1].persona, staged.slots[0].persona);
    assert_ne!(staged.slots[1].preset, staged.slots[0].preset);
    assert_eq!(staged.slots[1].socd, "last-input", "the rule copied");
    assert!(staged.slots[1].bindings > 0, "the bindings copied");

    // One control back to unbound, from the row's own ✕ twin.
    let response = post_form(
        addr,
        "/redesign/bind/clear",
        &format!("slot=1&function={function}"),
    );
    assert!(response.contains("flash=Draft%20updated."), "{response}");
    let cleared = ksx_api::staged_mapper_slot(&control.staged().slots[0], "(none)")
        .expect("mapper")
        .bindings
        .iter()
        .find(|(f, _)| f.eq_ignore_ascii_case(&function))
        .map(|(_, keys)| keys.clone())
        .unwrap_or_default();
    assert!(cleared.is_empty(), "{function} is unbound, got {cleared:?}");

    // Unbind-all empties the whole slot in one write.
    let response = post_form(addr, "/redesign/bind/clear-all", "number=1");
    assert!(
        response.contains("flash=Every%20key%20unbound"),
        "{response}"
    );
    assert_eq!(control.staged().slots[0].bindings, 0);

    // ✕ remove offers the server-held undo; the payload serves the chip and
    // the restore brings the duplicate's bindings back (appended at the next
    // free number — the compacted workbench re-occupied its old one).
    let response = post_form(addr, "/redesign/controller/remove", "number=2");
    assert!(response.contains("flash=Draft%20updated."), "{response}");
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/redesign"))).expect("payload");
    assert_eq!(api["controllers"]["undo_cls"], "rd-undochip", "{api}");
    assert!(
        api["controllers"]["undo_label"]
            .as_str()
            .unwrap_or_default()
            .contains("removed"),
        "{api}"
    );
    let response = post_form(addr, "/redesign/controller/undo", "");
    assert!(
        response.contains("flash=Controller%20restored%20with%20its%20bindings."),
        "{response}"
    );
    let staged = control.staged();
    assert_eq!(staged.slots.len(), 2, "the removed controller is back");
    assert!(staged.slots[1].bindings > 0, "with its bindings");
    // One shot: the stash was consumed.
    let response = post_form(addr, "/redesign/controller/undo", "");
    assert!(response.contains("no%20longer%20be%20undone"), "{response}");

    // The Keys tab's ✕: one key away from EVERYTHING it drives. The
    // restored duplicate still has bindings — pick one of its keys from the
    // same mapper inversion the By-key rows render, clear it, and the
    // inversion answers without it.
    let slot2 = control.staged().slots[1].clone();
    let mapper = ksx_api::staged_mapper_slot(&slot2, "(none)").expect("mapper");
    let victim = mapper
        .bindings
        .values()
        .flatten()
        .next()
        .cloned()
        .expect("a bound key to clear");
    let response = post_form(
        addr,
        "/redesign/key/clear",
        &format!("number={}&key={victim}", slot2.number),
    );
    assert!(
        response.contains("flash=That%20key%20is%20free%20again"),
        "{response}"
    );
    let after = ksx_api::staged_mapper_slot(&control.staged().slots[1], "(none)").expect("mapper");
    assert!(
        after
            .bindings
            .values()
            .flatten()
            .all(|k| !k.eq_ignore_ascii_case(&victim)),
        "{victim} still drives something"
    );
    // And the second ask is the honest no-op refusal.
    let response = post_form(
        addr,
        "/redesign/key/clear",
        &format!("number={}&key={victim}", slot2.number),
    );
    assert!(
        response.contains("flash=error%3A%20That%20key%20was%20not%20driving%20anything"),
        "{response}"
    );

    // The payload's panel is the shared composer's: the selected slot's
    // groups, pads and BY-KEY rows carry the same truth the verbs edited.
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/redesign?slot=2"))).expect("payload");
    assert_eq!(api["controllers"]["panel"]["slot_val"], "2", "{api}");
    assert!(
        api["controllers"]["pads"]
            .as_array()
            .is_some_and(|pads| pads.len() == 2),
        "{api}"
    );
    assert!(
        api["controllers"]["keys"]["key_rows"]
            .as_array()
            .is_some_and(|rows| !rows.is_empty()),
        "the Keys tab serves the remaining bound keys: {api}"
    );

    // The KEYBOARD widget rides the same payload: the standard plate's rows
    // and the picker roster, from the one shared board composer.
    assert!(
        api["board"]["kb_row1"]
            .as_array()
            .is_some_and(|cells| !cells.is_empty()),
        "the plate's first row serves cells: {api}"
    );
    assert!(
        api["board"]["board_rows"]
            .as_array()
            .is_some_and(|rows| rows.len() >= 2),
        "the picker roster serves at least follow-hardware and qwerty: {api}"
    );

    // The capture behaviour: one staged edit through the shared core, the
    // answer read back from the daemon, and the payload's rows re-marked.
    let response = post_form(addr, "/redesign/blocking", "blocking=whole");
    assert!(
        response.contains("/redesign?flash=Capture%20behaviour%20updated."),
        "{response}"
    );
    assert_eq!(control.staged().blocking.as_deref(), Some("whole"));
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/redesign"))).expect("payload");
    let chosen: Vec<&str> = api["capture_rows"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| row["chosen"] == true)
        .filter_map(|row| row["name"].as_str())
        .collect();
    assert_eq!(chosen, ["whole"], "{api}");
}

/// The mapping wire on the redesign page. The payload serves the SOURCE PIN —
/// the staged input's verified Windows identity, straight from the shared
/// `StartCaptureView` resolution — plus the macro table on the same panel, and
/// the aliased JSON verbs (`/redesign/api/bind`, `/redesign/api/macro/edit`)
/// share one workbench implementation behind the redesign route.
#[test]
fn the_redesign_mapping_wire_serves_the_pin_and_the_aliased_verbs() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control.clone());
    for edit in [
        ksx_api::StageEdit::ChooseDevice {
            selector: "usb:d209:0430:00".into(),
            alias: "panel".into(),
            label: "I-PAC".into(),
        },
        ksx_api::StageEdit::AddSlot {
            number: None,
            persona: "xbox360".into(),
            preset: "Player 1".into(),
            layout: Some("arcade-6button".into()),
        },
    ] {
        assert!(control.stage_edit(&edit).ok);
    }
    let saved: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/api/macro/save",
        "{\"target\":\"stage\",\"slot\":1,\"preset\":\"Player 1\",\"name\":\"combo\",\
         \"steps\":[{\"hold\":[\"A\"],\"ms\":50}]}",
    )))
    .expect("macro save");
    assert_eq!(saved["ok"], true, "{saved}");

    // The pin rides the payload verbatim — the browser never re-derives an
    // identity the capture resolution already decided.
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/redesign"))).expect("payload");
    assert_eq!(api["learn_selector"], "usb:d209:0430:00", "{api}");
    assert_eq!(api["learn_instance"], IPAC_KB, "{api}");

    // The macro table is composed on the same panel the inspector reads:
    // rows for the slot, and per-pad availability for the flow layer.
    let rows = api["controllers"]["macro_rows"]
        .as_array()
        .expect("macro rows");
    assert!(!rows.is_empty(), "{api}");
    assert!(
        rows[0]["edit_href"]
            .as_str()
            .is_some_and(|href| href.starts_with("/redesign?")),
        "the edit door stays on THIS page: {api}"
    );

    // The bind alias is the shared handler: a real staged write, target
    // revision checked, the stage mutated.
    let staged = control.staged();
    let slot = staged.slots.first().expect("one staged slot").clone();
    let mapper = ksx_api::staged_mapper_slot(&slot, "(none)").expect("mapper");
    let function = mapper
        .bindings
        .iter()
        .find(|(_, keys)| !keys.is_empty())
        .map(|(f, _)| f.clone())
        .expect("the layout bound at least one control");
    let bound: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/redesign/api/bind",
        &redesign_bind_body(&control, 1, &function, "P", None, false),
    )))
    .expect("bind outcome");
    assert_eq!(bound["ok"], true, "{bound}");

    // …and a STALE revision is refused at this door (the target pin is the
    // server's law, not the page's).
    let stale: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/redesign/api/bind",
        &redesign_bind_body_with_revision(1, "not-the-revision", &function, "O", None, false),
    )))
    .expect("stale outcome");
    assert_eq!(stale["ok"], false, "{stale}");

    // The macro edit alias: composing the editor through ?macro= (the row's
    // own door) and applying ONE act through the aliased handler answers with
    // the same composed workbench view the client consumes.
    let name = rows[0]["name"].as_str().expect("macro name").to_owned();
    let opened: serde_json::Value = serde_json::from_str(body_of(&get(
        addr,
        &format!("/api/redesign?slot=1&macro={name}"),
    )))
    .expect("payload with editor");
    let draft = opened["controllers"]["mac"]["table"].clone();
    assert!(
        !draft.is_null(),
        "the ?macro= door composes the editor: {opened}"
    );
    let edited: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/redesign/api/macro/edit",
        &format!("{{\"slot\":1,\"act\":\"cell|0|diag:dpad:dr\",\"draft\":{draft}}}"),
    )))
    .expect("edit");
    assert_eq!(edited["ok"], true, "{edited}");
    assert_eq!(
        edited["draft"]["steps"][0]["hold"],
        serde_json::json!(["A", "dpad.down", "dpad.right"]),
        "the diagonal pick JOINS the step's existing hold: {edited}"
    );
    // …and the recomposed roll wears this page's doors.
    assert!(
        edited["view"]["close_href"]
            .as_str()
            .is_some_and(|href| href.starts_with("/redesign")),
        "{edited}"
    );

    // The lifecycle forms ride this page's redirect with the shared domain
    // sentences (the shared verb cores, proven per verb).
    let response = post_form(addr, "/redesign/macro/new", "slot=1&name=combo2");
    assert!(
        response.contains("/redesign?")
            && response.contains("Macro%20created%20with%20one%20empty%20step"),
        "{response}"
    );
    let response = post_form(
        addr,
        "/redesign/macro/toggle",
        "slot=1&name=combo2&enable=false",
    );
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(response.contains("/redesign?"), "{response}");
    let response = post_form(addr, "/redesign/macro/delete", "slot=1&name=combo2");
    assert!(
        response.contains("/redesign?")
            && response.contains("Macro%20removed%20from%20this%20draft"),
        "{response}"
    );
    let staged = control.staged();
    let slot = staged.slots.first().expect("still staged").clone();
    assert!(
        ksx_api::staged_macro_snapshot(&slot)
            .macros
            .iter()
            .all(|m| m.name != "combo2"),
        "the deleted macro is gone from the stage"
    );
}

/// The cutover-critical lifecycle is one operational contract and the same
/// daemon lifecycle verbs: state is served before the click,
/// every form comes home to `/redesign`, Apply keeps its structured
/// needs-restart answer, and a full Play/Apply/Stop/Discard/Adopt loop changes
/// the authoritative providers rather than browser state.
#[test]
fn the_redesign_operational_shell_serves_truth_and_runs_the_shared_lifecycle() {
    let control = Arc::new(ScriptedControl::new(false));
    let machine = Arc::new(ScriptedMachine::default());
    // Ordinary Windows-input state: the exact I-PAC is present and can type.
    machine.winusb_claimed.store(false, Ordering::SeqCst);
    for edit in [
        ksx_api::StageEdit::ChooseDevice {
            selector: "usb:d209:0430:00".into(),
            alias: "panel".into(),
            label: "I-PAC".into(),
        },
        ksx_api::StageEdit::AddSlot {
            number: None,
            persona: "xbox360".into(),
            preset: "Player 1".into(),
            layout: Some("arcade-6button".into()),
        },
        ksx_api::StageEdit::SetBlocking {
            blocking: "whole".into(),
        },
    ] {
        assert!(control.stage_edit(&edit).ok);
    }
    control.dirty.store(true, Ordering::SeqCst);
    let addr = start_server_with_machine(control.clone(), machine.clone());

    let before: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/redesign"))).expect("payload");
    assert_eq!(before["operations"]["draft_dirty"], true, "{before}");
    assert_eq!(before["operations"]["draft_empty"], false, "{before}");
    assert!(
        before["operations"]["draft_revision"]
            .as_str()
            .is_some_and(|revision| !revision.is_empty()),
        "the daemon-owned draft generation must travel intact: {before}"
    );
    assert_eq!(
        before["operations"]["active_stage_revision"], "",
        "there is no active session, so the page must not invent a synchronized revision"
    );
    assert_eq!(
        before["operations"]["saved_label"], "Saved configuration",
        "{before}"
    );
    assert_eq!(
        before["operations"]["session"]["reachable"], true,
        "{before}"
    );
    assert_eq!(
        before["operations"]["session"]["running"], false,
        "{before}"
    );
    assert_eq!(before["operations"]["save"]["allowed"], true, "{before}");
    assert_eq!(before["operations"]["play"]["allowed"], true, "{before}");
    assert_eq!(before["operations"]["apply"]["allowed"], false, "{before}");
    assert!(
        before["operations"]["apply"]["reason"]
            .as_str()
            .unwrap_or_default()
            .contains("Nothing is running"),
        "{before}"
    );
    assert_eq!(
        before["journey"]["compact"], "3/4 complete · Ready to play",
        "{before}"
    );
    assert_eq!(before["capture"]["mode"], "prepare-optional", "{before}");

    // Output support is Play's stricter gate only. A missing output must not
    // make a complete draft look unsaveable.
    machine.output_mode.store(1, Ordering::SeqCst);
    let output_blocked: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/redesign"))).expect("blocked output");
    assert_eq!(
        output_blocked["operations"]["save"]["allowed"], true,
        "{output_blocked}"
    );
    assert_eq!(
        output_blocked["operations"]["play"]["allowed"], false,
        "{output_blocked}"
    );
    assert!(
        output_blocked["operations"]["play"]["reason"]
            .as_str()
            .unwrap_or_default()
            .contains("output"),
        "{output_blocked}"
    );
    machine.output_mode.store(0, Ordering::SeqCst);

    // Older/uncertain staged sessions fail closed: dirty is not proof that
    // the running session contains an earlier revision.
    control.running.store(true, Ordering::SeqCst);
    control.session_staged.store(true, Ordering::SeqCst);
    *control.active_stage_revision.lock().unwrap() = None;
    let uncertain: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/redesign"))).expect("uncertain session");
    assert_eq!(
        uncertain["operations"]["apply"]["allowed"], false,
        "{uncertain}"
    );
    assert!(
        uncertain["operations"]["apply"]["reason"]
            .as_str()
            .unwrap_or_default()
            .contains("cannot prove"),
        "{uncertain}"
    );
    control.running.store(false, Ordering::SeqCst);
    control.session_staged.store(false, Ordering::SeqCst);

    let initial_revision = before["operations"]["draft_revision"]
        .as_str()
        .expect("served initial draft revision")
        .to_owned();
    let stale_save = post_form(addr, "/redesign/save", "expected_revision=test-d1-stale");
    assert!(
        stale_save.contains("/redesign?flash=error%3A%20This%20draft%20changed"),
        "{stale_save}"
    );
    assert!(!control.committed.load(Ordering::SeqCst));

    let lifecycle_body = format!("expected_revision={initial_revision}");
    let saved = post_form(addr, "/redesign/save", &lifecycle_body);
    assert!(saved.starts_with("HTTP/1.1 303"), "{saved}");
    assert!(
        saved.contains("location: /redesign?flash=")
            || saved.contains("Location: /redesign?flash="),
        "the shared verb must come home to redesign: {saved}"
    );
    assert!(
        saved.contains("Setup%20saved.%20Play%20was%20not%20started%20or%20changed."),
        "{saved}"
    );
    assert!(control.committed.load(Ordering::SeqCst));

    let stale_play = post_form(addr, "/redesign/play", "expected_revision=test-d1-stale");
    assert!(
        stale_play.contains("/redesign?flash=error%3A%20This%20draft%20changed"),
        "{stale_play}"
    );
    assert!(!control.played.load(Ordering::SeqCst));

    let played = post_form(addr, "/redesign/play", &lifecycle_body);
    assert!(played.starts_with("HTTP/1.1 303"), "{played}");
    assert!(
        played.contains("/redesign?flash=Play%20is%20running%20from%20this%20draft."),
        "{played}"
    );
    assert!(control.played.load(Ordering::SeqCst));
    assert!(control.running.load(Ordering::SeqCst));

    // One post-Play draft edit advances the whole-draft token. Dirty alone
    // is not Apply authority; this exact revision difference is.
    assert!(
        control
            .stage_edit(&ksx_api::StageEdit::SetBlocking {
                blocking: "bound-keys".into(),
            })
            .ok
    );
    control.dirty.store(true, Ordering::SeqCst);

    let running: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/redesign"))).expect("running payload");
    assert_eq!(
        running["operations"]["session"]["running"], true,
        "{running}"
    );
    assert_ne!(
        running["operations"]["draft_revision"], running["operations"]["active_stage_revision"],
        "Apply must be licensed by an authoritative revision difference: {running}"
    );
    assert_eq!(
        running["operations"]["play"]["label"], "Restart Play",
        "{running}"
    );
    assert_eq!(running["operations"]["play"]["visible"], false, "{running}");
    assert_eq!(running["operations"]["stop"]["visible"], true, "{running}");
    assert_eq!(running["operations"]["stop"]["allowed"], true, "{running}");
    assert_eq!(running["operations"]["apply"]["visible"], true, "{running}");
    assert_eq!(running["operations"]["apply"]["allowed"], true, "{running}");
    assert_eq!(
        running["journey"]["compact"], "4/4 complete · Playing",
        "{running}"
    );
    let running_revision = running["operations"]["draft_revision"]
        .as_str()
        .expect("served running draft revision")
        .to_owned();

    // Save is deliberately allowed while Play is running. Its feedback must
    // describe that boundary without claiming this click did not start Play:
    // it writes the setup and leaves the live session exactly as it was.
    let active_before_save = control.active_stage_revision.lock().unwrap().clone();
    let saved_while_playing = post_form(
        addr,
        "/redesign/save",
        &format!("expected_revision={running_revision}"),
    );
    assert!(
        saved_while_playing.contains("Setup%20saved.%20Play%20was%20not%20started%20or%20changed."),
        "{saved_while_playing}"
    );
    assert!(
        control.running.load(Ordering::SeqCst),
        "Save must leave the running session alone"
    );
    assert_eq!(
        *control.active_stage_revision.lock().unwrap(),
        active_before_save,
        "Save must not move the live session to a different draft revision"
    );

    // Structured Apply preserves the stable code. No flash parsing is needed
    // before the client offers the expanded Replace session action.
    control.apply_needs_restart.store(true, Ordering::SeqCst);
    let stale_apply: serde_json::Value = serde_json::from_str(body_of(&post_form(
        addr,
        "/redesign/api/apply",
        "expected_revision=test-d1-stale",
    )))
    .expect("stale structured apply");
    assert_eq!(stale_apply["done"], false, "{stale_apply}");
    assert_eq!(stale_apply["code"], "stale-draft", "{stale_apply}");

    let apply_body = format!("expected_revision={running_revision}");
    let restart: serde_json::Value = serde_json::from_str(body_of(&post_form(
        addr,
        "/redesign/api/apply",
        &apply_body,
    )))
    .expect("structured apply");
    assert_eq!(restart["done"], false, "{restart}");
    assert_eq!(restart["code"], "needs-restart", "{restart}");

    control.apply_needs_restart.store(false, Ordering::SeqCst);
    let stale_form_apply = post_form(addr, "/redesign/apply", "expected_revision=test-d1-stale");
    assert!(
        stale_form_apply.contains("/redesign?flash=error%3A%20This%20draft%20changed"),
        "{stale_form_apply}"
    );
    let applied = post_form(addr, "/redesign/apply", &apply_body);
    assert!(
        applied.contains("/redesign?flash=Play%20updated%20in%20place."),
        "{applied}"
    );
    assert!(
        control.dirty.load(Ordering::SeqCst),
        "Apply updates the live session but never saves the draft"
    );
    let synced: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/redesign"))).expect("synced payload");
    assert_eq!(
        synced["operations"]["draft_revision"], synced["operations"]["active_stage_revision"],
        "{synced}"
    );
    assert_eq!(
        synced["operations"]["apply"]["allowed"], false,
        "an exact live match needs no Apply: {synced}"
    );
    assert_eq!(
        synced["operations"]["apply"]["visible"], false,
        "Apply visibility is authoritative live divergence, never saved-file dirty state: {synced}"
    );

    let stopped = post_form(addr, "/redesign/stop", "");
    assert!(
        stopped.contains(
            "/redesign?flash=Play%20stopped.%20Virtual%20controllers%20were%20disconnected."
        ),
        "{stopped}"
    );
    assert!(!control.running.load(Ordering::SeqCst));

    let discard_revision = synced["operations"]["draft_revision"]
        .as_str()
        .expect("served whole-draft revision");
    let discarded = post_form(
        addr,
        "/redesign/discard",
        &format!("confirm_discard=yes&expected_revision={discard_revision}"),
    );
    assert!(
        discarded.contains("/redesign?flash=Draft%20discarded"),
        "{discarded}"
    );
    assert!(control.staged().empty);
    let empty: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/redesign"))).expect("empty payload");
    assert_eq!(empty["operations"]["adopt"]["allowed"], true, "{empty}");

    let adopted = post_form(addr, "/redesign/adopt", "");
    assert!(
        adopted.contains("/redesign?flash=Saved%20setup%20loaded%20into%20this%20draft"),
        "{adopted}"
    );
    assert!(!control.staged().empty);
    assert!(
        !control.running.load(Ordering::SeqCst),
        "Adopt is load-only"
    );
}

/// Adopt and Discard edit only the draft even when a staged Play session is
/// still live. Their completion copy must not imply that no session exists,
/// and the handlers must leave both live authority and saved files alone.
#[test]
fn redesign_adopt_and_discard_leave_a_running_play_session_unchanged() {
    let control = Arc::new(ScriptedControl::new(false));
    for edit in [
        ksx_api::StageEdit::ChooseDevice {
            selector: "usb:d209:0430:00".into(),
            alias: "panel".into(),
            label: "I-PAC".into(),
        },
        ksx_api::StageEdit::AddSlot {
            number: None,
            persona: "xbox360".into(),
            preset: "Player 1".into(),
            layout: Some("arcade-6button".into()),
        },
        ksx_api::StageEdit::SetBlocking {
            blocking: "whole".into(),
        },
    ] {
        assert!(control.stage_edit(&edit).ok);
    }
    assert!(control.stage_play().ok, "fixture Play must start");
    let live_revision = control.active_stage_revision.lock().unwrap().clone();
    assert!(
        control.stage_edit(&ksx_api::StageEdit::Discard).ok,
        "fixture must clear only the draft before Adopt"
    );
    assert!(control.staged().empty);
    assert!(control.running.load(Ordering::SeqCst));
    let addr = start_server(control.clone());

    let adopted = post_form(addr, "/redesign/adopt", "");
    assert!(
        adopted.contains(
            "/redesign?flash=Saved%20setup%20loaded%20into%20this%20draft.%20Saved%20files%20and%20any%20running%20Play%20session%20were%20not%20changed."
        ),
        "{adopted}"
    );
    assert!(!control.staged().empty, "Adopt must populate the draft");
    assert!(
        control.running.load(Ordering::SeqCst),
        "Adopt must not stop Play"
    );
    assert_eq!(
        *control.active_stage_revision.lock().unwrap(),
        live_revision,
        "Adopt must not replace the running draft revision"
    );
    assert!(
        !control.committed.load(Ordering::SeqCst),
        "Adopt must not write saved files"
    );

    let discarded = post_form(addr, "/redesign/discard", "");
    assert!(
        discarded.contains(
            "/redesign?flash=Draft%20discarded.%20Saved%20files%20and%20any%20running%20Play%20session%20were%20not%20changed."
        ),
        "{discarded}"
    );
    assert!(control.staged().empty, "Discard must clear the draft");
    assert!(
        control.running.load(Ordering::SeqCst),
        "Discard must not stop Play"
    );
    assert_eq!(
        *control.active_stage_revision.lock().unwrap(),
        live_revision,
        "Discard must not replace the running draft revision"
    );
    assert!(
        !control.committed.load(Ordering::SeqCst),
        "Discard must not write saved files"
    );
}

/// A held WinUSB keyboard has a way back even with no staged setup. Both
/// release and prepare aliases retain the legacy core's exact-instance,
/// consent and post-mutation stage guards while returning to this surface.
#[test]
fn the_redesign_capture_shell_recovers_held_devices_and_preserves_exact_identity() {
    let control = Arc::new(ScriptedControl::new(false));
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(control.clone(), machine.clone());

    let held: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/redesign"))).expect("held payload");
    assert_eq!(held["capture"]["mode"], "release-held", "{held}");
    assert_eq!(held["capture"]["can_release"], true, "{held}");
    assert_eq!(held["capture"]["selector"], "usb:d209:0430:00", "{held}");
    assert_eq!(held["capture"]["instance"], IPAC_KB, "{held}");
    let held_rows = held["capture"]["held"].as_array().expect("held rows");
    assert_eq!(held_rows.len(), 1, "{held}");
    assert_eq!(held_rows[0]["can_release"], true, "{held}");

    let released = post_form(addr, "/redesign/capture/release", RELEASE_IPAC_FORM);
    assert!(released.starts_with("HTTP/1.1 303"), "{released}");
    assert!(
        released.contains("/redesign?flash=Keyboard%20released"),
        "{released}"
    );
    assert_eq!(machine.released_with.lock().unwrap().len(), 1);
    assert!(!machine.winusb_claimed.load(Ordering::SeqCst));

    assert!(
        control
            .stage_edit(&ksx_api::StageEdit::ChooseDevice {
                selector: "usb:d209:0430:00".into(),
                alias: "panel".into(),
                label: "I-PAC".into(),
            })
            .ok
    );
    let ready: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/redesign"))).expect("ready payload");
    assert_eq!(ready["capture"]["mode"], "prepare-optional", "{ready}");
    assert_eq!(ready["capture"]["can_prepare"], true, "{ready}");

    let prepared = post_form(addr, "/redesign/capture/prepare", PREPARE_IPAC_FORM);
    assert!(prepared.starts_with("HTTP/1.1 303"), "{prepared}");
    assert!(
        prepared.contains("/redesign?flash=Keyboard%20prepared"),
        "{prepared}"
    );
    assert_eq!(machine.prepared_with.lock().unwrap().len(), 1);
    assert_eq!(
        control
            .staged()
            .device
            .as_ref()
            .map(|device| device.backend.as_str()),
        Some("winusb"),
        "only an authoritative exact prepared result changes the stage backend"
    );
    let prepared_state: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/redesign"))).expect("prepared payload");
    assert_eq!(
        prepared_state["capture"]["mode"], "release",
        "{prepared_state}"
    );

    // A stale interface cannot be retargeted by the browser, and the
    // privileged provider is not called a second time.
    let stale = post_form(
        addr,
        "/redesign/capture/release",
        "expected_selector=usb%3Ad209%3A0430%3A00&instance_id=STALE&confirm_release=yes",
    );
    assert!(
        stale.contains("/redesign?flash=error%3A%20The%20selected%20keyboard%20changed"),
        "{stale}"
    );
    assert_eq!(machine.released_with.lock().unwrap().len(), 1);

    *machine.release_state.lock().unwrap() = Some("recovery-required".to_owned());
    let recovery = post_form(addr, "/redesign/capture/release", RELEASE_IPAC_FORM);
    assert!(
        recovery.contains("/redesign?flash=error%3A%20Windows%20could%20not%20finish%20releasing"),
        "the safe recovery sentence must come home to this page: {recovery}"
    );
    assert_eq!(machine.released_with.lock().unwrap().len(), 2);
    for internal in ["generated.inf", "--repair", "helper"] {
        assert!(!recovery.contains(internal), "{internal}: {recovery}");
    }
}

/// The redesign's fail-closed exact-input promise is mutation authority, not
/// decoration on a disabled button. A refused or incomplete live scan cannot
/// be bypassed with a direct Save/Play POST, while the shared domain cores
/// remain the only writers once capture is proven.
#[test]
fn the_redesign_save_and_play_refuse_unverified_capture_at_the_server_door() {
    for (case, machine) in [
        ("refused scan", ScriptedMachine::refusing()),
        ("incomplete scan", ScriptedMachine::blind()),
    ] {
        let control = Arc::new(ScriptedControl::new(false));
        for edit in [
            ksx_api::StageEdit::ChooseDevice {
                selector: "usb:d209:0430:00".into(),
                alias: "panel".into(),
                label: "I-PAC".into(),
            },
            ksx_api::StageEdit::AddSlot {
                number: None,
                persona: "xbox360".into(),
                preset: "Player 1".into(),
                layout: Some("arcade-6button".into()),
            },
            ksx_api::StageEdit::SetBlocking {
                blocking: "whole".into(),
            },
        ] {
            assert!(control.stage_edit(&edit).ok, "{case}");
        }
        let addr = start_server_with_machine(control.clone(), Arc::new(machine));
        let payload: serde_json::Value =
            serde_json::from_str(body_of(&get(addr, "/api/redesign"))).expect("payload");
        assert_eq!(
            payload["operations"]["save"]["allowed"], false,
            "{case}: {payload}"
        );
        assert_eq!(
            payload["operations"]["play"]["allowed"], false,
            "{case}: {payload}"
        );
        let revision = payload["operations"]["draft_revision"]
            .as_str()
            .expect("served revision");
        let body = format!("expected_revision={revision}");

        let save = post_form(addr, "/redesign/save", &body);
        assert!(
            save.contains("/redesign?flash=error%3A%20This%20setup%20is%20not%20ready"),
            "{case}: {save}"
        );
        assert!(
            !control.committed.load(Ordering::SeqCst),
            "{case}: Save reached the writer"
        );

        let play = post_form(addr, "/redesign/play", &body);
        assert!(
            play.contains("/redesign?flash=error%3A%20This%20setup%20is%20not%20ready"),
            "{case}: {play}"
        );
        assert!(
            !control.played.load(Ordering::SeqCst),
            "{case}: Play reached the session writer"
        );
    }
}

/// Independent failures stay independent: a readable config/device inventory
/// cannot make a dead staging/session channel look empty or idle, and every
/// disabled lifecycle action carries a customer-facing reason.
#[test]
fn the_redesign_operational_payload_fails_closed_when_the_daemon_is_down() {
    let addr = start_server(Arc::new(ScriptedControl::dead()));
    let value: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/redesign"))).expect("payload");
    assert_eq!(
        value["operations"]["draft_label"], "Draft unavailable",
        "{value}"
    );
    assert_eq!(
        value["operations"]["session"]["reachable"], false,
        "{value}"
    );
    assert_eq!(
        value["journey"]["compact"], "Progress unavailable",
        "{value}"
    );
    for action in ["save", "play", "apply", "stop", "adopt", "discard"] {
        assert_eq!(
            value["operations"][action]["allowed"], false,
            "{action}: {value}"
        );
        assert!(
            value["operations"][action]["reason"]
                .as_str()
                .is_some_and(|reason| !reason.trim().is_empty()),
            "{action}: {value}"
        );
    }
    let save = post_form(addr, "/redesign/save", "");
    assert!(save.starts_with("HTTP/1.1 303"), "{save}");
    assert!(save.contains("/redesign?flash=error%3A"), "{save}");
    for raw in ["daemon", "pipe", "control%20channel"] {
        assert!(!save.contains(raw), "raw provider text {raw:?}: {save}");
    }
}

/// Progress cannot turn green because one player is mapped while another
/// would plug dead. This is the redesign correction to the legacy rail's
/// `any(slot has bindings)` test.
#[test]
fn the_redesign_progress_requires_live_bindings_on_every_controller() {
    let control = Arc::new(ScriptedControl::new(false));
    let machine = Arc::new(ScriptedMachine::default());
    machine.winusb_claimed.store(false, Ordering::SeqCst);
    for edit in [
        ksx_api::StageEdit::ChooseDevice {
            selector: "usb:d209:0430:00".into(),
            alias: "panel".into(),
            label: "I-PAC".into(),
        },
        ksx_api::StageEdit::AddSlot {
            number: None,
            persona: "xbox360".into(),
            preset: "Player 1".into(),
            layout: Some("arcade-6button".into()),
        },
        ksx_api::StageEdit::AddSlot {
            number: None,
            persona: "playstation".into(),
            preset: "Player 2".into(),
            layout: None,
        },
        ksx_api::StageEdit::SetBlocking {
            blocking: "whole".into(),
        },
    ] {
        assert!(control.stage_edit(&edit).ok);
    }
    let staged = control.staged();
    assert!(staged.slots[0].bindings > 0);
    assert_eq!(staged.slots[1].bindings, 0);
    let addr = start_server_with_machine(control, machine);
    let value: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/redesign"))).expect("payload");
    let mapping = value["journey"]["rows"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["key"] == "mapping"))
        .expect("mapping step");
    assert_eq!(mapping["badge"], "Now", "{value}");
    assert_eq!(value["operations"]["save"]["allowed"], false, "{value}");
    assert_eq!(value["operations"]["play"]["allowed"], false, "{value}");
}

/// Required checkboxes are progressive enhancement, not authority. A direct
/// POST cannot discard a dirty redesign draft without the served consent;
/// clean drafts retain the deliberate one-click Start-over path.
#[test]
fn the_redesign_discard_route_guards_dirty_work_server_side() {
    let control = Arc::new(ScriptedControl::new(false));
    assert!(
        control
            .stage_edit(&ksx_api::StageEdit::ChooseDevice {
                selector: "usb:d209:0430:00".into(),
                alias: "panel".into(),
                label: "I-PAC".into(),
            })
            .ok
    );
    control.dirty.store(true, Ordering::SeqCst);
    let addr = start_server(control.clone());

    let refused = post_form(addr, "/redesign/discard", "");
    assert!(
        refused.contains("/redesign?flash=error%3A%20Confirm%20Start%20over"),
        "{refused}"
    );
    assert!(!control.staged().empty, "missing consent changed the draft");

    let revision = control.staged().revision;
    let missing_revision = post_form(addr, "/redesign/discard", "confirm_discard=yes");
    assert!(
        missing_revision.contains("/redesign?flash=error%3A%20This%20draft%20changed"),
        "{missing_revision}"
    );
    assert!(
        !control.staged().empty,
        "a generic confirmation discarded a draft it did not identify"
    );

    let stale = post_form(
        addr,
        "/redesign/discard",
        "confirm_discard=yes&expected_revision=test-d1-stale",
    );
    assert!(
        stale.contains("/redesign?flash=error%3A%20This%20draft%20changed"),
        "{stale}"
    );
    assert!(
        !control.staged().empty,
        "a stale confirmation changed the draft"
    );

    let confirmed = post_form(
        addr,
        "/redesign/discard",
        &format!("confirm_discard=yes&expected_revision={revision}"),
    );
    assert!(
        confirmed.contains("/redesign?flash=Draft%20discarded"),
        "{confirmed}"
    );
    assert!(control.staged().empty);

    // Clean content remains one click, as the expanded setup panel promises.
    assert!(control.stage_adopt(None).ok);
    control.dirty.store(false, Ordering::SeqCst);
    let clean = post_form(addr, "/redesign/discard", "");
    assert!(
        clean.contains("/redesign?flash=Draft%20discarded"),
        "{clean}"
    );
    assert!(control.staged().empty);
}

// ---------------------------------------------------------------------------
// /pads — the ViGEm bus, a bounded pad test, and the prune (v15)
// ---------------------------------------------------------------------------

/// The page renders from ONE `MachineSource::pads_view` call, with no
/// JavaScript involved: the pads, the bus devnode, the ceiling sentence and
/// the spawn form are all in the first paint.
#[test]
fn the_pads_page_renders_the_bus_server_side() {
    let control = Arc::new(ScriptedControl::new(true));
    let addr = start_server(control);
    let response = get(addr, "/pads");
    let body = body_of(&response);

    assert!(body.contains("2 virtual pads on the ViGEm bus"), "{body}");
    assert!(body.contains(r"USB\TEST\PAD1"), "{body}");
    assert!(body.contains(r"USB\TEST\PAD2"), "{body}");
    assert!(body.contains(r"ROOT\SYSTEM\0002"), "{body}");
    assert!(body.contains("ksx.exe (pid 1)"), "{body}");
    // The no-JS baseline: real forms, not fetch handlers.
    assert!(body.contains(r#"action="/pads/spawn""#), "{body}");
}

/// **Task #16 reaches the user before the click, not after it.**
///
/// Two independent channels, both server-rendered so a browser with scripting
/// switched off gets them: the standing ceiling paragraph, and the label on
/// the `<option>` that would cause it. Both strings are the PROVIDER's — this
/// asserts they survive the route and the render, which is the only part
/// Studio owns.
#[test]
fn the_pads_page_warns_about_the_xinput_ceiling_before_the_button_is_pressed() {
    let control = Arc::new(ScriptedControl::new(true));
    let addr = start_server(control);
    let response = get(addr, "/pads");
    let body = body_of(&response);

    assert!(
        body.contains("Windows exposes exactly 4 XInput slots"),
        "the ceiling paragraph must render: {body}"
    );
    assert!(
        body.contains(OVER_CEILING_LABEL),
        "the over-ceiling count must warn in its own option label: {body}"
    );
    // The warning has to name the persona it applies to. A persona-blind "4
    // invisible to games" contradicts the persona `<select>` beside it, the
    // card paragraph above it and the post-submit flash — three sentences on
    // one screen disagreeing about one click.
    assert!(
        body.contains("as xbox360") && body.contains("as playstation"),
        "the count warning must say which persona it applies to: {body}"
    );
}

/// **One session read feeds the whole render.**
///
/// Fails against the version this replaced, where `collect_pads` called
/// `control.session()` and then `pads_view()` dialled the daemon pipe a second
/// time on its own. Two round-trips are two points in time: a session starting
/// between them painted an "idle" header pill beside a spawn panel refused
/// because a session was running — or, worse, the reverse, offering a Spawn
/// button the verb would refuse. Here the fixture ECHOES what it was told, so
/// the two halves of the page can only agree if one read produced both.
#[test]
fn the_page_reads_the_session_once_and_both_halves_agree() {
    for running in [false, true] {
        let control = Arc::new(ScriptedControl::new(true));
        control.running.store(running, Ordering::SeqCst);
        let addr = start_server(control);
        let response = get(addr, "/pads");
        let body = body_of(&response);

        let value: serde_json::Value =
            serde_json::from_str(body_of(&get(addr, "/api/pads"))).expect("json");
        assert_eq!(
            value["pads"]["session_running"],
            serde_json::json!(running),
            "the machine view must have been told what the control read said"
        );
        assert_eq!(value["session"]["running"], serde_json::json!(running));

        if running {
            // The panel is refused AND the pill says running — one answer.
            assert!(body.contains("a session is running"), "{body}");
            assert!(
                !body.contains(r#"action="/pads/spawn""#),
                "a running session must not be offered a Spawn button: {body}"
            );
        } else {
            assert!(body.contains(r#"action="/pads/spawn""#), "{body}");
        }
    }
}

/// **A refused read is not an empty bus.**
///
/// The default `MachineSource` refuses every verb in words, which is what a
/// surface with no provider wired sees. Fails against the version this
/// replaced, which rendered a `PadsView::default()` through the same seam: the
/// devnode line asserted "ViGEmBus is not installed", four ghost tiles drew an
/// empty four-slot cabinet, and the prune panel said there was nothing to do —
/// three claims about a machine ksx had never managed to look at, under a
/// banner saying the read had failed.
#[test]
fn a_provider_that_cannot_answer_says_so_instead_of_showing_a_clean_bus() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server_with(control, Box::new(UnreadableMachine));
    let response = get(addr, "/pads");
    let body = body_of(&response);

    assert!(
        response.starts_with("HTTP/1.1 200"),
        "never a 500: {response}"
    );
    assert!(
        body.contains("ksx could not read the ViGEm bus"),
        "the banner must say the read failed: {body}"
    );
    for absence in [
        "not installed",
        ">empty<",
        "Nothing for this panel to do",
        "no virtual pads on the ViGEm bus",
    ] {
        assert!(
            !body.contains(absence),
            "a failed read rendered '{absence}', a claim about a machine never read: {body}"
        );
    }
    // …and neither verb is offered, because neither can be described.
    assert!(!body.contains(r#"action="/pads/spawn""#), "{body}");
    assert!(!body.contains(r#"href="/pads?confirm=1""#), "{body}");
}

/// The spawn form's values reach the verb intact — the echo proves all three.
#[test]
fn spawning_pads_passes_the_whole_spec_through_and_303s_back() {
    let control = Arc::new(ScriptedControl::new(true));
    let addr = start_server(control);

    let response = post_form(addr, "/pads/spawn", "count=8&persona=xbox360&hold_secs=30");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(
        response.contains("/pads?flash=spawned%208%20xbox360%20pad%28s%29%20for%2030s"),
        "the spec must arrive whole: {response}"
    );
}

/// A refusal flashes too, prefixed `error:` so the page colors it — never a
/// silent failure and never an error page dead-ending the no-JS loop.
#[test]
fn a_refused_spawn_flashes_the_refusal() {
    let control = Arc::new(ScriptedControl::new(true));
    let addr = start_server(control);

    let response = post_form(addr, "/pads/spawn", "count=0&persona=xbox360&hold_secs=10");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(
        response.contains("flash=error%3A%20pad%20count%20must%20be"),
        "{response}"
    );
}

/// **The consent shape, end to end.** Unarmed, the document carries no submit
/// that could restart the bus — not hidden, not disabled, ABSENT — because the
/// SSR paint is what a no-JS browser gets and a `display:none` button is one
/// CSS failure away from being pressable. Arming is a GET, and only the armed
/// page names every pad that goes.
#[test]
fn prune_is_absent_until_armed_and_then_names_every_pad() {
    let control = Arc::new(ScriptedControl::new(true));
    let addr = start_server(control);

    let unarmed_response = get(addr, "/pads");
    let unarmed = body_of(&unarmed_response);
    assert!(
        !unarmed.contains(r#"name="confirm" value="yes""#),
        "an unarmed page must not carry the confirmed submit: {unarmed}"
    );
    assert!(unarmed.contains(r#"href="/pads?confirm=1""#), "{unarmed}");

    let armed_response = get(addr, "/pads?confirm=1");
    let armed = body_of(&armed_response);
    assert!(armed.contains(r#"action="/pads/prune""#), "{armed}");
    assert!(armed.contains(r#"name="confirm" value="yes""#), "{armed}");
    assert!(armed.contains("This removes 2 pad(s)"), "{armed}");
    assert!(armed.contains(r"USB\TEST\PAD1"), "{armed}");
    assert!(armed.contains(r"USB\TEST\PAD2"), "{armed}");
    // Elevation is stated before the click, not discovered after the refusal.
    assert!(armed.contains("NOT running elevated"), "{armed}");
    // …and the confirmation does not navigate itself away while it is being
    // read. The no-JS refresh targets "/pads" with no query string, so it
    // would drop `?confirm=1` and drop the reader back to the disarmed view
    // five seconds in — every time, on a list that can be fifteen rows long.
    assert!(
        !armed.contains("http-equiv=\"refresh\""),
        "an armed confirmation must not carry a refresh timer: {armed}"
    );
    assert!(
        unarmed.contains(r#"content="5; url=/pads""#),
        "the unarmed page is a live view and keeps its refresh: {unarmed}"
    );
}

/// `confirm` is what turns a dry run into a bus restart, and a POST that did
/// not come from the confirm screen gets the dry run. Not an error — the CLI
/// answers the same way without `--yes`, and answering "what would happen" is
/// strictly better than answering "no".
#[test]
fn a_prune_without_the_confirm_field_is_a_dry_run() {
    let control = Arc::new(ScriptedControl::new(true));
    let addr = start_server(control);

    let dry = post_form(addr, "/pads/prune", "");
    assert!(dry.starts_with("HTTP/1.1 303"), "{dry}");
    assert!(dry.contains("flash=dry%20run"), "{dry}");

    let confirmed = post_form(addr, "/pads/prune", "confirm=yes");
    assert!(confirmed.starts_with("HTTP/1.1 303"), "{confirmed}");
    assert!(
        confirmed.contains("flash=cleared%202%20virtual%20pad"),
        "{confirmed}"
    );
}

/// Both mutating routes are inside the guarded router. A cross-origin POST is
/// refused by `Origin`, and any request at all is refused by `Host` — the
/// property that has to hold for EVERY new route, and the one a route declared
/// outside the `Router::new()` chain would silently lose.
#[test]
fn the_pads_routes_are_behind_the_guard() {
    let control = Arc::new(ScriptedControl::new(true));
    let addr = start_server(control);

    for path in ["/pads/spawn", "/pads/prune"] {
        let body = "confirm=yes";
        let response = http(
            addr,
            &format!(
                "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
                 Origin: https://evil.example\r\nConnection: close\r\n\
                 Content-Type: application/x-www-form-urlencoded\r\n\
                 Content-Length: {len}\r\n\r\n{body}",
                port = addr.port(),
                len = body.len(),
            ),
        );
        assert!(
            response.starts_with("HTTP/1.1 403"),
            "{path} must refuse a foreign origin: {response}"
        );
        assert_route_is_real(addr, path);
    }
    // …and the rebinding defence covers the read as well.
    let rebound = http(
        addr,
        "GET /pads HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n",
    );
    assert!(rebound.starts_with("HTTP/1.1 421"), "{rebound}");
}

/// The poller's endpoint serves the same struct the page embeds — and never
/// an armed one. A 2 s poll is not a user saying yes, and a poll that could
/// re-arm the prune would make the confirm panel reappear after someone had
/// deliberately navigated away from it.
#[test]
fn the_pads_api_serves_the_payload_and_never_arms_it() {
    let control = Arc::new(ScriptedControl::new(true));
    let addr = start_server(control);

    let response = get(addr, "/api/pads?confirm=1");
    // A pad list that is quietly ten minutes old is worse than one that took
    // 40 ms to fetch (sources.rs's rule); nothing on this page may be cached.
    assert!(response.contains("cache-control: no-store"), "{response}");
    let value: serde_json::Value = serde_json::from_str(body_of(&response)).expect("json");
    assert_eq!(value["confirm"], serde_json::json!(false));
    assert_eq!(value["flash"], serde_json::json!(null));
    assert_eq!(value["pads"]["prune"]["kind"], serde_json::json!("restart"));
    assert_eq!(value["pads"]["pads"].as_array().unwrap().len(), 2);
}

// ---------------------------------------------------------------------------
// /api/live — the live input feed, as Server-Sent Events.
// ---------------------------------------------------------------------------

/// **No daemon is an ANSWER, over real HTTP, and the browser keeps trying.**
///
/// The three things a browser needs from this endpoint when the feed is not
/// there, all in one response: a 200 (an `EventSource` treats any other status
/// as fatal and stops retrying — so a page opened before the daemon started
/// would stay dead until somebody reloaded it by hand), a `text/event-stream`
/// content type, and the refusal itself as an event it can put on screen.
///
/// Catches the shape that returned 503 with a JSON body: perfectly readable in
/// curl, and a permanently dead feed in a browser.
#[test]
fn the_live_feed_answers_without_a_daemon_and_keeps_the_browser_retrying() {
    let addr = start_server(Arc::new(ScriptedControl::new(false)));
    let response = get(addr, "/api/live");

    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(
        response
            .to_ascii_lowercase()
            .contains("content-type: text/event-stream"),
        "{response}"
    );
    assert!(
        response
            .to_ascii_lowercase()
            .contains("cache-control: no-store"),
        "a buffered live feed is worse than none: {response}"
    );

    let body = body_of(&response);
    assert!(
        body.contains("event: unavailable"),
        "the refusal travels as an event: {body}"
    );
    assert!(
        body.contains("retry: "),
        "the SERVER sets the reconnect interval, not each browser: {body}"
    );

    let data = body
        .lines()
        .find_map(|line| line.strip_prefix("data: "))
        .expect("a data line");
    let refusal: Refusal = serde_json::from_str(data).expect("the refusal is JSON");
    assert!(!refusal.message.trim().is_empty(), "{refusal:?}");
    assert!(
        refusal.remedy.is_some(),
        "a refusal owes a way out: {refusal:?}"
    );
}

/// The feed is a READ, and reads are not what `guard.rs` polices — but the Host
/// check covers every route, and a live stream is the one route somebody would
/// be most tempted to exempt "because it is only a stream".
///
/// A rebound host reaching this endpoint would be a page on another origin
/// watching what is typed on this cabinet's panel.
#[test]
fn the_live_feed_is_behind_the_guard_like_every_other_route() {
    let addr = start_server(Arc::new(ScriptedControl::new(false)));
    let response = http(
        addr,
        "GET /api/live HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n",
    );
    assert!(
        response.starts_with("HTTP/1.1 421"),
        "a rebound host must not be able to watch the panel: {response}"
    );
}

// ---------------------------------------------------------------------------
// /check — BUILD C, the button check.
// ---------------------------------------------------------------------------

/// **The page is useful with the daemon down, and honest about which half.**
///
/// The binding table is a disk read, so it is correct whatever the pipe is
/// doing — that half answers "what SHOULD this key do". The echo needs the
/// feed, and the page must not imply it has one it has not opened.
///
/// Catches a paint that rendered the grid with a "live" state: on a machine
/// with no daemon the chips would sit dark under the word "live", which is
/// indistinguishable from a working check on a panel nobody is touching — this
/// project's signature bug, on the one screen built to disprove it.
#[test]
fn the_button_check_renders_its_roster_and_never_claims_a_feed_it_has_not_opened() {
    let addr = start_server(Arc::new(ScriptedControl::new(false)));
    let response = get(addr, "/check");
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");

    let body = body_of(&response);
    // The roster came from the SAME `StatusSource::mapper()` the /map page
    // reads, so the fixture's slot and its bindings are on the page.
    assert!(body.contains("data-control="), "no chips at all: {body}");
    assert!(body.contains("data-slot="), "chips with no slot: {body}");
    // ...and the server paint says it is still connecting, with the explicit
    // show slot for a confirmed live feed false.
    assert!(body.contains("connecting to live input"), "{body}");
    assert!(body.contains(r#""show:live":false"#), "{body}");
}

/// The roster endpoint serves the same shape the page embeds — one struct, one
/// serializer, so the poller cannot disagree with the paint.
#[test]
fn the_check_api_serves_the_roster_and_is_never_cached() {
    let addr = start_server(Arc::new(ScriptedControl::new(true)));
    let response = get(addr, "/api/check");
    assert!(
        response.contains("cache-control: no-store"),
        "a stale roster is a wrong answer about what a key does: {response}"
    );
    let value: serde_json::Value = serde_json::from_str(body_of(&response)).expect("json");
    assert!(value["mapper"].is_object(), "{value}");
    assert!(value["session"].is_object(), "{value}");
    assert!(
        value["feed_hint"].as_str().is_some_and(|s| !s.is_empty()),
        "the hint is composed in Rust and must reach the page: {value}"
    );
    // The frame data is NOT here, and that is the page's shape: the echo
    // arrives on /api/live at display rate. A roster poll carrying a frame
    // would be a button check as fast as an HTTP poll.
    assert!(value.get("frame").is_none(), "{value}");
}

#[test]
fn the_check_distinguishes_unavailable_empty_and_zero_control_rosters_over_http() {
    let unavailable = start_server_with_status(
        Arc::new(ScriptedControl::new(false)),
        Box::new(FixedMapperStatus(MapperSnapshot::unavailable(
            r#"preset read failed at C:\Users\TestUser\.ksx; run `ksx preset list`"#,
        ))),
    );
    let unavailable = rendered_body(&get(unavailable, "/check"));
    assert!(
        unavailable.contains("Mappings could not be checked"),
        "{unavailable}"
    );
    assert!(unavailable.contains("Open ksx Studio"), "{unavailable}");
    assert!(!unavailable.contains("ksx preset list"), "{unavailable}");

    let empty = start_server_with_status(
        Arc::new(ScriptedControl::new(false)),
        Box::new(FixedMapperStatus(MapperSnapshot {
            generated_at: "test".into(),
            source: "saved setup".into(),
            config_root: "test".into(),
            slots: Vec::new(),
            profile: None,
        })),
    );
    let empty = rendered_body(&get(empty, "/check"));
    assert!(empty.contains("No controller is ready to test"), "{empty}");
    // PORTED 2026-08-26: "setup" is not a place any more — the empty state
    // names the one product surface, the same one `emptyHref` points at.
    assert!(empty.contains("Add a controller in ksx Studio"), "{empty}");

    let zero = start_server_with_status(
        Arc::new(ScriptedControl::new(false)),
        Box::new(FixedMapperStatus(MapperSnapshot {
            generated_at: "test".into(),
            source: "saved setup".into(),
            config_root: "test".into(),
            slots: vec![MapperSlot {
                number: 1,
                persona: "xbox360".into(),
                persona_label: "Xbox 360".into(),
                preset: "Player 1".into(),
                keyboard: "panel".into(),
                bindings: Default::default(),
                backup: None,
                session_backup: false,
                turbo: Default::default(),
                toggle: Default::default(),
                macros_off: false,
            }],
            profile: None,
        })),
    );
    let zero = rendered_body(&get(zero, "/check"));
    assert!(zero.contains("No controls are ready to test"), "{zero}");
    assert!(zero.contains(r#"href="/redesign""#), "{zero}");

    assert_ne!(unavailable, empty);
    assert_ne!(empty, zero);
    for body in [&unavailable, &empty, &zero] {
        assert!(!body.contains("No controllers to check"), "{body}");
    }
}

#[test]
fn the_check_keeps_canonical_live_keys_but_shows_controller_labels_over_http() {
    let mapper = MapperSnapshot {
        generated_at: "test".into(),
        source: "saved setup".into(),
        config_root: "test".into(),
        slots: vec![
            MapperSlot {
                number: 1,
                persona: "xbox360".into(),
                persona_label: "Xbox 360".into(),
                preset: "Player 1".into(),
                keyboard: "panel".into(),
                bindings: std::collections::BTreeMap::from([(
                    "dpad.up".to_owned(),
                    vec!["Up".to_owned()],
                )]),
                backup: None,
                session_backup: false,
                turbo: Default::default(),
                toggle: Default::default(),
                macros_off: false,
            },
            MapperSlot {
                number: 2,
                persona: "xbox360".into(),
                persona_label: "Xbox 360".into(),
                preset: "Player 2".into(),
                keyboard: "panel".into(),
                bindings: Default::default(),
                backup: None,
                session_backup: false,
                turbo: Default::default(),
                toggle: Default::default(),
                macros_off: false,
            },
        ],
        profile: None,
    };
    let addr = start_server_with_status(
        Arc::new(ScriptedControl::new(false)),
        Box::new(FixedMapperStatus(mapper)),
    );
    let body = rendered_body(&get(addr, "/check"));
    assert!(body.contains(r#"data-control="dpad.up""#), "{body}");
    assert!(body.contains("D-pad ↑"), "{body}");
    assert!(!body.contains(">dpad.up<"), "{body}");
    assert!(body.contains("Player 2 has no controls yet"), "{body}");
    assert!(body.contains(r#"href="/redesign?slot=2""#), "{body}");
}

/// A rebound host must not be able to read this cabinet's binding table.
#[test]
fn the_check_routes_are_behind_the_guard() {
    let addr = start_server(Arc::new(ScriptedControl::new(false)));
    for path in ["/check", "/api/check"] {
        let response = http(
            addr,
            &format!("GET {path} HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n"),
        );
        assert!(
            response.starts_with("HTTP/1.1 421"),
            "{path} answered a rebound host: {response}"
        );
        assert_route_is_real(addr, path);
    }
}

// ── /start: the first run, walked over HTTP ────────────────────────────────

const PREPARE_IPAC_FORM: &str = "expected_selector=usb%3Ad209%3A0430%3A00&\
instance_id=USB%5CVID_D209%26PID_0430%26MI_00%5C7%261A2B3C4D%260%260000&\
confirm_spare_keyboard=yes&confirm_rebind=yes&confirm_machine_certificate=yes";

const RELEASE_IPAC_FORM: &str = "expected_selector=usb%3Ad209%3A0430%3A00&\
instance_id=USB%5CVID_D209%26PID_0430%26MI_00%5C7%261A2B3C4D%260%260000&\
confirm_release=yes";

#[test]
fn the_service_worker_is_registrable_and_its_precache_resolves() {
    let addr = start_server(Arc::new(ScriptedControl::new(false)));
    let response = get(addr, "/sw.js");
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");

    // A browser refuses to register a worker served as anything but a
    // JavaScript MIME type.
    assert!(
        response.contains("content-type: text/javascript"),
        "a service worker served as the wrong type will not register: {response}"
    );
    // Registration is scoped to the script's own directory unless this widens
    // it; the worker is served from the root, so `/` is what it must claim.
    assert!(response.contains("service-worker-allowed: /"), "{response}");
    // A CACHED service worker is how a cabinet gets stuck on an old build
    // forever — the one file that must never be held.
    assert!(response.contains("no-store"), "{response}");
    assert!(
        response.contains("x-content-type-options: nosniff"),
        "{response}"
    );

    // Everything it precaches must be served, or `addAll` rejects and the
    // worker never activates.
    let body = body_of(&response).to_owned();
    let list = body
        .split_once("const PRECACHE_URLS = [")
        .and_then(|(_, rest)| rest.split_once("];"))
        .map(|(inner, _)| inner)
        .expect("the generated precache list");
    let urls: Vec<&str> = list
        .split('"')
        .filter(|piece| piece.starts_with('/'))
        .collect();
    assert!(
        !urls.is_empty(),
        "the service worker precaches nothing — the generator changed shape \
         and this test is no longer reading it: {list}"
    );
    for url in urls {
        let asset = get(addr, url);
        assert!(
            asset.starts_with("HTTP/1.1 200"),
            "sw.js precaches {url}, which the server does not serve. \
             `cache.addAll` rejects the whole install on ONE bad URL, so the \
             service worker would never activate: {asset}"
        );
    }
}

/// **The page may ask which board, and nothing else.**
///
/// `ksx_api::PanelChartSpec` carries `backup: bool`, and `facade::chart` answers
/// `backup: true` by writing a file, verifying it, and reconciling this board's
/// write-qualification journal. The neighbouring `api_input_test_start`
/// deserializes its api spec straight off the wire; doing the same here would
/// let a field nobody typed turn a read into a durable write.
///
/// The selector must also arrive VERBATIM: I-PAC instance paths are
/// serial-anchored, so a canonicalised string picks a different board than the
/// row the user pressed.
#[test]
fn panel_chart_carries_the_browsers_selector_and_never_asks_for_a_backup() {
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(Arc::new(ScriptedControl::new(true)), machine.clone());

    let body = post_json(
        addr,
        "/api/panel/chart",
        r#"{"selector":"USB\\VID_D209&PID_0430\\4"}"#,
    );
    assert!(
        body.contains("\"ok\":true"),
        "the read did not happen: {body}"
    );

    let specs = machine.panel_chart_specs.lock().unwrap();
    assert_eq!(specs.len(), 1, "exactly one chart read per request");
    assert_eq!(
        specs[0].device.as_deref(),
        Some(r"USB\VID_D209&PID_0430\4"),
        "the browser's selector did not reach the backend unchanged"
    );
    assert!(
        !specs[0].backup,
        "a page asked for a BACKUP, which writes a file and advances this \
         board's write-qualification state"
    );
}

/// A terminal Button Test phase is not proof that its observer is gone:
/// Cancel answers before the Raw Input window/panel tap/temporary claim has
/// necessarily finished closing. The route must ask the daemon-owned release
/// fence and must not touch the encoder when that bounded handoff refuses.
#[test]
fn panel_chart_waits_for_the_button_test_observer_release_fence() {
    let control = Arc::new(ScriptedControl::new(true));
    *control.input_test_release_fence_refusal.lock().unwrap() = Some(Refusal::new(
        "observer-busy",
        "scripted terminal observer is still releasing a private device path",
    ));
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(control.clone(), machine.clone());

    let body = post_json(addr, "/api/panel/chart", r#"{"selector":"x"}"#);

    assert!(
        body.contains("Button Test is still listening or releasing"),
        "the bounded observer refusal was not explained: {body}"
    );
    assert!(
        !body.contains("private device path"),
        "a backend observer diagnostic reached the browser: {body}"
    );
    assert_eq!(
        control
            .input_test_release_fence_calls
            .load(Ordering::SeqCst),
        1,
        "the chart route skipped or repeated the daemon fence"
    );
    assert!(
        machine.panel_chart_specs.lock().unwrap().is_empty(),
        "the encoder was opened after the observer fence refused"
    );
}

/// A body carrying anything else is refused outright rather than ignored, so a
/// client cannot send `backup` and be quietly told nothing happened.
#[test]
fn panel_chart_refuses_a_body_that_asks_for_more_than_a_selector() {
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(Arc::new(ScriptedControl::new(true)), machine.clone());

    let response = post_json(
        addr,
        "/api/panel/chart",
        r#"{"selector":"USB\\VID_D209&PID_0430\\4","backup":true}"#,
    );
    assert!(
        response.starts_with("HTTP/1.1 4"),
        "an unknown field was accepted: {response}"
    );
    assert!(
        machine.panel_chart_specs.lock().unwrap().is_empty(),
        "the board was read despite an unreadable request"
    );
}

/// **The refusal CODE decides what a page may read, never the prose.**
///
/// `facade::chart` reaches the recovery store on every call, and several of its
/// refusals format `path.display()` into the message — `RECOVERY_REQUIRED` in
/// three places, and `BackupError`'s own Display is `"{path}: {source}"` under
/// `REFUSED`. A denylist that suppressed only the lease refusal would announce
/// the user's absolute config path through an aria-live region.
#[test]
fn the_code_decides_which_chart_refusal_a_page_may_read() {
    // A refusal ABOUT THE REQUEST is authored copy and passes through.
    let machine = Arc::new(ScriptedMachine {
        panel_chart_refusal: Some(Refusal::with_remedy(
            ksx_api::codes::PANEL_INTERFACE_BUSY,
            "Another app is using this I-PAC's configuration interface.",
            "close WinIPAC and read the board again",
        )),
        ..ScriptedMachine::default()
    });
    let addr = start_server_with_machine(Arc::new(ScriptedControl::new(true)), machine.clone());
    let body = post_json(addr, "/api/panel/chart", r#"{"selector":"x"}"#);
    assert!(
        body.contains("Another app is using this I-PAC"),
        "an authored refusal was swallowed: {body}"
    );

    // Anything else becomes one authored sentence, and its path never ships.
    let machine = Arc::new(ScriptedMachine {
        panel_chart_refusal: Some(Refusal::with_remedy(
            ksx_api::codes::REFUSED,
            r"C:\Users\Someone\AppData\Roaming\ksx\panel-backups: access is denied",
            r"restore access to C:\Users\Someone\AppData\Roaming\ksx\panel-backups",
        )),
        ..ScriptedMachine::default()
    });
    let addr = start_server_with_machine(Arc::new(ScriptedControl::new(true)), machine.clone());
    let body = post_json(addr, "/api/panel/chart", r#"{"selector":"x"}"#);
    assert!(
        !body.contains("AppData"),
        "a store diagnostic put the user's config path on the page: {body}"
    );
    assert!(
        body.contains("could not be read"),
        "the page was told nothing at all: {body}"
    );
}

/// **A chart is true for the request that produced it and no longer.**
///
/// Nothing watches the board between requests — WinIPAC can rewrite it at any
/// moment — so a re-served copy is a stale answer wearing a fresh one's clothes.
#[test]
fn a_chart_read_is_never_cached() {
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(Arc::new(ScriptedControl::new(true)), machine.clone());
    let response = http(
        addr,
        "POST /api/panel/chart HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\
         Content-Type: application/json\r\nContent-Length: 16\r\n\r\n{\"selector\":\"x\"}",
    );
    assert!(
        response
            .to_ascii_lowercase()
            .contains("cache-control: no-store"),
        "a chart response may be cached: {response}"
    );
}

/// The write vocabulary never reaches the page. A surface handed
/// "Lossless backup, exact write, full readback, verification, and restore are
/// available" will eventually render it, and this build can do none of that.
#[test]
fn a_chart_response_carries_no_write_vocabulary() {
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(Arc::new(ScriptedControl::new(true)), machine.clone());
    let body = post_json(addr, "/api/panel/chart", r#"{"selector":"x"}"#);

    for write_word in [
        "programming_state",
        "programming_detail",
        "qualification_state",
        "qualification_detail",
        "recommended_terminals",
        "key_options",
        "image_bytes",
    ] {
        assert!(
            !body.contains(write_word),
            "{write_word:?} reached the page: {body}"
        );
    }
    // What it DOES carry: the board, the proof, and the terminals.
    assert!(body.contains("terminals"), "no terminals: {body}");
    assert!(body.contains("image_sha256"), "no read proof: {body}");
}
