//! A standalone ksx Studio serving FIXED data, for browser-level tests of the
//! client island (`studio-ui/pwtest`).
//!
//! The macro editor's state lives entirely in the browser — the draft, which
//! step the duration editor points at, the authored unit — and none of it is
//! reachable from a Rust test. So the DOM-level tests drive a real page, and
//! this is the backend they drive it against: the same `ksx_studio::serve` the
//! app uses, wired to a preset that never changes underfoot.
//!
//! Saves are kept in memory and served back by the next `/api/map` poll, which
//! is what makes "the unit survives save and reload" testable at all.
//!
//! Loopback only, and the port is an argument so it can never collide with the
//! user's own `ksx studio` (4460):
//!
//! ```text
//! cargo run -p ksx-studio --example macro_fixture -- 4476
//! ```

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use ksx_studio::{
    ControlSource, MacroOutcome, MacroSnapshot, MacroStepView, MacroView, MacroWrite, MapperSlot,
    MapperSnapshot, PadRow, ProfileRow, SessionView, StatusSnapshot, StatusSource,
};

const PRESET: &str = "Panel P1";

fn mac(name: &str, steps: Vec<MacroStepView>) -> MacroView {
    MacroView {
        name: name.into(),
        steps,
        on_release: "finish".into(),
        retrigger: "ignore".into(),
        interrupt: "none".into(),
        repeat: "once".into(),
        turbo_hz: None,
        gap_ms: None,
        triggers: vec!["P".into()],
        disabled: false,
    }
}

fn ms_step(hold: &[&str], ms: u32) -> MacroStepView {
    MacroStepView {
        hold: hold.iter().map(|s| (*s).to_owned()).collect(),
        ms: Some(ms),
        frames: None,
        allow_short: false,
    }
}

/// The preset the page opens on.
///
/// `piano` — step 1 authored in `ms`, step 2 authored in `frames`: the two
/// spellings §1c keeps apart, so a test can watch either one round-trip.
///
/// `written-by-hand` — steps NOBODY MADE THROUGH THIS PAGE. Named to sort
/// AFTER `piano`: `save_macro` re-sorts the table, and the page opens on the
/// FIRST macro, so a fixture macro that sorted first would silently become what
/// every other test is looking at once anything is saved. This is the round trip
/// the diagonal lens promises: a hold that names two ordinary bindings must
/// DISPLAY as the diagonal, including when it is spelled at a partial
/// deflection, when a button rides along with it, and (never) when it
/// contradicts itself.
fn seed_macros() -> Vec<MacroView> {
    vec![
        mac(
            "piano",
            vec![
                ms_step(&["dpad.down"], 50),
                MacroStepView {
                    hold: vec!["A".into()],
                    ms: None,
                    frames: Some(3),
                    allow_short: false,
                },
                ms_step(&["B"], 80),
            ],
        ),
        mac(
            "written-by-hand",
            vec![
                // The canonical pair — reads back as D-pad ↘.
                ms_step(&["dpad.down", "dpad.right"], 50),
                // A hand-written partial deflection — still LS ↘, labelled.
                ms_step(&["ly.-16384", "lx.max"], 50),
                // The single most common macro step in existence.
                ms_step(&["dpad.down", "dpad.right", "A"], 50),
                // Contradictory: never folded, never guessed.
                ms_step(&["dpad.down", "dpad.right", "dpad.up"], 50),
                // The hat+stick double-binding every in-box template writes.
                ms_step(&["dpad.down", "dpad.right", "ly.min", "lx.max"], 50),
            ],
        ),
    ]
}

/// The fixture's state: what Save wrote (served back exactly as a real
/// preset file would), a REAL staged setup driven by the REAL staging engine
/// (`StageEdit::apply` / `StagedSetupView::of` — the ScriptedControl
/// pattern, so nothing this double serves is hand-written), and a scripted
/// learner so identify-by-key completes a round-trip.
#[derive(Clone)]
struct Store {
    macros: Arc<Mutex<Vec<MacroView>>>,
    stage: Arc<Mutex<ksx_core::stage::StagedSetup>>,
    /// Set by any HTTP-driven staging edit (the seed does not count), the
    /// way the daemon's StageMeta stamps `dirty` — so the Apply button's
    /// running+dirty visibility is drivable on this double.
    dirty: Arc<AtomicBool>,
    /// `Some(generation)` while the scripted learner is "listening"; the next
    /// poll answers with a hit on the fixture I-PAC and clears it.
    listening: Arc<Mutex<Option<u64>>>,
}

