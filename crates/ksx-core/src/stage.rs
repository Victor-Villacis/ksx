//! The STAGED SETUP — a setup the user is still deciding on
//! (`docs/FIRST-RUN.md` §2).
//!
//! # Why this is a type and not a UI trick
//!
//! Before this module, choosing a persona *was* a `[[slot]]` written to
//! `config.toml`, and a pad appeared when a session started. "Pick PS4, look at
//! it, change to Xbox 360" was three file writes and two timestamped backups —
//! for a decision the user had not made yet. Deleting the controller they never
//! wanted left a fourth write and a backup behind it.
//!
//! A staged setup is its own value and **never touches disk**. It holds the
//! chosen input devices in authored order, the chosen persona per slot, each
//! device-qualified mapping route, and the blocking answer. It lives in the
//! daemon for the length of a visit. Nothing
//! is claimed, nothing is plugged, no config file is written, until the user
//! says so — and even then, [`StagedSetup::commit`] (save) and the play path
//! are separate acts.
//!
//! The consequences §2 makes requirements, and where each one is:
//!
//! - deleting a staged controller is free and complete — [`StagedSetup::remove_slot`];
//! - "Start over" always works — [`StagedSetup::discard`], which cannot refuse;
//! - leaving without saving loses only what was typed — nothing here writes;
//! - **what is staged is what plays** — [`StagedSetup::commit`] produces ONE
//!   [`CommitSpec`], and the save path and the play path are both built from
//!   that one value. There is no second translation in which a saved file could
//!   mean something different from what the screen showed. `ksx-backend`'s
//!   `crate::stage` pins that with a test.
//!
//! # Validation is reused, never restated
//!
//! Every rule here already existed somewhere and is *read*, not re-derived:
//!
//! - [`Persona::can_plug`] gates each HIDMaestro persona independently, and the refusal
//!   quotes [`crate::Persona::gap`] verbatim — the same sentence
//!   `ksx slot assign` prints, so each exact persona stops refusing only when
//!   its production host path is proven;
//! - [`MAX_XINPUT_SLOTS`] caps the personas that occupy one of Windows' four
//!   XInput slots, counted through [`Persona::is_xinput`] — which is why
//!   `playstation` is plain HID, takes none, and is how players 5+ exist;
//! - [`MAX_SLOTS`] caps the total, through [`SlotSpec::from_sources`]'s own
//!   check.
//!
//! Refusals name what would make the choice legal. A refusal with no way
//! forward is just an error message.
//!
//! # Whole-setup facts [`StagedSetup::commit`] refuses
//!
//! Every rule above is a fact about ONE edit, so an operation can check it.
//! Some are facts about the setup as a WHOLE, and they are ways a screen could
//! report success while nothing works:
//!
//! - **a controller that binds nothing** ([`StageRefusal::NoBindings`]) — the
//!   pad plugs, the game sees a controller, every button is dead;
//! - **a routed keyboard whose preset binds nothing**
//!   ([`StageRefusal::NoRouteBindings`]) — the UI claims that physical source
//!   feeds the pad, but every key from it is inert;
//! - **a controller with no input route** ([`StageRefusal::NoSources`]) — it
//!   may remain temporarily after one keyboard is removed, but cannot play or
//!   save until another source is routed or the controller is removed;
//! - **an unanswered split-or-freeze question**
//!   ([`StageRefusal::BlockingUnanswered`]) — resolving it to
//!   [`Blocking::default`] would silently freeze a first-run user's keyboard,
//!   and would overwrite a returning user's own answer with one they were
//!   never shown.
//!
//! Both live in `commit` and nowhere else, which is what makes them
//! unresurrectable: `commit` is the only door to a [`CommitSpec`], the save
//! path and the play path are both built from one, and
//! `ksx_api::StagedSetupView::ready` *is* `commit().is_ok()` — so the buttons
//! are not offered, and the verbs refuse if something offers them anyway.

use crate::blocking::Blocking;
use crate::engine::ResolvedSlot;
use crate::persona::Persona;
use crate::preset::Preset;
use crate::selector::DeviceSelector;
use crate::slot::{SlotSpec, SourceSpec, MAX_HIDMAESTRO_PADS, MAX_SLOTS, MAX_XINPUT_SLOTS};
use crate::socd::Socd;

/// The capture backend a staged device will use once the setup is committed.
///
/// This is an intent while the setup is still in memory.  The live preflight
/// immediately before Save and Play is authoritative: `Winusb` is refused
/// until the selected interface is actually bound to `winusb.sys`, and
/// `Interception` is refused when that backend is unavailable.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum StageCaptureBackend {
    #[default]
    Interception,
    Winusb,
}

impl StageCaptureBackend {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Interception => "interception",
            Self::Winusb => "winusb",
        }
    }
}

impl std::fmt::Display for StageCaptureBackend {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// One input device a staged setup is built on.
///
/// **A [`DeviceSelector`], never a raw path** (`docs/DEVICE-IDENTITY.md` §1):
/// what is staged is *which board*, so the setup keeps meaning the same thing
/// after the board is replugged into another socket. The raw instance path a
/// scan happened to see is not stored here at all, which is what makes it
/// impossible for it to leak onto a screen as the identifier
/// (`docs/FIRST-RUN.md` §5).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StagedDevice {
    /// Which board — the weakest rung that is still unique, as
    /// `ksx device pick` computes it.
    pub selector: DeviceSelector,
    /// The short name `[[slot]]` rows will refer to it by once this is saved
    /// ("panel", "P1"). Never contains a backslash: everywhere else in the
    /// config a value with one is read as a literal device path, so such an
    /// alias could never resolve back to its own entry.
    pub alias: String,
    /// What a human calls it on screen — "Ultimarc I-PAC 4", "Logitech
    /// keyboard". Presentation only; nothing resolves against it.
    pub label: String,
    /// Which capture backend the committed setup will request.  Choosing a
    /// device starts on Interception for wire compatibility; only the guarded
    /// transition below may change an already-staged selection to WinUSB.
    pub backend: StageCaptureBackend,
}

/// One keyboard-to-controller route while a setup is still in memory.
///
/// The selector, rather than an alias or a vector index, is the route's
/// identity. Aliases are presentation/config spelling and may be edited;
/// insertion order is presentation order and may shift when another keyboard
/// is removed. The selector is the durable fact both operations preserve.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StagedRoute {
    pub selector: DeviceSelector,
    pub preset: Preset,
}

/// One staged controller: the slot number, what it presents itself as, and its
/// source-qualified bindings so far.
///
/// Each route's bindings are a whole [`Preset`] because that is the unit the
/// rest of ksx already speaks — the engine and file format both resolve named
/// presets. `preset` remains the first-route compatibility view; [`StagedRoute`]
/// is the canonical fan-in model.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StagedSlot {
    /// 1..=[`MAX_SLOTS`].
    pub number: u8,
    /// What this slot presents itself as. Gated by [`Persona::can_plug`].
    pub persona: Persona,
    /// Compatibility view of the first route's bindings, carrying the preset
    /// file name existing callers display and edit.
    pub preset: Preset,
    /// What this slot does with simultaneous opposing directions — the same
    /// [`Socd`] a saved `[[slot]]` carries, staged here so a setup can answer
    /// the question BEFORE anything is written and [`StagedSetup::commit`]
    /// carries the answer into the one [`CommitSpec`] both exits read.
    /// Defaults to [`Socd::Off`], exactly as [`SlotSpec::new`] does.
    pub socd: Socd,
    /// Independently mapped keyboards feeding this controller, kept in the
    /// same relative order as [`StagedSetup::devices`].
    ///
    /// `preset` above remains the compatibility view of the first route. New
    /// callers should read [`StagedSlot::routes`] so two keyboards may use two
    /// different mappings without collapsing back to a shared preset.
    routes: Vec<StagedRoute>,
}

impl StagedSlot {
    /// Every source-qualified route feeding this controller.
    pub fn routes(&self) -> &[StagedRoute] {
        &self.routes
    }

    /// The route for one staged keyboard selector.
    pub fn route(&self, selector: &DeviceSelector) -> Option<&StagedRoute> {
        self.routes.iter().find(|route| &route.selector == selector)
    }
}

/// A setup being explored. In memory only; **nothing here can write**.
///
/// Every mutating operation takes `&self` and returns a *new* validated value.
/// That is not a style preference: it makes "a refusal changes nothing" a fact
/// about the type rather than a discipline the implementation has to keep, so a
/// user who is told "no" is provably left holding exactly what they had.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StagedSetup {
    /// In authored order, unique by selector. The first entry is the
    /// compatibility device returned by [`StagedSetup::device`].
    devices: Vec<StagedDevice>,
    /// Kept sorted by slot number.
    slots: Vec<StagedSlot>,
    /// `None` = **not asked yet**, which is a different fact from "the user
    /// chose the default" and a surface must be able to tell them apart:
    /// `docs/FIRST-RUN.md` §3 asks the split-or-freeze question once, and a
    /// screen that renders "Freeze" pre-selected has answered it for them.
    blocking: Option<Blocking>,
}

