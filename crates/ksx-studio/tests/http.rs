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
/// marker travels through the real `/api/status` handler, so observing it
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
    committed: AtomicBool,
    learning: AtomicBool,
    learn_generation: AtomicUsize,
    /// The daemon's StageMeta dirty stamp, scripted: set by the test that
    /// exercises the Apply button's running+dirty visibility.
    dirty: AtomicBool,
    /// Scripts `stage_apply` to refuse with `needs-restart`.
    apply_needs_restart: AtomicBool,
    /// Emulate an older daemon whose staged slot predates the authoring table.
    without_authoring: bool,
    /// Keep macro tables readable while making the direct mapper projection
    /// fail, so persona labels and the two availability channels are tested
    /// independently.
    invalid_mapping_authoring: AtomicBool,
    /// Optional one-shot daemon learner hit. Ordinary mapper fixtures leave
    /// this empty and continue reporting `listening`; the Identify route test
    /// supplies the exact interface path a real daemon panel tap returns.
    identify_hit: Mutex<Option<String>>,
    bound_with: std::sync::Mutex<Option<BindRequest>>,
    restored_with: std::sync::Mutex<Option<(String, String)>>,
    cleared: std::sync::Mutex<Option<String>>,
    saved_macro: std::sync::Mutex<Option<MacroWrite>>,
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
            committed: AtomicBool::new(false),
            learning: AtomicBool::new(false),
            learn_generation: AtomicUsize::new(0),
            dirty: AtomicBool::new(false),
            apply_needs_restart: AtomicBool::new(false),
            without_authoring: false,
            invalid_mapping_authoring: AtomicBool::new(false),
            identify_hit: Mutex::new(None),
            bound_with: std::sync::Mutex::new(None),
            restored_with: std::sync::Mutex::new(None),
            cleared: std::sync::Mutex::new(None),
            saved_macro: std::sync::Mutex::new(None),
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
        *self.identify_hit.lock().unwrap() = Some(device.into());
        self
    }

    fn without_authoring(mut self) -> Self {
        self.without_authoring = true;
        self
    }

    fn invalidate_mapping_authoring(&self) {
        self.invalid_mapping_authoring.store(true, Ordering::SeqCst);
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
                origin: ksx_api::SessionOrigin::Config,
                active: None,
            }
        } else {
            SessionView {
                reachable: true,
                running: false,
                line: "idle".into(),
                profile: None,
                origin: ksx_api::SessionOrigin::Unknown,
                active: None,
            }
        }
    }

    fn start(&self, profile: Option<&str>) -> Result<String, Refusal> {
        *self.started_with.lock().unwrap() = Some(profile.map(str::to_owned));
        if self.refuse_start {
            Err(no_channel("no ksx daemon control channel at the pipe"))
        } else {
            self.running.store(true, Ordering::SeqCst);
            Ok("running (4 slot(s))".into())
        }
    }

    fn stop(&self) -> Result<String, Refusal> {
        if self.no_daemon {
            return Err(no_channel(NO_CHANNEL));
        }
        self.running.store(false, Ordering::SeqCst);
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
            if let Some(device) = self.identify_hit.lock().unwrap().take() {
                self.learning.store(false, Ordering::SeqCst);
                return LearnView {
                    ok: true,
                    state: "hit".into(),
                    generation: Some(self.learn_generation.load(Ordering::SeqCst) as u64),
                    remaining_ms: None,
                    device: Some(device),
                    key: Some("A".into()),
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

    // ── The staged setup, the way the daemon holds it ────────────────────

    fn staged(&self) -> ksx_api::StagedSetupView {
        if self.no_daemon {
            return ksx_api::StagedSetupView::unreachable(NO_CHANNEL);
        }
        let mut view = ksx_api::StagedSetupView::of(&self.staged.lock().unwrap());
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
    /// ok otherwise (and the dirty stamp settles).
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
        self.dirty.store(false, Ordering::SeqCst);
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
                ksx_api::StageOutcome::ok(&setup, "staged")
            }
            Err(refusal) => ksx_api::StageOutcome::refused(&setup, &refusal),
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
    /// Nocturne poll cache. Calls and targets are recorded independently so a
    /// test can catch either accidental polling or browser-supplied authority.
    panel_status_calls: AtomicUsize,
    panel_status_devices: Mutex<Vec<Option<String>>>,
    panel_status_refuse: bool,
    panel_chart_specs: Mutex<Vec<ksx_api::PanelChartSpec>>,
    panel_backup_specs: Mutex<Vec<ksx_api::PanelBackupsSpec>>,
    panel_profile_reads: AtomicUsize,
    panel_profile_save_specs: Mutex<Vec<ksx_api::PanelHardwareProfileSaveSpec>>,
    panel_profile_delete_specs: Mutex<Vec<ksx_api::PanelHardwareProfileDeleteSpec>>,
    panel_program_plan_specs: Mutex<Vec<ksx_api::PanelProgramSpec>>,
    panel_program_specs: Mutex<Vec<ksx_api::PanelProgramApplySpec>>,
    panel_restore_plan_specs: Mutex<Vec<ksx_api::PanelRestoreSpec>>,
    panel_restore_specs: Mutex<Vec<ksx_api::PanelRestoreApplySpec>>,
    picked: Mutex<Vec<(String, Option<String>)>>,
    removed: Mutex<Vec<(String, bool)>>,
    /// Raw daemon learner identities presented for safe inventory resolution.
    /// They never cross the HTTP response; this proves the route did not ask
    /// the machine provider to open a competing observer.
    identified_from: Mutex<Vec<String>>,
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
            panel_backup_specs: Mutex::new(Vec::new()),
            panel_profile_reads: AtomicUsize::new(0),
            panel_profile_save_specs: Mutex::new(Vec::new()),
            panel_profile_delete_specs: Mutex::new(Vec::new()),
            panel_program_plan_specs: Mutex::new(Vec::new()),
            panel_program_specs: Mutex::new(Vec::new()),
            panel_restore_plan_specs: Mutex::new(Vec::new()),
            panel_restore_specs: Mutex::new(Vec::new()),
            picked: Mutex::new(Vec::new()),
            removed: Mutex::new(Vec::new()),
            identified_from: Mutex::new(Vec::new()),
            refuse: false,
            blind: false,
            created_profile: Mutex::new(None),
            theme: Mutex::new(String::new()),
            set_theme_specs: Mutex::new(Vec::new()),
            updated_profile: Mutex::new(None),
            deleted_profile: Mutex::new(None),
            created_preset: Mutex::new(None),
            reads_refuse: false,
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
const EXAMPLE_AUX_HID: &str = r"USB\VID_F00D&PID_CAFE&MI_01\7&5A6B7C8&0&0001";
/// A paired Bluetooth keyboard with a shape-preserving synthetic identity.
const BT_KEYBOARD: &str = r"BTHENUM\{00001124-0000-1000-8000-00805F9B34FB}_VID&0002045E_PID&0800\7&B1C2D3E4&0&02A1B2C3D4E5_C00000000";

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

    /// Both /profiles reads refuse (games.toml AND the presets folder).
    fn reads_refusing() -> Self {
        Self {
            reads_refuse: true,
            ..Self::default()
        }
    }

    fn panel_status_refusing() -> Self {
        Self {
            panel_status_refuse: true,
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

    fn hostile_profile_writes() -> Self {
        Self {
            hostile_profile_writes: true,
            ..Self::default()
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
                bcd_device: 0x0056,
                serial: None,
                driver: "ultimarc-ipac".to_owned(),
                driver_supported: true,
                driver_label: "Ultimarc I-PAC family".to_owned(),
                observed_mode: "keyboard-compatible".to_owned(),
                mode_detail: "A boot-keyboard interface is present; no vendor mode query was sent."
                    .to_owned(),
                observed_mode_label: "Keyboard-compatible · Recommended".to_owned(),
                mode_read_supported: false,
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
        Ok(Self::panel_chart_view())
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
        Ok(Self::panel_plan_view())
    }

    fn panel_program(
        &self,
        spec: &ksx_api::PanelProgramApplySpec,
    ) -> Result<ksx_api::PanelProgramOutcome, Refusal> {
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
        let mut plan = Self::panel_plan_view();
        plan.summary = "Restore 1 terminal assignment from the selected backup.".to_owned();
        Ok(plan)
    }

    fn panel_restore(
        &self,
        spec: &ksx_api::PanelRestoreApplySpec,
    ) -> Result<ksx_api::PanelProgramOutcome, Refusal> {
        self.panel_restore_specs.lock().unwrap().push(spec.clone());
        let mut outcome = Self::panel_program_outcome();
        outcome.summary = "The backup was restored and every byte verified.".to_owned();
        Ok(outcome)
    }

    fn device_identify(
        &self,
        observed_instance: &str,
    ) -> Result<ksx_api::DeviceIdentifyView, Refusal> {
        self.identified_from
            .lock()
            .unwrap()
            .push(observed_instance.to_owned());
        if !observed_instance.eq_ignore_ascii_case(IPAC_KB) {
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
        .write_all(b"GET /api/status HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
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
            payload["snapshot"]["generated_at"]
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

fn get_if_none_match(addr: SocketAddr, path: &str, etag: &str) -> String {
    http(
        addr,
        &format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nIf-None-Match: {etag}\r\n\r\n"
        ),
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

/// Percent-encode one form VALUE. Only used to post a selector the SERVER
/// served: a test that hand-spelled the encoding of a Bluetooth instance path
/// would be asserting its own arithmetic rather than the page's behaviour.
fn form_value(raw: &str) -> String {
    raw.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
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
    let page = get(addr, "/");
    for link in [
        r#"href="/favicon.svg""#,
        r#"href="/favicon.ico""#,
        r#"href="/apple-touch-icon.png""#,
    ] {
        assert!(page.contains(link), "status page missing {link}");
    }
}

#[test]
fn the_session_panel_round_trips_start_stop_and_the_flash() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control.clone());

    // Idle: the Start form and the profile dropdown render.
    let page = get(addr, "/");
    assert!(page.starts_with("HTTP/1.1 200"), "{page}");
    assert!(page.contains(r#"action="/session/start""#), "{page}");
    assert!(page.contains("Example Game"), "{page}");
    assert!(page.contains("idle"), "{page}");

    // Start with a profile: 303 back to / with the outcome flashed.
    let response = post_form(addr, "/session/start", "profile=Example+Game");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(response.contains("location: /?flash=running"), "{response}");
    assert_eq!(
        control.started_with.lock().unwrap().clone(),
        Some(Some("Example Game".to_owned())),
        "the form's profile field must reach the control verb"
    );

    // Following the redirect renders the flash and, now, Stop/Reload.
    let page = get(addr, "/?flash=running%20%284%20slot%28s%29%29");
    assert!(page.contains("running (4 slot(s))"), "{page}");
    assert!(page.contains(r#"action="/session/stop""#), "{page}");
    assert!(page.contains(r#"action="/config/reload""#), "{page}");
    assert!(!page.contains(r#"action="/session/start""#), "{page}");

    // The empty sentinel option means "no profile override".
    let response = post_form(addr, "/session/stop", "");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    let response = post_form(addr, "/session/start", "profile=");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert_eq!(control.started_with.lock().unwrap().clone(), Some(None));
}

/// The whole mapper loop over real HTTP: the page renders zones with real
/// bindings, the learn flow answers listening → cancel, and /api/bind
/// round-trips the conflict → Replace(force) decision.
#[test]
fn the_mapper_page_learn_flow_and_bind_round_trip() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control.clone());

    // The page: slot context, art, a zone with its binding tag, credit line.
    let page = get(addr, "/map");
    assert!(page.starts_with("HTTP/1.1 200"), "{page}");
    assert!(page.contains("P1 · Xbox 360 · Panel P1"), "{page}");
    assert!(page.contains("/_assets/pad-xbox.svg"), "{page}");
    assert!(page.contains(r#"data-fn="A""#), "{page}");
    assert!(page.contains(">G<"), "{page}");
    assert!(
        page.contains("Gamepad-Asset-Pack (MIT) by AL2009man"),
        "{page}"
    );
    // Ledger #13(a): the CSP header must allow inline STYLE attributes (the
    // zone geometry rides them) while scripts stay nonce-locked.
    //
    // It used to assert `style-src 'self' 'unsafe-inline'` — the policy ksx's
    // own `relax_style_src` produced. forma-server 0.2.0 fixed the underlying
    // problem, that workaround is deleted, and the header now carries
    // upstream's answer: a separate `style-src-attr` permits the attributes,
    // so `style-src` keeps its nonce for `<style>` blocks and stylesheets.
    // Asserting the old string here would have quietly demanded a weaker
    // policy than the server ships.
    let headers = page.split("\r\n\r\n").next().unwrap_or("");
    assert!(
        headers.contains("style-src-attr 'unsafe-inline'"),
        "the mapper's zone geometry rides inline style attributes: {headers}"
    );
    assert!(
        headers.contains("style-src 'nonce-"),
        "style-src must stay nonce-locked now that attributes have their own \
         directive: {headers}"
    );
    assert!(headers.contains("script-src 'nonce-"), "{headers}");

    // The art itself is served with the right type, recolored for the theme
    // (the palette sheet build.mjs injects) — never the source's black blob.
    let art = get(addr, "/_assets/pad-xbox.svg");
    assert!(art.starts_with("HTTP/1.1 200"), "{art}");
    assert!(art.contains("image/svg+xml"), "{art}");
    assert!(art.contains("<svg"), "{art}");
    assert!(art.contains("pad-body"), "recolor classes missing: {art}");
    assert!(!art.contains("fill:#000000"), "source black leaked: {art}");

    // /api/map serves the payload the page embeds.
    let api = get(addr, "/api/map");
    let payload: serde_json::Value = serde_json::from_str(body_of(&api)).expect("json");
    assert_eq!(payload["mapper"]["slots"][0]["preset"], "Panel P1");
    assert_eq!(payload["mapper"]["slots"][0]["bindings"]["A"][0], "G");
    assert_eq!(payload["mapper"]["slots"][0]["session_backup"], true);
    assert_eq!(payload["selected"], 1);
    assert_eq!(payload["learn"]["state"], "idle");

    // Learn: start → listening with the countdown, poll agrees, cancel ends.
    let started = post_json(addr, "/api/learn/start", "");
    let learn: serde_json::Value = serde_json::from_str(body_of(&started)).expect("json");
    assert_eq!(learn["state"], "listening");
    assert_eq!(learn["remaining_ms"], 10_000);
    let polled = get(addr, "/api/learn");
    let learn: serde_json::Value = serde_json::from_str(body_of(&polled)).expect("json");
    assert_eq!(learn["state"], "listening");
    // Browser cancellation is generation-qualified. A cached pre-generation
    // tab cannot issue an empty cancel that stops the listener a fresh tab now
    // owns.
    let unqualified = post_json(addr, "/api/learn/cancel", r#"{}"#);
    assert!(!unqualified.starts_with("HTTP/1.1 200"), "{unqualified}");
    let still_listening: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/learn"))).expect("json");
    assert_eq!(still_listening["state"], "listening");
    assert_eq!(still_listening["generation"], learn["generation"]);
    let stale = post_json(addr, "/api/learn/cancel", r#"{"generation":0}"#);
    let stale: serde_json::Value = serde_json::from_str(body_of(&stale)).expect("json");
    assert_eq!(stale["state"], "listening");
    assert_eq!(stale["generation"], learn["generation"]);
    let cancelled = post_json(
        addr,
        "/api/learn/cancel",
        &format!(r#"{{"generation":{}}}"#, learn["generation"]),
    );
    let learn: serde_json::Value = serde_json::from_str(body_of(&cancelled)).expect("json");
    assert_eq!(learn["state"], "cancelled");

    // Bind: the scripted conflict comes back structured; Replace (force)
    // succeeds and reports the reload.
    let refused = post_json(
        addr,
        "/api/bind",
        r#"{"preset":"Panel P1","function":"B","key":"G","force":false,"reload":true}"#,
    );
    let outcome: serde_json::Value = serde_json::from_str(body_of(&refused)).expect("json");
    assert_eq!(outcome["ok"], false);
    assert_eq!(outcome["code"], "conflict");
    assert_eq!(outcome["conflicts"][0]["preset"], "Panel P2");
    assert_eq!(outcome["conflicts"][0]["slot"], 2);

    let forced = post_json(
        addr,
        "/api/bind",
        r#"{"preset":"Panel P1","function":"B","key":"G","force":true,"reload":true}"#,
    );
    let outcome: serde_json::Value = serde_json::from_str(body_of(&forced)).expect("json");
    assert_eq!(outcome["ok"], true, "{outcome}");
    assert_eq!(outcome["reloaded"], true);
    let bound = control
        .bound_with
        .lock()
        .unwrap()
        .clone()
        .expect("bind reached control");
    assert_eq!(bound.preset, "Panel P1");
    assert_eq!(bound.function, "B");
    assert!(bound.force);
    assert!(bound.reload);

    // Restore: defaults succeeds, a missing session recovery copy surfaces an
    // honest refusal, and a junk mode never reaches the control source. The
    // customer response stays independent of storage/provider wording.
    let restored = post_json(
        addr,
        "/api/preset/restore",
        r#"{"preset":"Panel P1","mode":"defaults"}"#,
    );
    let outcome: serde_json::Value = serde_json::from_str(body_of(&restored)).expect("json");
    assert_eq!(outcome["ok"], true, "{outcome}");
    assert_eq!(
        outcome["message"], "Your controller layout was restored.",
        "{outcome}"
    );
    assert_eq!(
        control.restored_with.lock().unwrap().clone(),
        Some(("Panel P1".to_owned(), "defaults".to_owned()))
    );

    let refused = post_json(
        addr,
        "/api/preset/restore",
        r#"{"preset":"Panel P1","mode":"session-backup"}"#,
    );
    let outcome: serde_json::Value = serde_json::from_str(body_of(&refused)).expect("json");
    assert_eq!(outcome["ok"], false);
    assert_eq!(
        outcome["error"], "That recovery copy could not be applied. Nothing changed.",
        "{outcome}"
    );

    let junk = post_json(
        addr,
        "/api/preset/restore",
        r#"{"preset":"Panel P1","mode":"yolo"}"#,
    );
    let outcome: serde_json::Value = serde_json::from_str(body_of(&junk)).expect("json");
    assert_eq!(outcome["ok"], false);
    assert_eq!(
        outcome["error"], "Choose one of the recovery options shown on the page.",
        "{outcome}"
    );
    assert_eq!(
        control.restored_with.lock().unwrap().clone(),
        Some(("Panel P1".to_owned(), "session-backup".to_owned())),
        "the junk mode must have been rejected before the control source"
    );
}

/// FIX 1, over real HTTP: the reported failure. Quit the daemon, load
/// either page, and the FIRST thing on it must be a plain-language banner.
/// The technical recovery command still travels with the page for support,
/// while the visible Map workflow uses the consumer remedy and never exposes
/// a command-line mapping fallback.
#[test]
fn a_dead_daemon_is_loud_on_both_pages_with_a_runnable_command() {
    let addr = start_server(Arc::new(ScriptedControl::dead()));

    for (path, headline, remedy) in [
        (
            "/",
            "No daemon — ksx Studio can see your config but cannot change anything.",
            "tray icon",
        ),
        (
            "/map",
            "Mapping needs the background helper",
            "Close and reopen ksx",
        ),
    ] {
        let page = get(addr, path);
        assert!(page.starts_with("HTTP/1.1 200"), "{path}: {page}");
        let body = body_of(&page);
        assert!(body.contains(headline), "{path} has no banner: {body}");
        assert!(body.contains(remedy), "{path}: {body}");
        assert!(
            body.contains("ksx daemon --game &quot;Example Launcher&quot;")
                || body.contains(r#"ksx daemon --game "Example Launcher""#),
            "{path} must carry the command that actually starts THIS cabinet: {body}"
        );
        // Unmissable = above everything it is about. On both pages the banner
        // must precede the <main> content it warns you off touching.
        let banner = body.find(headline).expect("banner");
        let footer = body.find("<footer").expect("footer");
        assert!(banner < footer, "{path}: banner is below the fold: {body}");
        let first_other_card = body[banner..]
            .find(r#"class="card"#)
            .map(|i| banner + i)
            .expect("another card follows the banner");
        assert!(
            banner < first_other_card,
            "{path}: the banner is not first inside <main>: {body}"
        );
    }

    // The mapper additionally renders every control visibly inert…
    let map = body_of(&get(addr, "/map")).to_owned();
    assert!(map.contains("z-dead"), "{map}");
    assert!(map.contains("l-dead"), "{map}");
    assert!(map.contains("card pactions off"), "{map}");
    // The mapping controls remain present and visibly inert, but there is no
    // customer-facing shell fallback competing with the reopen remedy.
    assert!(!map.contains("ksx map --preset"), "{map}");
}

/// FIX 0 over HTTP: the mapper's own session controls are the same
/// ControlSource verbs the status page's forms use — one pipe verb each.
#[test]
fn the_mapper_can_pause_and_resume_emulation_over_json() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control.clone());

    // Start something, then pause it from the mapper.
    let started = post_json(addr, "/api/session/start", r#"{"profile":"Example Game"}"#);
    let out: serde_json::Value = serde_json::from_str(body_of(&started)).expect("json");
    assert_eq!(out["ok"], true, "{out}");

    let map = body_of(&get(addr, "/map")).to_owned();
    assert!(map.contains("Play is active"), "{map}");
    assert!(map.contains(r#"data-act="pause-map""#), "{map}");
    // v9: and it is a real form, so the pause is not a dead button on a page
    // without JavaScript — same `stop` verb, 303'd back to /map.
    assert!(map.contains(r#"action="/map/session/stop""#), "{map}");
    let response = post_form(addr, "/map/session/stop", "slot=1");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(
        response.contains("location: /map?slot=1&flash=stopped"),
        "{response}"
    );
    assert!(
        !control.session().running,
        "the form POST really stopped it"
    );
    let started = post_json(addr, "/api/session/start", r#"{"profile":"Example Game"}"#);
    let out: serde_json::Value = serde_json::from_str(body_of(&started)).expect("json");
    assert_eq!(out["ok"], true, "{out}");

    let paused = post_json(addr, "/api/session/stop", "");
    let out: serde_json::Value = serde_json::from_str(body_of(&paused)).expect("json");
    assert_eq!(out["ok"], true, "{out}");
    assert_eq!(out["message"], "Play is paused. You can edit controls now.");

    // Resume is its OWN verb and carries nothing. The page cannot know what it
    // paused — a session played from an unsaved staged setup has no profile at
    // all — and `start` means the config on disk, so resuming that way put back
    // the wrong session or none. Breaks against the shipped page, which posted
    // /api/session/start with the profile it had remembered.
    *control.started_with.lock().unwrap() = None;
    let resumed = post_json(addr, "/api/session/resume", "");
    let out: serde_json::Value = serde_json::from_str(body_of(&resumed)).expect("json");
    assert_eq!(out["ok"], true, "{out}");
    assert_eq!(control.resumes.load(Ordering::SeqCst), 1);
    assert_eq!(
        control.started_with.lock().unwrap().clone(),
        None,
        "Resume must not reach `start` — that verb is defined as the config on disk"
    );
    assert!(control.session().running, "and emulation really came back");
}

/// FIX 2 over HTTP: three destinations, and the label the third one wears.
#[test]
fn the_three_restore_destinations_and_clear_all_round_trip() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control.clone());

    let map = body_of(&get(addr, "/map")).to_owned();
    assert!(
        map.contains(&format!("Restore backup from {BACKUP_LABEL}")),
        "the newest backup's timestamp belongs in the label: {map}"
    );
    assert!(
        map.contains("Reset to KSX keyboard layout (WASD + arrows)"),
        "{map}"
    );
    assert!(!map.contains("Restore built-in defaults"), "{map}");

    let out: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/api/preset/restore",
        r#"{"preset":"Panel P1","mode":"latest-backup"}"#,
    )))
    .expect("json");
    assert_eq!(out["ok"], true, "{out}");
    assert_eq!(
        control.restored_with.lock().unwrap().clone(),
        Some(("Panel P1".to_owned(), "latest-backup".to_owned()))
    );

    let out: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/api/preset/clear-all",
        r#"{"preset":"Panel P1"}"#,
    )))
    .expect("json");
    assert_eq!(out["ok"], true, "{out}");
    assert_eq!(
        control.cleared.lock().unwrap().clone(),
        Some("Panel P1".to_owned())
    );
}

/// v11 over HTTP: the macro editor READS a real preset and SAVES the whole
/// table back through the one control verb.
///
/// The read half proves the card is no longer a blank draft — the file's own
/// numbers reach the page, in the unit they were authored in — and the write
/// half proves the save is `ControlSource::save_macro` (= the daemon's
/// `map-macro`), carrying the toast, the advisories a successful write still
/// has to say, and the backup label that IS the undo.
#[test]
fn the_macro_editor_reads_a_preset_and_saves_the_whole_table() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control.clone());

    // READ: the payload the island polls carries the file's shape.
    let map: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/map?slot=1"))).expect("json");
    assert_eq!(map["macros"]["available"], true, "{map}");
    assert_eq!(map["macros"]["preset"], "Panel P1");
    assert_eq!(map["macros"]["macros"][0]["name"], "hadouken");
    assert_eq!(map["macros"]["macros"][0]["triggers"][0], "P");
    assert_eq!(map["macros"]["macros"][0]["steps"][0]["ms"], 50);
    // A duration authored in frames stays frames all the way to the client.
    assert_eq!(map["macros"]["macros"][0]["steps"][1]["frames"], 3);
    assert_eq!(
        map["macros"]["macros"][0]["steps"][1]["ms"],
        serde_json::Value::Null
    );
    // ...and the SSR paint says the same thing without any JavaScript.
    let page = body_of(&get(addr, "/map?slot=1")).to_owned();
    assert!(page.contains("hadouken"), "{page}");
    assert!(page.contains("started by P"), "{page}");

    // WRITE: one POST, one whole table.
    let saved: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/api/macro/save",
        r#"{"preset":"Panel P1","name":"hadouken","on_release":"abort",
            "steps":[{"hold":["dpad.down"],"ms":50},{"hold":["A"],"frames":3}]}"#,
    )))
    .expect("json");
    assert_eq!(saved["ok"], true, "{saved}");
    assert_eq!(saved["backup"], BACKUP_LABEL, "the undo, named: {saved}");
    assert_eq!(
        saved["warnings"][0], "One very short step may be missed by the game.",
        "the customer-safe advisory is never swallowed: {saved}"
    );
    let write = control.saved_macro.lock().unwrap().clone().expect("saved");
    assert_eq!(write.preset, "Panel P1");
    assert_eq!(write.name, "hadouken");
    assert_eq!(write.on_release, "abort");
    assert_eq!(write.steps.len(), 2);
    assert_eq!(write.steps[1].frames, Some(3));
    assert!(!write.delete);
    assert!(
        write.reload,
        "a macro body is a binding change: the running session takes it in place"
    );

    // A refusal comes back as rows a page can list, not a sentence to parse.
    let refused: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/api/macro/save",
        r#"{"preset":"Panel P1","name":"hadouken","steps":[{"hold":["warp"],"ms":50}]}"#,
    )))
    .expect("json");
    assert_eq!(refused["ok"], false, "{refused}");
    assert_eq!(refused["code"], "macro-invalid", "{refused}");
    assert_eq!(
        refused["problems"][0], "One step or setting is not valid.",
        "{refused}"
    );

    // DELETE is the same route with the explicit word.
    let deleted: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/api/macro/save",
        r#"{"preset":"Panel P1","name":"hadouken","delete":true}"#,
    )))
    .expect("json");
    assert_eq!(deleted["ok"], true, "{deleted}");
    assert_eq!(deleted["deleted"], true, "{deleted}");
    assert!(control.saved_macro.lock().unwrap().as_ref().unwrap().delete);
}

/// END TO END over HTTP for the field that broke: `repeat`, and the turbo
/// rate that hangs off it.
///
/// The user set `repeat = while-held` in the card, clicked Save, was told
/// "saved", and watched the control snap back to `once` — because the value
/// was dropped between the wire and the preset file. Nothing about that was
/// visible from the outside: the POST returned `ok`. So this test asserts what
/// the POST actually DELIVERS, not just that it succeeded — the `MacroWrite`
/// that reached `ControlSource::save_macro` must carry the policy the request
/// asked for, in every spelling the card can produce.
#[test]
fn the_repeat_policy_and_its_rate_reach_the_control_source_over_http() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control.clone());

    // The read half serves the field at all — an absent `repeat` on the wire
    // would leave the card with nothing to show.
    let map: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/map?slot=1"))).expect("json");
    assert_eq!(map["macros"]["macros"][0]["repeat"], "once", "{map}");

    // while-held: the exact edit that was reported lost.
    let saved: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/api/macro/save",
        r#"{"preset":"Panel P1","name":"hadouken","repeat":"while-held",
            "steps":[{"hold":["A"],"ms":50}]}"#,
    )))
    .expect("json");
    assert_eq!(saved["ok"], true, "{saved}");
    let write = control.saved_macro.lock().unwrap().clone().expect("saved");
    assert_eq!(
        write.repeat, "while-held",
        "the repeat policy must reach the writer, or Save is a lie: {saved}"
    );

    // turbo authored in hertz: the rate travels in the unit it was written in.
    let _ = post_json(
        addr,
        "/api/macro/save",
        r#"{"preset":"Panel P1","name":"hadouken","repeat":"turbo","turbo_hz":12,
            "steps":[{"hold":["A"],"ms":50}]}"#,
    );
    let write = control.saved_macro.lock().unwrap().clone().expect("saved");
    assert_eq!(write.repeat, "turbo");
    assert_eq!(write.turbo_hz, Some(12));
    assert_eq!(write.gap_ms, None, "the other spelling is not invented");

    // ...and the same rate said the other way.
    let _ = post_json(
        addr,
        "/api/macro/save",
        r#"{"preset":"Panel P1","name":"hadouken","repeat":"turbo","gap_ms":50,
            "steps":[{"hold":["A"],"frames":2,"allow_short":true}]}"#,
    );
    let write = control.saved_macro.lock().unwrap().clone().expect("saved");
    assert_eq!(write.gap_ms, Some(50));
    assert_eq!(write.turbo_hz, None);
    // The step's own fields ride along untouched, in the author's unit.
    assert_eq!(write.steps[0].frames, Some(2));
    assert_eq!(write.steps[0].ms, None);
    assert!(write.steps[0].allow_short);

    // An omitted `repeat` is the file's own default, not an empty string the
    // daemon would refuse.
    let _ = post_json(
        addr,
        "/api/macro/save",
        r#"{"preset":"Panel P1","name":"hadouken","steps":[{"hold":["A"],"ms":50}]}"#,
    );
    let write = control.saved_macro.lock().unwrap().clone().expect("saved");
    assert!(
        write.repeat.is_empty(),
        "blank = the file's omitted-field rule"
    );
}

