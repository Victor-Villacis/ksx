//! Fixture sources: a fully synthetic cabinet with a scripted machine behind it.
//!
//! This exists for one reason and it is not a shortcut. A 10-foot surface is a
//! **design artefact** — the type has to be legible from six feet, the focus
//! ring has to be findable across a room, and the two columns of the button
//! check have to hold a plausible amount of live data without collapsing. None
//! of that can be judged from a screenshot of an empty panel with no daemon
//! behind it, and none of it should require starting a real session on a real
//! cabinet with real keyboards captured.
//!
//! So: `ksx cabinet --demo` renders the same window, the same theme and the
//! same navigation against a scripted cabinet. It performs **no verb** — every
//! [`ksx_api::ControlSource`] write here answers with a refusal that says it is
//! a demo — so it can never touch a real machine, a real config, or a running
//! daemon.

use std::sync::Mutex;
use std::time::Instant;

use ksx_api::{
    codes, ControlSource, KeyHit, LiveFeed, LiveFrame, MachineSource, MapperSlot, MapperSnapshot,
    PadRow, PresetRow, PresetsView, ProfileRow, Refusal, SessionView, SlotLive, SlotOutcome,
    StatusSnapshot, StatusSource,
};

/// A cabinet mid-session: four slots, a game up, everything healthy.
pub struct DemoStatus;

const DEMO_PROFILE: &str = "Example Launcher";
const DEMO_CONFIG_ROOT: &str = r"C:\cfg\ksx";

impl StatusSource for DemoStatus {
    fn snapshot(&self) -> StatusSnapshot {
        StatusSnapshot {
            generated_at: "2026-08-06 18:40:11 UTC".into(),
            vigem: "installed — service running — driver v1.22.0".into(),
            hidmaestro: ksx_api::ControllerOutputView::hidmaestro_inventory(
                true,
                false,
                Some("1.6.1".into()),
            ),
            interception: "not installed — every bound board is WinUSB-claimed".into(),
            daemon_running: true,
            daemon_detail: "ksx.exe alive (pid 4242) — claim held since 09:12".into(),
            autostart: format!("registered — ksx daemon --game \"{DEMO_PROFILE}\""),
            pads: (1..=4)
                .map(|n| PadRow {
                    persona: "Xbox 360 pad".into(),
                    instance: format!(r"USB\VID_045E&PID_028E\2&AA&0&0{n}"),
                })
                .collect(),
            profiles: vec![
                ProfileRow {
                    title: DEMO_PROFILE.into(),
                    detail: "example-launcher://library/1234 — 4 slots".into(),
                },
                ProfileRow {
                    title: "Example Game".into(),
                    detail: r"C:\Examples\example-game.exe — 4 slots".into(),
                },
                ProfileRow {
                    title: "Example Two Player Game".into(),
                    detail: r"D:\Examples\example-two-player.exe — 2 slots".into(),
                },
            ],
            config_root: DEMO_CONFIG_ROOT.into(),
        }
    }

    fn mapper(&self) -> MapperSnapshot {
        MapperSnapshot {
            generated_at: "2026-08-06 18:40:11 UTC".into(),
            source: format!("slots of profile \"{DEMO_PROFILE}\" (games.toml)"),
            // The same profile the demo session reports, so the demo does not
            // show a mismatch warning that a real cabinet would not have.
            profile: Some(DEMO_PROFILE.into()),
            config_root: DEMO_CONFIG_ROOT.into(),
            slots: (1..=4)
                .map(|n| MapperSlot {
                    number: n,
                    persona: "xbox360".into(),
                    persona_label: "Xbox 360".into(),
                    preset: format!("Panel P{n}"),
                    keyboard: if n <= 2 { "Panel A" } else { "Panel B" }.into(),
                    bindings: Default::default(),
                    backup: None,
                    session_backup: false,
                    turbo: Default::default(),
                    toggle: Default::default(),
                    macros_off: false,
                })
                .collect(),
        }
    }
}

/// A control source that answers the reads and refuses every write **in
/// words**, naming itself. Nothing here can reach a machine.
pub struct DemoControl;

