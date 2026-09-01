//! Main config file schema: `%APPDATA%\ksx\config.toml`.

use std::collections::HashSet;

use ksx_core::{
    Blocking, DeviceId, DeviceRef, MacroSwitch, Persona, SlotSpec, Socd, SourceKind, SourceSpec,
};
use serde::{Deserialize, Serialize};

use crate::error::ConfigError;

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfigFile {
    pub schema_version: u32,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default, rename = "device", skip_serializing_if = "Vec::is_empty")]
    pub devices: Vec<DeviceEntry>,
    #[serde(default, rename = "slot", skip_serializing_if = "Vec::is_empty")]
    pub slots: Vec<SlotEntry>,
}

impl Default for ConfigFile {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            settings: Settings::default(),
            devices: Vec::new(),
            slots: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Keyboard blocking mode (defaults to taking the whole device).
    ///
    /// Three states, two of which are still spelled as the bool this used to
    /// be: `true` takes the whole keyboard, `false` takes nothing, and
    /// `"bound-keys"` takes only the keys the slots on that device bind, so a
    /// desk keyboard driving two pads still types. See [`Blocking`].
    #[serde(with = "crate::blocking_serde")]
    pub block_keyboards: Blocking,
    /// Whether assigned mice are blocked from the OS (default false).
    pub block_mice: bool,
    /// Mouse-movement dead zone, 0..=12.
    pub mouse_move_deadzone: u8,
    /// First preferred virtual-controller user index, 1..=4.
    ///
    /// **INERT, and kept only so existing configs keep parsing.** Nothing
    /// reads this: it is defined here, range-checked in `validate`, and never
    /// consulted by the engine, the run plan or any output backend.
    ///
    /// It cannot be honoured. `ksx-output`'s module docs record the
    /// measurement: on real hardware both `get_user_index()` and the LED
    /// notification channel report wrong or missing slots
    /// (`docs/research/m2-xinput-findings.md`), so ksx establishes slot
    /// identity by ACTIVE CORRELATION — pulsing LT below the game-visible
    /// threshold and watching which XInput slot echoes it. Windows assigns
    /// the index; ksx discovers which one it got. A "preferred" index has
    /// nowhere to be applied.
    ///
    /// Do not give this a control. A knob that promises to place player 1 on
    /// a chosen slot would be promising something the platform does not offer.
    /// The useful surface, if one is ever wanted, is a READ of where each pad
    /// actually landed.
    pub starting_user_index: u8,
    /// The Studio's visual theme, by id — `None` follows the OS light/dark
    /// choice ("System"), which is also why absence is the default rather
    /// than a named theme.
    ///
    /// The Studio owns the theme roster (its generated `theme_tokens.rs`) and
    /// validates ids at the door; this store keeps whatever short ident it
    /// was handed, so a config written by a NEWER Studio still loads here and
    /// the stamp-time sanitizer — not a parse error — decides what an unknown
    /// id means (it renders as System). Skipped when `None` so configs that
    /// never chose a theme stay byte-identical across load/save.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    /// **Which board the Studio draws its keys on**, by id. `None` decides
    /// from whatever device is staged.
    ///
    /// A board is the PICTURE, never the mapping. `key -> control` is
    /// identical whichever one is on screen, because the only field a binding
    /// ever carries is the canonical key name — lay the keyboard out in
    /// alphabetical order and nothing downstream can tell.
    ///
    /// Absence is the default for the same reason it is for [`Self::theme`]:
    /// "follow what is staged" is a real answer, and writing it as a named id
    /// would be a second state to keep in step with the device list. The
    /// Studio owns the roster and sanitizes at render time, so a config
    /// written by a NEWER Studio still loads here and an id this build cannot
    /// draw falls back rather than failing to parse. Skipped when `None` so
    /// configs that never chose one stay byte-identical across load/save.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub board: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            block_keyboards: Blocking::Whole,
            block_mice: false,
            mouse_move_deadzone: 5,
            starting_user_index: 1,
            theme: None,
            board: None,
        }
    }
}