impl Store {
    fn new() -> Self {
        Self {
            dirty: Arc::new(AtomicBool::new(false)),
            macros: Arc::new(Mutex::new(seed_macros())),
            stage: Arc::new(Mutex::new(seeded_stage())),
            listening: Arc::new(Mutex::new(None)),
        }
    }
}

/// Seed the fixture's draft THROUGH the real staging engine: a board, two
/// authored controllers, an order-aware SOCD and the split answer — the same
/// edits a user's clicks would apply, so every roster, cap and sentence the
/// view serves is the engine's own.
fn seeded_stage() -> ksx_core::stage::StagedSetup {
    let mut setup = ksx_core::stage::StagedSetup::new();
    let mut apply = |edit: ksx_api::StageEdit| match edit.apply(&setup) {
        Ok(next) => setup = next,
        Err(refusal) => panic!("fixture seed edit refused: {}", refusal.message),
    };
    apply(ksx_api::StageEdit::ChooseDevice {
        selector: "usb:d209:0430:00".into(),
        alias: "panel".into(),
        label: "Ultimarc I-PAC 4".into(),
    });
    apply(ksx_api::StageEdit::AddSlot {
        number: None,
        persona: "xbox360".into(),
        preset: "Player 1".into(),
        layout: Some("arcade-6button".into()),
    });
    apply(ksx_api::StageEdit::SetBindings {
        number: 1,
        preset: Box::new(authored_preset("Player 1")),
    });
    apply(ksx_api::StageEdit::SetSocd {
        number: 1,
        socd: "last-input".into(),
    });
    apply(ksx_api::StageEdit::AddSlot {
        number: None,
        persona: "playstation".into(),
        preset: "Player 2".into(),
        layout: Some("arcade-6button".into()),
    });
    apply(ksx_api::StageEdit::SetBindings {
        number: 2,
        preset: Box::new(authored_preset("Player 2")),
    });
    apply(ksx_api::StageEdit::SetBlocking {
        blocking: "bound-keys".into(),
    });
    if std::env::var("KSX_FIXTURE_FIRST").as_deref() == Ok("ps") {
        apply(ksx_api::StageEdit::ReorderSlots {
            numbers: vec![2, 1],
        });
    }
    setup
}

