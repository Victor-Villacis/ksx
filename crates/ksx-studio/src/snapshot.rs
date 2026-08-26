//! The status contract — **now `ksx-api`'s** — plus the two PAGE payloads,
//! which stay here because they are this page's shape and nobody else's.
//!
//! `StatusSource` and its snapshots moved to `ksx-api` for the reason
//! docs/M9-DECISION.md §6 gives: the read side must be satisfiable with NO
//! daemon running (ksx-backend's collectors read the config store and the platform
//! directly), and it is consumed by surfaces that do not link this crate. What
//! remains below is the part that genuinely belongs to a web page: the
//! envelope the islands protocol serializes into the document and the poller
//! reads back.

pub use ksx_api::status::*;

use serde::{Deserialize, Serialize};

/// What `GET /api/check` serves AND what the button-check island's props carry
/// — the same one-struct-one-serializer rule as [`StatusPayload`], parity
/// pinned in `render_check.rs`.
///
/// **There is no live data in here, and that is the shape of the page.** This
/// payload is the STRUCTURE — which slots exist, which controls each one's
/// preset names, which keys drive them — read from disk on the server and
/// re-read every few seconds. The lighting-up arrives on a different channel
/// entirely (`GET /api/live`, `crate::live`), at display rate, and touches no
/// signal on the page. Putting a frame in here would mean a button check whose
/// echo was as fast as an HTTP poll, which is not a button check.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckPayload {
    /// The slot roster with every preset's whole binding table — the SAME
    /// `StatusSource::mapper()` read the mapper page uses.
    ///
    /// The control list per slot is `MapperSlot::bindings`' key set, which is
    /// every function the preset names, unbound ones included. That is where
    /// the roster has to come from: a list of "the controls an Xbox pad has"
    /// written into the page would be a second answer to a question the
    /// backend already answers, and docs/SURFACES.md §1 names that failure.
    pub mapper: MapperSnapshot,
    /// The daemon's session state — the page prints it, because "nothing is
    /// lighting up" and "nothing is running" are the same picture and
    /// different problems.
    pub session: crate::control::SessionView,
    /// One sentence saying what this screen watches and where the frames come
    /// from. Composed in Rust so the island words nothing.
    pub feed_hint: String,
}

/// What `GET /api/pads` serves AND what the pads island's props carry — the
/// same one-struct-one-serializer rule as [`StatusPayload`], parity pinned in
/// `render_pads.rs`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PadsPayload {
    /// The bus, its children, and both verbs' preconditions — one
    /// `MachineSource::pads_view` call, never re-derived here.
    pub pads: ksx_api::PadsView,
    /// Whether the daemon answers at all. Not a precondition for this page:
    /// the pad list and the prune plan are collector reads, and the session is
    /// shown because a running one is what REFUSES both verbs.
    pub session: crate::control::SessionView,
    /// Is the destructive panel armed (`/pads?confirm=1`)?
    ///
    /// Always `false` from `/api/pads` — a poll is not a user saying yes, and
    /// a poll that could re-arm a prune would make the confirm panel reappear
    /// after someone had deliberately navigated away from it.
    #[serde(default)]
    pub confirm: bool,
    /// Why the machine read failed, if it did. Rendered as a banner instead of
    /// an empty pad list, which would read as "your bus is clean".
    #[serde(default)]
    pub unavailable: Option<String>,
    /// One-shot action feedback (the `?flash=` query). Always `None` from
    /// `/api/pads`, `Some` only in the page-render props.
    pub flash: Option<String>,
}

/// What `GET /api/devices` serves AND what the `/devices` island's props
/// carry — the same one-struct-one-serializer rule as [`StatusPayload`],
/// parity pinned in `render_devices.rs`.
///
/// The scan and the reason it is missing are SEPARATE fields on purpose. An
/// empty `DeviceScanView` is a real answer on a machine with nothing plugged
/// in; it is also what a refusal would degrade to if the two were collapsed,
/// and "no boards found" on a machine with four boards is the worst possible
/// lie for this page to tell. [`Self::unavailable`] non-empty means the view
/// below is not a reading of anything.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DevicesPayload {
    pub scan: ksx_api::DeviceScanView,
    /// **What ksx left behind**, from `MachineSource::winusb_residue`. A
    /// SEPARATE read from the scan and deliberately so: the device tree is the
    /// thing that looks healthy while the receipt store disagrees with it, and
    /// a page that only ever read the tree is why nine stale receipts sat
    /// unreported on an affected machine.
    #[serde(default)]
    pub residue: ksx_api::WinusbResidueView,
    /// Session state, for the header pill and for the one caution this page
    /// owes a running cabinet: a `[[device]]` edit lands in `config.toml`, and
    /// the session already running keeps the devices it opened until it is
    /// restarted.
    pub session: crate::control::SessionView,
    /// Empty when the scan answered. Otherwise the refusal, verbatim.
    #[serde(default)]
    pub unavailable: String,
    /// One-shot action feedback (the `?flash=` query). Always `None` from
    /// `/api/devices` — a poll is not an action.
    pub flash: Option<String>,
}

/// The setup page's read: `ksx_api::MachineSource::setup_state`, plus the one
/// fact a bare `Result` cannot carry into a template — WHY there is nothing.
///
/// The same shape, and the same reason, as [`MapperSnapshot::unavailable`]: a
/// provider that refuses must produce a page that SAYS so, not an empty
/// checklist that looks like a machine with nothing configured. Those two
/// states are opposite advice ("import a config" vs "this build has no machine
/// provider") and a blank page gives the wrong one.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupSnapshot {
    /// The machine provider answered.
    pub available: bool,
    /// Where the facts came from, or — with `available` false — why there are
    /// none. Rendered either way.
    pub source: String,
    pub view: ksx_api::SetupView,
}

impl SetupSnapshot {
    pub fn ready(view: ksx_api::SetupView) -> Self {
        Self {
            available: true,
            source: "read from this machine's config root".to_owned(),
            view,
        }
    }

    /// No setup facts; `reason` renders where the checklist would be.
    pub fn unavailable(reason: &str) -> Self {
        Self {
            available: false,
            source: reason.to_owned(),
            view: ksx_api::SetupView::default(),
        }
    }
}

/// **Every `createShow` boolean on `/setup`, decided once, in Rust.**
///
/// Same rule and same reason as [`SetupLines`]: the seam injects these into the
/// SSR paint and `SetupIsland.ts` assigns them straight into its signals, so
/// the learner partition and the "is this readable" gate cannot be true on one
/// side of the seam and false on the other.
///
/// The two flash booleans are deliberately NOT here: a flash is one-shot action
/// feedback the client owns (it clears itself on a timer), so it is not a fact
/// about the machine and a poll must never rewrite it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupFlags {
    pub pill_running: bool,
    pub pill_idle: bool,
    pub pill_down: bool,
    pub no_daemon: bool,
    /// The machine provider REFUSED. Everything that would state a fact about
    /// this machine is gated off by it.
    pub setup_down: bool,
    /// The machine provider answered — the gate every inventory row, every
    /// checklist row and every "nothing here yet" sentence sits behind.
    pub setup_known: bool,
    pub first_run: bool,
    pub configured: bool,
    pub can_wire: bool,
    pub cannot_wire: bool,
    pub prove_down: bool,
    pub prove_listening: bool,
    pub prove_hit: bool,
    pub prove_idle: bool,
    pub has_boards: bool,
    pub no_boards: bool,
    pub has_slots: bool,
    pub no_slots: bool,
    pub has_notes: bool,
}

impl SetupFlags {
    pub fn of(
        setup: &SetupSnapshot,
        session: &crate::control::SessionView,
        learn: &crate::control::LearnView,
    ) -> Self {
        let view = &setup.view;
        let available = setup.available;

        // "Can this page write a slot?" is three facts now: a config we could
        // READ, a daemon to take the write, and a preset for the slot to point
        // at. A menu with no options and a live button is the shape that makes
        // a user think they did something.
        let wireable = available && session.reachable && !view.presets.is_empty();

        let listener_down = !session.reachable || learn.state == "unavailable";
        let listening = !listener_down && learn.state == "listening";
        let hit = !listener_down && learn.state == "hit";

        Self {
            pill_running: session.reachable && session.running,
            pill_idle: session.reachable && !session.running,
            pill_down: !session.reachable,
            no_daemon: !session.reachable,
            setup_down: !available,
            setup_known: available,
            first_run: available && !view.config_exists,
            configured: available && view.config_exists,
            can_wire: wireable,
            cannot_wire: !wireable,
            prove_down: listener_down,
            prove_listening: listening,
            prove_hit: hit,
            prove_idle: !listener_down && !listening && !hit,
            // EVERY one of these is `available &&`. Without it a refused read
            // renders "No board has a name yet" — a claim about a machine
            // nothing was read from.
            has_boards: available && !view.devices.is_empty(),
            no_boards: available && view.devices.is_empty(),
            has_slots: available && !view.slots.is_empty(),
            no_slots: available && view.slots.is_empty(),
            has_notes: available && !view.notes.is_empty(),
        }
    }
}

/// One checklist step as the row the page draws.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupStepRowView {
    /// "1", "2", "3" — the position, as the badge text.
    pub badge: String,
    pub title: String,
    pub detail: String,
    /// `step done` | `step now` | `step later` — presentation of the BACKEND's
    /// state word, composed here so neither language re-derives it.
    pub cls: String,
}

/// A title-over-detail row (the inventory's boards and slots).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupPairRowView {
    pub title: String,
    pub detail: String,
}

/// One `<option>`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupOptionRowView {
    pub value: String,
    pub label: String,
}

/// One plain-text row (presets, profiles, notes).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupTextRowView {
    pub text: String,
}

/// **Every list row `/setup` draws, composed once, in Rust** — the same
/// docs/SURFACES.md §1 rule [`SetupLines`] and [`SetupFlags`] already follow,
/// applied to the row and label formatters.
///
/// These used to live twice: `render_setup.rs::list_values` composed
/// "Slot 3 — Panel P1" for the SSR paint and `SetupIsland.ts` composed it
/// again for the two-second poll. Two copies of a SENTENCE drift silently
/// (the Profiles page's `ProfilesDerived` header tells the longer version of
/// this story); now both seams read these rows verbatim and format nothing.
/// One split-or-freeze answer, on the page that edits a SAVED config.
///
/// The same three answers `/start` asks with, from the same
/// `BlockingOption::roster()` - deliberately not a second wording. What differs
/// is only that here the chosen one is a fact about a file, not about a stage.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupBlockingRowView {
    pub name: String,
    pub title: String,
    pub detail: String,
    pub chosen_cls: String,
    pub button: String,
}

/// One theme choice, current one marked — the blocking-row idiom exactly
/// (member `chosen_cls` + a per-row one-hidden-input POST form), because it
/// is the repo's one established "pick one of N, server decides which is
/// current" widget and it works with scripting switched off.
///
/// Rows come from the GENERATED roster (`theme_tokens::THEMES`) plus the
/// System row, so shipping a new theme never edits TS or this composition.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupThemeRowView {
    /// What the row's form posts: a theme id, or `system`.
    pub value: String,
    pub title: String,
    pub detail: String,
    pub chosen_cls: String,
    pub button: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupRows {
    pub steps: Vec<SetupStepRowView>,
    pub devices: Vec<SetupPairRowView>,
    pub slots: Vec<SetupPairRowView>,
    /// `1..=SetupView::max_slots` — the ceiling the backend serves, never a
    /// literal in either language.
    pub slot_options: Vec<SetupOptionRowView>,
    pub preset_options: Vec<SetupTextRowView>,
    /// Controller identities this build can actually create. The full served
    /// roster remains on [`ksx_api::SetupView::persona_options`] so unavailable
    /// identities are not erased from the contract; this form intentionally
    /// omits them rather than offering a write the daemon must refuse.
    pub persona_options: Vec<SetupOptionRowView>,
    pub profile_options: Vec<SetupTextRowView>,
    pub notes: Vec<SetupTextRowView>,
    /// The split-or-freeze answers, current one marked. Composed here so the
    /// browser never decides which of the three is chosen.
    pub blocking: Vec<SetupBlockingRowView>,
    /// The SOCD `<select>`'s options, served. The blank "leave it as it is"
    /// entry is the FORM's, not a policy, so it is not in here.
    pub socd_options: Vec<SetupOptionRowView>,
    /// The theme choices (System first, then the generated roster), current
    /// one marked. Same rule as blocking: the browser never decides.
    #[serde(default)]
    pub themes: Vec<SetupThemeRowView>,
}

impl SetupRows {
    /// Compose every row for one read. The only implementation.
    pub fn of(setup: &SetupSnapshot) -> Self {
        let view = &setup.view;
        Self {
            steps: view
                .steps
                .iter()
                .enumerate()
                .map(|(i, step)| SetupStepRowView {
                    badge: (i + 1).to_string(),
                    title: step.title.clone(),
                    detail: step.detail.clone(),
                    cls: format!("step {}", step.state),
                })
                .collect(),
            devices: view
                .devices
                .iter()
                .map(|device| SetupPairRowView {
                    title: device.alias.clone(),
                    detail: format!("{} · {}", device.backend, device.id),
                })
                .collect(),
            slots: view
                .slots
                .iter()
                .map(|slot| SetupPairRowView {
                    title: format!("Slot {} — {}", slot.number, slot.preset),
                    // The SOCD is named ONLY when it is doing something.
                    // "off" is the default and the overwhelming majority of
                    // rows, and a detail line that repeated it on every slot
                    // would bury the one row where it matters.
                    detail: if slot.socd.is_empty() || slot.socd == "off" {
                        format!("{} · {} · {}", slot.device, slot.persona, slot.source)
                    } else {
                        format!(
                            "{} · {} · {} · {}",
                            slot.device, slot.persona, slot.socd, slot.source
                        )
                    },
                })
                .collect(),
            slot_options: (1..=view.max_slots)
                .map(|n| SetupOptionRowView {
                    value: n.to_string(),
                    label: format!("Slot {n}"),
                })
                .collect(),
            preset_options: view
                .presets
                .iter()
                .map(|name| SetupTextRowView { text: name.clone() })
                .collect(),
            persona_options: view
                .persona_options
                .iter()
                .filter(|option| option.can_plug)
                .map(|option| SetupOptionRowView {
                    value: option.name.clone(),
                    label: persona_picker_label(option),
                })
                .collect(),
            profile_options: view
                .profiles
                .iter()
                .map(|title| SetupTextRowView {
                    text: title.clone(),
                })
                .collect(),
            notes: view
                .notes
                .iter()
                .map(|note| SetupTextRowView { text: note.clone() })
                .collect(),
            socd_options: view
                .socd_options
                .iter()
                .map(|option| SetupOptionRowView {
                    value: option.name.clone(),
                    label: option.title.clone(),
                })
                .collect(),
            blocking: view
                .blocking_options
                .iter()
                .map(|option| {
                    let chosen = view.blocking == option.name;
                    SetupBlockingRowView {
                        name: option.name.clone(),
                        title: option.title.clone(),
                        detail: option.detail.clone(),
                        chosen_cls: if chosen {
                            "pill pill-ok".to_owned()
                        } else {
                            "pill pill-none".to_owned()
                        },
                        // The chosen row's button says so rather than inviting a
                        // no-op write; the others say what picking them does.
                        button: if chosen {
                            "This is how it is set".to_owned()
                        } else {
                            option.title.clone()
                        },
                    }
                })
                .collect(),
            themes: theme_rows(setup),
        }
    }
}

/// The Studio theme roster, composed once and served by every page that lets
/// someone change it. Extracted from `SetupRows::of` when `/nocturne` grew its
/// own picker: one implementation means the two pages cannot disagree about
/// which theme is marked, which is the whole point of the three-state rule
/// documented inside.
pub fn theme_rows(setup: &SetupSnapshot) -> Vec<SetupThemeRowView> {
    let view = &setup.view;
    // Three states, three honest markings (review-caught: the
    // first cut marked System "in use" even when the config could
    // not be READ — a claim about a file nothing read, on the page
    // whose signature rule is that a refusal renders as one):
    //  - unreadable → NO row marked and every button stays an
    //    action; theme_line carries the refusal sentence.
    //  - unknown id → System IS what renders (the pill is true)
    //    but not what is SET, so the button offers the useful act
    //    — clearing the id — instead of claiming "this is how it
    //    is set" about a config that says otherwise.
    //  - known/empty → the blocking card's marking exactly.
    let known = crate::theme_tokens::THEMES
        .iter()
        .any(|t| t.id == view.theme);
    let readable = setup.available;
    let system_set = readable && view.theme.is_empty();
    let system_fallback = readable && !view.theme.is_empty() && !known;
    let mark = |chosen: bool| {
        if chosen {
            "pill pill-ok".to_owned()
        } else {
            "pill pill-none".to_owned()
        }
    };
    let mut rows = vec![SetupThemeRowView {
        value: "system".to_owned(),
        title: "Match the operating system".to_owned(),
        detail: "Light or dark follows the system setting on the machine \
                         viewing the page."
            .to_owned(),
        chosen_cls: mark(system_set || system_fallback),
        button: if system_set {
            "This is how it is set".to_owned()
        } else if system_fallback {
            "Follow the operating system instead".to_owned()
        } else {
            "Match the operating system".to_owned()
        },
    }];
    rows.extend(crate::theme_tokens::THEMES.iter().map(|meta| {
        let chosen = readable && view.theme == meta.id;
        SetupThemeRowView {
            value: meta.id.to_owned(),
            title: meta.label.to_owned(),
            detail: if meta.scheme == "light" {
                "Every page renders light, whatever the system prefers.".to_owned()
            } else {
                "Every page renders dark, whatever the system prefers.".to_owned()
            },
            chosen_cls: mark(chosen),
            button: if chosen {
                "This is how it is set".to_owned()
            } else {
                meta.label.to_owned()
            },
        }
    }));
    rows
}

// ───────────────────────────────────────────────────────────────────────────
// /start — the first run, moments 4 to 7 (docs/FIRST-RUN.md)
// ───────────────────────────────────────────────────────────────────────────