/// A known physical device: stable identity learned via the picker wizard.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceEntry {
    /// **Which board**, not which socket — a [`ksx_core::DeviceSelector`] plus
    /// the exact text it was written as (`docs/DEVICE-IDENTITY.md`).
    ///
    /// Every spelling that ever worked still does: a full instance path, an
    /// Interception hardware id, an ACPI path the setup wizard wrote, and now
    /// `usb:d209:0430:00` — the replug-proof form `ksx device pick` writes.
    /// What each one *means* is decided once, at session start
    /// (`ksx-backend::run::resolve`), against a fresh enumeration; nothing
    /// byte-compares this against hardware any more.
    ///
    /// The raw string is what goes back to disk — see [`crate::device_serde`]
    /// for why storing only the parsed value would rewrite every user's file
    /// just by loading it.
    #[serde(with = "crate::device_serde")]
    pub id: DeviceRef,
    pub alias: String,
    #[serde(default)]
    pub backend: Backend,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    #[default]
    Interception,
    Winusb,
}

/// One physical input route into a controller slot.
///
/// A route owns its preset because fan-in is useful only when each physical
/// source can describe its own keys. Two keyboards may therefore feed one
/// virtual controller without pretending to be one device or sharing a
/// mapping file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceEntry {
    /// A `[[device]]` alias or a literal device instance path.
    pub device: String,
    /// Which event stream this device contributes.
    #[serde(with = "source_kind_serde")]
    pub kind: SourceKind,
    /// The preset applied only to this source's events.
    pub preset: String,
}

impl SourceEntry {
    pub fn new(device: impl Into<String>, kind: SourceKind, preset: impl Into<String>) -> Self {
        Self {
            device: device.into(),
            kind,
            preset: preset.into(),
        }
    }
}

pub(crate) const fn source_kind_name(kind: SourceKind) -> &'static str {
    match kind {
        SourceKind::Keyboard => "keyboard",
        SourceKind::Mouse => "mouse",
    }
}

/// Encode a canonical source list with the smallest lossless on-disk shape.
///
/// The legacy fields can express at most one keyboard, at most one mouse and
/// one shared preset. Anything richer stays as explicit source rows.
pub(crate) fn source_fields<F>(
    spec: &SlotSpec,
    display: F,
) -> (Option<String>, Option<String>, String, Vec<SourceEntry>)
where
    F: Fn(&DeviceId) -> String,
{
    if spec.sources.is_empty() {
        return (None, None, spec.primary_preset().to_owned(), Vec::new());
    }

    let shared_preset = spec.sources[0].preset.as_str();
    let one_keyboard = spec.sources_of_kind(SourceKind::Keyboard).nth(1).is_none();
    let one_mouse = spec.sources_of_kind(SourceKind::Mouse).nth(1).is_none();
    let one_preset = spec
        .sources
        .iter()
        .all(|source| source.preset == shared_preset);

    if one_keyboard && one_mouse && one_preset {
        return (
            spec.source(SourceKind::Keyboard)
                .map(|source| display(&source.device)),
            spec.source(SourceKind::Mouse)
                .map(|source| display(&source.device)),
            shared_preset.to_owned(),
            Vec::new(),
        );
    }

    let sources = spec
        .sources
        .iter()
        .map(|source| SourceEntry::new(display(&source.device), source.kind, &source.preset))
        .collect();
    (None, None, String::new(), sources)
}