/// Clearing ONE binding is the plain `map` verb with a null key — no second
/// writer, no GUI-only path.
#[test]
fn clearing_one_binding_goes_through_the_bind_verb_with_a_null_key() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control.clone());
    let out: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/api/bind",
        r#"{"preset":"Panel P1","function":"A","key":null,"force":false,"reload":true}"#,
    )))
    .expect("json");
    assert_eq!(out["ok"], true, "{out}");
    let bound = control.bound_with.lock().unwrap().clone().expect("bind");
    assert_eq!(bound.function, "A");
    assert_eq!(bound.key, None, "a null key is a CLEAR");
}

/// v9, over real HTTP and with no JavaScript anywhere in sight: the mapper
/// page ships forms, and posting one form-encoded body writes a binding and
/// 303s back to /map with the outcome flashed. This is the whole no-JS
/// contract — if it holds here, a browser with scripting off can map a
/// cabinet.
#[test]
fn the_mapper_is_fully_operable_with_form_posts_only() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control.clone());

    // The page a scripting-off browser gets: real forms, real action URLs,
    // real key options, and slot switching as links.
    let page = body_of(&get(addr, "/map")).to_owned();
    assert!(page.contains(r#"action="/map/bind""#), "{page}");
    assert!(page.contains(r#"formaction="/map/clear""#), "{page}");
    assert!(page.contains(r#"action="/map/preset/restore""#), "{page}");
    assert!(page.contains(r#"action="/map/preset/clear-all""#), "{page}");
    assert!(
        page.contains(r#"<select class="keysel" name="key""#),
        "{page}"
    );
    assert!(page.contains("<option>NumpadEnter</option>"), "{page}");
    assert!(page.contains(r#"href="/map?slot=1""#), "{page}");

    // Bind: form-encoded in, 303 back to the slot we were on, outcome flashed.
    let response = post_form(addr, "/map/bind", "slot=1&function=B&key=H");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(
        response.contains("location: /map?slot=1&flash=B%20is%20now%20H."),
        "{response}"
    );
    let bound = control.bound_with.lock().unwrap().clone().expect("bind");
    assert_eq!(bound.preset, "Panel P1", "the slot resolved to its preset");
    assert_eq!(bound.function, "B");
    assert_eq!(bound.key.as_deref(), Some("H"));
    assert!(
        bound.reload,
        "a binding edit is hot-swapped, pads stay plugged"
    );
    assert!(!bound.force, "the row form never forces on its own");

    // Clear: the same `map` verb with a null key — no second unbind path.
    let response = post_form(addr, "/map/clear", "slot=1&function=A");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(
        response.contains("location: /map?slot=1&flash=A%20is%20now%20unbound."),
        "{response}"
    );
    assert_eq!(
        control.bound_with.lock().unwrap().clone().unwrap().key,
        None,
        "a null key is a CLEAR"
    );

    // The empty placeholder is refused in words, never read as a clear.
    let response = post_form(addr, "/map/bind", "slot=1&function=B&key=");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(
        response.contains("flash=error%3A%20no%20key%20picked"),
        "{response}"
    );

    // Cross-player refusal: the flash names the other player AND the checkbox
    // that says yes to it — a form's version of the Replace dialog.
    let response = post_form(addr, "/map/bind", "slot=1&function=B&key=G");
    assert!(
        response.contains("location: /map?slot=1&flash=error"),
        "{response}"
    );
    assert!(response.contains("Player%202"), "{response}");
    assert!(!response.contains("IPAC"), "{response}");
    let response = post_form(addr, "/map/bind", "slot=1&function=B&key=G&force=1");
    assert!(response.contains("flash=B%20is%20now%20G."), "{response}");
    assert!(control.bound_with.lock().unwrap().clone().unwrap().force);

    // The preset writes and the pause, same shape.
    let response = post_form(addr, "/map/preset/clear-all", "slot=1");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert_eq!(
        control.cleared.lock().unwrap().clone(),
        Some("Panel P1".to_owned())
    );
    let response = post_form(addr, "/map/preset/restore", "slot=1&mode=latest-backup");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert_eq!(
        control.restored_with.lock().unwrap().clone(),
        Some(("Panel P1".to_owned(), "latest-backup".to_owned()))
    );
    // A junk mode is refused before the daemon is ever asked.
    let response = post_form(addr, "/map/preset/restore", "slot=1&mode=yolo");
    assert!(
        response.contains(
            "flash=error%3A%20Choose%20one%20of%20the%20recovery%20options%20shown%20on%20the%20page."
        ),
        "{response}"
    );
    assert_eq!(
        control.restored_with.lock().unwrap().clone(),
        Some(("Panel P1".to_owned(), "latest-backup".to_owned())),
        "the junk mode must not have reached the control source"
    );

    // Following the redirect renders the outcome — the no-JS feedback loop
    // closed, exactly like the status page's.
    let page = body_of(&get(addr, "/map?slot=1&flash=B%20is%20now%20H.")).to_owned();
    assert!(page.contains("The change was completed."), "{page}");
    assert!(page.contains("flash flash-ok"), "{page}");
    let page = body_of(&get(addr, "/map?slot=1&flash=error%3A%20nope")).to_owned();
    assert!(page.contains("flash flash-err"), "{page}");

    // Query strings are untrusted diagnostic input, not customer copy. A
    // hardware address, local path, parser detail, registry key or JSON blob
    // must all collapse to the authored Map fallback before SSR; hydration is
    // pinned independently against the same rule in map_target_source.rs.
    for (encoded, leaked) in [
        ("C%3A%5CUsers%5CTestUser%5Csecret", "TestUser"),
        ("HID%5CVID_D209%26PID_0430", "VID_D209"),
        ("HKLM%5CSYSTEM%5CCurrentControlSet", "CurrentControlSet"),
        (
            "expected%20a%20sequence%20at%20line%204%20column%209",
            "line 4",
        ),
        ("%7B%22verb%22%3A%22map%22%2C%22key%22%3A%22A%22%7D", "verb"),
    ] {
        let page = body_of(&get(
            addr,
            &format!("/map?slot=1&flash=error%3A%20{encoded}"),
        ))
        .to_owned();
        assert!(
            page.contains("That change could not be completed. Nothing changed."),
            "{page}"
        );
        assert!(!page.contains(leaked), "{leaked} leaked into Map: {page}");
    }
}

/// v10, MANY KEYS → ONE CONTROL over real HTTP and with no JavaScript: the
/// same row form that binds can also ADD the picked key to what a control
/// already holds, and REMOVE just one of the keys it holds. Both are
/// read-modify-write on the key list the page already read, so a form body
/// never carries a key list it made up.
#[test]
fn the_no_js_forms_add_and_remove_one_key_at_a_time() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control.clone());

    let page = body_of(&get(addr, "/map")).to_owned();
    assert!(page.contains(r#"formaction="/map/add""#), "{page}");
    assert!(page.contains(r#"formaction="/map/key/remove""#), "{page}");
    // The fixture's B holds two keys: both are on the page, each with its own
    // remove payload, and neither reader spells them as a chord.
    assert!(page.contains(r#"data-rmkey="B|S""#), "{page}");
    assert!(page.contains(r#"data-rmkey="B|Enter""#), "{page}");
    assert!(!page.contains("S+Enter"), "{page}");

    // REMOVE ONE: B keeps S, loses Enter — and because one key is left, this
    // daemon's single-key `map` verb can express it exactly.
    let response = post_form(addr, "/map/key/remove", "slot=1&function=B&key=Enter");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(
        response.contains("flash=Enter%20removed.%20B%20is%20now%20S."),
        "{response}"
    );
    assert_eq!(
        control
            .bound_with
            .lock()
            .unwrap()
            .clone()
            .unwrap()
            .key
            .as_deref(),
        Some("S"),
        "the survivor is what gets written"
    );

    // A key the control does not have is a refusal that names what it DOES
    // have — never a silent no-op, and never a write.
    let response = post_form(addr, "/map/key/remove", "slot=1&function=B&key=J");
    assert!(response.contains("flash=error%3A"), "{response}");
    assert!(
        response.contains("it%20has%20S%20%C2%B7%20Enter"),
        "{response}"
    );

    // ADD onto an UNBOUND control is an ordinary bind: nothing to keep.
    let response = post_form(addr, "/map/add", "slot=1&function=X&key=J");
    assert!(response.contains("flash=X%20is%20now%20J."), "{response}");

    // ADD onto a control that already has keys is the OR-chain the engine
    // executes — and the honest limit of today's wire: the map verb writes one
    // key per control and would drop the rest, so the write is REFUSED in
    // words rather than made silently lossy. (The day the verb takes a key
    // list, `ControlSource::bind_keys` writes it and this flash becomes the
    // success sentence, with nothing else on the page changing.)
    let before = control.bound_with.lock().unwrap().clone();
    let response = post_form(addr, "/map/add", "slot=1&function=B&key=J");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(response.contains("flash=error%3A"), "{response}");
    assert!(
        response.contains(
            "B%20was%20not%20changed%3A%20That%20control%20could%20not%20be%20changed.%20Nothing%20changed."
        ),
        "{response}"
    );
    assert_eq!(
        control.bound_with.lock().unwrap().clone().map(|b| b.key),
        before.map(|b| b.key),
        "a refused multi-key write must not have written anything"
    );

    // Adding a key the control already has changes nothing and says so.
    let response = post_form(addr, "/map/add", "slot=1&function=A&key=G");
    assert!(response.contains("already%20has%20G"), "{response}");

    // No key picked: the same honest refusal the Bind button gives.
    let response = post_form(addr, "/map/add", "slot=1&function=B&key=");
    assert!(
        response.contains("flash=error%3A%20no%20key%20picked"),
        "{response}"
    );
}

/// The JSON twin: the island computes the SET it wants and posts it whole, so
/// add, remove-one and undo all land through one writer.
#[test]
fn the_key_list_route_writes_a_whole_set() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control.clone());

    // One key: an ordinary bind.
    let response = post_json(
        addr,
        "/api/bind/keys",
        r#"{"preset":"Panel P1","function":"B","keys":["H"],"force":false,"reload":true}"#,
    );
    assert!(body_of(&response).contains(r#""ok":true"#), "{response}");
    let bound = control.bound_with.lock().unwrap().clone().unwrap();
    assert_eq!(bound.key.as_deref(), Some("H"));
    assert!(bound.reload);

    // No keys: a clear, through the same `map` verb.
    let response = post_json(
        addr,
        "/api/bind/keys",
        r#"{"preset":"Panel P1","function":"B","keys":[],"reload":true}"#,
    );
    assert!(body_of(&response).contains(r#""ok":true"#), "{response}");
    assert_eq!(
        control.bound_with.lock().unwrap().clone().unwrap().key,
        None
    );

    // Two keys: refused in customer language, without exposing the wire
    // limitation — and nothing was written.
    let response = post_json(
        addr,
        "/api/bind/keys",
        r#"{"preset":"Panel P1","function":"B","keys":["S","Enter"],"reload":true}"#,
    );
    let body = body_of(&response);
    assert!(body.contains(r#""ok":false"#), "{response}");
    assert!(
        body.contains("That control could not be changed. Nothing changed."),
        "{response}"
    );
    assert_eq!(
        control.bound_with.lock().unwrap().clone().unwrap().key,
        None,
        "the refusal must not have written the first key"
    );
}

/// No daemon: the forms are still there (dimmed by CSS, never removed) and a
/// post still answers with the reason — the no-JS half of FIX 1's "never a
/// silent no-op".
#[test]
fn a_no_js_post_without_a_daemon_flashes_the_reason() {
    let addr = start_server(Arc::new(ScriptedControl::dead()));
    let page = body_of(&get(addr, "/map")).to_owned();
    assert!(page.contains(r#"class="lbind nojs off""#), "{page}");
    assert!(page.contains(r#"action="/map/bind""#), "{page}");

    let response = post_form(addr, "/map/preset/clear-all", "slot=1");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(response.contains("flash=error%3A"), "{response}");
    assert!(
        response.contains(
            "The%20controller%20layout%20could%20not%20be%20cleared.%20Nothing%20changed."
        ),
        "{response}"
    );
    assert!(!response.contains("daemon"), "{response}");
}

#[test]
fn a_refused_action_comes_back_as_an_error_flash_never_silence() {
    let control = Arc::new(ScriptedControl::new(true));
    let addr = start_server(control);

    let response = post_form(addr, "/session/start", "profile=");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(
        response.contains("location: /?flash=error%3A%20no%20ksx%20daemon"),
        "{response}"
    );

    // And the redirect target renders it.
    let page = get(
        addr,
        "/?flash=error%3A%20no%20ksx%20daemon%20control%20channel",
    );
    assert!(
        page.contains("error: no ksx daemon control channel"),
        "{page}"
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
        "/map/preset/clear-all",
        "/map/session/stop",
        "/session/stop",
        "/map/clear",
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
            "POST /map/clear HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
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
    assert!(
        control.bound_with.lock().unwrap().is_some(),
        "the write must actually have reached the control surface"
    );
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
        "GET /api/map HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n",
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

/// The page and the poller serve one shape.
#[test]
fn api_devices_serves_the_same_payload_the_page_embeds() {
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

/// Device selection now lives directly in the customer Setup flow. Existing
/// and specialist screens must reach that flow, and the destination must still
/// contain the real picker form rather than merely borrowing its label.
#[test]
fn every_page_links_to_the_device_picker() {
    let addr = start_server(Arc::new(ScriptedControl::new(true)));
    let picker = body_of(&get(addr, "/start")).to_owned();
    assert!(
        picker.contains(r#"action="/start/device""#),
        "the Setup destination has no device picker: {picker}"
    );
    for route in ["/", "/map", "/devices"] {
        let page = get(addr, route);
        let body = body_of(&page);
        assert!(
            body.contains(r#"href="/start#keyboard""#),
            "{route} has no link to the device picker: {body}"
        );
    }
}

// ---------------------------------------------------------------------------
// /profiles — the games.toml profiles and the presets (v15)
// ---------------------------------------------------------------------------

/// A missing program is called out before Play, without turning a machine path
/// into alarm copy. The editable value remains in the affected row's form.
#[test]
fn the_profiles_page_shows_a_broken_game_and_keeps_its_path_in_edit() {
    let control = Arc::new(ScriptedControl::new(true));
    let addr = start_server(control);
    let response = get(addr, "/profiles");
    let body = body_of(&response);

    assert!(body.contains("Games that need attention"), "{body}");
    let alarm = body
        .split_once("Games that need attention")
        .and_then(|(_, rest)| rest.split_once("</section>"))
        .map(|(alarm, _)| alarm)
        .expect("attention card");
    assert!(alarm.contains("Missing Example Game"), "{alarm}");
    assert!(alarm.contains("The program could not be found"), "{alarm}");
    assert!(!alarm.contains("X:\\Examples\\missing-game.exe"), "{alarm}");
    assert!(
        body.contains(r#"value="X:\Examples\missing-game.exe""#),
        "the edit form must retain the value that needs correction: {body}"
    );
    // The healthy one is listed too.
    assert!(body.contains("Example Game"), "{body}");
    assert!(body.contains(r#"action="/profiles/update""#), "{body}");
    assert!(body.contains(r#"action="/profiles/delete""#), "{body}");
    assert!(body.contains("Edit or delete"), "{body}");
    // The presets and the in-box templates both arrived — the second is what
    // `LocalMachine::presets` used to answer with an empty list.
    assert!(body.contains("Arcade"), "{body}");
    assert!(body.contains("keyboard-2p"), "{body}");
}

/// The JSON twin serves the same shape the page embeds — one struct, one
/// serializer, like `/api/status` and `/api/map`.
#[test]
fn the_profiles_api_serves_the_pages_own_payload() {
    let control = Arc::new(ScriptedControl::new(true));
    let addr = start_server(control);
    let response = get(addr, "/api/profiles");
    assert!(response.contains("no-store"), "{response}");

    let value: serde_json::Value = serde_json::from_str(body_of(&response)).expect("json");
    assert_eq!(
        value.pointer("/profiles/profiles/1/state"),
        Some(&serde_json::json!("broken"))
    );
    assert_eq!(
        value.pointer("/profiles/profiles/1/broken_path"),
        Some(&serde_json::json!("X:\\Examples\\missing-game.exe"))
    );
    assert_eq!(
        value.pointer("/profiles/profiles/0/revision"),
        Some(&serde_json::json!("g1-example"))
    );
    assert_eq!(
        value.pointer("/presets/templates/0/id"),
        Some(&serde_json::json!("keyboard-2p"))
    );
    // A poll is not an action.
    assert_eq!(value.pointer("/flash"), Some(&serde_json::json!(null)));
}

/// `/profiles?flash=` is attacker-controlled. Escaping is insufficient: raw
/// internal text would still be safe HTML but bad product copy.
#[test]
fn a_hostile_profiles_query_flash_is_replaced_not_reflected() {
    let addr = start_server(Arc::new(ScriptedControl::new(true)));
    let response = get(
        addr,
        "/profiles?flash=error%3A%20daemon%20TOML%20profile%20preset%20slot%20CLI%20C%3A%5Csecret%5Cgames.toml%20--force",
    );
    let body = body_of(&response);
    let block = body
        .split_once(r#"<script id="__ksx-payload" type="application/json">"#)
        .and_then(|(_, rest)| rest.split_once("</script>"))
        .map(|(json, _)| json)
        .expect("profiles payload block");
    let payload: serde_json::Value = serde_json::from_str(block).expect("payload json");
    let flash = payload["flash"].as_str().expect("safe flash");
    assert_eq!(
        flash,
        "error: Saved Games could not finish that request. Reopen ksx and try again."
    );
    let lower = flash.to_ascii_lowercase();
    for leaked in [
        "daemon", "toml", "profile", "preset", "slot", "cli", "secret", "--force",
    ] {
        assert!(
            !lower.contains(leaked),
            "query text leaked through flash: {flash}"
        );
    }
}

/// Provider messages and remedies are untrusted presentation input too. Every
/// Saved Games action maps success/refusal to its own fixed customer copy.
#[test]
fn hostile_saved_games_providers_cannot_write_internal_copy_into_flashes() {
    fn assert_safe(response: &str, expected: &str) {
        assert!(response.starts_with("HTTP/1.1 303"), "{response}");
        let location = response
            .lines()
            .find(|line| line.to_ascii_lowercase().starts_with("location:"))
            .expect("redirect Location");
        let flash = location
            .split_once("flash=")
            .map(|(_, flash)| flash)
            .expect("flash");
        assert!(flash.contains(expected), "{response}");
        let lower = flash.to_ascii_lowercase();
        for leaked in [
            "daemon", "toml", "profile", "preset", "slot", "cli", "secret", "--force",
        ] {
            assert!(!lower.contains(leaked), "provider text leaked: {response}");
        }
    }

    let control = Arc::new(ScriptedControl::dead());
    let machine = Arc::new(ScriptedMachine::hostile_profile_writes());
    let addr = start_server_with_machine(control, machine);
    for (path, body, expected) in [
        (
            "/profiles/new",
            "title=T&path=C%3A%5Cx.exe&slots=1&preset=Arcade",
            "Saved%20game%20could%20not%20be%20added",
        ),
        (
            "/profiles/update",
            "original_title=T&revision=g1-t&title=T&path=C%3A%5Cx.exe&slots=1&preset=Arcade",
            "Saved%20game%20could%20not%20be%20updated",
        ),
        (
            "/profiles/delete",
            "title=T&revision=g1-t&confirm_delete=yes",
            "Saved%20game%20could%20not%20be%20deleted",
        ),
        (
            "/profiles/preset/new",
            "name=T&template=keyboard-2p&player=1",
            "Controller%20layout%20could%20not%20be%20created",
        ),
        (
            "/profiles/switch",
            "profile=T",
            "That%20game%20could%20not%20be%20started",
        ),
        ("/profiles/stop", "", "Play%20could%20not%20be%20stopped"),
    ] {
        assert_safe(&post_form(addr, path, body), expected);
    }
}

/// Creating a profile: the form's own values reach the backend verb, and the
/// outcome comes back as a flash on a 303 — never HTML from a POST.
#[test]
fn creating_a_profile_reaches_the_verb_and_flashes_the_outcome() {
    let control = Arc::new(ScriptedControl::new(true));
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(control, machine.clone());

    let response = post_form(
        addr,
        "/profiles/new",
        "title=Tekken&path=C%3A%5Cgames%5Ctekken.exe&arguments=-windowed&slots=4&preset=Arcade",
    );
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(response.contains("/profiles?flash="), "{response}");
    assert!(response.contains("Saved%20game%20added."), "{response}");

    let spec = machine
        .created_profile
        .lock()
        .unwrap()
        .clone()
        .expect("spec");
    assert_eq!(spec.title, "Tekken");
    assert_eq!(spec.path, "C:\\games\\tekken.exe");
    assert_eq!(spec.arguments, "-windowed");
    assert_eq!(spec.slots, 4);
    assert_eq!(spec.preset, "Arcade");
}

/// Profile repair is a first-class Studio operation: every editable field,
/// including the explicit device-refresh choice, reaches one typed backend
/// verb and comes back to the same page with feedback.
#[test]
fn updating_a_profile_reaches_the_typed_verb() {
    let control = Arc::new(ScriptedControl::new(true));
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(control, machine.clone());

    let response = post_form(
        addr,
        "/profiles/update",
        "original_title=Example+Game&revision=g1-example&title=Example+Game+Updated&path=%22C%3A%5CExamples%5Cexample-game-updated.exe%22&arguments=-fullscreen&slots=2&preset=Arcade&rebase_devices=true",
    );
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(response.contains("/profiles?flash="), "{response}");
    assert!(response.contains("Saved%20game%20updated."), "{response}");

    let spec = machine
        .updated_profile
        .lock()
        .unwrap()
        .clone()
        .expect("update spec");
    assert_eq!(spec.original_title, "Example Game");
    assert_eq!(spec.revision, "g1-example");
    assert_eq!(spec.title, "Example Game Updated");
    assert_eq!(spec.path, "\"C:\\Examples\\example-game-updated.exe\"");
    assert_eq!(spec.arguments, "-fullscreen");
    assert_eq!(spec.slots, 2);
    assert_eq!(spec.preset, "Arcade");
    assert!(spec.rebase_devices);
}

/// Deleting a profile never implies deleting the layouts it references. The
/// route carries only the exact profile title into the typed delete verb.
#[test]
fn deleting_a_profile_reaches_the_typed_verb() {
    let control = Arc::new(ScriptedControl::new(true));
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(control, machine.clone());

    let response = post_form(
        addr,
        "/profiles/delete",
        "title=Missing+Example+Game&revision=g1-missing&confirm_delete=yes",
    );
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(response.contains("/profiles?flash="), "{response}");
    assert!(response.contains("Saved%20game%20deleted."), "{response}");
    assert_eq!(
        machine.deleted_profile.lock().unwrap().clone(),
        Some(ksx_api::DeleteProfile {
            title: "Missing Example Game".to_owned(),
            revision: "g1-missing".to_owned(),
        })
    );
}

/// Deletion requires server-side confirmation too. Browser validation and the
/// JavaScript dialog improve the interaction, but neither is an authorization
/// boundary for a destructive POST.
#[test]
fn deleting_a_profile_without_confirmation_changes_nothing() {
    let control = Arc::new(ScriptedControl::new(true));
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(control, machine.clone());

    let response = post_form(addr, "/profiles/delete", "title=Missing+Example+Game");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(response.contains("flash=error%3A"), "{response}");
    assert!(machine.deleted_profile.lock().unwrap().is_none());
}

#[test]
fn stale_update_and_delete_forms_are_worded_refusals() {
    let control = Arc::new(ScriptedControl::new(true));
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(control, machine);

    let update = post_form(
        addr,
        "/profiles/update",
        "original_title=Example+Game&revision=g1-old&title=Example+Game&path=C%3A%5CExamples%5Cexample-game.exe&slots=2&preset=Arcade",
    );
    assert!(update.contains("flash=error%3A"), "{update}");
    assert!(
        update.contains("Saved%20game%20could%20not%20be%20updated"),
        "{update}"
    );
    assert!(!update.contains("changed%20while"), "{update}");

    let delete = post_form(
        addr,
        "/profiles/delete",
        "title=Missing+Example+Game&revision=g1-old&confirm_delete=yes",
    );
    assert!(delete.contains("flash=error%3A"), "{delete}");
    assert!(
        delete.contains("Saved%20game%20could%20not%20be%20deleted"),
        "{delete}"
    );
    assert!(!delete.contains("changed%20while"), "{delete}");
}

/// A refusal flashes too, prefixed `error:` so the page's `show:flashError`
/// pair picks the red side. Nothing fails silently.
#[test]
fn a_refused_profile_create_flashes_the_reason() {
    let control = Arc::new(ScriptedControl::new(true));
    let addr = start_server(control);
    let response = post_form(
        addr,
        "/profiles/new",
        "title=&path=C%3A%5Cx.exe&slots=1&preset=Arcade",
    );
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(response.contains("flash=error%3A"), "{response}");
}

/// A post with a field missing OR EMPTY still comes back as a 303 with a
/// worded flash, NOT a 422.
///
/// The distinction is not pedantry. The island fetch-submits and reads its
/// outcome out of the redirect's `?flash=` — a 422 carries no `Location`, so
/// the page would show nothing whatsoever and the user would be left pressing
/// a button that appears to do nothing. That is the failure mode this whole
/// screen replaced; it must not come back through the extractor.
///
/// The EMPTY cases are the ones that matter, and the earlier version of this
/// test did not have them: it covered only the absent key, which
/// `#[serde(default)]` already handled, so it passed against the broken build.
/// A browser sends `slots=` — present, empty — the instant a user clears a
/// non-`required` `<input type="number">`, and serde_urlencoded answers
/// "cannot parse integer from empty string" for an `Option<u8>`. The rows
/// below fail against the `Option<u8>` version with a 422 and no `Location`;
/// the `garbage` rows fail against any version that lets the extractor do the
/// parsing at all.
#[test]
fn a_post_with_a_missing_or_empty_number_still_flashes_instead_of_422() {
    let control = Arc::new(ScriptedControl::new(true));
    let addr = start_server(control);
    for (path, body, why) in [
        ("/profiles/new", "path=C%3A%5Cx.exe", "the key is absent"),
        (
            "/profiles/new",
            "title=T&path=C%3A%5Cx.exe&slots=&preset=Arcade",
            "the user cleared the slots box",
        ),
        (
            "/profiles/update",
            "original_title=T&title=T&path=C%3A%5Cx.exe&slots=&preset=Arcade",
            "the user cleared the update players box",
        ),
        (
            "/profiles/update",
            "original_title=T&title=T&path=C%3A%5Cx.exe&slots=many&preset=Arcade",
            "the update players box is not a number",
        ),
        (
            "/profiles/new",
            "title=T&path=C%3A%5Cx.exe&slots=lots&preset=Arcade",
            "the slots box holds something that is not a number",
        ),
        ("/profiles/preset/new", "name=Couch", "the key is absent"),
        (
            "/profiles/preset/new",
            "name=Couch&template=keyboard-2p&player=",
            "the user cleared the player box",
        ),
        (
            "/profiles/preset/new",
            "name=Couch&template=keyboard-2p&player=two",
            "the player box holds something that is not a number",
        ),
    ] {
        let response = post_form(addr, path, body);
        assert!(
            response.starts_with("HTTP/1.1 303"),
            "{path} must redirect with a flash when {why}, not reject the \
             body — a 422 carries no Location and the island renders it as \
             nothing at all: {response}"
        );
        assert!(
            response
                .to_ascii_lowercase()
                .contains("location: /profiles"),
            "{path} ({why}) must carry a Location the island can read a flash \
             out of: {response}"
        );
        assert!(response.contains("flash="), "{path} ({why}): {response}");
    }
}

/// A provider refusal is mapped to the form's own safe remedy. Provider
/// message/remedy text never becomes customer presentation copy.
#[test]
fn a_layout_refusal_flashes_a_safe_way_out() {
    let control = Arc::new(ScriptedControl::new(true));
    let addr = start_server(control);
    let response = post_form(
        addr,
        "/profiles/preset/new",
        "name=Arcade&template=keyboard-2p&player=1",
    );
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(
        response.contains("Controller%20layout%20could%20not%20be%20created"),
        "{response}"
    );
    assert!(
        response
            .to_ascii_lowercase()
            .contains("choose%20a%20different%20name"),
        "{response}"
    );
    assert!(!response.contains("already%20exists"), "{response}");
    assert!(!response.contains("--force"), "{response}");
}

/// A REFUSED read must not render as an assertion of absence.
///
/// This is the page's own stated purpose turned on itself, and it is this
/// project's signature bug: a surface answering for a read it never completed
/// (the session that reported success while the arcade panel was dead because
/// a WinUSB board had silently fallen back to Interception).
///
/// Fails against the shipped version on the first two assertions: there,
/// `collect_profiles` substituted `ProfilesView::default()` / `PresetsView::
/// default()` on `Err`, so the page printed "no profiles in games.toml" and
/// "No presets on disk … Make a preset from an in-box template below first" —
/// the second of which points at a form whose `<select>` is empty for exactly
/// the same reason, so the only route it offers cannot succeed.
#[test]
fn a_refused_read_is_not_rendered_as_an_empty_machine() {
    let control = Arc::new(ScriptedControl::new(true));
    let addr = start_server_with_machine(control, Arc::new(ScriptedMachine::reads_refusing()));
    let response = get(addr, "/profiles");
    let body = body_of(&response);

    assert!(
        !body.contains("no profiles in games.toml"),
        "a failed read must not be reported as an empty games.toml: {body}"
    );
    assert!(
        !body.contains("Make a preset from an in-box template below"),
        "a failed presets read must not send the user to a form fed by the \
         same read: {body}"
    );
    assert!(
        !body.contains(r#"action="/profiles/preset/new""#),
        "…and that form must not be on the page at all: {body}"
    );
    // What it says instead: both failed resources, and both reasons, in words.
    assert!(body.contains("Saved games could not be read"), "{body}");
    assert!(
        body.contains("Controller layouts could not be read"),
        "{body}"
    );
    assert!(body.contains("Reopen ksx and try again"), "{body}");
    for leaked in [
        "expected `=`",
        "access is denied",
        "ksx config",
        "ksx doctor",
    ] {
        assert!(
            !body.contains(leaked),
            "internal read detail leaked: {body}"
        );
    }
    for action in [
        r#"action="/profiles/new""#,
        r#"action="/profiles/update""#,
        r#"action="/profiles/delete""#,
    ] {
        assert!(
            !body.contains(action),
            "a failed Saved Games read must disable Add/Edit/Delete: {body}"
        );
    }

    // The JSON twin says it in a machine-readable field, not by omission.
    let value: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/profiles"))).expect("json");
    assert_eq!(
        value.pointer("/view/profiles_unreadable"),
        Some(&serde_json::json!(true)),
        "a poller must be able to tell a refused read from an empty one: \
         {value}"
    );
    assert_eq!(
        value.pointer("/view/presets_unreadable"),
        Some(&serde_json::json!(true)),
        "{value}"
    );
    assert_eq!(
        value.pointer("/view/no_presets_yet"),
        Some(&serde_json::json!(false)),
        "'no presets yet' is a claim about the FOLDER; nothing was read: \
         {value}"
    );
}

/// Creating a preset from a template, through the same `preset_new` verb
/// `ksx preset new` performs.
#[test]
fn creating_a_preset_from_a_template_reaches_the_verb() {
    let control = Arc::new(ScriptedControl::new(true));
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(control, machine.clone());

    let response = post_form(
        addr,
        "/profiles/preset/new",
        "name=Couch&template=keyboard-2p&player=2",
    );
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(
        response.contains("Controller%20layout%20created."),
        "{response}"
    );
    let spec = machine
        .created_preset
        .lock()
        .unwrap()
        .clone()
        .expect("spec");
    assert_eq!(spec.name, "Couch");
    assert_eq!(spec.template, "keyboard-2p");
    assert_eq!(spec.player, 2);
    // Overwriting a 25-binding mapping is not something a web form may do by
    // accident; `--force` stays the CLI's consent step.
    assert!(!spec.force);
}

/// Switching profile is the SAME `ControlSource::start` the status page posts
/// — one backend verb, no second "switch" path — and it comes back to
/// /profiles so the user keeps their place.
#[test]
fn switching_profile_calls_start_and_returns_to_profiles() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control.clone());

    let response = post_form(addr, "/profiles/switch", "profile=Missing+Example+Game");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(
        response
            .to_ascii_lowercase()
            .contains("location: /profiles?flash="),
        "the redirect must come back HERE, not to / like the status page's \
         twin of this verb: {response}"
    );
    assert!(response.contains("flash=Play%20started."), "{response}");
    assert!(!response.contains("Missing%20Example%20Game"), "{response}");
    assert!(
        !response.to_ascii_lowercase().contains("slot"),
        "{response}"
    );
    assert_eq!(
        control.started_with.lock().unwrap().clone(),
        Some(Some("Missing Example Game".to_owned())),
        "the profile the row named must reach `start`"
    );
}

#[test]
fn stopping_play_returns_to_saved_games() {
    let control = Arc::new(ScriptedControl::new(true));
    control.running.store(true, Ordering::SeqCst);
    let addr = start_server(control.clone());

    let response = post_form(addr, "/profiles/stop", "");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(
        response
            .to_ascii_lowercase()
            .contains("location: /profiles?flash="),
        "{response}"
    );
    assert!(response.contains("flash=Play%20stopped."), "{response}");
    assert!(!control.running.load(Ordering::SeqCst));
}

/// The guard is a router-wide layer, so a route declared in the same chain is
/// guarded by construction — but "by construction" is exactly the claim worth
/// testing, once, per new mutating route.
#[test]
fn the_profiles_write_routes_refuse_a_cross_site_post() {
    let control = Arc::new(ScriptedControl::new(false));
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(control.clone(), machine.clone());
    control.running.store(true, Ordering::SeqCst);

    for (path, body) in [
        (
            "/profiles/new",
            "title=Evil&path=C%3A%5Cevil.exe&slots=1&preset=Arcade",
        ),
        (
            "/profiles/update",
            "original_title=Street+Fighter&title=Evil&path=C%3A%5Cevil.exe&slots=1&preset=Arcade",
        ),
        ("/profiles/delete", "title=Street+Fighter"),
        (
            "/profiles/preset/new",
            "name=Evil&template=keyboard-2p&player=1",
        ),
        ("/profiles/switch", "profile=Missing+Example+Game"),
        ("/profiles/stop", ""),
    ] {
        let response = http(
            addr,
            &format!(
                "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
                 Origin: http://evil.example\r\nConnection: close\r\n\
                 Content-Type: application/x-www-form-urlencoded\r\n\
                 Content-Length: {len}\r\n\r\n{body}",
                port = addr.port(),
                len = body.len(),
            ),
        );
        assert!(
            response.starts_with("HTTP/1.1 403"),
            "{path} must refuse a cross-site POST: {response}"
        );
    }
    // Not "it returned 403" — that no write happened.
    assert!(machine.created_profile.lock().unwrap().is_none());
    assert!(machine.updated_profile.lock().unwrap().is_none());
    assert!(machine.deleted_profile.lock().unwrap().is_none());
    assert!(machine.created_preset.lock().unwrap().is_none());
    assert!(control.started_with.lock().unwrap().is_none());
    assert!(
        control.running.load(Ordering::SeqCst),
        "the rejected Stop request must not reach the control provider"
    );
}

/// A rebound host cannot even READ the profile list. The same Host check
/// covers every route; it is asserted on this one because a page that lists
/// filesystem paths is worth naming explicitly.
#[test]
fn a_rebound_host_cannot_read_the_profiles() {
    let control = Arc::new(ScriptedControl::new(true));
    let addr = start_server(control);
    let response = http(
        addr,
        "GET /api/profiles HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n",
    );
    assert!(response.starts_with("HTTP/1.1 421"), "{response}");
}

/// Every page carries the customer workflow: Setup → Controls → Test. Advanced
/// and diagnostic screens remain reachable from contextual affordances rather
/// than expanding this primary rail. Controls itself is deliberately a
/// non-link so an editing target cannot be lost by clicking the active stage.
#[test]
fn every_page_links_to_every_other_page() {
    let control = Arc::new(ScriptedControl::new(true));
    let addr = start_server(control);
    for route in [
        "/",
        "/start",
        "/map",
        "/check",
        "/devices",
        "/profiles",
        "/setup",
        "/pads",
    ] {
        let response = get(addr, route);
        let body = body_of(&response);
        assert!(
            body.contains(r#"href="/start#keyboard""#),
            "{route}: {body}"
        );
        assert!(body.contains(r#">Keyboard<"#), "{route}: {body}");
        assert!(body.contains(r#">Mapping<"#), "{route}: {body}");
        assert!(body.contains(r#"href="/check""#), "{route}: {body}");
        assert!(body.contains(r#">Test inputs<"#), "{route}: {body}");
        if route == "/map" {
            assert!(
                body.contains(
                    r#"<span class="navlink workflow-link on" aria-current="page"><span class="workflow-num">3</span>Mapping</span>"#
                ),
                "the active Mapping stage must preserve mapper context: {body}"
            );
        } else {
            assert!(
                body.contains(r#"href="/map""#),
                "{route} cannot reach Mapping: {body}"
            );
        }
    }
}

// ── /setup: the config first, and the first run ────────────────────────────

/// The page a first run lands on, over real HTTP: the configuration is the
/// first card, the two verbs are on it, and the checklist is what the backend
/// decided rather than anything this page worked out.
#[test]
fn the_setup_page_leads_with_the_config_and_its_two_verbs() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control);
    let response = get(addr, "/setup");
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(
        response.contains("cache-control: no-store"),
        "a config read is point-in-time: {response}"
    );
    let body = body_of(&response);

    // The two verbs, both reachable with no JavaScript at all.
    assert!(body.contains(r#"href="/setup/export.json""#), "{body}");
    assert!(body.contains(r#"action="/setup/import""#), "{body}");
    // The checklist, straight off the provider.
    assert!(body.contains("Press a button and watch it land"), "{body}");
    assert!(body.contains(r#"class="step now""#), "{body}");
    // Onward, rather than duplicated: the board step belongs to /devices.
    assert!(body.contains(r#"href="/devices""#), "{body}");
    // The path is present exactly once, in the support line — never as a
    // control. This is the owner's brief, checked over the wire.
    let at = body.find("C:\\cfg").expect("the config root, for support");
    let smallprint = body.find(r#"class="smallprint""#).expect("support line");
    assert!(
        smallprint < at,
        "the config root must be inside the small print"
    );
    assert!(!body.contains(r#"href="C:\cfg"#), "{body}");
}

/// The page and the poller serve one shape (the parity render_setup.rs pins
/// server-side, observed here end to end).
#[test]
fn the_setup_api_serves_the_payload_the_page_embeds() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control);
    let payload: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/setup"))).expect("json");
    assert_eq!(payload["setup"]["available"], serde_json::json!(true));
    assert_eq!(
        payload["setup"]["view"]["config_exists"],
        serde_json::json!(true)
    );
    assert_eq!(payload["setup"]["view"]["steps"][2]["state"], "now");
    assert_eq!(
        payload["setup"]["view"]["persona_options"]
            .as_array()
            .expect("served persona roster")
            .len(),
        ksx_core::Persona::ALL.len(),
        "the API keeps the complete capability roster"
    );
    let dualsense = payload["setup"]["view"]["persona_options"]
        .as_array()
        .unwrap()
        .iter()
        .find(|option| option["name"] == "dualsense")
        .expect("the canonical DualSense option");
    assert_eq!(dualsense["backend"], "hidmaestro");
    assert_eq!(dualsense["backend_label"], "HIDMaestro");
    assert_eq!(dualsense["instance_limit"], serde_json::Value::Null);
    assert_eq!(dualsense["available"], true);
    assert_eq!(dualsense["unavailable_reason"], serde_json::Value::Null);
    assert_eq!(
        payload["rows"]["persona_options"],
        serde_json::json!([
            {"value": "xbox360", "label": "Xbox 360 · ViGEmBus"},
            {"value": "playstation", "label": "PlayStation · ViGEmBus"},
            {"value": "dualsense", "label": "DualSense · HIDMaestro"},
            {"value": "switchpro", "label": "Switch Pro · HIDMaestro"},
            {"value": "xboxseries", "label": "Xbox Series X|S · HIDMaestro"},
            {"value": "snes", "label": "SNES · HIDMaestro"},
            {"value": "genesis", "label": "Genesis · HIDMaestro"}
        ]),
        "the form rows contain every live persona and no gated one"
    );
    assert_eq!(payload["learn"]["state"], "idle");
    // A poll is not an action.
    assert_eq!(payload["flash"], serde_json::json!(null));
}

/// EXPORT is a download, not a path. The bytes come back with a file name
/// attached, so a plain `<a download>` finishes the job.
#[test]
fn export_hands_back_the_document_itself() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control);
    let response = get(addr, "/setup/export.json");
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(
        response.contains("content-disposition: attachment; filename=\"ksx-config-"),
        "{response}"
    );
    assert!(
        response.contains("content-type: application/json"),
        "{response}"
    );
    assert!(body_of(&response).contains("ksx_interop"), "{response}");
}

/// The consent shape, over HTTP: no "write it" box, no write — and the answer
/// says so in a sentence short enough to have survived the redirect.
#[test]
fn import_is_a_dry_run_until_the_box_is_ticked() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control);

    let document = "%7B%22ksx_interop%22%3A1%7D";
    let dry = post_form(addr, "/setup/import", &format!("document={document}"));
    assert!(dry.starts_with("HTTP/1.1 303"), "{dry}");
    assert!(dry.contains("nothing%20written%20yet"), "{dry}");
    assert!(
        !dry.contains("flash=error"),
        "a clean dry run is not an error: {dry}"
    );

    let applied = post_form(
        addr,
        "/setup/import",
        &format!("document={document}&apply=yes"),
    );
    assert!(applied.starts_with("HTTP/1.1 303"), "{applied}");
    assert!(applied.contains("imported%20config"), "{applied}");

    // The CONSENT CONTROL is named by this page, not by the backend: the
    // report's own sentence says what would happen and that nothing was
    // written, and the flash adds the label on the box that makes it write.
    // (The backend used to bake `Tick "write it"` in, where the cabinet egui —
    // which has no such box — reads the same string.)
    assert!(dry.contains("Tick%20%22write%20it%22"), "{dry}");
    assert!(
        !applied.contains("Tick%20%22write%20it%22"),
        "a write that happened must not ask for consent again: {applied}"
    );

    // A document that does not say what it is comes back as an ERROR flash —
    // never silence, and never a claim that something was written.
    let junk = post_form(addr, "/setup/import", "document=%7B%7D");
    assert!(junk.contains("flash=error"), "{junk}");
    // …and an empty box is refused before the provider is even asked.
    let empty = post_form(addr, "/setup/import", "document=");
    assert!(empty.contains("flash=error"), "{empty}");
    assert!(empty.contains("paste%20a%20configuration"), "{empty}");
}

/// The commonest way an import fails is a document that will not validate —
/// and the page that OWNS config editing (docs/SURFACES.md §3) must be able to
/// say what is wrong with it.
///
/// Fails against the version that shipped: it flashed `report.summary` alone
/// and threw the populated `faults` list away, ending on "`ksx config import
/// --dry-run` lists them" — a page handing the user to a shell to read a list
/// it was already holding.
#[test]
fn a_refused_import_says_what_is_wrong_with_the_document() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control);

    let document = "%7B%22ksx_interop%22%3A1%2C%22faulty%22%3Atrue%7D";
    let refused = post_form(addr, "/setup/import", &format!("document={document}"));
    assert!(refused.contains("flash=error"), "{refused}");
    // The count, from the backend…
    assert!(refused.contains("3%20validation%20fault"), "{refused}");
    // …and the first fault itself, plus how many more there are, from here.
    assert!(refused.contains("First%3A"), "{refused}");
    assert!(refused.contains("Nope"), "{refused}");
    assert!(refused.contains("%2B2%20more"), "{refused}");
    // Never the CLI dead end.
    assert!(!refused.contains("dry-run%60%20lists"), "{refused}");
}

/// A bare document — the one "an assistant wrote you", which the import card
/// invites — needs a way to say what it is, and the form has one.
#[test]
fn the_import_form_can_say_what_a_bare_document_is() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control);

    // The invitation is on the page, and so is the control that makes it true.
    let body = body_of(&get(addr, "/setup")).to_owned();
    assert!(body.contains("an assistant that wrote you one"), "{body}");
    assert!(body.contains(r#"name="what""#), "{body}");

    // Bare + unsaid: refused, as it must be — importing the wrong file over
    // the wrong file is what that refusal exists to prevent.
    let unsaid = post_form(addr, "/setup/import", "document=%7B%22slots%22%3A%5B%5D%7D");
    assert!(unsaid.contains("flash=error"), "{unsaid}");
    assert!(
        unsaid.contains("does%20not%20say%20what%20it%20is"),
        "{unsaid}"
    );

    // Bare + said: the same document goes through.
    let said = post_form(
        addr,
        "/setup/import",
        "document=%7B%22slots%22%3A%5B%5D%7D&what=config",
    );
    assert!(said.starts_with("HTTP/1.1 303"), "{said}");
    assert!(!said.contains("flash=error"), "{said}");
}

/// Every refusal on this route is a flashed sentence — including the ones axum
/// would otherwise answer itself.
///
/// The page's whole feedback channel with scripting off is the flash (see
/// `ImportForm`'s doc comment), so a body this route cannot read has to arrive
/// as one too. It used to fall through to axum's bare 4xx with no way back.
#[test]
fn an_unreadable_import_body_is_a_flashed_sentence_not_a_bare_4xx() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control);

    // Wrong content type: the same rejection arm an over-large paste takes.
    let body = "{\"ksx_interop\":1}";
    let response = http(
        addr,
        &format!(
            "POST /setup/import HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\
             Content-Type: text/plain\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        ),
    );
    assert!(
        response.starts_with("HTTP/1.1 303"),
        "a body this route cannot read must come back as a flash: {response}"
    );
    assert!(response.contains("flash=error"), "{response}");
    assert!(response.contains("ksx%20config%20import"), "{response}");
}

/// Step 2 is ONE backend verb — `ControlSource::assign_slot`, the same pipe
/// verb `ksx slot assign` performs — and the flash is
/// `SlotOutcome::headline()`, the canonical renderer the cabinet and the daemon
/// already print.
///
/// **The idle half is the regression test.** The version that shipped rebuilt
/// the sentence from flags and appended " The pads replugged." whenever
/// `restarted` was set — and this page offers the wire form whenever the daemon
/// is REACHABLE, not running. So an idle cabinet was told its four controllers
/// had just vanished and come back by a write that replugged nothing. The
/// ledger test `control.rs::a_slot_outcome_prints_what_the_daemon_said_rather
/// _than_re_deriving_it` forbids that re-derivation by name.
#[test]
fn wiring_a_slot_goes_through_assign_slot_and_prints_the_daemons_own_sentence() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control);

    // Nothing running: the daemon says so, and the page does not invent a
    // bounce on top of it.
    let idle = post_form(addr, "/setup/slot", "slot=2&preset=Panel+P1&profile=");
    assert!(idle.starts_with("HTTP/1.1 303"), "{idle}");
    assert!(idle.contains("slot%202%20now%20uses"), "{idle}");
    assert!(idle.contains("nothing%20is%20running"), "{idle}");
    assert!(
        !idle.contains("replugged"),
        "the flash claimed a pad bounce against an idle daemon: {idle}"
    );

    // Persona is the canonical value the served menu posts. The existing
    // assign-slot verb parses it; the page owns no alias table.
    let dualsense = post_form(
        addr,
        "/setup/slot",
        "slot=2&preset=Panel+P1&persona=dualsense&profile=",
    );
    assert!(dualsense.starts_with("HTTP/1.1 303"), "{dualsense}");
    assert!(dualsense.contains("DualSense"), "{dualsense}");

    // A running session: the bounce is named once, by the daemon, and not
    // again by this page.
    let started = post_form(addr, "/session/start", "profile=");
    assert!(started.starts_with("HTTP/1.1 303"), "{started}");
    let running = post_form(addr, "/setup/slot", "slot=2&preset=Panel+P1&profile=");
    assert!(running.contains("pads%20replugged"), "{running}");
    assert_eq!(
        running.matches("replugged").count(),
        1,
        "the bounce was named twice — once by the daemon and once by the page: {running}"
    );

    // A preset that is not there is a refusal, flashed as one.
    let bad = post_form(addr, "/setup/slot", "slot=2&preset=Nope");
    assert!(bad.contains("flash=error"), "{bad}");
    // …and so is submitting the form with nothing chosen.
    let empty = post_form(addr, "/setup/slot", "slot=2&preset=");
    assert!(empty.contains("flash=error"), "{empty}");
}

/// The slot menu offers what the DAEMON accepts, over the wire.
///
/// `ksx-core` is a test-only dependency of this crate for exactly this kind of
/// assertion (see Cargo.toml): the page knows no vocabulary at runtime, the
/// test reads the one true constant. Fails against the shipped version, which
/// held `SLOT_CHOICES = 8` in two languages while `MAX_SLOTS` was 16.
#[test]
fn the_setup_slot_menu_offers_every_slot_the_daemon_accepts() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control);
    let body = body_of(&get(addr, "/setup")).to_owned();
    for n in 1..=ksx_core::MAX_SLOTS {
        assert!(
            body.contains(&format!(">Slot {n}<")),
            "the menu skips slot {n}, which `slot assign` takes: {body}"
        );
    }
    let past = u16::from(ksx_core::MAX_SLOTS) + 1;
    assert!(!body.contains(&format!(">Slot {past}<")), "{body}");
}

/// A machine provider that REFUSED produces a page that says so — and says
/// nothing else about the machine.
///
/// The signature bug of this project is a surface reporting success over a
/// read that failed. Here it would be a first-run page telling a cabinet with a
/// full configuration that it has no boards, no slots and no presets, because
/// the provider that could not answer was rendered as an empty one. Fails
/// against the shipped version six sentences over.
#[test]
fn a_refused_machine_provider_never_claims_the_machine_is_empty() {
    struct NoMachine;
    // Every method defaulted: `setup_state` refuses with the CONTROL-SURFACE
    // sentence, which is exactly the state this test is about.
    impl ksx_api::MachineSource for NoMachine {}

    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server_with_machine(control, Arc::new(NoMachine));
    let body = body_of(&get(addr, "/setup")).to_owned();

    assert!(
        body.contains("The configuration could not be read"),
        "{body}"
    );
    assert!(body.contains("cannot say which step is next"), "{body}");
    for claim in [
        "There is no configuration on this machine yet.",
        "no boards named yet",
        "No board has a name yet",
        "no slots wired yet",
        "No slot is wired yet",
        "0 preset(s) and 0 game profile(s) on disk.",
        "Three steps, in order.",
    ] {
        assert!(
            !body.contains(claim),
            "a refused read claimed {claim:?} over the wire: {body}"
        );
    }
    // …and no live control that would write against a config nobody read.
    assert!(!body.contains(r#"action="/setup/slot""#), "{body}");
    assert!(
        body.contains("could not be read, so ksx cannot offer"),
        "{body}"
    );

    // The poller sees the same refusal, in the same words.
    let payload: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/setup"))).expect("json");
    assert_eq!(payload["setup"]["available"], serde_json::json!(false));
    assert_eq!(
        payload["lines"]["config"],
        serde_json::json!("The configuration could not be read.")
    );
    assert_eq!(payload["flags"]["no_boards"], serde_json::json!(false));
    assert_eq!(payload["flags"]["setup_known"], serde_json::json!(false));
}

/// Step 3 is the daemon's own learner, and it is operable with scripting off:
/// POST, 303, and the next render shows the state the poll would have.
#[test]
fn proving_a_button_uses_the_daemon_learner_with_no_javascript() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control);

    let started = post_form(addr, "/setup/prove", "");
    assert!(started.starts_with("HTTP/1.1 303"), "{started}");
    assert!(started.contains("Listening"), "{started}");

    // The page itself now says the learner is listening — no client code
    // involved, which is what makes the <noscript> refresh enough.
    let page = body_of(&get(addr, "/setup")).to_owned();
    assert!(page.contains("press any button on the panel"), "{page}");
    assert!(page.contains(r#"action="/setup/prove/cancel""#), "{page}");

    // A cached form without the generation is refused without cancelling the
    // listener a newer page owns.
    let stale = post_form(addr, "/setup/prove/cancel", "");
    assert!(stale.starts_with("HTTP/1.1 303"), "{stale}");
    assert!(stale.contains("stale"), "{stale}");
    let page = body_of(&get(addr, "/setup")).to_owned();
    assert!(page.contains("press any button on the panel"), "{page}");

    let stopped = post_form(addr, "/setup/prove/cancel", "generation=1");
    assert!(stopped.starts_with("HTTP/1.1 303"), "{stopped}");
}

/// Every mutating /setup route is inside the guarded router, and the reads are
/// covered by the Host check like every other read. Written as a loop over the
/// routes rather than as one case, because the failure this catches is a route
/// added later and attached in the wrong place.
#[test]
fn the_setup_routes_are_guarded_like_every_other_one() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control);

    for path in [
        "/setup/import",
        "/setup/slot",
        "/setup/theme",
        "/setup/prove",
        "/setup/prove/cancel",
    ] {
        let body = "document=%7B%7D&slot=1&preset=Panel+P1";
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
    }

    // Reads too: a rebound name never reaches a handler, on any route.
    for path in ["/setup", "/api/setup", "/setup/export.json"] {
        let response = http(
            addr,
            &format!("GET {path} HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n"),
        );
        assert!(
            response.starts_with("HTTP/1.1 421"),
            "{path} must refuse a rebound read, got: {response}"
        );
    }
}

/// TK2's stamp oracle: every page GET renders `<html lang="en">` with the
/// stored theme stamped — and ONLY ids this build ships. The stamp is applied
/// per handler (`page_theme` + `render::with_theme`) and the render-layer
/// tests cannot see it because the splice happens above them — so this loop
/// is the coverage, and PAGES is a HAND-KEPT list: an eleventh page must be
/// added both to its handler and to this array, or its stamp ships untested.
#[test]
fn every_page_stamps_the_stored_theme_and_only_a_shipped_one() {
    const PAGES: [&str; 10] = [
        "/",
        "/start",
        "/workspace",
        "/nocturne",
        "/map",
        "/check",
        "/pads",
        "/devices",
        "/profiles",
        "/setup",
    ];

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
    // hand-editable and /setup/import writes Settings wholesale, so this path
    // is reachable — and stamping it would defeat the system-follow guard
    // while styling nothing (a light-OS user silently gets base dark).
    let machine = Arc::new(ScriptedMachine::default());
    *machine.theme.lock().unwrap() = "matrix2".to_owned();
    let addr = start_server_with_machine(Arc::new(ScriptedControl::new(false)), machine);
    let response = get(addr, "/");
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

/// The theme form's round trip: a shipped id is stored and the very next
/// render stamps it; `system` clears (the spec carries the empty string, not
/// a word); an id this build lacks is refused at the door and never reaches
/// the machine provider.
#[test]
fn the_theme_form_round_trips_and_refuses_what_the_build_lacks() {
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(
        Arc::new(ScriptedControl::new(false)),
        Arc::clone(&machine) as Arc<dyn ksx_api::MachineSource>,
    );

    let response = post_form(addr, "/setup/theme", "theme=light");
    assert!(response.starts_with("HTTP/1.1 303"), "got: {response}");
    assert!(response.contains("/setup?flash=Saved"), "got: {response}");
    assert_eq!(
        machine.set_theme_specs.lock().unwrap().as_slice(),
        ["light"],
        "the form's id must reach the verb"
    );
    let after = get(addr, "/setup");
    assert!(
        body_of(&after).contains("data-theme=\"light\""),
        "the redirect's render must already stamp the new choice \
         (the POST busts the machine cache)"
    );

    let response = post_form(addr, "/setup/theme", "theme=system");
    assert!(response.starts_with("HTTP/1.1 303"), "got: {response}");
    assert_eq!(
        machine.set_theme_specs.lock().unwrap().as_slice(),
        ["light", ""],
        "`system` clears: the stored value is the empty string"
    );

    let response = post_form(addr, "/setup/theme", "theme=matrix2");
    assert!(
        response.contains("flash=error"),
        "an unshipped id flashes an error, got: {response}"
    );
    assert_eq!(
        machine.set_theme_specs.lock().unwrap().len(),
        2,
        "a refused id must never reach the machine provider"
    );
}

/// With no daemon, the config half of the page keeps working and the two verbs
/// stay live — Import and Export are the config store, not the pipe. The steps
/// that DO need a daemon say so instead of offering a dead button.
#[test]
fn the_config_verbs_survive_a_dead_daemon() {
    let control = Arc::new(ScriptedControl::dead());
    let addr = start_server(control);
    let body = body_of(&get(addr, "/setup")).to_owned();

    assert!(body.contains(r#"href="/setup/export.json""#), "{body}");
    assert!(body.contains(r#"action="/setup/import""#), "{body}");
    assert!(
        body.contains("Import and Export below still work"),
        "{body}"
    );
    // …and no live control that would silently do nothing.
    assert!(!body.contains(r#"action="/setup/slot""#), "{body}");
    assert!(!body.contains(r#"action="/setup/prove""#), "{body}");
    assert!(body.contains("the listener lives in the daemon"), "{body}");

    // An export still produces a document.
    assert!(
        get(addr, "/setup/export.json").starts_with("HTTP/1.1 200"),
        "the config store needs no daemon"
    );
}

/// The product Setup stage is `/start`; the older import/export setup screen is
/// a specialist surface, not the first-run destination in the primary rail.
#[test]
fn the_existing_pages_link_to_setup() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(control);
    for path in ["/", "/map"] {
        let body = body_of(&get(addr, path)).to_owned();
        assert!(
            body.contains(r#"href="/start#keyboard""#),
            "{path} must reach the product Setup flow from its nav: {body}"
        );
    }
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

/// The nav has a way in. "One action away from the mapper" (docs/MAPPER-UX.md
/// Build C) is a claim about navigation, and nothing else in the suite would
/// notice it becoming false.
#[test]
fn the_mapper_is_one_click_from_the_button_check() {
    let addr = start_server(Arc::new(ScriptedControl::new(false)));
    let map = get(addr, "/map");
    assert!(
        body_of(&map).contains(r#"href="/check""#),
        "the mapper lost its link to the button check"
    );
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
    assert!(unavailable.contains("Open setup"), "{unavailable}");
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
    assert!(empty.contains("Add a controller in setup"), "{empty}");

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
    assert!(zero.contains(r#"href="/map""#), "{zero}");

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
    assert!(body.contains(r#"href="/map?slot=2""#), "{body}");
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
    }
}

// ── /start: the first run, walked over HTTP ────────────────────────────────

const PREPARE_IPAC_FORM: &str = "expected_selector=usb%3Ad209%3A0430%3A00&\
instance_id=USB%5CVID_D209%26PID_0430%26MI_00%5C7%261A2B3C4D%260%260000&\
confirm_spare_keyboard=yes&confirm_rebind=yes&confirm_machine_certificate=yes";

const RELEASE_IPAC_FORM: &str = "expected_selector=usb%3Ad209%3A0430%3A00&\
instance_id=USB%5CVID_D209%26PID_0430%26MI_00%5C7%261A2B3C4D%260%260000&\
confirm_release=yes";

fn prepare_ipac(addr: SocketAddr) -> String {
    post_form(addr, "/start/capture/prepare", PREPARE_IPAC_FORM)
}

#[test]
fn start_gates_controls_describes_replacement_and_sanitizes_feedback_over_http() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));
    let fresh = rendered_body(&get(addr, "/start"));
    assert!(
        !fresh.contains(r#"href="/map?target=stage"#),
        "an empty setup offered Controls: {fresh}"
    );

    post_form(
        addr,
        "/start/device",
        "selector=usb%3Ad209%3A0430%3A00&alias=panel&label=I-PAC",
    );
    let chosen = rendered_body(&get(addr, "/start"));
    assert!(
        !chosen.contains(r#"href="/map?target=stage"#),
        "a keyboard without a controller offered Controls: {chosen}"
    );
    post_form(
        addr,
        "/start/controller",
        "persona=xbox360&preset=Player+1&layout=arcade-6button",
    );
    let staged = rendered_body(&get(addr, "/start"));
    assert!(
        staged.contains(r#"href="/map?target=stage&amp;slot=1""#),
        "the staged controller has no Controls action: {staged}"
    );

    control.running.store(true, Ordering::SeqCst);
    let running = rendered_body(&get(addr, "/start"));
    assert!(
        running.contains("stop that session and replace it with the setup on this screen"),
        "{running}"
    );
    assert!(
        !running.contains("Play will not replace what is running"),
        "{running}"
    );

    let hostile = rendered_body(&get(
        addr,
        "/start?flash=error%3A%20daemon%20pipe%20C%3A%5CUsers%5CTestUser%5C.ksx%20--preset%20claim",
    ));
    assert!(
        hostile.contains("Setup could not finish that request"),
        "{hostile}"
    );
    for raw in ["daemon pipe", r"C:\Users\TestUser", "--preset"] {
        assert!(
            !hostile.contains(raw),
            "raw flash fragment {raw:?}: {hostile}"
        );
    }

    let dead = start_server(Arc::new(ScriptedControl::dead()));
    let refused = post_form(
        dead,
        "/start/device",
        "selector=usb%3Ad209%3A0430%3A00&alias=panel&label=I-PAC",
    );
    // MIGRATED (2026-08-17): the keyboard verbs answer on /nocturne now —
    // the old form still works, but the outcome lands on the new page.
    assert!(
        refused.contains("location: /nocturne?flash=error"),
        "{refused}"
    );
    for raw in ["daemon", "pipe", "control%20channel", "%60ksx"] {
        assert!(
            !refused.contains(raw),
            "raw provider text {raw:?}: {refused}"
        );
    }
}

#[test]
fn capture_preparation_requires_all_consents_transitions_only_verified_exact_state_and_releases() {
    let control = Arc::new(ScriptedControl::new(false));
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(Arc::clone(&control), machine.clone());

    post_form(
        addr,
        "/start/device",
        "selector=usb%3Ad209%3A0430%3A00&alias=panel&label=I-PAC",
    );
    post_form(
        addr,
        "/start/controller",
        "persona=xbox360&preset=Player+1&layout=arcade-6button",
    );
    post_form(addr, "/start/blocking", "blocking=bound-keys");

    let before: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/start"))).expect("start payload");
    // This fixture's I-PAC is ALREADY held by WinUSB while `ChooseDevice`
    // staged the ordinary Interception path, so the card is the disagreement
    // one: no Prepare (the provider could only refuse it), no staged Release
    // (the stage does not say winusb), not ready — and the way back is the
    // held-keyboard list, which is keyed on the machine and not on the stage.
    //
    // FAILS against the QA build, where the same state offered "Prepare this
    // keyboard for play" over a keyboard Windows had already prepared and
    // drew no release control anywhere on the page.
    assert_eq!(before["flags"]["capture_prepare"], false, "{before}");
    assert_eq!(before["flags"]["capture_release"], false, "{before}");
    assert_eq!(before["flags"]["capture_blocked"], true, "{before}");
    assert_eq!(before["flags"]["has_prepared"], true, "{before}");
    assert_eq!(before["flags"]["ready"], false, "{before}");
    assert!(
        before["capture"].get("backend").is_none(),
        "the browser must never select a backend: {before}"
    );

    // A hand-authored Save/Play bypasses no readiness gate. The domain stage
    // is otherwise complete, so capture is the only remaining refusal.
    let save = post_form(addr, "/start/save", "");
    let play = post_form(addr, "/start/play", "");
    assert!(save.contains("not%20ready%20to%20save"), "{save}");
    assert!(play.contains("not%20ready%20to%20play"), "{play}");
    assert!(!control.committed.load(Ordering::SeqCst));
    assert!(!control.played.load(Ordering::SeqCst));

    // HTML `required` is convenience only. The server rejects a crafted form
    // missing even one consent and never calls the privileged provider.
    let missing = post_form(
        addr,
        "/start/capture/prepare",
        "expected_selector=usb%3Ad209%3A0430%3A00&\
         instance_id=USB%5CVID_D209%26PID_0430%26MI_00%5C7%261A2B3C4D%260%260000&\
         confirm_spare_keyboard=yes&confirm_rebind=yes",
    );
    assert!(missing.contains("Confirm%20all%20three"), "{missing}");
    assert!(machine.prepared_with.lock().unwrap().is_empty());
    assert_eq!(
        control.staged().device.unwrap().backend,
        "interception",
        "a refused consent changed the stage"
    );

    let prepared = prepare_ipac(addr);
    assert!(!prepared.contains("flash=error"), "{prepared}");
    for raw in ["generated.inf", "private%20provider", "--repair"] {
        assert!(
            !prepared.contains(raw),
            "provider/helper detail leaked through the redirect: {prepared}"
        );
    }
    let calls = machine.prepared_with.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].expected_selector, "usb:d209:0430:00");
    assert!(calls[0].instance_id.eq_ignore_ascii_case(IPAC_KB));
    assert!(calls[0].confirm_spare_keyboard);
    assert!(calls[0].confirm_rebind);
    assert!(calls[0].confirm_machine_certificate);
    drop(calls);
    assert_eq!(control.staged().device.unwrap().backend, "winusb");

    let ready: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/start"))).expect("ready start payload");
    assert_eq!(ready["flags"]["capture_prepare"], false, "{ready}");
    assert_eq!(ready["flags"]["capture_release"], true, "{ready}");
    assert_eq!(ready["flags"]["capture_blocked"], false, "{ready}");
    assert_eq!(ready["flags"]["ready"], true, "{ready}");

    let missing_release = post_form(
        addr,
        "/start/capture/release",
        "expected_selector=usb%3Ad209%3A0430%3A00&\
         instance_id=USB%5CVID_D209%26PID_0430%26MI_00%5C7%261A2B3C4D%260%260000",
    );
    assert!(
        missing_release.contains("Confirm%20that%20you%20want%20to%20release"),
        "{missing_release}"
    );
    assert!(machine.released_with.lock().unwrap().is_empty());
    assert_eq!(control.staged().device.unwrap().backend, "winusb");

    let released = post_form(addr, "/start/capture/release", RELEASE_IPAC_FORM);
    assert!(!released.contains("flash=error"), "{released}");
    assert_eq!(machine.released_with.lock().unwrap().len(), 1);
    assert_eq!(control.staged().device.unwrap().backend, "interception");
    let after: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/start"))).expect("released start payload");
    // Interception is available in this fixture, so release restores a ready
    // ordinary path while the same prepare card remains as the optional
    // built-in USB-mode choice.
    assert_eq!(after["flags"]["capture_prepare"], true, "{after}");
    assert_eq!(after["flags"]["capture_release"], false, "{after}");
    assert_eq!(after["flags"]["capture_blocked"], false, "{after}");
    assert_eq!(after["flags"]["ready"], true, "{after}");
}

/// **The way back does not go through the staged setup** — over real HTTP,
/// against the real router, with the daemon holding nothing at all.
///
/// This is the 2026-08-11 QA report as a test: "the release button only comes
/// up once I select a keyboard to bind... but the ipac was already bound and
/// it was not showing the unrelease."
///
/// FAILS against that build in both halves. The page drew no release control
/// with an empty stage, and `start_capture_target` refused the POST outright
/// because it resolved its target from `staged.device` — so even a
/// hand-written form could not reach the provider. A held keyboard does not
/// type, so that was a state whose only documented exit was `docs/RECOVERY.md`
/// and an elevated shell (`docs/FIRST-RUN.md` §6).
#[test]
fn a_held_keyboard_is_released_from_start_with_nothing_staged() {
    let control = Arc::new(ScriptedControl::new(false));
    let machine = Arc::new(ScriptedMachine::default());
    // The fixture's default: the I-PAC is already bound to winusb.sys. No
    // `/start/device` is posted below, so the daemon holds no device at all —
    // the fresh-install state, and the state a QA reset that moves config.toml
    // aside also produces, because the binding is Windows's and not the
    // config's.
    let addr = start_server_with_machine(Arc::clone(&control), machine.clone());

    let payload: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/start"))).expect("start payload");
    assert!(payload["staged"]["device"].is_null(), "{payload}");
    assert_eq!(payload["flags"]["has_prepared"], true, "{payload}");
    let row = &payload["rows"]["prepared"][0];
    assert_eq!(row["name"], "Ultimarc I-PAC 4X", "{payload}");
    assert_eq!(row["selector"], "usb:d209:0430:00", "{payload}");

    let page = rendered_body(&get(addr, "/start"));
    assert!(page.contains("Keyboards ksx is holding"), "{page}");
    assert!(
        page.contains(r#"action="/start/capture/release""#),
        "a held keyboard had no way back on a machine with nothing staged: {page}"
    );

    // Consent is still server-side, not an HTML `required` attribute, and a
    // form without it never reaches the privileged provider.
    let unconfirmed = post_form(
        addr,
        "/start/capture/release",
        "expected_selector=usb%3Ad209%3A0430%3A00&         instance_id=USB%5CVID_D209%26PID_0430%26MI_00%5C7%261A2B3C4D%260%260000",
    );
    assert!(
        unconfirmed.contains("Confirm%20that%20you%20want%20to%20release"),
        "{unconfirmed}"
    );
    assert!(machine.released_with.lock().unwrap().is_empty());

    // And identity is still re-resolved on the server: a selector this machine
    // does not carry is refused before elevation, rather than retargeted onto
    // the one board that happens to be held.
    let wrong = post_form(
        addr,
        "/start/capture/release",
        "expected_selector=usb%3A046d%3Ac31c%3A00&         instance_id=USB%5CVID_046D%26PID_C31C%26MI_00%5C7%26DEAD%260%260000&         confirm_release=yes",
    );
    assert!(wrong.contains("flash=error"), "{wrong}");
    assert!(machine.released_with.lock().unwrap().is_empty());

    let released = post_form(addr, "/start/capture/release", RELEASE_IPAC_FORM);
    assert!(!released.contains("flash=error"), "{released}");
    let calls = machine.released_with.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].expected_selector, "usb:d209:0430:00");
    assert!(calls[0].instance_id.eq_ignore_ascii_case(IPAC_KB));
    assert!(calls[0].confirm_release);
    drop(calls);
    // Nothing was staged before and nothing is staged now: releasing a board
    // is a machine action, not a setup edit.
    assert!(control.staged().device.is_none());

    let after: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/start"))).expect("released payload");
    assert_eq!(after["flags"]["has_prepared"], false, "{after}");
    assert_eq!(after["rows"]["prepared"].as_array().unwrap().len(), 0);
}

/// The same way back while a DIFFERENT keyboard is the selection — the second
/// state the QA build stranded, and the one where a stage-keyed control does
/// not merely disappear but points at the wrong board.
#[test]
fn releasing_a_held_keyboard_leaves_a_different_selection_alone() {
    let control = Arc::new(ScriptedControl::new(false));
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(Arc::clone(&control), machine.clone());

    // Select the Bluetooth keyboard: a real row in this scan, and one that can
    // never be WinUSB-held.
    let bt = form_value(BT_KEYBOARD);
    post_form(
        addr,
        "/start/device",
        &format!("selector={bt}&alias=desk&label=Bluetooth+Keyboard"),
    );
    let staged_selector = control.staged().device.expect("a staged device").selector;

    let payload: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/start"))).expect("start payload");
    assert_eq!(payload["flags"]["has_prepared"], true, "{payload}");
    assert_eq!(
        payload["rows"]["prepared"][0]["selector"], "usb:d209:0430:00",
        "the list followed the selection instead of the machine: {payload}"
    );

    let released = post_form(addr, "/start/capture/release", RELEASE_IPAC_FORM);
    assert!(!released.contains("flash=error"), "{released}");
    assert_eq!(machine.released_with.lock().unwrap().len(), 1);
    // The selection is untouched: releasing another board is not a setup edit,
    // and posting its backend would have refused and turned a release that
    // happened into an error flash.
    assert_eq!(
        control.staged().device.expect("still staged").selector,
        staged_selector
    );
}

#[test]
fn capture_preparation_refuses_stale_or_noncanonical_results_without_retargeting_stage() {
    let control = Arc::new(ScriptedControl::new(false));
    let machine = Arc::new(ScriptedMachine::default());
    machine.winusb_claimed.store(false, Ordering::SeqCst);
    let addr = start_server_with_machine(Arc::clone(&control), machine.clone());
    post_form(
        addr,
        "/start/device",
        "selector=usb%3Ad209%3A0430%3A00&alias=panel&label=I-PAC",
    );

    // A platform phase such as `active` is not the canonical MachineSource
    // result. Studio does not infer success from it or from helper copy.
    *machine.prepare_state.lock().unwrap() = Some("active".to_owned());
    let noncanonical = prepare_ipac(addr);
    assert!(noncanonical.contains("flash=error"), "{noncanonical}");
    assert!(!noncanonical.contains("active"), "{noncanonical}");
    assert!(!noncanonical.contains("generated.inf"), "{noncanonical}");
    assert_eq!(control.staged().device.unwrap().backend, "interception");

    *machine.prepare_state.lock().unwrap() = Some("recovery-required".to_owned());
    let recovery = prepare_ipac(addr);
    assert!(recovery.contains("may%20need%20recovery"), "{recovery}");
    assert!(!recovery.contains("private%20provider"), "{recovery}");
    assert_eq!(control.staged().device.unwrap().backend, "interception");

    // Even canonical state cannot license a different returned interface.
    *machine.prepare_state.lock().unwrap() = Some("prepared".to_owned());
    *machine.prepare_instance.lock().unwrap() = Some(r"USB\VID_0000&PID_0000\OTHER".to_owned());
    let wrong_instance = prepare_ipac(addr);
    assert!(wrong_instance.contains("flash=error"), "{wrong_instance}");
    assert!(!wrong_instance.contains("VID_0000"), "{wrong_instance}");
    assert_eq!(control.staged().device.unwrap().backend, "interception");

    let calls_before_stale = machine.prepared_with.lock().unwrap().len();
    let missing_target = post_form(
        addr,
        "/start/capture/prepare",
        "confirm_spare_keyboard=yes&confirm_rebind=yes&confirm_machine_certificate=yes",
    );
    assert!(
        missing_target.starts_with("HTTP/1.1 303"),
        "{missing_target}"
    );
    assert!(
        missing_target.contains("selected%20keyboard%20changed"),
        "{missing_target}"
    );
    let stale = post_form(
        addr,
        "/start/capture/prepare",
        "expected_selector=usb%3Ad209%3A0430%3A01&\
         instance_id=USB%5CVID_D209%26PID_0430%26MI_01%5C7%261A2B3C4D%260%260001&\
         confirm_spare_keyboard=yes&confirm_rebind=yes&confirm_machine_certificate=yes",
    );
    assert!(stale.contains("selected%20keyboard%20changed"), "{stale}");
    assert_eq!(
        machine.prepared_with.lock().unwrap().len(),
        calls_before_stale,
        "a stale browser target reached the privileged provider"
    );
    assert_eq!(control.staged().device.unwrap().backend, "interception");
}

/// **`docs/FIRST-RUN.md` §7 as far as HTTP can carry it**: the four moments a
/// browser performs, in order, against the real router and the real staging
/// domain — no terminal, no file editing, and nothing typed but a click.
///
/// This is the journey the shipped page could not complete honestly. It fails
/// against the version at `179324e` in three separate places:
///
///  1. `/start/controller` staged an EMPTY preset, so the setup was `ready`
///     the moment a persona was picked and `/start/play` started a pad on
///     which every button was dead;
///  2. the split-or-freeze question was never required, so both buttons were
///     live with it unanswered and Save wrote `block_keyboards = "whole"`
///     from an answer nobody gave;
///  3. there was no way at all to give a staged controller individual
///     bindings or macros — the mapper only edited files this flow had not
///     written.
///
/// The `played` flag is the load-bearing assertion: it proves a refused Play
/// started NOTHING, rather than merely that the flash looked unhappy.
#[test]
fn the_first_run_journey_stages_maps_answers_and_only_then_plays() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));

    // Moment 4 — a keyboard, posted as the SERVED selector. Nothing typed.
    let response = post_form(
        addr,
        "/start/device",
        "selector=usb%3Ad209%3A0430%3A00&alias=panel&label=Ultimarc+I-PAC+4",
    );
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    // This fixture's I-PAC begins already bound to WinUSB while the staged
    // choice starts on the compatible Interception default. The explicit
    // preparation closes that gap and proves the no-terminal clean path.
    let response = prepare_ipac(addr);
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(!response.contains("flash=error"), "{response}");

    // Moment 5 + 6's menu half — a controller AND the layout it starts from,
    // in one click, which is what the form posts.
    let response = post_form(
        addr,
        "/start/controller",
        "persona=xbox360&preset=Player+1&layout=arcade-6button",
    );
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");

    // The bindings are really in the stage — no file was written to get them.
    let page = get(addr, "/start");
    assert!(page.contains("controls bound"), "{page}");
    assert!(
        !page.contains("nothing mapped yet"),
        "a controller staged from a layout binds something: {page}"
    );

    // Moment 6's full editor half — the SAME mapper as a saved layout, aimed
    // at the in-memory stage. The read says which target it is showing.
    let map: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/map?target=stage&slot=1")))
            .expect("staged mapper json");
    assert_eq!(map["target"], "stage", "{map}");
    assert_eq!(map["mapper"]["slots"][0]["preset"], "Player 1", "{map}");

    // Multi-key, turbo-capable binding writes land in the stage and nowhere
    // else. Two keys here is intentional: the old one-key daemon verb cannot
    // make this pass by accident.
    let bound: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/api/bind/keys",
        r#"{"target":"stage","slot":1,"preset":"Player 1","function":"A",
            "keys":["H","Enter"],"turbo_hz":12,"reload":true}"#,
    )))
    .expect("staged binding outcome");
    assert_eq!(bound["ok"], true, "{bound}");
    assert_eq!(bound["reloaded"], false, "staging never reloads: {bound}");
    assert!(
        control.bound_with.lock().unwrap().is_none(),
        "the saved-layout writer was called for an unsaved setup"
    );

    // A plain HTML form preserves that destination too. It adds one key to
    // the staged set and redirects back to the staged URL.
    let response = post_form(addr, "/map/add", "target=stage&slot=1&function=A&key=J");
    assert!(
        response.contains("location: /map?target=stage&slot=1"),
        "{response}"
    );

    // Macro body and trigger use the same target. Neither a disk backup nor a
    // live reload may be claimed for an in-memory change.
    let macro_saved: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/api/macro/save",
        r#"{"target":"stage","slot":1,"preset":"Player 1","name":"dash",
            "steps":[{"hold":["A"],"ms":50}]}"#,
    )))
    .expect("staged macro outcome");
    assert_eq!(macro_saved["ok"], true, "{macro_saved}");
    assert_eq!(
        macro_saved["backup"],
        serde_json::Value::Null,
        "{macro_saved}"
    );
    assert_eq!(macro_saved["reloaded"], false, "{macro_saved}");
    assert!(control.saved_macro.lock().unwrap().is_none());

    let trigger: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/api/bind/keys",
        r#"{"target":"stage","slot":1,"preset":"Player 1",
            "function":"macro.dash","keys":["M"],"reload":true}"#,
    )))
    .expect("staged macro trigger outcome");
    assert_eq!(trigger["ok"], true, "{trigger}");

    let mapped: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/map?target=stage&slot=1")))
            .expect("refreshed staged mapper json");
    assert_eq!(
        mapped["mapper"]["slots"][0]["bindings"]["A"],
        serde_json::json!(["H", "Enter", "J"]),
        "{mapped}"
    );
    assert_eq!(mapped["macros"]["macros"][0]["name"], "dash", "{mapped}");
    assert_eq!(
        mapped["macros"]["macros"][0]["triggers"],
        serde_json::json!(["M"]),
        "{mapped}"
    );

    // A stale tab is never redirected to Player 1. Reads keep the requested
    // number visible as unavailable; every JSON and plain-form write refuses
    // with the same target intact and leaves the live draft byte-for-byte
    // equivalent at the API seam.
    let stale_read: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/map?target=stage&slot=9")))
            .expect("stale staged mapper json");
    assert_eq!(stale_read["selected"], 9, "{stale_read}");
    assert!(
        stale_read["mapper"]["slots"].as_array().unwrap().is_empty(),
        "a missing player must not paint Player 1: {stale_read}"
    );

    for request in [
        r#"{"target":"stage","preset":"Player 1","function":"B","keys":["K"]}"#,
        r#"{"target":"stage","slot":9,"preset":"Player 1","function":"B","keys":["K"]}"#,
    ] {
        let refused: serde_json::Value =
            serde_json::from_str(body_of(&post_json(addr, "/api/bind/keys", request)))
                .expect("stale binding refusal");
        assert_eq!(refused["ok"], false, "{refused}");
        assert_eq!(refused["code"], ksx_api::codes::BAD_SLOT, "{refused}");
    }
    for request in [
        r#"{"target":"stage","preset":"Player 1","name":"dash","enabled":false}"#,
        r#"{"target":"stage","slot":9,"preset":"Player 1","name":"dash","enabled":false}"#,
    ] {
        let refused: serde_json::Value =
            serde_json::from_str(body_of(&post_json(addr, "/api/macro/save", request)))
                .expect("stale macro refusal");
        assert_eq!(refused["ok"], false, "{refused}");
        assert_eq!(refused["code"], ksx_api::codes::BAD_SLOT, "{refused}");
    }
    for (path, form) in [
        ("/map/bind", "target=stage&slot=9&function=B&key=K"),
        ("/map/add", "target=stage&slot=9&function=B&key=K"),
        ("/map/key/remove", "target=stage&slot=9&function=A&key=H"),
        ("/map/clear", "target=stage&slot=9&function=B"),
        ("/map/turbo", "target=stage&slot=9&function=A&turbo_hz=10"),
    ] {
        let stale_form = post_form(addr, path, form);
        assert!(
            stale_form.contains("location: /map?target=stage&slot=9"),
            "{path}: {stale_form}"
        );
    }
    let after_stale: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/map?target=stage&slot=1")))
            .expect("unchanged staged mapper json");
    assert_eq!(after_stale["mapper"], mapped["mapper"]);
    assert_eq!(after_stale["macros"], mapped["macros"]);

    // ...and Play is NOT offered yet, because §3 is unanswered.
    assert!(
        !page.contains(r#"action="/start/play""#),
        "Play was offered with the one question unanswered: {page}"
    );
    assert!(page.contains("split-or-freeze"), "{page}");
    assert!(
        page.contains("Not asked yet"),
        "and it must still not be pre-answered: {page}"
    );

    // A hand-made POST to Play — the thing a disabled button cannot stop — is
    // refused by the DOMAIN, and starts nothing.
    let response = post_form(addr, "/start/play", "");
    assert!(
        response.contains("flash=error"),
        "Play was accepted with §3 unanswered: {response}"
    );
    assert!(
        response.contains("not%20ready%20to%20play"),
        "the refusal must give a safe next step: {response}"
    );
    assert!(
        !response.contains("split-or-freeze"),
        "the provider's internal refusal leaked through the Studio boundary: {response}"
    );
    assert!(
        !control.played.load(Ordering::SeqCst),
        "a refused Play started a session"
    );
    // Save is refused for the same reason, so it cannot write Freeze either.
    let response = post_form(addr, "/start/save", "");
    assert!(response.contains("flash=error"), "{response}");
    assert!(response.contains("not%20ready%20to%20save"), "{response}");

    // Moment 6's question, answered — with SPLIT, the answer a default would
    // never have produced.
    let response = post_form(addr, "/start/blocking", "blocking=bound-keys");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");

    let page = get(addr, "/start");
    assert!(page.contains(r#"action="/start/play""#), "{page}");
    assert!(page.contains(r#"action="/start/save""#), "{page}");
    assert!(page.contains("Answered: Split this keyboard."), "{page}");

    // Moment 7.
    let response = post_form(addr, "/start/play", "");
    assert!(
        !response.contains("flash=error"),
        "a complete setup was refused: {response}"
    );
    assert!(control.played.load(Ordering::SeqCst), "{response}");
}

/// The API carries the full build roster and a narrower picker at the same
/// time. Once the one-host DualSense is staged, a second one is absent from
/// the real `/start` form and a handcrafted POST still cannot bypass the
/// domain limit.
#[test]
fn start_keeps_offering_dualsense_after_the_first_over_http() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));
    post_form(
        addr,
        "/start/device",
        "selector=usb%3Ad209%3A0430%3A00&alias=panel&label=I-PAC",
    );
    let first = post_form(
        addr,
        "/start/controller",
        "persona=dualsense&preset=Player+1&layout=keyboard-2p",
    );
    assert!(!first.contains("flash=error"), "{first}");

    let payload: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/start"))).expect("start payload");
    let dualsense = payload["staged"]["personas"]
        .as_array()
        .unwrap()
        .iter()
        .find(|option| option["name"] == "dualsense")
        .expect("the full roster keeps DualSense");
    assert_eq!(dualsense["can_plug"], true);
    assert_eq!(dualsense["backend"], "hidmaestro");
    // 2026-08-20: the multi-controller SDK host lifts the one-DualSense cap —
    // the offer stands after the first, and a second POST stages an ordinary
    // slot. The unavailable machinery stays wired for the next bounded
    // persona.
    assert_eq!(dualsense["instance_limit"], serde_json::Value::Null);
    assert_eq!(dualsense["available"], true);
    assert_eq!(dualsense["unavailable_reason"], serde_json::Value::Null);
    assert!(
        payload["rows"]["personas"]
            .as_array()
            .unwrap()
            .iter()
            .any(|option| option["value"] == "dualsense"),
        "the rendered option rows keep offering DualSense: {payload}"
    );
    assert!(payload["rows"]["personas"]
        .as_array()
        .unwrap()
        .iter()
        .any(|option| option["value"] == "playstation"));

    let page = rendered_body(&get(addr, "/start"));
    assert!(
        page.contains(r#"<option value="dualsense""#),
        "the HTML form must keep offering DualSense: {page}"
    );

    let second = post_form(
        addr,
        "/start/controller",
        "persona=dualsense&preset=Player+2&layout=keyboard-2p",
    );
    assert!(!second.contains("flash=error"), "{second}");
    assert_eq!(
        control.staged().slots.len(),
        2,
        "the second DualSense stages an ordinary slot"
    );
}

/// Saving writes no controller and therefore remains available when a required
/// output is missing or unreadable. Play has the stricter gate, repeated in
/// the handler so a hand-authored POST cannot bypass the page.
#[test]
fn controller_output_readiness_blocks_play_without_blocking_save() {
    for (mode, expected_state) in [(1, "blocked"), (2, "unknown")] {
        let control = Arc::new(ScriptedControl::new(false));
        let machine = Arc::new(ScriptedMachine::default());
        machine.output_mode.store(mode, Ordering::SeqCst);
        let addr = start_server_with_machine(Arc::clone(&control), machine);

        post_form(
            addr,
            "/start/device",
            "selector=usb%3Ad209%3A0430%3A00&alias=panel&label=I-PAC",
        );
        let prepared = prepare_ipac(addr);
        assert!(!prepared.contains("flash=error"), "{prepared}");
        post_form(
            addr,
            "/start/controller",
            "persona=xbox360&preset=Player+1&layout=arcade-6button",
        );
        post_form(addr, "/start/blocking", "blocking=bound-keys");

        let payload: serde_json::Value =
            serde_json::from_str(body_of(&get(addr, "/api/start"))).expect("start payload");
        assert_eq!(payload["controller_outputs"]["state"], expected_state);
        assert_eq!(payload["flags"]["can_save"], true);
        assert_eq!(payload["flags"]["can_play"], false);
        assert_eq!(payload["flags"]["cannot_save"], false);
        assert_eq!(payload["flags"]["cannot_play"], true);

        let save = post_form(addr, "/start/save", "");
        assert!(!save.contains("flash=error"), "{save}");
        assert!(control.committed.load(Ordering::SeqCst), "{save}");

        let play = post_form(addr, "/start/play", "");
        assert!(play.contains("flash=error"), "{play}");
        assert!(play.contains("ready%20to%20save"), "{play}");
        assert!(!control.played.load(Ordering::SeqCst), "{play}");
    }
}

/// **A controller with no layout is staged, refused by name, and fixable
/// without leaving the page.**
///
/// The blank layout is a real choice and it must stay reachable — but it is
/// the one that cannot play, and every screen and every verb has to say so in
/// the same words. Fails against any build where `/start/play` accepts a slot
/// whose preset binds nothing.
#[test]
fn a_controller_with_no_bindings_is_refused_by_name_and_fixed_in_place() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));

    post_form(
        addr,
        "/start/device",
        "selector=usb%3Ad209%3A0430%3A00&alias=panel&label=I-PAC",
    );
    let prepared = prepare_ipac(addr);
    assert!(!prepared.contains("flash=error"), "{prepared}");
    // The blank layout: every control listed, nothing bound.
    post_form(
        addr,
        "/start/controller",
        "persona=xbox360&preset=Player+1&layout=empty",
    );
    post_form(addr, "/start/blocking", "blocking=whole");

    let page = get(addr, "/start");
    assert!(
        page.contains("not ready — no controls are mapped"),
        "{page}"
    );
    assert!(
        !page.contains(r#"action="/start/play""#),
        "Play was offered for a pad that binds nothing: {page}"
    );

    let response = post_form(addr, "/start/play", "");
    assert!(response.contains("flash=error"), "{response}");
    assert!(
        response.contains("not%20ready%20to%20play"),
        "the refusal must give a customer-safe remedy: {response}"
    );
    assert!(
        !response.contains("slot%201"),
        "the provider's raw slot failure leaked through the Studio boundary: {response}"
    );
    assert!(!control.played.load(Ordering::SeqCst), "{response}");

    // The fix is on the page — one POST, no file, no mapper, no shell.
    let response = post_form(
        addr,
        "/start/controller/layout",
        "number=1&layout=arcade-6button",
    );
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    let page = get(addr, "/start");
    assert!(page.contains("controls bound"), "{page}");
    assert!(page.contains(r#"action="/start/play""#), "{page}");

    let response = post_form(addr, "/start/play", "");
    assert!(!response.contains("flash=error"), "{response}");
    assert!(control.played.load(Ordering::SeqCst), "{response}");
}

/// Every mutating `/start` route is behind the guard: a rebound host must not
/// be able to stage, save or start anything on this machine.
#[test]
fn the_start_routes_are_behind_the_guard() {
    let addr = start_server(Arc::new(ScriptedControl::new(false)));
    for path in [
        "/start/device",
        "/start/device/identify",
        "/start/capture/prepare",
        "/start/capture/release",
        "/start/controller",
        "/start/controller/persona",
        "/start/controller/layout",
        "/start/controller/remove",
        "/start/blocking",
        "/start/discard",
        "/start/save",
        "/start/play",
    ] {
        let response = http(
            addr,
            &format!(
                "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://evil.example\r\n\
                 Content-Type: application/x-www-form-urlencoded\r\n\
                 Content-Length: 0\r\nConnection: close\r\n\r\n"
            ),
        );
        assert!(
            response.starts_with("HTTP/1.1 403") || response.starts_with("HTTP/1.1 421"),
            "{path} accepted a cross-origin POST: {response}"
        );
    }
}

/// The browser's Identify action starts the daemon-owned learner, passes that
/// exact generation's observed interface to the machine inventory resolver,
/// and lets the ordinary stage writer own the reversible selection. It must
/// not require a path from the browser, open a competing local observer, or
/// mutate capture/output state.
#[test]
fn start_identify_selects_the_machine_providers_exact_board() {
    let control = Arc::new(ScriptedControl::new(false).with_identify_hit(IPAC_KB));
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(Arc::clone(&control), machine.clone());

    let page = get(addr, "/start");
    assert!(
        page.contains(r#"action="/start/device/identify""#),
        "{page}"
    );
    assert!(page.contains("Identify by pressing a key"), "{page}");

    let response = post_form(addr, "/start/device/identify", "");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(response.contains("Keyboard%20identified"), "{response}");

    let staged = control.staged();
    let selected = staged.device.expect("the identified keyboard is staged");
    assert_eq!(selected.label, "Ultimarc I-PAC 4X");
    assert_eq!(selected.alias, "panel");
    assert_eq!(selected.selector, "usb:d209:0430:00");
    assert!(
        staged.slots.is_empty(),
        "identify must not create a controller"
    );
    assert_eq!(
        *machine.identified_from.lock().unwrap(),
        vec![IPAC_KB.to_owned()],
        "the machine resolver must receive the daemon learner's exact identity"
    );
}

// ── /workspace — the left pane's form twins (M2) ────────────────────────────

/// The whole left pane, no JavaScript anywhere: stage a draft, reorder it,
/// set a slot's opposite-directions rule, answer the capture question, remove
/// a controller — every step one POST, every answer a 303 with an allowlisted
/// flash, every fact read back from the same payload the island polls.
#[test]
fn the_workspace_left_pane_edits_through_its_form_twins() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));

    // Stage a draft with /start's twins — one stage, two doors onto it.
    post_form(
        addr,
        "/start/device",
        "selector=usb%3Ad209%3A0430%3A00&alias=panel&label=I-PAC",
    );
    post_form(
        addr,
        "/start/controller",
        "persona=xbox360&preset=Player+1&layout=arcade-6button",
    );
    post_form(
        addr,
        "/start/controller",
        "persona=playstation&preset=Player+2&layout=arcade-6button",
    );

    let page = get(addr, "/workspace");
    assert!(page.contains("P1 · Xbox 360"), "{page}");
    assert!(page.contains("P2 · PlayStation"), "{page}");
    assert!(
        page.contains(r#"action="/workspace/controller/move""#),
        "{page}"
    );
    assert!(
        page.contains(r#"action="/workspace/controller/socd""#),
        "{page}"
    );
    assert!(page.contains(r#"action="/workspace/blocking""#), "{page}");

    // Reorder: one whole-order write, and the renumbering is the daemon's.
    let response = post_form(addr, "/workspace/controller/move", "number=1&order=2+1");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(response.contains("Draft%20updated"), "{response}");
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/workspace"))).expect("workspace payload");
    assert_eq!(api["view"]["rack"][0]["title"], "P1 · PlayStation", "{api}");
    assert_eq!(api["view"]["rack"][1]["title"], "P2 · Xbox 360", "{api}");

    // The first row's "Move up" is already at that end: no write, and the
    // honest sentence rather than an error.
    let response = post_form(addr, "/workspace/controller/move", "number=1&order=");
    assert!(response.contains("already%20at%20that%20end"), "{response}");

    // A slot's opposite-directions rule, in the served roster's own words.
    let response = post_form(
        addr,
        "/workspace/controller/socd",
        "number=1&socd=last-input",
    );
    assert!(response.contains("Draft%20updated"), "{response}");
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/workspace"))).expect("workspace payload");
    assert_eq!(
        api["view"]["rack"][0]["socd_note"], "Opposites: Last press wins",
        "{api}"
    );

    // The capture answer.
    let response = post_form(addr, "/workspace/blocking", "blocking=whole");
    assert!(response.contains("Draft%20updated"), "{response}");
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/workspace"))).expect("workspace payload");
    assert!(
        api["view"]["blocking_line"]
            .as_str()
            .unwrap()
            .starts_with("Freeze"),
        "{api}"
    );

    // Remove one; the rack shrinks and says so.
    let response = post_form(addr, "/workspace/controller/remove", "number=2");
    assert!(response.contains("Draft%20updated"), "{response}");
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/workspace"))).expect("workspace payload");
    assert_eq!(api["view"]["rack"].as_array().unwrap().len(), 1, "{api}");
    assert_eq!(api["view"]["rack_line"], "1 controller staged.", "{api}");

    // Add one back through the workspace's own form: served persona roster,
    // served layout roster, served preset name.
    let preset = api["view"]["add_preset"].as_str().expect("a served name");
    assert!(!preset.is_empty(), "{api}");
    let response = post_form(
        addr,
        "/workspace/controller",
        &format!(
            "persona=xbox360&preset={}&layout=arcade-6button",
            preset.replace(' ', "+")
        ),
    );
    assert!(response.contains("Draft%20updated"), "{response}");
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/workspace"))).expect("workspace payload");
    assert_eq!(api["view"]["rack"].as_array().unwrap().len(), 2, "{api}");
}

/// The workspace's Identify goes through the same daemon-owned transaction
/// as /start's, and lands its flash on THIS page.
#[test]
fn workspace_identify_selects_the_board_and_returns_here() {
    let control = Arc::new(ScriptedControl::new(false).with_identify_hit(IPAC_KB));
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(Arc::clone(&control), machine.clone());

    let page = get(addr, "/workspace");
    assert!(
        page.contains(r#"action="/workspace/device/identify""#),
        "{page}"
    );

    let response = post_form(addr, "/workspace/device/identify", "");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(response.contains("/workspace?flash="), "{response}");
    assert!(response.contains("Keyboard%20identified"), "{response}");
    let staged = control.staged();
    assert_eq!(
        staged
            .device
            .expect("the identified keyboard is staged")
            .label,
        "Ultimarc I-PAC 4X"
    );
}

/// Duplicate is a COMPOSITION of existing staging verbs, and the copy is
/// honest: same bindings, same opposite-directions rule, the served fresh
/// preset name — never the same name twice, because a save writes one file
/// per slot.
#[test]
fn duplicating_a_controller_copies_bindings_rule_and_takes_the_served_name() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));
    post_form(
        addr,
        "/start/device",
        "selector=usb%3Ad209%3A0430%3A00&alias=panel&label=I-PAC",
    );
    post_form(
        addr,
        "/start/controller",
        "persona=xbox360&preset=Player+1&layout=arcade-6button",
    );
    post_form(
        addr,
        "/workspace/controller/socd",
        "number=1&socd=last-input",
    );

    let response = post_form(addr, "/workspace/controller/duplicate", "number=1");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(response.contains("Controller%20duplicated"), "{response}");

    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/workspace"))).expect("workspace payload");
    let rack = api["view"]["rack"].as_array().unwrap();
    assert_eq!(rack.len(), 2, "{api}");
    assert_eq!(rack[1]["socd_note"], "Opposites: Last press wins", "{api}");
    // Same binding count, different preset name.
    let d0 = rack[0]["detail"].as_str().unwrap();
    let d1 = rack[1]["detail"].as_str().unwrap();
    assert_eq!(
        d0.split("· ").last(),
        d1.split("· ").last(),
        "the copy binds what the original binds: {api}"
    );
    assert!(
        d0.contains("Player 1") && !d1.contains("\"Player 1\""),
        "{api}"
    );

    let staged = control.staged();
    assert_eq!(staged.slots[0].bindings, staged.slots[1].bindings);
    assert_ne!(staged.slots[0].preset, staged.slots[1].preset);
}

/// `?slot=N` selection is a server-resolved LINK: the rack marks the row,
/// the right pane lists that controller's bindings, and the Clear twin puts
/// one control back to unbound — no JavaScript anywhere in the loop.
#[test]
fn selecting_a_slot_lists_its_bindings_and_clear_unbinds_one_control() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));
    post_form(
        addr,
        "/start/device",
        "selector=usb%3Ad209%3A0430%3A00&alias=panel&label=I-PAC",
    );
    post_form(
        addr,
        "/start/controller",
        "persona=xbox360&preset=Player+1&layout=arcade-6button",
    );
    post_form(
        addr,
        "/start/controller",
        "persona=playstation&preset=Player+2&layout=arcade-6button",
    );

    let page = get(addr, "/workspace?slot=2");
    assert!(page.contains("P2 · PlayStation — \"Player 2\""), "{page}");
    assert!(page.contains(r#"action="/workspace/bind/clear""#), "{page}");
    let api: serde_json::Value = serde_json::from_str(body_of(&get(addr, "/api/workspace?slot=2")))
        .expect("workspace payload");
    assert_eq!(api["view"]["rack"][1]["row_cls"], "wsrow on", "{api}");
    assert_eq!(
        api["view"]["pad_ps"], true,
        "the stage follows the selection"
    );
    let rows = api["view"]["bind_rows"].as_array().unwrap();
    assert_eq!(
        rows.len(),
        ksx_core::preset::MAPPABLE_COUNT,
        "one row per zone: {api}"
    );
    let bound_before = rows.iter().filter(|r| r["keys"] != "—").count();
    assert!(bound_before > 0, "{api}");
    let cleared_fn = rows
        .iter()
        .find(|r| r["keys"] != "—")
        .and_then(|r| r["function"].as_str())
        .unwrap()
        .to_owned();

    let response = post_form(
        addr,
        "/workspace/bind/clear",
        &format!("slot=2&function={}", cleared_fn.replace('.', "%2E")),
    );
    assert!(response.contains("Draft%20updated"), "{response}");
    let api: serde_json::Value = serde_json::from_str(body_of(&get(addr, "/api/workspace?slot=2")))
        .expect("workspace payload");
    let row = api["view"]["bind_rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["function"] == cleared_fn.as_str())
        .unwrap()
        .clone();
    assert_eq!(row["keys"], "—", "{api}");
    assert_eq!(row["clear"], "", "{api}");
}

/// The flash is an allowlist, not a reflector: whatever lands in the query,
/// only this module's own copy reaches the page.
#[test]
fn an_unknown_workspace_flash_is_never_reflected() {
    let addr = start_server(Arc::new(ScriptedControl::new(false)));
    let page = get(addr, "/workspace?flash=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
    assert!(!page.contains("alert(1)"), "{page}");
    assert!(
        page.contains("could not finish that request"),
        "the unknown-flash fallback must render: {page}"
    );
}

/// Every mutating `/workspace` route is behind the guard: a rebound host must
/// not be able to edit this machine's draft.
#[test]
fn the_workspace_routes_are_behind_the_guard() {
    let addr = start_server(Arc::new(ScriptedControl::new(false)));
    for path in [
        "/workspace/blocking",
        "/workspace/controller",
        "/workspace/controller/move",
        "/workspace/controller/duplicate",
        "/workspace/controller/remove",
        "/workspace/controller/socd",
        "/workspace/device/identify",
        "/workspace/bind/clear",
        "/workspace/adopt",
    ] {
        let response = http(
            addr,
            &format!(
                "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://evil.example\r\n\
                 Content-Type: application/x-www-form-urlencoded\r\n\
                 Content-Length: 0\r\nConnection: close\r\n\r\n"
            ),
        );
        assert!(
            response.starts_with("HTTP/1.1 403") || response.starts_with("HTTP/1.1 421"),
            "{path} accepted a cross-origin POST: {response}"
        );
    }
}

/// **The MIGRATED keyboard section, over HTTP.** `/nocturne` serves the
/// scan-backed device rows and the roster beside the placeholder half,
/// reflects only its own allowlisted flash copy, and its verbs — the same
/// handlers `/start`'s old routes now point at — answer on `/nocturne` with
/// every guard intact.
#[test]
fn nocturne_serves_the_migrated_keyboard_section_over_http() {
    let control = Arc::new(ScriptedControl::new(false));
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(Arc::clone(&control), machine.clone());

    // The page embeds its payload and renders the machine's board beside the
    // roster's own words and the design-proof placeholder half.
    let raw = get(addr, "/nocturne");
    assert!(
        body_of(&raw).contains("__ksx-payload"),
        "payload block missing"
    );
    let page = rendered_body(&raw);
    assert!(page.contains("I-PAC"), "{page}");
    assert!(page.contains("Freeze this keyboard"), "{page}");
    // Pass 2: the rack caption and the escape hatch are served facts now,
    // and the design proof's invented values are gone.
    assert!(page.contains("XInput"), "{page}");
    assert!(page.contains("LeftCtrl five times"), "{page}");
    assert!(!page.contains("16 of 24 inputs bound"), "{page}");

    // The canvas contract: the keyboard widget is SERVED carrying the exact
    // attributes the engine's mountItem would write, so adoption is a no-op
    // for parity. Losing any of these breaks the canvas silently — the
    // island would still hydrate, the engine would just restyle the article
    // one frame later and the parity gate would light up instead of this.
    for pin in [
        r#"data-instance-id="keyboard""#,
        "data-widget-navigation-item",
        r#"data-canvas-preferred-width="980""#,
        r#"data-canvas-resizable="false""#,
        "widget-instance n-widget n-widget-kb",
        "widget-drag-handle",
    ] {
        assert!(
            page.contains(pin),
            "served keyboard widget lost {pin:?}: {page}"
        );
    }
    // And the client-built side of the same contract: controller widgets
    // must NOT be served (their SSR absence is parity rule 3e).
    assert!(!page.contains("data-client-widget"), "{page}");

    // Only copy this page can emit is reflected back onto it.
    let hostile = rendered_body(&get(
        addr,
        "/nocturne?flash=error%3A%20daemon%20pipe%20C%3A%5Cksx%20--secret%20claim",
    ));
    assert!(hostile.contains("could not be finished"), "{hostile}");
    for raw in ["daemon pipe", "--secret", r"C:\ksx"] {
        assert!(
            !hostile.contains(raw),
            "raw flash fragment {raw:?}: {hostile}"
        );
    }

    // Picking a board IS the old "Use this device": one staged value.
    let picked = post_form(
        addr,
        "/nocturne/device",
        "selector=usb%3Ad209%3A0430%3A00&alias=panel&label=I-PAC",
    );
    assert!(
        picked.contains("location: /nocturne?flash=Keyboard%20selected"),
        "{picked}"
    );
    assert_eq!(
        control.staged().device.expect("staged device").selector,
        "usb:d209:0430:00"
    );

    // The capture answer carries its own sentence, not the device one…
    let blocked = post_form(addr, "/nocturne/blocking", "blocking=bound-keys");
    assert!(
        blocked.contains("Capture%20behaviour%20updated"),
        "{blocked}"
    );
    assert_eq!(control.staged().blocking.as_deref(), Some("bound-keys"));
    // …and a junk answer refuses without touching the staged one.
    let junk = post_form(addr, "/nocturne/blocking", "blocking=everything");
    assert!(junk.contains("flash=error"), "{junk}");
    assert_eq!(control.staged().blocking.as_deref(), Some("bound-keys"));

    // A crafted prepare missing a consent never reaches the provider — the
    // same server-side validation the old card had, behind the new fold.
    let missing = post_form(
        addr,
        "/nocturne/capture/prepare",
        "expected_selector=usb%3Ad209%3A0430%3A00&         instance_id=USB%5CVID_D209%26PID_0430%26MI_00%5C7%261A2B3C4D%260%260000&         confirm_spare_keyboard=yes&confirm_machine_certificate=yes",
    );
    assert!(missing.contains("Confirm%20all%20three"), "{missing}");
    assert!(machine.prepared_with.lock().unwrap().is_empty());

    // The poller serves the same derived facts the page painted.
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne"))).expect("nocturne payload");
    assert!(
        api["view"]["kb_title"]
            .as_str()
            .expect("kb_title")
            .contains("I-PAC"),
        "{api}"
    );
    assert!(
        !api["view"]["mode_rows"]
            .as_array()
            .expect("mode rows")
            .is_empty(),
        "{api}"
    );

    // A dead daemon refuses in the page's own words, with nothing raw.
    let dead = start_server(Arc::new(ScriptedControl::dead()));
    let refused = post_form(dead, "/nocturne/blocking", "blocking=bound-keys");
    assert!(
        refused.contains("location: /nocturne?flash=error"),
        "{refused}"
    );
}

/// The nocturne pane's six controller groups, flattened back into one row
/// list for tests that search across the whole pane.
fn nocturne_bind_rows(api: &serde_json::Value) -> Vec<serde_json::Value> {
    [
        "bind_face",
        "bind_dpad",
        "bind_shoulders",
        "bind_lstick",
        "bind_rstick",
        "bind_system",
    ]
    .iter()
    .flat_map(|k| api["view"][k].as_array().cloned().unwrap_or_default())
    .collect()
}

/// **The MIGRATED rebind editor, over HTTP.** The learner's JSON trio
/// answers from its new home with generation-stamped states; the staged bind
/// verb resolves the slot's preset identity and current key list server-side
/// (a browser is never trusted with a key list it made up); a cross-slot
/// duplicate refuses with the typed conflict rows until `force` says yes;
/// and the turbo/toggle form twins carry every guard in allowlisted words.
#[test]
fn nocturne_serves_the_migrated_rebind_editor_over_http() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));

    // A real staged draft, seeded through the same edits the daemon applies:
    // a board, a dressed first controller, an empty second one.
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
            persona: "xbox360".into(),
            preset: "Player 2".into(),
            layout: None,
        },
    ] {
        let out = control.stage_edit(&edit);
        assert!(out.ok, "seed edit refused: {:?}", out.error);
    }

    // The learner's trio, from its new home.
    let started: serde_json::Value =
        serde_json::from_str(body_of(&post_json(addr, "/api/learn/start", "{}")))
            .expect("learn start");
    assert_eq!(started["state"], "listening", "{started}");
    let generation = started["generation"].as_u64().expect("generation");
    let polled: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/learn"))).expect("learn poll");
    assert_eq!(polled["generation"].as_u64(), Some(generation), "{polled}");
    let cancelled: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/api/learn/cancel",
        &format!("{{\"generation\":{generation}}}"),
    )))
    .expect("learn cancel");
    assert_eq!(cancelled["state"], "cancelled", "{cancelled}");

    // The rows the page serves are where the test finds its targets — never
    // hardcoded to a layout's private details.
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne"))).expect("payload");
    let rows = nocturne_bind_rows(&api);
    assert!(!rows.is_empty(), "{api}");
    // The six controller groups carry every zone exactly once — bound
    // controls as rows, FREE ones as the group's available chips: face 4,
    // D-pad 4, shoulders & triggers 4, each stick 5 (hub + four
    // directions), system 3.
    for (group, avail, count) in [
        ("bind_face", "avail_ctl_face", 4),
        ("bind_dpad", "avail_ctl_dpad", 4),
        ("bind_shoulders", "avail_ctl_shoulders", 4),
        ("bind_lstick", "avail_ctl_lstick", 5),
        ("bind_rstick", "avail_ctl_rstick", 5),
        ("bind_system", "avail_ctl_system", 3),
    ] {
        let bound = api["view"][group].as_array().expect(group).len();
        let free = api["view"][avail].as_array().expect(avail).len();
        assert_eq!(bound + free, count, "{group}: {api}");
    }
    let free_total: usize = [
        "avail_ctl_face",
        "avail_ctl_dpad",
        "avail_ctl_shoulders",
        "avail_ctl_lstick",
        "avail_ctl_rstick",
        "avail_ctl_system",
    ]
    .iter()
    .map(|k| api["view"][k].as_array().expect(k).len())
    .sum();
    assert_eq!(
        rows.len() + free_total,
        ksx_core::preset::MAPPABLE_COUNT,
        "bound plus free is the whole vocabulary: {api}"
    );
    assert!(
        api["view"]["bind_face_n"]
            .as_str()
            .is_some_and(|n| n.ends_with("bound")),
        "{api}"
    );
    // The groups wrapper carries the selected slot's ramp digit (the
    // dots wear its shade), and the board wrapper tints with it too.
    assert_eq!(api["view"]["bind_g_cls"], "n-bindgroups np1", "{api}");
    assert_eq!(api["view"]["kb_cls"], "n-kb np1", "{api}");
    // Idle: no across-the-room word.
    assert_eq!(api["view"]["stage_word"], "", "{api}");
    let bound_fn = rows
        .iter()
        .find(|r| r["chip"] != "Unbound")
        .expect("a bound row")["function"]
        .as_str()
        .expect("function")
        .to_owned();
    // Unbound controls are the groups' FREE chips now, not rows.
    let unbound_fn = [
        "avail_ctl_face",
        "avail_ctl_dpad",
        "avail_ctl_shoulders",
        "avail_ctl_lstick",
        "avail_ctl_rstick",
        "avail_ctl_system",
    ]
    .iter()
    .find_map(|k| api["view"][k].as_array().and_then(|chips| chips.first()))
    .expect("a free control chip")["function"]
        .as_str()
        .expect("function")
        .to_owned();

    // Replace, resolved server-side: slot number in, preset identity found.
    let replaced: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/nocturne/api/bind",
        &format!("{{\"slot\":1,\"function\":\"{unbound_fn}\",\"key\":\"F7\"}}"),
    )))
    .expect("bind outcome");
    assert_eq!(replaced["ok"], true, "{replaced}");
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne"))).expect("payload");
    let row = nocturne_bind_rows(&api)
        .into_iter()
        .find(|r| r["function"] == unbound_fn.as_str())
        .expect("edited row");
    assert_eq!(row["chip"], "F7", "{row}");

    // Adding a key the control already has refuses in words, changes nothing.
    let dup: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/nocturne/api/bind",
        &format!("{{\"slot\":1,\"function\":\"{unbound_fn}\",\"key\":\"F7\",\"mode\":\"add\"}}"),
    )))
    .expect("dup outcome");
    assert_eq!(dup["ok"], false, "{dup}");
    assert!(
        dup["error"]
            .as_str()
            .is_some_and(|error| error.contains("already has")),
        "{dup}"
    );

    // A cross-slot duplicate: Player 2 asking for Player 1's key refuses
    // with the typed conflict rows…
    let conflicted: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/nocturne/api/bind",
        &format!("{{\"slot\":2,\"function\":\"{unbound_fn}\",\"key\":\"F7\"}}"),
    )))
    .expect("conflict outcome");
    assert_eq!(conflicted["ok"], false, "{conflicted}");
    assert_eq!(conflicted["code"], "conflict", "{conflicted}");
    assert!(
        !conflicted["conflicts"].as_array().expect("rows").is_empty(),
        "{conflicted}"
    );
    // …until force — the dialog's "Use here too" — says yes to the fan-out.
    let forced: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/nocturne/api/bind",
        &format!("{{\"slot\":2,\"function\":\"{unbound_fn}\",\"key\":\"F7\",\"force\":true}}"),
    )))
    .expect("forced outcome");
    assert_eq!(forced["ok"], true, "{forced}");

    // A slot this draft does not have refuses with authored copy.
    let missing: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/nocturne/api/bind",
        "{\"slot\":9,\"function\":\"a\",\"key\":\"F8\"}",
    )))
    .expect("missing outcome");
    assert_eq!(missing["ok"], false, "{missing}");
    assert!(
        missing["error"]
            .as_str()
            .is_some_and(|error| error.contains("no longer in this unsaved setup")),
        "{missing}"
    );

    // The turbo twin: sets a rate on a bound control…
    let set = post_form(
        addr,
        "/nocturne/bind/turbo",
        &format!("slot=1&function={bound_fn}&turbo_hz=9"),
    );
    assert!(set.contains("Auto-fire%20updated"), "{set}");
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne"))).expect("payload");
    let row = nocturne_bind_rows(&api)
        .into_iter()
        .find(|r| r["function"] == bound_fn.as_str())
        .expect("turbo row");
    assert!(
        row["badge"]
            .as_str()
            .is_some_and(|badge| badge.ends_with("/s")),
        "{row}"
    );
    assert!(!row["turbo"].as_str().unwrap_or("").is_empty(), "{row}");
    // …refuses a blank or non-numeric rate before any write…
    let junk = post_form(
        addr,
        "/nocturne/bind/turbo",
        &format!("slot=1&function={bound_fn}&turbo_hz=fast"),
    );
    assert!(junk.contains("Type%20a%20number"), "{junk}");
    // …and refuses an unbound control instead of inventing a write. (The
    // second slot's rows are all unbound except the forced F7.)
    let hollow = post_form(addr, "/nocturne/bind/turbo", "slot=2&function=a&turbo_hz=9");
    assert!(hollow.contains("nothing%20to%20auto-fire"), "{hollow}");

    // The toggle twin: latch on, in allowlisted words, visible in the row…
    let latched = post_form(
        addr,
        "/nocturne/bind/toggle",
        &format!("slot=1&function={bound_fn}&mode=toggle"),
    );
    assert!(latched.contains("Press%20behaviour%20updated"), "{latched}");
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne"))).expect("payload");
    let row = nocturne_bind_rows(&api)
        .into_iter()
        .find(|r| r["function"] == bound_fn.as_str())
        .expect("toggle row");
    assert!(
        row["badge"]
            .as_str()
            .is_some_and(|badge| badge.contains("Toggle")),
        "{row}"
    );
    assert_eq!(row["tog_cls"], "n-bpill on", "{row}");
    assert_eq!(row["hold_cls"], "n-bpill", "{row}");
    // …back to hold…
    let held = post_form(
        addr,
        "/nocturne/bind/toggle",
        &format!("slot=1&function={bound_fn}&mode=hold"),
    );
    assert!(held.contains("Press%20behaviour%20updated"), "{held}");
    // …an unbound control refuses…
    let hollow = post_form(
        addr,
        "/nocturne/bind/toggle",
        "slot=2&function=b&mode=toggle",
    );
    assert!(hollow.contains("nothing%20to%20hold"), "{hollow}");
    // …and a junk mode refuses without reaching the stage.
    let blink = post_form(
        addr,
        "/nocturne/bind/toggle",
        &format!("slot=1&function={bound_fn}&mode=blink"),
    );
    assert!(blink.contains("flash=error"), "{blink}");

    // A rate or latch edit on a key deliberately SHARED across players
    // re-affirms the existing list, it does not ask for a new fan-out — it
    // must not re-trip the cross-slot conflict (F7 is on both players now).
    let shared_turbo = post_form(
        addr,
        "/nocturne/bind/turbo",
        &format!("slot=1&function={unbound_fn}&turbo_hz=5"),
    );
    assert!(
        shared_turbo.contains("Auto-fire%20updated"),
        "{shared_turbo}"
    );
    let shared_latch = post_form(
        addr,
        "/nocturne/bind/toggle",
        &format!("slot=1&function={unbound_fn}&mode=toggle"),
    );
    assert!(
        shared_latch.contains("Press%20behaviour%20updated"),
        "{shared_latch}"
    );
}

/// **The MIGRATED macro lifecycle, over HTTP.** The macro rows are the
/// staged authoring's own facts; the moved /api/macro/save authors into the
/// **A MACRO TRIGGER IS A BINDING TOO.** `MapperSlot.bindings` is built from
/// the preset's CONTROL entries, and a trigger lives in a different table with
/// no `Binding` variant — so every read that inverted `bindings` was blind to
/// triggers. Two things broke on that: "add another trigger key" appended to a
/// list it could not see, which is a REPLACE, and the key that starts a macro
/// painted unbound on a board that shows every other binding.
#[test]
fn nocturne_treats_a_macro_trigger_as_a_binding() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));
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

    let bind = |key: &str, mode: &str| -> serde_json::Value {
        serde_json::from_str(body_of(&post_json(
            addr,
            "/nocturne/api/bind",
            &format!(
                "{{\"slot\":1,\"function\":\"macro.combo\",\"key\":\"{key}\",\"mode\":\"{mode}\"}}"
            ),
        )))
        .expect("bind")
    };
    let triggers = || -> String {
        let api: serde_json::Value =
            serde_json::from_str(body_of(&get(addr, "/api/nocturne?slot=1"))).expect("payload");
        api["view"]["macro_rows"][0]["chip"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    };

    assert_eq!(bind("P", "replace")["ok"], true);
    assert_eq!(triggers(), "P");
    // THE REPORT: `add` must JOIN the list, not stand in for it.
    assert_eq!(bind("O", "add")["ok"], true);
    assert_eq!(triggers(), "P · O", "a second trigger key JOINS the first");
    // …and one can be taken off again without losing the other.
    assert_eq!(bind("P", "remove")["ok"], true);
    assert_eq!(triggers(), "O");
    assert_eq!(bind("P", "add")["ok"], true);

    // THE BOARD: a key that starts a macro is bound like any other.
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne?slot=1"))).expect("payload");
    let cell = [
        "kb_row1", "kb_row2", "kb_row3", "kb_row4", "kb_row5", "kb_row6",
    ]
    .iter()
    .filter_map(|row| api["view"][row].as_array())
    .flatten()
    .find(|c| c["key"] == "O")
    .expect("O is on the board")
    .clone();
    let cls = cell["cls"].as_str().unwrap_or_default();
    assert!(cls.contains("bound"), "a trigger key paints bound: {cell}");
    assert!(
        cls.contains(" bn1"),
        "and wears its controller's color: {cell}"
    );
    assert_eq!(cell["short"], "M", "{cell}");
    assert!(
        cell["title"].as_str().is_some_and(|t| t.contains("combo")),
        "and says WHICH macro it starts: {cell}"
    );
    // …so it is no longer offered as a key nobody is using.
    for grid in ["avail_main", "avail_nav", "avail_num"] {
        let free = api["view"][grid].as_array().cloned().unwrap_or_default();
        assert!(
            !free.iter().any(|c| c["cap"] == "O" || c["key"] == "O"),
            "{grid} still offers a bound trigger key as free"
        );
    }

    // THE PER-KEY CLEAR acts on what the row says it drives.
    let cleared = post_form(addr, "/nocturne/key/clear", "number=1&key=O");
    assert!(!cleared.contains("flash=error"), "{cleared}");
    assert_eq!(
        triggers(),
        "P",
        "the ✕ took the trigger off, and only that one"
    );
}

/// **A macro is authored and edited without leaving the page**: the New twin
/// writes the smallest table `save_macro` accepts, and the edit door applies
/// ONE act to a draft the browser is holding and hands back the roll that
/// draws it — the same composition SSR paints, so the two cannot drift.
#[test]
fn nocturne_authors_and_edits_a_macro_over_http() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));
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

    // A name is what the table is CALLED, so a blank one is refused in words.
    let blank = post_form(addr, "/nocturne/macro/new", "slot=1&name=%20%20");
    assert!(
        blank.contains("flash=error"),
        "a blank name is answered, not swallowed: {blank}"
    );

    let made = post_form(addr, "/nocturne/macro/new", "slot=1&name=combo");
    assert!(made.contains("flash="), "{made}");
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne?macro=combo"))).expect("payload");
    let mac = api["view"]["mac"].clone();
    assert_eq!(mac["open"], true, "the editor opens on what was just made");
    assert_eq!(
        mac["rows"].as_array().expect("rows").len(),
        1,
        "one step, holding nothing — the smallest legal table: {mac}"
    );
    assert_eq!(
        mac["table"]["steps"][0]["hold"]
            .as_array()
            .expect("hold")
            .len(),
        0
    );

    // ONE act, applied to the draft the browser holds.
    let draft = mac["table"].clone();
    let edited: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/nocturne/api/macro/edit",
        &format!("{{\"slot\":1,\"act\":\"cell|0|diag:dpad:dr\",\"draft\":{draft}}}"),
    )))
    .expect("edit");
    assert_eq!(edited["ok"], true, "{edited}");
    assert_eq!(
        edited["draft"]["steps"][0]["hold"],
        serde_json::json!(["dpad.down", "dpad.right"]),
        "a diagonal pick writes the PAIR, because that is what a diagonal is          in the file: {edited}"
    );
    assert!(
        edited["said"]
            .as_str()
            .is_some_and(|s| s.contains("dpad.down + dpad.right")),
        "…and it says so, naming both halves: {edited}"
    );
    // The roll that comes back is the SAME composition SSR paints.
    let lit: Vec<&str> = edited["view"]["cells"]
        .as_array()
        .expect("cells")
        .iter()
        .filter(|c| {
            c["cls"]
                .as_str()
                .is_some_and(|cls| cls.split(' ').any(|one| one == "on"))
        })
        .filter_map(|c| c["cell"].as_str())
        .collect();
    assert_eq!(lit, vec!["0|diag:dpad:dr"], "{edited}");
    assert!(
        edited["view"]["rows"][0]["exp"]
            .as_str()
            .is_some_and(|e| e.contains("dpad.down")),
        "and the row still spells what the file stores: {edited}"
    );

    // A REFUSAL IS SAID OUT LOUD. Answering a rejected act with `ok: true`
    // and an empty sentence let the browser mark the macro dirty over a
    // change that never happened — the number in the box and the number
    // that would be saved disagreeing, in silence.
    for (act, expect) in [
        ("pol|on_release|explode", "not a setting"),
        ("dur|0|0", "not a length"),
        ("dur|0|abc", "not a length"),
        ("down|x", "bottom"),
        ("short|0", "long enough"),
        ("wat", "not something this editor does"),
    ] {
        let junk: serde_json::Value = serde_json::from_str(body_of(&post_json(
            addr,
            "/nocturne/api/macro/edit",
            &format!("{{\"slot\":1,\"act\":\"{act}\",\"draft\":{draft}}}"),
        )))
        .expect("edit");
        assert_eq!(junk["ok"], false, "{act} should be refused: {junk}");
        assert!(
            junk["said"].as_str().is_some_and(|w| w.contains(expect)),
            "{act} must say why: {junk}"
        );
        assert_eq!(junk["draft"], draft, "{act} changed the draft");
    }

    // …and a malformed index is answered rather than suffered: `down` used to
    // do its arithmetic before its range test, so an unparseable index
    // overflowed and panicked the request.
    let dead: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/nocturne/api/macro/edit",
        &format!("{{\"slot\":1,\"act\":\"down|-1\",\"draft\":{draft}}}"),
    )))
    .expect("edit");
    assert_eq!(dead["ok"], false, "{dead}");
    assert!(
        !dead["said"]
            .as_str()
            .unwrap_or_default()
            .contains("panicked"),
        "it refuses, it does not crash: {dead}"
    );

    // NEW MEANS NEW. `stage_macro` resolves a name case-insensitively and
    // writes over what it finds, so "New macro" on an existing name silently
    // replaced a whole authored table with one empty step.
    let taken = post_form(addr, "/nocturne/macro/new", "slot=1&name=COMBO");
    assert!(taken.contains("flash=error"), "{taken}");
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne?macro=combo"))).expect("payload");
    assert_eq!(
        api["view"]["mac"]["rows"].as_array().expect("rows").len(),
        1,
        "the table that was already there is untouched: {api}"
    );

    // A name becomes a TOML key and the `macro=` half of its own edit link,
    // so one that cannot survive either is refused rather than minted.
    for bad in ["punch%26kick", "a%20b", "%2Eleading", "%23hash"] {
        let out = post_form(addr, "/nocturne/macro/new", &format!("slot=1&name={bad}"));
        assert!(out.contains("flash=error"), "{bad}: {out}");
    }
}

/// **The macro STEP editor is served**: a macro is addressed by NAME on the
/// selected controller, and the whole roll — columns, bands, steps, cells,
/// policies — arrives composed. The two things worth pinning are the ones the
/// editor exists for: a hand-written direction PAIR reads back as ONE diagonal
/// with the file's own spelling beside it, and a step under the sampling floor
/// is flagged in the unit it was authored in.
#[test]
fn nocturne_serves_the_macro_step_editor() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));
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
    // Step 1 is written as a PAIR, by hand, the way a preset file does it.
    // Step 2 is one frame — shorter than a 60 Hz poller can see.
    let saved: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/api/macro/save",
        "{\"target\":\"stage\",\"slot\":1,\"preset\":\"Player 1\",\"name\":\"combo\",\"steps\":[\
         {\"hold\":[\"dpad.down\",\"dpad.right\"],\"ms\":50},{\"hold\":[\"A\"],\"frames\":1}]}",
    )))
    .expect("macro save");
    assert_eq!(saved["ok"], true, "{saved}");

    // Closed until a macro is named — and an unknown name opens nothing.
    for query in ["", "?macro=nosuchmacro"] {
        let api: serde_json::Value =
            serde_json::from_str(body_of(&get(addr, &format!("/api/nocturne{query}"))))
                .expect("payload");
        assert_eq!(api["view"]["mac"]["open"], false, "{query}: {api}");
        assert_eq!(api["view"]["mac"]["back_cls"], "nd-back none", "{query}");
    }

    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne?macro=combo"))).expect("payload");
    let mac = api["view"]["mac"].clone();
    // The canvas receives the same staged macro as a per-pad topology. This
    // catches the broken client-only shortcut that tried to derive All-player
    // flows from selected-slot lifecycle rows (which have no step outputs).
    let flow = api["view"]["pads"][0]["macros"][0].clone();
    assert_eq!(api["view"]["pads"][0]["mapping_available"], true);
    assert_eq!(api["view"]["pads"][0]["mapping_reason"], "");
    assert_eq!(api["view"]["pads"][0]["macro_available"], true);
    assert_eq!(api["view"]["pads"][0]["macro_reason"], "");
    assert_eq!(flow["name"], "combo", "{flow}");
    assert_eq!(flow["triggers"], serde_json::json!([]), "{flow}");
    assert_eq!(flow["outputs"][0]["function"], "dpad.down", "{flow}");
    assert_eq!(
        flow["outputs"][0]["steps"],
        serde_json::json!([1]),
        "{flow}"
    );
    assert_eq!(flow["outputs"][1]["function"], "dpad.right", "{flow}");
    assert_eq!(flow["outputs"][2]["function"], "A", "{flow}");
    assert!(
        flow["timeline"][0]
            .as_str()
            .is_some_and(|step| step.contains('\u{2198}')),
        "the signal node says diagonal instead of flattening the sequence: {flow}"
    );
    assert_eq!(mac["open"], true, "{mac}");
    assert_eq!(mac["name"], "combo", "{mac}");
    assert_eq!(
        mac["head"], "2 steps \u{b7} 83 ms",
        "the shape before the detail: {mac}"
    );
    assert_eq!(mac["close_href"], "/nocturne?slot=1", "{mac}");
    // The direction zones become three rings of eight, so a diagonal is a thing
    // you point at instead of a thing you know how to build. The width is
    // derived: `the_grid_is_three_rings` owns the shape, this owns the wiring.
    let cols = mac["cols"].as_array().expect("cols").len();
    let rows_n = mac["rows"].as_array().expect("rows").len();
    assert_eq!(rows_n, 2, "{mac}");
    assert_eq!(
        mac["cells"].as_array().expect("cells").len(),
        cols * rows_n,
        "one cell per (step, column): {mac}"
    );

    // THE LENS: the pair reads as one control, and the file's spelling is
    // beside it rather than hidden in the TOML.
    let first = mac["rows"][0].clone();
    assert!(
        first["hold"]
            .as_str()
            .is_some_and(|h| h.contains('\u{2198}')),
        "a written pair reads back as the diagonal it is: {first}"
    );
    assert!(
        first["exp"]
            .as_str()
            .is_some_and(|e| e.contains("dpad.down") && e.contains("dpad.right")),
        "and the row still spells what the file stores: {first}"
    );
    let lit: Vec<&str> = mac["cells"]
        .as_array()
        .expect("cells")
        .iter()
        .filter(|c| {
            c["cls"]
                .as_str()
                .is_some_and(|cls| cls.split(' ').any(|one| one == "on"))
        })
        .filter_map(|c| c["cell"].as_str())
        .collect();
    assert_eq!(lit, vec!["0|diag:dpad:dr", "1|A"], "{mac}");
    assert!(
        mac["cells"]
            .as_array()
            .expect("cells")
            .iter()
            .filter(|c| c["cls"].as_str().is_some_and(|cls| cls.contains(" part")))
            .count()
            == 2,
        "the two cardinals stay ticked underneath — the lens never hides the store: {mac}"
    );

    // THE FLOOR: flagged where it is read, in the unit it was authored in.
    let second = mac["rows"][1].clone();
    assert!(
        second["cls"].as_str().is_some_and(|c| c.contains("short")),
        "{second}"
    );
    assert!(
        second["warn"].as_str().is_some_and(|w| w.contains("fr")),
        "the flag counts frames, because that is how the step was written: {second}"
    );
    assert_eq!(second["unit"], "fr", "{second}");

    // The bands are NAMED and COUNTED: where a macro lives, before you read a
    // single cell.
    let bands: Vec<(String, String)> = mac["groups"]
        .as_array()
        .expect("groups")
        .iter()
        .map(|g| {
            (
                g["label"].as_str().unwrap_or_default().to_owned(),
                g["count"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .collect();
    assert!(
        bands.contains(&("D-pad".to_owned(), "1".to_owned()))
            && bands.contains(&("Face buttons".to_owned(), "1".to_owned())),
        "{bands:?}"
    );
    assert!(
        bands
            .iter()
            .any(|(label, count)| label == "Right stick" && count.is_empty()),
        "a band this macro never touches counts nothing: {bands:?}"
    );

    // Every policy option is visible, and the current one is marked.
    let on: Vec<&str> = mac["pols"]
        .as_array()
        .expect("pols")
        .iter()
        .filter(|o| o["cls"] == "n-bpill on")
        .filter_map(|o| o["act"].as_str())
        .collect();
    assert_eq!(
        on,
        vec![
            "on_release|finish",
            "retrigger|ignore",
            "interrupt|none",
            "repeat|once"
        ],
        "{mac}"
    );
    assert_eq!(
        mac["turbo_cls"], "n-macrate none",
        "no turbo, no rate: {mac}"
    );
    assert_eq!(
        mac["motions"].as_array().expect("motions").len(),
        8,
        "{mac}"
    );
    assert!(
        mac["motions"][0]["label"]
            .as_str()
            .is_some_and(|l| !l.is_empty()),
        "every motion carries its NAME, not just its shape: {mac}"
    );

    // …and the row that opens it points at this page, not at Controls.
    let row = api["view"]["macro_rows"][0].clone();
    assert_eq!(row["edit_href"], "/nocturne?slot=1&macro=combo", "{row}");
}

/// An older daemon can still serve its staged roster while omitting the
/// authoring table. The canvas must say that macro topology is unavailable;
/// an empty list would falsely claim the preset defines no processors.
#[test]
fn nocturne_does_not_turn_unavailable_macro_data_into_an_empty_answer() {
    let control = Arc::new(ScriptedControl::new(false).without_authoring());
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
    let addr = start_server(control);
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne?slot=1"))).expect("payload");
    let pad = api["view"]["pads"][0].clone();
    assert_eq!(pad["mapping_available"], false, "{pad}");
    assert_eq!(pad["fn_keys"], serde_json::json!({}), "{pad}");
    assert_eq!(
        pad["controls"],
        serde_json::json!([]),
        "an unavailable authoring read must not look like a controller with every control unbound: {pad}"
    );
    assert_eq!(
        pad["mapping_reason"],
        "Player 1's controller layout is not available. Refresh the unsaved setup.",
        "{pad}"
    );
    assert_eq!(pad["macro_available"], false, "{pad}");
    assert_eq!(pad["macros"], serde_json::json!([]), "{pad}");
    assert_eq!(
        pad["macro_reason"],
        "Player 1's controller layout is not available. Refresh the unsaved setup.",
        "{pad}"
    );
}

/// Macro authoring and direct-mapper projection are independent reads. A bad
/// binding must not hide a readable macro, and its timeline still uses the
/// staged controller's own button language rather than an Xbox fallback.
#[test]
fn nocturne_keeps_persona_macro_labels_when_direct_mapping_is_unavailable() {
    let control = Arc::new(ScriptedControl::new(false));
    for edit in [
        ksx_api::StageEdit::ChooseDevice {
            selector: "usb:d209:0430:00".into(),
            alias: "panel".into(),
            label: "I-PAC".into(),
        },
        ksx_api::StageEdit::AddSlot {
            number: None,
            persona: "playstation".into(),
            preset: "Player 1".into(),
            layout: Some("arcade-6button".into()),
        },
    ] {
        assert!(control.stage_edit(&edit).ok);
    }
    let addr = start_server(Arc::clone(&control));
    let saved: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/api/macro/save",
        "{\"target\":\"stage\",\"slot\":1,\"preset\":\"Player 1\",\"name\":\"cross\",\"steps\":[{\"hold\":[\"A\"],\"ms\":50}]}",
    )))
    .expect("macro save");
    assert_eq!(saved["ok"], true, "{saved}");
    control.invalidate_mapping_authoring();

    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne?slot=1&macro=cross")))
            .expect("payload");
    let pad = api["view"]["pads"][0].clone();
    assert_eq!(pad["mapping_available"], false, "{pad}");
    assert!(
        pad["mapping_reason"]
            .as_str()
            .is_some_and(|reason| reason.contains("not.a.controller.function")),
        "{pad}"
    );
    assert_eq!(pad["fn_keys"], serde_json::json!({}), "{pad}");
    assert_eq!(pad["macro_available"], true, "{pad}");
    assert_eq!(
        pad["macros"][0]["timeline"],
        serde_json::json!(["✕"]),
        "{pad}"
    );
    let editor = api["view"]["mac"].clone();
    assert_eq!(editor["open"], true, "{editor}");
    assert_eq!(editor["rows"][0]["hold"], "✕", "{editor}");
    let cross_column = editor["cols"]
        .as_array()
        .and_then(|cols| {
            cols.iter().find(|column| {
                column["title"]
                    .as_str()
                    .is_some_and(|title| title.ends_with("(A)"))
            })
        })
        .expect("cross column");
    assert_eq!(cross_column["id"], "✕", "{editor}");

    // The first edit response recomposes the same editor. It must retain the
    // staged persona even though direct mapper conversion is still refused.
    let request = serde_json::json!({
        "slot": 1,
        "act": "cell|0|B",
        "draft": editor["table"].clone()
    })
    .to_string();
    let edited: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/nocturne/api/macro/edit",
        &request,
    )))
    .expect("macro edit");
    assert_eq!(edited["ok"], true, "{edited}");
    assert!(
        edited["view"]["rows"][0]["hold"]
            .as_str()
            .is_some_and(|hold| hold.contains('✕') && hold.contains('○')),
        "{edited}"
    );
    assert!(
        edited["view"]["cols"]
            .as_array()
            .expect("columns")
            .iter()
            .any(|column| column["id"] == "○"),
        "{edited}"
    );
}