/// Why a staging operation was refused. Nothing is ever half-applied: the
/// caller still holds the setup it passed in.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum StageRefusal {
    #[error("slot number must be 1..={MAX_SLOTS}, got {given}")]
    BadSlot { given: u8 },
    #[error("slot {number} is already staged")]
    SlotTaken { number: u8 },
    #[error("slot {number} is not staged")]
    NoSuchSlot { number: u8 },
    #[error(
        "all {MAX_SLOTS} slots are already staged — {MAX_SLOTS} is ksx's own ceiling \
         (ksx_core::MAX_SLOTS), not a Windows one"
    )]
    NoFreeSlot,
    /// The persona is a real persona, and this build cannot create it. Worded
    /// from [`crate::Persona::gap`] so this refusal and `ksx slot assign`'s
    /// say the identical thing.
    #[error(
        "persona '{persona}' is a persona ksx knows and this build cannot create — {reason}. \
         What decides it is the BINARY, not the machine: `Persona::backend()` sends {persona} to \
         {backend}, and `Persona::can_plug` is false for {persona} in this build. \
         Stage persona '{instead}' instead"
    )]
    PersonaNotImplemented {
        persona: Persona,
        backend: &'static str,
        reason: &'static str,
        instead: Persona,
    },
    /// This build can create the persona, but its production runtime owns a
    /// deliberately bounded number of devices.
    #[error(
        "slot {number} would make {after} staged '{persona}' controllers, but this release can create at most {limit}. The first HIDMaestro runtime owns one fixed DualSense endpoint; use another supported persona for the extra slot"
    )]
    PersonaCapacity {
        number: u8,
        persona: Persona,
        after: usize,
        limit: usize,
    },
    /// Staging this would leave a fifth slot on an XInput persona.
    #[error(
        "that would make {after} staged slots use an XInput persona, and Windows exposes only \
         {MAX_XINPUT_SLOTS} XInput slots — the fifth pad plugs and no game reads it (measured, \
         docs/research/m6.5-ds4-findings.md). What decides it is `Persona::is_xinput()`: '{}' and \
         '{}' each take one of the four; '{}' is plain HID and takes none, which is how players \
         5+ exist at all. Give slot {number} persona '{}', or move one of the other {after} off \
         XInput. Nothing has been written, so changing your mind costs nothing",
        Persona::Xbox360,
        Persona::XboxSeries,
        Persona::PlayStation,
        Persona::PlayStation
    )]
    TooManyXinputSlots {
        number: u8,
        /// How many staged slots would be on an XInput persona.
        after: usize,
    },
    /// Staging this would exceed the HIDMaestro host's controller pool.
    #[error(
        "that would make {after} staged slots use a HIDMaestro persona, but the elevated \
         HIDMaestro host has a live-pad capacity of {MAX_HIDMAESTRO_PADS}. Give slot {number} \
         persona '{}' or '{}' (ViGEmBus, outside that pool), or remove one of the other \
         {after}. Nothing has been written, so changing your mind costs nothing",
        Persona::Xbox360,
        Persona::PlayStation
    )]
    TooManyHidMaestroPads {
        number: u8,
        /// How many staged slots would be on a HIDMaestro persona.
        after: usize,
    },
    /// An alias that could never resolve back to its own `[[device]]` entry.
    #[error("\"{alias}\" cannot name this device: {problem}")]
    BadAlias {
        alias: String,
        problem: &'static str,
    },
    #[error(
        "keyboard selectors '{selector}' and '{other}' both use alias \"{alias}\" — config aliases resolve by exact spelling, so saving both would make one source resolve as the other. Give either keyboard a distinct alias"
    )]
    DuplicateAlias {
        alias: String,
        selector: String,
        other: String,
    },
    #[error("keyboard selector '{selector}' is not staged, so it cannot own a controller route")]
    NoSuchDevice { selector: String },
    #[error("slot {number} has no route from keyboard selector '{selector}'")]
    NoSuchRoute { number: u8, selector: String },
    /// Two staged slots hold presets that share a NAME but not a BODY.
    ///
    /// One name is one preset file, so saving these would collapse them into
    /// one and the setup that came back off disk would not be the one on
    /// screen. That is exactly the second translation §2 forbids, caught while
    /// it is still free to fix.
    #[error(
        "slots {number} and {other} both stage a preset called \"{name}\", with different \
         bindings — one name is one preset file, so saving would keep one set of bindings and \
         silently lose the other. Rename one of them"
    )]
    PresetNameClash { number: u8, other: u8, name: String },
    #[error("a preset needs a name — it is what the saved file is called, and what a [[slot]] refers to")]
    UnnamedPreset { number: u8 },
    /// **A staged controller that binds nothing.**
    ///
    /// The pad plugs, Windows shows a controller, the game shows a controller,
    /// and every button does nothing — which is indistinguishable from broken
    /// hardware and is exactly `docs/FIRST-RUN.md` §6's "a screen reports
    /// success while nothing works". Refused at [`StagedSetup::commit`], so it
    /// is refused for BOTH exits (save and play) and shows up as
    /// `StagedSetupView::not_ready` before either button is offered.
    #[error(
        "slot {number} would plug a pad that does nothing: its preset \"{preset}\" has no key \
         bound to any control, so every button on it would be dead in a game — which looks \
         exactly like broken hardware. Give it a layout to start from, or bind at least one \
         control, then save or play. Nothing has been written, so fixing it costs nothing"
    )]
    NoBindings { number: u8, preset: String },
    #[error(
        "slot {number}'s route from keyboard selector '{selector}' uses preset \"{preset}\", but that preset binds no key to any control — bind that source or remove its route"
    )]
    NoRouteBindings {
        number: u8,
        selector: String,
        preset: String,
    },
    /// A controller survived an edit but none of the remaining keyboards feed
    /// it. This is distinct from `NoDevice`: other staged keyboards may still
    /// feed other controllers.
    #[error(
        "slot {number} has no keyboard route, so it would plug a controller that no physical input can drive — route a staged keyboard to it or remove the controller"
    )]
    NoSources { number: u8 },
    /// **Split-or-freeze has not been answered.**
    ///
    /// `docs/FIRST-RUN.md` §3 asks it once, and [`StagedSetup::blocking`] keeps
    /// "not asked" apart from "chose the default" precisely so this can be
    /// refused rather than silently resolved. A commit that fell back to
    /// [`Blocking::default`] would write Freeze over the answer a returning
    /// user had already given, from a question they were never shown.
    #[error(
        "split-or-freeze has not been answered yet, and it decides whether the keyboard you \
         picked can still type while the pads are live. There is deliberately no default: an \
         unanswered question resolved to \"{}\" would take a returning user's own answer away \
         and would tell a first-run user their keyboard stopped typing for no reason they were \
         shown. Answer it ({} | {} | {}), then save or play",
        Blocking::Whole.as_str(),
        Blocking::Whole.as_str(),
        Blocking::BoundKeys.as_str(),
        Blocking::Off.as_str()
    )]
    BlockingUnanswered,
    /// Committing (or planning) with no device chosen.
    #[error(
        "no keyboard has been chosen yet, so there is nothing for these {slots} slot(s) to \
         listen to — pick a device first, or add one to a multi-keyboard setup"
    )]
    NoDevice { slots: usize },
    /// Committing (or planning) with no slots.
    #[error(
        "no controller has been staged yet — a setup with a keyboard and no controller drives \
         nothing. Add one and choose what it should become"
    )]
    NoSlots,
    /// A backend transition was prepared for one staged board, but another
    /// selection replaced it before the transition arrived.
    #[error(
        "the staged keyboard changed while its capture backend was being prepared: expected \
         '{expected}', but the current selection is {current}. Choose the keyboard again; the \
         newer staged choice was left unchanged"
    )]
    DeviceChanged { expected: String, current: String },
    /// A reorder that does not name exactly the staged slots, once each. A
    /// whole-order write that dropped or invented a slot would silently
    /// delete a controller, so it is refused whole instead.
    #[error(
        "the new order must name every staged slot exactly once — staged slots: [{staged}], the \
         order sent: [{given}]. Nothing has been changed"
    )]
    BadReorder { staged: String, given: String },
}

/// The numbers as the refusal prints them.
fn join_numbers(numbers: &[u8]) -> String {
    numbers
        .iter()
        .map(u8::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

impl StageRefusal {
    /// The stable refusal word. The three that name a rule shared with
    /// `ksx slot assign` deliberately reuse ITS word: a surface that routes on
    /// the code must handle one fact once, not once per verb that states it.
    pub fn code(&self) -> &'static str {
        match self {
            Self::BadSlot { .. } => "bad-slot",
            Self::SlotTaken { .. } => "slot-taken",
            Self::NoSuchSlot { .. } => "no-such-slot",
            Self::NoFreeSlot => "no-free-slot",
            Self::PersonaNotImplemented { .. } => "persona-not-implemented",
            Self::PersonaCapacity { .. } => "persona-capacity",
            Self::TooManyXinputSlots { .. } => "too-many-xinput-slots",
            Self::TooManyHidMaestroPads { .. } => "too-many-hidmaestro-pads",
            Self::BadAlias { .. } => "bad-alias",
            Self::DuplicateAlias { .. } => "duplicate-alias",
            Self::NoSuchDevice { .. } => "no-such-device",
            Self::NoSuchRoute { .. } => "no-such-route",
            Self::PresetNameClash { .. } => "preset-name-clash",
            Self::UnnamedPreset { .. } => "unnamed-preset",
            Self::NoBindings { .. } => "no-bindings",
            Self::NoRouteBindings { .. } => "no-route-bindings",
            Self::NoSources { .. } => "no-sources",
            Self::BlockingUnanswered => "blocking-unanswered",
            Self::NoDevice { .. } => "no-device",
            Self::NoSlots => "no-slots",
            Self::DeviceChanged { .. } => "staged-device-changed",
            Self::BadReorder { .. } => "bad-reorder",
        }
    }
}

/// Everything a finished staging means, as one typed value.
///
/// **The single typed source of truth both paths read.** `ksx-app`'s
/// `crate::stage` turns this
/// into the `ConfigFile` a save writes AND into the `RunPlan` a play runs, with
/// one translation used by both — which is what makes "what is staged is what
/// plays" a structural fact instead of a promise.
///
/// [`Self::slots`] is [`ResolvedSlot`], the very type `RunPlan::slots` holds:
/// a slot spec with its primary and additional routed presets already beside
/// it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitSpec {
    /// Compatibility view of [`Self::devices`]'s first keyboard.
    pub device: StagedDevice,
    /// Every staged keyboard in authored order, unique by selector.
    pub devices: Vec<StagedDevice>,
    /// Slot order. Each slot carries its own source-qualified keyboard routes.
    pub slots: Vec<ResolvedSlot>,
    /// How much of the staged keyboards a session takes away from Windows.
    ///
    /// **Always the answer the user gave.** [`StagedSetup::commit`] refuses an
    /// unanswered setup ([`StageRefusal::BlockingUnanswered`]), so there is no
    /// path from "never asked" to a value here — which is what makes it safe
    /// for `ksx-app`'s `stage::to_config` to assign it unconditionally over a
    /// returning user's `block_keyboards`.
    pub blocking: Blocking,
}

impl StagedSetup {
    /// An empty stage: no devices, no controllers, nothing asked.
    pub fn new() -> Self {
        Self::default()
    }

    /// The first staged keyboard, retained as the exact compatibility view
    /// callers used when a setup could hold only one.
    pub fn device(&self) -> Option<&StagedDevice> {
        self.devices.first()
    }

    /// Every staged keyboard in authored order, unique by selector.
    pub fn devices(&self) -> &[StagedDevice] {
        &self.devices
    }

    /// The staged controllers, in slot order.
    pub fn slots(&self) -> &[StagedSlot] {
        &self.slots
    }

    pub fn slot(&self, number: u8) -> Option<&StagedSlot> {
        self.slots.iter().find(|s| s.number == number)
    }

    /// The split-or-freeze answer, or `None` if the question has not been
    /// asked. See the field docs for why those are not the same.
    pub fn blocking(&self) -> Option<Blocking> {
        self.blocking
    }

    /// Nothing staged at all. `true` for a fresh visit and after
    /// [`Self::discard`].
    pub fn is_empty(&self) -> bool {
        self.devices.is_empty() && self.slots.is_empty() && self.blocking.is_none()
    }

    /// The lowest slot number not staged yet, or `None` when all
    /// [`MAX_SLOTS`] are taken. What an "Add a controller" button offers.
    pub fn next_free_slot(&self) -> Option<u8> {
        (1..=MAX_SLOTS).find(|n| self.slot(*n).is_none())
    }

    /// How many staged slots occupy one of Windows' four XInput slots.
    ///
    /// Counted through [`Persona::is_xinput`] — the same flag `ksx-config`'s
    /// validator and `ksx pads` count from. A second
    /// `matches!(p, Xbox360 | XboxSeries)` written here would be a fourth
    /// persona's chance to be forgotten.
    pub fn xinput_slots(&self) -> usize {
        self.slots.iter().filter(|s| s.persona.is_xinput()).count()
    }

    /// How many staged slots ask for one exact persona.
    pub fn persona_slots(&self, persona: Persona) -> usize {
        self.slots
            .iter()
            .filter(|slot| slot.persona == persona)
            .count()
    }

    /// Choose the input device. Replaces every earlier choice — the exact
    /// singleton behavior this method had before staged fan-in.
    ///
    /// New multi-keyboard callers use [`Self::upsert_device`] instead. Keeping
    /// replacement here matters: an existing surface's "choose another
    /// keyboard" action must not silently turn into "add another keyboard".
    pub fn choose_device(&self, device: StagedDevice) -> Result<Self, StageRefusal> {
        let device = normalize_device(device)?;
        let mut next = self.clone();
        next.devices = vec![device.clone()];
        for slot in &mut next.slots {
            slot.routes = vec![StagedRoute {
                selector: device.selector.clone(),
                preset: slot.preset.clone(),
            }];
        }
        Ok(next)
    }