mod source_kind_serde {
    use ksx_core::SourceKind;
    use serde::{de, Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(value: &SourceKind, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(super::source_kind_name(*value))
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<SourceKind, D::Error>
    where
        D: Deserializer<'de>,
    {
        match String::deserialize(deserializer)?.as_str() {
            "keyboard" => Ok(SourceKind::Keyboard),
            "mouse" => Ok(SourceKind::Mouse),
            other => Err(de::Error::unknown_variant(other, &["keyboard", "mouse"])),
        }
    }
}

/// One `[[slot]]` entry. `keyboard`/`mouse` refer to a `[[device]]` alias, or
/// hold a literal instance path.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlotEntry {
    pub number: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keyboard: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mouse: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub preset: String,
    /// Which controller this slot presents itself as. Absent means
    /// [`Persona::Xbox360`], which is why every pre-persona config still loads
    /// and still round-trips byte-identically.
    #[serde(
        default,
        with = "crate::persona_serde",
        skip_serializing_if = "crate::persona_serde::is_default"
    )]
    pub persona: Persona,
    /// What this slot does with simultaneous opposing directions:
    /// `"off"` (default — today's behavior, nothing generated), `"neutral"`,
    /// `"up-priority"`, `"last-input"` or `"first-input"`. See
    /// [`ksx_core::socd`].
    #[serde(
        default,
        with = "crate::socd_serde",
        skip_serializing_if = "crate::socd_serde::is_default"
    )]
    pub socd: Socd,
    /// Does this slot run macros at all: `"on"` (default — today's behavior) or
    /// `"off"`. THE TOURNAMENT SWITCH: one edit takes every macro off a panel
    /// without deleting a single one, and it overrides each macro's own
    /// `enabled = true`. See [`ksx_core::MacroSwitch`].
    ///
    /// A slot property rather than a preset one for the same reason
    /// [`SlotEntry::socd`] is: the panel and the occasion decide it, and a
    /// preset that gets shared (M7) must not have to change to suit them.
    #[serde(
        default,
        with = "crate::macro_serde::switch",
        skip_serializing_if = "crate::macro_serde::switch::is_default"
    )]
    pub macros: MacroSwitch,
    /// Canonical fan-in spelling. Serializes as `[[slot.source]]` rows.
    ///
    /// Empty means the legacy `keyboard` / `mouse` / shared `preset` fields
    /// above are authoritative. The two representations may never be mixed.
    #[serde(default, rename = "source", skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<SourceEntry>,
}

impl SlotEntry {
    pub(crate) fn has_legacy_sources(&self) -> bool {
        self.keyboard.is_some() || self.mouse.is_some() || !self.preset.is_empty()
    }

    pub(crate) fn preset_refs(&self) -> Vec<&str> {
        let refs: Vec<_> = if self.sources.is_empty() {
            vec![self.preset.as_str()]
        } else if self.has_legacy_sources() {
            std::iter::once(self.preset.as_str())
                .chain(self.sources.iter().map(|source| source.preset.as_str()))
                .collect()
        } else {
            self.sources
                .iter()
                .map(|source| source.preset.as_str())
                .collect()
        };
        refs.into_iter().fold(Vec::new(), |mut unique, preset| {
            if !unique.contains(&preset) {
                unique.push(preset);
            }
            unique
        })
    }
}

impl ConfigFile {
    /// Alias → the `[[device]]` entry's id **as written**. A literal instance
    /// path (contains `\`) passes through unchanged; anything else must match a
    /// `[[device]]` alias.
    ///
    /// Deliberately still the *written* spelling and not a concrete devnode:
    /// what a selector names is decided once, at session start, against a fresh
    /// enumeration (`ksx-backend::run::resolve`). Resolving here would mean the
    /// config layer enumerating hardware, and would put resolution downstream
    /// of the hot-swap comparison that decides whether a config edit has to
    /// bounce a live session (`docs/DEVICE-IDENTITY.md` §8).
    pub fn resolve_device(&self, alias_or_id: &str) -> Result<DeviceId, ConfigError> {
        if let Some(device) = self.devices.iter().find(|d| d.alias == alias_or_id) {
            return Ok(device.id.as_device_id());
        }
        if alias_or_id.contains('\\') {
            return Ok(DeviceId::new(alias_or_id));
        }
        Err(ConfigError::UnknownDeviceAlias(alias_or_id.to_owned()))
    }

    /// Resolve one slot entry into a core [`SlotSpec`].
    pub fn slot_spec(&self, slot: &SlotEntry) -> Result<SlotSpec, ConfigError> {
        if !slot.sources.is_empty() {
            if slot.has_legacy_sources() {
                return Err(ConfigError::MixedSlotSourceRepresentations(slot.number));
            }
            let mut seen = HashSet::new();
            let mut sources = Vec::with_capacity(slot.sources.len());
            for source in &slot.sources {
                let device = self.resolve_device(&source.device)?;
                if !seen.insert((source.kind, device.clone())) {
                    return Err(ConfigError::DuplicateSlotSource {
                        slot: slot.number,
                        device: source.device.clone(),
                        kind: source_kind_name(source.kind).to_owned(),
                    });
                }
                sources.push(SourceSpec::new(source.kind, device, source.preset.clone()));
            }
            return SlotSpec::from_sources(slot.number, sources, String::new())
                .map(|spec| {
                    spec.with_persona(slot.persona)
                        .with_socd(slot.socd)
                        .with_macros(slot.macros)
                })
                .map_err(Into::into);
        }

        let keyboard = slot
            .keyboard
            .as_deref()
            .map(|k| self.resolve_device(k))
            .transpose()?;
        let mouse = slot
            .mouse
            .as_deref()
            .map(|m| self.resolve_device(m))
            .transpose()?;
        SlotSpec::new(slot.number, keyboard, mouse, slot.preset.clone())
            .map(|spec| {
                spec.with_persona(slot.persona)
                    .with_socd(slot.socd)
                    .with_macros(slot.macros)
            })
            .map_err(Into::into)
    }