/// Canvas topology is pad-owned, not borrowed from the selected controller's
/// macro editor. Asking to inspect P1 must therefore keep P2's complete macro
/// chain in the payload, including P2's own controller vocabulary.
#[test]
fn nocturne_keeps_nonselected_player_macro_topology() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));
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
            persona: "switchpro".into(),
            preset: "Player 2".into(),
            layout: Some("arcade-6button".into()),
        },
    ] {
        assert!(control.stage_edit(&edit).ok);
    }
    for (slot, preset, name, hold) in [
        (1, "Player 1", "p1-combo", serde_json::json!(["A"])),
        (2, "Player 2", "p2-combo", serde_json::json!(["lt", "back"])),
    ] {
        let request = serde_json::json!({
            "target": "stage",
            "slot": slot,
            "preset": preset,
            "name": name,
            "steps": [{ "hold": hold, "ms": 50 }]
        })
        .to_string();
        let saved: serde_json::Value =
            serde_json::from_str(body_of(&post_json(addr, "/api/macro/save", &request)))
                .expect("macro save");
        assert_eq!(saved["ok"], true, "{saved}");
    }
    for (slot, function, key) in [(1, "macro.p1-combo", "F11"), (2, "macro.p2-combo", "F12")] {
        let request = serde_json::json!({
            "slot": slot,
            "function": function,
            "key": key,
            "mode": "replace",
            "force": true
        })
        .to_string();
        let bound: serde_json::Value =
            serde_json::from_str(body_of(&post_json(addr, "/nocturne/api/bind", &request)))
                .expect("macro trigger bind");
        assert_eq!(bound["ok"], true, "{bound}");
    }

    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne?slot=1"))).expect("payload");
    let pads = api["view"]["pads"].as_array().expect("pads");
    assert_eq!(pads.len(), 2, "{api}");
    assert_eq!(pads[0]["macros"][0]["name"], "p1-combo", "{api}");
    assert_eq!(pads[0]["macros"][0]["triggers"], serde_json::json!(["F11"]));
    assert_eq!(pads[1]["slot"], 2, "{api}");
    assert_eq!(pads[1]["macros"][0]["name"], "p2-combo", "{api}");
    assert_eq!(pads[1]["macros"][0]["triggers"], serde_json::json!(["F12"]));
    assert_eq!(
        pads[1]["macros"][0]["timeline"],
        serde_json::json!(["ZL + Capture"]),
        "{api}"
    );
    assert_eq!(pads[1]["fn_names"]["lt"], "ZL", "{api}");
    assert_eq!(pads[1]["fn_names"]["back"], "Capture", "{api}");

    let p2: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne?slot=2&macro=p2-combo")))
            .expect("P2 editor payload");
    let editor = &p2["view"]["mac"];
    assert_eq!(editor["open"], true, "{editor}");
    assert_eq!(editor["rows"][0]["hold"], "ZL + Capture", "{editor}");
    for (function, label) in [("lt", "ZL"), ("back", "Capture")] {
        let suffix = format!("({function})");
        let column = editor["cols"]
            .as_array()
            .and_then(|cols| {
                cols.iter().find(|column| {
                    column["title"]
                        .as_str()
                        .is_some_and(|title| title.ends_with(suffix.as_str()))
                })
            })
            .expect("Switch column");
        assert_eq!(column["id"], label, "{editor}");
    }
}