/// The authored preset both fixture controllers bind — real authoring tables,
/// so the binding pane shows rows with the interesting notes: a multi-bind
/// with fan-out, a turbo'd trigger, a latched bumper.
fn authored_preset(name: &str) -> ksx_config::PresetFile {
    use ksx_core::preset::Binding;
    use ksx_core::{Axis, DpadDirection, Key, XButton, AXIS_MAX, AXIS_MIN};
    let core = ksx_core::Preset {
        name: name.to_owned(),
        entries: vec![
            (Key::G, Binding::Button(XButton::A)),
            (Key::H, Binding::Button(XButton::A)),
            (Key::G, Binding::Button(XButton::B)),
            (Key::J, Binding::Button(XButton::X)),
            (Key::K, Binding::Button(XButton::Y)),
            (Key::T, Binding::Trigger(ksx_core::Trigger::Right)),
            (Key::L, Binding::Button(XButton::LeftBumper)),
            (
                Key::W,
                Binding::Axis {
                    axis: Axis::Y,
                    value: AXIS_MAX,
                },
            ),
            (
                Key::S,
                Binding::Axis {
                    axis: Axis::Y,
                    value: AXIS_MIN,
                },
            ),
            (
                Key::A,
                Binding::Axis {
                    axis: Axis::X,
                    value: AXIS_MIN,
                },
            ),
            (
                Key::D,
                Binding::Axis {
                    axis: Axis::X,
                    value: AXIS_MAX,
                },
            ),
            (Key::Up, Binding::Dpad(DpadDirection::Up)),
            (Key::Down, Binding::Dpad(DpadDirection::Down)),
            (Key::Enter, Binding::Button(XButton::Start)),
        ],
        chords: Vec::new(),
        // One REAL macro with a trigger key, so the right pane's macro
        // lifecycle rows have a fact to show: a three-step quarter-circle
        // ending on X, started by P.
        macros: ksx_core::Macros {
            defs: vec![ksx_core::Macro {
                name: "hadouken".into(),
                steps: vec![
                    ksx_core::MacroStep {
                        hold: vec![Binding::Dpad(DpadDirection::Down)],
                        duration: ksx_core::StepDuration::Ms(50),
                        allow_short: false,
                    },
                    ksx_core::MacroStep {
                        hold: vec![
                            Binding::Dpad(DpadDirection::Down),
                            Binding::Dpad(DpadDirection::Right),
                        ],
                        duration: ksx_core::StepDuration::Ms(50),
                        allow_short: false,
                    },
                    ksx_core::MacroStep {
                        hold: vec![Binding::Button(XButton::X)],
                        duration: ksx_core::StepDuration::Ms(80),
                        allow_short: false,
                    },
                ],
                on_release: Default::default(),
                retrigger: Default::default(),
                interrupt: Default::default(),
                repeat: Default::default(),
                turbo: None,
                enabled: true,
            }],
            triggers: vec![ksx_core::MacroTrigger::new(Key::P, 0)],
        },
        turbo: vec![ksx_core::TurboBinding::new(
            Binding::Trigger(ksx_core::Trigger::Right),
            12,
        )],
        toggle: vec![Binding::Button(XButton::LeftBumper)],
        protected: false,
    };
    ksx_config::PresetFile::from_core(&core)
}

impl StatusSource for Store {
    fn snapshot(&self) -> StatusSnapshot {
        StatusSnapshot {
            generated_at: "fixture".into(),
            vigem: "installed".into(),
            hidmaestro: ksx_api::ControllerOutputView::hidmaestro_inventory(
                true,
                false,
                Some("1.6.1".into()),
            ),
            interception: "installed".into(),
            daemon_running: true,
            daemon_detail: "fixture".into(),
            autostart: "not registered".into(),
            pads: vec![PadRow {
                persona: "Xbox 360 pad".into(),
                instance: "USB\\FIXTURE\\1".into(),
            }],
            profiles: vec![ProfileRow {
                title: "Fixture".into(),
                detail: "C:\\fixture.exe — 1 slot".into(),
            }],
            config_root: "C:\\fixture".into(),
        }
    }

    fn mapper(&self) -> MapperSnapshot {
        MapperSnapshot {
            generated_at: "fixture".into(),
            source: "fixture".into(),
            profile: None,
            config_root: "C:\\fixture".into(),
            slots: vec![MapperSlot {
                number: 1,
                persona: "xbox360".into(),
                persona_label: "Xbox 360".into(),
                preset: PRESET.into(),
                keyboard: "HID\\FIXTURE".into(),
                bindings: BTreeMap::from([("A".to_owned(), vec!["G".to_owned()])]),
                backup: None,
                session_backup: false,
                turbo: BTreeMap::new(),
                toggle: Default::default(),
                macros_off: false,
            }],
        }
    }

    fn macros(&self, preset: &str) -> MacroSnapshot {
        MacroSnapshot::read(preset, self.macros.lock().unwrap().clone())
    }
}

