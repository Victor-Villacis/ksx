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
/// preset file would), the staged keyboard the migrated /nocturne verbs
/// edit, and a scripted learner so identify-by-key completes a real
/// round-trip against this double.
#[derive(Clone)]
struct Store {
    macros: Arc<Mutex<Vec<MacroView>>>,
    stage: Arc<Mutex<FixtureStage>>,
    /// `Some(generation)` while the scripted learner is "listening"; the next
    /// poll answers with a hit on the fixture I-PAC and clears it.
    listening: Arc<Mutex<Option<u64>>>,
}

struct FixtureStage {
    device: ksx_api::StagedDeviceView,
    blocking: String,
}

impl Store {
    fn new() -> Self {
        Self {
            macros: Arc::new(Mutex::new(seed_macros())),
            stage: Arc::new(Mutex::new(FixtureStage {
                device: ksx_api::StagedDeviceView {
                    label: "Ultimarc I-PAC 4".into(),
                    alias: "panel".into(),
                    selector: "usb:d209:0430:00".into(),
                    rung: "model".into(),
                    survives_replug: true,
                    backend: "interception".into(),
                },
                blocking: "bound-keys".into(),
            })),
            listening: Arc::new(Mutex::new(None)),
        }
    }
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
        Ok("running") => SessionView {
            reachable: true,
            running: true,
            line: "running — Fixture — 1 pad(s)".into(),
            profile: Some("Fixture".into()),
            origin: ksx_api::SessionOrigin::Config,
            active: None,
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
    /// The migrated /nocturne keyboard verbs, against this double: choosing a
    /// board, answering split-or-freeze, and following a capture transition
    /// mutate the fixture's staged keyboard so the page behaves — everything
    /// else keeps refusing in the trait's honest words.
    fn stage_edit(&self, edit: &ksx_api::StageEdit) -> ksx_api::StageOutcome {
        let ok = |message: &str, setup: ksx_api::StagedSetupView| ksx_api::StageOutcome {
            ok: true,
            message: Some(message.to_owned()),
            error: None,
            code: None,
            remedy: None,
            setup,
            saved: None,
            backup: None,
            playing: false,
        };
        let refused = |error: &str, setup: ksx_api::StagedSetupView| ksx_api::StageOutcome {
            ok: false,
            message: None,
            error: Some(error.to_owned()),
            code: Some("bad-request".to_owned()),
            remedy: None,
            setup,
            saved: None,
            backup: None,
            playing: false,
        };
        match edit {
            ksx_api::StageEdit::ChooseDevice {
                selector,
                alias,
                label,
            } => {
                self.stage.lock().unwrap().device = ksx_api::StagedDeviceView {
                    label: label.clone(),
                    alias: alias.clone(),
                    selector: selector.clone(),
                    rung: "model".into(),
                    survives_replug: true,
                    backend: "interception".into(),
                };
                ok("device staged", self.staged())
            }
            ksx_api::StageEdit::SetBlocking { blocking } => {
                let known = ksx_api::BlockingOption::roster()
                    .iter()
                    .any(|option| option.name == *blocking);
                if !known {
                    return refused("unknown blocking mode", self.staged());
                }
                self.stage.lock().unwrap().blocking = blocking.clone();
                ok("blocking staged", self.staged())
            }
            ksx_api::StageEdit::SetDeviceBackend {
                expected_selector,
                backend,
            } => {
                let mut stage = self.stage.lock().unwrap();
                if stage.device.selector != *expected_selector {
                    drop(stage);
                    return refused("the staged selection changed", self.staged());
                }
                stage.device.backend = backend.clone();
                drop(stage);
                ok("backend staged", self.staged())
            }
            _ => refused(
                "the fixture stages only the migrated keyboard verbs — a daemon holds the rest",
                self.staged(),
            ),
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
        // One lock, taken before the struct literal: two `.lock()` calls
        // inside one literal would hold the first guard to the end of the
        // whole expression and deadlock on the second.
        let (staged_device, staged_blocking) = {
            let stage = self.stage.lock().unwrap();
            (stage.device.clone(), stage.blocking.clone())
        };
        let ps_first = std::env::var("KSX_FIXTURE_FIRST").as_deref() == Ok("ps");
        let persona = |name: &str, label: &str, is_xinput: bool| ksx_api::PersonaOption {
            name: name.into(),
            label: label.into(),
            is_xinput,
            backend: "vigem".into(),
            backend_label: "ViGEmBus".into(),
            instance_limit: None,
            can_plug: true,
            gap: None,
            instead: label.into(),
            available: true,
            unavailable_reason: None,
        };
        // Real authoring tables, so the binding pane (and its screenshots)
        // show rows with the interesting notes: a multi-bind with fan-out, a
        // turbo'd trigger, a latched bumper — the states a reviewer needs to
        // see rendered.
        let authored = |name: &str| {
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
                macros: Default::default(),
                turbo: vec![ksx_core::TurboBinding::new(
                    Binding::Trigger(ksx_core::Trigger::Right),
                    12,
                )],
                toggle: vec![Binding::Button(XButton::LeftBumper)],
                protected: false,
            };
            let bindings = core.live_bindings();
            (ksx_config::PresetFile::from_core(&core), bindings)
        };
        let (p1_file, p1_bindings) = authored("Player 1");
        let (p2_file, p2_bindings) = authored("Player 2");
        let mut slots = vec![
            ksx_api::StagedSlotView {
                number: 1,
                persona: "xbox360".into(),
                persona_label: "Xbox 360".into(),
                is_xinput: true,
                preset: "Player 1".into(),
                authoring: Some(p1_file),
                socd: "last-input".into(),
                socd_label: "Last press wins".into(),
                bindings: p1_bindings,
            },
            ksx_api::StagedSlotView {
                number: 2,
                persona: "playstation".into(),
                persona_label: "PlayStation".into(),
                is_xinput: false,
                preset: "Player 2".into(),
                authoring: Some(p2_file),
                socd: String::new(),
                socd_label: String::new(),
                bindings: p2_bindings,
            },
        ];
        if ps_first {
            slots.reverse();
            slots[0].number = 1;
            slots[1].number = 2;
        }
        ksx_api::StagedSetupView {
            reachable: true,
            error: None,
            empty: false,
            device: Some(staged_device),
            slots,
            blocking: Some(staged_blocking),
            next_slot: Some(3),
            next_preset: Some("Player 3".into()),
            xinput_used: 1,
            max_slots: 16,
            max_xinput_slots: 4,
            personas: vec![
                persona("xbox360", "Xbox 360", true),
                persona("playstation", "PlayStation", false),
            ],
            layouts: ksx_api::TemplateRow::roster(),
            default_layout: "arcade-6button".into(),
            blocking_options: ksx_api::BlockingOption::roster(),
            socd_options: ksx_api::SocdOption::roster(),
            dirty: true,
            origin: "config".into(),
            ..ksx_api::StagedSetupView::default()
        }
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
    struct NoMachine;
    impl ksx_api::MachineSource for NoMachine {
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
        Box::new(NoMachine),
        // The fixture has no daemon behind it, so the live feed refuses in
        // words — which is the state the button check renders when nothing is
        // running, and therefore a state worth being able to look at.
        std::sync::Arc::new(ksx_api::NoLiveSource::new(
            "this is the macro fixture — there is no daemon behind it, so there is no live feed",
        )),
    ) {
        eprintln!("fixture failed: {err}");
        std::process::exit(1);
    }
}