    /// Add a keyboard without replacing any earlier one, or update the
    /// metadata of the same selector in place.
    ///
    /// Selector equality is the upsert key. Updating an alias, label or
    /// backend therefore cannot duplicate a physical source or move it in the
    /// authored order, and every existing route remains attached.
    pub fn upsert_device(&self, device: StagedDevice) -> Result<Self, StageRefusal> {
        let device = normalize_device(device)?;
        if let Some(other) = self
            .devices
            .iter()
            .find(|other| other.selector != device.selector && other.alias == device.alias)
        {
            return Err(StageRefusal::DuplicateAlias {
                alias: device.alias.clone(),
                selector: device.selector.to_string(),
                other: other.selector.to_string(),
            });
        }
        let mut next = self.clone();
        if let Some(existing) = next
            .devices
            .iter_mut()
            .find(|existing| existing.selector == device.selector)
        {
            *existing = device;
            return Ok(next);
        }

        let first = next.devices.is_empty();
        next.devices.push(device.clone());
        if first {
            for slot in &mut next.slots {
                if slot.routes.is_empty() {
                    slot.routes.push(StagedRoute {
                        selector: device.selector.clone(),
                        preset: slot.preset.clone(),
                    });
                }
            }
        }
        Ok(next)
    }

    /// Additive spelling for [`Self::upsert_device`]. A repeated selector is
    /// an in-place metadata update, never a duplicate row.
    pub fn add_device(&self, device: StagedDevice) -> Result<Self, StageRefusal> {
        self.upsert_device(device)
    }

    /// Remove one staged keyboard and only the routes that name it.
    /// Controllers and routes owned by other keyboards remain untouched.
    pub fn remove_device(&self, selector: &DeviceSelector) -> Result<Self, StageRefusal> {
        if !self
            .devices
            .iter()
            .any(|device| &device.selector == selector)
        {
            return Err(StageRefusal::NoSuchDevice {
                selector: selector.to_string(),
            });
        }
        let mut next = self.clone();
        next.devices.retain(|device| &device.selector != selector);
        for slot in &mut next.slots {
            slot.routes.retain(|route| &route.selector != selector);
            sync_compatibility_preset(slot);
        }
        Ok(next)
    }

    /// Change only one staged device's capture backend, provided it is still
    /// the selector the caller prepared.
    ///
    /// Comparing typed selectors is the stale-action guard: a UAC prompt may
    /// remain open while another tab chooses a different board.  The completed
    /// preparation must never overwrite that newer choice.
    pub fn set_device_backend(
        &self,
        expected: &DeviceSelector,
        backend: StageCaptureBackend,
    ) -> Result<Self, StageRefusal> {
        let Some(index) = self
            .devices
            .iter()
            .position(|device| &device.selector == expected)
        else {
            return Err(StageRefusal::DeviceChanged {
                expected: expected.to_string(),
                current: staged_devices_description(&self.devices),
            });
        };
        let mut next = self.clone();
        next.devices[index].backend = backend;
        Ok(next)
    }

    /// Stage a controller in `number`, presenting itself as `persona`, with
    /// `preset` as its bindings so far.
    pub fn add_slot(
        &self,
        number: u8,
        persona: Persona,
        preset: Preset,
    ) -> Result<Self, StageRefusal> {
        check_slot_number(number)?;
        if self.slot(number).is_some() {
            return Err(StageRefusal::SlotTaken { number });
        }
        check_pluggable(persona)?;
        let mut next = self.clone();
        let routes = self
            .device()
            .map(|device| {
                vec![StagedRoute {
                    selector: device.selector.clone(),
                    preset: preset.clone(),
                }]
            })
            .unwrap_or_default();
        next.slots.push(StagedSlot {
            number,
            persona,
            preset,
            socd: Socd::default(),
            routes,
        });
        next.slots.sort_by_key(|s| s.number);
        next.check_persona_capacity(number, persona)?;
        next.check_xinput_ceiling(number)?;
        next.check_hidmaestro_pool(number)?;
        Ok(next)
    }

    /// Stage a controller whose initial bindings belong to one explicit
    /// keyboard. This is the source-qualified counterpart to [`Self::add_slot`]
    /// and does not implicitly route the compatibility/first keyboard.
    pub fn add_slot_for_source(
        &self,
        number: u8,
        persona: Persona,
        selector: &DeviceSelector,
        preset: Preset,
    ) -> Result<Self, StageRefusal> {
        self.require_device(selector)?;
        let mut next = self.add_slot(number, persona, preset.clone())?;
        let slot = next
            .slots
            .iter_mut()
            .find(|slot| slot.number == number)
            .expect("add_slot inserted it");
        slot.routes = vec![StagedRoute {
            selector: selector.clone(),
            preset,
        }];
        sync_compatibility_preset(slot);
        Ok(next)
    }

    /// Stage a controller in the lowest free slot — the "Add a controller"
    /// button, which must not make a first-run user pick a number.
    pub fn add_next_slot(&self, persona: Persona, preset: Preset) -> Result<Self, StageRefusal> {
        let number = self.next_free_slot().ok_or(StageRefusal::NoFreeSlot)?;
        self.add_slot(number, persona, preset)
    }

    /// Change what a staged slot presents itself as — moment 5's "and they can
    /// change their mind freely".
    pub fn set_persona(&self, number: u8, persona: Persona) -> Result<Self, StageRefusal> {
        check_slot_number(number)?;
        check_pluggable(persona)?;
        let mut next = self.clone();
        let slot = next
            .slots
            .iter_mut()
            .find(|s| s.number == number)
            .ok_or(StageRefusal::NoSuchSlot { number })?;
        slot.persona = persona;
        next.check_persona_capacity(number, persona)?;
        next.check_xinput_ceiling(number)?;
        next.check_hidmaestro_pool(number)?;
        Ok(next)
    }

    /// Replace a staged slot's bindings wholesale.
    ///
    /// Whole-preset, never per-key, for the reason `ControlSource::bind_keys`
    /// gives: the editor already holds the whole grid, so it can always send
    /// all of it, and a partial protocol carries indices computed against a
    /// value that may have moved.
    pub fn set_bindings(&self, number: u8, preset: Preset) -> Result<Self, StageRefusal> {
        check_slot_number(number)?;
        let mut next = self.clone();
        let slot = next
            .slots
            .iter_mut()
            .find(|s| s.number == number)
            .ok_or(StageRefusal::NoSuchSlot { number })?;
        slot.preset = preset.clone();
        if let Some(route) = slot.routes.first_mut() {
            route.preset = preset;
        } else if let Some(device) = next.devices.first() {
            slot.routes.push(StagedRoute {
                selector: device.selector.clone(),
                preset,
            });
        }
        Ok(next)
    }

    /// Add or replace one source-qualified mapping route on a staged slot.
    /// Existing routes for other keyboards are left byte-for-byte intact.
    pub fn set_source_bindings(
        &self,
        number: u8,
        selector: &DeviceSelector,
        preset: Preset,
    ) -> Result<Self, StageRefusal> {
        check_slot_number(number)?;
        self.require_device(selector)?;
        let mut next = self.clone();
        let slot = next
            .slots
            .iter_mut()
            .find(|slot| slot.number == number)
            .ok_or(StageRefusal::NoSuchSlot { number })?;
        if let Some(route) = slot
            .routes
            .iter_mut()
            .find(|route| &route.selector == selector)
        {
            route.preset = preset;
        } else {
            slot.routes.push(StagedRoute {
                selector: selector.clone(),
                preset,
            });
        }
        sort_routes(&next.devices, slot);
        sync_compatibility_preset(slot);
        Ok(next)
    }

    /// Remove one keyboard's route from one controller without removing the
    /// keyboard or any of its routes to other controllers.
    pub fn remove_source_bindings(
        &self,
        number: u8,
        selector: &DeviceSelector,
    ) -> Result<Self, StageRefusal> {
        check_slot_number(number)?;
        self.require_device(selector)?;
        let Some(staged) = self.slot(number) else {
            return Err(StageRefusal::NoSuchSlot { number });
        };
        if staged.route(selector).is_none() {
            return Err(StageRefusal::NoSuchRoute {
                number,
                selector: selector.to_string(),
            });
        }
        let mut next = self.clone();
        let slot = next
            .slots
            .iter_mut()
            .find(|slot| slot.number == number)
            .expect("checked above");
        slot.routes.retain(|route| &route.selector != selector);
        sync_compatibility_preset(slot);
        Ok(next)
    }

    /// **Delete a staged controller. Free and complete** — no file, no backup,
    /// no trace, because there was never one to begin with.
    pub fn remove_slot(&self, number: u8) -> Result<Self, StageRefusal> {
        check_slot_number(number)?;
        if self.slot(number).is_none() {
            return Err(StageRefusal::NoSuchSlot { number });
        }
        let mut next = self.clone();
        next.slots.retain(|s| s.number != number);
        Ok(next)
    }

    /// Set what a staged slot does with simultaneous opposing directions —
    /// the same choice `ksx slot assign --socd` writes onto a saved slot,
    /// made while the setup is still free to change.
    pub fn set_socd(&self, number: u8, socd: Socd) -> Result<Self, StageRefusal> {
        check_slot_number(number)?;
        let mut next = self.clone();
        let slot = next
            .slots
            .iter_mut()
            .find(|s| s.number == number)
            .ok_or(StageRefusal::NoSuchSlot { number })?;
        slot.socd = socd;
        Ok(next)
    }

    /// **Reorder the staged controllers.** `order` is the CURRENT slot numbers
    /// in the desired new sequence — a whole-order write, the same
    /// whole-value rule `set_bindings` follows, so a drag that raced a poll
    /// carries its entire intent rather than a delta computed against a value
    /// that moved.
    ///
    /// The result is renumbered contiguously 1..=n: dropping P3 onto P1 makes
    /// it P1 and shifts the rest down, which is what "player 2" then MEANS —
    /// each controller keeps its persona, its bindings and its SOCD answer,
    /// and only the number (the XInput position, the preset a layout refers
    /// to by player) changes. Renumbering never re-instantiates a layout.
    pub fn reorder_slots(&self, order: &[u8]) -> Result<Self, StageRefusal> {
        let mut staged: Vec<u8> = self.slots.iter().map(|s| s.number).collect();
        let mut given: Vec<u8> = order.to_vec();
        staged.sort_unstable();
        given.sort_unstable();
        if staged != given {
            return Err(StageRefusal::BadReorder {
                staged: join_numbers(&staged),
                given: join_numbers(order),
            });
        }
        let mut next = self.clone();
        next.slots = order
            .iter()
            .enumerate()
            .map(|(index, number)| {
                let slot = self.slot(*number).expect("membership checked above");
                StagedSlot {
                    number: u8::try_from(index + 1).expect("bounded by MAX_SLOTS"),
                    ..slot.clone()
                }
            })
            .collect();
        Ok(next)
    }

    /// Answer the split-or-freeze question (`docs/FIRST-RUN.md` §3).
    #[must_use]
    pub fn set_blocking(&self, blocking: Blocking) -> Self {
        let mut next = self.clone();
        next.blocking = Some(blocking);
        next
    }