    /// The same resolution for a `[[game.slot]]`.
    ///
    /// **A game slot resolves through THIS config's `[[device]]` table**, and
    /// that is not a convenience — it is the difference between a working
    /// cabinet and a dead panel. Backend selection (`[[device]] backend =
    /// "winusb"`) is a property of the *device*, matched by instance path, so a
    /// game slot that kept `keyboard = "ipac"` as a literal `DeviceId` matched
    /// no `[[device]]` entry, selected no WinUSB claim, and silently ran the
    /// session on Interception — which cannot see a claimed board at all. The
    /// panel is simply dead, with nothing in any log to say why.
    ///
    /// Legacy games.toml files persist full instance paths and keep working:
    /// [`ConfigFile::resolve_device`] passes anything containing a `\` through
    /// untouched. What changes is that an alias now means the same thing in
    /// both files, and a reference that means nothing in either is an error
    /// instead of a literal.
    pub fn game_slot_spec(
        &self,
        slot: &crate::games::GameSlotEntry,
    ) -> Result<SlotSpec, ConfigError> {
        if !slot.sources.is_empty() {
            if slot.has_legacy_sources() {
                return Err(ConfigError::MixedSlotSourceRepresentations(slot.number));
            }
            let mut seen = HashSet::new();
            let mut sources = Vec::with_capacity(slot.sources.len());
            for source in &slot.sources {
                let device = self.resolve_device(&source.device)?;
                if !seen.insert((source.kind, device.clone())) {
                    return Err(ConfigError::DuplicateSlotSource {
                        slot: slot.number,
                        device: source.device.clone(),
                        kind: source_kind_name(source.kind).to_owned(),
                    });
                }
                sources.push(SourceSpec::new(source.kind, device, source.preset.clone()));
            }
            return SlotSpec::from_sources(slot.number, sources, String::new())
                .map(|spec| {
                    spec.with_persona(slot.persona)
                        .with_socd(slot.socd)
                        .with_macros(slot.macros)
                })
                .map_err(Into::into);
        }

        let keyboard = slot
            .keyboard
            .as_deref()
            .map(|k| self.resolve_device(k))
            .transpose()?;
        let mouse = slot
            .mouse
            .as_deref()
            .map(|m| self.resolve_device(m))
            .transpose()?;
        SlotSpec::new(slot.number, keyboard, mouse, slot.preset.clone())
            .map(|spec| {
                spec.with_persona(slot.persona)
                    .with_socd(slot.socd)
                    .with_macros(slot.macros)
            })
            .map_err(Into::into)
    }