/// What `GET /api/start` serves AND what the `/start` island's props carry —
/// the same one-struct-one-serializer rule as [`StatusPayload`], parity pinned
/// in `render_start.rs`.
///
/// **Independent reads keep independent failure states.** They are kept apart for the
/// reason `docs/SURFACES.md` §1b gives: a daemon that is down and a machine
/// with no boards are opposite advice, and collapsing either into an empty
/// value is how a page ends up saying "you have staged nothing" when the truth
/// is "nothing answered". [`Self::staged`] carries its own `reachable` +
/// `error`; [`Self::controller_outputs`] carries per-required-backend read
/// state; the other reads carry theirs beside them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartPayload {
    /// The staged setup, from `ControlSource::staged` — the DAEMON's memory,
    /// not a file. Its own `reachable`/`error` fields say when there is none.
    pub staged: ksx_api::StagedSetupView,
    /// The device enumeration, from `MachineSource::device_scan` — the same
    /// read `/devices` renders.
    pub scan: ksx_api::DeviceScanView,
    pub session: crate::control::SessionView,
    /// Output readiness for exactly the supported personas currently staged,
    /// from `MachineSource::controller_outputs`.
    ///
    /// The machine fact this page cannot get from the daemon or device list,
    /// and the one that decides whether moment 7 can happen: a missing backend
    /// required by a staged persona leaves every authoring step functional but
    /// cannot materialize that controller.
    /// Read-only — `docs/SURFACES.md` §3 marks driver installation `never` for
    /// the browser, and this is how a page obeys that rule and still tells the
    /// truth before the button. ViGEmBus is considered only for staged
    /// Xbox/PlayStation personas; HIDMaestro only for staged DualSense. A
    /// refused read preserves those requirements as unknown, and an installed
    /// HIDMaestro package remains `verified-on-play` rather than false green.
    #[serde(default)]
    pub controller_outputs: ksx_api::ControllerOutputsView,
    /// Empty when the scan answered. Otherwise the refusal, verbatim.
    #[serde(default)]
    pub unavailable: String,
    /// The presets ON DISK, from `MachineSource::presets`. Not what the stage
    /// holds — what a save would land next to, which is the only way this page
    /// can say "a preset of that name is already there" before the click.
    #[serde(default)]
    pub presets: Vec<ksx_api::PresetRow>,
    /// Empty when the preset read answered; otherwise the refusal. Separate
    /// from an empty list, because "no presets yet" is a first run and "I could
    /// not read the presets folder" is a broken install.
    #[serde(default)]
    pub presets_error: String,
    /// The selected keyboard's capture preparation, composed from the staged
    /// selector and the current machine inventory.  The two identifiers are
    /// form values, not presentation copy: the card never prints either one,
    /// and the server revalidates both before it asks the machine provider to
    /// do anything privileged.
    #[serde(default)]
    pub capture: StartCaptureView,
    /// **The logon task**, from `MachineSource::autostart` - `None` when the
    /// read refused, which is NOT the same as "not registered" and must not
    /// render as it.
    #[serde(default)]
    pub autostart_read: Option<ksx_api::AutostartView>,
    /// Empty when the logon read answered; otherwise the refusal.
    #[serde(default)]
    pub autostart_error: String,
    /// The logon card, composed from the two above.
    #[serde(default)]
    pub autostart: StartAutostartView,
    /// One-shot action feedback (the `?flash=` query). Always `None` from
    /// `/api/start` — a poll is not an action.
    pub flash: Option<String>,
    /// Backend-owned progress semantics for the persistent four-stage rail.
    /// The browser never infers completion or invents blocker reasons from a
    /// route: these four rows are composed from the same staged/capture/output
    /// facts that gate Save and Play.
    #[serde(default)]
    pub journey: StartJourney,
    /// The page's sentences, composed from the four above. Derived, never
    /// authored — [`StartPayload::composed`] fills it.
    #[serde(default)]
    pub lines: StartLines,
    /// The page's `createShow` booleans, decided from the same four.
    #[serde(default)]
    pub flags: StartFlags,
    /// The page's list rows, same rule again.
    #[serde(default)]
    pub rows: StartRows,
}

/// The scalar-only capture-preparation seam for `/start`.
///
/// This deliberately is not a device row and does not carry a backend field.
/// The browser can confirm the exact selection it was shown, but only the
/// server decides which backend follows an authoritative prepare/release
/// result. `mode` is server-only; the three rendered branches travel through
/// [`StartFlags`] so Forma gets three scalar shows and no new list.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartCaptureView {
    pub expected_selector: String,
    pub instance_id: String,
    #[serde(skip)]
    mode: StartCaptureMode,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum StartCaptureMode {
    #[default]
    None,
    Ready,
    Prepare,
    PrepareOptional,
    Release,
    /// **The machine says prepared; the stage says ordinary Windows path.**
    ///
    /// Reachable the instant a user picks a board ksx is already holding:
    /// `StageEdit::ChooseDevice` always stages `Interception` (the stage is a
    /// pure value and knows nothing about drivers), so choosing an
    /// already-prepared keyboard leaves the two disagreeing.
    ///
    /// It is NOT `Prepare`, which is what this page used to show for it —
    /// "Prepare this keyboard for play" over a keyboard Windows had already
    /// prepared, whose only possible outcome was the provider's
    /// `winusb-already-prepared` refusal telling the user to "use Release",
    /// which the same page then did not draw. That is the 2026-08-11 QA
    /// report, and `docs/FIRST-RUN.md` §6's "a screen reports success while
    /// nothing works" turned inside out: a screen offering the one action that
    /// cannot apply.
    ///
    /// It is not [`Self::Release`] either, because that one counts as READY
    /// and this one must not: a session started on a stage that says
    /// Interception, over an interface that is off the keyboard stack, is the
    /// dead panel this project keeps rediscovering. So it reads as blocked,
    /// says which two facts disagree, and the way out is the held-keyboard
    /// list above it, which releases by identity rather than through the
    /// stage.
    Held,
    Blocked,
}

impl StartCaptureView {
    /// The ONE capture-mode derivation, shared by `/start`'s card and
    /// `/nocturne`'s prepared-for-play control. Extracted rather than copied
    /// when the keyboard backend migrated (2026-08-17): two mode machines
    /// would eventually disagree about the same physical keyboard.
    pub(crate) fn from_parts(
        staged: &ksx_api::StagedSetupView,
        scan: &ksx_api::DeviceScanView,
        scan_read: bool,
    ) -> Self {
        let Some(device) = staged.device.as_ref() else {
            return Self::default();
        };
        if !staged.reachable {
            return Self::default();
        }
        if !scan_read {
            return Self::blocked(device.selector.clone());
        }

        // A selector chosen from the served inventory should name one board.
        // Re-check that invariant instead of taking the first match: a stale
        // or malformed inventory must remove the action, never retarget it.
        let mut matches = scan
            .boards
            .iter()
            .filter(|board| board.selector.as_deref() == Some(device.selector.as_str()));
        let Some(board) = matches.next() else {
            return Self::blocked(device.selector.clone());
        };
        if matches.next().is_some() {
            return Self::blocked(device.selector.clone());
        }
        let Some(instance_id) = board.keyboard.as_ref() else {
            return Self::blocked(device.selector.clone());
        };
        if scan
            .boards
            .iter()
            .flat_map(|candidate| candidate.interfaces.iter())
            .filter(|row| row.instance_id.eq_ignore_ascii_case(instance_id))
            .count()
            != 1
        {
            return Self::blocked(device.selector.clone());
        }

        // These are the two canonical wire spellings accepted by StageEdit.
        // They are server-owned constants; no browser field selects either.
        let backend = device.backend.as_str();
        let interception = "interception";
        let winusb = "winusb";
        let interception_ready = backend == interception
            && scan.interception_available
            && board.interception_eligible
            && board.can_type
            && !board.claimed;
        let mode = if interception_ready && board.winusb_eligible {
            // The optional built-in path must remain reachable even when a
            // shared Interception install happens to make this machine work.
            // It is an option, not a readiness blocker.
            StartCaptureMode::PrepareOptional
        } else if interception_ready {
            StartCaptureMode::Ready
        } else if backend == winusb && board.winusb_eligible && board.claimed {
            StartCaptureMode::Release
        } else if board.claimed {
            // **The machine's answer wins over the stage's.** `claimed` is read
            // from the live device tree; `backend` is what this visit's staged
            // value happens to say. When they disagree the board is still off
            // the keyboard stack, and a card that offered Prepare here would be
            // offering the one action the provider refuses.
            StartCaptureMode::Held
        } else if (backend == interception || backend == winusb) && board.winusb_eligible {
            StartCaptureMode::Prepare
        } else {
            StartCaptureMode::Blocked
        };
        Self {
            expected_selector: device.selector.clone(),
            instance_id: instance_id.clone(),
            mode,
        }
    }

    fn blocked(expected_selector: String) -> Self {
        Self {
            expected_selector,
            mode: StartCaptureMode::Blocked,
            ..Self::default()
        }
    }

    /// The mode as a stable word, for derivations OUTSIDE this module
    /// (`NocturneDerived`) that need the full seven-way answer without the
    /// private enum crossing the boundary.
    pub(crate) fn mode_word(&self) -> &'static str {
        match self.mode {
            StartCaptureMode::None => "none",
            StartCaptureMode::Ready => "ready",
            StartCaptureMode::Prepare => "prepare",
            StartCaptureMode::PrepareOptional => "prepare-optional",
            StartCaptureMode::Release => "release",
            StartCaptureMode::Held => "held",
            StartCaptureMode::Blocked => "blocked",
        }
    }
}

/// **Every sentence `/start` states as a fact, composed once, in Rust.**
///
/// Same rule and same reason as [`SetupLines`]: the SSR paint and the island's
/// poll show identical words because there is one implementation of them. The
/// island assigns these to signals and composes nothing.
///
/// What is deliberately NOT here: the split-or-freeze wording, the escape hatch
/// and the per-session scope. Those are `ksx_api::BlockingOption::roster()`,
/// `ESCAPE_HATCH_LINE` and `BLOCKING_SCOPE_LINE` — `docs/FIRST-RUN.md` §3 is a
/// question about what the CAPTURE THREAD does, so its words belong beside the
/// type that answers it and not on the one screen that currently asks.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartLines {
    /// The keyboard step's heading line — chosen, or what to do about it.
    pub device_line: String,
    /// The chosen board's id, as SMALL PRINT. `FIRST-RUN.md` §5: the path
    /// belongs in small print for support, never as the identifier on screen.
    pub device_detail: String,
    /// `scan.boards_summary`, verbatim — the one line that distinguishes "no
    /// keyboard-capable board" from "nothing could be read".
    pub boards_line: String,
    /// The held-keyboard banner's heading and sentence. Empty when nothing on
    /// this machine is held — the banner is a fact about the DEVICE TREE, so
    /// it appears on a fresh install with no config and no staged setup, which
    /// is the state it exists for.
    #[serde(default)]
    pub prepared_heading: String,
    #[serde(default)]
    pub prepared_line: String,
    /// Customer copy for the scalar capture-preparation card. Exact instance
    /// ids and provider/helper messages never enter these fields.
    pub capture_heading: String,
    pub capture_line: String,
    pub capture_detail: String,
    pub capture_prepare_cls: String,
    pub capture_button_cls: String,
    pub capture_button: String,
    /// The controller step's line: how many are staged and what that costs.
    pub controller_line: String,
    /// The XInput occupancy, from the SERVED numbers.
    pub xinput_line: String,
    /// Where the one question stands: the answer, or that it has not been
    /// asked. Never a pre-selected default — §3.
    pub blocking_line: String,
    /// What the mapper edits and where the staged preset stands relative to
    /// the presets on disk.
    pub preset_line: String,
    /// **What the mapper is, beside the link to it.** The one sentence that
    /// keeps "I mapped it in the mapper" from meaning "Play here will use
    /// that" — see [`MAPPER_LINE`].
    pub mapper_line: String,
    /// Ready to save or play, or a customer-facing next step selected from the
    /// staged facts. Raw domain refusals remain support data.
    pub ready_line: String,
    /// Save and Play have different prerequisites. Save needs a complete
    /// staged setup and capture path; controller output is irrelevant because
    /// saving plugs nothing. Play additionally needs a readable, non-blocked
    /// output view. These separate lines keep a driver problem from making a
    /// valid setup look unsaveable.
    #[serde(default)]
    pub save_status: String,
    #[serde(default)]
    pub play_status: String,
    /// The output banner's heading. What the SENTENCES say is
    /// `ksx_api::ControllerOutputsView`'s and arrives composed; what this page decides is
    /// how to introduce it — "cannot" and "could not be checked" are two
    /// different headings and a page that used one for both would be asserting
    /// the machine's state from a read that failed.
    pub bus_heading: String,
    /// The banner's class: red for a bus that is known not to work, amber for
    /// one nothing could be learned about. Served rather than derived in
    /// TypeScript for the reason every other `_cls` on this page is
    /// (`StartBoardRow::caveat_cls`): the severity is a judgement, and
    /// judgements are the backend's.
    pub bus_cls: String,
    /// What pressing Play actually does — moment 7's first sentence.
    pub play_line: String,
    /// Moment 7's one fact about the pad itself.
    pub guide_line: String,
    /// The always-available way to stop Play, in customer language.
    #[serde(default)]
    pub escape_line: String,
    /// Which keyboards and how long the split/freeze answer affects.
    #[serde(default)]
    pub scope_line: String,
    /// The daemon refusal that makes staging impossible, if any.
    pub stage_error: String,
    /// The scan refusal, if any.
    pub scan_error: String,
    /// The preset-read refusal, if any.
    pub presets_error: String,
}

/// One rail destination. `cls` is presentation state only; `badge` is its
/// glanceable word and `detail` is the full accessible explanation rendered
/// beside the destination for assistive technology.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartJourneyStep {
    pub cls: String,
    pub badge: String,
    pub detail: String,
}

/// Truthful progress for the four-stage setup journey.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartJourney {
    pub keyboard: StartJourneyStep,
    pub controller: StartJourneyStep,
    pub mapping: StartJourneyStep,
    pub play: StartJourneyStep,
}
/// A persona picker says both the public identity and the immutable output
/// route. A per-session ceiling belongs in the option too: it is useful before
/// the first pick, while [`ksx_api::PersonaOption::available`] prevents an impossible
/// later pick from appearing at all.
fn persona_picker_label(option: &ksx_api::PersonaOption) -> String {
    let backend = if option.backend_label.trim().is_empty() {
        option.backend.as_str()
    } else {
        option.backend_label.as_str()
    };
    match option.instance_limit {
        Some(1) => format!("{} · {} · one per session", option.label, backend),
        Some(limit) => format!("{} · {} · up to {limit} per session", option.label, backend),
        None if backend.trim().is_empty() => option.label.clone(),
        None => format!("{} · {}", option.label, backend),
    }
}

/// **Every `createShow` boolean on `/start`, decided once, in Rust.**
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartFlags {
    pub pill_running: bool,
    pub pill_idle: bool,
    pub pill_down: bool,
    /// The staged setup could not be reached — every verb on the page is inert
    /// and the banner says why.
    pub stage_down: bool,
    /// The device scan refused. NOT the same as an empty machine.
    pub scan_down: bool,
    /// The preset read refused.
    pub presets_down: bool,
    /// **A required output needs saying before the Play button.** Known
    /// blockers, unknown reads, and HIDMaestro's Play-time verification are
    /// distinct states. False only when no backend is required or every
    /// required backend is fully preflighted.
    pub bus_warn: bool,
    /// A keyboard is staged.
    pub has_device: bool,
    /// **This machine is holding at least one keyboard the capture card is not
    /// already offering to release.** Read off the device tree, so it is true
    /// on a machine with no config and an empty stage — which is exactly the
    /// state where the only release control used to be unreachable.
    #[serde(default)]
    pub has_prepared: bool,
    /// The three mutually exclusive scalar branches of the capture card.
    pub capture_prepare: bool,
    pub capture_release: bool,
    pub capture_blocked: bool,
    /// Keyboard-shaped boards that can be picked on the ordinary path.
    pub has_boards: bool,
    /// Pickable HID devices that do not identify themselves as keyboards.
    /// These stay available as an explicit playground, never mixed into the
    /// ordinary keyboard list.
    pub has_experimental: bool,
    /// **The enumeration ANSWERED and found no keyboard-capable board.** The
    /// only flag that licenses the "there is nothing here" paragraph; false
    /// whenever the list is empty because nothing could be read.
    pub no_boards: bool,
    /// Boards with no keyboard interface, listed so "why is my device not
    /// here" has an answer.
    pub has_other: bool,
    pub has_notes: bool,
    /// Controllers are staged.
    pub has_slots: bool,
    /// A controller can still be added (a free slot AND a persona to put in
    /// it AND a keyboard to drive it).
    pub can_add: bool,
    /// Every slot is taken — the ceiling, said before the button vanishes.
    pub slots_full: bool,
    /// Personas this build cannot plug, listed with the reason.
    pub has_gaps: bool,
    /// A staged controller can be dressed in a layout — there is one to dress
    /// and a daemon to hold the result.
    pub can_layout: bool,
    /// §3 has been answered.
    pub blocking_answered: bool,
    /// Save and Play deliberately have different gates. Controller-output
    /// readiness affects Play only: committing the staged files is safe and
    /// useful even on a machine whose required driver is missing or unread.
    #[serde(default)]
    pub can_save: bool,
    #[serde(default)]
    pub can_play: bool,
    #[serde(default)]
    pub cannot_save: bool,
    #[serde(default)]
    pub cannot_play: bool,
    /// Compatibility pair for the current island while it migrates to the
    /// split shows. They mirror Save's gate so a driver problem never hides a
    /// valid Save action; the server independently guards Play with `can_play`.
    pub ready: bool,
    pub not_ready: bool,
    /// Anything at all is staged, so "Start over" means something.
    pub can_discard: bool,
    /// A game is already using the current setup, so the page says before the
    /// click that Play replaces it as one serialized action.
    pub session_live: bool,
    pub flash_ok: bool,
    pub flash_error: bool,
}

/// One board a first-run user could pick.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartBoardRow {
    /// **The identifier on screen** — the vendor table's name (`FIRST-RUN.md`
    /// §5).
    pub name: String,
    /// `USB` | `Bluetooth`, as a human reads it.
    pub transport: String,
    /// What can reach it, served by `DeviceScanView::read` — the sentence that
    /// says a Bluetooth keyboard can be split but never WinUSB-claimed.
    pub backends: String,
    /// Its keyboard interface's verdict.
    pub verdict: String,
    /// The honest caveat when nothing on it DECLARES itself a keyboard, else
    /// empty. Rendered on every row and hidden when empty — a `createShow`
    /// inside a `createList` is not a shape this compiler emits.
    pub caveat: String,
    pub caveat_cls: String,
    /// "it is present and cannot type right now", when that applies.
    pub cannot_type: String,
    pub cannot_type_cls: String,
    /// SMALL PRINT: the Windows instance path, for a support conversation.
    /// Never the identifier — §5.
    pub path: String,
    /// What the form posts: the SERVED `DeviceSelector`, and the alias a pick
    /// would write. Neither is derived here and neither is ever typed.
    pub selector: String,
    pub alias: String,
    /// Is this the board already staged?
    pub chosen_cls: String,
    pub button: String,
}