/// Existing preset files do not cap macro-name length. The canvas door must
/// therefore encode the complete name (including query delimiters), and that
/// exact href must reopen the existing editor instead of a truncated ghost.
#[test]
fn nocturne_macro_flow_href_round_trips_long_reserved_names() {
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
    ] {
        assert!(control.stage_edit(&edit).ok);
    }
    let addr = start_server(control);
    let name = format!("{} &?#/%", "long".repeat(31));
    assert!(name.chars().count() > 120);
    let request = serde_json::json!({
        "target": "stage",
        "slot": 1,
        "preset": "Player 1",
        "name": name,
        "steps": [{ "hold": ["A"], "ms": 50 }]
    })
    .to_string();
    let saved: serde_json::Value =
        serde_json::from_str(body_of(&post_json(addr, "/api/macro/save", &request)))
            .expect("macro save");
    assert_eq!(saved["ok"], true, "{saved}");

    let encoded = format!("{}%20%26%3F%23%2F%25", "long".repeat(31));
    let api: serde_json::Value = serde_json::from_str(body_of(&get(
        addr,
        &format!("/api/nocturne?slot=1&macro={encoded}"),
    )))
    .expect("payload");
    assert_eq!(api["view"]["mac"]["open"], true, "{api}");
    assert_eq!(api["view"]["mac"]["name"], name, "{api}");
    let flow = api["view"]["pads"][0]["macros"]
        .as_array()
        .and_then(|macros| macros.iter().find(|mac| mac["name"] == name))
        .expect("long macro flow");
    assert_eq!(
        flow["edit_href"],
        format!("/nocturne?slot=1&macro={encoded}"),
        "{flow}"
    );
}