impl ControlSource for DemoControl {
    fn session(&self) -> SessionView {
        SessionView {
            reachable: true,
            running: true,
            line: format!("running — {DEMO_PROFILE} — 4 pad(s)"),
            profile: Some(DEMO_PROFILE.into()),
            origin: ksx_api::SessionOrigin::Config,
            active: None,
        }
    }

    fn start(&self, _profile: Option<&str>) -> Result<String, Refusal> {
        Err(demo_refusal("start emulation"))
    }

    fn stop(&self) -> Result<String, Refusal> {
        Err(demo_refusal("stop emulation"))
    }

    fn resume(&self) -> Result<String, Refusal> {
        Err(demo_refusal("resume emulation"))
    }

    fn reload(&self) -> Result<String, Refusal> {
        Err(demo_refusal("reload the config"))
    }

    fn assign_slot(&self, request: &ksx_api::SlotAssignRequest) -> SlotOutcome {
        SlotOutcome {
            ok: false,
            error: Some(format!(
                "this is `ksx cabinet --demo` — nothing was written. The real verb is \
                 `ksx slot assign --slot {}{}{}`",
                request.slot,
                // Echo only the halves the caller actually asked for: a demo
                // that printed `--preset ""` would be teaching a command that
                // does not work.
                request
                    .preset
                    .as_deref()
                    .map(|preset| format!(" --preset \"{preset}\""))
                    .unwrap_or_default(),
                request
                    .persona
                    .as_deref()
                    .map(|persona| format!(" --persona {persona}"))
                    .unwrap_or_default()
            )),
            code: Some(codes::NOT_HERE.to_owned()),
            ..SlotOutcome::default()
        }
    }
}

fn demo_refusal(what: &str) -> Refusal {
    Refusal::with_remedy(
        codes::NOT_HERE,
        format!("this is `ksx cabinet --demo` — it will not {what} on a real machine"),
        "run `ksx cabinet` against a live daemon",
    )
}

pub struct DemoMachine;

impl MachineSource for DemoMachine {
    fn presets(&self) -> Result<PresetsView, Refusal> {
        Ok(PresetsView {
            config_root: DEMO_CONFIG_ROOT.into(),
            presets: [
                "Panel P1",
                "Panel P2",
                "Panel P3",
                "Panel P4",
                "Example Game P1",
                "default",
            ]
            .into_iter()
            .map(|name| PresetRow {
                name: name.into(),
                bound: 14,
                macros: 2,
                protected: name == "default",
                usable: true,
                problem: None,
                source: format!(r"C:\…\presets\{name}.toml"),
                // The demo's two slots both name a layout, so the row that
                // shows a use count shows a REAL one here too.
                used_by: usize::from(name != "default"),
            })
            .collect(),
            templates: Vec::new(),
        })
    }
}

/// A scripted panel: four players pressing things, on a loop.
///
/// Deliberately irregular — a real panel does not produce one press per frame
/// on the beat, and a screenshot of a metronome would not tell us whether the
/// decay reads correctly.
pub struct DemoFeed {
    started: Instant,
    last: Mutex<u64>,
}

impl Default for DemoFeed {
    fn default() -> Self {
        Self {
            started: Instant::now(),
            last: Mutex::new(0),
        }
    }
}

/// `(key, device alias, slot, control)` — one scripted press, with both
/// columns of the truth it produces.
const SCRIPT: [(&str, &str, u8, &str); 8] = [
    ("G", "Panel P1", 1, "A"),
    ("H", "Panel P1", 1, "B"),
    ("R", "Panel P2", 2, "dpad.up"),
    ("D", "Panel P2", 2, "lt"),
    ("A", "Panel P3", 3, "X"),
    ("W", "Panel P3", 3, "dpad.left"),
    ("K", "Panel P4", 4, "Y"),
    ("L", "Panel P4", 4, "start"),
];