/// **One keyboard ksx is holding, and the form that gives it back.**
///
/// The two identifiers are FORM VALUES, exactly as the capture card's are: the
/// row prints the human name and keeps the instance path in the support
/// details, and the server re-resolves both before it asks the privileged
/// provider for anything (`docs/FIRST-RUN.md` §5 — a user is never asked to
/// read, type or paste a device path).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartPreparedRow {
    /// The vendor table's name — the identifier on screen.
    pub name: String,
    /// `USB` | `Bluetooth`, as a human reads it.
    pub transport: String,
    /// What being held costs, for this row.
    pub detail: String,
    /// SMALL PRINT: the Windows instance path, for a support conversation.
    pub path: String,
    /// The served selector and exact interface the release form posts.
    pub selector: String,
    pub instance_id: String,
    /// Why this row carries no button, when it does not — and it is a
    /// sentence, never a command, because the remedy for the one case that
    /// reaches it is physical (`docs/SURFACES.md` §3a: ksx refuses to guess
    /// between twins; unplug one, then release). Empty when the form is live.
    pub note: String,
    pub note_cls: String,
    /// The form's class: hidden when [`Self::note`] explains why there is no
    /// action. A `createShow` inside a `createList` is not a shape this
    /// compiler emits, so the row hides by class like every other row here.
    pub form_cls: String,
}

/// One board that cannot be picked at all, and why.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartOtherRow {
    pub name: String,
    pub transport: String,
    pub reason: String,
    pub backends: String,
}

/// One staged controller.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartSlotRow {
    /// The form value.
    pub number: String,
    pub title: String,
    /// **Both halves of moment 5 in one line.** `FIRST-RUN.md` §1 says the
    /// controller "appears **ready**", and §2 says nothing has been plugged,
    /// claimed or written — and a row that said only the second reads as a
    /// half-finished thing rather than a decision that has been made.
    pub state: String,
    pub persona: String,
    /// Whether it occupies one of Windows' four XInput slots, as a sentence.
    pub xinput: String,
    /// The preset it binds, and how many controls that is — including zero,
    /// which is a real answer a page should say before a game does.
    pub preset: String,
    pub bindings: String,
    /// Existing mapper, pointed at this in-memory slot rather than a saved
    /// preset. Served so the island never invents routing semantics.
    pub map_href: String,
}

/// One `<option>`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartOptionRow {
    pub value: String,
    pub label: String,
}

/// One in-box layout, as a row somebody reads before choosing it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartLayoutRow {
    pub label: String,
    /// `TemplateRow::detail` — the panel this is for, verbatim from
    /// `ksx_core::templates`. Never paraphrased here.
    pub panel: String,
    /// Which players it dresses, and — for the one that binds nothing — what
    /// choosing it costs. Both in one line, because a `createShow` inside a
    /// `createList` is not a shape this compiler emits.
    pub players: String,
}

/// One persona this build cannot plug, with `Persona::gap()`'s own sentence.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartGapRow {
    pub label: String,
    pub gap: String,
    pub instead: String,
}

/// One answer to §3's question.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartBlockingRow {
    pub name: String,
    pub title: String,
    pub detail: String,
    /// Marks the answer that was actually given. Empty otherwise — no option
    /// is ever pre-marked, which is the whole point of `blocking` being
    /// optional.
    pub chosen_cls: String,
    pub button: String,
}

/// One plain-text row.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartTextRow {
    pub text: String,
}

/// **Every list row `/start` draws, composed once, in Rust.**
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartRows {
    pub boards: Vec<StartBoardRow>,
    /// **Boards ksx is holding, each with its own way back.** Built from
    /// [`held_boards`], so it answers "which keyboards cannot type right now"
    /// from the device tree rather than from the stage or the config.
    #[serde(default)]
    pub prepared: Vec<StartPreparedRow>,
    /// Pickable arbitrary HID interfaces. Kept separate from [`Self::boards`]
    /// so mice, lighting controllers and unusual composite devices remain a
    /// useful opt-in playground without masquerading as ordinary keyboards.
    pub experimental: Vec<StartBoardRow>,
    pub other: Vec<StartOtherRow>,
    pub notes: Vec<StartTextRow>,
    pub slots: Vec<StartSlotRow>,
    /// The personas this build can plug AND this stage can still add, in
    /// `Persona::ALL` order. Nothing here is spelled in TypeScript:
    /// `docs/SURFACES.md` §10 already settled that the full roster is served
    /// with build capability plus stage-specific availability per entry.
    pub personas: Vec<StartOptionRow>,
    /// The ones it cannot, listed rather than hidden — a menu that silently
    /// drops three of eight choices teaches a user the product has five.
    pub gaps: Vec<StartGapRow>,
    pub blocking: Vec<StartBlockingRow>,
    /// The in-box layouts as `<option>`s, **the served default first** — a
    /// `<select>` shows its first option, so this is how "Add a controller"
    /// means "with the arcade chart" without anybody choosing.
    pub layouts: Vec<StartOptionRow>,
    /// The same layouts as readable rows: what panel each one is for, which
    /// sets of player keys it carries, and whether it binds anything at all. A
    /// layout nobody can identify from a list is a layout nobody picks.
    pub layout_details: Vec<StartLayoutRow>,
    /// The staged slot numbers, as the options of "give slot N this layout".
    ///
    /// A second `<select>` rather than a form per row: a `createList` inside a
    /// `createList` is not a shape this compiler emits, and the per-row
    /// alternative would be a layout menu drawn once per staged controller.
    pub slot_numbers: Vec<StartOptionRow>,
}

/// **The logon-task card** - `FIRST-RUN.md`'s last moment, the one that makes
/// moment 7 repeat with nobody present.
///
/// Every sentence is composed here, like the rest of this page: a cabinet that
/// does not come up on its own is not commissioned, and the difference between
/// "off", "on", "on but pointing at a ksx that is gone" and "I could not ask
/// the scheduler" is four different things to say, not one boolean.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartAutostartView {
    /// The scheduler answered. False renders the card DISABLED WITH THE
    /// REASON, never as "off": "off" is a claim about a machine nobody could
    /// read (`SURFACES.md` §1b, the same rule `reachable` follows).
    pub readable: bool,
    /// Why not, when it could not be read.
    pub error: String,
    pub registered: bool,
    /// The state as one sentence.
    pub line: String,
    /// What the button would do, said before it is pressed.
    pub detail: String,
    /// The submit label.
    pub button: String,
    /// What the form posts - the inverse of the current state, except when the
    /// registration is stale, where BOTH the repair and the removal are on.
    pub enable: bool,
    /// Registered, and it will not work.
    pub stale: bool,
    /// Why - composed by the provider, never `Staleness::message`, whose
    /// remedy names a CLI command.
    pub stale_detail: String,
    /// The state is a real scheduler read, but this runtime has no authority
    /// to mutate the durable installed task.
    #[serde(default)]
    pub read_only: bool,
}

impl StartAutostartView {
    fn of(p: &StartPayload) -> Self {
        let Some(view) = p.autostart_read.as_ref() else {
            return Self {
                readable: false,
                error: if p.autostart_error.is_empty() {
                    "Windows could not be asked what happens at sign-in.".to_owned()
                } else {
                    p.autostart_error.clone()
                },
                line: "Whether ksx starts at sign-in could not be read.".to_owned(),
                detail: "This says nothing about whether it is on. Reload the page to ask again."
                    .to_owned(),
                button: "Start ksx when I sign in".to_owned(),
                enable: true,
                ..Self::default()
            };
        };

        let stale = view.stale;
        let stale_detail = view.stale_detail.clone().unwrap_or_default();
        let read_only = view.read_only;
        // A stale registration offers the REPAIR, not the removal: turning it
        // on again rewrites the task to point here, which is the whole fix. An
        // "off" button would leave the cabinet in the state it is already
        // failing in.
        let enable = !view.registered || stale;
        Self {
            readable: true,
            error: String::new(),
            registered: view.registered,
            line: if !view.registered {
                "ksx does not start on its own. After a restart, somebody has to open it before \
                 the controllers work."
                    .to_owned()
            } else if stale {
                "ksx is set to start at sign-in, but the registration is out of date.".to_owned()
            } else {
                "ksx starts by itself when you sign in.".to_owned()
            },
            detail: if read_only {
                view.read_only_detail.clone().unwrap_or_else(|| {
                    "This sign-in state is read-only in the current runtime.".to_owned()
                })
            } else if enable && !view.registered {
                "Turn this on and the cabinet comes up ready on its own - no keyboard, no mouse, \
                 nobody standing at it."
                    .to_owned()
            } else if enable {
                "Turning it on again points it back at this copy of ksx.".to_owned()
            } else {
                "Turning this off means somebody has to open ksx by hand after every restart."
                    .to_owned()
            },
            button: if enable {
                "Start ksx when I sign in".to_owned()
            } else {
                "Stop starting ksx at sign-in".to_owned()
            },
            enable,
            stale,
            stale_detail,
            read_only,
        }
    }
}

/// The right pane's whole content for one selected controller, composed off
/// the SAME machinery the mapper reads (`ksx_api::staged_mapper_slot` + the
/// zone tables in render_map.rs), so the two surfaces cannot describe one
/// binding differently.
struct WorkspaceBinds {
    title: String,
    rows: Vec<WorkspaceBindRow>,
    foot: String,
}

/// One binding-list row of the workspace's right pane: the selected slot's
/// controls in the zone tables' own order, each with the composed strings
/// the Nocturne row anatomy renders and the fields its Clear twin submits.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceBindRow {
    /// Canonical function name — the form field and the row key.
    pub function: String,
    /// "LS ▲", "D-pad ◀", "A" — the mapper's own legend label.
    pub label: String,
    /// "G · H", or the honest "—" for an unbound control.
    pub keys: String,
    /// The row's modifiers as one quiet sentence: "Turbo ~12 Hz · Toggle ·
    /// this key also drives A, B" — empty when the row is plain.
    pub notes: String,
    /// `"wsbind"` (+" unbound"/" shared").
    pub cls: String,
    /// The fan-out sentence ALONE ("this key also drives A · B"), for a
    /// surface that shows turbo/toggle as badges instead of prose.
    pub share_note: String,

    /// "Clear" on a bound row, empty (and therefore hidden) on an unbound
    /// one — the list idiom for a per-row action that is sometimes a no-op.
    pub clear: String,
    /// The slot number the Clear twin submits.
    pub slot: String,
    /// The control's delivered auto-fire rate as the turbo box's prefill
    /// ("12"), or empty for none.
    pub turbo_hz: String,
    /// TOGGLE-HOLD: the control latches (press once holds, press again
    /// releases).
    pub toggle: bool,
}

// The binding-row composer the Nocturne right pane uses. It was written for
// the /workspace shell and outlived it: /nocturne re-dresses these rows.
fn workspace_bind_rows(
    staged: &ksx_api::StagedSetupView,
    selected: Option<&ksx_api::StagedSlotView>,
) -> WorkspaceBinds {
    let empty = |title: &str| WorkspaceBinds {
        title: title.to_owned(),
        rows: Vec::new(),
        foot: String::new(),
    };
    if !staged.reachable {
        return empty("Not readable right now.");
    }
    let Some(slot) = selected else {
        return empty("No controller staged yet.");
    };
    let keyboard = staged
        .device
        .as_ref()
        .map(|device| device.label.as_str())
        .unwrap_or("(none)");
    let Ok(mapper) = ksx_api::staged_mapper_slot(slot, keyboard) else {
        // An older daemon serves no authoring table; the mapper page carries
        // the full explanation, so point there rather than paraphrasing.
        return WorkspaceBinds {
            title: format!("P{} · {}", slot.number, slot.persona_label),
            rows: Vec::new(),
            foot: String::new(),
        };
    };
    let shared = crate::render_map::shared_labels(&mapper);
    let zones = crate::render_map::zones_for(&mapper.persona);
    let rows: Vec<WorkspaceBindRow> = zones
        .iter()
        .zip(&shared)
        .map(|(zone, share)| {
            let keys = crate::render_map::key_tag(&mapper, zone.fn_name);
            let unbound = keys == "—";
            let mut notes: Vec<String> = Vec::new();
            if let Some(effective) = mapper.turbo.get(zone.fn_name) {
                notes.push(format!("Turbo ~{effective} Hz"));
            }
            if mapper.toggle.contains(zone.fn_name) {
                notes.push("Toggle: a press holds until the next press".to_owned());
            }
            // PER-KEY fan-out, subject named — "this key also drives…" could
            // not say WHICH key on a multi-key row. One vocabulary
            // everywhere: keys DRIVE controls (the board's own words).
            let share_note = {
                let mut parts: Vec<String> = Vec::new();
                for key in crate::render_map::keys_of(&mapper, zone.fn_name) {
                    let others: Vec<String> = zones
                        .iter()
                        .filter(|other| other.fn_name != zone.fn_name)
                        .filter(|other| {
                            crate::render_map::keys_of(&mapper, other.fn_name).contains(&key)
                        })
                        .map(|other| {
                            crate::render_map::legend_label_for_persona(&mapper.persona, other)
                        })
                        .collect();
                    if !others.is_empty() {
                        parts.push(format!("{key} also drives {}", others.join(" · ")));
                    }
                }
                parts.join(" — ")
            };
            if !share_note.is_empty() {
                notes.push(share_note.clone());
            }
            let mut cls = String::from("wsbind");
            if unbound {
                cls.push_str(" unbound");
            }
            if !share.is_empty() {
                cls.push_str(" shared");
            }
            WorkspaceBindRow {
                function: zone.fn_name.to_owned(),
                label: crate::render_map::legend_label_for_persona(&mapper.persona, zone),
                keys,
                notes: notes.join(" · "),
                cls,
                share_note,
                clear: if unbound {
                    String::new()
                } else {
                    "Clear".to_owned()
                },
                slot: slot.number.to_string(),
                turbo_hz: mapper
                    .turbo
                    .get(zone.fn_name)
                    .map(|hz| hz.to_string())
                    .unwrap_or_default(),
                toggle: mapper.toggle.contains(zone.fn_name),
            }
        })
        .collect();
    let bound = rows.iter().filter(|row| row.keys != "—").count();
    // A key is SHARED when it drives more than one control — counted once,
    // by inverting the binding table, so a key that merely sits beside a
    // shared one on some row never inflates the number.
    let shared_keys: usize = {
        let mut fanout: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
        for keys in mapper.bindings.values() {
            for key in keys {
                *fanout.entry(key.as_str()).or_default() += 1;
            }
        }
        fanout.values().filter(|count| **count > 1).count()
    };
    let foot = match shared_keys {
        0 => format!("{bound} of {} controls bound.", rows.len()),
        1 => format!("{bound} of {} controls bound · 1 key shared.", rows.len()),
        n => format!(
            "{bound} of {} controls bound · {n} keys shared.",
            rows.len()
        ),
    };
    WorkspaceBinds {
        title: format!(
            "P{} · {} — \"{}\"",
            slot.number, slot.persona_label, slot.preset
        ),
        rows,
        foot,
    }
}

// ═══ /nocturne — THE MIGRATED KEYBOARD SECTION ═════════════════════════════
//
// The first real payload behind the Nocturne route (2026-08-17): the keyboard
// facts ONLY — device pick rows off the live machine scan, the split/freeze
// roster, and the prepared-for-play control composed from the SAME
// [`StartCaptureView`] mode machine `/start`'s card uses. Everything else on
// the page stays the design proof's placeholder until its own migration pass.

/// `/nocturne`'s served facts. Independent reads with independent failure
/// modes, exactly like [`StartPayload`]: a dead daemon must not read as "you
/// have staged nothing" and a refused enumeration must not read as "you have
/// no keyboards".
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct NocturnePayload {
    /// Provenance of every machine/device answer in this payload. Fixtures
    /// must name themselves so manual QA can never confuse synthetic state
    /// with an attached cabinet.
    #[serde(default)]
    pub environment: ksx_api::RuntimeEnvironmentView,
    pub staged: ksx_api::StagedSetupView,
    pub scan: ksx_api::DeviceScanView,
    pub session: crate::control::SessionView,
    /// Empty when the scan answered; otherwise the refusal, verbatim.
    #[serde(default)]
    pub unavailable: String,
    /// The configuration menu's three reads, each with its own honest
    /// degradation: what config.toml holds, the games.toml profiles, and the
    /// sign-in task — `None` plus the error sentence when a read refused.
    #[serde(default)]
    pub setup: Option<ksx_api::SetupView>,
    #[serde(default)]
    pub setup_error: String,
    #[serde(default)]
    pub games: Option<ksx_api::ProfilesView>,
    #[serde(default)]
    pub games_error: String,
    #[serde(default)]
    pub autostart_read: Option<ksx_api::AutostartView>,
    #[serde(default)]
    pub autostart_error: String,
    /// The `?slot=N` the request asked for — SERVER-resolved against the
    /// staged roster (a number the draft does not have falls back to the
    /// first slot), so selection works with no JavaScript and survives a
    /// reload.
    #[serde(default)]
    pub selected: Option<u8>,
    /// The binding filter (`?q=`), server-resolved like the selection.
    #[serde(default)]
    pub q: Option<String>,
    /// Which macro the step editor is open on — a SERVED selection, like
    /// the slot, so the dialog survives a reload and a reader with no
    /// scripting can still open a sequence and read it.
    pub macro_selected: Option<String>,
    /// The undo chip's sentence while the server still holds a removed
    /// controller's resurrection material (`server/nocturne.rs` stash).
    #[serde(default)]
    pub undo_label: Option<String>,
    /// Every sentence and row the page renders, composed once, here.
    #[serde(default)]
    pub view: NocturneDerived,
}

impl NocturnePayload {
    /// Recompose [`view`](Self::view) from this payload's own facts — called
    /// on the way OUT, like every other `composed()`/`derived()` here.
    #[must_use]
    pub fn derived(mut self) -> Self {
        self.view = NocturneDerived::of(&self);
        self
    }

    fn scan_read(&self) -> bool {
        self.unavailable.trim().is_empty()
    }
}

