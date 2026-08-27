//! A standalone ksx Studio serving FIXED data, for browser-level tests of the
//! client island (`studio-ui/pwtest`).
//!
//! The macro editor's state lives entirely in the browser — the draft, which
//! step the duration editor points at, the authored unit — and none of it is
//! reachable from a Rust test. So the DOM-level tests drive a real page, and
//! this is the backend they drive it against: the same `ksx_studio::serve` the
//! app uses, wired to a preset that never changes underfoot.
//!
//! Saves are kept in memory and served back by the next `/api/nocturne` poll, which
//! is what makes "the unit survives save and reload" testable at all.
//!
//! Loopback only, and the port is an argument so it can never collide with the
//! user's own `ksx studio` (4460):
//! `4478` belongs to the automated macro-editor suite, while `4520`, `4521` and
//! `4522` are the documented manual first-run, blank-encoder and messy-encoder
//! workspaces.
//!
//! ```text
//! cargo run -p ksx-studio --example macro_fixture -- 4476
//! cargo run -p ksx-studio --example macro_fixture -- 4520 --first-run
//! cargo run -p ksx-studio --example macro_fixture -- 4521 --blank-panel
//! cargo run -p ksx-studio --example macro_fixture -- 4522 --messy-panel
//! ```

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use ksx_studio::{
    ControlSource, MacroOutcome, MacroSnapshot, MacroStepView, MacroView, MacroWrite, MapperSlot,
    MapperSnapshot, PadRow, ProfileRow, SessionView, StatusSnapshot, StatusSource,
};

const PRESET: &str = "Panel P1";

/// Which cabinet history the browser fixture exposes.
///
/// Seeded remains the default because the browser suites rely on its authored
/// controllers and macros. FirstRun is an explicit manual-QA scenario: the
/// same attached synthetic hardware, carrying a believable existing key
/// chart, but no KSX config, profile, preset, staged controller, or running
/// session exists yet. BlankPanel keeps that empty KSX history while making
/// the encoder EEPROM deliberately all-Unassigned for the rarer hardware-
/// initialization path.
///
/// MessyPanel keeps that same empty KSX history and gives the encoder the
/// chart a used cabinet actually walks in with. Its whole reason to exist is
/// that FirstRun and BlankPanel can only ever produce `supported: true` and a
/// disabled shift byte, so every terminal state a surface has to tell apart —
/// a preserved vendor action, a keyboard usage KSX cannot observe, an opaque
/// shift byte, the shift terminal itself, one key emitted by two terminals,
/// and a byte that is genuinely zero — was unreachable in a browser, and
/// anything built on those states therefore shipped unexercised.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum FixtureScenario {
    #[default]
    Seeded,
    FirstRun,
    BlankPanel,
    MessyPanel,
}

impl FixtureScenario {
    const fn starts_without_ksx_config(self) -> bool {
        matches!(self, Self::FirstRun | Self::BlankPanel | Self::MessyPanel)
    }

    /// The default seeded browser fixture historically presents a blank chart
    /// and its suites depend on that qualification flow. Keep that compatibility
    /// while giving manual QA an honestly named blank-hardware scenario.
    const fn panel_is_blank(self) -> bool {
        matches!(self, Self::Seeded | Self::BlankPanel)
    }

    /// A separate fact from `panel_is_blank`, not its opposite: a messy chart
    /// is the preconfigured baseline with a used board's history overlaid on
    /// it, so it is neither blank nor the clean 56-key stand-in.
    const fn panel_is_messy(self) -> bool {
        matches!(self, Self::MessyPanel)
    }

    const fn label(self) -> &'static str {
        match self {
            Self::Seeded => "seeded-demo",
            Self::FirstRun => "first-run",
            Self::BlankPanel => "blank-encoder",
            Self::MessyPanel => "messy-encoder",
        }
    }
}

fn parse_fixture_args<I, S>(args: I) -> Result<(u16, FixtureScenario, Option<String>), String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut port = None;
    let mut scenario = FixtureScenario::Seeded;
    let mut scenario_selected = false;
    let mut generation = None;
    for arg in args {
        let arg = arg.as_ref();
        if arg == "--first-run" || arg == "--blank-panel" || arg == "--messy-panel" {
            if scenario_selected {
                return Err(
                    "choose exactly one fixture scenario: --first-run, --blank-panel or --messy-panel"
                        .into(),
                );
            }
            scenario = match arg {
                "--first-run" => FixtureScenario::FirstRun,
                "--blank-panel" => FixtureScenario::BlankPanel,
                _ => FixtureScenario::MessyPanel,
            };
            scenario_selected = true;
        } else if let Some(value) = arg.strip_prefix("--generation=") {
            if value.is_empty()
                || value.len() > 128
                || !value
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
            {
                return Err(
                    "fixture generation must be 1-128 ASCII letters, digits, '.', '_', or '-'"
                        .into(),
                );
            }
            if generation.replace(value.to_owned()).is_some() {
                return Err("the fixture accepts only one generation nonce".into());
            }
        } else if let Ok(parsed) = arg.parse::<u16>() {
            if port.replace(parsed).is_some() {
                return Err("the fixture accepts only one port".into());
            }
        } else {
            return Err(format!(
                "unknown fixture argument '{arg}' (usage: macro_fixture [PORT] [--first-run|--blank-panel|--messy-panel] [--generation=NONCE])"
            ));
        }
    }
    Ok((port.unwrap_or(4476), scenario, generation))
}

fn default_fixture_generation() -> String {
    let started = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    format!("pid-{}-{started:x}", std::process::id())
}

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
    scenario: FixtureScenario,
    fixture_generation: Arc<str>,
    macros: Arc<Mutex<Vec<MacroView>>>,
    stage: Arc<Mutex<ksx_core::stage::StagedSetup>>,
    /// The configuration a successful Save made available to Load. `None` is
    /// the actual first-install state, rather than an empty draft laid over a
    /// fabricated config.toml.
    saved_stage: Arc<Mutex<Option<ksx_core::stage::StagedSetup>>>,
    /// The session, STATEFUL: `KSX_FIXTURE_SESSION=running` seeds only the
    /// boot state; Play and Stop flip it, so a drive can watch the stage
    /// word, the title bar and the live license settle like the product's.
    session_on: Arc<AtomicBool>,
    /// Number of controllers in the setup that most recently entered Play.
    /// Kept apart from the editable draft so adding a controller while a
    /// session runs does not rewrite what the live-session sentence claims.
    active_slots: Arc<AtomicUsize>,
    /// Set by any HTTP-driven staging edit (the seed does not count), the
    /// way the daemon's StageMeta stamps `dirty` — so the Apply button's
    /// running+dirty visibility is drivable on this double.
    dirty: Arc<AtomicBool>,
    /// `config`, `profile:<title>`, or empty for a new draft — the same origin
    /// metadata the production daemon stamps around Save/Load/Start over.
    origin: Arc<Mutex<String>>,
    /// `Some(generation)` while the scripted learner is "listening"; the next
    /// poll answers with a hit on the fixture I-PAC and clears it.
    listening: Arc<Mutex<Option<u64>>>,
}

impl Store {
    #[cfg(test)]
    fn new(scenario: FixtureScenario) -> Self {
        Self::with_generation(scenario, default_fixture_generation())
    }

    fn with_generation(scenario: FixtureScenario, generation: impl Into<String>) -> Self {
        let seeded = (scenario == FixtureScenario::Seeded).then(seeded_stage);
        let first_run = scenario.starts_without_ksx_config();
        Self {
            scenario,
            fixture_generation: Arc::from(generation.into()),
            dirty: Arc::new(AtomicBool::new(false)),
            origin: Arc::new(Mutex::new(String::new())),
            session_on: Arc::new(AtomicBool::new(
                !first_run && std::env::var("KSX_FIXTURE_SESSION").as_deref() == Ok("running"),
            )),
            active_slots: Arc::new(AtomicUsize::new(if first_run { 0 } else { 2 })),
            macros: Arc::new(Mutex::new(match scenario {
                FixtureScenario::Seeded => seed_macros(),
                FixtureScenario::FirstRun
                | FixtureScenario::BlankPanel
                | FixtureScenario::MessyPanel => Vec::new(),
            })),
            stage: Arc::new(Mutex::new(seeded.clone().unwrap_or_default())),
            saved_stage: Arc::new(Mutex::new(seeded)),
            listening: Arc::new(Mutex::new(None)),
        }
    }

    fn stamp_stage(&self, mut outcome: ksx_api::StageOutcome) -> ksx_api::StageOutcome {
        outcome.setup.dirty = self.dirty.load(Ordering::SeqCst);
        outcome.setup.origin = self.origin.lock().unwrap().clone();
        outcome
    }
}