/// draft; the trigger rebinds through the SAME staged bind verb as any
/// control; the toggle keeps every step; delete removes table and triggers
/// together — and every twin refuses junk in allowlisted words.
#[test]
fn nocturne_serves_the_migrated_macro_lifecycle_over_http() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));
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

    // A layout with no macros serves the honest empty state.
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne"))).expect("payload");
    assert!(
        api["view"]["macro_rows"]
            .as_array()
            .expect("rows")
            .is_empty(),
        "{api}"
    );
    assert!(
        api["view"]["macros_note"]
            .as_str()
            .is_some_and(|note| note.contains("Controls")),
        "{api}"
    );

    // Author one through the MOVED editor verb (same route as ever).
    let saved: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/api/macro/save",
        "{\"target\":\"stage\",\"slot\":1,\"preset\":\"Player 1\",\"name\":\"combo\",\"steps\":[{\"hold\":[\"dpad.down\"],\"ms\":50},{\"hold\":[\"A\"],\"ms\":80}]}",
    )))
    .expect("macro save");
    assert_eq!(saved["ok"], true, "{saved}");
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne"))).expect("payload");
    let row = api["view"]["macro_rows"][0].clone();
    assert_eq!(row["name"], "combo", "{api}");
    assert_eq!(row["chip"], "No trigger key", "{api}");
    assert!(
        row["meta"]
            .as_str()
            .is_some_and(|meta| meta.contains("2 steps")),
        "{api}"
    );

    // The trigger rebinds through the same staged bind verb as any control.
    let bound: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/nocturne/api/bind",
        "{\"slot\":1,\"function\":\"macro.combo\",\"key\":\"F9\"}",
    )))
    .expect("trigger bind");
    assert_eq!(bound["ok"], true, "{bound}");
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne"))).expect("payload");
    assert_eq!(api["view"]["macro_rows"][0]["chip"], "F9", "{api}");

    // Toggle off: the table keeps everything, only the flag moves.
    let off = post_form(addr, "/nocturne/macro/toggle", "slot=1&name=combo");
    assert!(off.contains("Macro%20updated"), "{off}");
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne"))).expect("payload");
    let row = api["view"]["macro_rows"][0].clone();
    assert!(
        row["meta"]
            .as_str()
            .is_some_and(|meta| meta.contains("disabled")),
        "{api}"
    );
    assert_eq!(row["toggle_label"], "Enable", "{api}");
    assert!(
        row["meta"]
            .as_str()
            .is_some_and(|meta| meta.contains("2 steps")),
        "the toggle must keep the steps: {api}"
    );

    // Back on…
    let on = post_form(
        addr,
        "/nocturne/macro/toggle",
        "slot=1&name=combo&enable=yes",
    );
    assert!(on.contains("Macro%20updated"), "{on}");

    // …and delete removes the table AND its trigger rows, in this draft only.
    let gone = post_form(addr, "/nocturne/macro/delete", "slot=1&name=combo");
    assert!(gone.contains("Macro%20removed"), "{gone}");
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne"))).expect("payload");
    assert!(
        api["view"]["macro_rows"]
            .as_array()
            .expect("rows")
            .is_empty(),
        "{api}"
    );

    // A slot this draft does not have refuses without touching anything.
    let missing = post_form(addr, "/nocturne/macro/delete", "slot=9&name=combo");
    assert!(missing.contains("flash=error"), "{missing}");
}