/// One pickable keyboard row: the row IS the `/nocturne/device` form's
/// button, so the three hidden values ride beside the display fields. All
/// three are SERVED — `FIRST-RUN.md` §6 forbids asking anyone to type a
/// device path, and this page has no text input either.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneDeviceRow {
    pub cls: String,
    pub name: String,
    pub meta: String,
    /// `keyboard` | `panel-encoder` | `other`, copied from the backend-owned
    /// [`ksx_api::BoardRole`]. The island uses this value for presentation; it
    /// never identifies an encoder by matching the display name.
    pub role: String,
    pub selector: String,
    pub alias: String,
    pub label: String,
}

/// One board that cannot be picked, and why — kept visible, never hidden:
/// a list that silently drops rows teaches a user the machine has fewer
/// keyboards than it does.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneOtherRow {
    pub name: String,
    pub meta: String,
}

/// One split-or-freeze answer, from `BlockingOption::roster()` — the same
/// words `/start` and `/workspace` ask with, deliberately not a third wording.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneChoiceRow {
    pub name: String,
    pub title: String,
    pub detail: String,
    pub cls: String,
}

/// One staged controller in the rack.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneRackRow {
    pub number: String,
    pub badge: String,
    /// The controller's identity color class: `n-pbadge np1..np16` by
    /// slot number — each of the 16 slots owns a distinct default color
    /// (`--pcs1..16`), user-overridable from the rack's color dot.
    pub badge_cls: String,
    /// The color dot that opens the picker: `n-cdot np{N}`.
    pub dot_cls: String,
    pub name: String,
    pub meta: String,
    pub cls: String,
    /// The selection link (`/nocturne?slot=N`) — served whole, because a
    /// list body must be bare member reads (the compiler contract).
    pub href: String,
    /// The whole slot order with this row swapped one place up/down — one
    /// reorder per click, precomposed server-side (the workspace's rule).
    /// Empty at that end of the order; the handler answers with the honest
    /// at-that-end sentence instead of a write.
    pub up_order: String,
    pub down_order: String,
}

/// One free slot the rack shows as an invitation.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneEmptyRow {
    pub badge: String,
}

/// One persona card in the create form. Unavailable personas stay listed —
/// a menu that silently drops choices teaches a user the product has fewer.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturnePersonaRow {
    pub name: String,
    pub label: String,
    pub api: String,
    pub note: String,
    pub cls: String,
}

/// One `<option>`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneOptionRow {
    pub value: String,
    pub label: String,
}

/// One binding-list row, composed off the SAME machinery the mapper reads
/// (via [`workspace_bind_rows`]) and re-dressed for the Nocturne pane.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneBindRow {
    pub function: String,
    pub label: String,
    pub chip: String,
    pub note: String,
    pub cls: String,
    pub chip_cls: String,
    /// `n-minus` when the chip carries several keys (a pair to choose),
    /// `n-minus none` otherwise — the ⊖ only shows where it can act.
    pub minus_cls: String,
    pub clear_cls: String,
    pub slot: String,
    /// The turbo box's prefill — the delivered rate ("12"), or empty.
    pub turbo: String,
    /// The chip's hover sentence: the RELATION, stated from the game's side
    /// ("Driven by G or H — …"), because the chip lives on a control row.
    pub chip_title: String,

    /// The summary badge — "Toggle · 12/s" / "12/s" / "Toggle", with its
    /// visibility class ("" cannot ride CSS `:empty`: the renderer keeps a
    /// zero-width text node in an empty slot).
    pub badge: String,
    pub badge_cls: String,
    /// The ghost "+" add-a-key chip: hidden on an unbound row, whose main
    /// chip already binds the first key.
    pub add_cls: String,
    /// The Hold|Toggle pill pair, precomposed: exactly one carries `on`.
    pub hold_cls: String,
    pub tog_cls: String,
}

/// One macro of the selected slot's layout, as the right pane's lifecycle
/// row: trigger keys, a step/policy summary, and the enable/disable state.
/// Step EDITING stays on the Controls editor until its own pass; this row
/// says so with a link instead of pretending.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneMacroRow {
    /// The table name — the display label.
    pub name: String,
    /// `macro.<name>` — the binding-table function the learn flow rebinds.
    pub fn_name: String,
    /// Trigger keys joined, or the honest "No trigger key".
    pub chip: String,
    /// The chip's hover sentence — the relation, plus the gesture.
    pub chip_title: String,
    /// The ghost "+" add-a-trigger chip; hidden until one trigger exists.
    pub add_cls: String,
    pub chip_cls: String,
    /// "3 steps · repeats while held · …".
    pub meta: String,
    pub cls: String,
    pub slot: String,
    /// The Controls editor, opened at exactly this macro.
    pub edit_href: String,
    /// The lifecycle pair, precomposed: what the submit does and the wire
    /// value it sends ("yes" enables, empty disables).
    pub toggle_label: String,
    pub toggle_value: String,
}

/// One saved game in the configuration menu — a LOAD row, never a launcher.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneGameRow {
    /// The games.toml profile title — the row's label AND the adopt form's
    /// `profile` value.
    pub title: String,
    /// "2 controllers · ready" / the broken verdict, compact.
    pub meta: String,
    /// `"nm-game"` (+" broken").
    pub cls: String,
    pub ico_cls: String,
    /// The opaque revision served with this row — the stale-screen guard every
    /// edit and delete echoes back, so a second window cannot overwrite a
    /// change it never saw.
    pub revision: String,
    /// The editable facts, served so the edit form opens already filled in
    /// rather than making someone retype what the page is showing them.
    pub path: String,
    pub arguments: String,
    pub slots: String,
    pub preset: String,
}

/// One FREE control in the By-control view's per-group strip: click it,
/// then press (or click) a key — the control-side twin of a free key chip.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneCtlChip {
    /// The mapper's own spelling, for the learn target.
    pub function: String,
    pub label: String,
    pub cls: String,
}

/// One row of the pane's BY-KEY view: a bound key and everything it
/// drives, the relation read from the keyboard's side.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneKeyRow {
    pub key: String,
    /// The controls this key drives, in readable zone labels ("A · RB").
    pub targets: String,
    /// The same controls as canonical fn tokens, space-joined lowercase —
    /// the client's door to the By-control rows.
    pub fns: String,
    /// `n-krow` (+" shared" when the key fans out to several controls).
    pub cls: String,
    /// The selected slot's number, carried so the row's per-key Clear form
    /// twin can name it. Empty on the free-key chips (nothing to clear).
    pub slot: String,
}

/// One chip of the board's color legend: which color speaks for which
/// controller, and the door to muting it on the keys.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneLegendRow {
    pub slot: String,
    pub badge: String,
    /// The persona label, so the chip says who as well as which color.
    pub name: String,
    /// `n-lgd np{N}` — the chip wears the controller's own color.
    pub cls: String,
}

/// One controller for the stage's MULTI-PAD grid: everything the client
/// needs to clone the right master art and dress it for this slot. Pure
/// payload data — no template reads it, so it mints no slots.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturnePadView {
    pub slot: u8,
    /// Opaque staged-controller revision served with this exact row. The
    /// browser returns it unchanged with a bind; it is not presentation data
    /// and must never be reconstructed from the visible preset/persona.
    #[serde(default)]
    pub target_revision: String,
    /// "xbox" | "ps" — which master silhouette the client clones.
    pub family: String,
    /// The slot's preset name — the controller's STABLE identity across
    /// reorders (seats renumber, worksheets travel), which is what the
    /// client keys its identity colors by.
    pub preset: String,
    pub title: String,
    /// Canonical fn → its key chip ("G · H"), for the clone's callouts.
    pub fn_keys: std::collections::BTreeMap<String, String>,
    /// `false` means the provider could not project this slot's direct mapper
    /// table. An empty `fn_keys` is otherwise the valid fact "nothing is
    /// bound", so availability has to travel separately.
    #[serde(default)]
    pub mapping_available: bool,
    #[serde(default)]
    pub mapping_reason: String,
    /// Every controller control in one stable authoring order. Unlike
    /// `fn_keys`, this keeps the exact key vector and the per-control
    /// transforms the canvas needs to edit a connection without reading the
    /// legacy binding pane's DOM. Empty is meaningful only while
    /// `mapping_available` is true; otherwise `mapping_reason` says why no
    /// authoring projection could be made.
    #[serde(default)]
    pub controls: Vec<NocturneControlAuthoring>,
    /// Canonical fn → the persona's readable label ("LS ↑", "△") — the
    /// toast's vocabulary for arming ANY pad's control, not just the
    /// selected one.
    pub fn_names: std::collections::BTreeMap<String, String>,
    /// Timed processors owned by this preset. The canvas renders these as
    /// real key → macro → control chains instead of pretending a trigger
    /// key is a direct controller binding.
    #[serde(default)]
    pub macros: Vec<NocturneMacroFlow>,
    /// `false` means the provider could not answer the macro read. It must not
    /// collapse into an empty macro list: "unknown" and "defines none" are
    /// different authoring facts.
    #[serde(default)]
    pub macro_available: bool,
    #[serde(default)]
    pub macro_reason: String,
}

/// One controller-side endpoint in the canvas authoring graph.
///
/// The identity comes from [`crate::render_map::zones_for`], while binding
/// and transform facts come straight from [`ksx_api::MapperSlot`]. This is a
/// normalized backend projection, not a transcription of whichever rows a
/// surface happens to render.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneControlAuthoring {
    /// Canonical mapper function spelling (`A`, `dpad.up`, `lx.min`).
    pub function: String,
    /// Persona-aware control name (`A`, `△`, `Create`, `LS ←`).
    pub label: String,
    /// Stable machine group slug: face, dpad, shoulders, left-stick,
    /// right-stick, or system.
    pub group: String,
    /// Zero-based position in the complete normalized control sequence.
    pub order: usize,
    /// Exact authored OR-chain, in file order. Empty means unbound.
    pub keys: Vec<String>,
    /// Whether a press latches until the next press.
    pub toggle: bool,
    /// Authored auto-fire rate; absent means ordinary non-turbo behavior.
    pub turbo_hz: Option<u32>,
}

/// The read-only part of one macro needed by the canvas signal graph.
///
/// This is composed from the same staged [`ksx_api::MacroSnapshot`] as the
/// lifecycle rows and step editor. The browser receives presentation-ready
/// step words plus canonical output names; it does not interpret macro files
/// or invent execution semantics of its own.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneMacroFlow {
    pub name: String,
    pub triggers: Vec<String>,
    /// Unique canonical functions touched anywhere in the timeline, in first
    /// appearance order. A neutral-only macro legitimately leaves this empty.
    pub outputs: Vec<NocturneMacroFlowOutput>,
    /// One persona-aware sentence per step ("D-pad ↓", "D-pad ↘", "X").
    pub timeline: Vec<String>,
    pub meta: String,
    pub disabled: bool,
    pub edit_href: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneMacroFlowOutput {
    pub function: String,
    /// One-based step numbers where this output is held. This is what keeps a
    /// sequence from being presented as simultaneous fan-out.
    pub steps: Vec<usize>,
}

fn nocturne_macro_meta(mac: &ksx_api::MacroView) -> String {
    let mut notes = vec![match mac.steps.len() {
        1 => "1 step".to_owned(),
        n => format!("{n} steps"),
    }];
    match mac.repeat.as_str() {
        "while-held" => notes.push("repeats while held".to_owned()),
        "turbo" => notes.push(match (mac.turbo_hz, mac.gap_ms) {
            (Some(hz), _) => format!("turbo {hz} Hz"),
            (_, Some(gap)) => format!("turbo · {gap} ms gap"),
            _ => "turbo".to_owned(),
        }),
        _ => {}
    }
    if mac.on_release == "abort" {
        notes.push("aborts on release".to_owned());
    }
    if mac.disabled {
        notes.push("disabled — keeps every step, never starts".to_owned());
    }
    notes.join(" · ")
}

fn nocturne_macro_outputs(mac: &ksx_api::MacroView) -> Vec<NocturneMacroFlowOutput> {
    let mut positions = std::collections::HashMap::<String, usize>::new();
    let mut outputs: Vec<NocturneMacroFlowOutput> = Vec::new();
    for (step_index, step) in mac.steps.iter().enumerate() {
        for function in &step.hold {
            let normalized = function.to_ascii_lowercase();
            if let Some(index) = positions.get(&normalized).copied() {
                outputs[index].steps.push(step_index + 1);
            } else {
                positions.insert(normalized, outputs.len());
                outputs.push(NocturneMacroFlowOutput {
                    function: function.clone(),
                    steps: vec![step_index + 1],
                });
            }
        }
    }
    outputs
}

/// How many owner bands a keycap can carry before the last one becomes the
/// neutral "and more" mark: four 6px bands is the legible floor at 30px, and
/// no palette is readable past a handful of hues anyway.
const BAND_MAX: usize = 4;

/// The band class prefixes, in paint order (left to right).
const BAND_KEYS: [&str; BAND_MAX] = ["ba", "bb", "bc", "bd"];

/// One keycap on the standard board, dressed with its binding short.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneKeyCell {
    pub cap: String,
    /// The canonical `ksx_core::Key` name — the live feed's `KeyHit.key`
    /// vocabulary, carried as `data-key` so live lighting is a lookup.
    pub key: String,
    pub cls: String,
    pub short: String,
    /// The hover sentence: which controls this key drives, in the persona's
    /// readable zone labels. Empty on an unbound cap.
    pub title: String,
    /// The assistive name (`role="img"` + `aria-label`): the same sentence
    /// on a bound cap, the bare cap otherwise — never empty.
    pub aria: String,
}

/// Every sentence `/nocturne` states as a served fact.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NocturneDerived {
    /// The device kicker's count — "N found", or the honest refusal word.
    pub dev_count: String,
    /// `scan.boards_summary` or the refusal sentence — the one line that
    /// distinguishes "no keyboard-capable board" from "nothing could be read".
    pub dev_note: String,
    /// Recognized physical panel encoders get their own first-run lane even
    /// when keyboard mode makes their capture interface declare as a keyboard.
    pub encoder_count: String,
    pub encoder_head: String,
    /// The keyboard header over the key grid: the STAGED selection's identity.
    pub kb_title: String,
    pub dev_encoders: Vec<NocturneDeviceRow>,
    pub dev_rows: Vec<NocturneDeviceRow>,
    /// Pickable HID devices that do NOT identify themselves as keyboards —
    /// the explicit experimentation playground, never mixed into the
    /// ordinary keyboard list (the same split `/start` draws).
    pub dev_exp: Vec<NocturneDeviceRow>,
    pub dev_other: Vec<NocturneOtherRow>,
    /// The two folds' headers ("… · N") and visibility classes; empty tiers
    /// hide their fold entirely.
    pub exp_head: String,
    pub exp_fold_cls: String,
    pub other_head: String,
    pub other_fold_cls: String,
    pub mode_rows: Vec<NocturneChoiceRow>,
    /// Why the behaviour section has nothing to offer, when it does not —
    /// an empty roster with no sentence is a silent hole, not a state.
    pub mode_note: String,
    /// The prepared-for-play control, composed from [`StartCaptureView`]'s
    /// mode machine. `capd_cls` hides the whole control (`none`) or strips
    /// its action (`noact`); the two dialog shows are exclusive.
    pub cap_line: String,
    pub capd_cls: String,
    pub cap_sw_cls: String,
    pub cap_selector: String,
    pub cap_instance: String,
    pub cap_prepare: bool,
    pub cap_release: bool,
    /// The title bar: real version, the draft's origin + dirty answer, the
    /// backend-owned escape hatch, and the session verbs' visibility.
    pub version: String,
    /// Persistent title-bar provenance. `environment_id` is the stable token;
    /// the label is presentation copy. `environment_cls` distinguishes live,
    /// fixture, and fail-closed unknown providers.
    pub environment_id: String,
    pub environment_label: String,
    pub environment_detail: String,
    pub environment_cls: String,
    pub environment_fixture: bool,
    pub environment_generation: String,
    pub chip_text: String,
    pub save_text: String,
    pub escape_line: String,
    pub play_cls: String,
    pub stop_cls: String,
    /// The title bar's Apply-changes verb: visible only while a session
    /// runs AND the draft is dirty (`stage_apply` — M1b F3's UI).
    pub apply_cls: String,
    /// The rack.
    pub rack_rows: Vec<NocturneRackRow>,
    pub rack_empty: Vec<NocturneEmptyRow>,
    pub rack_caption: String,
    /// The create form: real personas, layouts, SOCD roster, served preset
    /// name, and the lede naming the player and board.
    pub add_lede: String,
    pub add_preset: String,
    pub persona_rows: Vec<NocturnePersonaRow>,
    pub layout_opts: Vec<NocturneOptionRow>,
    pub socd_opts: Vec<NocturneOptionRow>,
    /// The selected slot's opposite-directions editor under the rack:
    /// visibility class, the slot number the form names, its label, and the
    /// served policy roster (its own list — the create dialog's `socd_opts`
    /// already mints a list slot, and one signal cannot feed two lists).
    pub socd_cls: String,
    pub socd_num: String,
    pub socd_lab: String,
    pub socd_edit_opts: Vec<NocturneOptionRow>,
    /// The stage's meta bar and the binding pane, off the first slot.
    pub pad_badge: String,
    /// The meta bar's badge wears the selected slot's ramp shade too.
    pub pad_badge_cls: String,
    pub pad_name: String,
    pub pad_sub: String,
    /// The hidden masters' family classes (`"n-padwrap"` / `"n-padwrap
    /// none"`): with JS the masters are clone templates and the class is
    /// moot, but WITHOUT JS the canvas relaxes into a document and the
    /// served class is what picks which body shows. Exactly one is visible.
    pub pad_xbox_cls: String,
    pub pad_ps_cls: String,
    pub pad_ps5_cls: String,
    pub pad_switchpro_cls: String,
    pub pad_xboxseries_cls: String,
    pub bind_title: String,
    /// The binding list, grouped the way the physical controller is
    /// organised: face cluster, D-pad, shoulders & triggers, each stick,
    /// and the system row. Six served lists because a list body is one
    /// flat template — the group headers live in the island markup, each
    /// with its served "N of M bound" count beside it.
    pub bind_face: Vec<NocturneBindRow>,
    pub bind_dpad: Vec<NocturneBindRow>,
    pub bind_shoulders: Vec<NocturneBindRow>,
    pub bind_lstick: Vec<NocturneBindRow>,
    pub bind_rstick: Vec<NocturneBindRow>,
    pub bind_system: Vec<NocturneBindRow>,
    pub bind_face_n: String,
    pub bind_dpad_n: String,
    pub bind_shoulders_n: String,
    pub bind_lstick_n: String,
    pub bind_rstick_n: String,
    pub bind_system_n: String,
    /// Per-group section classes: `n-bindg empty` when `?q=` hides every
    /// row of a group — the island's sweep mirrors the same rule.
    pub bind_face_cls: String,
    pub bind_dpad_cls: String,
    pub bind_shoulders_cls: String,
    pub bind_lstick_cls: String,
    pub bind_rstick_cls: String,
    pub bind_system_cls: String,
    /// The current slot number for the filter form's hidden field.
    pub slot_val: String,
    /// Hides the six group frames when no slot serves rows; otherwise
    /// carries the selected slot's ramp digit so the dots wear its shade.
    pub bind_g_cls: String,
    /// The board wrapper's class — the ramp digit tints the bound caps.
    pub kb_cls: String,
    /// The rack's undo chip: visible while the server holds a removed
    /// controller, with the sentence naming it.
    pub undo_cls: String,
    pub undo_label: String,
    /// The stage's quiet across-the-room state word ("Running" or empty).
    pub stage_word: String,
    pub bind_foot: String,
    /// The selected slot's macros: lifecycle rows + the honest state line.
    pub macros_head: String,
    pub macro_rows: Vec<NocturneMacroRow>,
    pub macros_note: String,
    /// The keyboard grid, dressed: six rows of the standard board with each
    /// key's binding short, the off-board tray, and the honesty note naming
    /// which controller the shorts describe.
    pub kb_row1: Vec<NocturneKeyCell>,
    pub kb_row2: Vec<NocturneKeyCell>,
    pub kb_row3: Vec<NocturneKeyCell>,
    pub kb_row4: Vec<NocturneKeyCell>,
    pub kb_row5: Vec<NocturneKeyCell>,
    pub kb_row6: Vec<NocturneKeyCell>,
    pub kb_tray: Vec<NocturneKeyCell>,
    /// The BY-KEY view: one row per bound key, keyboard -> controller.
    pub key_rows: Vec<NocturneKeyRow>,
    pub keys_note: String,
    /// The rest of the board's REAL vocabulary, free to bind — in the
    /// keyboard's own geography (main / navigation / numpad).
    pub avail_main: Vec<NocturneKeyRow>,
    pub avail_nav: Vec<NocturneKeyRow>,
    pub avail_num: Vec<NocturneKeyRow>,
    /// The multi-pad grid's controllers (payload data, no slots).
    pub pads: Vec<NocturnePadView>,
    /// The board's color legend, one chip per staged controller.
    pub legend: Vec<NocturneLegendRow>,
    /// The solo button's label — "Only P1", naming the selected controller.
    pub solo_label: String,
    pub avail_main_head: String,
    pub avail_nav_head: String,
    pub avail_num_head: String,
    pub avail_main_cls: String,
    pub avail_nav_cls: String,
    pub avail_num_cls: String,
    /// The By-control strips: each group's FREE controls as chips.
    pub avail_ctl_face: Vec<NocturneCtlChip>,
    pub avail_ctl_dpad: Vec<NocturneCtlChip>,
    pub avail_ctl_shoulders: Vec<NocturneCtlChip>,
    pub avail_ctl_lstick: Vec<NocturneCtlChip>,
    pub avail_ctl_rstick: Vec<NocturneCtlChip>,
    pub avail_ctl_system: Vec<NocturneCtlChip>,
    pub kb_tray_head: String,
    pub kb_tray_cls: String,
    pub kb_note: String,
    /// The legend's key to a STACKED cap, shown only when some key actually
    /// carries more owners than the bands can name.
    pub kb_more_cls: String,
    /// The macro step editor, composed whole (see [`crate::macro_editor`]).
    pub mac: crate::macro_editor::NocturneMacroEditor,
    /// The configuration menu, served: the saved-config row, the load/start-
    /// over affordances, the games list, and the sign-in task's fold.
    pub cfg_line: String,
    pub cfg_meta: String,
    pub cfg_cls: String,
    pub cfg_check: String,
    pub adopt_cls: String,
    pub discard_note: String,
    pub games_head: String,
    pub game_rows: Vec<NocturneGameRow>,
    pub games_note: String,
    pub auto_line: String,
    pub auto_sw_cls: String,
    /// The DIRECTION the autostart form submits ("on" = register, "" =
    /// unregister) — served, never inferred client-side from a stale page.
    pub auto_dir: String,
    pub auto_btn: String,
    pub auto_note: String,
    /// Hides the consent form when the sign-in state could not be read or the
    /// runtime is explicitly read-only — an unknown or unavailable verb is
    /// not offered.
    pub auto_form_cls: String,
    /// The Studio theme roster — same three-state marking `/setup` uses, from
    /// the one shared composer so the two pages cannot disagree. Re-dressed as
    /// choice rows because the blocking picker on this page is the same shape.
    pub theme_rows: Vec<NocturneChoiceRow>,
}