/// Which session the fixture reports, from `KSX_FIXTURE_SESSION`.
///
/// The default is unchanged (`idle`) — every existing pwtest depends on it.
/// The other two exist so the SSR-vs-hydration parity check can be run in the
/// states where the show pairs actually MOVE: `running` flips
/// pillRunning/canStop/rowsPlain/sessionRunning/readOnly, and `down` flips the
/// whole no-daemon surface. Those are the only states where a first paint
/// could visibly disagree with what the client renders a moment later.
fn fixture_session() -> SessionView {
    match std::env::var("KSX_FIXTURE_SESSION").as_deref() {
        // The running fixture session is STAGED-origin: it "runs" the seeded
        // draft this fixture holds, which is what licenses the live echo to
        // paint onto the staged rows (the fail-closed origin rule).
        Ok("running") => SessionView {
            reachable: true,
            running: true,
            line: "running — Fixture — 2 pad(s)".into(),
            profile: None,
            origin: ksx_api::SessionOrigin::Staged,
            active: Some(ksx_api::ActiveSessionView {
                elapsed: "2m 07s".into(),
                input: "one keyboard captured (fixture)".into(),
                outputs: "2 virtual pads (fixture)".into(),
                escape_hatch: ksx_api::stage::ESCAPE_HATCH_LINE.into(),
            }),
        },
        Ok("down") => SessionView::unreachable("no daemon control channel"),
        _ => SessionView {
            reachable: true,
            running: false,
            line: "idle".into(),
            profile: None,
            origin: ksx_api::SessionOrigin::Unknown,
            active: None,
        },
    }
}

impl ControlSource for Store {
    /// EVERY staging verb, through the real engine — `StageEdit::apply` is
    /// the same code the daemon runs, so the double cannot drift from it.
    fn stage_edit(&self, edit: &ksx_api::StageEdit) -> ksx_api::StageOutcome {
        let mut setup = self.stage.lock().unwrap();
        match edit.apply(&setup) {
            Ok(next) => {
                *setup = next;
                self.dirty.store(true, Ordering::SeqCst);
                ksx_api::StageOutcome::ok(&setup, "staged")
            }
            Err(refusal) => ksx_api::StageOutcome::refused(&setup, &refusal),
        }
    }

    /// A scripted learner: listening answers the NEXT poll with a hit on the
    /// fixture I-PAC, so identify-by-key completes its whole transaction
    /// (listen → resolve → stage) against this double.
    fn learn_start(&self) -> ksx_api::LearnView {
        let mut listening = self.listening.lock().unwrap();
        let generation = listening.map_or(1, |generation| generation + 1);
        *listening = Some(generation);
        ksx_api::LearnView {
            ok: true,
            state: "listening".into(),
            generation: Some(generation),
            remaining_ms: Some(11_000),
            device: None,
            key: None,
            error: None,
        }
    }

    fn learn_poll(&self) -> ksx_api::LearnView {
        let mut listening = self.listening.lock().unwrap();
        match listening.take() {
            Some(generation) => ksx_api::LearnView {
                ok: true,
                state: "hit".into(),
                generation: Some(generation),
                remaining_ms: None,
                device: Some("HID\\VID_D209&PID_0430\\FIXTURE".into()),
                key: Some("G".into()),
                error: None,
            },
            None => ksx_api::LearnView {
                ok: true,
                state: "idle".into(),
                generation: None,
                remaining_ms: None,
                device: None,
                key: None,
                error: None,
            },
        }
    }

    fn learn_cancel_generation(&self, _generation: Option<u64>) -> ksx_api::LearnView {
        *self.listening.lock().unwrap() = None;
        ksx_api::LearnView {
            ok: true,
            state: "cancelled".into(),
            generation: None,
            remaining_ms: None,
            device: None,
            key: None,
            error: None,
        }
    }

    fn session(&self) -> SessionView {
        fixture_session()
    }

    /// The staged draft the workspace panes render — a board, two controllers
    /// (one carrying an order-aware SOCD), the served rosters, and unsaved
    /// edits — so the visual gate screenshots the pane DOING ITS JOB rather
    /// than the failed-read fallback, and a reviewer sees the rack, the add
    /// form, the capture rows and the dirty note in every context.
    ///
    /// `KSX_FIXTURE_FIRST=ps` puts the PlayStation controller first, which is
    /// how a reviewer screenshots the stage's DualShock schematic (the show
    /// pair follows the first slot's family).
    fn staged(&self) -> ksx_api::StagedSetupView {
        let mut view = ksx_api::StagedSetupView::of(&self.stage.lock().unwrap());
        view.dirty = self.dirty.load(Ordering::SeqCst);
        view
    }