/// **Slot selection is server-resolved.** `?slot=N` picks which controller
/// every pane follows — the rack mark, the binding title, the stage family —
/// and a number the draft does not have falls back to the first slot instead
/// of a dead page.
#[test]
fn nocturne_resolves_the_selected_slot_server_side() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));
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
    ] {
        assert!(control.stage_edit(&edit).ok);
    }

    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne?slot=2"))).expect("payload");
    assert!(
        api["view"]["bind_title"]
            .as_str()
            .is_some_and(|title| title.contains("P2")),
        "{api}"
    );
    let rack = api["view"]["rack_rows"].as_array().expect("rack");
    assert_eq!(rack[0]["cls"], "n-slot", "{api}");
    assert_eq!(rack[1]["cls"], "n-slot on", "{api}");
    // The second slot is the PlayStation draft: the stage follows its family,
    // and every ramp surface wears P2's shade.
    assert_eq!(api["view"]["pad_ps_cls"], "n-padwrap", "{api}");
    assert_eq!(api["view"]["pad_ps5_cls"], "n-padwrap none", "{api}");
    assert_eq!(api["view"]["pad_badge_cls"], "n-pbadge np2", "{api}");
    assert_eq!(api["view"]["kb_cls"], "n-kb np2", "{api}");

    // A slot this draft does not have falls back to the first.
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne?slot=9"))).expect("payload");
    assert!(
        api["view"]["bind_title"]
            .as_str()
            .is_some_and(|title| title.contains("P1")),
        "{api}"
    );
    assert_eq!(api["view"]["rack_rows"][0]["cls"], "n-slot on", "{api}");

    // The page itself resolves the same way (SSR paints the selection).
    let page = rendered_body(&get(addr, "/nocturne?slot=2"));
    assert!(page.contains("P2"), "{page}");

    // A DualSense gets its OWN body. Before this, family was `is_xinput`
    // decided, so every non-Xbox seat drew a DualShock 4 — a PS5 pad wearing
    // PS4 art, which is a picture that lies about the device Windows gained.
    assert!(
        control
            .stage_edit(&ksx_api::StageEdit::AddSlot {
                number: None,
                persona: "dualsense".into(),
                preset: "Player 3".into(),
                layout: None,
            })
            .ok
    );
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne?slot=3"))).expect("payload");
    let pads = api["view"]["pads"].as_array().expect("pads");
    let families: Vec<&str> = pads
        .iter()
        .map(|pad| pad["family"].as_str().unwrap_or("?"))
        .collect();
    assert_eq!(families, vec!["xbox", "ps", "ps5"], "{api}");
    // …and the no-JS masters follow the selected seat: exactly one shows.
    assert_eq!(api["view"]["pad_ps5_cls"], "n-padwrap", "{api}");
    assert_eq!(api["view"]["pad_ps_cls"], "n-padwrap none", "{api}");
    assert_eq!(api["view"]["pad_xbox_cls"], "n-padwrap none", "{api}");

    // Switch Pro and Xbox Series are not aliases for the nearest old art:
    // each modern persona keeps the physical layout it actually exposes.
    for persona in ["switchpro", "xboxseries"] {
        assert!(
            control
                .stage_edit(&ksx_api::StageEdit::AddSlot {
                    number: None,
                    persona: persona.into(),
                    preset: format!("{persona} art"),
                    layout: None,
                })
                .ok
        );
    }
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne?slot=4"))).expect("payload");
    let families: Vec<&str> = api["view"]["pads"]
        .as_array()
        .expect("pads")
        .iter()
        .map(|pad| pad["family"].as_str().unwrap_or("?"))
        .collect();
    assert_eq!(
        families,
        vec!["xbox", "ps", "ps5", "switchpro", "xboxseries"],
        "{api}"
    );
    assert_eq!(api["view"]["pad_switchpro_cls"], "n-padwrap", "{api}");
    assert_eq!(api["view"]["pad_xboxseries_cls"], "n-padwrap none", "{api}");

    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne?slot=5"))).expect("payload");
    assert_eq!(api["view"]["pad_xboxseries_cls"], "n-padwrap", "{api}");
    assert_eq!(api["view"]["pad_switchpro_cls"], "n-padwrap none", "{api}");
}