impl LiveFeed for DemoFeed {
    fn poll(&mut self) -> LiveFrame {
        // One step every ~230 ms: slow enough to read, fast enough that a
        // screenshot almost always catches something lit.
        let step = self.started.elapsed().as_millis() as u64 / 230;
        let mut last = self.last.lock().expect("demo feed");
        let fired: Vec<u64> = ((*last + 1)..=step).collect();
        *last = step;
        drop(last);

        let mut frame = LiveFrame {
            running: true,
            ..LiveFrame::default()
        };
        let mut slots: Vec<SlotLive> = (1..=4)
            .map(|slot| SlotLive {
                slot,
                ..SlotLive::default()
            })
            .collect();
        for tick in fired {
            let (key, alias, slot, control) = SCRIPT[(tick as usize) % SCRIPT.len()];
            frame.keys.push(KeyHit {
                key: key.into(),
                device: format!(r"HID\VID_F00D&PID_BEEF&MI_0{slot}\8&A1B2C3D4&0&000{slot}"),
                alias: alias.into(),
                down: true,
            });
            if let Some(entry) = slots.iter_mut().find(|s| s.slot == slot) {
                entry.hit.push(control.to_owned());
                // Every other press is still HELD when the frame is taken, so
                // both the "down now" and the "just happened" treatments are
                // on screen at once and can be compared.
                if tick % 2 == 0 {
                    entry.down.push(control.to_owned());
                }
            }
        }
        frame.slots = slots;
        frame
    }
}

/// The whole demo cabinet.
pub fn cabinet() -> crate::Cabinet {
    crate::Cabinet {
        status: std::sync::Arc::new(DemoStatus),
        control: std::sync::Arc::new(DemoControl),
        machine: std::sync::Arc::new(DemoMachine),
        feed: Box::new(DemoFeed::default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The demo must be incapable of touching a real machine — every write is
    /// a worded refusal, never a silent success.
    #[test]
    fn the_demo_refuses_every_write_in_words() {
        let control = DemoControl;
        for refusal in [
            control.start(None).unwrap_err(),
            control.stop().unwrap_err(),
            control.reload().unwrap_err(),
        ] {
            assert_eq!(refusal.code, codes::NOT_HERE);
            assert!(refusal.message.contains("--demo"), "{refusal}");
            assert!(refusal.remedy.is_some(), "a refusal owes a way out");
        }
        let assigned = control.assign_slot(&ksx_api::SlotAssignRequest {
            slot: 1,
            preset: Some("Panel P2".into()),
            profile: None,
            persona: None,
            socd: None,
            reload: true,
        });
        assert!(!assigned.ok);
        assert!(assigned.headline().contains("ksx slot assign"));
    }

    #[test]
    fn the_demo_payload_is_explicitly_synthetic() {
        let status = DemoStatus.snapshot();
        assert_eq!(status.config_root, DEMO_CONFIG_ROOT);
        assert_eq!(status.profiles[0].title, DEMO_PROFILE);
        assert_eq!(status.profiles[1].title, "Example Game");
        assert_eq!(
            status.profiles[0].detail,
            "example-launcher://library/1234 — 4 slots"
        );
        assert_eq!(
            status.profiles[1].detail,
            r"C:\Examples\example-game.exe — 4 slots"
        );

        let mapper = DemoStatus.mapper();
        assert_eq!(mapper.profile.as_deref(), Some(DEMO_PROFILE));
        assert!(mapper.slots.iter().all(|slot| {
            slot.preset.starts_with("Panel P") && slot.keyboard.starts_with("Panel ")
        }));

        let presets = DemoMachine.presets().expect("synthetic presets");
        assert!(presets.presets.iter().any(|row| row.name == "Panel P1"));
        assert!(presets
            .presets
            .iter()
            .any(|row| row.name == "Example Game P1"));
    }

    /// The scripted feed produces BOTH columns for one press, which is the
    /// thing the screenshot has to show.
    #[test]
    fn the_demo_feed_produces_both_columns() {
        let mut feed = DemoFeed {
            started: Instant::now() - std::time::Duration::from_millis(2_000),
            last: Mutex::new(0),
        };
        let frame = feed.poll();
        assert!(frame.running);
        assert!(!frame.keys.is_empty(), "the panel column");
        assert!(
            frame
                .keys
                .iter()
                .all(|hit| hit.device.contains("VID_F00D&PID_BEEF")),
            "the demo feed must use only synthetic device identities"
        );
        assert!(
            frame.slots.iter().any(|s| !s.hit.is_empty()),
            "the pad column"
        );
    }
}