    /// Reverse of [`ConfigFile::slot_spec`]: an instance path folds back to
    /// its alias when a `[[device]]` entry matches.
    pub fn slot_entry(&self, spec: &SlotSpec) -> SlotEntry {
        let display = |id: &DeviceId| {
            self.devices
                .iter()
                .find(|d| d.id.raw() == id.as_str())
                .map(|d| d.alias.clone())
                .unwrap_or_else(|| id.as_str().to_owned())
        };
        let (keyboard, mouse, preset, sources) = source_fields(spec, display);
        SlotEntry {
            number: spec.number,
            keyboard,
            mouse,
            preset,
            persona: spec.persona,
            socd: spec.socd,
            macros: spec.macros,
            sources,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Native main-config schema regression example.
    const DOC_EXAMPLE: &str = r#"
schema_version = 1

[settings]
block_keyboards = true
block_mice = false
mouse_move_deadzone = 5          # 0..12
starting_user_index = 1          # 1..4

[[device]]
id = "HID\\VID_D209&PID_0430&MI_00\\8&A1B2C3D4&0&0000"
alias = "P1 I-PAC"
backend = "interception"

[[slot]]
number = 1
keyboard = "P1 I-PAC"
preset = "street-fighter-p1"
"#;

    #[test]
    fn doc_example_parses() {
        let cfg: ConfigFile = toml::from_str(DOC_EXAMPLE).unwrap();
        assert_eq!(cfg.schema_version, SCHEMA_VERSION);
        assert_eq!(cfg.settings, Settings::default());
        assert_eq!(cfg.devices.len(), 1);
        assert_eq!(
            cfg.devices[0].id.raw(),
            r"HID\VID_D209&PID_0430&MI_00\8&A1B2C3D4&0&0000"
        );
        assert_eq!(cfg.devices[0].alias, "P1 I-PAC");
        assert_eq!(cfg.devices[0].backend, Backend::Interception);
        assert_eq!(cfg.slots.len(), 1);
        assert_eq!(cfg.slots[0].keyboard.as_deref(), Some("P1 I-PAC"));
        assert_eq!(cfg.slots[0].mouse, None);
        assert_eq!(cfg.slots[0].preset, "street-fighter-p1");
    }

    /// Serializing and parsing must be inverses, not merely stable.
    ///
    /// Not covered by `tests/emission.rs::populated_config_shape`, which
    /// snapshots the emitted TEXT: a field that emits one way and parses back
    /// as a DIFFERENT value leaves the text unchanged, so the snapshot stays
    /// green and pins the lossy bytes. `Blocking` is the live example — it
    /// emits as a bool and parses from a bool or a string, so the two
    /// directions can drift apart without a byte moving. This is the only
    /// test that would notice.
    #[test]
    fn round_trips_through_toml() {
        let cfg: ConfigFile = toml::from_str(DOC_EXAMPLE).unwrap();
        let serialized = toml::to_string(&cfg).unwrap();
        let reparsed: ConfigFile = toml::from_str(&serialized).unwrap();
        assert_eq!(cfg, reparsed);
    }

    #[test]
    fn missing_sections_use_defaults_and_unknown_keys_are_lenient() {
        let cfg: ConfigFile =
            toml::from_str("schema_version = 1\nfuture_option = \"ignored\"\n").unwrap();
        assert_eq!(cfg.settings, Settings::default());
        assert_eq!(cfg.settings.block_keyboards, Blocking::Whole);
        assert!(!cfg.settings.block_mice);
        assert_eq!(cfg.settings.mouse_move_deadzone, 5);
        assert_eq!(cfg.settings.starting_user_index, 1);
        assert!(cfg.devices.is_empty());
        assert!(cfg.slots.is_empty());
    }

    /// The macro master switch: absent means "on" and writes nothing, so every
    /// config that predates it round-trips byte for byte; `"off"` survives.
    #[test]
    fn the_macro_switch_defaults_to_on_and_costs_no_bytes() {
        let cfg: ConfigFile = toml::from_str(DOC_EXAMPLE).unwrap();
        assert_eq!(cfg.slots[0].macros, MacroSwitch::On);
        let text = toml::to_string(&cfg).unwrap();
        assert!(!text.contains("macros"), "{text}");
        // ...and it reaches the core spec the engine builds from.
        assert_eq!(
            cfg.slot_spec(&cfg.slots[0]).unwrap().macros,
            MacroSwitch::On
        );

        let off: ConfigFile = toml::from_str(&format!("{DOC_EXAMPLE}macros = \"off\"\n")).unwrap();
        assert_eq!(off.slots[0].macros, MacroSwitch::Off);
        assert_eq!(
            off.slot_spec(&off.slots[0]).unwrap().macros,
            MacroSwitch::Off
        );
        let text = toml::to_string(&off).unwrap();
        assert!(text.contains("macros = \"off\""), "{text}");
        assert_eq!(toml::from_str::<ConfigFile>(&text).unwrap(), off);
        // ...and back through the spec, unchanged.
        assert_eq!(
            off.slot_entry(&off.slot_spec(&off.slots[0]).unwrap()),
            off.slots[0]
        );
    }

    /// `block_keyboards` gained a third state, and the two it already had must
    /// not have moved a byte. The doc example says `true`; it has to still mean
    /// "the whole device" and still be written as `true`, because every
    /// config.toml on every machine ksx runs on says exactly that.
    #[test]
    fn block_keyboards_true_still_means_the_whole_device_and_still_writes_as_true() {
        let cfg: ConfigFile = toml::from_str(DOC_EXAMPLE).unwrap();
        assert_eq!(cfg.settings.block_keyboards, Blocking::Whole);
        let text = toml::to_string(&cfg).unwrap();
        assert!(text.contains("block_keyboards = true"), "{text}");
        assert!(!text.contains("whole"), "{text}");

        let off: ConfigFile = toml::from_str(
            &DOC_EXAMPLE.replace("block_keyboards = true", "block_keyboards = false"),
        )
        .unwrap();
        assert_eq!(off.settings.block_keyboards, Blocking::Off);
        assert!(toml::to_string(&off)
            .unwrap()
            .contains("block_keyboards = false"));
    }

    /// The new state: the desk-keyboard mode, from the file to the struct and
    /// back with nothing lost.
    #[test]
    fn block_keyboards_can_ask_for_bound_keys_only() {
        let cfg: ConfigFile = toml::from_str(
            &DOC_EXAMPLE.replace("block_keyboards = true", "block_keyboards = \"bound-keys\""),
        )
        .unwrap();
        assert_eq!(cfg.settings.block_keyboards, Blocking::BoundKeys);
        let text = toml::to_string(&cfg).unwrap();
        assert!(text.contains("block_keyboards = \"bound-keys\""), "{text}");
        assert_eq!(toml::from_str::<ConfigFile>(&text).unwrap(), cfg);
    }

    #[test]
    fn backend_winusb_parses() {
        let entry: DeviceEntry =
            toml::from_str("id = \"USB\\\\X\"\nalias = \"p\"\nbackend = \"winusb\"\n").unwrap();
        assert_eq!(entry.backend, Backend::Winusb);
    }

    /// **The cabinet's live `config.toml`, byte for byte.**
    ///
    /// This is the file on the machine ksx runs on tonight, and the whole cost
    /// of `[[device]] id` becoming a selector is paid here: `DeviceSelector::
    /// parse` uppercases legacy paths, so a config layer that stored the parsed
    /// value and wrote it back would silently edit this file every time it was
    /// loaded.
    ///
    /// The assertion is on the TEXT, not on the struct. Value equality would
    /// pass with the id rewritten and prove nothing whatsoever about the bytes
    /// on disk.
    #[test]
    fn the_live_cabinet_config_is_byte_identical_after_a_load_and_save() {
        const LIVE: &str = "schema_version = 1\n\n\
             [settings]\n\
             block_keyboards = true\n\
             block_mice = false\n\
             mouse_move_deadzone = 5\n\
             starting_user_index = 1\n\n\
             [[device]]\n\
             id = 'USB\\VID_D209&PID_0430&MI_00\\7&1A2B3C4D&0&0000'\n\
             alias = \"ipac\"\n\
             backend = \"winusb\"\n";

        let cfg: ConfigFile = toml::from_str(LIVE).unwrap();
        assert_eq!(cfg.devices[0].alias, "ipac");
        assert_eq!(cfg.devices[0].backend, Backend::Winusb);
        assert_eq!(
            toml::to_string(&cfg).unwrap(),
            LIVE,
            "a load/save cycle must not move one byte of the user's file"
        );
    }

    /// The spelling `ksx device pick` writes. It has to load, keep its exact
    /// text, and carry a selector that names a model rather than a socket —
    /// without that, `pick` writes a config that matches no hardware.
    #[test]
    fn a_usb_selector_loads_and_keeps_the_text_pick_wrote() {
        const LINE: &str = "id = \"usb:d209:0430:00\"\nalias = \"ipac\"\nbackend = \"winusb\"\n";
        let entry: DeviceEntry = toml::from_str(LINE).unwrap();
        assert_eq!(entry.id.raw(), "usb:d209:0430:00");
        assert_eq!(entry.id.selector().rung(), "model");
        assert!(entry.id.selector().survives_replug());
        assert_eq!(toml::to_string(&entry).unwrap(), LINE);
    }

    /// A laptop or PS/2 keyboard, whose id ksx's own setup wizard wrote from
    /// what Raw Input reported. Refusing an enumerator ksx does not model would
    /// break a config ksx itself produced, on upgrade, for an entirely ordinary
    /// keyboard.
    #[test]
    fn an_acpi_keyboard_entry_still_loads() {
        let entry: DeviceEntry =
            toml::from_str("id = 'ACPI\\PNP0303\\4&1A2B3C4D&0'\nalias = \"laptop\"\n").unwrap();
        assert_eq!(entry.id.raw(), r"ACPI\PNP0303\4&1A2B3C4D&0");
        assert_eq!(entry.backend, Backend::Interception);
    }

    /// An alias resolves to the id **as written**, not to a canonicalised or
    /// hardware-resolved one: resolution is one pass at session start, and the
    /// hot-swap comparison that decides whether an edit bounces a live session
    /// has to sit downstream of it, not upstream.
    #[test]
    fn resolving_an_alias_yields_the_spelling_the_file_holds() {
        let cfg: ConfigFile = toml::from_str(
            "schema_version = 1\n[[device]]\nid = \"usb:D209:0430:00\"\nalias = \"ipac\"\n",
        )
        .unwrap();
        assert_eq!(
            cfg.resolve_device("ipac").unwrap().as_str(),
            "usb:D209:0430:00"
        );
    }

    #[test]
    fn slot_spec_resolves_alias_to_instance_path() {
        let cfg: ConfigFile = toml::from_str(DOC_EXAMPLE).unwrap();
        let spec = cfg.slot_spec(&cfg.slots[0]).unwrap();
        assert_eq!(spec.number, 1);
        assert_eq!(
            spec.keyboard(),
            Some(&ksx_core::DeviceId::new(
                r"HID\VID_D209&PID_0430&MI_00\8&A1B2C3D4&0&0000"
            ))
        );
        assert_eq!(spec.mouse(), None);
        assert_eq!(spec.preset(), "street-fighter-p1");

        // And back: the id folds to its alias.
        let entry = cfg.slot_entry(&spec);
        assert_eq!(entry, cfg.slots[0]);
    }

    #[test]
    fn legacy_slot_bytes_survive_canonical_normalization() {
        let mut cfg: ConfigFile = toml::from_str(DOC_EXAMPLE).unwrap();
        let before = toml::to_string(&cfg).unwrap();
        let spec = cfg.slot_spec(&cfg.slots[0]).unwrap();
        cfg.slots[0] = cfg.slot_entry(&spec);
        assert_eq!(toml::to_string(&cfg).unwrap(), before);
        assert!(!before.contains("[[slot.source]]"), "{before}");
    }

    /// A `[[game.slot]]` and a `[[slot]]` naming the same alias must produce
    /// the same [`SlotSpec`]. They are two spellings of one sentence, and the
    /// day they stopped agreeing a claimed panel went dead with no error.
    #[test]
    fn a_game_slot_resolves_the_same_alias_the_same_way() {
        let cfg: ConfigFile = toml::from_str(DOC_EXAMPLE).unwrap();
        let game: crate::games::GameSlotEntry =
            toml::from_str("number = 1\nkeyboard = \"P1 I-PAC\"\npreset = \"street-fighter-p1\"\n")
                .unwrap();
        assert_eq!(
            cfg.game_slot_spec(&game).unwrap(),
            cfg.slot_spec(&cfg.slots[0]).unwrap()
        );
        // ...and an alias nothing defines is an error, not a literal id.
        let ghost: crate::games::GameSlotEntry =
            toml::from_str("number = 1\nkeyboard = \"ipac\"\npreset = \"p\"\n").unwrap();
        assert!(matches!(
            cfg.game_slot_spec(&ghost),
            Err(ConfigError::UnknownDeviceAlias(_))
        ));
    }

    #[test]
    fn two_keyboards_round_trip_as_independent_source_rows() {
        const FAN_IN: &str = r#"schema_version = 1

[[device]]
id = 'HID\VID_1111&PID_0001\LEFT'
alias = "left keyboard"

[[device]]
id = 'HID\VID_2222&PID_0002\RIGHT'
alias = "right keyboard"

[[slot]]
number = 1

[[slot.source]]
device = "left keyboard"
kind = "keyboard"
preset = "left-side"

[[slot.source]]
device = "right keyboard"
kind = "keyboard"
preset = "right-side"
"#;

        let cfg: ConfigFile = toml::from_str(FAN_IN).unwrap();
        let spec = cfg.slot_spec(&cfg.slots[0]).unwrap();
        assert_eq!(spec.sources.len(), 2);
        assert_eq!(spec.sources[0].kind, SourceKind::Keyboard);
        assert_eq!(
            spec.sources[0].device.as_str(),
            r"HID\VID_1111&PID_0001\LEFT"
        );
        assert_eq!(spec.sources[0].preset, "left-side");
        assert_eq!(
            spec.sources[1].device.as_str(),
            r"HID\VID_2222&PID_0002\RIGHT"
        );
        assert_eq!(spec.sources[1].preset, "right-side");

        let entry = cfg.slot_entry(&spec);
        assert_eq!(entry, cfg.slots[0]);
        let text = toml::to_string(&cfg).unwrap();
        assert_eq!(text.matches("[[slot.source]]").count(), 2, "{text}");
        assert!(!text.contains("keyboard ="), "{text}");
        assert_eq!(toml::from_str::<ConfigFile>(&text).unwrap(), cfg);
    }

    #[test]
    fn mixed_and_duplicate_source_representations_are_refused() {
        let mixed: ConfigFile = toml::from_str(
            r#"schema_version = 1
[[device]]
id = 'HID\VID_1111&PID_0001\LEFT'
alias = "left"
[[slot]]
number = 1
keyboard = "left"
preset = "default"
[[slot.source]]
device = "left"
kind = "keyboard"
preset = "default"
"#,
        )
        .unwrap();
        assert!(matches!(
            mixed.slot_spec(&mixed.slots[0]),
            Err(ConfigError::MixedSlotSourceRepresentations(1))
        ));

        let duplicate: ConfigFile = toml::from_str(
            r#"schema_version = 1
[[device]]
id = 'HID\VID_1111&PID_0001\LEFT'
alias = "left"
[[device]]
id = 'HID\VID_1111&PID_0001\LEFT'
alias = "same board"
[[slot]]
number = 1
[[slot.source]]
device = "left"
kind = "keyboard"
preset = "left-side"
[[slot.source]]
device = "same board"
kind = "keyboard"
preset = "right-side"
"#,
        )
        .unwrap();
        assert!(matches!(
            duplicate.slot_spec(&duplicate.slots[0]),
            Err(ConfigError::DuplicateSlotSource { slot: 1, .. })
        ));
    }

    #[test]
    fn source_rows_still_refuse_unknown_aliases() {
        let cfg: ConfigFile = toml::from_str(
            r#"schema_version = 1
[[slot]]
number = 1
[[slot.source]]
device = "ghost"
kind = "keyboard"
preset = "missing"
"#,
        )
        .unwrap();
        assert!(matches!(
            cfg.slot_spec(&cfg.slots[0]),
            Err(ConfigError::UnknownDeviceAlias(alias)) if alias == "ghost"
        ));
    }

    #[test]
    fn literal_instance_path_passes_through() {
        let cfg = ConfigFile::default();
        let id = cfg.resolve_device(r"HID\VID_AAAA&PID_BBBB\1&2&3").unwrap();
        assert_eq!(id.as_str(), r"HID\VID_AAAA&PID_BBBB\1&2&3");
    }

    #[test]
    fn unknown_alias_is_an_error() {
        let cfg = ConfigFile::default();
        assert!(matches!(
            cfg.resolve_device("P9 Ghost"),
            Err(ConfigError::UnknownDeviceAlias(_))
        ));
    }

    #[test]
    fn bad_slot_number_is_an_error() {
        let cfg = ConfigFile::default();
        let slot = SlotEntry {
            number: ksx_core::MAX_SLOTS + 1,
            keyboard: None,
            mouse: None,
            preset: "p".into(),
            persona: Persona::default(),
            socd: Socd::default(),
            macros: MacroSwitch::default(),
            sources: Vec::new(),
        };
        assert!(matches!(
            cfg.slot_spec(&slot),
            Err(ConfigError::InvalidSlotNumber(_))
        ));
    }
}