/// The configuration menu for the explicit first-run scenario. It begins as
/// a real absence (`config_exists == false`), then reflects a successful Save
/// from the shared in-memory restore point so the same browser session can
/// verify first boot → author → save → reload without a contradictory menu.
fn first_run_setup_state(saved: Option<&ksx_core::stage::StagedSetup>) -> ksx_api::SetupView {
    let staged = saved.map(ksx_api::StagedSetupView::of);
    let devices = staged
        .as_ref()
        .and_then(|view| view.device.as_ref())
        .map(|device| {
            vec![ksx_api::SetupDeviceRow {
                alias: device.alias.clone(),
                id: device.selector.clone(),
                backend: device.backend.clone(),
            }]
        })
        .unwrap_or_default();
    let device = staged
        .as_ref()
        .and_then(|view| view.device.as_ref())
        .map_or_else(|| "(any)".to_owned(), |device| device.alias.clone());
    let slots: Vec<ksx_api::SetupSlotRow> = staged
        .as_ref()
        .map(|view| {
            view.slots
                .iter()
                .map(|slot| ksx_api::SetupSlotRow {
                    number: slot.number,
                    device: device.clone(),
                    preset: slot.preset.clone(),
                    persona: slot.persona_label.clone(),
                    socd: slot.socd.clone(),
                    source: "config.toml".into(),
                })
                .collect()
        })
        .unwrap_or_default();
    let presets = slots
        .iter()
        .map(|slot| slot.preset.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    ksx_api::SetupView {
        generated_at: "fixture".into(),
        blocking: staged
            .as_ref()
            .and_then(|view| view.blocking.clone())
            .unwrap_or_default(),
        theme: std::env::var("KSX_FIXTURE_THEME").unwrap_or_default(),
        config_root: "C:\\fixture".into(),
        config_exists: saved.is_some(),
        devices,
        slots,
        presets,
        profiles: Vec::new(),
        ..ksx_api::SetupView::default()
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
    fn environment(&self) -> ksx_api::RuntimeEnvironmentView {
        let (id, label, detail) = match self.scenario {
            FixtureScenario::Seeded => (
                "fixture-seeded-demo",
                "FIXTURE · SEEDED DEMO",
                "Synthetic seeded demo state; no physical devices are read or written.",
            ),
            FixtureScenario::FirstRun => (
                "fixture-first-run",
                "FIXTURE · FIRST RUN",
                "Synthetic first KSX visit with a preconfigured encoder chart; no physical devices are read or written.",
            ),
            FixtureScenario::BlankPanel => (
                "fixture-blank-encoder",
                "FIXTURE · BLANK ENCODER",
                "Synthetic first KSX visit with an all-Unassigned encoder chart; no physical devices are read or written.",
            ),
            FixtureScenario::MessyPanel => (
                "fixture-messy-encoder",
                "FIXTURE · MESSY ENCODER",
                "Synthetic first KSX visit with a used encoder chart carrying preserved vendor bytes, an opaque shift byte, a shared key and an unassigned terminal; no physical devices are read or written.",
            ),
        };
        ksx_api::RuntimeEnvironmentView::fixture(id, label, detail)
            .with_generation(self.fixture_generation.to_string())
    }

    fn snapshot(&self) -> StatusSnapshot {
        let first_run = self.scenario.starts_without_ksx_config();
        StatusSnapshot {
            generated_at: "fixture".into(),
            vigem: "installed".into(),
            hidmaestro: ksx_api::ControllerOutputView::hidmaestro_inventory(
                true,
                false,
                Some("1.6.1".into()),
            ),
            interception: if first_run {
                "not installed".into()
            } else {
                "installed".into()
            },
            daemon_running: true,
            daemon_detail: "fixture".into(),
            autostart: "not registered".into(),
            pads: if first_run {
                Vec::new()
            } else {
                vec![PadRow {
                    persona: "Xbox 360 pad".into(),
                    instance: "USB\\FIXTURE\\1".into(),
                }]
            },
            profiles: if first_run {
                Vec::new()
            } else {
                vec![ProfileRow {
                    title: "Fixture".into(),
                    detail: "C:\\fixture.exe — 1 slot".into(),
                }]
            },
            config_root: "C:\\fixture".into(),
        }
    }

    fn mapper(&self) -> MapperSnapshot {
        if self.scenario.starts_without_ksx_config() {
            return MapperSnapshot {
                generated_at: "fixture".into(),
                source: "first-run fixture".into(),
                profile: None,
                config_root: "C:\\fixture".into(),
                slots: Vec::new(),
            };
        }
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
fn fixture_session(running: bool, active_slots: usize) -> SessionView {
    // `KSX_FIXTURE_SESSION=down` stays a boot-wide override (the dead-pipe
    // state has no verbs to flip it with).
    if std::env::var("KSX_FIXTURE_SESSION").as_deref() == Ok("down") {
        return SessionView::unreachable("no daemon control channel");
    }
    let pad_word = if active_slots == 1 { "pad" } else { "pads" };
    match running {
        // The running fixture session is STAGED-origin: it "runs" the seeded
        // draft this fixture holds, which is what licenses the live echo to
        // paint onto the staged rows (the fail-closed origin rule).
        true => SessionView {
            reachable: true,
            running: true,
            line: format!("running — Fixture — {active_slots} pad(s)"),
            profile: None,
            origin: ksx_api::SessionOrigin::Staged,
            active: Some(ksx_api::ActiveSessionView {
                elapsed: "2m 07s".into(),
                input: "one keyboard captured (fixture)".into(),
                outputs: format!("{active_slots} virtual {pad_word} (fixture)"),
                escape_hatch: ksx_api::stage::ESCAPE_HATCH_LINE.into(),
            }),
        },
        false => SessionView {
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
                match edit {
                    ksx_api::StageEdit::Discard => {
                        self.dirty.store(false, Ordering::SeqCst);
                        self.origin.lock().unwrap().clear();
                    }
                    _ => self.dirty.store(true, Ordering::SeqCst),
                }
                self.stamp_stage(ksx_api::StageOutcome::ok(&setup, "staged"))
            }
            Err(refusal) => self.stamp_stage(ksx_api::StageOutcome::refused(&setup, &refusal)),
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
        // KSX_FIXTURE_LEARN=hold keeps the learner listening until it is
        // cancelled — the scripted instant-hit makes the WAITING state
        // undrivable otherwise (cap-click answers, cue visibility, Esc).
        if std::env::var("KSX_FIXTURE_LEARN").as_deref() == Ok("hold") {
            if let Some(generation) = *listening {
                return ksx_api::LearnView {
                    ok: true,
                    state: "listening".into(),
                    generation: Some(generation),
                    remaining_ms: Some(11_000),
                    device: None,
                    key: None,
                    error: None,
                };
            }
        }
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

    fn learn_cancel_generation(&self, generation: Option<u64>) -> ksx_api::LearnView {
        // Generation-qualified like the real daemon: a stale attempt's late
        // cancel must never stop a listener that superseded it (the island's
        // skip-to-next flow races exactly this way).
        let mut listening = self.listening.lock().unwrap();
        let cancels = match (generation, *listening) {
            (Some(gen), Some(current)) => gen == current,
            (None, _) => true,
            (Some(_), None) => false,
        };
        if cancels {
            *listening = None;
        }
        drop(listening);
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
        fixture_session(
            self.session_on.load(Ordering::SeqCst),
            self.active_slots.load(Ordering::SeqCst),
        )
    }

    /// Save, scripted like Play: the engine's readiness answers, and a
    /// committed draft settles the dirty stamp the way the daemon's
    /// StageMeta does.
    fn stage_commit(&self) -> ksx_api::StageOutcome {
        let setup = self.stage.lock().unwrap();
        match setup.commit() {
            Ok(_) => {
                *self.saved_stage.lock().unwrap() = Some(setup.clone());
                self.dirty.store(false, Ordering::SeqCst);
                *self.origin.lock().unwrap() = "config".into();
                self.stamp_stage(ksx_api::StageOutcome::ok(&setup, "saved"))
            }
            Err(err) => {
                let refusal = ksx_api::Refusal::new("not-ready", err.to_string());
                self.stamp_stage(ksx_api::StageOutcome::refused(&setup, &refusal))
            }
        }
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
        view.origin = self.origin.lock().unwrap().clone();
        view
    }

    /// Play, scripted: the engine's own readiness answers — a draft that
    /// commits "starts" (this double runs no sessions; the flash is the
    /// thing under test), and an unready one refuses with the engine's
    /// sentence.
    fn stage_play(&self) -> ksx_api::StageOutcome {
        let setup = self.stage.lock().unwrap();
        match setup.commit() {
            Ok(_) => {
                self.active_slots.store(
                    ksx_api::StagedSetupView::of(&setup).slots.len(),
                    Ordering::SeqCst,
                );
                self.session_on.store(true, Ordering::SeqCst);
                self.stamp_stage(ksx_api::StageOutcome::ok(&setup, "started"))
            }
            Err(err) => {
                let refusal = ksx_api::Refusal::new("not-ready", err.to_string());
                self.stamp_stage(ksx_api::StageOutcome::refused(&setup, &refusal))
            }
        }
    }

    /// Apply-in-place, the daemon's shape: refused when nothing runs; ok
    /// (and the dirty bit settles) when the fixture session is running.
    fn stage_apply(&self) -> ksx_api::StageOutcome {
        let setup = self.stage.lock().unwrap();
        if !self.session_on.load(Ordering::SeqCst) {
            let refusal =
                ksx_api::Refusal::new("no-session", "nothing is running to apply the draft to");
            return self.stamp_stage(ksx_api::StageOutcome::refused(&setup, &refusal));
        }
        // KSX_FIXTURE_APPLY=restart scripts the structural-difference shape,
        // in a daemon-shaped sentence, so the quoting dialog is drivable.
        if std::env::var("KSX_FIXTURE_APPLY").as_deref() == Ok("restart") {
            let refusal = ksx_api::Refusal::new(
                "needs-restart",
                "the draft adds controller P3 (Xbox 360), which the running session does not have — only a replaced session can plug it",
            );
            return self.stamp_stage(ksx_api::StageOutcome::refused(&setup, &refusal));
        }
        self.dirty.store(false, Ordering::SeqCst);
        self.stamp_stage(ksx_api::StageOutcome::ok(&setup, "applied in place"))
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
            return self.stamp_stage(ksx_api::StageOutcome::refused(&setup, &refusal));
        }
        if let Some(title) = profile {
            if !title.eq_ignore_ascii_case("Street Fighter 6")
                && !title.eq_ignore_ascii_case("MAME cabinet")
            {
                let refusal = ksx_api::Refusal::new(
                    "unknown-profile",
                    format!("no saved game named \"{title}\""),
                );
                return self.stamp_stage(ksx_api::StageOutcome::refused(&setup, &refusal));
            }
        }
        // Preserve the browser suites' long-standing reset contract exactly:
        // the seeded fixture always adopts its canonical seed, regardless of
        // what an earlier test saved into the in-memory draft.
        if self.scenario == FixtureScenario::Seeded {
            *setup = seeded_stage();
            self.dirty.store(false, Ordering::SeqCst);
            *self.origin.lock().unwrap() =
                profile.map_or_else(|| "config".to_owned(), |title| format!("profile:{title}"));
            return self.stamp_stage(ksx_api::StageOutcome::ok(&setup, "adopted"));
        }
        if profile.is_some() {
            let refusal = ksx_api::Refusal::new(
                "not-ready",
                "this first-run fixture has no saved games to load",
            );
            return self.stamp_stage(ksx_api::StageOutcome::refused(&setup, &refusal));
        }
        let Some(saved) = self.saved_stage.lock().unwrap().clone() else {
            let refusal = ksx_api::Refusal::new(
                "not-ready",
                "this first-run fixture has no saved configuration to load",
            );
            return self.stamp_stage(ksx_api::StageOutcome::refused(&setup, &refusal));
        };
        *setup = saved;
        self.dirty.store(false, Ordering::SeqCst);
        *self.origin.lock().unwrap() = "config".into();
        self.stamp_stage(ksx_api::StageOutcome::ok(&setup, "adopted"))
    }

    fn start(&self, _profile: Option<&str>) -> Result<String, ksx_api::Refusal> {
        let saved_slots = self
            .saved_stage
            .lock()
            .unwrap()
            .as_ref()
            .map(|setup| ksx_api::StagedSetupView::of(setup).slots.len());
        let Some(saved_slots) = saved_slots else {
            return Err(ksx_api::Refusal::new(
                "not-ready",
                "this first-run fixture has no saved configuration to start",
            ));
        };
        self.active_slots.store(saved_slots, Ordering::SeqCst);
        self.session_on.store(true, Ordering::SeqCst);
        Ok(if self.scenario == FixtureScenario::Seeded {
            "running (1 slot(s))".into()
        } else {
            format!("running ({saved_slots} slot(s))")
        })
    }

    fn stop(&self) -> Result<String, ksx_api::Refusal> {
        self.session_on.store(false, Ordering::SeqCst);
        Ok("stopped".into())
    }

    fn reload(&self) -> Result<String, ksx_api::Refusal> {
        if self.saved_stage.lock().unwrap().is_none() {
            return Err(ksx_api::Refusal::new(
                "not-ready",
                "this first-run fixture has no saved configuration to reload",
            ));
        }
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
        let phase = self.step % 6;
        self.step += 1;
        // The seeded preset's own vocabulary: W holds the stick up (ly.max),
        // G is the shared key driving A and B, T is the turbo'd RT.
        let (down, hit, keys): (Vec<&str>, Vec<&str>, Vec<(&str, bool)>) = match phase {
            0 => (vec!["ly.max"], vec!["ly.max"], vec![("W", true)]),
            1 => (vec!["ly.max", "a", "b"], vec!["a", "b"], vec![("G", true)]),
            2 => (
                // Deliberately omit G's release and report one dropped frame.
                // A remains down in the virtual snapshot, so a client that
                // trusts its stale physical-key ledger would falsely animate
                // G → A. The canvas must fail closed on the gap.
                vec!["rt", "a"],
                vec!["rt"],
                vec![("W", false), ("T", true)],
            ),
            3 => (
                vec![],
                vec!["x"],
                vec![("T", false), ("J", true), ("J", false)],
            ),
            4 => (vec![], vec![], vec![]),
            _ => (
                // The frame immediately after the authoritative stop tries
                // to drive G again. A client must keep it dark until a fresh
                // structure payload licenses the new running session.
                vec!["a", "b"],
                vec!["a", "b"],
                vec![("G", true)],
            ),
        };
        Ok(ksx_api::LiveEnvelope {
            frame: ksx_api::LiveFrame {
                running: phase != 4,
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
                dropped: u64::from(phase == 2),
                ..Default::default()
            },
            unavailable: None,
        })
    }
}

fn main() {
    let (port, scenario, generation) = match parse_fixture_args(std::env::args().skip(1)) {
        Ok(parsed) => parsed,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    let bind: SocketAddr = ([127, 0, 0, 1], port).into();
    let store = Store::with_generation(
        scenario,
        generation.unwrap_or_else(default_fixture_generation),
    );
    println!(
        "macro fixture ({}) on http://{bind}/nocturne",
        scenario.label()
    );

    let saved_stage = Arc::clone(&store.saved_stage);
    if let Err(err) = ksx_studio::serve(
        bind,
        Box::new(store.clone()),
        Box::new(store),
        Box::new(NoMachine {
            scenario,
            saved_stage,
            autostart: std::sync::atomic::AtomicBool::new(false),
            panel_backup_created: std::sync::atomic::AtomicBool::new(false),
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

// ── THE FIXTURE'S OWN HARDWARE, AT MODULE SCOPE ────────────────────────────
// These were declared inside `main`, where a `#[cfg(test)]` module physically
// cannot reach them — which is how a panel fixture that served `supported:
// true` on all 56 rows went unnoticed long enough to be written into a plan as
// "every state this stage exists to render is unreachable in the browser".
// Rust items cannot capture locals, so lifting them out is a pure move.

// The fixture drives the MAPPER, so the machine provider is the trait's
// own defaults: every method refuses in words and names the CLI verb that
// works. /devices, /profiles, /setup and /pads under this fixture
// therefore render their refusal states — /pads honestly says it cannot
// read the bus rather than inventing one — which are real states of those
// pages and worth being able to look at.
struct NoMachine {
    scenario: FixtureScenario,
    saved_stage: Arc<Mutex<Option<ksx_core::stage::StagedSetup>>>,
    /// The sign-in task's one bit, so the menu's toggle round-trips.
    autostart: std::sync::atomic::AtomicBool,
    /// The fixture exposes its synthetic restore point only after Studio
    /// explicitly requested a backup with the complete chart read.
    panel_backup_created: std::sync::atomic::AtomicBool,
}

/// Same physical/UI order and sparse PAC256 normal-plane offsets as the
/// production I-PAC 4 profile. Keeping the fixture table exact makes its
/// one-byte review useful contract evidence instead of decorative copy.
const FIXTURE_IPAC_TERMINALS: [(&str, u8, u8); 56] = [
    ("1up", 1, 15),
    ("1down", 1, 13),
    ("1left", 1, 17),
    ("1right", 1, 19),
    ("1sw1", 1, 11),
    ("1sw2", 1, 9),
    ("1sw3", 1, 31),
    ("1sw4", 1, 29),
    ("1sw5", 1, 27),
    ("1sw6", 1, 52),
    ("1sw7", 1, 63),
    ("1sw8", 1, 55),
    ("1start", 1, 61),
    ("1coin", 1, 53),
    ("2up", 2, 12),
    ("2down", 2, 10),
    ("2left", 2, 14),
    ("2right", 2, 16),
    ("2sw1", 2, 8),
    ("2sw2", 2, 30),
    ("2sw3", 2, 28),
    ("2sw4", 2, 26),
    ("2sw5", 2, 59),
    ("2sw6", 2, 60),
    ("2sw7", 2, 48),
    ("2sw8", 2, 56),
    ("2start", 2, 54),
    ("2coin", 2, 62),
    ("3up", 3, 47),
    ("3down", 3, 37),
    ("3left", 3, 39),
    ("3right", 3, 46),
    ("3sw1", 3, 35),
    ("3sw2", 3, 33),
    ("3sw3", 3, 7),
    ("3sw4", 3, 5),
    ("3sw5", 3, 3),
    ("3sw6", 3, 1),
    ("3sw7", 3, 49),
    ("3sw8", 3, 57),
    ("3start", 3, 23),
    ("3coin", 3, 21),
    ("4up", 4, 36),
    ("4down", 4, 34),
    ("4left", 4, 44),
    ("4right", 4, 38),
    ("4sw1", 4, 32),
    ("4sw2", 4, 6),
    ("4sw3", 4, 4),
    ("4sw4", 4, 2),
    ("4sw5", 4, 0),
    ("4sw6", 4, 22),
    ("4sw7", 4, 58),
    ("4sw8", 4, 50),
    ("4start", 4, 20),
    ("4coin", 4, 18),
];

/// Exact semantic key order used by the production backend's
/// `canonical-four-player` planner. The fixture cannot depend on the
/// backend crate by design, so this wire-level twin is pinned here for the
/// browser's backend-owned recommendation preview.
const FIXTURE_CANONICAL_KEYS: [(&str, u16); 56] = [
    ("A", 0x04),
    ("B", 0x05),
    ("C", 0x06),
    ("D", 0x07),
    ("E", 0x08),
    ("F", 0x09),
    ("G", 0x0A),
    ("H", 0x0B),
    ("I", 0x0C),
    ("J", 0x0D),
    ("K", 0x0E),
    ("L", 0x0F),
    ("M", 0x10),
    ("N", 0x11),
    ("O", 0x12),
    ("P", 0x13),
    ("Q", 0x14),
    ("R", 0x15),
    ("S", 0x16),
    ("T", 0x17),
    ("U", 0x18),
    ("V", 0x19),
    ("W", 0x1A),
    ("X", 0x1B),
    ("Y", 0x1C),
    ("Z", 0x1D),
    ("One", 0x1E),
    ("Two", 0x1F),
    ("Three", 0x20),
    ("Four", 0x21),
    ("Five", 0x22),
    ("Six", 0x23),
    ("Seven", 0x24),
    ("Eight", 0x25),
    ("Nine", 0x26),
    ("Zero", 0x27),
    ("DashUnderscore", 0x2D),
    ("PlusEquals", 0x2E),
    ("OpenBracketBrace", 0x2F),
    ("CloseBracketBrace", 0x30),
    ("BackslashPipe", 0x31),
    ("SemicolonColon", 0x33),
    ("SingleDoubleQuote", 0x34),
    ("Tilde", 0x35),
    ("CommaLeftArrow", 0x36),
    ("PeriodRightArrow", 0x37),
    ("F1", 0x3A),
    ("F2", 0x3B),
    ("F3", 0x3C),
    ("F4", 0x3D),
    ("F5", 0x3E),
    ("F6", 0x3F),
    ("F7", 0x40),
    ("F8", 0x41),
    ("F9", 0x42),
    ("F10", 0x43),
];

/// What `--messy-panel` overlays on the preconfigured baseline, as
/// `(terminal_id, normal, alternate, shift)` raw bytes in the board's own
/// wire spelling.
///
/// This table is written into the IMAGE and nowhere else; the chart is
/// decoded back out of that image the way the production driver decodes a
/// real read. There is therefore exactly one place these bytes exist, and
/// no way for the raw preview and the semantic rows to drift apart.
///
/// The vocabulary these bytes are chosen from: `0x00` is Unassigned,
/// `0x04..=0x67` and the compacted modifier range `0x70..=0x77` are
/// keyboard usages, every other value is a vendor byte KSX preserves and
/// cannot name; on the shift plane `0x01` is disabled, `0x41` enabled, and
/// anything else is preserved and opaque.
const FIXTURE_MESSY_TERMINALS: [(&str, u8, u8, u8); 8] = [
    // A vendor byte KSX cannot name. Preserved exactly, never selectable
    // as a KSX key — and the one case a press CAN complete: the firmware
    // stores something, and only the learner can say what it emits.
    ("1sw5", 0xE9, 0x00, 0x01),
    // A Keyboard-page usage the chart can encode and KSX's capture
    // vocabulary cannot observe (HID 0x66, Keyboard Power). Teaching can
    // NEVER resolve this one — pressing it produces nothing for a learner
    // to hear — which is exactly why it carries a different label from
    // 1sw5 rather than being folded into one "unknown".
    ("1sw6", 0x66, 0x00, 0x01),
    // An opaque shift byte: preserved as-is, and specifically not read as
    // "shift disabled" just because it is not the enabled value.
    ("1sw7", 0x0E, 0x00, 0x7F),
    // A real shifted assignment, so the shift terminal below unlocks
    // something and the alternate plane is not uniformly empty.
    ("1sw8", 0x0F, 0x3A, 0x01),
    // The terminal that IS the shift key.
    ("1start", 0x10, 0x00, 0x41),
    // Two terminals deliberately emitting one key: the case where an
    // observation of "S" cannot be attributed to a terminal at all.
    ("2sw1", 0x16, 0x00, 0x01),
    ("2sw2", 0x16, 0x00, 0x01),
    // A byte that is genuinely zero — which a chart read cannot tell apart
    // from an onboard vendor macro, so nothing may report it as a terminal
    // that does nothing.
    ("3sw8", 0x00, 0x00, 0x01),
];

fn fixture_panel_image(scenario: FixtureScenario) -> [u8; 256] {
    let mut bytes = [0; 256];
    bytes[..4].copy_from_slice(&[0x50, 0xDD, 0x56, 0x00]);
    // PAC256 encodes an explicitly disabled shifted role as 0x01; 0x00 is
    // opaque/unknown. Keep the raw preview image and the semantic fixture
    // rows below byte-for-byte consistent so the one-byte plan is real.
    for (_, _, base) in FIXTURE_IPAC_TERMINALS {
        bytes[4 + usize::from(base) + 128] = 0x01;
    }
    // A first KSX visit is not a factory-reset board. Most customers
    // arrive with usable firmware defaults or an old WinIPAC chart. The
    // canonical collision-free key set is a deterministic, believable
    // stand-in for that existing configuration; only --blank-panel (and
    // the legacy seeded fixture retained for browser compatibility) has
    // empty normal-plane assignments.
    if !scenario.panel_is_blank() {
        for ((_, _, base), (_, code)) in FIXTURE_IPAC_TERMINALS
            .into_iter()
            .zip(FIXTURE_CANONICAL_KEYS)
        {
            bytes[4 + usize::from(base)] =
                u8::try_from(code).expect("fixture key usage fits one byte");
        }
    }
    // A used cabinet's history, laid over that clean baseline. Applied
    // last so it wins, and applied to the image alone: every semantic row
    // the chart serves is decoded back out of these same bytes.
    if scenario.panel_is_messy() {
        for (id, normal, alternate, shift) in FIXTURE_MESSY_TERMINALS {
            let base = FIXTURE_IPAC_TERMINALS
                .iter()
                .find_map(|(candidate, _, base)| {
                    (*candidate == id).then_some(usize::from(*base))
                })
                .expect("every messy override names an exact fixture terminal");
            bytes[4 + base] = normal;
            bytes[4 + base + 64] = alternate;
            bytes[4 + base + 128] = shift;
        }
    }
    bytes
}

fn fixture_sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};

    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn fixture_terminal_label(id: &str, player: u8) -> (String, &'static str) {
    let suffix = &id[1..];
    let (label, kind) = match suffix {
        "up" => ("Up".into(), "direction"),
        "down" => ("Down".into(), "direction"),
        "left" => ("Left".into(), "direction"),
        "right" => ("Right".into(), "direction"),
        "start" => ("Start".into(), "start"),
        "coin" => ("Coin".into(), "coin"),
        other => (other.to_ascii_uppercase(), "button"),
    };
    (format!("P{player} {label}"), kind)
}

/// Decode one raw action byte into the same `PanelKeyValue` the production
/// driver's `key_value` builds, with its exact two unsupported spellings.
///
/// The two are a real distinction, not two words for "unknown": a keyboard
/// usage KSX cannot observe can never be resolved by pressing the control,
/// because nothing arrives for a learner to hear, while an opaque vendor
/// byte is precisely the case a press completes. A surface that collapsed
/// them would offer teaching that can only ever fail.
///
/// The fixture's roster is 56 keys, not the backend's whole observable
/// vocabulary, so a real key outside that roster would be mislabelled
/// here. None ever reaches this function: every byte it sees comes from
/// `FIXTURE_CANONICAL_KEYS` or `FIXTURE_MESSY_TERMINALS`.
fn fixture_key_value(raw: u8) -> ksx_api::PanelKeyValue {
    let code = u16::from(raw);
    if raw == 0 {
        return ksx_api::PanelKeyValue {
            code,
            key: None,
            label: "Unassigned".into(),
            supported: true,
        };
    }
    if let Some((key, _)) = FIXTURE_CANONICAL_KEYS
        .into_iter()
        .find(|(_, candidate)| *candidate == code)
    {
        return ksx_api::PanelKeyValue {
            code,
            key: Some(key.into()),
            label: key.into(),
            supported: true,
        };
    }
    let label = if matches!(raw, 0x04..=0x67 | 0x70..=0x77) {
        format!("Unobservable HID action 0x{raw:02X}")
    } else {
        format!("Preserved vendor action 0x{raw:02X}")
    };
    ksx_api::PanelKeyValue {
        code,
        key: None,
        label,
        supported: false,
    }
}

/// The shift plane's three states, decoded exactly as production decodes
/// them. Anything that is not the enabled or disabled value stays opaque
/// rather than being rounded down to "disabled" — the difference decides
/// whether a mutation is allowed to touch this terminal at all.
fn fixture_shift_state(raw: u8) -> ksx_api::PanelShiftState {
    match raw {
        0x01 => ksx_api::PanelShiftState::Disabled,
        0x41 => ksx_api::PanelShiftState::Enabled,
        _ => ksx_api::PanelShiftState::Opaque,
    }
}

fn fixture_panel_backup(scenario: FixtureScenario) -> ksx_api::PanelBackupRow {
    let image = fixture_panel_image(scenario);
    let (backup_id, label) = match scenario {
        FixtureScenario::Seeded | FixtureScenario::BlankPanel => (
            "fixture-blank-ipac-original",
            "Fixture preview · original all-Unassigned chart",
        ),
        FixtureScenario::FirstRun => (
            "fixture-preconfigured-ipac-original",
            "Fixture preview · original preconfigured 56-key chart",
        ),
        FixtureScenario::MessyPanel => (
            "fixture-messy-ipac-original",
            "Fixture preview · original used chart, vendor bytes included",
        ),
    };
    ksx_api::PanelBackupRow {
        backup_id: backup_id.into(),
        label: label.into(),
        created_at: "fixture session".into(),
        board_fingerprint: "fixture-ipac-d209-0430-0056".into(),
        image_sha256: fixture_sha256(&image),
        image_bytes: 256,
        reason: "first-run-chart-read".into(),
    }
}

/// A safe browser-only model of three distinct customer histories. An
/// ordinary first KSX visit discovers a board whose terminals already
/// emit keys; --blank-panel models the exceptional cleared/new EEPROM;
/// --messy-panel models the board that actually walks in, carrying every
/// terminal state the other two cannot reach.
/// This fixture never sends an HID report; every plan carries a blocker so
/// even its confirmation dialog cannot issue a physical write.
fn fixture_panel_chart(scenario: FixtureScenario, backup: bool) -> ksx_api::PanelChartView {
    let blank = scenario.panel_is_blank();
    let image = fixture_panel_image(scenario);
    // Decode the SAME bytes the raw preview carries, instead of writing a
    // second copy of them by hand. `panel_program_plan` takes its baseline
    // hash from the image and its `before` value from a row built here: if
    // the two were authored independently this fixture could serve a
    // review whose one-byte diff does not describe its own board.
    let mut terminals = Vec::with_capacity(56);
    for (id, player, base) in FIXTURE_IPAC_TERMINALS {
        let (terminal_label, kind) = fixture_terminal_label(id, player);
        let offset = 4 + usize::from(base);
        let shift_state = fixture_shift_state(image[offset + 128]);
        terminals.push(ksx_api::PanelTerminalRow {
            terminal_id: id.into(),
            terminal_label,
            player,
            kind: kind.into(),
            normal: fixture_key_value(image[offset]),
            shifted: fixture_key_value(image[offset + 64]),
            shift_state,
            is_shift: shift_state == ksx_api::PanelShiftState::Enabled,
        });
    }
    let recommended_terminals = terminals
        .iter()
        .zip(FIXTURE_CANONICAL_KEYS)
        .map(|(terminal, (key, code))| ksx_api::PanelTerminalRow {
            normal: ksx_api::PanelKeyValue {
                code,
                key: Some(key.into()),
                label: key.into(),
                supported: true,
            },
            ..terminal.clone()
        })
        .collect();
    let key_options = FIXTURE_CANONICAL_KEYS
        .into_iter()
        .enumerate()
        .map(|(index, (key, code))| ksx_api::PanelKeyOption {
            key: key.into(),
            label: key.into(),
            code,
            // Production deliberately limits the first-live-write test
            // to letters and the top number row.
            safe_for_qualification: index < 36,
        })
        .collect();
    // Counted off the decoded rows rather than written into a sentence, so
    // nothing here can outlive the overlay table it claims to describe.
    //
    // These go into `notes` as well as `summary` on purpose: the Studio
    // route (`nocturne_api_panel_chart`) serves only `board_name`,
    // `image_sha256`, `terminals` and `notes`, so a count that lived in
    // `summary` alone would reach the browser not at all. `summary` is
    // still filled honestly — the CLI read renders it — but the numbers a
    // page can actually show have to travel in a note.
    let assigned = terminals
        .iter()
        .filter(|terminal| terminal.normal.code != 0)
        .count();
    let unknown_actions: usize = terminals
        .iter()
        .map(|terminal| {
            usize::from(!terminal.normal.supported)
                + usize::from(!terminal.shifted.supported)
                + usize::from(terminal.shift_state == ksx_api::PanelShiftState::Opaque)
        })
        .sum();
    // Scoped: a BTreeMap of borrowed keys has a Drop impl, so its borrow of
    // `terminals` would otherwise still be live where the vector is moved.
    let shared_signals = {
        let mut normal_keys: BTreeMap<&str, usize> = BTreeMap::new();
        for terminal in &terminals {
            if let Some(key) = terminal.normal.key.as_deref() {
                *normal_keys.entry(key).or_default() += 1;
            }
        }
        normal_keys.values().filter(|count| **count > 1).count()
    };
    let mut notes = vec![match scenario {
        FixtureScenario::Seeded => {
            "Fixture-only preview; no physical I-PAC was read or changed.".to_owned()
        }
        FixtureScenario::BlankPanel => {
            "Fixture-only blank-encoder preview; no physical I-PAC was read or changed."
                .to_owned()
        }
        FixtureScenario::FirstRun => {
            "Fixture-only preconfigured-encoder preview; these deterministic assignments model an existing chart, not a claim about one exact factory image. No physical I-PAC was read or changed."
                .to_owned()
        }
        FixtureScenario::MessyPanel => {
            "Fixture-only used-encoder preview; the deterministic overlay models one preserved vendor action, one keyboard usage KSX cannot observe, one opaque shift byte, one shift terminal, one key emitted by two terminals, and one terminal whose byte is zero — which a chart read cannot tell apart from an onboard vendor macro. These are believable bytes, not a claim about one exact vendor encoding. No physical I-PAC was read or changed."
                .to_owned()
        }
    }];
    if scenario.panel_is_messy() {
        notes.push(format!(
            "{assigned} of 56 normal outputs carry a byte. {unknown_actions} value(s) across the three planes are preserved exactly and cannot be selected as KSX keys. {shared_signals} key(s) are emitted by more than one terminal, so an observation of one of those keys cannot be attributed to a terminal."
        ));
    }
    ksx_api::PanelChartView {
        generated_at: "fixture session".into(),
        summary: match scenario {
            FixtureScenario::Seeded | FixtureScenario::BlankPanel => {
                "Fixture preview: complete all-Unassigned I-PAC chart read safely.".into()
            }
            FixtureScenario::FirstRun => {
                "Fixture preview: complete preconfigured I-PAC chart read; 56 of 56 normal outputs are assigned."
                    .into()
            }
            FixtureScenario::MessyPanel => format!(
                "Fixture preview: complete used I-PAC chart read; {assigned} of 56 normal outputs carry a byte, {unknown_actions} value(s) across the three planes are preserved exactly and cannot be selected as KSX keys, and {shared_signals} key(s) are emitted by more than one terminal."
            ),
        },
        board_id: "USB\\VID_D209&PID_0430\\FIXTURE".into(),
        board_name: "Ultimarc I-PAC 4".into(),
        board_fingerprint: "fixture-ipac-d209-0430-0056".into(),
        driver: "ultimarc-ipac4".into(),
        protocol_profile: "ipac4-pac256-v1".into(),
        image_sha256: fixture_sha256(&image),
        image_bytes: 256,
        programming_state: "supervised".into(),
        programming_detail: "The fixture models the guarded workflow but sends no hardware report.".into(),
        qualification_state: "required".into(),
        qualification_detail: if blank {
            "Choose one SW terminal and temporary safe key to preview the reversible writer check."
                .into()
        } else {
            "Choose one SW terminal and a different temporary safe key to preview changing and restoring an existing assignment."
                .into()
        },
        qualification_restore_backup_id: None,
        terminals,
        recommended_terminals,
        key_options,
        backup: backup.then(|| fixture_panel_backup(scenario)),
        notes,
    }
}

fn require_fixture_panel(device: Option<&str>) -> Result<(), ksx_api::Refusal> {
    let selected = device.unwrap_or_default();
    if selected.eq_ignore_ascii_case("usb:d209:0430:00") {
        Ok(())
    } else {
        Err(ksx_api::Refusal::new(
            ksx_api::codes::BAD_REQUEST,
            format!("the fixture has no panel matching '{selected}'"),
        ))
    }
}

impl ksx_api::MachineSource for NoMachine {
    /// The configuration menu's identity row: a config.toml with the two
    /// seeded controllers. `KSX_FIXTURE_THEME` seeds the stored theme id
    /// (the `KSX_FIXTURE_SESSION` precedent) so the browser suites can
    /// exercise the server-stamped `data-theme` without a config file —
    /// this fixture fabricates state and reads no config.toml.
    fn setup_state(&self) -> Result<ksx_api::SetupView, ksx_api::Refusal> {
        if self.scenario.starts_without_ksx_config() {
            let saved = self.saved_stage.lock().unwrap();
            return Ok(first_run_setup_state(saved.as_ref()));
        }
        Ok(ksx_api::SetupView {
            config_exists: true,
            theme: std::env::var("KSX_FIXTURE_THEME").unwrap_or_default(),
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
        if self.scenario.starts_without_ksx_config() {
            return Ok(ksx_api::ProfilesView {
                generated_at: "fixture".into(),
                config_root: "C:\\fixture".into(),
                games_path: "C:\\fixture\\games.toml".into(),
                profiles: Vec::new(),
                notes: Vec::new(),
            });
        }
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
                    role: ksx_api::BoardRole::PanelEncoder,
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
                    // WITHOUT THESE THE READ SURFACE DOES NOT EXIST.
                    //
                    // `chart_readable` defaults to false, `choosingReadable()`
                    // reads it, and `syncControlSurfaceChrome` leaves
                    // `#n-encoder-read` hidden when it is false. So every state
                    // `--messy-panel` was built to render — the vendor byte, the
                    // unobservable usage, the opaque shift byte, the shift
                    // terminal, the shared key, the zero byte — was unreachable
                    // in a browser while the Rust test that decodes them passed,
                    // because that test calls the chart builder directly and
                    // never goes through the roster.
                    chart_readable: true,
                    family_label: Some("Ultimarc I-PAC 4".into()),
                    firmware_label: Some("firmware 1.56".into()),
                    profile_state: "profiled".into(),
                    profile_detail:
                        "ksx has a measured protocol profile for this firmware and can read the \
                         chart."
                            .into(),
                    terminal_count: Some(56),
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

    /// The Builder's inspection card needs a believable passive answer in
    /// this browser fixture. It mirrors the measured I-PAC topology while
    /// keeping the production boundary explicit: raw descriptor metadata,
    /// no chart query and no report transaction.
    fn panel_status(
        &self,
        spec: &ksx_api::PanelStatusSpec,
    ) -> Result<ksx_api::PanelStatusView, ksx_api::Refusal> {
        require_fixture_panel(spec.device.as_deref())?;
        let (chart_detail, chart_label, recommendation) = match self.scenario {
            FixtureScenario::Seeded => (
                "Open I-PAC Setup to load the fixture's all-Unassigned first-run chart; no physical report is sent",
                "All-Unassigned first-run preview available",
                "Choose Set up to QA the blank-board read, backup, qualification, and review flow without writing hardware",
            ),
            FixtureScenario::BlankPanel => (
                "Open I-PAC Setup to load the explicit all-Unassigned encoder chart; no physical report is sent",
                "Blank encoder preview available",
                "Choose Set up to QA initialization of an encoder whose terminals emit no keys yet",
            ),
            FixtureScenario::FirstRun => (
                "Open I-PAC Setup to load the fixture's existing 56-key chart; no physical report is sent",
                "Preconfigured encoder preview available",
                "Choose Set up to inspect and back up the existing terminal-to-key assignments before routing them through KSX",
            ),
            FixtureScenario::MessyPanel => (
                "Open I-PAC Setup to load the fixture's used chart, vendor bytes included; no physical report is sent",
                "Used encoder preview available",
                "Choose Set up to inspect a chart carrying preserved vendor bytes, an opaque shift byte, a shift terminal, a shared key and an unassigned terminal before routing any of it through KSX",
            ),
        };
        Ok(ksx_api::PanelStatusView {
            generated_at: "fixture".into(),
            summary: "1 physical USB board matched; 6 HID collections were inspected".into(),
            inspection_note: "Read-only metadata inspection: HID handles used desired access 0; no input, output, or feature report was requested or sent.".into(),
            access_detail:
                "USB descriptors and passive HID collection metadata were readable".into(),
            usb_available: true,
            hid_available: true,
            panels: vec![ksx_api::PanelStatusRow {
                board_id: "USB\\VID_D209&PID_0430\\FIXTURE".into(),
                name: "Ultimarc I-PAC 4".into(),
                identity: "USB VID D209, PID 0430, raw bcdDevice 0x0056".into(),
                vendor_id: 0xD209,
                product_id: 0x0430,
                family_id: Some("ultimarc-ipac4".into()),
                family_label: Some("Ultimarc I-PAC 4X".into()),
                bcd_device: 0x0056,
                firmware_label: Some("1.56".into()),
                firmware_detail: "Measured KSX I-PAC 4 release-0056 profile matched USB bcdDevice 0x0056; firmware was not queried from the board.".into(),
                profile_terminal_count: Some(56),
                serial: None,
                driver: "ultimarc-ipac".into(),
                driver_supported: true,
                driver_label: "Ultimarc I-PAC 4 lossless chart driver · fixture preview".into(),
                observed_mode: "keyboard-compatible".into(),
                mode_detail: "Keyboard-compatible HID input was observed; exact vendor mode was not queried. Evidence: MI_00 declares the HID boot-keyboard protocol".into(),
                observed_mode_label: "Keyboard-compatible input observed".into(),
                mode_read_supported: false,
                capabilities: ksx_api::PanelDriverCapabilities {
                    can_identify: true,
                    can_report_mode: false,
                    can_read_chart: true,
                    can_write_chart: true,
                    write_is_persistent: true,
                },
                chart_state: "available-unopened".into(),
                chart_attempted: false,
                chart_detail: chart_detail.into(),
                chart_label: chart_label.into(),
                configuration_collection_state: "available-unopened".into(),
                configuration_collection: Some(
                    "HID\\VID_D209&PID_0430&MI_02&COL01\\FIXTURE".into(),
                ),
                configuration_collection_detail: "One exact 5-byte IN/OUT configuration collection is available in this synthetic fixture".into(),
                recommendation: recommendation.into(),
                programming_recovery_required: false,
                programming_recovery_detail: String::new(),
                interfaces: vec![ksx_api::PanelInterfaceRow {
                    instance_id: "USB\\VID_D209&PID_0430&MI_00\\FIXTURE".into(),
                    interface_number: 0,
                    interface_class: 3,
                    interface_subclass: 1,
                    interface_protocol: 1,
                    binding: "hidusb.sys (keyboard stack)".into(),
                    boot_keyboard: true,
                    description: "USB Input Device".into(),
                }],
                hid_collections: vec![ksx_api::PanelHidCollectionRow {
                    instance_id: "HID\\VID_D209&PID_0430&MI_02&COL01\\FIXTURE".into(),
                    state: "available".into(),
                    vendor_id: Some(0xD209),
                    product_id: Some(0x0430),
                    version_number: Some(0x0056),
                    usage_page: Some(0x0001),
                    usage: Some(0x0000),
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
    ) -> Result<ksx_api::PanelChartView, ksx_api::Refusal> {
        require_fixture_panel(spec.device.as_deref())?;
        if spec.backup {
            self.panel_backup_created
                .store(true, std::sync::atomic::Ordering::Release);
        }
        Ok(fixture_panel_chart(self.scenario, spec.backup))
    }

    fn panel_backups(
        &self,
        spec: &ksx_api::PanelBackupsSpec,
    ) -> Result<ksx_api::PanelBackupsView, ksx_api::Refusal> {
        require_fixture_panel(spec.device.as_deref())?;
        let backups = self
            .panel_backup_created
            .load(std::sync::atomic::Ordering::Acquire)
            .then(|| fixture_panel_backup(self.scenario))
            .into_iter()
            .collect();
        Ok(ksx_api::PanelBackupsView {
            summary: match self.scenario {
                FixtureScenario::Seeded => "Fixture-only first-run restore points.".into(),
                FixtureScenario::FirstRun => {
                    "Fixture-only restore points for the preconfigured encoder chart.".into()
                }
                FixtureScenario::BlankPanel => {
                    "Fixture-only restore points for the blank encoder chart.".into()
                }
                FixtureScenario::MessyPanel => {
                    "Fixture-only restore points for the used encoder chart.".into()
                }
            },
            board_fingerprint: "fixture-ipac-d209-0430-0056".into(),
            backups,
        })
    }

    fn panel_program_plan(
        &self,
        spec: &ksx_api::PanelProgramSpec,
    ) -> Result<ksx_api::PanelProgramPlanView, ksx_api::Refusal> {
        require_fixture_panel(spec.device.as_deref())?;
        let baseline = fixture_panel_image(self.scenario);
        let baseline_sha = fixture_sha256(&baseline);
        if spec.expected_base_sha256 != baseline_sha || spec.layout != "custom" {
            return Err(ksx_api::Refusal::new(
                ksx_api::codes::BAD_REQUEST,
                if self.scenario == FixtureScenario::Seeded {
                    "the fixture review requires its current blank-chart hash and custom layout"
                } else {
                    "the fixture review requires its current chart hash and custom layout"
                },
            ));
        }
        let [edit] = spec.edits.as_slice() else {
            return Err(ksx_api::Refusal::new(
                ksx_api::codes::BAD_REQUEST,
                "the fixture writer check requires exactly one terminal edit",
            ));
        };
        if edit.shifted_key.is_some() || edit.is_shift.is_some() || edit.allow_shared_key {
            return Err(ksx_api::Refusal::new(
                ksx_api::codes::BAD_REQUEST,
                "the fixture writer check accepts one unshared normal-key edit only",
            ));
        }
        let after = edit.normal_key.as_deref().ok_or_else(|| {
            ksx_api::Refusal::new(
                ksx_api::codes::BAD_REQUEST,
                "choose one temporary normal key for the fixture review",
            )
        })?;
        let terminal = edit.terminal_id.to_ascii_lowercase();
        let chart = fixture_panel_chart(self.scenario, false);
        let terminal_row = chart
            .terminals
            .iter()
            .find(|candidate| candidate.terminal_id == terminal && candidate.kind == "button")
            .ok_or_else(|| {
                ksx_api::Refusal::new(
                    ksx_api::codes::BAD_REQUEST,
                    format!("'{terminal}' is not a fixture SW action terminal"),
                )
            })?;
        let key = chart
            .key_options
            .iter()
            .find(|candidate| {
                candidate.safe_for_qualification && candidate.key.eq_ignore_ascii_case(after)
            })
            .ok_or_else(|| {
                ksx_api::Refusal::new(
                    ksx_api::codes::BAD_REQUEST,
                    format!("the fixture chart cannot program key '{after}'"),
                )
            })?;
        if terminal_row.normal.code == key.code {
            return Err(ksx_api::Refusal::new(
                ksx_api::codes::BAD_REQUEST,
                format!(
                    "choose a different temporary key; {terminal} already emits '{}'",
                    terminal_row.normal.label
                ),
            ));
        }
        let base = FIXTURE_IPAC_TERMINALS
            .iter()
            .find_map(|(id, _, base)| (*id == terminal).then_some(*base as usize))
            .expect("terminal row and exact sparse offset table stay aligned");
        let offset = 4 + base;
        let mut desired = baseline;
        desired[offset] = u8::try_from(key.code).expect("fixture key usage fits one byte");
        Ok(ksx_api::PanelProgramPlanView {
            summary: match self.scenario {
                FixtureScenario::Seeded => "Preview one reversible terminal assignment while preserving the other 255 bytes."
                    .into(),
                FixtureScenario::BlankPanel => "Preview one reversible assignment on the blank encoder while preserving the other 255 bytes."
                    .into(),
                FixtureScenario::FirstRun => "Preview one reversible change to the existing chart while preserving the other 255 bytes."
                    .into(),
                FixtureScenario::MessyPanel => "Preview one reversible change to the used chart while preserving the other 255 bytes, vendor bytes included."
                    .into(),
            },
            board_id: "USB\\VID_D209&PID_0430\\FIXTURE".into(),
            board_name: "Ultimarc I-PAC 4".into(),
            board_fingerprint: "fixture-ipac-d209-0430-0056".into(),
            protocol_profile: "ipac4-pac256-v1".into(),
            base_sha256: baseline_sha,
            desired_sha256: fixture_sha256(&desired),
            image_bytes: 256,
            terminal_diff: vec![ksx_api::PanelTerminalDiffRow {
                terminal_id: terminal.clone(),
                terminal_label: terminal_row.terminal_label.clone(),
                layer: "normal".into(),
                before: terminal_row.normal.label.clone(),
                after: key.label.clone(),
            }],
            byte_diff: vec![ksx_api::PanelByteDiffRow {
                offset,
                before: terminal_row.normal.code,
                after: key.code,
                meaning: format!("{terminal} normal"),
            }],
            preserved_byte_count: 255,
            confirmation: "I reviewed this exact fixture diff; no hardware write is available in the demo.".into(),
            blockers: vec![
                "Fixture preview only — the demo server intentionally cannot write physical EEPROM."
                    .into(),
            ],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_arguments_keep_seeded_default_and_require_an_explicit_scenario() {
        assert_eq!(
            parse_fixture_args(std::iter::empty::<&str>()).unwrap(),
            (4476, FixtureScenario::Seeded, None)
        );
        assert_eq!(
            parse_fixture_args(["4520", "--first-run"]).unwrap(),
            (4520, FixtureScenario::FirstRun, None)
        );
        assert_eq!(
            parse_fixture_args([
                "--blank-panel",
                "4521",
                "--generation=launch-0123456789abcdef",
            ])
            .unwrap(),
            (
                4521,
                FixtureScenario::BlankPanel,
                Some("launch-0123456789abcdef".into()),
            )
        );
        assert_eq!(
            parse_fixture_args(["4522", "--messy-panel"]).unwrap(),
            (4522, FixtureScenario::MessyPanel, None)
        );
        assert!(parse_fixture_args(["--first-run", "--blank-panel"]).is_err());
        assert!(parse_fixture_args(["--blank-panel", "--blank-panel"]).is_err());
        assert!(parse_fixture_args(["--messy-panel", "--first-run"]).is_err());
        assert!(parse_fixture_args(["--messy-panel", "--messy-panel"]).is_err());
        assert!(parse_fixture_args(["4476", "4478"]).is_err());
        assert!(parse_fixture_args(["--generation=one", "--generation=two"]).is_err());
        assert!(parse_fixture_args(["--generation=bad value"]).is_err());
        assert!(parse_fixture_args(["--mystery"]).is_err());
    }

    #[test]
    fn first_ksx_visit_and_blank_encoder_are_independent_fixture_facts() {
        assert!(!FixtureScenario::Seeded.starts_without_ksx_config());
        assert!(FixtureScenario::FirstRun.starts_without_ksx_config());
        assert!(FixtureScenario::BlankPanel.starts_without_ksx_config());
        assert!(FixtureScenario::MessyPanel.starts_without_ksx_config());

        assert!(FixtureScenario::Seeded.panel_is_blank());
        assert!(!FixtureScenario::FirstRun.panel_is_blank());
        assert!(FixtureScenario::BlankPanel.panel_is_blank());
        assert!(!FixtureScenario::MessyPanel.panel_is_blank());

        // Not-blank is two different boards: the clean 56-key stand-in and the
        // used one. Nothing may treat "not blank" as "ordinary".
        assert!(!FixtureScenario::Seeded.panel_is_messy());
        assert!(!FixtureScenario::FirstRun.panel_is_messy());
        assert!(!FixtureScenario::BlankPanel.panel_is_messy());
        assert!(FixtureScenario::MessyPanel.panel_is_messy());

        assert_eq!(FixtureScenario::Seeded.label(), "seeded-demo");
        assert_eq!(FixtureScenario::FirstRun.label(), "first-run");
        assert_eq!(FixtureScenario::BlankPanel.label(), "blank-encoder");
        assert_eq!(FixtureScenario::MessyPanel.label(), "messy-encoder");
    }

    #[test]
    fn every_fixture_scenario_is_visibly_and_honestly_labeled() {
        let cases = [
            (
                FixtureScenario::Seeded,
                "fixture-seeded-demo",
                "FIXTURE · SEEDED DEMO",
            ),
            (
                FixtureScenario::FirstRun,
                "fixture-first-run",
                "FIXTURE · FIRST RUN",
            ),
            (
                FixtureScenario::BlankPanel,
                "fixture-blank-encoder",
                "FIXTURE · BLANK ENCODER",
            ),
            (
                FixtureScenario::MessyPanel,
                "fixture-messy-encoder",
                "FIXTURE · MESSY ENCODER",
            ),
        ];

        for (scenario, id, label) in cases {
            let environment =
                StatusSource::environment(&Store::with_generation(scenario, "launch-test-42"));
            assert!(environment.fixture);
            assert_eq!(environment.id, id);
            assert_eq!(environment.label, label);
            assert!(environment.detail.starts_with("Synthetic"));
            assert!(environment
                .detail
                .contains("no physical devices are read or written"));
            assert_eq!(environment.generation, "launch-test-42");
        }
    }

    #[test]
    fn first_run_is_empty_everywhere_but_keeps_the_real_staging_engine() {
        let store = Store::new(FixtureScenario::FirstRun);
        let staged = ControlSource::staged(&store);
        assert!(staged.reachable);
        assert!(staged.empty);
        assert!(!staged.dirty);
        assert!(staged.device.is_none());
        assert!(staged.slots.is_empty());
        assert_eq!(staged.next_slot, Some(1));

        assert!(StatusSource::snapshot(&store).pads.is_empty());
        assert!(StatusSource::snapshot(&store).profiles.is_empty());
        assert_eq!(StatusSource::snapshot(&store).interception, "not installed");
        assert!(StatusSource::mapper(&store).slots.is_empty());
        assert!(ControlSource::start(&store, None).is_err());

        let setup = first_run_setup_state(None);
        assert!(!setup.config_exists);
        assert!(setup.devices.is_empty());
        assert!(setup.slots.is_empty());
        assert!(setup.presets.is_empty());
        assert!(setup.profiles.is_empty());
    }

    #[test]
    fn blank_panel_is_also_a_clean_ksx_visit() {
        let store = Store::new(FixtureScenario::BlankPanel);
        let staged = ControlSource::staged(&store);
        assert!(staged.reachable);
        assert!(staged.empty);
        assert!(!staged.dirty);
        assert!(staged.device.is_none());
        assert!(staged.slots.is_empty());
        assert!(StatusSource::mapper(&store).slots.is_empty());
        assert!(ControlSource::start(&store, None).is_err());
    }

    /// The messy chart is a fact about the ENCODER. KSX's own history is still
    /// empty, exactly like the other two hardware scenarios — otherwise a
    /// manual pass would be reading a used board through a pre-seeded KSX and
    /// could not tell which of the two supplied a claim.
    #[test]
    fn messy_panel_is_also_a_clean_ksx_visit() {
        let store = Store::new(FixtureScenario::MessyPanel);
        let staged = ControlSource::staged(&store);
        assert!(staged.reachable);
        assert!(staged.empty);
        assert!(!staged.dirty);
        assert!(staged.device.is_none());
        assert!(staged.slots.is_empty());
        assert!(StatusSource::mapper(&store).slots.is_empty());
        assert!(StatusSource::snapshot(&store).pads.is_empty());
        assert!(ControlSource::start(&store, None).is_err());
        assert!(StatusSource::macros(&store, PRESET).macros.is_empty());
    }

    #[test]
    fn first_run_save_becomes_the_configuration_that_can_be_loaded() {
        let store = Store::new(FixtureScenario::FirstRun);
        *store.stage.lock().unwrap() = seeded_stage();
        let saved = ControlSource::stage_commit(&store);
        assert!(saved.ok, "{}", saved.message.as_deref().unwrap_or_default());
        assert!(!saved.setup.dirty);
        assert_eq!(saved.setup.origin, "config");

        let held = store.saved_stage.lock().unwrap();
        let setup = first_run_setup_state(held.as_ref());
        assert!(setup.config_exists);
        assert_eq!(setup.devices.len(), 1);
        assert_eq!(setup.slots.len(), 2);
        assert_eq!(setup.presets, ["Player 1", "Player 2"]);
        drop(held);

        let discarded = ControlSource::stage_edit(&store, &ksx_api::StageEdit::Discard);
        assert!(discarded.ok);
        assert!(discarded.setup.empty);
        assert!(!discarded.setup.dirty);
        assert!(discarded.setup.origin.is_empty());
        let adopted = ControlSource::stage_adopt(&store, None);
        assert!(
            adopted.ok,
            "{}",
            adopted.error.as_deref().unwrap_or_default()
        );
        assert_eq!(adopted.setup.slots.len(), 2);
        assert!(!adopted.setup.dirty);
        assert_eq!(adopted.setup.origin, "config");
    }

    #[test]
    fn seeded_adopt_still_resets_to_its_canonical_browser_test_state() {
        let store = Store::new(FixtureScenario::Seeded);
        *store.stage.lock().unwrap() = ksx_core::stage::StagedSetup::new();
        *store.saved_stage.lock().unwrap() = None;

        let adopted = ControlSource::stage_adopt(&store, None);
        assert!(
            adopted.ok,
            "{}",
            adopted.error.as_deref().unwrap_or_default()
        );
        assert_eq!(adopted.setup.slots.len(), 2);
        assert_eq!(adopted.setup.device.unwrap().label, "Ultimarc I-PAC 4");
    }

    #[test]
    fn first_run_play_reports_the_number_of_controllers_that_actually_started() {
        let store = Store::new(FixtureScenario::FirstRun);
        *store.stage.lock().unwrap() = seeded_stage();
        let removed =
            ControlSource::stage_edit(&store, &ksx_api::StageEdit::RemoveSlot { number: 2 });
        assert!(removed.ok);

        let played = ControlSource::stage_play(&store);
        assert!(played.ok, "{}", played.error.as_deref().unwrap_or_default());
        let session = ControlSource::session(&store);
        assert_eq!(session.line, "running — Fixture — 1 pad(s)");
        assert_eq!(session.active.unwrap().outputs, "1 virtual pad (fixture)");
    }

    /// **The messy fixture actually reaches the states it exists to reach.**
    ///
    /// The fixture it replaces served `supported: true` and
    /// `PanelShiftState::Disabled` on all 56 rows, so every state the truth
    /// model composes was unreachable in a browser and the surface for them was
    /// never once rendered by a test. Asserting the scenario parses is not the
    /// same as asserting the bytes decode, so this reads the decoded chart.
    #[test]
    fn the_messy_chart_decodes_into_every_state_it_promises() {
        let chart = fixture_panel_chart(FixtureScenario::MessyPanel, false);
        let row = |id: &str| {
            chart
                .terminals
                .iter()
                .find(|terminal| terminal.terminal_id == id)
                .unwrap_or_else(|| panic!("the messy overlay names {id}"))
                .clone()
        };

        // A vendor byte: unnameable, and the one case where pressing the
        // control CAN complete what the read could not.
        let vendor = row("1sw5");
        assert!(!vendor.normal.supported);
        assert!(vendor.normal.key.is_none());
        assert!(
            vendor.normal.label.starts_with("Preserved vendor action"),
            "{}",
            vendor.normal.label
        );

        // A keyboard usage KSX cannot observe. It must carry a DIFFERENT label
        // from the vendor byte above: the backend decides whether to offer a
        // press by reading exactly this text, and offering one here is an offer
        // that can never succeed.
        let unobservable = row("1sw6");
        assert!(!unobservable.normal.supported);
        assert!(
            unobservable.normal.label.starts_with("Unobservable HID action"),
            "{}",
            unobservable.normal.label
        );
        assert_ne!(vendor.normal.label, unobservable.normal.label);

        // An opaque shift byte is not "shift disabled".
        let opaque = row("1sw7");
        assert_eq!(opaque.shift_state, ksx_api::PanelShiftState::Opaque);
        assert!(!opaque.is_shift);

        // Exactly one terminal is the shift key, so the shifted column on every
        // other row means something.
        let shift = row("1start");
        assert_eq!(shift.shift_state, ksx_api::PanelShiftState::Enabled);
        assert!(shift.is_shift);
        assert_eq!(
            chart
                .terminals
                .iter()
                .filter(|terminal| terminal.is_shift)
                .count(),
            1
        );
        assert!(row("1sw8").shifted.key.is_some());

        // Two terminals emitting one key: the case where an observation cannot
        // be attributed to a terminal at all.
        let (first, second) = (row("2sw1"), row("2sw2"));
        assert!(first.normal.key.is_some());
        assert_eq!(first.normal.key, second.normal.key);

        // A byte that is genuinely zero — indistinguishable from an onboard
        // macro, so it is `Unassigned` and never "does nothing".
        let zero = row("3sw8");
        assert_eq!(zero.normal.code, 0);
        assert_eq!(zero.normal.label, "Unassigned");

        // None of the above is reachable without the flag, which is the whole
        // reason the flag exists.
        let clean = fixture_panel_chart(FixtureScenario::FirstRun, false);
        assert!(clean.terminals.iter().all(|t| t.normal.supported));
        assert!(clean.terminals.iter().all(|t| !t.is_shift));
    }
}