    /// Play, scripted: the engine's own readiness answers — a draft that
    /// commits "starts" (this double runs no sessions; the flash is the
    /// thing under test), and an unready one refuses with the engine's
    /// sentence.
    fn stage_play(&self) -> ksx_api::StageOutcome {
        let setup = self.stage.lock().unwrap();
        match setup.commit() {
            Ok(_) => ksx_api::StageOutcome::ok(&setup, "started"),
            Err(err) => {
                let refusal = ksx_api::Refusal::new("not-ready", err.to_string());
                ksx_api::StageOutcome::refused(&setup, &refusal)
            }
        }
    }

    /// Apply-in-place, the daemon's shape: refused when nothing runs; ok
    /// (and the dirty bit settles) when the fixture session is running.
    fn stage_apply(&self) -> ksx_api::StageOutcome {
        let setup = self.stage.lock().unwrap();
        if !fixture_session().running {
            let refusal =
                ksx_api::Refusal::new("no-session", "nothing is running to apply the draft to");
            return ksx_api::StageOutcome::refused(&setup, &refusal);
        }
        // KSX_FIXTURE_APPLY=restart scripts the structural-difference shape,
        // in a daemon-shaped sentence, so the quoting dialog is drivable.
        if std::env::var("KSX_FIXTURE_APPLY").as_deref() == Ok("restart") {
            let refusal = ksx_api::Refusal::new(
                "needs-restart",
                "the draft adds controller P3 (Xbox 360), which the running session does not have — only a replaced session can plug it",
            );
            return ksx_api::StageOutcome::refused(&setup, &refusal);
        }
        self.dirty.store(false, Ordering::SeqCst);
        ksx_api::StageOutcome::ok(&setup, "applied in place")
    }

    /// Adoption, with the daemon's exact refusal discipline: never over a
    /// non-empty draft (`stage-not-empty`), and LOAD only — nothing starts.
    /// The fixture's "saved configuration" and both of its "saved games"
    /// adopt back the seeded two-player setup, which makes the whole menu
    /// loop drivable: Start over → empty → Load → the draft returns.
    fn stage_adopt(&self, profile: Option<&str>) -> ksx_api::StageOutcome {
        let mut setup = self.stage.lock().unwrap();
        if !ksx_api::StagedSetupView::of(&setup).empty {
            let refusal = ksx_api::Refusal::new(
                "stage-not-empty",
                "this draft already has content; discard it before loading",
            );
            return ksx_api::StageOutcome::refused(&setup, &refusal);
        }
        if let Some(title) = profile {
            if !title.eq_ignore_ascii_case("Street Fighter 6")
                && !title.eq_ignore_ascii_case("MAME cabinet")
            {
                let refusal = ksx_api::Refusal::new(
                    "unknown-profile",
                    format!("no saved game named \"{title}\""),
                );
                return ksx_api::StageOutcome::refused(&setup, &refusal);
            }
        }
        *setup = seeded_stage();
        ksx_api::StageOutcome::ok(&setup, "adopted")
    }

    fn start(&self, _profile: Option<&str>) -> Result<String, ksx_api::Refusal> {
        Ok("running (1 slot(s))".into())
    }

    fn stop(&self) -> Result<String, ksx_api::Refusal> {
        Ok("stopped".into())
    }

    fn reload(&self) -> Result<String, ksx_api::Refusal> {
        Ok("running (1 slot(s))".into())
    }

    /// Whole table in, whole table out — the same shape `mapping::save_macro`
    /// writes, so what the next poll serves is what the grid sent.
    fn save_macro(&self, request: &MacroWrite) -> MacroOutcome {
        let mut held = self.macros.lock().unwrap();
        held.retain(|m| !m.name.eq_ignore_ascii_case(&request.name));
        if !request.delete {
            held.push(MacroView {
                name: request.name.clone(),
                steps: request.steps.clone(),
                on_release: request.on_release.clone(),
                retrigger: request.retrigger.clone(),
                interrupt: request.interrupt.clone(),
                repeat: request.repeat.clone(),
                turbo_hz: request.turbo_hz,
                gap_ms: request.gap_ms,
                // Triggers live in `[bindings]`, not in the macro table — the
                // real writer does not touch them either.
                triggers: vec!["P".into()],
                // A whole-table write carries the flag like any field.
                disabled: request.enabled == Some(false),
            });
            held.sort_by(|a, b| a.name.cmp(&b.name));
        }
        MacroOutcome {
            ok: true,
            message: Some(format!("\"{PRESET}\": macro \"{}\" saved", request.name)),
            deleted: request.delete,
            reloaded: request.reload,
            ..MacroOutcome::default()
        }
    }
}