/// Which of the right pane's six controller clusters a mapper function
/// belongs to — the order a hand finds them: face buttons, D-pad,
/// shoulders & triggers, left stick, right stick, system. The rows carry
/// the MAPPER's spelling, which writes the face buttons UPPERCASE while the
/// zone vocabulary is lowercase (the live-echo lesson) — match both.
/// Anything unrecognised lands in the system group rather than disappearing.
/// The six group names, exactly as the island's markup spells them — the
/// server-side filter and the client sweep both match against these.
const NOCTURNE_BIND_GROUP_LABELS: [&str; 6] = [
    "Face buttons",
    "D-pad",
    "Shoulders & triggers",
    "Left stick",
    "Right stick",
    "System",
];

/// Stable canvas vocabulary for the same six physical clusters. These are
/// slugs rather than display copy so a frontend can group controls without
/// inheriting the right pane's headings.
const NOCTURNE_CONTROL_GROUPS: [&str; 6] = [
    "face",
    "dpad",
    "shoulders",
    "left-stick",
    "right-stick",
    "system",
];

/// Which drawn body a seat wears — the ONE rule, read by both the per-slot
/// pad views (what each canvas widget clones) and the no-JS master classes.
///
/// Keyed on the persona rather than on `is_xinput`, because a DualSense is
/// not a DualShock: it has its own shell, its own Create/Options pair and its
/// own touchpad, and drawing it as a PS4 pad is a picture that lies about the
/// device Windows just gained.
///
fn pad_art_family(persona: Option<&str>, slot: Option<&ksx_api::StagedSlotView>) -> &'static str {
    match persona {
        Some("dualsense") => "ps5",
        Some("switchpro") => "switchpro",
        Some("xboxseries") => "xboxseries",
        _ => {
            if slot.is_some_and(|slot| slot.is_xinput) {
                "xbox"
            } else if slot.is_some() {
                "ps"
            } else {
                // An empty roster keeps the neutral Xbox outline as ground.
                "xbox"
            }
        }
    }
}

fn nocturne_bind_group(function: &str) -> usize {
    match function {
        "a" | "b" | "x" | "y" | "A" | "B" | "X" | "Y" => 0,
        f if f.starts_with("dpad.") => 1,
        "lb" | "rb" | "lt" | "rt" => 2,
        "lthumb" => 3,
        f if f.starts_with("lx.") || f.starts_with("ly.") => 3,
        "rthumb" => 4,
        f if f.starts_with("rx.") || f.starts_with("ry.") => 4,
        _ => 5,
    }
}

/// A human-scannable order independent of the art tables' drawing order.
/// The tables remain the source of which controls and persona labels exist;
/// this rank only normalizes those controls into face, D-pad, shoulders,
/// sticks, system for any authoring surface.
fn nocturne_control_rank(function: &str) -> (usize, usize) {
    let group = nocturne_bind_group(function);
    let normalized = function.to_ascii_lowercase();
    let within = match group {
        0 => ["a", "b", "x", "y"]
            .iter()
            .position(|candidate| *candidate == normalized)
            .unwrap_or(usize::MAX),
        1 => ["dpad.up", "dpad.down", "dpad.left", "dpad.right"]
            .iter()
            .position(|candidate| *candidate == normalized)
            .unwrap_or(usize::MAX),
        2 => ["lb", "rb", "lt", "rt"]
            .iter()
            .position(|candidate| *candidate == normalized)
            .unwrap_or(usize::MAX),
        3 => ["lthumb", "ly.max", "ly.min", "lx.min", "lx.max"]
            .iter()
            .position(|candidate| *candidate == normalized)
            .unwrap_or(usize::MAX),
        4 => ["rthumb", "ry.max", "ry.min", "rx.min", "rx.max"]
            .iter()
            .position(|candidate| *candidate == normalized)
            .unwrap_or(usize::MAX),
        _ => ["back", "guide", "start"]
            .iter()
            .position(|candidate| *candidate == normalized)
            .unwrap_or(usize::MAX),
    };
    (group, within)
}

fn nocturne_control_authoring(
    persona: &str,
    mapper: &ksx_api::MapperSlot,
) -> Vec<NocturneControlAuthoring> {
    let mut zones: Vec<_> = crate::render_map::zones_for(persona).iter().collect();
    zones.sort_by_key(|zone| nocturne_control_rank(zone.fn_name));
    zones
        .into_iter()
        .enumerate()
        .map(|(order, zone)| {
            // Face-button casing differs between some mapper providers and
            // the art vocabulary. Read every authored fact case-bridged, but
            // always serialize the zone table's canonical spelling.
            let keys = mapper
                .bindings
                .get(zone.fn_name)
                .or_else(|| {
                    mapper
                        .bindings
                        .iter()
                        .find(|(name, _)| name.eq_ignore_ascii_case(zone.fn_name))
                        .map(|(_, keys)| keys)
                })
                .cloned()
                .unwrap_or_default();
            let toggle = mapper
                .toggle
                .iter()
                .any(|name| name.eq_ignore_ascii_case(zone.fn_name));
            let turbo_hz = mapper.turbo.get(zone.fn_name).copied().or_else(|| {
                mapper
                    .turbo
                    .iter()
                    .find(|(name, _)| name.eq_ignore_ascii_case(zone.fn_name))
                    .map(|(_, rate)| *rate)
            });
            let group = nocturne_bind_group(zone.fn_name);
            NocturneControlAuthoring {
                function: zone.fn_name.to_owned(),
                label: crate::render_map::legend_label_for_persona(persona, zone),
                group: NOCTURNE_CONTROL_GROUPS[group].to_owned(),
                order,
                keys,
                toggle,
                turbo_hz,
            }
        })
        .collect()
}