/// **The MIGRATED rack ordering + opposite-directions verbs, over HTTP.**
/// One whole-order reorder per click with the daemon's own renumbering; an
/// end row's empty order gets the honest at-that-end sentence, not a write;
/// the SOCD verb renames the selected slot's policy in the served roster's
/// words; and the re-pointed `/workspace` doors land their answers on
/// `/nocturne`.
#[test]
fn nocturne_serves_the_migrated_rack_ordering_and_socd_over_http() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));
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
    ] {
        assert!(control.stage_edit(&edit).ok);
    }

    // Every rack row precomposes its one-swap whole orders, empty at the
    // ends, and the SOCD editor is live for the selected (first) slot.
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne"))).expect("payload");
    let rack = api["view"]["rack_rows"].as_array().expect("rack");
    assert_eq!(rack[0]["up_order"], "", "{api}");
    assert_eq!(rack[0]["down_order"], "2 1", "{api}");
    assert_eq!(rack[1]["up_order"], "2 1", "{api}");
    assert_eq!(rack[1]["down_order"], "", "{api}");
    assert_eq!(api["view"]["socd_cls"], "n-socdform", "{api}");
    assert_eq!(api["view"]["socd_num"], "1", "{api}");
    assert_eq!(api["view"]["socd_lab"], "Opposites — P1", "{api}");
    assert!(
        !api["view"]["socd_edit_opts"]
            .as_array()
            .expect("roster")
            .is_empty(),
        "{api}"
    );

    // Reorder: one whole-order write; the renumbering is the daemon's.
    let response = post_form(addr, "/nocturne/controller/move", "order=2+1");
    assert!(response.starts_with("HTTP/1.1 303"), "{response}");
    assert!(
        response.contains("location: /nocturne?flash="),
        "{response}"
    );
    assert!(response.contains("Draft%20updated"), "{response}");
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne"))).expect("payload");
    assert_eq!(api["view"]["rack_rows"][0]["name"], "PlayStation", "{api}");
    assert_eq!(api["view"]["rack_rows"][1]["name"], "Xbox 360", "{api}");

    // An end row's order is empty: no write, and the honest sentence.
    let response = post_form(addr, "/nocturne/controller/move", "order=");
    assert!(response.contains("already%20at%20that%20end"), "{response}");

    // The slot's opposite-directions rule, in the served roster's words.
    let response = post_form(
        addr,
        "/nocturne/controller/socd",
        "number=1&socd=last-input",
    );
    assert!(response.contains("Draft%20updated"), "{response}");
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne"))).expect("payload");
    assert!(
        api["view"]["rack_rows"][0]["meta"]
            .as_str()
            .is_some_and(|meta| meta.contains("SOCD Last press wins")),
        "{api}"
    );

    // The old /workspace doors answer on /nocturne now.
    let via_workspace = post_form(addr, "/workspace/controller/move", "number=1&order=");
    assert!(
        via_workspace.contains("location: /nocturne?flash="),
        "{via_workspace}"
    );
    let via_workspace = post_form(addr, "/workspace/controller/socd", "number=1&socd=off");
    assert!(
        via_workspace.contains("location: /nocturne?flash="),
        "{via_workspace}"
    );
}

/// **The machine-read cache + ETag**: the 2-second poll must not cost a
/// USB enumeration per tick — reads inside the TTL are served from the
/// cache; every MUTATING request and Rescan's `fresh=1` drop it; and an
/// unchanged payload answers `304 Not Modified` to `If-None-Match`.
#[test]
fn nocturne_caches_machine_reads_and_answers_304() {
    let control = Arc::new(ScriptedControl::new(false));
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(
        Arc::clone(&control),
        Arc::clone(&machine) as Arc<dyn ksx_api::MachineSource>,
    );

    // Two polls inside the TTL: ONE enumeration.
    let first = get(addr, "/api/nocturne");
    let _second = get(addr, "/api/nocturne");
    assert!(first.contains(" 200 "), "{first}");
    assert_eq!(machine.scans.load(Ordering::SeqCst), 1, "cache missed");

    // The unchanged answer carries an ETag and honours If-None-Match.
    let etag = first
        .lines()
        .find_map(|line| line.strip_prefix("etag: "))
        .expect("an etag header")
        .trim()
        .to_owned();
    let not_modified = get_if_none_match(addr, "/api/nocturne", &etag);
    assert!(not_modified.contains(" 304 "), "{not_modified}");
    assert!(!not_modified.contains("staged"), "a 304 carries no body");

    // A mutating request drops the cache: the next poll enumerates again.
    let _ = post_form(addr, "/nocturne/blocking", "blocking=whole");
    let _ = get(addr, "/api/nocturne");
    assert_eq!(
        machine.scans.load(Ordering::SeqCst),
        2,
        "a POST must invalidate"
    );

    // And so does Rescan's fresh=1, explicitly.
    let _ = get(addr, "/api/nocturne?fresh=1");
    assert_eq!(
        machine.scans.load(Ordering::SeqCst),
        3,
        "fresh=1 must invalidate"
    );

    // A changed draft changes the ETag (the 304 can never mask an edit).
    assert!(
        control
            .stage_edit(&ksx_api::StageEdit::ChooseDevice {
                selector: "usb:d209:0430:00".into(),
                alias: "panel".into(),
                label: "I-PAC".into(),
            })
            .ok
    );
    let after = get_if_none_match(addr, "/api/nocturne", &etag);
    assert!(after.contains(" 200 "), "{after}");
}

/// **The `?q=` filter, SERVER-resolved**: rows and whole groups hide in
/// the SSR answer itself — the no-JS filter is real, not dead chrome —
/// with the same row-or-group-label rule the island sweep applies.
#[test]
fn nocturne_resolves_the_filter_server_side() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));
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

    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne?q=stick"))).expect("payload");
    // "stick" matches both stick GROUPS: their rows stay visible.
    assert_eq!(api["view"]["bind_lstick_cls"], "n-bindg", "{api}");
    assert_eq!(api["view"]["bind_rstick_cls"], "n-bindg", "{api}");
    assert!(
        api["view"]["bind_lstick"]
            .as_array()
            .expect("rows")
            .iter()
            .all(|row| !row["cls"].as_str().unwrap_or("").contains("hide")),
        "{api}"
    );
    // The face group matches nothing: every row hidden, the group empty.
    assert_eq!(api["view"]["bind_face_cls"], "n-bindg empty", "{api}");
    assert!(
        api["view"]["bind_face"]
            .as_array()
            .expect("rows")
            .iter()
            .all(|row| row["cls"].as_str().unwrap_or("").contains("hide")),
        "{api}"
    );
    // And the SSR page paints the same truth for a no-JS reader.
    let page = rendered_body(&get(addr, "/nocturne?q=stick"));
    assert!(page.contains("n-bindg empty"), "{page}");

    // No query: nothing hides.
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne"))).expect("payload");
    assert_eq!(api["view"]["bind_face_cls"], "n-bindg", "{api}");
}

/// **Clear-all over HTTP**: one write empties the slot's whole key table —
/// macro TRIGGER keys included, because triggers are bindings — while the
/// macros keep their steps. A junk slot changes nothing.
#[test]
fn nocturne_clears_every_binding_in_one_write() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));
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
    assert!(control.staged().slots[0].bindings > 0);

    let response = post_form(addr, "/nocturne/bind/clear-all", "number=1");
    assert!(response.contains("Every%20key%20unbound"), "{response}");
    let slot = control.staged().slots[0].clone();
    assert_eq!(slot.bindings, 0, "{slot:?}");
    assert!(
        slot.authoring
            .as_ref()
            .is_some_and(|preset| preset.bindings.is_empty()),
        "{slot:?}"
    );

    let junk = post_form(addr, "/nocturne/bind/clear-all", "number=9");
    assert!(junk.contains("could%20not%20be%20made"), "{junk}");
}

/// **Per-key clear over HTTP**: one key taken away from EVERYTHING it drives
/// — a shared control keeps its other keys, a solo control goes unbound —
/// each rewrite through the daemon's own staged-bind verb, the touched
/// functions named by the same staged inversion the By-key rows render. A
/// key that drives nothing gets the honest nothing-changed sentence.
#[test]
fn nocturne_clears_one_key_everywhere_it_drives() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));
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
            layout: None,
        },
    ] {
        assert!(control.stage_edit(&edit).ok);
    }
    let preset = control.staged().slots[0].preset.clone();
    for (function, keys) in [("A", vec!["G", "H"]), ("B", vec!["G"])] {
        assert!(
            control
                .stage_bind(&ksx_api::StagedBindRequest {
                    number: 1,
                    preset: preset.clone(),
                    function: function.into(),
                    keys: keys.into_iter().map(str::to_owned).collect(),
                    force: true,
                    turbo_hz: None,
                    toggle: None,
                })
                .ok
        );
    }

    let response = post_form(addr, "/nocturne/key/clear", "number=1&key=G");
    assert!(response.contains("free%20again"), "{response}");
    let staged = control.staged();
    let mapper = ksx_api::staged_mapper_slot(&staged.slots[0], "I-PAC").expect("mapper");
    assert_eq!(
        mapper.bindings.get("A").cloned().unwrap_or_default(),
        vec!["H".to_owned()],
        "the shared control keeps its other key"
    );
    assert!(
        mapper
            .bindings
            .get("B")
            .cloned()
            .unwrap_or_default()
            .is_empty(),
        "the solo control goes unbound"
    );

    let none = post_form(addr, "/nocturne/key/clear", "number=1&key=F9");
    assert!(none.contains("not%20driving%20anything"), "{none}");
}

/// **The board is a territory map**: every owned key's cap carries its
/// FIRST owner's color class (`own{N}`, plus `owned` when the key belongs
/// to another controller entirely), and the strips mark only the REMAINING
/// owners — so a key with one owner needs no underline, and a shared key
/// wears the second owner's mark over the first owner's fill.
#[test]
fn nocturne_paints_the_board_by_owner() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));
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
            layout: None,
        },
        ksx_api::StageEdit::AddSlot {
            number: None,
            persona: "xbox360".into(),
            preset: "Player 2".into(),
            layout: None,
        },
    ] {
        assert!(control.stage_edit(&edit).ok);
    }
    let staged = control.staged();
    let p1 = staged.slots[0].preset.clone();
    let p2 = staged.slots[1].preset.clone();
    for (number, preset, function, key) in [
        (1, p1.clone(), "A", "G"),
        (2, p2.clone(), "B", "G"),
        (2, p2, "lb", "F6"),
    ] {
        assert!(
            control
                .stage_bind(&ksx_api::StagedBindRequest {
                    number,
                    preset,
                    function: function.into(),
                    keys: vec![key.into()],
                    force: true,
                    turbo_hz: None,
                    toggle: None,
                })
                .ok
        );
    }

    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne"))).expect("payload");
    let cell = |key: &str| -> serde_json::Value {
        [
            "kb_row1", "kb_row2", "kb_row3", "kb_row4", "kb_row5", "kb_row6",
        ]
        .iter()
        .filter_map(|row| api["view"][row].as_array())
        .flatten()
        .find(|c| c["key"] == key)
        .unwrap_or_else(|| panic!("{key} is not on the board"))
        .clone()
    };

    // Shared by two: the cap splits, and the SELECTED slot's band leads.
    let g = cell("G");
    let g_cls = g["cls"].as_str().expect("cls");
    assert!(
        g_cls.contains(" bound"),
        "the ring says the selection drives it"
    );
    assert!(g_cls.contains(" bn2"), "two owners, two bands: {g}");
    assert!(g_cls.contains(" ba1") && g_cls.contains(" bb2"), "{g}");
    assert!(
        g["title"]
            .as_str()
            .is_some_and(|t| t.contains("also bound on P2")),
        "the words name the other owner: {g}"
    );

    // Owned by another controller only: one band in ITS color, and no
    // ring — the selected slot does not drive this key.
    let f6 = cell("F6");
    let f6_cls = f6["cls"].as_str().expect("cls");
    assert!(f6_cls.contains(" bn1") && f6_cls.contains(" ba2"), "{f6}");
    assert!(!f6_cls.contains(" bound"), "{f6}");

    // Untouched keys stay plain.
    let z = cell("Z");
    let z_cls = z["cls"].as_str().expect("cls");
    assert!(!z_cls.contains(" bn") && !z_cls.contains(" bound"), "{z}");

    // The legend names every controller in its own color.
    let legend = api["view"]["legend"].as_array().expect("legend");
    assert_eq!(legend.len(), 2, "{api}");
    assert_eq!(legend[0]["badge"], "P1", "{api}");
    assert_eq!(
        legend[0]["cls"], "n-lgd np1 on",
        "the selected controller's chip is marked, so soloing can cross out          every other one: {api}"
    );
    assert_eq!(legend[1]["cls"], "n-lgd np2", "{api}");
    assert_eq!(api["view"]["solo_label"], "Only P1", "{api}");
}

/// **A crowded key stacks**: four bands is the ceiling a 30px cap can carry,
/// so a key five controllers share stops naming anyone — one woven face, the
/// TOTAL on the cap, and every owner still named in words. Nothing to add:
/// no band class survives, so the number can only be read as "five".
#[test]
fn nocturne_stacks_a_key_five_controllers_share() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));
    assert!(
        control
            .stage_edit(&ksx_api::StageEdit::ChooseDevice {
                selector: "usb:d209:0430:00".into(),
                alias: "panel".into(),
                label: "I-PAC".into(),
            })
            .ok
    );
    for n in 1..=5 {
        // XInput seats only four; the fifth controller is a PlayStation pad
        // (ViGEm), which is exactly why five owners is a real case.
        let persona = if n <= 4 { "xbox360" } else { "playstation" };
        assert!(
            control
                .stage_edit(&ksx_api::StageEdit::AddSlot {
                    number: None,
                    persona: persona.into(),
                    preset: format!("Player {n}"),
                    layout: None,
                })
                .ok,
            "adding controller {n}"
        );
    }
    let staged = control.staged();
    // Every controller drives Q; the selected one (P1) is bound LAST, to
    // prove its band still leads.
    for slot in staged.slots.iter().rev() {
        assert!(
            control
                .stage_bind(&ksx_api::StagedBindRequest {
                    number: slot.number,
                    preset: slot.preset.clone(),
                    function: "A".into(),
                    keys: vec!["Q".into()],
                    force: true,
                    turbo_hz: None,
                    toggle: None,
                })
                .ok
        );
    }

    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne?slot=3"))).expect("payload");
    let q = [
        "kb_row1", "kb_row2", "kb_row3", "kb_row4", "kb_row5", "kb_row6",
    ]
    .iter()
    .filter_map(|row| api["view"][row].as_array())
    .flatten()
    .find(|c| c["key"] == "Q")
    .expect("Q is on the board")
    .clone();
    let cls = q["cls"].as_str().expect("cls");
    assert!(
        cls.contains(" bstack") && cls.contains(" bcount5"),
        "past four owners the cap stacks and carries the TOTAL: {q}"
    );
    assert!(
        !cls.contains(" bn") && !cls.contains(" ba1") && !cls.contains(" bb2"),
        "and it names NOBODY — three colors out of five would be an \
         arbitrary three, and a band beside a count is a sum to work out: {q}"
    );
    assert!(
        q["title"]
            .as_str()
            .is_some_and(|t| t.contains("P1") && t.contains("P5")),
        "the words still name every owner: {q}"
    );
    assert_eq!(
        api["view"]["kb_more_cls"], "n-lgdmore",
        "and the legend explains the stacked cap, since nothing else does: {api}"
    );

    // Exactly four owners is still four named bands: the stack begins where
    // the colors run out, not before.
    assert!(
        control
            .stage_edit(&ksx_api::StageEdit::RemoveSlot { number: 5 })
            .ok
    );
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne?slot=3"))).expect("payload");
    let q = [
        "kb_row1", "kb_row2", "kb_row3", "kb_row4", "kb_row5", "kb_row6",
    ]
    .iter()
    .filter_map(|row| api["view"][row].as_array())
    .flatten()
    .find(|c| c["key"] == "Q")
    .expect("Q is on the board")
    .clone();
    let cls = q["cls"].as_str().expect("cls");
    assert!(
        cls.contains(" bn4")
            && cls.contains(" ba1")
            && cls.contains(" bb2")
            && cls.contains(" bc3")
            && cls.contains(" bd4"),
        "four owners, four bands, slot order whoever is selected: {q}"
    );
    assert!(
        !cls.contains(" bstack") && !cls.contains(" bcount"),
        "nothing stacks while every owner has a color: {q}"
    );
    assert_eq!(
        api["view"]["kb_more_cls"], "n-lgdmore none",
        "and the legend's key stays away until a cap actually stacks: {api}"
    );
}

/// The canvas authoring projection is backend-owned: every zone appears once
/// in a normalized group order, persona labels come from that controller's
/// art vocabulary, and exact keys plus per-control transforms come directly
/// from the staged mapper rather than from the legacy pane rows.
#[test]
fn nocturne_serves_ordered_canvas_control_authoring() {
    let control = Arc::new(ScriptedControl::new(false));
    for edit in [
        ksx_api::StageEdit::ChooseDevice {
            selector: "usb:d209:0430:00".into(),
            alias: "panel".into(),
            label: "I-PAC".into(),
        },
        ksx_api::StageEdit::AddSlot {
            number: None,
            persona: "playstation".into(),
            preset: "Player 1".into(),
            layout: None,
        },
    ] {
        assert!(control.stage_edit(&edit).ok);
    }
    let preset = control.staged().slots[0].preset.clone();
    assert!(
        control
            .stage_bind(&ksx_api::StagedBindRequest {
                number: 1,
                preset,
                function: "A".into(),
                keys: vec!["G".into(), "H".into()],
                force: true,
                turbo_hz: Some(12),
                toggle: Some(true),
            })
            .ok
    );

    let addr = start_server(control);
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne?slot=1"))).expect("payload");
    let pad = &api["view"]["pads"][0];
    assert_eq!(pad["mapping_available"], true, "{pad}");
    assert_eq!(pad["mapping_reason"], "", "{pad}");
    let controls = pad["controls"].as_array().expect("controls");
    assert_eq!(controls.len(), ksx_core::preset::MAPPABLE_COUNT, "{pad}");

    let expected = [
        "A",
        "B",
        "X",
        "Y",
        "dpad.up",
        "dpad.down",
        "dpad.left",
        "dpad.right",
        "lb",
        "rb",
        "lt",
        "rt",
        "lthumb",
        "ly.max",
        "ly.min",
        "lx.min",
        "lx.max",
        "rthumb",
        "ry.max",
        "ry.min",
        "rx.min",
        "rx.max",
        "back",
        "guide",
        "start",
    ];
    let functions: Vec<&str> = controls
        .iter()
        .map(|control| control["function"].as_str().expect("function"))
        .collect();
    assert_eq!(functions, expected, "normalized authoring order drifted");
    for (order, control) in controls.iter().enumerate() {
        assert_eq!(control["order"].as_u64(), Some(order as u64), "{control}");
    }
    let groups: Vec<&str> = controls
        .iter()
        .map(|control| control["group"].as_str().expect("group"))
        .collect();
    assert_eq!(
        groups,
        [
            "face",
            "face",
            "face",
            "face",
            "dpad",
            "dpad",
            "dpad",
            "dpad",
            "shoulders",
            "shoulders",
            "shoulders",
            "shoulders",
            "left-stick",
            "left-stick",
            "left-stick",
            "left-stick",
            "left-stick",
            "right-stick",
            "right-stick",
            "right-stick",
            "right-stick",
            "right-stick",
            "system",
            "system",
            "system",
        ],
        "{pad}"
    );

    let a = controls
        .iter()
        .find(|control| control["function"] == "A")
        .expect("A control");
    assert_eq!(a["label"], "✕", "the label must speak PlayStation: {a}");
    assert_eq!(a["keys"], serde_json::json!(["G", "H"]), "{a}");
    assert_eq!(a["toggle"], true, "{a}");
    assert_eq!(a["turbo_hz"], 12, "{a}");
    // The exact vector is the new contract; the old joined callout remains
    // for existing clients during migration.
    assert_eq!(pad["fn_keys"]["A"], "G · H", "{pad}");

    let b = controls
        .iter()
        .find(|control| control["function"] == "B")
        .expect("B control");
    assert_eq!(b["label"], "○", "{b}");
    assert_eq!(b["keys"], serde_json::json!([]), "{b}");
    assert_eq!(b["toggle"], false, "{b}");
    assert_eq!(b["turbo_hz"], serde_json::Value::Null, "{b}");
}

/// **The multi-pad payload**: every staged controller serves its family,
/// title, callout chips and readable control names — the clone grid's whole
/// diet, pure payload data that mints no slots.
#[test]
fn nocturne_serves_every_pad_for_the_grid() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));
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
            layout: None,
        },
        ksx_api::StageEdit::AddSlot {
            number: None,
            persona: "playstation".into(),
            preset: "Player 2".into(),
            layout: None,
        },
    ] {
        assert!(control.stage_edit(&edit).ok);
    }
    let preset = control.staged().slots[0].preset.clone();
    assert!(
        control
            .stage_bind(&ksx_api::StagedBindRequest {
                number: 1,
                preset,
                function: "A".into(),
                keys: vec!["G".into(), "H".into()],
                force: true,
                turbo_hz: None,
                toggle: None,
            })
            .ok
    );

    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne"))).expect("payload");
    let pads = api["view"]["pads"].as_array().expect("pads");
    assert_eq!(pads.len(), 2, "{api}");
    assert_eq!(pads[0]["slot"], 1, "{api}");
    assert_eq!(pads[0]["family"], "xbox", "{api}");
    assert_eq!(pads[0]["fn_keys"]["A"], "G · H", "{api}");
    assert_eq!(pads[1]["slot"], 2, "{api}");
    assert_eq!(pads[1]["family"], "ps", "{api}");
    // The readable names speak the persona's own vocabulary.
    assert_eq!(pads[0]["fn_names"]["A"], "A", "{api}");
    assert!(
        pads[1]["fn_names"]
            .as_object()
            .expect("names")
            .values()
            .any(|v| v == "△"),
        "{api}"
    );
}

/// **The ⊖ over HTTP**: mode "remove" on the bind verb takes ONE key off ONE
/// control — its other keys stay, and removing the last key leaves the
/// control honestly unbound. A key the control never had refuses in words.
#[test]
fn nocturne_removes_one_key_from_one_control() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));
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
            layout: None,
        },
    ] {
        assert!(control.stage_edit(&edit).ok);
    }
    let preset = control.staged().slots[0].preset.clone();
    assert!(
        control
            .stage_bind(&ksx_api::StagedBindRequest {
                number: 1,
                preset: preset.clone(),
                function: "A".into(),
                keys: vec!["G".into(), "H".into()],
                force: true,
                turbo_hz: None,
                toggle: None,
            })
            .ok
    );

    let removed: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/nocturne/api/bind",
        "{\"slot\":1,\"function\":\"A\",\"key\":\"H\",\"mode\":\"remove\"}",
    )))
    .expect("remove outcome");
    assert_eq!(removed["ok"], true, "{removed}");
    let staged = control.staged();
    let mapper = ksx_api::staged_mapper_slot(&staged.slots[0], "I-PAC").expect("mapper");
    assert_eq!(
        mapper.bindings.get("A").cloned().unwrap_or_default(),
        vec!["G".to_owned()],
        "the other key stays"
    );

    // Removing a key the control never had refuses in words.
    let missing: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/nocturne/api/bind",
        "{\"slot\":1,\"function\":\"A\",\"key\":\"F9\",\"mode\":\"remove\"}",
    )))
    .expect("missing outcome");
    assert_eq!(missing["ok"], false, "{missing}");
    assert!(
        missing["error"]
            .as_str()
            .is_some_and(|error| error.contains("not driven by")),
        "{missing}"
    );

    // Removing the LAST key leaves the control honestly unbound.
    let last: serde_json::Value = serde_json::from_str(body_of(&post_json(
        addr,
        "/nocturne/api/bind",
        "{\"slot\":1,\"function\":\"A\",\"key\":\"G\",\"mode\":\"remove\"}",
    )))
    .expect("last outcome");
    assert_eq!(last["ok"], true, "{last}");
    let staged = control.staged();
    let mapper = ksx_api::staged_mapper_slot(&staged.slots[0], "I-PAC").expect("mapper");
    assert!(
        mapper
            .bindings
            .get("A")
            .cloned()
            .unwrap_or_default()
            .is_empty(),
        "unbound after the last removal"
    );
}