/// The live fan-out's double. Open refuses while the fixture is "idle";
/// running, each stream loops the same four-beat choreography at a gentle
/// rate (the real feed is consumer-coalesced ~60 Hz; a demo does not need
/// to be).
struct ScriptedLive;

impl ksx_api::LiveSource for ScriptedLive {
    fn open(&self) -> Result<Box<dyn ksx_api::LiveStream>, ksx_api::Refusal> {
        // Its OWN opt-in, deliberately separate from KSX_FIXTURE_SESSION:
        // the parity gate captures the running session's first paint, and a
        // frame arriving inside that capture window is a legitimate
        // post-load dynamic the gate would (rightly) flag as a flash.
        let opted_in = std::env::var("KSX_FIXTURE_LIVE").as_deref() == Ok("1")
            && std::env::var("KSX_FIXTURE_SESSION").as_deref() == Ok("running");
        if !opted_in {
            return Err(ksx_api::Refusal::not_here(
                "the live echo — nothing is running on this fixture",
                "restart the fixture with KSX_FIXTURE_SESSION=running and KSX_FIXTURE_LIVE=1",
            ));
        }
        Ok(Box::new(ScriptedLiveStream { step: 0 }))
    }
}

struct ScriptedLiveStream {
    step: usize,
}

impl ksx_api::LiveStream for ScriptedLiveStream {
    fn next_frame(&mut self) -> Result<ksx_api::LiveEnvelope, ksx_api::Refusal> {
        std::thread::sleep(std::time::Duration::from_millis(400));
        let phase = self.step % 4;
        self.step += 1;
        // The seeded preset's own vocabulary: W holds the stick up (ly.max),
        // G is the shared key driving A and B, T is the turbo'd RT.
        let (down, hit, keys): (Vec<&str>, Vec<&str>, Vec<(&str, bool)>) = match phase {
            0 => (vec!["ly.max"], vec!["ly.max"], vec![("W", true)]),
            1 => (vec!["ly.max", "a", "b"], vec!["a", "b"], vec![("G", true)]),
            2 => (
                vec!["rt"],
                vec!["rt"],
                vec![("W", false), ("G", false), ("T", true)],
            ),
            _ => (
                vec![],
                vec!["x"],
                vec![("T", false), ("J", true), ("J", false)],
            ),
        };
        Ok(ksx_api::LiveEnvelope {
            frame: ksx_api::LiveFrame {
                running: true,
                slots: vec![ksx_api::SlotLive {
                    slot: 1,
                    down: down.iter().map(|s| s.to_string()).collect(),
                    hit: hit.iter().map(|s| s.to_string()).collect(),
                    rt: if phase == 2 { 255 } else { 0 },
                    ly: if phase <= 1 { 32767 } else { 0 },
                    ..Default::default()
                }],
                keys: keys
                    .iter()
                    .map(|(key, down)| ksx_api::KeyHit {
                        key: (*key).to_string(),
                        device: "HID\\VID_D209&PID_0430\\FIXTURE".into(),
                        alias: "panel".into(),
                        down: *down,
                    })
                    .collect(),
                ..Default::default()
            },
            unavailable: None,
        })
    }
}