impl NocturneDerived {
    fn of(p: &NocturnePayload) -> Self {
        let staged = &p.staged;
        let scan_read = p.scan_read();
        let chosen = staged.device.as_ref().map(|d| d.selector.as_str());

        let mut dev_encoders = Vec::new();
        let mut dev_rows = Vec::new();
        let mut dev_exp = Vec::new();
        let mut dev_other = Vec::new();
        if scan_read {
            for b in &p.scan.boards {
                if !b.pickable {
                    dev_other.push(NocturneOtherRow {
                        name: b.name.clone(),
                        meta: format!("{} · {}", b.transport_label, b.backends),
                    });
                    continue;
                }
                let Some(selector) = b.selector.clone() else {
                    dev_other.push(NocturneOtherRow {
                        name: b.name.clone(),
                        meta: b.backends.clone(),
                    });
                    continue;
                };
                let is_chosen = chosen == Some(selector.as_str());
                let verdict = if b.claimed {
                    "Held by ksx"
                } else if b.role == ksx_api::BoardRole::PanelEncoder {
                    // An arcade encoder being reachable through its HID
                    // interface does not prove that any terminal has a usable
                    // key assignment.  The chart read in I-PAC Setup owns that
                    // answer; the device roster must not call an unchecked (or
                    // deliberately cleared) EEPROM chart "ready".
                    "Connected · outputs not checked"
                } else if b.cannot_type_line.trim().is_empty() {
                    "Ready to use"
                } else {
                    "Cannot type right now"
                };
                let row = NocturneDeviceRow {
                    cls: if is_chosen {
                        "n-dev on".to_owned()
                    } else {
                        "n-dev".to_owned()
                    },
                    name: b.name.clone(),
                    meta: format!("{} · {}", b.transport_label, verdict),
                    role: b.role.code().to_owned(),
                    selector,
                    alias: b.alias_hint.clone(),
                    label: b.name.clone(),
                };
                if b.role == ksx_api::BoardRole::PanelEncoder {
                    dev_encoders.push(row);
                } else if b.looks_like_a_keyboard {
                    dev_rows.push(row);
                } else {
                    dev_exp.push(row);
                }
            }
        }
        let exp_head = format!("Not keyboards — experimental · {}", dev_exp.len());
        let exp_fold_cls = if dev_exp.is_empty() {
            "n-devfold none".to_owned()
        } else {
            "n-devfold".to_owned()
        };
        let other_head = format!("Unavailable devices · {}", dev_other.len());
        let other_fold_cls = if dev_other.is_empty() {
            "n-devfold none".to_owned()
        } else {
            "n-devfold".to_owned()
        };

        let encoder_count = if scan_read {
            format!("{} found", dev_encoders.len())
        } else {
            "unavailable".to_owned()
        };
        let encoder_head = "Arcade encoders".to_owned();
        let dev_count = if scan_read {
            format!("{} found", dev_rows.len())
        } else {
            "unavailable".to_owned()
        };
        let dev_note = if scan_read {
            p.scan.boards_summary.clone()
        } else {
            p.unavailable.clone()
        };

        let kb_title = match staged.device.as_ref() {
            _ if !staged.reachable => "The draft could not be read — reopen ksx".to_owned(),
            Some(d) => {
                let transport = p
                    .scan
                    .boards
                    .iter()
                    .find(|b| b.selector.as_deref() == Some(d.selector.as_str()))
                    .map(|b| b.transport_label.as_str())
                    .filter(|t| !t.trim().is_empty());
                match transport {
                    Some(t) => format!("{} · {}", d.label, t),
                    None => d.label.clone(),
                }
            }
            None => "No keyboard selected — pick one on the left".to_owned(),
        };

        let selected_is_panel_encoder = chosen.is_some_and(|selector| {
            dev_encoders
                .iter()
                .any(|row| row.selector.eq_ignore_ascii_case(selector))
        });
        let mode_note = if staged.reachable && selected_is_panel_encoder {
            "Choose how this encoder's Windows key signals behave while Play is running. Hardware assignments stay unchanged."
                .to_owned()
        } else if staged.reachable {
            String::new()
        } else {
            "The draft could not be read, so the capture answer cannot be shown. Reopen ksx."
                .to_owned()
        };
        let current_mode = staged.blocking.as_deref().unwrap_or("");
        let mode_rows = if staged.reachable {
            staged
                .blocking_options
                .iter()
                .map(|option| {
                    let (title, detail) = if selected_is_panel_encoder {
                        match option.name.as_str() {
                            "whole" => (
                                "Dedicated arcade panel".to_owned(),
                                "Capture every I-PAC signal during Play so cabinet buttons never type into Windows or trigger shortcuts."
                                    .to_owned(),
                            ),
                            "bound-keys" => (
                                "Share unused outputs with Windows".to_owned(),
                                "Capture mapped I-PAC signals; outputs that KSX does not use still pass through to Windows."
                                    .to_owned(),
                            ),
                            _ => (
                                "Observe and pass through".to_owned(),
                                "KSX routes mapped outputs while Windows receives those same I-PAC key signals too."
                                    .to_owned(),
                            ),
                        }
                    } else {
                        (option.title.clone(), option.detail.clone())
                    };
                    NocturneChoiceRow {
                    name: option.name.clone(),
                    title,
                    detail,
                    cls: if option.name == current_mode {
                        "n-radio on".to_owned()
                    } else {
                        "n-radio".to_owned()
                    },
                }
                })
                .collect()
        } else {
            Vec::new()
        };

        let cap = StartCaptureView::from_parts(staged, &p.scan, scan_read);
        let mode = cap.mode_word();
        let (cap_prepare, cap_release) = match mode {
            "prepare" | "prepare-optional" => (true, false),
            "release" => (false, true),
            _ => (false, false),
        };
        let cap_line = match mode {
            "none" => String::new(),
            "ready" => {
                "Ready through the shared capture driver — typing normally until Play.".to_owned()
            }
            "prepare-optional" => {
                "Typing normally — the shared driver is ready; preparing the built-in path is \
                 optional."
                    .to_owned()
            }
            "prepare" => {
                "Prepare for play — Windows stops this keyboard's ordinary typing until it is \
                 released here."
                    .to_owned()
            }
            "release" => {
                "Prepared for play — this keyboard will not type until it is released here."
                    .to_owned()
            }
            "held" => "Held by ksx but staged for the ordinary Windows path — release it from the \
                 held-keyboards list on the Start screen."
                .to_owned(),
            _ => "This keyboard is not ready for capture right now.".to_owned(),
        };
        let capd_cls = match mode {
            "none" => "n-capd none".to_owned(),
            "prepare" | "prepare-optional" | "release" => "n-capd".to_owned(),
            _ => "n-capd noact".to_owned(),
        };
        let cap_sw_cls = if mode == "release" {
            "n-capsw on".to_owned()
        } else {
            "n-capsw".to_owned()
        };

        let version = format!("v{}", env!("CARGO_PKG_VERSION"));
        let environment_id = p.environment.id.clone();
        let environment_label = p.environment.label.clone();
        let environment_detail = p.environment.detail.clone();
        let environment_cls = if p.environment.fixture {
            "n-environment fixture"
        } else if p.environment.id == "live-machine" {
            "n-environment live"
        } else {
            "n-environment unknown"
        }
        .to_owned();
        let environment_fixture = p.environment.fixture;
        let environment_generation = p.environment.generation.clone();
        let chip_text = if !staged.reachable {
            "Draft unavailable".to_owned()
        } else if staged.origin == "config" {
            "Saved configuration".to_owned()
        } else {
            "New draft".to_owned()
        };
        let save_text = if !staged.reachable {
            String::new()
        } else if staged.dirty {
            "Unsaved changes".to_owned()
        } else {
            "Saved".to_owned()
        };
        let escape_line = ksx_api::stage::ESCAPE_HATCH_LINE.to_owned();
        let running = p.session.reachable && p.session.running;
        let play_cls = if running { "n-play none" } else { "n-play" }.to_owned();
        let stop_cls = if running { "n-stop" } else { "n-stop none" }.to_owned();
        // Apply-in-place is offered exactly when it can mean something: a
        // session is running AND the draft has unsaved edits to hand it.
        let apply_cls = if running && staged.dirty {
            "n-apply".to_owned()
        } else {
            "n-apply none".to_owned()
        };

        // The selected slot: the `?slot=N` the request asked for when the
        // draft still has it, else the first — resolved HERE so every pane
        // (rack mark, binding rows, board shorts, stage family) follows one
        // answer.
        let selected = p
            .selected
            .and_then(|number| staged.slots.iter().find(|slot| slot.number == number))
            .or_else(|| staged.slots.first());
        let selected_number = selected.map(|slot| slot.number);
        let rack_order: Vec<u8> = staged.slots.iter().map(|slot| slot.number).collect();
        let rack_swapped = |a: usize, b: usize| -> String {
            let mut next = rack_order.clone();
            next.swap(a, b);
            next.iter().map(u8::to_string).collect::<Vec<_>>().join(" ")
        };
        let rack_rows: Vec<NocturneRackRow> = if staged.reachable {
            staged
                .slots
                .iter()
                .enumerate()
                .map(|(at, slot)| NocturneRackRow {
                    number: slot.number.to_string(),
                    badge: format!("P{}", slot.number),
                    badge_cls: format!("n-pbadge np{}", slot.number),
                    dot_cls: format!("n-cdot np{}", slot.number),
                    name: slot.persona_label.clone(),
                    // The quoted name is the PRESET, not the seat: a
                    // reorder renumbers P{n} but the worksheet travels with
                    // its controller — the label keeps that readable.
                    meta: format!(
                        "\"{}\" preset · {} bound · SOCD {}",
                        slot.preset, slot.bindings, slot.socd_label
                    ),
                    cls: if selected_number == Some(slot.number) {
                        "n-slot on".to_owned()
                    } else {
                        "n-slot".to_owned()
                    },
                    href: format!("/nocturne?slot={}", slot.number),
                    up_order: if at == 0 {
                        String::new()
                    } else {
                        rack_swapped(at - 1, at)
                    },
                    down_order: if at + 1 == rack_order.len() {
                        String::new()
                    } else {
                        rack_swapped(at, at + 1)
                    },
                })
                .collect()
        } else {
            Vec::new()
        };
        let rack_empty: Vec<NocturneEmptyRow> = if !staged.reachable {
            Vec::new()
        } else {
            match staged.next_slot {
                None => Vec::new(),
                Some(next) => {
                    // Fill the rack to four visible rows the way the design
                    // does; past four, one invitation for the next slot.
                    let upto = if staged.slots.len() < 4 {
                        (u8::try_from(staged.slots.len()).unwrap_or(u8::MAX) + 1)..=4
                    } else {
                        next..=next
                    };
                    upto.map(|n| NocturneEmptyRow {
                        badge: format!("P{n}"),
                    })
                    .collect()
                }
            }
        };
        let rack_caption = if staged.reachable {
            format!(
                "{}/{} XInput · {}/{} slots",
                staged.xinput_used,
                staged.max_xinput_slots,
                staged.slots.len(),
                staged.max_slots
            )
        } else {
            String::new()
        };

        let add_lede = match (staged.next_slot, staged.device.as_ref()) {
            (Some(next), Some(device)) => {
                format!("Games will see Player {next}, driven by {}.", device.label)
            }
            (Some(next), None) => {
                format!("Games will see Player {next}, driven by the selected keyboard.")
            }
            (None, _) => "Every controller slot is staged. Remove one to add another.".to_owned(),
        };
        let add_preset = staged.next_preset.clone().unwrap_or_default();
        let persona_rows: Vec<NocturnePersonaRow> = staged
            .personas
            .iter()
            .map(|persona| {
                let usable = persona.can_plug && persona.available;
                NocturnePersonaRow {
                    name: persona.name.clone(),
                    label: persona.label.clone(),
                    api: if persona.is_xinput {
                        format!("{} · XInput", persona.backend_label)
                    } else {
                        persona.backend_label.clone()
                    },
                    note: persona
                        .unavailable_reason
                        .clone()
                        .or_else(|| persona.gap.clone())
                        .unwrap_or_default(),
                    cls: if usable {
                        "nd-card sel".to_owned()
                    } else {
                        "nd-card off".to_owned()
                    },
                }
            })
            .collect();
        // A daemon built before a roster field serves it EMPTY (serde
        // default) — and an empty `<select>` renders as a dead blank box.
        // Degrade honestly: one option that says why, whose empty value the
        // add handler skips, so the daemon's own default applies.
        let layout_opts: Vec<NocturneOptionRow> = if staged.reachable && staged.layouts.is_empty() {
            vec![NocturneOptionRow {
                value: String::new(),
                label: "Empty worksheet — this ksx build serves no starting layouts".to_owned(),
            }]
        } else {
            staged
                .layouts
                .iter()
                .map(|layout| NocturneOptionRow {
                    value: layout.id.clone(),
                    label: layout.label.clone(),
                })
                .collect()
        };
        let socd_opts: Vec<NocturneOptionRow> =
            if staged.reachable && staged.socd_options.is_empty() {
                vec![NocturneOptionRow {
                    value: String::new(),
                    label: "Daemon default — update ksx to choose a policy".to_owned(),
                }]
            } else {
                staged
                    .socd_options
                    .iter()
                    .map(|option| NocturneOptionRow {
                        value: option.name.clone(),
                        label: option.title.clone(),
                    })
                    .collect()
            };
        // The selected slot's opposite-directions editor, under the rack.
        // Hidden when nothing is staged — and when the daemon serves no
        // policy roster, because a select of names the engine never listed
        // would be an invented value.
        let socd_editable =
            staged.reachable && selected.is_some() && !staged.socd_options.is_empty();
        let socd_cls = if socd_editable {
            "n-socdform".to_owned()
        } else {
            "n-socdform none".to_owned()
        };
        let socd_num = if socd_editable {
            selected_number.map(|n| n.to_string()).unwrap_or_default()
        } else {
            String::new()
        };
        let socd_lab = if socd_editable {
            selected
                .map(|slot| format!("Opposites — P{}", slot.number))
                .unwrap_or_default()
        } else {
            String::new()
        };
        let socd_edit_opts: Vec<NocturneOptionRow> = if socd_editable {
            staged
                .socd_options
                .iter()
                .map(|option| NocturneOptionRow {
                    value: option.name.clone(),
                    label: option.title.clone(),
                })
                .collect()
        } else {
            Vec::new()
        };

        // The selected slot's ramp digit, worn by every surface that speaks
        // for it: the meta badge, the board's bound-cap tint, and the
        // binding pane's dots.
        let ramp = selected.map(|slot| slot.number);
        let pad_badge_cls = match ramp {
            Some(digit) => format!("n-pbadge np{digit}"),
            None => "n-pbadge".to_owned(),
        };
        let kb_cls = match ramp {
            Some(digit) => format!("n-kb np{digit}"),
            None => "n-kb".to_owned(),
        };
        let slot_val = selected_number.map(|n| n.to_string()).unwrap_or_default();
        let (undo_cls, undo_label) = match p.undo_label.as_ref() {
            Some(label) => ("n-undochip".to_owned(), label.clone()),
            None => ("n-undochip none".to_owned(), String::new()),
        };
        // The quiet across-the-room state word inside the stage — from the
        // polled session, never invented.
        let stage_word = if running {
            "Running".to_owned()
        } else {
            String::new()
        };
        let (pad_badge, pad_name, pad_sub) = match selected {
            Some(slot) => (
                format!("P{}", slot.number),
                slot.persona_label.clone(),
                format!("\"{}\" preset · SOCD {}", slot.preset, slot.socd_label),
            ),
            None => (String::new(), String::new(), String::new()),
        };
        // Which vendored silhouette the no-JS page draws — the selected
        // slot's OWN family (the workspace's `pad_ps` rule), so a
        // PlayStation draft is a DualShock on screen, not an Xbox with
        // relabelled pills. An empty roster keeps the neutral Xbox outline
        // as its ground. (With JS the masters are display:none clone
        // templates and every staged pad is its own canvas widget.)
        // ⚠️Keyed on the PERSONA, not on `is_xinput`: a DualSense has its
        // own body, and drawing every non-XInput seat as a DualShock is how
        // modern controllers ended up wearing another generation's art.
        let pad_family = pad_art_family(selected.map(|slot| slot.persona.as_str()), selected);
        let wrap_cls = |family: &str| {
            if pad_family == family {
                "n-padwrap".to_owned()
            } else {
                "n-padwrap none".to_owned()
            }
        };
        let pad_xbox_cls = wrap_cls("xbox");
        let pad_ps_cls = wrap_cls("ps");
        let pad_ps5_cls = wrap_cls("ps5");
        let pad_switchpro_cls = wrap_cls("switchpro");
        let pad_xboxseries_cls = wrap_cls("xboxseries");
        // The keyboard grid: the SAME mapper table the binding pane reads,
        // inverted key→functions, painted onto the standard-board layout.
        let keyboard_name = staged
            .device
            .as_ref()
            .map(|device| device.label.as_str())
            .unwrap_or("(none)");
        let mapper =
            selected.and_then(|slot| ksx_api::staged_mapper_slot(slot, keyboard_name).ok());
        // ⚠️ A MACRO TRIGGER IS A BINDING TOO. `MapperSlot.bindings` is built
        // from the preset's CONTROL entries only — a macro trigger lives in a
        // separate table with no `Binding` variant — so every inversion built
        // on it alone was blind to them: the key that starts a macro painted
        // UNBOUND on the board, and "add another trigger key" appended to a
        // list it could not see, which is a replace.
        let trigger_keys = |slot: &ksx_api::StagedSlotView| -> Vec<(String, Vec<String>)> {
            ksx_api::staged_macro_snapshot(slot)
                .macros
                .into_iter()
                .filter(|m| !m.triggers.is_empty())
                .map(|m| (format!("macro.{}", m.name), m.triggers))
                .collect()
        };
        let selected_triggers: Vec<(String, Vec<String>)> =
            selected.map(trigger_keys).unwrap_or_default();
        let mut key_fns: std::collections::BTreeMap<&str, Vec<&str>> =
            std::collections::BTreeMap::new();
        if let Some(mapper) = mapper.as_ref() {
            for (fn_name, keys) in &mapper.bindings {
                for key in keys {
                    key_fns
                        .entry(key.as_str())
                        .or_default()
                        .push(fn_name.as_str());
                }
            }
        }
        for (fn_name, keys) in &selected_triggers {
            for key in keys {
                key_fns
                    .entry(key.as_str())
                    .or_default()
                    .push(fn_name.as_str());
            }
        }
        // The GLOBAL ownership read: which controllers each key drives,
        // across EVERY staged slot — the board's color strips wear it.
        let mut key_slots: std::collections::BTreeMap<String, Vec<u8>> =
            std::collections::BTreeMap::new();
        for slot in &staged.slots {
            let mut own = |key: &String| {
                let owners = key_slots.entry(key.clone()).or_default();
                if !owners.contains(&slot.number) {
                    owners.push(slot.number);
                }
            };
            if let Ok(m) = ksx_api::staged_mapper_slot(slot, keyboard_name) {
                for keys in m.bindings.values() {
                    for key in keys {
                        own(key);
                    }
                }
            }
            // …and the keys that START a macro on this controller.
            for (_, keys) in trigger_keys(slot) {
                for key in &keys {
                    own(key);
                }
            }
        }
        // OWNERSHIP IS THE CAP'S FILL. Every key that some controller drives
        // paints that controller's color; a key several controllers share
        // splits into one band each, ALWAYS in slot order. The order is
        // stable on purpose: a key P1 and P2 share reads blue|coral whoever
        // you are editing, so the stripe itself tells you who is on it and
        // the map never rearranges under you. (Which of them is YOURS is
        // the ring's job — see `--mine` in the sheet.) Four bands is the
        // honest ceiling at 30px; past it the cap stops naming owners
        // altogether and becomes a STACK.
        let bands = |owners: &[u8]| -> String {
            if owners.is_empty() {
                return String::new();
            }
            if owners.len() > BAND_MAX {
                // THE STACK. Three colors out of eight would be an arbitrary
                // three, and a band plus a separate "+N" makes you add two
                // marks that stand for the same controllers. So past four the
                // face becomes one woven texture that names NOBODY, and the
                // cap carries the TOTAL: nothing to add, nothing to guess.
                // (Every owner is still named in the cap's own sentence, and
                // the ring still says whether one of them is yours.)
                return format!(" bstack bcount{}", owners.len());
            }
            let mut order: Vec<u8> = owners.to_vec();
            order.sort_unstable();
            let mut cls = format!(" bn{}", order.len());
            for (at, slot) in order.iter().enumerate() {
                cls.push_str(&format!(" {}{slot}", BAND_KEYS[at]));
            }
            cls
        };
        // Does any key carry more owners than the bands can name? Then the
        // legend explains the stacked cap in words, beside the colors it
        // stands in for — a mark nothing names is a mark you have to guess.
        let kb_more_cls = if key_slots.values().any(|owners| owners.len() > BAND_MAX) {
            "n-lgdmore".to_owned()
        } else {
            "n-lgdmore none".to_owned()
        };
        // The board's legend: every staged controller with its color, so
        // "which color is who" is answerable without the left pane, and
        // each chip is the door to muting that player on the keys.
        let legend: Vec<NocturneLegendRow> = staged
            .slots
            .iter()
            .map(|slot| NocturneLegendRow {
                slot: slot.number.to_string(),
                badge: format!("P{}", slot.number),
                name: slot.persona_label.clone(),
                // The selected controller's chip is marked, so "only this
                // one" can cross out every OTHER chip without the browser
                // having to work out which is which.
                cls: if selected_number == Some(slot.number) {
                    format!("n-lgd np{} on", slot.number)
                } else {
                    format!("n-lgd np{}", slot.number)
                },
            })
            .collect();
        let solo_label = match selected_number {
            Some(number) => format!("Only P{number}"),
            None => "Only this player".to_owned(),
        };
        // The multi-pad grid's data: every staged controller, its family,
        // its callout chips and its readable control names.
        let pads: Vec<NocturnePadView> = staged
            .slots
            .iter()
            .map(|slot| {
                let mut fn_keys = std::collections::BTreeMap::new();
                let mut mapping_available = true;
                let mut mapping_reason = String::new();
                let mapper = match ksx_api::staged_mapper_slot(slot, keyboard_name) {
                    Ok(mapper) => Some(mapper),
                    Err(refusal) => {
                        mapping_available = false;
                        mapping_reason = refusal.message;
                        None
                    }
                };
                if let Some(m) = mapper.as_ref() {
                    for (fn_name, keys) in &m.bindings {
                        if !keys.is_empty() {
                            fn_keys.insert(fn_name.clone(), keys.join(" · "));
                        }
                    }
                }
                let controls = mapper
                    .as_ref()
                    .map(|mapper| nocturne_control_authoring(&slot.persona, mapper))
                    .unwrap_or_default();
                let fn_names = crate::render_map::zones_for(&slot.persona)
                    .iter()
                    .map(|zone| {
                        (
                            zone.fn_name.to_owned(),
                            crate::render_map::legend_label_for_persona(&slot.persona, zone),
                        )
                    })
                    .collect();
                let macro_snapshot = ksx_api::staged_macro_snapshot(slot);
                let macros = macro_snapshot
                    .macros
                    .iter()
                    .map(|mac| NocturneMacroFlow {
                        name: mac.name.clone(),
                        triggers: mac.triggers.clone(),
                        outputs: nocturne_macro_outputs(mac),
                        timeline: mac
                            .steps
                            .iter()
                            .map(|step| {
                                crate::render_map::hold_text_for_persona(&slot.persona, &step.hold)
                            })
                            .collect(),
                        meta: nocturne_macro_meta(mac),
                        disabled: mac.disabled,
                        edit_href: format!(
                            "/nocturne?slot={}&macro={}",
                            slot.number,
                            crate::render_map::urlencode_value(&mac.name)
                        ),
                    })
                    .collect();
                NocturnePadView {
                    slot: slot.number,
                    target_revision: slot.target_revision.clone(),
                    family: pad_art_family(Some(slot.persona.as_str()), Some(slot)).to_owned(),
                    preset: slot.preset.clone(),
                    title: format!("{} — \"{}\" preset", slot.persona_label, slot.preset),
                    fn_keys,
                    mapping_available,
                    mapping_reason,
                    controls,
                    fn_names,
                    macros,
                    macro_available: macro_snapshot.available,
                    macro_reason: macro_snapshot.reason,
                }
            })
            .collect();
        let persona = selected
            .map(|slot| slot.persona.as_str())
            .unwrap_or("xbox360");
        // The READABLE control names for hover/assistive sentences — the
        // zone tables' own labels ("LS ↑", "D-pad ←", "△"), looked up
        // case-bridged because the mapper spells face functions UPPERCASE.
        let zone_labels: std::collections::HashMap<String, String> =
            crate::render_map::zones_for(persona)
                .iter()
                .map(|zone| {
                    (
                        zone.fn_name.to_ascii_lowercase(),
                        crate::render_map::legend_label_for_persona(persona, zone),
                    )
                })
                .collect();
        let readable = |f: &str| -> String {
            if let Some(name) = f.strip_prefix("macro.") {
                format!("macro \"{name}\"")
            } else {
                zone_labels
                    .get(&f.to_ascii_lowercase())
                    .cloned()
                    .unwrap_or_else(|| f.to_owned())
            }
        };
        let drives_whom = selected
            .map(|slot| format!(" on P{}", slot.number))
            .unwrap_or_default();
        let dress = |cell: &crate::keyboard_layout::KeyCell| {
            let mut cls = String::from("n-key");
            if !cell.unit.is_empty() {
                cls.push(' ');
                cls.push_str(cell.unit);
            }
            if cell.sp {
                cls.push_str(" sp");
            }
            if cell.ghost {
                cls.push_str(" ghost");
            }
            let fns = key_fns.get(cell.key).filter(|fns| !fns.is_empty());
            let (short, title) = match fns {
                Some(fns) => {
                    cls.push_str(" bound");
                    if fns.len() > 1 {
                        cls.push_str(" shared");
                    }
                    let short = crate::keyboard_layout::short_for(persona, fns[0]);
                    let spoken: Vec<String> = fns.iter().map(|f| readable(f)).collect();
                    (
                        short,
                        format!("{} — drives {}{drives_whom}", cell.cap, spoken.join(" · ")),
                    )
                }
                None => (String::new(), String::new()),
            };
            let owners = key_slots.get(cell.key).map(|v| v.as_slice()).unwrap_or(&[]);
            let others: Vec<String> = owners
                .iter()
                .filter(|n| Some(**n) != selected_number)
                .map(|n| format!("P{n}"))
                .collect();
            let title = if !others.is_empty() {
                if title.is_empty() {
                    format!("{} — bound on {}", cell.cap, others.join(" · "))
                } else {
                    format!("{title}; also bound on {}", others.join(" · "))
                }
            } else {
                title
            };
            let aria = if title.is_empty() {
                cell.cap.to_owned()
            } else {
                title.clone()
            };
            cls.push_str(&bands(owners));
            NocturneKeyCell {
                cap: cell.cap.to_owned(),
                key: cell.key.to_owned(),
                cls,
                short,
                title,
                aria,
            }
        };
        let kb_rows: Vec<Vec<NocturneKeyCell>> = crate::keyboard_layout::ROWS
            .iter()
            .map(|row| row.iter().map(dress).collect())
            .collect();
        let mut kb_rows = kb_rows.into_iter();
        let kb_row1 = kb_rows.next().unwrap_or_default();
        let kb_row2 = kb_rows.next().unwrap_or_default();
        let kb_row3 = kb_rows.next().unwrap_or_default();
        let kb_row4 = kb_rows.next().unwrap_or_default();
        let kb_row5 = kb_rows.next().unwrap_or_default();
        let kb_row6 = kb_rows.next().unwrap_or_default();
        // Off-board keys: bound in the table but not on the standard board.
        let board_keys: std::collections::BTreeSet<&str> = crate::keyboard_layout::ROWS
            .iter()
            .flat_map(|row| row.iter())
            .filter(|cell| !cell.key.is_empty())
            .map(|cell| cell.key)
            .collect();
        let kb_tray: Vec<NocturneKeyCell> = key_fns
            .iter()
            .filter(|(key, _)| !board_keys.contains(*key))
            .map(|(key, fns)| {
                let tray_owners = key_slots.get(*key).map(|v| v.as_slice()).unwrap_or(&[]);
                let spoken: Vec<String> = fns.iter().map(|f| readable(f)).collect();
                let title = format!("{key} — drives {}{drives_whom}", spoken.join(" · "));
                // The board's cells name the other owners; so does the tray.
                let others: Vec<String> = tray_owners
                    .iter()
                    .filter(|n| Some(**n) != selected_number)
                    .map(|n| format!("P{n}"))
                    .collect();
                let title = if others.is_empty() {
                    title
                } else {
                    format!("{title}; also bound on {}", others.join(" · "))
                };
                NocturneKeyCell {
                    cap: (*key).to_owned(),
                    key: (*key).to_owned(),
                    cls: {
                        let mut cls = if fns.len() > 1 {
                            "n-key tray bound shared".to_owned()
                        } else {
                            "n-key tray bound".to_owned()
                        };
                        cls.push_str(&bands(tray_owners));
                        cls
                    },
                    short: crate::keyboard_layout::short_for(persona, fns[0]),
                    aria: title.clone(),
                    title,
                }
            })
            .collect();
        // The BY-KEY view's rows: the same inversion the board reads,
        // alphabetical (BTreeMap order), each key with its whole fan-out.
        let key_rows: Vec<NocturneKeyRow> = key_fns
            .iter()
            .map(|(key, fns)| NocturneKeyRow {
                key: (*key).to_owned(),
                targets: fns
                    .iter()
                    .map(|f| readable(f))
                    .collect::<Vec<_>>()
                    .join(" · "),
                fns: fns
                    .iter()
                    .map(|f| f.to_lowercase())
                    .collect::<Vec<_>>()
                    .join(" "),
                cls: if fns.len() > 1 {
                    "n-krow shared".to_owned()
                } else {
                    "n-krow".to_owned()
                },
                slot: selected_number.map(|n| n.to_string()).unwrap_or_default(),
            })
            .collect();
        // Every key on the standard board NOT yet bound — the REAL roster
        // (the board table is unit-pinned against `ksx_core::Key`), served
        // so the By-key view can offer what is still free.
        // The free keys, in the keyboard's own geography: main block,
        // navigation cluster, numpad — classified by canonical name.
        const NAV_KEYS: [&str; 13] = [
            "Insert",
            "Delete",
            "Home",
            "End",
            "PageUp",
            "PageDown",
            "Up",
            "Down",
            "Left",
            "Right",
            "PrintScreen",
            "ScrollLock",
            "Pause",
        ];
        let mut avail_main: Vec<NocturneKeyRow> = Vec::new();
        let mut avail_nav: Vec<NocturneKeyRow> = Vec::new();
        let mut avail_num: Vec<NocturneKeyRow> = Vec::new();
        if selected.is_some() {
            for cell in crate::keyboard_layout::ROWS
                .iter()
                .flat_map(|row| row.iter())
            {
                if cell.ghost || cell.key.is_empty() || key_fns.contains_key(cell.key) {
                    continue;
                }
                let chip = NocturneKeyRow {
                    key: cell.key.to_owned(),
                    targets: String::new(),
                    fns: String::new(),
                    cls: "n-akey".to_owned(),
                    slot: String::new(),
                };
                if cell.key.starts_with("Numpad") || cell.key == "NumLock" {
                    avail_num.push(chip);
                } else if NAV_KEYS.contains(&cell.key) {
                    avail_nav.push(chip);
                } else {
                    avail_main.push(chip);
                }
            }
        }
        let section = |name: &str, rows: &Vec<NocturneKeyRow>| -> (String, String) {
            if rows.is_empty() {
                (String::new(), "n-akeysec none".to_owned())
            } else {
                (format!("{name} · {}", rows.len()), "n-akeysec".to_owned())
            }
        };
        let (avail_main_head, avail_main_cls) = section("Main block", &avail_main);
        let (avail_nav_head, avail_nav_cls) = section("Navigation", &avail_nav);
        let (avail_num_head, avail_num_cls) = section("Numpad", &avail_num);
        let avail_total = avail_main.len() + avail_nav.len() + avail_num.len();
        let keys_note = match selected {
            Some(_) if !key_rows.is_empty() => format!(
                "{} keys drive this controller · {} more available below.",
                key_rows.len(),
                avail_total
            ),
            Some(_) => {
                "No keys bound yet — click an available key, then a control on the pad.".to_owned()
            }
            None => String::new(),
        };
        let kb_tray_head = format!("Bound off this board · {}", kb_tray.len());
        let kb_tray_cls = if kb_tray.is_empty() {
            "n-kbtray none".to_owned()
        } else {
            "n-kbtray".to_owned()
        };
        // ── The macro STEP editor, when one is open ───────────────────────
        // A macro is addressed by NAME on the selected controller; an unknown
        // name simply leaves the dialog closed rather than inventing a macro.
        let mac = match (selected, p.macro_selected.as_deref()) {
            (Some(slot), Some(name)) if !name.is_empty() => {
                let snap = ksx_api::staged_macro_snapshot(slot);
                snap.macros
                    .iter()
                    .find(|m| m.name == name)
                    .map(|m| {
                        crate::macro_editor::NocturneMacroEditor::compose(
                            m,
                            &slot.persona,
                            mapper.as_ref(),
                            slot.number,
                            p.q.as_deref(),
                        )
                    })
                    .unwrap_or_else(crate::macro_editor::NocturneMacroEditor::closed)
            }
            _ => crate::macro_editor::NocturneMacroEditor::closed(),
        };

        let kb_note = match selected {
            Some(slot) if mapper.is_some() => format!(
                "Key shorts show what drives P{} · {} — on a standard board layout.",
                slot.number, slot.persona_label
            ),
            _ => String::new(),
        };

        // ── The configuration menu, served ────────────────────────────────
        // The saved-config row: what config.toml holds, and whether THIS
        // draft came from it (daemon-stamped origin + dirty).
        let (cfg_line, cfg_meta, cfg_cls, cfg_check, adopt_cls) = match &p.setup {
            Some(setup) if setup.config_exists => {
                let config_slots = setup
                    .slots
                    .iter()
                    .filter(|slot| slot.source == "config.toml")
                    .count();
                let meta = match config_slots {
                    0 => "config.toml — no controllers wired yet".to_owned(),
                    1 => "config.toml — 1 controller".to_owned(),
                    n => format!("config.toml — {n} controllers"),
                };
                let from_config = staged.origin == "config";
                (
                    "Saved configuration".to_owned(),
                    if from_config && staged.dirty {
                        format!("{meta} · this draft came from it, with unsaved edits")
                    } else if from_config {
                        format!("{meta} · this draft came from it")
                    } else {
                        meta
                    },
                    if from_config { "nm-cfg on" } else { "nm-cfg" }.to_owned(),
                    if from_config { "✓" } else { "" }.to_owned(),
                    "nm-item".to_owned(),
                )
            }
            // First run: no config.toml yet, and that is not an error.
            Some(_) => (
                "No saved configuration yet".to_owned(),
                "Save writes this draft as the configuration.".to_owned(),
                "nm-cfg".to_owned(),
                String::new(),
                "nm-item none".to_owned(),
            ),
            None => (
                "Configuration could not be read".to_owned(),
                p.setup_error.clone(),
                "nm-cfg".to_owned(),
                String::new(),
                "nm-item none".to_owned(),
            ),
        };
        // The dirty-aware sentence the Start-over fold shows BEFORE the verb.
        let discard_note = if !staged.reachable {
            "The draft is not readable right now.".to_owned()
        } else if staged.empty {
            "This draft is already empty; discarding changes nothing.".to_owned()
        } else if staged.dirty {
            "This draft has unsaved edits — discarding loses them. Saved files are not touched."
                .to_owned()
        } else {
            "This draft is cleared from memory. Saved files are not touched.".to_owned()
        };
        // Saved games: LOAD rows, never launchers — Play stays its own act.
        let (games_head, game_rows, games_note) = match &p.games {
            Some(games) => {
                let rows: Vec<NocturneGameRow> = games
                    .profiles
                    .iter()
                    .map(|game| {
                        let broken = game.state == "broken";
                        let controllers = match game.slots {
                            1 => "1 controller".to_owned(),
                            n => format!("{n} controllers"),
                        };
                        NocturneGameRow {
                            title: game.title.clone(),
                            meta: if broken {
                                format!(
                                    "{controllers} · its program is missing — bindings still load"
                                )
                            } else {
                                controllers
                            },
                            cls: if broken { "nm-game broken" } else { "nm-game" }.to_owned(),
                            ico_cls: if broken { "nm-gico broken" } else { "nm-gico" }.to_owned(),
                            revision: game.revision.clone(),
                            path: game.path.clone(),
                            arguments: game.arguments.clone(),
                            slots: game.slots.to_string(),
                            preset: game.presets.first().cloned().unwrap_or_default(),
                        }
                    })
                    .collect();
                let head = format!("Saved games · {}", rows.len());
                let note = if rows.is_empty() {
                    "No saved games yet.".to_owned()
                } else {
                    games.notes.join(" · ")
                };
                (head, rows, note)
            }
            None => ("Saved games".to_owned(), Vec::new(), p.games_error.clone()),
        };
        // The sign-in task: the SAME derivation /start's card uses, so the
        // two surfaces cannot word one scheduler two ways.
        let auto = StartAutostartView::of(&StartPayload {
            autostart_read: p.autostart_read.clone(),
            autostart_error: p.autostart_error.clone(),
            ..StartPayload::default()
        });
        let auto_note = if !auto.readable {
            format!("{} {}", auto.error, auto.detail)
        } else if auto.read_only {
            auto.detail.clone()
        } else if auto.stale && !auto.stale_detail.is_empty() {
            format!("{} {}", auto.stale_detail, auto.detail)
        } else {
            auto.detail.clone()
        };
        let auto_sw_cls = if auto.registered {
            "n-capsw on".to_owned()
        } else {
            "n-capsw".to_owned()
        };
        // The wire value `checked()` accepts — the same spelling the /start
        // card's form has always sent.
        let auto_dir = if auto.enable {
            "yes".to_owned()
        } else {
            String::new()
        };
        let auto_form_cls = if auto.readable && !auto.read_only {
            "n-capform".to_owned()
        } else {
            // An unreadable precondition or an explicitly read-only provider
            // cannot license a mutation; the next poll still retries reads.
            "n-capform none".to_owned()
        };

        let binds = workspace_bind_rows(staged, selected);
        // The pane groups its rows the way the physical controller is
        // organised — face cluster, D-pad, shoulders & triggers, each
        // stick, system — so a row is found where a hand would find the
        // control. Six served lists (a list body is one flat template; the
        // group headers live in the island markup over these).
        let mut bind_groups: [Vec<NocturneBindRow>; 6] = Default::default();
        let mut avail_groups: [Vec<NocturneCtlChip>; 6] = Default::default();
        let mut bind_bound = [0usize; 6];
        for row in &binds.rows {
            // The mapper's own unbound placeholder (`key_tag`).
            let bound = row.keys != "—";
            let group = nocturne_bind_group(&row.function);
            if !bound {
                // A free control is a CHIP, not a row: its whole story is
                // "available" — click it to give it a key.
                avail_groups[group].push(NocturneCtlChip {
                    function: row.function.clone(),
                    label: row.label.clone(),
                    cls: "n-ctlchip".to_owned(),
                });
                continue;
            }
            bind_bound[group] += 1;
            bind_groups[group].push(NocturneBindRow {
                function: row.function.clone(),
                label: row.label.clone(),
                chip: if bound {
                    row.keys.clone()
                } else {
                    "Unbound".to_owned()
                },
                note: row.share_note.clone(),
                chip_title: if bound {
                    format!(
                        "Driven by {} — click, then press a new key to replace",
                        row.keys.replace(" · ", " or ")
                    )
                } else {
                    "Not bound — click, then press a key".to_owned()
                },
                badge: {
                    let mut parts: Vec<String> = Vec::new();
                    if row.toggle {
                        parts.push("Toggle".to_owned());
                    }
                    if !row.turbo_hz.is_empty() {
                        parts.push(format!("{}/s", row.turbo_hz));
                    }
                    parts.join(" · ")
                },
                badge_cls: if row.toggle || !row.turbo_hz.is_empty() {
                    "n-rowbadge".to_owned()
                } else {
                    "n-rowbadge none".to_owned()
                },
                add_cls: if bound {
                    "n-addchip".to_owned()
                } else {
                    "n-addchip none".to_owned()
                },
                cls: if bound {
                    "n-bind on".to_owned()
                } else {
                    "n-bind".to_owned()
                },
                chip_cls: match (bound, row.share_note.is_empty()) {
                    (true, true) => "n-keychip".to_owned(),
                    // The ONE shared-key signal, the board's dashed ring.
                    (true, false) => "n-keychip shared".to_owned(),
                    (false, _) => "n-keychip ghost".to_owned(),
                },
                minus_cls: if bound && row.keys.contains(" · ") {
                    "n-minus".to_owned()
                } else {
                    "n-minus none".to_owned()
                },
                clear_cls: if bound {
                    "n-rowclear".to_owned()
                } else {
                    "n-rowclear none".to_owned()
                },
                slot: row.slot.clone(),
                turbo: row.turbo_hz.clone(),
                hold_cls: if row.toggle {
                    "n-bpill".to_owned()
                } else {
                    "n-bpill on".to_owned()
                },
                tog_cls: if row.toggle {
                    "n-bpill on".to_owned()
                } else {
                    "n-bpill".to_owned()
                },
            });
        }
        // Within a group the rows read in the canonical spoken order (A B X
        // Y; LB RB LT RT) rather than the zone table's diamond geometry — a
        // LIST is scanned by name, not by position on the pad.
        for (group, order) in [
            (0usize, ["a", "b", "x", "y"]),
            (2, ["lb", "rb", "lt", "rt"]),
        ] {
            bind_groups[group].sort_by_key(|row| {
                order
                    .iter()
                    .position(|f| row.function.eq_ignore_ascii_case(f))
                    .unwrap_or(usize::MAX)
            });
        }
        // The `?q=` filter, SERVER-resolved: a row matches on its own label
        // or its group's ("stick" keeps both stick clusters), and a group
        // whose rows are all hidden hides whole. The island's sweep applies
        // the SAME rule imperatively — the two must not drift, which is why
        // both read these exact labels.
        let query =
            p.q.as_deref()
                .map(str::trim)
                .filter(|q| !q.is_empty())
                .map(str::to_lowercase);
        let mut bind_group_cls: [String; 6] = std::array::from_fn(|_| "n-bindg".to_owned());
        if let Some(query) = query.as_deref() {
            for group in 0..6 {
                let gmatch = NOCTURNE_BIND_GROUP_LABELS[group]
                    .to_lowercase()
                    .contains(query);
                let mut visible = 0usize;
                for row in bind_groups[group].iter_mut() {
                    if gmatch || row.label.to_lowercase().contains(query) {
                        visible += 1;
                    } else {
                        row.cls.push_str(" hide");
                    }
                }
                for chip in avail_groups[group].iter_mut() {
                    if gmatch || chip.label.to_lowercase().contains(query) {
                        visible += 1;
                    } else {
                        chip.cls.push_str(" hide");
                    }
                }
                if visible == 0
                    && !(bind_groups[group].is_empty() && avail_groups[group].is_empty())
                {
                    bind_group_cls[group] = "n-bindg empty".to_owned();
                }
            }
        }
        let [bind_face_cls, bind_dpad_cls, bind_shoulders_cls, bind_lstick_cls, bind_rstick_cls, bind_system_cls] =
            bind_group_cls;
        let bind_heads: Vec<String> = bind_groups
            .iter()
            .zip(avail_groups.iter())
            .zip(bind_bound)
            .map(|((rows, avail), bound)| {
                let total = rows.len() + avail.len();
                if total == 0 {
                    String::new()
                } else if bound == 0 {
                    "none bound".to_owned()
                } else {
                    format!("{bound} of {total} bound")
                }
            })
            .collect();
        let bind_g_cls = if binds.rows.is_empty() {
            "n-bindgroups none".to_owned()
        } else {
            match selected.map(|slot| slot.number) {
                Some(digit) => format!("n-bindgroups np{digit}"),
                None => "n-bindgroups".to_owned(),
            }
        };
        let [bind_face, bind_dpad, bind_shoulders, bind_lstick, bind_rstick, bind_system] =
            bind_groups;
        let [avail_face, avail_dpad, avail_shoulders, avail_lstick, avail_rstick, avail_system] =
            avail_groups;
        let [bind_face_n, bind_dpad_n, bind_shoulders_n, bind_lstick_n, bind_rstick_n, bind_system_n]: [String; 6] =
            bind_heads.try_into().expect("six groups");

        // ── The selected slot's macros: lifecycle rows off the SAME staged
        // authoring the mapper reads. Step editing stays on Controls until
        // its own pass, and the rows say so with a link, not a pretence.
        let (macros_head, macro_rows, macros_note) = match selected {
            None => ("Macros".to_owned(), Vec::new(), String::new()),
            Some(slot) => {
                let snap = ksx_api::staged_macro_snapshot(slot);
                if !snap.available {
                    ("Macros".to_owned(), Vec::new(), snap.reason.clone())
                } else {
                    let rows: Vec<NocturneMacroRow> = snap
                        .macros
                        .iter()
                        .map(|mac| {
                            let triggered = !mac.triggers.is_empty();
                            NocturneMacroRow {
                                name: mac.name.clone(),
                                fn_name: format!("macro.{}", mac.name),
                                chip: if triggered {
                                    mac.triggers.join(" · ")
                                } else {
                                    "No trigger key".to_owned()
                                },
                                chip_title: if triggered {
                                    format!(
                                        "Started by {} — click, then press a new trigger key",
                                        mac.triggers.join(" or ")
                                    )
                                } else {
                                    "No trigger key — click, then press a key".to_owned()
                                },
                                add_cls: if triggered {
                                    "n-addchip".to_owned()
                                } else {
                                    "n-addchip none".to_owned()
                                },
                                chip_cls: if triggered {
                                    "n-keychip".to_owned()
                                } else {
                                    "n-keychip ghost".to_owned()
                                },
                                meta: nocturne_macro_meta(mac),
                                cls: if triggered && !mac.disabled {
                                    "n-bind on".to_owned()
                                } else {
                                    "n-bind".to_owned()
                                },
                                slot: slot.number.to_string(),
                                edit_href: format!(
                                    "/nocturne?slot={}&macro={}",
                                    slot.number,
                                    crate::render_map::urlencode_value(&mac.name)
                                ),
                                toggle_label: if mac.disabled {
                                    "Enable".to_owned()
                                } else {
                                    "Disable".to_owned()
                                },
                                toggle_value: if mac.disabled {
                                    "yes".to_owned()
                                } else {
                                    String::new()
                                },
                            }
                        })
                        .collect();
                    let head = format!("Macros · {}", rows.len());
                    let note = if rows.is_empty() {
                        "No macros in this layout yet — author them in the Controls editor."
                            .to_owned()
                    } else {
                        String::new()
                    };
                    (head, rows, note)
                }
            }
        };

        Self {
            theme_rows: theme_rows(&SetupSnapshot {
                available: p.setup.is_some(),
                source: String::new(),
                view: p.setup.clone().unwrap_or_default(),
            })
            .into_iter()
            .map(|row| NocturneChoiceRow {
                name: row.value,
                title: row.title,
                detail: row.detail,
                cls: row.chosen_cls,
            })
            .collect(),
            version,
            environment_id,
            environment_label,
            environment_detail,
            environment_cls,
            environment_fixture,
            environment_generation,
            chip_text,
            save_text,
            escape_line,
            play_cls,
            stop_cls,
            apply_cls,
            rack_rows,
            rack_empty,
            rack_caption,
            add_lede,
            add_preset,
            persona_rows,
            layout_opts,
            socd_opts,
            socd_cls,
            socd_num,
            socd_lab,
            socd_edit_opts,
            pad_badge,
            pad_badge_cls,
            kb_cls,
            undo_cls,
            undo_label,
            stage_word,
            pad_name,
            pad_sub,
            pad_xbox_cls,
            pad_ps_cls,
            pad_ps5_cls,
            pad_switchpro_cls,
            pad_xboxseries_cls,
            bind_title: binds.title,
            bind_face,
            bind_dpad,
            bind_shoulders,
            bind_lstick,
            bind_rstick,
            bind_system,
            bind_face_n,
            bind_dpad_n,
            bind_shoulders_n,
            bind_lstick_n,
            bind_rstick_n,
            bind_system_n,
            bind_face_cls,
            bind_dpad_cls,
            bind_shoulders_cls,
            bind_lstick_cls,
            bind_rstick_cls,
            bind_system_cls,
            slot_val,
            bind_g_cls,
            bind_foot: binds.foot,
            macros_head,
            macro_rows,
            macros_note,
            kb_row1,
            kb_row2,
            kb_row3,
            kb_row4,
            kb_row5,
            kb_row6,
            kb_tray,
            key_rows,
            keys_note,
            avail_main,
            avail_nav,
            avail_num,
            pads,
            legend,
            solo_label,
            avail_main_head,
            avail_nav_head,
            avail_num_head,
            avail_main_cls,
            avail_nav_cls,
            avail_num_cls,
            avail_ctl_face: avail_face,
            avail_ctl_dpad: avail_dpad,
            avail_ctl_shoulders: avail_shoulders,
            avail_ctl_lstick: avail_lstick,
            avail_ctl_rstick: avail_rstick,
            avail_ctl_system: avail_system,
            kb_tray_head,
            kb_tray_cls,
            kb_note,
            kb_more_cls,
            mac,
            cfg_line,
            cfg_meta,
            cfg_cls,
            cfg_check,
            adopt_cls,
            discard_note,
            games_head,
            game_rows,
            games_note,
            auto_line: auto.line,
            auto_sw_cls,
            auto_dir,
            auto_btn: auto.button,
            auto_note,
            auto_form_cls,
            dev_count,
            dev_note,
            encoder_count,
            encoder_head,
            kb_title,
            dev_encoders,
            dev_rows,
            dev_exp,
            dev_other,
            exp_head,
            exp_fold_cls,
            other_head,
            other_fold_cls,
            mode_rows,
            mode_note,
            cap_line,
            capd_cls,
            cap_sw_cls,
            cap_selector: cap.expected_selector.clone(),
            cap_instance: cap.instance_id.clone(),
            cap_prepare,
            cap_release,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nocturne_environment_provenance_survives_derivation() {
        let payload = NocturnePayload {
            environment: ksx_api::RuntimeEnvironmentView::fixture(
                "fixture-first-run",
                "FIXTURE · FIRST RUN",
                "Synthetic first-run state; no physical device is read.",
            )
            .with_generation("seed-42"),
            ..NocturnePayload::default()
        }
        .derived();

        assert_eq!(payload.environment.id, "fixture-first-run");
        assert_eq!(payload.view.environment_id, "fixture-first-run");
        assert_eq!(payload.view.environment_label, "FIXTURE · FIRST RUN");
        assert_eq!(payload.view.environment_cls, "n-environment fixture");
        assert!(payload.view.environment_fixture);
        assert_eq!(payload.view.environment_generation, "seed-42");
        assert!(payload
            .view
            .environment_detail
            .contains("no physical device"));
    }

    /// **The saved answer is marked, and an unconfigured machine claims
    /// nothing.**
    ///
    /// The three answers come from `BlockingOption::roster()` - the same list
    /// `/start` asks with - so this pins the part that is genuinely this page's
    /// own: which one is chosen, and what the line says when there is nothing
    /// to choose from yet. An unconfigured machine has a default in MEMORY,
    /// and printing that as though somebody had picked it sends a person
    /// hunting for a setting they never set.
    #[test]
    fn the_saved_split_or_freeze_answer_is_the_marked_one() {
        let configured = ksx_api::SetupView {
            config_exists: true,
            blocking: "whole".to_owned(),
            blocking_options: ksx_api::BlockingOption::roster(),
            ..ksx_api::SetupView::default()
        };
        let rows = SetupRows::of(&SetupSnapshot::ready(configured.clone())).blocking;
        assert_eq!(
            rows.len(),
            3,
            "every answer is offered, not just the others"
        );
        let chosen: Vec<&str> = rows
            .iter()
            .filter(|r| r.chosen_cls.contains("pill-ok"))
            .map(|r| r.name.as_str())
            .collect();
        assert_eq!(chosen, ["whole"], "exactly the saved answer is marked");
        assert!(
            rows.iter()
                .find(|r| r.name == "whole")
                .is_some_and(|r| r.button.contains("how it is set")),
            "the current answer does not invite a no-op write"
        );

        // Nothing is configured: no answer is reported, and none is invented.
        let fresh = ksx_api::SetupView {
            config_exists: false,
            blocking: String::new(),
            blocking_options: ksx_api::BlockingOption::roster(),
            ..ksx_api::SetupView::default()
        };
        assert!(
            SetupRows::of(&SetupSnapshot::ready(fresh))
                .blocking
                .iter()
                .all(|r| !r.chosen_cls.contains("pill-ok")),
            "an unset machine has chosen none of the three"
        );

        // A value this build does not know (an older or hand-edited config) is
        // NOT smoothed over into one of the three it does know.
        let strange = ksx_api::SetupView {
            config_exists: true,
            blocking: "half-on".to_owned(),
            blocking_options: ksx_api::BlockingOption::roster(),
            ..ksx_api::SetupView::default()
        };
        assert!(
            SetupRows::of(&SetupSnapshot::ready(strange))
                .blocking
                .iter()
                .all(|r| !r.chosen_cls.contains("pill-ok")),
            "an unknown value marks none of the three as in use"
        );
    }

    /// **A stale registration offers the REPAIR, not the removal.**
    ///
    /// The subtle case, and the one a cabinet actually lands in: ksx is
    /// reinstalled, the scheduled task keeps the old path, and the machine
    /// would cold-boot to nothing. Deriving the button from `registered` alone
    /// would offer "stop starting ksx at sign-in" - which is already what the
    /// machine effectively does, and would leave the user in the broken state
    /// with the fix nowhere on screen. Turning it ON again rewrites the task.
    ///
    /// Also pins the third state apart from the other two: a read that
    /// REFUSED must not render as "off" (`SURFACES.md` §1b) - "nothing is
    /// registered" and "nobody could ask" are different sentences.
    #[test]
    fn a_stale_logon_task_offers_the_repair_and_an_unreadable_one_claims_nothing() {
        let card = |view: Option<ksx_api::AutostartView>| {
            StartAutostartView::of(&StartPayload {
                autostart_read: view,
                ..StartPayload::default()
            })
        };

        let stale = card(Some(ksx_api::AutostartView {
            registered: true,
            line: "registered".into(),
            stale: true,
            stale_detail: Some("points somewhere else".into()),
            ..ksx_api::AutostartView::default()
        }));
        assert!(stale.enable, "a stale task must offer to be rewritten");
        assert!(stale.stale && !stale.stale_detail.is_empty());
        assert!(stale.button.contains("Start ksx"), "{}", stale.button);

        let healthy = card(Some(ksx_api::AutostartView {
            registered: true,
            line: "registered".into(),
            ..ksx_api::AutostartView::default()
        }));
        assert!(!healthy.enable, "a working task offers to be turned off");

        let off = card(Some(ksx_api::AutostartView::default()));
        assert!(off.enable && off.readable && !off.registered);

        let unreadable = card(None);
        assert!(!unreadable.readable, "a refused read is not an answer");
        assert!(
            !unreadable.registered,
            "and it must never be reported as registered either"
        );
        assert!(
            !unreadable.line.contains("does not start on its own"),
            "an unreadable scheduler must not claim ksx is off: {}",
            unreadable.line
        );
    }

    /// **The four-player panel, layout menu untouched** - `FIRST-RUN.md` §1
    /// moment 5, pressed four times.
    ///
    /// A template's player block is chosen by SLOT NUMBER (`ksx_api`'s
    /// `instantiate`, `player = number`), so "Add this controller" with the
    /// `<select>` left alone sends whatever `layout_options` put first. Every
    /// in-box layout except `arcade-4way` carries at most two blocks, so
    /// before the sort knew the next slot number the THIRD press was refused
    /// outright with `TemplateError::NoSuchPlayer` - the wall a four-player
    /// cabinet walks into, reported as "Reopen ksx and try again".
    ///
    /// Driven through the real `StageEdit::apply` rather than asserting an
    /// order, and deliberately never naming `arcade-4way`: an assertion on
    /// that id would keep passing if the sort broke and that template merely
    /// happened to stay first.
    #[test]
    fn adding_four_controllers_without_touching_the_layout_menu_is_accepted() {
        let mut setup = ksx_api::StageEdit::ChooseDevice {
            selector: "usb:d209:0430:00".to_owned(),
            alias: "panel".to_owned(),
            label: "Ultimarc I-PAC 4".to_owned(),
        }
        .apply(&ksx_core::stage::StagedSetup::new())
        .expect("staging the panel");

        for expected in 1..=4u8 {
            let view = ksx_api::StagedSetupView::of(&setup);
            assert_eq!(view.next_slot, Some(expected), "slot order");

            // Exactly what the untouched form posts: the option the menu puts
            // first, and the served preset name. The ordering is inlined from
            // the served view rather than taken from a page helper - layouts
            // that fit the next slot lead, then the default.
            let first = {
                let next = view.next_slot;
                let mut rows: Vec<&ksx_api::TemplateRow> = view.layouts.iter().collect();
                rows.sort_by_key(|layout| {
                    (
                        !next.is_none_or(|number| layout.players.contains(&number)),
                        layout.id != view.default_layout,
                    )
                });
                rows.first().expect("a layout to offer").id.clone()
            };
            let persona = view
                .personas
                .iter()
                .find(|p| p.can_plug)
                .expect("a persona this build can plug")
                .name
                .clone();

            setup = ksx_api::StageEdit::AddSlot {
                number: None,
                persona,
                preset: view.next_preset.clone().expect("a served preset name"),
                layout: Some(first.clone()),
            }
            .apply(&setup)
            .unwrap_or_else(|refusal| {
                panic!(
                    "player {expected} refused the layout the menu offered first \
                     ({first}): {}",
                    refusal.message
                )
            });
        }

        assert_eq!(ksx_api::StagedSetupView::of(&setup).slots.len(), 4);
    }

    /// The ROW sentences are composed here and nowhere else. This pins the
    /// exact strings both seams (render_setup.rs's SSR injection and
    /// SetupIsland.ts's poll) now read verbatim — the formatters they used to
    /// each own are gone, so this is the only place a row wording can change.
    /// The theme card's three states, pinned (TK2/TK3 review finding: the
    /// first cut marked System "in use" on a config nothing had READ, and
    /// claimed "this is how it is set" about a config that said otherwise).
    #[test]
    fn the_theme_rows_and_line_say_only_what_the_read_supports() {
        let marked = |rows: &[SetupThemeRowView]| {
            rows.iter()
                .filter(|r| r.chosen_cls == "pill pill-ok")
                .map(|r| r.value.clone())
                .collect::<Vec<_>>()
        };

        // Nothing stored: System is genuinely how it is set.
        let snap = SetupSnapshot::ready(ksx_api::SetupView::default());
        let rows = SetupRows::of(&snap).themes;
        assert_eq!(marked(&rows), ["system"]);
        assert_eq!(rows[0].button, "This is how it is set");

        // A shipped id: that row is marked; System offers its action.
        let snap = SetupSnapshot::ready(ksx_api::SetupView {
            theme: "light".to_owned(),
            ..Default::default()
        });
        let rows = SetupRows::of(&snap).themes;
        assert_eq!(marked(&rows), ["light"]);
        assert_eq!(rows[0].button, "Match the operating system");
        assert!(rows
            .iter()
            .any(|r| r.value == "light" && r.button == "This is how it is set"));

        // An id this build does not ship: System IS what renders (the pill is
        // true) but NOT what is set — the button offers the useful act.
        let snap = SetupSnapshot::ready(ksx_api::SetupView {
            theme: "matrix2".to_owned(),
            ..Default::default()
        });
        let rows = SetupRows::of(&snap).themes;
        assert_eq!(marked(&rows), ["system"]);
        assert_eq!(rows[0].button, "Follow the operating system instead");

        // A config nothing could read: no row claims anything about it.
        let snap = SetupSnapshot::unavailable("the store refused");
        let rows = SetupRows::of(&snap).themes;
        assert_eq!(marked(&rows), Vec::<String>::new());
        assert!(rows.iter().all(|r| r.button != "This is how it is set"));
    }

    #[test]
    fn the_setup_rows_are_composed_once_from_the_view() {
        let view = ksx_api::SetupView {
            devices: vec![ksx_api::SetupDeviceRow {
                alias: "P1 board".to_owned(),
                id: "usb:d209:0430:00".to_owned(),
                backend: "interception".to_owned(),
            }],
            slots: vec![ksx_api::SetupSlotRow {
                number: 3,
                device: "P1 board".to_owned(),
                preset: "Panel P1".to_owned(),
                persona: "Xbox 360 pad".to_owned(),
                socd: String::new(),
                source: "config.toml".to_owned(),
            }],
            presets: vec!["Panel P1".to_owned()],
            profiles: vec!["Example Game".to_owned()],
            steps: vec![ksx_api::SetupStep {
                id: ksx_api::setup_steps::SLOT.to_owned(),
                title: "Wire a slot".to_owned(),
                detail: "One slot is wired.".to_owned(),
                state: ksx_api::setup_states::NOW.to_owned(),
            }],
            notes: vec!["a note".to_owned()],
            ..ksx_api::SetupView::default()
        };
        let rows = SetupRows::of(&SetupSnapshot::ready(view));

        assert_eq!(rows.steps[0].badge, "1");
        assert_eq!(rows.steps[0].cls, "step now");
        assert_eq!(rows.devices[0].title, "P1 board");
        assert_eq!(rows.devices[0].detail, "interception · usb:d209:0430:00");
        assert_eq!(rows.slots[0].title, "Slot 3 — Panel P1");
        assert_eq!(
            rows.slots[0].detail,
            "P1 board · Xbox 360 pad · config.toml"
        );
        assert_eq!(rows.preset_options[0].text, "Panel P1");
        assert_eq!(
            rows.persona_options
                .iter()
                .map(|option| option.value.as_str())
                .collect::<Vec<_>>(),
            [
                "xbox360",
                "playstation",
                "dualsense",
                "switchpro",
                "xboxseries",
                "snes",
                "genesis"
            ],
            "the maintenance menu offers every live persona and no gated one"
        );
        assert_eq!(rows.persona_options[0].label, "Xbox 360 · ViGEmBus");
        assert_eq!(rows.persona_options[2].label, "DualSense · HIDMaestro");
        assert_eq!(rows.profile_options[0].text, "Example Game");
        assert_eq!(rows.notes[0].text, "a note");

        // The menu is 1..=the ceiling the BACKEND serves — never a literal in
        // a view layer (the shipped page held `SLOT_CHOICES = 8` in two
        // languages while `ksx_core::MAX_SLOTS` was 16).
        assert_eq!(rows.slot_options.len(), usize::from(ksx_core::MAX_SLOTS));
        assert_eq!(rows.slot_options[0].value, "1");
        assert_eq!(rows.slot_options[0].label, "Slot 1");
        let last = rows.slot_options.last().unwrap();
        assert_eq!(last.value, ksx_core::MAX_SLOTS.to_string());
    }
}