/// **The undo chip over HTTP**: removing a controller stashes its whole
/// slot view SERVER-side; the chip is served while the window holds; Undo
/// replays add + bindings + socd and consumes the stash — a second Undo
/// gets the honest gone sentence, as does an Undo nobody earned.
#[test]
fn nocturne_undoes_a_removal_from_the_server_held_stash() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));
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
            layout: Some("arcade-6button".into()),
        },
        ksx_api::StageEdit::SetSocd {
            number: 2,
            socd: "last-input".into(),
        },
    ] {
        assert!(control.stage_edit(&edit).ok);
    }

    // Nothing removed yet: no chip, and an unearned Undo says so.
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne"))).expect("payload");
    assert_eq!(api["view"]["undo_cls"], "n-undochip none", "{api}");
    let response = post_form(addr, "/nocturne/controller/undo", "");
    assert!(response.contains("no%20longer%20be%20undone"), "{response}");

    // Remove P2: the chip appears naming it.
    let bindings_before = control.staged().slots[1].bindings;
    assert!(bindings_before > 0);
    let response = post_form(addr, "/nocturne/controller/remove", "number=2");
    assert!(response.contains("Draft%20updated"), "{response}");
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne"))).expect("payload");
    assert_eq!(api["view"]["undo_cls"], "n-undochip", "{api}");
    assert!(
        api["view"]["undo_label"]
            .as_str()
            .is_some_and(|label| label.contains("P2") && label.contains("PlayStation")),
        "{api}"
    );

    // Undo: the controller returns whole — persona, preset, bindings, SOCD.
    let response = post_form(addr, "/nocturne/controller/undo", "");
    assert!(response.contains("Controller%20restored"), "{response}");
    let staged = control.staged();
    assert_eq!(staged.slots.len(), 2, "{staged:?}");
    let restored = staged
        .slots
        .iter()
        .find(|slot| slot.number == 2)
        .expect("P2 back");
    assert_eq!(restored.persona, "playstation");
    assert_eq!(restored.preset, "Player 2");
    assert_eq!(restored.bindings, bindings_before);
    assert_eq!(restored.socd, "last-input");

    // The stash is consumed: no chip, and a second Undo is honest.
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne"))).expect("payload");
    assert_eq!(api["view"]["undo_cls"], "n-undochip none", "{api}");
    let response = post_form(addr, "/nocturne/controller/undo", "");
    assert!(response.contains("no%20longer%20be%20undone"), "{response}");
}

/// **Apply-in-place over HTTP** (`stage_apply`, M1b F3's UI): the button is
/// served only while a session runs AND the draft is dirty; the verb
/// flashes the daemon's three shapes — applied in place, `needs-restart`
/// naming Play, and the honest error when nothing can take it.
#[test]
fn nocturne_applies_the_dirty_draft_to_the_running_session() {
    let control = Arc::new(ScriptedControl::new(false));
    let addr = start_server(Arc::clone(&control));
    assert!(
        control
            .stage_edit(&ksx_api::StageEdit::ChooseDevice {
                selector: "usb:d209:0430:00".into(),
                alias: "panel".into(),
                label: "I-PAC".into(),
            })
            .ok
    );
    assert!(
        control
            .stage_edit(&ksx_api::StageEdit::AddSlot {
                number: None,
                persona: "xbox360".into(),
                preset: "Player 1".into(),
                layout: Some("arcade-6button".into()),
            })
            .ok
    );

    // Idle, clean: the verb is not offered.
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne"))).expect("payload");
    assert_eq!(api["view"]["apply_cls"], "n-apply none", "{api}");

    // Running + dirty: offered.
    control.running.store(true, Ordering::SeqCst);
    control.dirty.store(true, Ordering::SeqCst);
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne"))).expect("payload");
    assert_eq!(api["view"]["apply_cls"], "n-apply", "{api}");

    // The hot path applies in place.
    let response = post_form(addr, "/nocturne/apply", "");
    assert!(response.contains("Changes%20applied"), "{response}");

    // A structural difference refuses with the sentence naming Play.
    control.dirty.store(true, Ordering::SeqCst);
    control.apply_needs_restart.store(true, Ordering::SeqCst);
    let response = post_form(addr, "/nocturne/apply", "");
    assert!(
        response.contains("cannot%20take%20it%20in%20place"),
        "{response}"
    );

    // Nothing running: the honest error.
    control.running.store(false, Ordering::SeqCst);
    let response = post_form(addr, "/nocturne/apply", "");
    assert!(
        response.contains("could%20not%20be%20applied"),
        "{response}"
    );

    // The JSON twin answers with the daemon's OWN words: the hot path's
    // fixed flash, and the needs-restart shape carrying the difference
    // sentence verbatim for the quoting dialog.
    control.running.store(true, Ordering::SeqCst);
    control.apply_needs_restart.store(false, Ordering::SeqCst);
    let hot: serde_json::Value =
        serde_json::from_str(body_of(&post_json(addr, "/nocturne/api/apply", "")))
            .expect("apply json");
    assert_eq!(hot["done"], true, "{hot}");
    assert!(
        hot["flash"]
            .as_str()
            .is_some_and(|f| f.starts_with("Changes applied")),
        "{hot}"
    );
    control.apply_needs_restart.store(true, Ordering::SeqCst);
    let restart: serde_json::Value =
        serde_json::from_str(body_of(&post_json(addr, "/nocturne/api/apply", "")))
            .expect("apply json");
    assert_eq!(restart["done"], false, "{restart}");
    assert_eq!(restart["code"], "needs-restart", "{restart}");
    assert_eq!(
        restart["message"], "the draft changed the session's structure",
        "{restart}"
    );
    control.running.store(false, Ordering::SeqCst);
    let idle: serde_json::Value =
        serde_json::from_str(body_of(&post_json(addr, "/nocturne/api/apply", "")))
            .expect("apply json");
    assert_eq!(idle["done"], false, "{idle}");
    assert!(idle["code"].is_null(), "{idle}");
}

/// **The MIGRATED configuration menu, over HTTP.** The menu's facts are
/// served (config identity, games with the broken row's honesty, the
/// sign-in task in /start's exact vocabulary); adopt refuses over content
/// and loads into emptiness — never starting anything; discard always
/// works; and the sign-in twin keeps its consent gate. The re-pointed
/// `/start` and `/workspace` doors land their answers on `/nocturne`.
#[test]
fn nocturne_serves_the_migrated_configuration_menu_over_http() {
    let control = Arc::new(ScriptedControl::new(false));
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(Arc::clone(&control), machine);

    // The served menu facts, from the machine reads.
    let api: serde_json::Value =
        serde_json::from_str(body_of(&get(addr, "/api/nocturne"))).expect("payload");
    assert_eq!(api["view"]["cfg_line"], "Saved configuration", "{api}");
    assert!(
        api["view"]["cfg_meta"]
            .as_str()
            .is_some_and(|meta| meta.contains("config.toml")),
        "{api}"
    );
    assert_eq!(api["view"]["games_head"], "Saved games · 2", "{api}");
    let games = api["view"]["game_rows"].as_array().expect("game rows");
    assert!(
        games.iter().any(|game| game["cls"] == "nm-game broken"
            && game["meta"]
                .as_str()
                .is_some_and(|meta| meta.contains("program is missing"))),
        "the broken game's honesty is gone: {api}"
    );
    assert!(
        api["view"]["auto_line"]
            .as_str()
            .is_some_and(|line| line.contains("does not start on its own")),
        "{api}"
    );

    // Adopt into an EMPTY draft loads and starts nothing.
    let adopted = post_form(addr, "/nocturne/adopt", "");
    assert!(
        adopted.contains("Loaded%20into%20this%20draft"),
        "{adopted}"
    );
    assert!(!control.staged().slots.is_empty());
    assert!(
        !control.played.load(Ordering::SeqCst),
        "adopt must not Play"
    );

    // Over content it refuses with the Start-over remedy…
    let blocked = post_form(addr, "/nocturne/adopt", "profile=Example+Game");
    assert!(blocked.contains("already%20has%20content"), "{blocked}");

    // …and Start over always works; then a game loads by title.
    let discarded = post_form(addr, "/nocturne/discard", "");
    assert!(discarded.contains("Draft%20discarded"), "{discarded}");
    assert!(control.staged().empty);
    let game = post_form(addr, "/nocturne/adopt", "profile=Example+Game");
    assert!(game.contains("Loaded%20into%20this%20draft"), "{game}");
    assert_eq!(control.staged().slots[0].preset, "Example Game");

    // The sign-in twin: no consent, no write; with consent, the re-read's
    // own truth answers.
    let unticked = post_form(addr, "/nocturne/autostart", "enable=yes");
    assert!(unticked.contains("Tick%20the%20box"), "{unticked}");
    let on = post_form(
        addr,
        "/nocturne/autostart",
        "enable=yes&confirm_autostart=yes",
    );
    assert!(on.contains("start%20when%20you%20sign%20in"), "{on}");
    let off = post_form(addr, "/nocturne/autostart", "confirm_autostart=yes");
    assert!(off.contains("no%20longer%20start"), "{off}");

    // The old doors answer on /nocturne now.
    let via_start = post_form(addr, "/start/discard", "");
    assert!(
        via_start.contains("location: /nocturne?flash=Draft%20discarded"),
        "{via_start}"
    );
    let via_workspace = post_form(addr, "/workspace/adopt", "");
    assert!(
        via_workspace.contains("location: /nocturne?flash=Loaded%20into%20this%20draft"),
        "{via_workspace}"
    );
}

/// The Builder's hardware card is an explicit read, not another participant
/// in `/api/nocturne`'s 2 s poll. With no staged device there is no target and
/// therefore no license to enumerate HID collections at all.
#[test]
fn panel_status_is_on_demand_and_skips_the_provider_without_a_selected_encoder() {
    let control = Arc::new(ScriptedControl::new(false));
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(Arc::clone(&control), machine.clone());

    for _ in 0..2 {
        let response = get(addr, "/api/nocturne");
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    }
    assert_eq!(machine.panel_status_calls.load(Ordering::SeqCst), 0);

    let response = get(addr, "/api/panel/status");
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(response.contains("cache-control: no-store"), "{response}");
    let payload: serde_json::Value =
        serde_json::from_str(body_of(&response)).expect("panel status payload");
    assert!(payload["target_selector"].is_null(), "{payload}");
    assert!(payload["unavailable"].is_null(), "{payload}");
    assert!(payload["view"].is_null(), "{payload}");
    assert_eq!(
        machine.panel_status_calls.load(Ordering::SeqCst),
        0,
        "no selection must not become a whole-machine HID probe"
    );
}

/// A selected board comes from the daemon-held draft, reaches the typed
/// MachineSource verb once, and returns composed copy plus raw evidence. The
/// chart's absence is an explicit unattempted state, never an empty chart.
#[test]
fn panel_status_uses_the_staged_selector_and_reports_metadata_without_mutation() {
    let control = Arc::new(ScriptedControl::new(false));
    let selected = control.stage_edit(&ksx_api::StageEdit::ChooseDevice {
        selector: "usb:d209:0430:00".to_owned(),
        alias: "panel".to_owned(),
        label: "Ultimarc I-PAC 4X".to_owned(),
    });
    assert!(selected.ok, "{selected:?}");
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(Arc::clone(&control), machine.clone());

    let response = get(addr, "/api/panel/status");
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(response.contains("cache-control: no-store"), "{response}");
    let payload: serde_json::Value =
        serde_json::from_str(body_of(&response)).expect("panel status payload");
    assert_eq!(payload["target_selector"], "usb:d209:0430:00", "{payload}");
    assert!(payload["unavailable"].is_null(), "{payload}");
    let view = &payload["view"];
    assert_eq!(
        view["panels"].as_array().map(Vec::len),
        Some(1),
        "{payload}"
    );
    assert_eq!(view["panels"][0]["bcd_device"], 0x0056, "{payload}");
    assert_eq!(
        view["panels"][0]["observed_mode"], "keyboard-compatible",
        "{payload}"
    );
    assert_eq!(
        view["panels"][0]["chart_state"], "protocol-unverified",
        "{payload}"
    );
    assert_eq!(view["panels"][0]["chart_attempted"], false, "{payload}");
    assert!(
        view["panels"][0]["identity"]
            .as_str()
            .is_some_and(|line| line.contains("0x0056")),
        "raw bcdDevice disappeared from the backend-composed line: {payload}"
    );
    assert_eq!(
        view["inspection_note"], "Inspection only. KSX did not program or change this encoder.",
        "{payload}"
    );
    assert_eq!(machine.panel_status_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        *machine.panel_status_devices.lock().unwrap(),
        vec![Some("usb:d209:0430:00".to_owned())]
    );
    assert!(machine.picked.lock().unwrap().is_empty());
    assert!(machine.prepared_with.lock().unwrap().is_empty());
    assert!(machine.released_with.lock().unwrap().is_empty());
    assert!(control.bound_with.lock().unwrap().is_none());
}

/// A failed provider read is neither an unsupported device nor a healthy
/// empty inventory. It stays an unavailable envelope the card can Retry.
#[test]
fn panel_status_preserves_provider_refusal_as_unavailable() {
    let control = Arc::new(ScriptedControl::new(false));
    assert!(
        control
            .stage_edit(&ksx_api::StageEdit::ChooseDevice {
                selector: "usb:d209:0430:00".to_owned(),
                alias: "panel".to_owned(),
                label: "Ultimarc I-PAC 4X".to_owned(),
            })
            .ok
    );
    let machine = Arc::new(ScriptedMachine::panel_status_refusing());
    let addr = start_server_with_machine(control, machine.clone());

    let response = get(addr, "/api/panel/status");
    let payload: serde_json::Value =
        serde_json::from_str(body_of(&response)).expect("panel refusal envelope");
    assert_eq!(payload["target_selector"], "usb:d209:0430:00", "{payload}");
    assert!(
        payload["unavailable"]
            .as_str()
            .is_some_and(|line| line.contains("could not be read")),
        "{payload}"
    );
    assert!(payload["view"].is_null(), "{payload}");
    assert_eq!(machine.panel_status_calls.load(Ordering::SeqCst), 1);
}

/// The endpoint is local-read-only in both directions: a rebound Host cannot
/// reach it, and POST is not a hidden programming surface.
#[test]
fn panel_status_is_guarded_and_has_no_write_method() {
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(Arc::new(ScriptedControl::new(false)), machine.clone());
    let rebound = http(
        addr,
        "GET /api/panel/status HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n",
    );
    assert!(rebound.starts_with("HTTP/1.1 421"), "{rebound}");
    let posted = post_json(addr, "/api/panel/status", "{}");
    assert!(posted.starts_with("HTTP/1.1 405"), "{posted}");
    assert_eq!(machine.panel_status_calls.load(Ordering::SeqCst), 0);
}

/// Every panel POST can cause the machine provider to exchange HID reports,
/// including the nominally read-only chart and plan steps. A foreign page must
/// be stopped by the shared Origin guard before any of those typed verbs run.
#[test]
fn panel_report_routes_reject_foreign_origins_before_the_machine_provider() {
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(Arc::new(ScriptedControl::new(false)), machine.clone());

    for path in [
        "/api/panel/chart",
        "/api/panel/profiles/save",
        "/api/panel/profiles/delete",
        "/api/panel/program/plan",
        "/api/panel/program/apply",
        "/api/panel/restore/plan",
        "/api/panel/restore/apply",
    ] {
        let response = http(
            addr,
            &format!(
                "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: https://evil.example\r\n\
                 Content-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
            ),
        );
        assert!(
            response.starts_with("HTTP/1.1 403") || response.starts_with("HTTP/1.1 421"),
            "{path} reached a report-sending handler from a foreign origin: {response}"
        );
    }

    assert!(machine.panel_chart_specs.lock().unwrap().is_empty());
    assert!(machine.panel_profile_save_specs.lock().unwrap().is_empty());
    assert!(machine
        .panel_profile_delete_specs
        .lock()
        .unwrap()
        .is_empty());
    assert!(machine.panel_program_plan_specs.lock().unwrap().is_empty());
    assert!(machine.panel_program_specs.lock().unwrap().is_empty());
    assert!(machine.panel_restore_plan_specs.lock().unwrap().is_empty());
    assert!(machine.panel_restore_specs.lock().unwrap().is_empty());
}

/// Saved layouts are portable semantic profiles, not board-bound recovery
/// images. They can therefore be listed and edited before an encoder is
/// selected, while revisions still make update/delete stale-write safe. This
/// catches the broken version where the Studio treated profile deletion as a
/// hardware clear or trusted browser-supplied driver/protocol metadata.
#[test]
fn panel_profile_routes_create_update_and_delete_without_touching_hardware() {
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(Arc::new(ScriptedControl::new(false)), machine.clone());

    let listed = get(addr, "/api/panel/profiles");
    assert!(listed.starts_with("HTTP/1.1 200"), "{listed}");
    assert!(listed.contains("cache-control: no-store"), "{listed}");
    let listed: serde_json::Value = serde_json::from_str(body_of(&listed)).unwrap();
    assert!(listed["unavailable"].is_null(), "{listed}");
    assert_eq!(listed["view"]["config_root"], r"C:\cfg", "{listed}");
    assert_eq!(
        listed["view"]["terminal_signature"], "terminal-signature-56",
        "{listed}"
    );
    assert_eq!(
        listed["view"]["profiles"][0]["protocol_profile"], "ipac4-pac256-v1",
        "compatibility must be served by the backend: {listed}"
    );
    assert_eq!(machine.panel_profile_reads.load(Ordering::SeqCst), 1);
    assert_eq!(machine.panel_status_calls.load(Ordering::SeqCst), 0);

    let create_body = serde_json::json!({
        "name": "Tournament panel",
        "description": "Four players, six buttons each",
        "terminals": [{
            "terminal_id": "1sw4",
            "normal_key": "K",
            "shifted_key": null,
            "is_shift": false,
            "allow_shared_key": true
        }]
    })
    .to_string();
    let created = post_json(addr, "/api/panel/profiles/save", &create_body);
    assert!(created.contains("cache-control: no-store"), "{created}");
    let created: serde_json::Value = serde_json::from_str(body_of(&created)).unwrap();
    assert_eq!(created["mutation"]["state"], "created", "{created}");
    assert_eq!(
        created["mutation"]["profile"]["name"], "Tournament panel",
        "{created}"
    );
    let saves = machine.panel_profile_save_specs.lock().unwrap();
    assert_eq!(saves.len(), 1);
    assert!(saves[0].profile_id.is_none());
    assert!(saves[0].expected_revision.is_none());
    assert_eq!(saves[0].terminals[0].normal_key.as_deref(), Some("K"));
    assert!(saves[0].terminals[0].allow_shared_key);
    drop(saves);

    let update_body = serde_json::json!({
        "profile_id": "four-player-cabinet",
        "expected_revision": "revision-A",
        "name": "Tournament panel v2",
        "description": "Renamed in Studio",
        "terminals": [{
            "terminal_id": "1sw4",
            "normal_key": "J",
            "is_shift": false,
            "allow_shared_key": false
        }]
    })
    .to_string();
    let updated = post_json(addr, "/api/panel/profiles/save", &update_body);
    let updated: serde_json::Value = serde_json::from_str(body_of(&updated)).unwrap();
    assert_eq!(updated["mutation"]["state"], "updated", "{updated}");
    assert_eq!(
        updated["mutation"]["profile"]["revision"], "revision-B",
        "{updated}"
    );
    let saves = machine.panel_profile_save_specs.lock().unwrap();
    assert_eq!(saves.len(), 2);
    assert_eq!(saves[1].profile_id.as_deref(), Some("four-player-cabinet"));
    assert_eq!(saves[1].expected_revision.as_deref(), Some("revision-A"));
    drop(saves);

    let deleted = post_json(
        addr,
        "/api/panel/profiles/delete",
        r#"{"profile_id":"four-player-cabinet","expected_revision":"revision-B"}"#,
    );
    let deleted: serde_json::Value = serde_json::from_str(body_of(&deleted)).unwrap();
    assert_eq!(deleted["mutation"]["state"], "deleted", "{deleted}");
    assert!(deleted["mutation"]["profile"].is_null(), "{deleted}");
    let deletes = machine.panel_profile_delete_specs.lock().unwrap();
    assert_eq!(deletes.len(), 1);
    assert_eq!(deletes[0].profile_id, "four-player-cabinet");
    assert_eq!(deletes[0].expected_revision, "revision-B");

    assert!(
        machine.panel_program_specs.lock().unwrap().is_empty(),
        "deleting a saved profile must never clear the physical encoder"
    );
    assert!(machine.panel_restore_specs.lock().unwrap().is_empty());
}

/// Axum must reject incomplete profile JSON before a machine verb sees it.
/// This catches a permissive transport that defaulted an omitted complete
/// terminal chart to an empty profile or deleted without a reviewed revision.
#[test]
fn panel_profile_routes_reject_incomplete_json_before_the_provider() {
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(Arc::new(ScriptedControl::new(false)), machine.clone());

    let save = post_json(
        addr,
        "/api/panel/profiles/save",
        r#"{"name":"Incomplete","description":"missing terminal chart"}"#,
    );
    assert!(save.starts_with("HTTP/1.1 422"), "{save}");
    let delete = post_json(
        addr,
        "/api/panel/profiles/delete",
        r#"{"profile_id":"four-player-cabinet"}"#,
    );
    assert!(delete.starts_with("HTTP/1.1 422"), "{delete}");
    assert!(machine.panel_profile_save_specs.lock().unwrap().is_empty());
    assert!(machine
        .panel_profile_delete_specs
        .lock()
        .unwrap()
        .is_empty());
}

/// The encoder programmer is one supervised flow over the typed machine
/// verbs: read + immutable backup, exact diff, explicit write, readback result,
/// and a separately reviewed restore. The staged selector remains the server's
/// authority in every request.
#[test]
fn panel_programming_routes_preserve_the_backup_plan_confirm_verify_contract() {
    let control = Arc::new(ScriptedControl::new(false));
    assert!(
        control
            .stage_edit(&ksx_api::StageEdit::ChooseDevice {
                selector: "usb:d209:0430:00".to_owned(),
                alias: "panel".to_owned(),
                label: "Ultimarc I-PAC 4X".to_owned(),
            })
            .ok
    );
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(control, machine.clone());

    let chart = post_json(
        addr,
        "/api/panel/chart",
        r#"{"expected_selector":"usb:d209:0430:00","backup":true}"#,
    );
    assert!(chart.starts_with("HTTP/1.1 200"), "{chart}");
    assert!(chart.contains("cache-control: no-store"), "{chart}");
    let chart: serde_json::Value = serde_json::from_str(body_of(&chart)).unwrap();
    assert_eq!(chart["target_selector"], "usb:d209:0430:00", "{chart}");
    assert_eq!(chart["view"]["programming_state"], "supervised", "{chart}");
    assert_eq!(
        chart["view"]["protocol_profile"], "ipac4-pac256-v1",
        "{chart}"
    );
    assert_eq!(chart["view"]["image_bytes"], 256, "{chart}");
    assert_eq!(
        chart["view"]["terminals"][0]["shift_state"], "disabled",
        "an is_shift=false compatibility bit must not hide an opaque shift byte: {chart}"
    );
    assert_eq!(chart["view"]["terminals"][0]["is_shift"], false);
    assert_eq!(
        chart["view"]["recommended_terminals"][0]["normal"]["key"],
        "A",
        "Studio receives a semantic backend-owned recommendation instead of recreating key bytes: {chart}"
    );
    assert_eq!(
        chart["view"]["key_options"][0]["safe_for_qualification"], true,
        "Studio must receive the backend-owned first-write key policy: {chart}"
    );
    let chart_calls = machine.panel_chart_specs.lock().unwrap();
    assert_eq!(chart_calls.len(), 1);
    assert_eq!(chart_calls[0].device.as_deref(), Some("usb:d209:0430:00"));
    assert!(chart_calls[0].backup);
    drop(chart_calls);

    let backups = get(addr, "/api/panel/backups");
    let backups: serde_json::Value = serde_json::from_str(body_of(&backups)).unwrap();
    assert_eq!(backups["view"]["backups"].as_array().map(Vec::len), Some(1));
    assert_eq!(
        machine.panel_backup_specs.lock().unwrap()[0]
            .device
            .as_deref(),
        Some("usb:d209:0430:00")
    );

    let plan = post_json(
        addr,
        "/api/panel/program/plan",
        &format!(
            r#"{{"expected_selector":"usb:d209:0430:00","expected_base_sha256":"{}","layout":"custom","edits":[{{"terminal_id":"1sw4","normal_key":"K"}}]}}"#,
            "A".repeat(64)
        ),
    );
    let plan: serde_json::Value = serde_json::from_str(body_of(&plan)).unwrap();
    assert!(plan["unavailable"].is_null(), "{plan}");
    assert_eq!(plan["plan"]["desired_sha256"], "B".repeat(64), "{plan}");
    let planned = machine.panel_program_plan_specs.lock().unwrap();
    assert_eq!(planned.len(), 1);
    assert_eq!(planned[0].device.as_deref(), Some("usb:d209:0430:00"));
    assert_eq!(planned[0].edits[0].terminal_id, "1sw4");
    drop(planned);

    let applied = post_json(
        addr,
        "/api/panel/program/apply",
        &format!(
            r#"{{"expected_selector":"usb:d209:0430:00","program":{{"expected_base_sha256":"{}","layout":"custom","edits":[{{"terminal_id":"1sw4","normal_key":"K"}}]}},"expected_board_fingerprint":"ultimarc-ipac:D209:0430:board-4","expected_protocol_profile":"ipac4-pac256-v1","expected_desired_sha256":"{}","confirm":true,"supervised":true}}"#,
            "A".repeat(64),
            "B".repeat(64)
        ),
    );
    let applied: serde_json::Value = serde_json::from_str(body_of(&applied)).unwrap();
    assert_eq!(applied["outcome"]["state"], "verified", "{applied}");
    assert_eq!(applied["mutation_disposition"], "verified", "{applied}");
    let writes = machine.panel_program_specs.lock().unwrap();
    assert_eq!(writes.len(), 1);
    assert!(writes[0].confirm);
    assert!(writes[0].supervised);
    assert_eq!(
        writes[0].expected_board_fingerprint,
        "ultimarc-ipac:D209:0430:board-4"
    );
    assert_eq!(writes[0].expected_protocol_profile, "ipac4-pac256-v1");
    assert_eq!(
        writes[0].program.device.as_deref(),
        Some("usb:d209:0430:00")
    );
    drop(writes);

    let restore_plan = post_json(
        addr,
        "/api/panel/restore/plan",
        &format!(
            r#"{{"expected_selector":"usb:d209:0430:00","backup_id":"20260823-120000-A1B2C3D4E5F6","expected_current_sha256":"{}"}}"#,
            "B".repeat(64)
        ),
    );
    let restore_plan: serde_json::Value = serde_json::from_str(body_of(&restore_plan)).unwrap();
    assert!(restore_plan["plan"]["summary"]
        .as_str()
        .is_some_and(|line| line.starts_with("Restore")));

    let restored = post_json(
        addr,
        "/api/panel/restore/apply",
        &format!(
            r#"{{"expected_selector":"usb:d209:0430:00","restore":{{"backup_id":"20260823-120000-A1B2C3D4E5F6","expected_current_sha256":"{}"}},"expected_board_fingerprint":"ultimarc-ipac:D209:0430:board-4","expected_protocol_profile":"ipac4-pac256-v1","expected_desired_sha256":"{}","confirm":true,"supervised":true}}"#,
            "B".repeat(64),
            "B".repeat(64)
        ),
    );
    let restored: serde_json::Value = serde_json::from_str(body_of(&restored)).unwrap();
    assert_eq!(restored["mutation_disposition"], "verified", "{restored}");
    assert!(restored["outcome"]["summary"]
        .as_str()
        .is_some_and(|line| line.contains("restored")));
    assert_eq!(machine.panel_restore_specs.lock().unwrap().len(), 1);
}

/// A browser selector is a stale-screen assertion, never authority, and a
/// live Play session is a hard stop before the provider can see a write.
#[test]
fn panel_programming_rejects_stale_targets_and_live_session_writes() {
    let running = Arc::new(ScriptedControl::new(false));
    running.running.store(true, Ordering::SeqCst);
    assert!(
        running
            .stage_edit(&ksx_api::StageEdit::ChooseDevice {
                selector: "usb:d209:0430:00".to_owned(),
                alias: "panel".to_owned(),
                label: "Ultimarc I-PAC 4X".to_owned(),
            })
            .ok
    );
    let machine = Arc::new(ScriptedMachine::default());
    let addr = start_server_with_machine(running, machine.clone());

    let stale = post_json(
        addr,
        "/api/panel/chart",
        r#"{"expected_selector":"usb:d209:0431:00","backup":true}"#,
    );
    let stale: serde_json::Value = serde_json::from_str(body_of(&stale)).unwrap();
    assert!(stale["unavailable"]
        .as_str()
        .is_some_and(|line| line.contains("changed")));
    assert!(machine.panel_chart_specs.lock().unwrap().is_empty());

    let blocked = post_json(
        addr,
        "/api/panel/program/apply",
        &format!(
            r#"{{"expected_selector":"usb:d209:0430:00","program":{{"expected_base_sha256":"{}","layout":"custom","edits":[]}},"expected_board_fingerprint":"ultimarc-ipac:D209:0430:board-4","expected_protocol_profile":"ipac4-pac256-v1","expected_desired_sha256":"{}","confirm":true,"supervised":true}}"#,
            "A".repeat(64),
            "B".repeat(64)
        ),
    );
    let blocked: serde_json::Value = serde_json::from_str(body_of(&blocked)).unwrap();
    assert_eq!(blocked["mutation_disposition"], "not-started", "{blocked}");
    assert!(blocked["unavailable"]
        .as_str()
        .is_some_and(|line| line.contains("stop Play")));
    assert!(machine.panel_program_specs.lock().unwrap().is_empty());
}