fn main() {
    let port: u16 = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(4476);
    let bind: SocketAddr = ([127, 0, 0, 1], port).into();
    let store = Store::new();
    println!("macro fixture on http://{bind}/map");
    // The fixture drives the MAPPER, so the machine provider is the trait's
    // own defaults: every method refuses in words and names the CLI verb that
    // works. /devices, /profiles, /setup and /pads under this fixture
    // therefore render their refusal states — /pads honestly says it cannot
    // read the bus rather than inventing one — which are real states of those
    // pages and worth being able to look at.
    struct NoMachine {
        /// The sign-in task's one bit, so the menu's toggle round-trips.
        autostart: std::sync::atomic::AtomicBool,
    }
    impl ksx_api::MachineSource for NoMachine {
        /// The configuration menu's identity row: a config.toml with the two
        /// seeded controllers.
        fn setup_state(&self) -> Result<ksx_api::SetupView, ksx_api::Refusal> {
            Ok(ksx_api::SetupView {
                config_exists: true,
                slots: vec![
                    ksx_api::SetupSlotRow {
                        number: 1,
                        device: "panel".into(),
                        preset: "Player 1".into(),
                        persona: "Xbox 360 pad".into(),
                        socd: String::new(),
                        source: "config.toml".into(),
                    },
                    ksx_api::SetupSlotRow {
                        number: 2,
                        device: "panel".into(),
                        preset: "Player 2".into(),
                        persona: "PlayStation pad".into(),
                        socd: String::new(),
                        source: "config.toml".into(),
                    },
                ],
                ..ksx_api::SetupView::default()
            })
        }

        /// Two saved games: one ready, one with its program missing — the
        /// broken row is a real state of the menu and worth looking at.
        fn profiles(&self) -> Result<ksx_api::ProfilesView, ksx_api::Refusal> {
            Ok(ksx_api::ProfilesView {
                generated_at: "fixture".into(),
                config_root: "C:\\fixture".into(),
                games_path: "C:\\fixture\\games.toml".into(),
                profiles: vec![
                    ksx_api::ProfileDetail {
                        revision: "fx-sf6".into(),
                        title: "Street Fighter 6".into(),
                        path: "C:\\Games\\sf6.exe".into(),
                        arguments: String::new(),
                        slots: 2,
                        presets: vec!["Player 1".into(), "Player 2".into()],
                        state: "ok".into(),
                        verdict: "the program is there".into(),
                        broken_path: None,
                    },
                    ksx_api::ProfileDetail {
                        revision: "fx-mame".into(),
                        title: "MAME cabinet".into(),
                        path: "D:\\arcade\\mame.exe".into(),
                        arguments: "-skip_gameinfo".into(),
                        slots: 4,
                        presets: vec!["Player 1".into()],
                        state: "broken".into(),
                        verdict: "game profile 'MAME cabinet' points at a program that does \
                                  not exist"
                            .into(),
                        broken_path: Some("D:\\arcade\\mame.exe".into()),
                    },
                ],
                notes: Vec::new(),
            })
        }

        fn autostart(&self) -> Result<ksx_api::AutostartView, ksx_api::Refusal> {
            let registered = self.autostart.load(std::sync::atomic::Ordering::SeqCst);
            Ok(ksx_api::AutostartView {
                registered,
                line: if registered {
                    "registered".into()
                } else {
                    "not registered".into()
                },
                ..ksx_api::AutostartView::default()
            })
        }

        /// The re-read discipline: the answer is the state AFTER the write,
        /// exactly what the real provider returns.
        fn set_autostart(
            &self,
            spec: &ksx_api::AutostartSpec,
        ) -> Result<ksx_api::AutostartView, ksx_api::Refusal> {
            self.autostart
                .store(spec.enable, std::sync::atomic::Ordering::SeqCst);
            self.autostart()
        }
        /// Resolve the scripted learner's hit back to a board, completing the
        /// identify round-trip against this double.
        fn device_identify(
            &self,
            observed_instance: &str,
        ) -> Result<ksx_api::DeviceIdentifyView, ksx_api::Refusal> {
            if observed_instance.eq_ignore_ascii_case("HID\\VID_D209&PID_0430\\FIXTURE") {
                Ok(ksx_api::DeviceIdentifyView {
                    selector: "usb:d209:0430:00".into(),
                    alias: "panel".into(),
                    label: "Ultimarc I-PAC 4".into(),
                })
            } else if observed_instance.eq_ignore_ascii_case("HID\\VID_046D&PID_C545\\FIXTURE") {
                Ok(ksx_api::DeviceIdentifyView {
                    selector: "usb:046d:c545:00".into(),
                    alias: "g915".into(),
                    label: "Logitech G915 TKL".into(),
                })
            } else {
                Err(ksx_api::Refusal::not_here(
                    "identifying a keyboard by key press",
                    "run `ksx setup`",
                ))
            }
        }

        /// The one machine read the migrated /nocturne keyboard pane renders:
        /// a small believable inventory, aligned with the fixture's staged
        /// I-PAC (same selector, so the chosen row marks and the
        /// prepared-for-play control composes its Prepare state). Everything
        /// else keeps the trait's refusing defaults — /devices and /pads
        /// still render their honest refusal states, and a prepare/release
        /// POST against this fixture answers with the provider refusal
        /// sentence rather than pretending Windows was asked.
        fn device_scan(&self) -> Result<ksx_api::DeviceScanView, ksx_api::Refusal> {
            Ok(ksx_api::DeviceScanView {
                boards_summary: "2 keyboard-capable boards found; 1 more device has no keyboard \
                                 interface."
                    .into(),
                interception_available: false,
                boards: vec![
                    ksx_api::BoardRow {
                        name: "Ultimarc I-PAC 4".into(),
                        transport_label: "USB".into(),
                        backends: "Built-in path (WinUSB) after preparing".into(),
                        selector: Some("usb:d209:0430:00".into()),
                        alias_hint: "panel".into(),
                        keyboard: Some("HID\\VID_D209&PID_0430\\FIXTURE".into()),
                        interfaces: vec![ksx_api::UsbRow {
                            instance_id: "HID\\VID_D209&PID_0430\\FIXTURE".into(),
                            ..Default::default()
                        }],
                        interception_eligible: true,
                        winusb_eligible: true,
                        can_type: true,
                        pickable: true,
                        looks_like_a_keyboard: true,
                        ..Default::default()
                    },
                    ksx_api::BoardRow {
                        name: "Logitech G915 TKL".into(),
                        transport_label: "Bluetooth".into(),
                        backends: "Shared capture driver only".into(),
                        selector: Some("usb:046d:c545:00".into()),
                        alias_hint: "g915".into(),
                        keyboard: Some("HID\\VID_046D&PID_C545\\FIXTURE".into()),
                        interfaces: vec![ksx_api::UsbRow {
                            instance_id: "HID\\VID_046D&PID_C545\\FIXTURE".into(),
                            ..Default::default()
                        }],
                        interception_eligible: true,
                        winusb_eligible: false,
                        can_type: true,
                        pickable: true,
                        looks_like_a_keyboard: true,
                        ..Default::default()
                    },
                    // The experimentation tier: pickable HID, NOT a keyboard.
                    ksx_api::BoardRow {
                        name: "AURA LED Controller".into(),
                        transport_label: "USB".into(),
                        backends: "Shared capture driver only".into(),
                        selector: Some("usb:0b05:1939:00".into()),
                        alias_hint: "aura".into(),
                        keyboard: Some("HID\\VID_0B05&PID_1939\\FIXTURE".into()),
                        interfaces: vec![ksx_api::UsbRow {
                            instance_id: "HID\\VID_0B05&PID_1939\\FIXTURE".into(),
                            ..Default::default()
                        }],
                        interception_eligible: true,
                        winusb_eligible: false,
                        can_type: false,
                        pickable: true,
                        looks_like_a_keyboard: false,
                        ..Default::default()
                    },
                    ksx_api::BoardRow {
                        name: "Composite pointing device".into(),
                        transport_label: "USB".into(),
                        backends: "No keyboard interface — cannot be split".into(),
                        selector: None,
                        ..Default::default()
                    },
                ],
                ..Default::default()
            })
        }
    }

    if let Err(err) = ksx_studio::serve(
        bind,
        Box::new(store.clone()),
        Box::new(store),
        Box::new(NoMachine {
            autostart: std::sync::atomic::AtomicBool::new(false),
        }),
        // A SCRIPTED live source: refuses in words while the fixture session
        // is idle (the state the button check renders when nothing runs), and
        // under KSX_FIXTURE_SESSION=running loops a small choreography — a
        // held stick, a shared-key tap, a turbo'd trigger — so the live echo
        // can be driven end to end against this double.
        std::sync::Arc::new(ScriptedLive),
    ) {
        eprintln!("fixture failed: {err}");
        std::process::exit(1);
    }
}