    /// **"Start over".** Infallible on purpose: §2 requires that a staged setup
    /// can be discarded wholesale, and a discard that could refuse would be a
    /// way to get stuck in a setup you did not want.
    #[must_use]
    pub fn discard(&self) -> Self {
        Self::default()
    }

    /// Turn this into the one typed value a save and a play are both built
    /// from, or refuse.
    ///
    /// Re-checks every rule an operation already checked. That is deliberate
    /// and cheap: it makes the spec's validity a property of the SPEC rather
    /// than of the sequence of calls that produced it, so a future operation
    /// that forgets a rule cannot leak a bad setup past here.
    pub fn commit(&self) -> Result<CommitSpec, StageRefusal> {
        if self.devices.is_empty() {
            return Err(StageRefusal::NoDevice {
                slots: self.slots.len(),
            });
        }
        if self.slots.is_empty() {
            return Err(StageRefusal::NoSlots);
        }
        self.check_device_aliases()?;
        self.check_preset_names()?;

        let mut slots = Vec::with_capacity(self.slots.len());
        for staged in &self.slots {
            check_pluggable(staged.persona)?;
            if staged.routes.is_empty() {
                return Err(StageRefusal::NoSources {
                    number: staged.number,
                });
            }
            // A pad with no bindings plugs and does nothing. Both exits are
            // built from this value, so refusing here refuses SAVE and PLAY
            // with one rule — and `StagedSetupView::ready` reads this same
            // result, so the buttons are never offered for it in the first
            // place.
            if staged.routes.len() == 1 && staged.routes[0].preset.binds_nothing() {
                return Err(StageRefusal::NoBindings {
                    number: staged.number,
                    preset: staged.routes[0].preset.name.clone(),
                });
            }
            if let Some(route) = staged
                .routes
                .iter()
                .find(|route| route.preset.binds_nothing())
            {
                return Err(StageRefusal::NoRouteBindings {
                    number: staged.number,
                    selector: route.selector.to_string(),
                    preset: route.preset.name.clone(),
                });
            }

            let mut sources = Vec::with_capacity(staged.routes.len());
            for route in &staged.routes {
                let routed_device = self
                    .devices
                    .iter()
                    .find(|device| device.selector == route.selector)
                    .ok_or_else(|| StageRefusal::NoSuchDevice {
                        selector: route.selector.to_string(),
                    })?;
                // `from_selector`, not `parse(&to_string())`: this is a value
                // ksx is writing for the first time, so the canonical spelling
                // IS the written one.
                let keyboard =
                    crate::selector::DeviceRef::from_selector(routed_device.selector.clone())
                        .as_device_id();
                sources.push(SourceSpec::keyboard(keyboard, route.preset.name.clone()));
            }

            let primary = staged.routes[0].preset.clone();
            let spec = SlotSpec::from_sources(staged.number, sources, primary.name.clone())
                .map_err(|err| StageRefusal::BadSlot { given: err.0 })?
                .with_persona(staged.persona)
                .with_socd(staged.socd);
            let mut additional_presets = Vec::new();
            for route in &staged.routes[1..] {
                if !route.preset.name.eq_ignore_ascii_case(&primary.name)
                    && !additional_presets
                        .iter()
                        .any(|preset: &Preset| preset.name.eq_ignore_ascii_case(&route.preset.name))
                {
                    additional_presets.push(route.preset.clone());
                }
            }
            slots
                .push(ResolvedSlot::new(spec, primary).with_additional_presets(additional_presets));
        }
        let xinput = self.xinput_slots();
        if xinput > usize::from(MAX_XINPUT_SLOTS) {
            return Err(StageRefusal::TooManyXinputSlots {
                number: self
                    .slots
                    .iter()
                    .filter(|s| s.persona.is_xinput())
                    .map(|s| s.number)
                    .next_back()
                    .unwrap_or(0),
                after: xinput,
            });
        }
        for persona in Persona::ALL.iter().copied() {
            self.check_persona_capacity(
                self.slots
                    .iter()
                    .filter(|slot| slot.persona == persona)
                    .map(|slot| slot.number)
                    .next_back()
                    .unwrap_or(0),
                persona,
            )?;
        }
        // LAST, because it is moment 6 and the others are moments 4 and 5: a
        // user who has not yet added a controller should be told that, not
        // asked about blocking. An unanswered question resolved to
        // `Blocking::default()` here is the whole reason this refusal exists —
        // see `StageRefusal::BlockingUnanswered`.
        let Some(blocking) = self.blocking else {
            return Err(StageRefusal::BlockingUnanswered);
        };
        // Canvas membership is broader than the runnable graph: a user may
        // intentionally place a spare keyboard without mapping it yet. Save
        // and Play must not capture or persist that inert board. Preserve the
        // staged roster's order, but carry only devices referenced by at least
        // one controller route; the first routed device is the legacy
        // compatibility field.
        let devices = self
            .devices
            .iter()
            .filter(|device| {
                self.slots.iter().any(|slot| {
                    slot.routes
                        .iter()
                        .any(|route| route.selector == device.selector)
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        let device = devices
            .first()
            .cloned()
            .expect("every committed slot established at least one routed staged device");
        Ok(CommitSpec {
            device,
            devices,
            slots,
            blocking,
        })
    }

    /// Refuse a state where a fifth slot would sit on an XInput persona.
    ///
    /// `number` is the slot the caller just touched, so the refusal can name
    /// the one to change.
    fn check_xinput_ceiling(&self, number: u8) -> Result<(), StageRefusal> {
        let after = self.xinput_slots();
        if after > usize::from(MAX_XINPUT_SLOTS) {
            return Err(StageRefusal::TooManyXinputSlots { number, after });
        }
        Ok(())
    }

    /// Refuse a state with more controllers than the HIDMaestro host carries.
    ///
    /// The source-built host carries [`MAX_HIDMAESTRO_PADS`] live pads; a
    /// configuration past that would validate, save, and then die at the
    /// next plug of startup — after another pad was already live.
    fn check_hidmaestro_pool(&self, number: u8) -> Result<(), StageRefusal> {
        let after = self
            .slots
            .iter()
            .filter(|s| s.persona.backend() == crate::PadBackend::HidMaestro)
            .count();
        if after > usize::from(MAX_HIDMAESTRO_PADS) {
            return Err(StageRefusal::TooManyHidMaestroPads { number, after });
        }
        Ok(())
    }

    fn check_persona_capacity(&self, number: u8, persona: Persona) -> Result<(), StageRefusal> {
        let Some(limit) = persona.instance_limit() else {
            return Ok(());
        };
        let after = self.persona_slots(persona);
        if after > limit {
            return Err(StageRefusal::PersonaCapacity {
                number,
                persona,
                after,
                limit,
            });
        }
        Ok(())
    }

    fn require_device(&self, selector: &DeviceSelector) -> Result<(), StageRefusal> {
        if self
            .devices
            .iter()
            .any(|device| &device.selector == selector)
        {
            return Ok(());
        }
        Err(StageRefusal::NoSuchDevice {
            selector: selector.to_string(),
        })
    }

    /// Alias resolution in `ksx-config` is exact and first-match. Two
    /// different selectors with the same alias would therefore make one set
    /// of committed routes silently target the other keyboard.
    fn check_device_aliases(&self) -> Result<(), StageRefusal> {
        for (index, device) in self.devices.iter().enumerate() {
            for other in &self.devices[index + 1..] {
                if device.alias == other.alias && device.selector != other.selector {
                    return Err(StageRefusal::DuplicateAlias {
                        alias: device.alias.clone(),
                        selector: device.selector.to_string(),
                        other: other.selector.to_string(),
                    });
                }
            }
        }
        Ok(())
    }

    /// One preset name is one preset file. Two staged slots may share a name
    /// only when they share the bindings too. The same rule spans every route:
    /// a second keyboard's preset is still written to the same presets folder.
    fn check_preset_names(&self) -> Result<(), StageRefusal> {
        let routed: Vec<(u8, &Preset)> = self
            .slots
            .iter()
            .flat_map(|slot| {
                if slot.routes.is_empty() {
                    vec![(slot.number, &slot.preset)]
                } else {
                    slot.routes
                        .iter()
                        .map(|route| (slot.number, &route.preset))
                        .collect()
                }
            })
            .collect();
        for (index, (number, preset)) in routed.iter().enumerate() {
            if preset.name.trim().is_empty() {
                return Err(StageRefusal::UnnamedPreset { number: *number });
            }
            for (other_number, other) in &routed[index + 1..] {
                if other.name.eq_ignore_ascii_case(&preset.name) && *other != *preset {
                    return Err(StageRefusal::PresetNameClash {
                        number: *number,
                        other: *other_number,
                        name: preset.name.clone(),
                    });
                }
            }
        }
        Ok(())
    }
}

fn normalize_device(device: StagedDevice) -> Result<StagedDevice, StageRefusal> {
    let alias = device.alias.trim();
    if alias.is_empty() {
        return Err(StageRefusal::BadAlias {
            alias: device.alias.clone(),
            problem: "an alias is the short name a [[slot]] refers to, and an empty one \
                      refers to nothing",
        });
    }
    if alias.contains('\\') {
        return Err(StageRefusal::BadAlias {
            alias: device.alias.clone(),
            problem: "a value containing a backslash is read as a literal device path \
                      everywhere else in the config, so it could never resolve back to this \
                      entry",
        });
    }
    Ok(StagedDevice {
        alias: alias.to_owned(),
        ..device
    })
}

fn sort_routes(devices: &[StagedDevice], slot: &mut StagedSlot) {
    slot.routes.sort_by_key(|route| {
        devices
            .iter()
            .position(|device| device.selector == route.selector)
            .unwrap_or(usize::MAX)
    });
}

/// Keep the public single-preset view aligned with the canonical first route.
/// When the last route is removed, retain the previous value as the pending
/// preset legacy callers expect to survive until another device is chosen.
fn sync_compatibility_preset(slot: &mut StagedSlot) {
    if let Some(route) = slot.routes.first() {
        slot.preset = route.preset.clone();
    }
}

fn staged_devices_description(devices: &[StagedDevice]) -> String {
    match devices {
        [] => "no keyboard is currently staged".to_owned(),
        [device] => format!("'{}'", device.selector),
        _ => format!(
            "staged keyboards [{}]",
            devices
                .iter()
                .map(|device| device.selector.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

fn check_slot_number(number: u8) -> Result<(), StageRefusal> {
    if number == 0 || number > MAX_SLOTS {
        return Err(StageRefusal::BadSlot { given: number });
    }
    Ok(())
}

/// Refuse a persona this BUILD cannot create, in [`crate::Persona`]'s own
/// words.
///
/// Reads [`Persona::can_plug`] and nothing else — never a driver probe, for the
/// reason that method's doc comment gives: a probe answers "is HIDMaestro
/// installed", whose answer flips to yes while `create_controller` still has
/// nothing to call.
fn check_pluggable(persona: Persona) -> Result<(), StageRefusal> {
    if persona.can_plug() {
        return Ok(());
    }
    let backend = persona.backend();
    Err(StageRefusal::PersonaNotImplemented {
        persona,
        backend: backend.label(),
        reason: persona
            .gap()
            .unwrap_or("this build ships no code that can create it"),
        instead: persona.nearest_pluggable(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::{DeviceId, KeyEvent};
    use crate::engine::Engine;
    use crate::key::Key;
    use crate::pad::{XButton, XButtons};
    use crate::preset::Binding;

    fn device() -> StagedDevice {
        StagedDevice {
            selector: DeviceSelector::parse("usb:d209:0430:00").unwrap(),
            alias: "panel".to_owned(),
            label: "Ultimarc I-PAC 4".to_owned(),
            backend: StageCaptureBackend::Interception,
        }
    }

    fn other_device() -> StagedDevice {
        StagedDevice {
            selector: DeviceSelector::parse("usb:046d:c31c:00").unwrap(),
            alias: "desk".to_owned(),
            label: "Logitech keyboard".to_owned(),
            backend: StageCaptureBackend::Interception,
        }
    }

    fn preset(name: &str) -> Preset {
        routed_preset(name, Key::A, XButton::A)
    }

    fn routed_preset(name: &str, key: Key, button: XButton) -> Preset {
        Preset {
            name: name.to_owned(),
            entries: vec![(key, Binding::Button(button))],
            chords: Vec::new(),
            macros: Default::default(),
            turbo: Vec::new(),
            toggle: Vec::new(),
            protected: false,
        }
    }

    fn event(device: &DeviceId, key: Key, down: bool) -> KeyEvent {
        KeyEvent {
            device: device.clone(),
            key,
            down,
            t: 0,
        }
    }

    fn staged() -> StagedSetup {
        StagedSetup::new()
            .choose_device(device())
            .unwrap()
            .add_slot(1, Persona::Xbox360, preset("Player 1"))
            .unwrap()
    }

    /// SOCD answered in the stage travels into the ONE CommitSpec both exits
    /// read — the property that makes staging it meaningful at all. Fails
    /// against a commit that rebuilt SlotSpec without carrying it (which is
    /// exactly what commit did before staged SOCD existed).
    #[test]
    fn a_staged_socd_answer_reaches_the_commit_spec() {
        let setup = staged()
            .set_socd(1, Socd::UpPriority)
            .expect("slot 1 is staged")
            .set_blocking(Blocking::BoundKeys);
        assert_eq!(setup.slot(1).unwrap().socd, Socd::UpPriority);
        let spec = setup.commit().expect("complete setup commits");
        assert_eq!(spec.slots[0].spec.socd, Socd::UpPriority);

        // Unanswered stays the same default a saved slot starts on.
        let default = staged().set_blocking(Blocking::BoundKeys);
        assert_eq!(default.slot(1).unwrap().socd, Socd::Off);
        assert_eq!(default.commit().unwrap().slots[0].spec.socd, Socd::Off);

        let missing = staged().set_socd(9, Socd::Neutral).unwrap_err();
        assert_eq!(missing.code(), "no-such-slot");
    }

    /// Reordering renumbers contiguously and keeps every controller WHOLE —
    /// persona, bindings and SOCD move with their controller, only the number
    /// changes. Fails against a reorder that re-instantiated layouts (the
    /// bindings would revert) or that dropped SOCD (a leverless panel's
    /// cleaner silently off after a drag).
    #[test]
    fn reordering_renumbers_contiguously_and_moves_controllers_whole() {
        let setup = staged()
            .add_slot(2, Persona::PlayStation, preset("Player 2"))
            .unwrap()
            .add_slot(3, Persona::Xbox360, preset("Player 3"))
            .unwrap()
            .set_socd(3, Socd::Neutral)
            .unwrap();

        let reordered = setup.reorder_slots(&[3, 1, 2]).expect("a real permutation");
        let slots = reordered.slots();
        assert_eq!(
            slots.iter().map(|s| s.number).collect::<Vec<_>>(),
            [1, 2, 3],
            "renumbered contiguously"
        );
        assert_eq!(slots[0].preset.name, "Player 3");
        assert_eq!(
            slots[0].socd,
            Socd::Neutral,
            "SOCD moved with its controller"
        );
        assert_eq!(slots[1].preset.name, "Player 1");
        assert_eq!(slots[2].persona, Persona::PlayStation);
        assert_eq!(slots[2].preset.name, "Player 2");
    }

    /// A whole-order write that does not name exactly the staged slots is
    /// refused whole — a dropped number would silently delete a controller,
    /// an invented one would stage a ghost.
    #[test]
    fn a_reorder_that_is_not_a_permutation_is_refused_whole() {
        let setup = staged()
            .add_slot(2, Persona::PlayStation, preset("Player 2"))
            .unwrap();
        for bad in [&[1_u8][..], &[1, 2, 3], &[1, 1], &[2, 7]] {
            let refusal = setup.reorder_slots(bad).unwrap_err();
            assert_eq!(refusal.code(), "bad-reorder", "{bad:?}");
            // ...and the caller still holds what they had.
            assert_eq!(setup.slots().len(), 2);
        }
        // Sparse numbering compacts: {1,3} reordered as [3,1] becomes {1,2}.
        let sparse = staged()
            .add_slot(3, Persona::PlayStation, preset("Player 3"))
            .unwrap();
        let compact = sparse.reorder_slots(&[3, 1]).unwrap();
        assert_eq!(
            compact.slots().iter().map(|s| s.number).collect::<Vec<_>>(),
            [1, 2]
        );
        assert_eq!(compact.slots()[0].preset.name, "Player 3");
    }

    /// **The moment §2 exists for.** Pick PS4, look at it, change to Xbox 360,
    /// then delete the controller entirely — and every one of those is a value
    /// in memory.
    ///
    /// Breaks against the pre-staging design, in which each of these four acts
    /// was a `config.toml` write plus a timestamped backup. There is no file
    /// here to assert on, which IS the assertion: the type has no path to one.
    #[test]
    fn a_user_can_change_their_mind_four_times_and_nothing_is_written() {
        let ps4 = staged()
            .set_persona(1, Persona::PlayStation)
            .expect("PlayStation plugs");
        assert_eq!(ps4.slot(1).unwrap().persona, Persona::PlayStation);

        let xbox = ps4.set_persona(1, Persona::Xbox360).unwrap();
        assert_eq!(xbox.slot(1).unwrap().persona, Persona::Xbox360);

        // Deleting is free and COMPLETE: no trace of slot 1 anywhere.
        let gone = xbox.remove_slot(1).unwrap();
        assert!(gone.slots().is_empty());
        assert_eq!(gone.slot(1), None);
        // ...and the device survives, because deleting a controller is not
        // starting over.
        assert_eq!(gone.device(), Some(&device()));

        // "Start over" always works, from any state, and cannot refuse.
        assert!(xbox.discard().is_empty());
        assert!(StagedSetup::new().discard().is_empty());
    }

    /// A refusal leaves the caller holding exactly what it had.
    ///
    /// Breaks against a `&mut self` design that validates as it mutates: those
    /// leave the fifth Xbox slot pushed onto the list and then report failure,
    /// so the next read shows a slot the user was told they could not have.
    #[test]
    fn a_refusal_changes_nothing_at_all() {
        let four = (1..=4).fold(
            StagedSetup::new().choose_device(device()).unwrap(),
            |setup, n| {
                setup
                    .add_slot(n, Persona::Xbox360, preset(&format!("P{n}")))
                    .unwrap()
            },
        );
        let refused = four
            .add_slot(5, Persona::Xbox360, preset("P5"))
            .unwrap_err();
        assert_eq!(refused.code(), "too-many-xinput-slots");
        assert_eq!(
            four.slots().len(),
            4,
            "the setup the caller holds is intact"
        );
        assert_eq!(four.xinput_slots(), 4);
    }

    /// The XInput ceiling is Windows', the slot ceiling is ours, and the two
    /// are different numbers — which is exactly how players 5+ exist.
    ///
    /// Breaks against a stage that counted slots instead of
    /// `Persona::is_xinput()`: that version refuses the PlayStation slot 5 that
    /// is the entire point of the persona, or waves through a fifth Xbox pad
    /// that plugs and that no game will ever read.
    #[test]
    fn a_fifth_xbox_slot_is_refused_and_a_fifth_playstation_slot_is_not() {
        let four = (1..=4).fold(
            StagedSetup::new().choose_device(device()).unwrap(),
            |setup, n| {
                setup
                    .add_slot(n, Persona::Xbox360, preset(&format!("P{n}")))
                    .unwrap()
            },
        );
        let refused = four
            .add_slot(5, Persona::Xbox360, preset("P5"))
            .unwrap_err();
        let message = refused.to_string();
        assert!(message.contains("is_xinput()"), "names the rule: {message}");
        assert!(message.contains("playstation"), "{message}");
        assert!(
            message.contains("Nothing has been written"),
            "a staged refusal must say the change is still free: {message}"
        );

        let fifth = four
            .add_slot(5, Persona::PlayStation, preset("P5"))
            .expect("plain HID takes none of the four");
        assert_eq!(fifth.slots().len(), 5);
        assert_eq!(fifth.xinput_slots(), 4);

        // ...and re-personaing that fifth slot back to Xbox is the same
        // refusal, so the two doors into the state are one rule.
        assert_eq!(
            fifth.set_persona(5, Persona::Xbox360).unwrap_err().code(),
            "too-many-xinput-slots"
        );
    }

    /// Only personas backed by a shipped production runtime are stageable.
    #[test]
    fn stage_accepts_shipped_personas_and_refuses_gated_profiles() {
        for persona in [Persona::Xbox360, Persona::PlayStation, Persona::DualSense] {
            let result = staged().add_slot(2, persona, preset("P2"));
            result.unwrap_or_else(|refused| panic!("{persona} must stage: {refused}"));
        }
        for persona in [
            Persona::SwitchPro,
            Persona::XboxSeries,
            Persona::Snes,
            Persona::Genesis,
        ] {
            let refused = staged()
                .add_slot(2, persona, preset("P2"))
                .expect_err("a gated profile must not stage");
            assert_eq!(refused.code(), "persona-not-implemented", "{persona}");
        }
    }

    /// The source-built host carries [`MAX_HIDMAESTRO_PADS`] live pads, and
    /// staging refuses the next pad before it can reach that host.
    #[test]
    fn a_second_hidmaestro_pad_is_refused_before_it_can_reach_the_host() {
        // Slot 1 is `staged()`'s Xbox360 pad — ViGEmBus, outside the pool — so
        // the pool fills over slots 2..=MAX_HIDMAESTRO_PADS + 1 and the pad
        // that overflows it is the one after that. Derived rather than spelled
        // concrete values because the panic below already counts "pad N of
        // MAX_HIDMAESTRO_PADS": a loop bound that disagreed with it would stage
        // the wrong number of pads while reporting the right one.
        let last_in_pool = MAX_HIDMAESTRO_PADS + 1;
        let overflow = last_in_pool + 1;
        let mut setup = staged();
        for n in 2u8..=last_in_pool {
            setup = setup
                .add_slot(n, Persona::DualSense, preset("P"))
                .unwrap_or_else(|e| {
                    panic!("pad {} of {MAX_HIDMAESTRO_PADS} must stage: {e}", n - 1)
                });
        }
        let refused = setup
            .add_slot(overflow, Persona::DualSense, preset("P-overflow"))
            .unwrap_err();
        assert_eq!(refused.code(), "too-many-hidmaestro-pads");
        let message = refused.to_string();
        // The NUMBER comes from the constant that owns it; the words around it
        // are this module's, and this line is the one place that locks them.
        // A literal would be another copy of a number ksx-config,
        // ksx-backend and ksx-output also assert — raise the ceiling and each
        // fails on its own, with nothing in any of the four messages saying
        // they are the same fact.
        assert!(
            message.contains(&format!("live-pad capacity of {MAX_HIDMAESTRO_PADS}")),
            "{message}"
        );
        assert!(message.contains("xbox360"), "{message}");

        // The same gate on the other door: repainting a ViGEm slot onto the
        // full pool exceeds the host in the same way.
        let with_other = setup
            .add_slot(overflow, Persona::PlayStation, preset("P-overflow"))
            .unwrap();
        assert_eq!(
            with_other
                .set_persona(overflow, Persona::DualSense)
                .unwrap_err()
                .code(),
            "too-many-hidmaestro-pads"
        );
    }

    /// MAX_SLOTS is the total ceiling, and it is ksx's own — the refusal says
    /// so rather than implying Windows imposed it.
    #[test]
    fn the_slot_ceiling_is_max_slots_and_the_refusals_name_the_live_bound() {
        let mut setup = StagedSetup::new().choose_device(device()).unwrap();
        for n in 1..=MAX_SLOTS {
            // PlayStation throughout: this test is about the TOTAL, and four
            // XInput slots would stop it at five for the other reason.
            setup = setup
                .add_slot(n, Persona::PlayStation, preset(&format!("P{n}")))
                .expect("every slot up to the ceiling");
        }
        assert_eq!(setup.next_free_slot(), None);
        assert_eq!(
            setup
                .add_next_slot(Persona::PlayStation, preset("P17"))
                .unwrap_err(),
            StageRefusal::NoFreeSlot
        );
        // A number off the end is refused by the same check `SlotSpec::new`
        // makes, quoting the live bound.
        let off = setup
            .add_slot(MAX_SLOTS + 1, Persona::PlayStation, preset("X"))
            .unwrap_err();
        assert_eq!(off.code(), "bad-slot");
        assert!(off.to_string().contains(&MAX_SLOTS.to_string()));
        assert_eq!(
            StagedSetup::new()
                .add_slot(0, Persona::Xbox360, preset("X"))
                .unwrap_err()
                .code(),
            "bad-slot"
        );
    }

    /// **"Not asked yet" and "the user chose Freeze" are different facts, and
    /// the difference reaches all the way to the commit.**
    ///
    /// Breaks against the shipped version, in which `commit()` read
    /// `effective_blocking()` — `self.blocking.unwrap_or_default()`. That one
    /// collapses the two into `Blocking::Whole` at the last step, so
    /// `ready` (which IS `commit().is_ok()`) was true with the question
    /// unanswered: Save was offered, and it wrote `block_keyboards = "whole"`
    /// from a question the user had never been shown. All of §3's care —
    /// `Option<Blocking>`, a screen that refuses to pre-select — leaked out
    /// here.
    ///
    /// Also breaks against `blocking: Blocking` (no Option), which cannot tell
    /// a surface whether §3's one question has been put to the user at all.
    #[test]
    fn an_unanswered_split_or_freeze_question_is_refused_rather_than_defaulted() {
        let setup = staged();
        assert_eq!(setup.blocking(), None, "nobody has been asked");

        let refused = setup.commit().unwrap_err();
        assert_eq!(refused.code(), "blocking-unanswered");
        let message = refused.to_string();
        assert!(
            message.contains("no default"),
            "the refusal has to say the silence is deliberate: {message}"
        );
        assert!(message.contains("bound-keys"), "{message}");

        // Answering it — with EITHER answer — is what makes the setup
        // committable, and the answer is what the spec carries.
        for answer in [Blocking::Whole, Blocking::BoundKeys, Blocking::Off] {
            let spec = setup
                .set_blocking(answer)
                .commit()
                .expect("an answered question commits");
            assert_eq!(spec.blocking, answer);
        }

        // Answering "freeze" is an ANSWER, not a return to silence.
        let freeze = setup
            .set_blocking(Blocking::BoundKeys)
            .set_blocking(Blocking::Whole);
        assert_eq!(freeze.blocking(), Some(Blocking::Whole));
        assert!(!freeze.is_empty());
    }

    /// **A staged controller that binds nothing is refused by BOTH exits.**
    ///
    /// Breaks against the shipped `commit()`, which never looked at the
    /// bindings: `StageEdit::AddSlot` stages `entries: Vec::new()`, `ready`
    /// was therefore true the instant a persona was picked, and Play plugged a
    /// pad on which every button was dead — while the screen said "ready".
    ///
    /// The placeholder half is the one that would survive a naive fix:
    /// `builtin_empty()` lists every control with a `Key::None` row, so an
    /// `entries.is_empty()` check calls a preset that binds nothing "mapped".
    #[test]
    fn a_controller_that_binds_nothing_cannot_be_saved_or_played() {
        let blank = Preset {
            name: "Player 1".to_owned(),
            entries: Vec::new(),
            chords: Vec::new(),
            macros: Default::default(),
            turbo: Vec::new(),
            toggle: Vec::new(),
            protected: false,
        };
        let setup = StagedSetup::new()
            .choose_device(device())
            .unwrap()
            .add_slot(1, Persona::Xbox360, blank)
            .expect("staging it is free — it is the COMMIT that refuses")
            .set_blocking(Blocking::Whole);

        let refused = setup.commit().unwrap_err();
        assert_eq!(refused.code(), "no-bindings");
        let message = refused.to_string();
        assert!(message.contains("slot 1"), "it names the slot: {message}");
        assert!(message.contains("Player 1"), "{message}");
        assert!(
            message.contains("Nothing has been written"),
            "a staged refusal says the fix is still free: {message}"
        );

        // The all-placeholder preset — every control present, nothing bound —
        // is the same refusal, not a pass.
        let placeholders = StagedSetup::new()
            .choose_device(device())
            .unwrap()
            .add_slot(1, Persona::Xbox360, Preset::builtin_empty())
            .unwrap()
            .set_blocking(Blocking::Whole);
        assert!(!placeholders.slot(1).unwrap().preset.entries.is_empty());
        assert_eq!(placeholders.commit().unwrap_err().code(), "no-bindings");

        // One live binding is enough — this is a floor, not a quality bar.
        let mapped = placeholders
            .set_bindings(1, preset("Player 1"))
            .unwrap()
            .commit()
            .expect("one bound key is a pad that does something");
        assert_eq!(mapped.slots.len(), 1);

        // ...and a slot the user has not touched is named individually, so a
        // four-player setup says WHICH pad is dead.
        let one_dead = mapped_setup()
            .add_slot(2, Persona::PlayStation, Preset::builtin_empty())
            .unwrap()
            .commit()
            .unwrap_err();
        assert_eq!(one_dead.code(), "no-bindings");
        assert!(one_dead.to_string().contains("slot 2"), "{one_dead}");
    }

    /// A device, one mapped controller and an answered question — the
    /// smallest setup that may be saved or played.
    fn mapped_setup() -> StagedSetup {
        staged().set_blocking(Blocking::Whole)
    }

    /// A device is staged as a SELECTOR — which board — and never as the raw
    /// path a scan happened to see.
    ///
    /// Breaks against a stage that carried the instance path: that value pins
    /// the setup to one USB socket, and it is the string §5 bans from ever
    /// being the identifier on screen.
    #[test]
    fn the_staged_device_is_a_selector_and_its_alias_can_never_be_a_path() {
        let setup = staged();
        let staged_device = setup.device().unwrap();
        assert_eq!(staged_device.selector.rung(), "model");
        assert!(staged_device.selector.survives_replug());
        assert_eq!(staged_device.label, "Ultimarc I-PAC 4");

        // An alias with a backslash is read as a literal device path
        // everywhere else in the config, so it could never resolve back here.
        let refused = StagedSetup::new()
            .choose_device(StagedDevice {
                alias: r"USB\VID_D209".to_owned(),
                ..device()
            })
            .unwrap_err();
        assert_eq!(refused.code(), "bad-alias");
        assert!(refused.to_string().contains("literal device path"));

        let blank = StagedSetup::new()
            .choose_device(StagedDevice {
                alias: "  ".to_owned(),
                ..device()
            })
            .unwrap_err();
        assert_eq!(blank.code(), "bad-alias");

        // Changing the device is free, and replaces the earlier choice.
        let other = DeviceSelector::parse("usb:f00d:beef:00").unwrap();
        let moved = setup
            .choose_device(StagedDevice {
                selector: other.clone(),
                alias: " logitech ".to_owned(),
                label: "Logitech keyboard".to_owned(),
                backend: StageCaptureBackend::Interception,
            })
            .unwrap();
        assert_eq!(moved.device().unwrap().selector, other);
        assert_eq!(moved.device().unwrap().alias, "logitech", "trimmed");
        assert_eq!(moved.slots().len(), 1, "the controllers are untouched");
    }

    /// Commit produces slots that name the chosen device and carry the staged
    /// persona and the staged bindings — the three things the screen showed.
    ///
    /// Breaks against a commit that dropped the keyboard (which is what
    /// `slots::assign` does for a slot it creates): the saved config plans to
    /// zero usable slots, because a slot with no input device is dropped with
    /// `NoInputDeviceSelected`, and the cabinet is dead with four pads missing.
    #[test]
    fn commit_carries_the_device_the_persona_and_the_bindings() {
        let spec = staged()
            .add_slot(2, Persona::PlayStation, preset("Player 2"))
            .unwrap()
            .set_blocking(Blocking::BoundKeys)
            .commit()
            .expect("a device and two controllers");

        assert_eq!(spec.blocking, Blocking::BoundKeys);
        assert_eq!(spec.slots.len(), 2);
        assert_eq!(spec.device.alias, "panel");
        for slot in &spec.slots {
            assert_eq!(
                slot.spec.keyboard().map(|k| k.as_str()),
                Some("usb:d209:0430:00"),
                "every staged slot listens to the staged device"
            );
            assert_eq!(slot.spec.primary_preset(), slot.preset.name);
        }
        assert_eq!(spec.slots[0].spec.persona, Persona::Xbox360);
        assert_eq!(spec.slots[1].spec.persona, Persona::PlayStation);
        assert_eq!(spec.slots[0].preset.entries.len(), 1);
    }

    #[test]
    fn two_keyboards_feed_one_controller_with_independent_presets() {
        let left = device();
        let right = other_device();
        let left_map = routed_preset("left-side", Key::Q, XButton::A);
        let right_map = routed_preset("right-side", Key::W, XButton::B);
        let setup = StagedSetup::new()
            .choose_device(left.clone())
            .unwrap()
            .add_device(right.clone())
            .unwrap()
            .add_slot(1, Persona::Xbox360, left_map.clone())
            .unwrap()
            .set_source_bindings(1, &right.selector, right_map.clone())
            .unwrap()
            .set_blocking(Blocking::BoundKeys);

        assert_eq!(setup.devices(), [left.clone(), right.clone()]);
        assert_eq!(setup.device(), Some(&left));
        let routes = setup.slot(1).unwrap().routes();
        assert_eq!(routes.len(), 2);
        assert_eq!(routes[0].selector, left.selector);
        assert_eq!(routes[0].preset, left_map);
        assert_eq!(routes[1].selector, right.selector);
        assert_eq!(routes[1].preset, right_map);

        let committed = setup.commit().unwrap();
        assert_eq!(committed.devices, [left, right]);
        assert_eq!(committed.slots[0].spec.sources.len(), 2);
        assert_eq!(committed.slots[0].spec.sources[0].preset, "left-side");
        assert_eq!(committed.slots[0].spec.sources[1].preset, "right-side");
        assert_eq!(committed.slots[0].preset.name, "left-side");
        assert_eq!(committed.slots[0].additional_presets, [right_map]);
    }

    #[test]
    fn two_keyboards_can_feed_two_different_controllers() {
        let left = device();
        let right = other_device();
        let committed = StagedSetup::new()
            .add_device(left.clone())
            .unwrap()
            .add_device(right.clone())
            .unwrap()
            .add_slot_for_source(
                1,
                Persona::Xbox360,
                &left.selector,
                routed_preset("Player 1", Key::A, XButton::A),
            )
            .unwrap()
            .add_slot_for_source(
                2,
                Persona::PlayStation,
                &right.selector,
                routed_preset("Player 2", Key::B, XButton::B),
            )
            .unwrap()
            .set_blocking(Blocking::Whole)
            .commit()
            .unwrap();

        assert_eq!(committed.slots.len(), 2);
        assert_eq!(committed.slots[0].spec.sources.len(), 1);
        assert_eq!(
            committed.slots[0].spec.sources[0].device.as_str(),
            left.selector.to_string()
        );
        assert_eq!(committed.slots[1].spec.sources.len(), 1);
        assert_eq!(
            committed.slots[1].spec.sources[0].device.as_str(),
            right.selector.to_string()
        );
    }

    #[test]
    fn removing_one_keyboard_removes_only_its_routes() {
        let left = device();
        let right = other_device();
        let setup = StagedSetup::new()
            .add_device(left.clone())
            .unwrap()
            .add_device(right.clone())
            .unwrap()
            .add_slot_for_source(1, Persona::Xbox360, &left.selector, preset("P1"))
            .unwrap()
            .add_slot_for_source(2, Persona::PlayStation, &right.selector, preset("P2"))
            .unwrap()
            .set_blocking(Blocking::Whole);

        let removed = setup.remove_device(&left.selector).unwrap();
        assert_eq!(removed.devices(), std::slice::from_ref(&right));
        assert_eq!(removed.device(), Some(&right));
        assert!(removed.slot(1).unwrap().routes().is_empty());
        assert_eq!(removed.slot(1).unwrap().preset.name, "P1");
        assert_eq!(removed.slot(2).unwrap().routes().len(), 1);
        assert_eq!(
            removed.slot(2).unwrap().routes()[0].selector,
            right.selector
        );
        assert_eq!(
            removed.commit().unwrap_err(),
            StageRefusal::NoSources { number: 1 }
        );

        let surviving = removed.remove_slot(1).unwrap().commit().unwrap();
        assert_eq!(surviving.slots.len(), 1);
        assert_eq!(surviving.slots[0].spec.number, 2);
        assert_eq!(surviving.slots[0].spec.sources[0].preset, "P2");
    }

    #[test]
    fn upserting_the_same_selector_updates_in_place_without_losing_routes() {
        let original = device();
        let setup = staged();
        let updated = StagedDevice {
            alias: "renamed-panel".to_owned(),
            label: "Updated panel label".to_owned(),
            backend: StageCaptureBackend::Winusb,
            ..original.clone()
        };
        let next = setup.upsert_device(updated.clone()).unwrap();

        assert_eq!(next.devices(), std::slice::from_ref(&updated));
        assert_eq!(next.device(), Some(&updated));
        assert_eq!(next.slot(1).unwrap().routes().len(), 1);
        assert_eq!(
            next.slot(1).unwrap().routes()[0].selector,
            original.selector
        );
        assert_eq!(next.slot(1).unwrap().preset.name, "Player 1");
        assert_eq!(
            next.set_blocking(Blocking::Whole).commit().unwrap().devices,
            [updated]
        );
    }

    #[test]
    fn commit_excludes_canvas_only_keyboards_from_the_runtime_device_roster() {
        let canvas_only = device();
        let routed = other_device();
        let setup = StagedSetup::new()
            .add_device(canvas_only.clone())
            .unwrap()
            .add_device(routed.clone())
            .unwrap()
            .add_slot_for_source(
                1,
                Persona::Xbox360,
                &routed.selector,
                routed_preset("Player 1 - desk", Key::Q, XButton::A),
            )
            .unwrap()
            .set_blocking(Blocking::Whole);

        assert_eq!(setup.devices(), &[canvas_only, routed.clone()]);
        let committed = setup.commit().unwrap();
        assert_eq!(committed.device, routed.clone());
        assert_eq!(committed.devices, [routed]);
        assert_eq!(committed.slots[0].spec.sources.len(), 1);
    }

    #[test]
    fn same_key_on_different_staged_sources_keeps_its_source_identity() {
        let left = device();
        let right = other_device();
        let committed = StagedSetup::new()
            .add_device(left)
            .unwrap()
            .add_device(right)
            .unwrap()
            .add_slot(
                1,
                Persona::Xbox360,
                routed_preset("left", Key::Q, XButton::A),
            )
            .unwrap()
            .set_source_bindings(
                1,
                &other_device().selector,
                routed_preset("right", Key::Q, XButton::B),
            )
            .unwrap()
            .set_blocking(Blocking::Whole)
            .commit()
            .unwrap();
        let left_id = committed.slots[0].spec.sources[0].device.clone();
        let right_id = committed.slots[0].spec.sources[1].device.clone();
        let mut engine = Engine::new(committed.slots);

        engine.handle(&event(&left_id, Key::Q, true));
        assert_eq!(engine.pad_state(1).unwrap().buttons, XButtons::A);
        engine.handle(&event(&right_id, Key::Q, true));
        assert_eq!(
            engine.pad_state(1).unwrap().buttons,
            XButtons::A | XButtons::B
        );
        engine.handle(&event(&left_id, Key::Q, false));
        assert_eq!(engine.pad_state(1).unwrap().buttons, XButtons::B);
    }

    #[test]
    fn legacy_one_device_calls_commit_to_the_exact_previous_slot_shape() {
        let staged_device = device();
        let mapping = routed_preset("Legacy P1", Key::B, XButton::B);
        let setup = StagedSetup::new()
            .choose_device(staged_device.clone())
            .unwrap()
            .add_slot(1, Persona::Xbox360, preset("placeholder"))
            .unwrap()
            .set_bindings(1, mapping.clone())
            .unwrap()
            .set_socd(1, Socd::Neutral)
            .unwrap()
            .set_blocking(Blocking::Whole);

        assert_eq!(setup.device(), Some(&staged_device));
        assert_eq!(setup.devices(), std::slice::from_ref(&staged_device));
        assert_eq!(setup.slot(1).unwrap().preset, mapping);
        assert_eq!(setup.slot(1).unwrap().routes().len(), 1);

        let keyboard = crate::selector::DeviceRef::from_selector(staged_device.selector.clone())
            .as_device_id();
        let expected_spec = SlotSpec::new(1, Some(keyboard), None, mapping.name.clone())
            .unwrap()
            .with_socd(Socd::Neutral);
        let committed = setup.commit().unwrap();
        assert_eq!(committed.device, staged_device.clone());
        assert_eq!(committed.devices, [staged_device]);
        assert_eq!(committed.slots, [ResolvedSlot::new(expected_spec, mapping)]);
    }

    #[test]
    fn aliases_are_unique_by_the_config_resolvers_exact_case_semantics() {
        let first = device();
        let same_alias = StagedDevice {
            alias: first.alias.clone(),
            ..other_device()
        };
        let setup = StagedSetup::new().add_device(first).unwrap();
        let refused = setup.add_device(same_alias).unwrap_err();
        assert_eq!(refused.code(), "duplicate-alias");
        assert!(refused.to_string().contains("panel"));
        assert_eq!(setup.devices().len(), 1, "a refusal changes nothing");

        let case_distinct = StagedDevice {
            alias: "Panel".to_owned(),
            ..other_device()
        };
        assert_eq!(
            setup.add_device(case_distinct).unwrap().devices().len(),
            2,
            "config alias lookup is exact, not case-folded"
        );
    }

    #[test]
    fn routed_preset_names_deduplicate_equal_bodies_and_refuse_different_ones() {
        let left = device();
        let right = other_device();
        let shared = routed_preset("shared", Key::Q, XButton::A);
        let setup = StagedSetup::new()
            .add_device(left)
            .unwrap()
            .add_device(right.clone())
            .unwrap()
            .add_slot(1, Persona::Xbox360, shared.clone())
            .unwrap()
            .set_source_bindings(1, &right.selector, shared.clone())
            .unwrap()
            .set_blocking(Blocking::Whole);
        let deduplicated = setup.commit().unwrap();
        assert_eq!(deduplicated.slots[0].spec.sources.len(), 2);
        assert!(deduplicated.slots[0].additional_presets.is_empty());

        let different = setup
            .set_source_bindings(
                1,
                &right.selector,
                routed_preset("shared", Key::Q, XButton::B),
            )
            .unwrap()
            .commit()
            .unwrap_err();
        assert_eq!(different.code(), "preset-name-clash");
    }

    #[test]
    fn an_inert_routed_source_is_refused_by_selector_and_preset() {
        let right = other_device();
        let mut inert = Preset::builtin_empty();
        inert.name = "inert-right".to_owned();
        let refused = staged()
            .add_device(right.clone())
            .unwrap()
            .set_source_bindings(1, &right.selector, inert)
            .unwrap()
            .set_blocking(Blocking::Whole)
            .commit()
            .unwrap_err();
        assert_eq!(refused.code(), "no-route-bindings");
        let message = refused.to_string();
        assert!(message.contains(&right.selector.to_string()), "{message}");
        assert!(message.contains("inert-right"), "{message}");
    }

    /// Committing an incomplete stage refuses in words that name the missing
    /// step, rather than saving a config that cannot run.
    #[test]
    fn committing_without_a_device_or_without_a_controller_is_refused() {
        let no_device = StagedSetup::new()
            .add_slot(1, Persona::Xbox360, preset("P1"))
            .unwrap()
            .commit()
            .unwrap_err();
        assert_eq!(no_device.code(), "no-device");
        assert!(no_device.to_string().contains("pick a device"));

        let no_slots = StagedSetup::new()
            .choose_device(device())
            .unwrap()
            .commit()
            .unwrap_err();
        assert_eq!(no_slots.code(), "no-slots");
        assert!(no_slots.to_string().contains("Add one"));
    }

    /// Two staged slots may share a preset NAME only when they share the
    /// bindings, because one name is one file.
    ///
    /// Breaks against a commit with no name check: saving writes "Player 1"
    /// twice, the second write wins, and slot 1 comes back off disk holding
    /// slot 2's bindings — the second translation §2 forbids, landing silently.
    #[test]
    fn two_slots_cannot_stage_different_bindings_under_one_preset_name() {
        let mut two = preset("Player 1");
        two.entries = vec![(Key::B, Binding::Button(XButton::B))];
        let clash = staged()
            .add_slot(2, Persona::PlayStation, two)
            .unwrap()
            .commit()
            .unwrap_err();
        assert_eq!(clash.code(), "preset-name-clash");
        assert!(clash.to_string().contains("silently lose the other"));

        // Deliberate sharing — the SAME preset in both slots — is fine: that
        // is two players on one key map, which is an ordinary thing to want.
        let shared = mapped_setup()
            .add_slot(2, Persona::PlayStation, preset("Player 1"))
            .unwrap()
            .commit()
            .expect("one preset, two slots");
        assert_eq!(shared.slots.len(), 2);

        // A nameless preset has no file to be written to.
        let unnamed = staged()
            .add_slot(2, Persona::PlayStation, preset(" "))
            .unwrap()
            .commit()
            .unwrap_err();
        assert_eq!(unnamed.code(), "unnamed-preset");
    }

    /// Editing bindings and removing slots only ever touch the slot named.
    #[test]
    fn bindings_and_removal_address_exactly_one_slot() {
        let two = staged()
            .add_slot(2, Persona::PlayStation, preset("Player 2"))
            .unwrap();

        let edited = two
            .set_bindings(2, preset("Player 2 v2"))
            .expect("slot 2 is staged");
        assert_eq!(edited.slot(2).unwrap().preset.name, "Player 2 v2");
        assert_eq!(edited.slot(1).unwrap().preset.name, "Player 1");

        assert_eq!(
            two.set_bindings(3, preset("ghost")).unwrap_err(),
            StageRefusal::NoSuchSlot { number: 3 }
        );
        assert_eq!(
            two.remove_slot(3).unwrap_err(),
            StageRefusal::NoSuchSlot { number: 3 }
        );
        assert_eq!(
            two.set_persona(3, Persona::Xbox360).unwrap_err(),
            StageRefusal::NoSuchSlot { number: 3 }
        );

        // Removing the middle of a set leaves the rest, and the freed number
        // is offered again.
        let one = two.remove_slot(1).unwrap();
        assert_eq!(one.slots().len(), 1);
        assert_eq!(one.slots()[0].number, 2);
        assert_eq!(one.next_free_slot(), Some(1));
    }

    /// "Add a controller" must not make a first-run user pick a number, and it
    /// must never reuse one.
    #[test]
    fn add_next_slot_fills_the_lowest_free_number() {
        let mut setup = StagedSetup::new().choose_device(device()).unwrap();
        for expected in 1..=3 {
            setup = setup
                .add_next_slot(Persona::PlayStation, preset(&format!("P{expected}")))
                .unwrap();
            assert_eq!(setup.slots().last().unwrap().number, expected);
        }
        let gap = setup.remove_slot(2).unwrap();
        assert_eq!(gap.next_free_slot(), Some(2));
        let filled = gap
            .add_next_slot(Persona::PlayStation, preset("P2b"))
            .unwrap();
        assert_eq!(filled.slot(2).unwrap().preset.name, "P2b");
        assert_eq!(filled.slots().len(), 3);
    }

    /// Every refusal has a stable, distinct code AND a message that names the
    /// thing it is refusing.
    ///
    /// Surfaces route on [`StageRefusal::code`]; the person staring at the
    /// screen reads `to_string()`. Both halves have to be checked, and the
    /// second one has to check RENDERING, not length: `!to_string().is_empty()`
    /// is satisfied by a message that forgot which slot it was about.
    ///
    /// **Why the ordinal machinery (2026-08-26 audit).** The array here used to
    /// be hand-written with no exhaustiveness check, and three live variants had
    /// silently fallen out of it — `TooManyHidMaestroPads`, `DeviceChanged` and
    /// `BadReorder`, all three of which surfaces route on — while the test still
    /// said "one code per refusal" and passed. `ordinal` below is exhaustive, so
    /// adding a variant to `StageRefusal` now stops this file COMPILING until
    /// somebody comes here. Note the residual gap, honestly: the compiler forces
    /// the arm, and the `REFUSAL_VARIANTS` assertion forces the sample only if
    /// the count below is bumped with it. Closing that last inch needs a derive
    /// macro, and ksx-core is deliberately dependency-free (see the note above
    /// `mod tests` in `persona.rs`). Bump the count when you add the arm.
    #[test]
    fn every_refusal_has_a_distinct_code_and_a_message_that_names_its_subject() {
        // Sentinels that cannot show up by accident in boilerplate wording.
        let all: Vec<(StageRefusal, Vec<&str>)> = vec![
            (StageRefusal::BadSlot { given: 0 }, vec!["0"]),
            (StageRefusal::SlotTaken { number: 7 }, vec!["7"]),
            (StageRefusal::NoSuchSlot { number: 7 }, vec!["7"]),
            // The ceiling is ksx's, not Windows'. Saying so is the whole point
            // of the sentence: a user who reads "16 slots" as a driver limit
            // goes looking for a driver setting that does not exist.
            (
                StageRefusal::NoFreeSlot,
                vec!["16", "ksx's own ceiling", "not a Windows one"],
            ),
            (
                StageRefusal::PersonaNotImplemented {
                    persona: Persona::DualSense,
                    backend: "HIDMaestro",
                    reason: "zzz-the-stated-gap",
                    instead: Persona::PlayStation,
                },
                // The refusal is useless without all four: which persona, which
                // stack decided, why, and what to stage instead.
                vec![
                    "dualsense",
                    "HIDMaestro",
                    "zzz-the-stated-gap",
                    "playstation",
                ],
            ),
            (
                StageRefusal::PersonaCapacity {
                    number: 7,
                    persona: Persona::DualSense,
                    after: 2,
                    limit: 1,
                },
                vec!["7", "dualsense"],
            ),
            (
                StageRefusal::TooManyXinputSlots {
                    number: 7,
                    after: 5,
                },
                vec!["7", "5"],
            ),
            (
                StageRefusal::TooManyHidMaestroPads {
                    number: 7,
                    after: 9,
                },
                vec!["7", "9"],
            ),
            (
                StageRefusal::BadAlias {
                    alias: "zzz-alias".into(),
                    problem: "zzz-the-problem",
                },
                vec!["zzz-alias", "zzz-the-problem"],
            ),
            (
                StageRefusal::DuplicateAlias {
                    alias: "zzz-alias".into(),
                    selector: "zzz-selector".into(),
                    other: "zzz-other".into(),
                },
                vec!["zzz-alias", "zzz-selector", "zzz-other"],
            ),
            (
                StageRefusal::NoSuchDevice {
                    selector: "zzz-selector".into(),
                },
                vec!["zzz-selector"],
            ),
            (
                StageRefusal::NoSuchRoute {
                    number: 7,
                    selector: "zzz-selector".into(),
                },
                vec!["7", "zzz-selector"],
            ),
            (
                StageRefusal::PresetNameClash {
                    number: 7,
                    other: 2,
                    name: "zzz-preset".into(),
                },
                vec!["7", "2", "zzz-preset"],
            ),
            // NOTE, deliberately not an assertion: `UnnamedPreset` carries
            // `number` and its message never prints it, so the user is told "a
            // preset needs a name" without being told which staged slot. It is
            // the one refusal in this list that cannot name its own subject.
            // Not pinned either way — asserting the number would fail today,
            // and asserting its absence would defend the gap.
            (
                StageRefusal::UnnamedPreset { number: 7 },
                vec!["needs a name", "[[slot]]"],
            ),
            (
                StageRefusal::NoBindings {
                    number: 7,
                    preset: "zzz-preset".into(),
                },
                vec!["7", "zzz-preset"],
            ),
            (
                StageRefusal::NoRouteBindings {
                    number: 7,
                    selector: "zzz-selector".into(),
                    preset: "zzz-preset".into(),
                },
                vec!["7", "zzz-selector", "zzz-preset"],
            ),
            (StageRefusal::NoSources { number: 7 }, vec!["7"]),
            // An unanswered question has to be ASKABLE from its own refusal, so
            // all three answers are named. Literals, not `Blocking::as_str()`:
            // the message is built from that function, so checking it against
            // itself could only ever agree.
            (
                StageRefusal::BlockingUnanswered,
                vec!["split-or-freeze", "whole", "bound-keys", "off"],
            ),
            (
                StageRefusal::NoDevice { slots: 7 },
                vec!["7", "pick a device"],
            ),
            (StageRefusal::NoSlots, vec!["no controller has been staged"]),
            (
                StageRefusal::DeviceChanged {
                    expected: "zzz-expected".into(),
                    current: "zzz-current".into(),
                },
                vec!["zzz-expected", "zzz-current"],
            ),
            (
                StageRefusal::BadReorder {
                    staged: "zzz-staged".into(),
                    given: "zzz-given".into(),
                },
                vec!["zzz-staged", "zzz-given"],
            ),
        ];

        /// Keep in lockstep with `ordinal`'s last arm.
        const REFUSAL_VARIANTS: usize = 22;

        // Exhaustive on purpose — no wildcard arm, ever. The ordinals mean
        // nothing except "this variant has a sample above".
        fn ordinal(refusal: &StageRefusal) -> usize {
            match refusal {
                StageRefusal::BadSlot { .. } => 0,
                StageRefusal::SlotTaken { .. } => 1,
                StageRefusal::NoSuchSlot { .. } => 2,
                StageRefusal::NoFreeSlot => 3,
                StageRefusal::PersonaNotImplemented { .. } => 4,
                StageRefusal::PersonaCapacity { .. } => 5,
                StageRefusal::TooManyXinputSlots { .. } => 6,
                StageRefusal::TooManyHidMaestroPads { .. } => 7,
                StageRefusal::BadAlias { .. } => 8,
                StageRefusal::PresetNameClash { .. } => 9,
                StageRefusal::UnnamedPreset { .. } => 10,
                StageRefusal::NoBindings { .. } => 11,
                StageRefusal::BlockingUnanswered => 12,
                StageRefusal::NoDevice { .. } => 13,
                StageRefusal::NoSlots => 14,
                StageRefusal::DeviceChanged { .. } => 15,
                StageRefusal::BadReorder { .. } => 16,
                StageRefusal::DuplicateAlias { .. } => 17,
                StageRefusal::NoSuchDevice { .. } => 18,
                StageRefusal::NoSuchRoute { .. } => 19,
                StageRefusal::NoRouteBindings { .. } => 20,
                StageRefusal::NoSources { .. } => 21,
            }
        }

        let covered: std::collections::BTreeSet<usize> =
            all.iter().map(|(r, _)| ordinal(r)).collect();
        assert_eq!(
            covered,
            (0..REFUSAL_VARIANTS).collect::<std::collections::BTreeSet<_>>(),
            "every StageRefusal variant needs a sample in this test",
        );

        let codes: std::collections::HashSet<&str> = all.iter().map(|(r, _)| r.code()).collect();
        assert_eq!(codes.len(), all.len(), "one code per refusal");
        assert!(
            codes.iter().all(|c| !c.is_empty()),
            "a surface cannot route on an empty code",
        );

        for (refusal, must_name) in &all {
            let rendered = refusal.to_string();
            assert!(
                !must_name.is_empty(),
                "{}: every refusal must state something checkable — a message \
                 checked only for being non-empty is not checked at all",
                refusal.code(),
            );
            for datum in must_name {
                assert!(
                    rendered.contains(datum),
                    "{} must name {datum:?}, or the user cannot tell which slot, \
                     board or preset it means: {rendered}",
                    refusal.code(),
                );
            }
        }
    }

    /// Staging the same slot twice is a refusal, not a silent overwrite — a
    /// second "Add a controller" click must not replace the one being edited.
    #[test]
    fn staging_a_slot_that_is_already_staged_is_refused() {
        let refused = staged()
            .add_slot(1, Persona::PlayStation, preset("other"))
            .unwrap_err();
        assert_eq!(refused, StageRefusal::SlotTaken { number: 1 });
        assert_eq!(staged().slot(1).unwrap().preset.name, "Player 1");
    }
}
