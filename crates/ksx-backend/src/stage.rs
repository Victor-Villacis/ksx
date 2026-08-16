//! The staged setup's two exits: **save it** and **play it** —
//! `docs/FIRST-RUN.md` §2, moment 7.
//!
//! [`ksx_core::StagedSetup`] is the value a visit accumulates; it has no path
//! to a file and no path to a driver. This module is the only thing that gives
//! it either, and it gives it **one translation for both**:
//!
//! ```text
//!                      ┌─ [`to_config`] ─┐
//!   CommitSpec  ───────┤                 ├──► ConfigFile
//!                      └─────────────────┘        │
//!                                 ┌───────────────┴────────────────┐
//!                        [`apply`] (save)                  [`plan`] (play)
//!                     store.backup + save_config        run::plan::build_plan
//! ```
//!
//! # Why one translation is the requirement, not a tidiness
//!
//! §2: *"What is staged is what plays. There is no second translation step
//! where a saved file means something different from what the screen showed."*
//! Two functions — one that turned a stage into a session and one that turned
//! it into TOML — would be two chances to disagree, and the disagreement would
//! surface as "it worked when I pressed Play and the pads were wrong after I
//! restarted". So both exits are built from [`to_config`], and
//! [`tests::what_is_staged_is_what_plays`] pins it by planning the in-memory
//! config and the one read back off disk and comparing the two plans.
//!
//! # Which existing writers this feeds, and which it does not duplicate
//!
//! - **The config writer is `ksx_config::Store::save_config`**, behind
//!   `Store::backup`, which is the identical six lines
//!   [`crate::device_edit::apply_pick`] uses and the pattern
//!   [`crate::slots::assign`] documents. There is no second writer here: this
//!   module composes a `ConfigFile` and hands it over.
//! - **The `[[slot]]` shape comes from `ConfigFile::slot_entry`**, ksx-config's
//!   own reverse of the `slot_spec` that `build_plan` reads. Writing
//!   `SlotEntry` by hand here would be exactly the second translation above —
//!   and the round trip is already pinned by ksx-config's
//!   `slot_spec_resolves_alias_to_instance_path`.
//! - **The planner is `crate::run::plan::build_plan`**, unchanged and pure:
//!   the same function `ksx run`, `ksx daemon`, autostart and the tray's
//!   "Reload config" all reach through `resolve_as`. Play-without-saving is
//!   that function called on a `ConfigFile` that was never written, which is
//!   why a staged session refuses for exactly the reasons a saved one would.
//! - **The preset writer is `Store::save_preset`**, the same atomic save
//!   `ksx setup` and the mapper use.
//!
//! # Nothing here claims or plugs
//!
//! [`plan`] returns a plan. Claiming a board is still `ksx winusb claim`, and
//! plugging pads is still the supervisor's job at session start — `SURFACES.md`
//! §3 and `FIRST-RUN.md` §6 both require that an action which looked like a
//! menu choice never turns out to have installed a driver or claimed a board.

use std::path::PathBuf;

use ksx_config::{ConfigFile, DeviceEntry, GamesFile, PresetFile, SlotEntry, Store};
use ksx_core::stage::{CommitSpec, StageCaptureBackend};
use ksx_core::DeviceRef;

use crate::run::plan::{build_plan, PlanError, PlanSource, RunPlan};

/// Authoritative, live capture readiness checked immediately before either
/// staged exit performs its first side effect.
///
/// This is intentionally separate from `StagedSetupView::ready`, which is a
/// pure draft-validity answer. Driver availability and a USB binding can
/// change after the page was rendered, so Save and Play call this again.
#[cfg(windows)]
pub fn preflight_capture(spec: &CommitSpec) -> Result<(), ksx_api::Refusal> {
    let backend = match spec.device.backend {
        StageCaptureBackend::Interception => ksx_config::Backend::Interception,
        StageCaptureBackend::Winusb => ksx_config::Backend::Winusb,
    };
    let require_usb = matches!(
        spec.device.selector,
        ksx_core::DeviceSelector::Usb { .. } | ksx_core::DeviceSelector::InstancePath(_)
    );
    let inventory = crate::identity::LiveInventory::collect(
        require_usb,
        backend == ksx_config::Backend::Interception,
    )
    .map_err(identity_refusal)?;
    let resolved = inventory
        .resolve(&spec.device.selector, backend)
        .map_err(identity_refusal)?;

    if backend == ksx_config::Backend::Winusb
        && !resolved
            .binding
            .as_ref()
            .is_some_and(ksx_capture::Binding::is_winusb)
    {
        return Err(ksx_api::Refusal::with_remedy(
            "winusb-not-prepared",
            "the exact staged keyboard is not currently bound to winusb.sys",
            "prepare this exact keyboard for WinUSB, then Save or Play again",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn identity_refusal(error: crate::identity::IdentityError) -> ksx_api::Refusal {
    use crate::identity::IdentityError;
    match error {
        IdentityError::Enumeration(detail) => ksx_api::Refusal::with_remedy(
            "usb-enumeration-unavailable",
            detail,
            "keep the keyboard connected and try again",
        ),
        IdentityError::InterceptionUnavailable(detail) => ksx_api::Refusal::with_remedy(
            "interception-unavailable",
            detail,
            "repair the installed Interception runtime or prepare the exact keyboard for WinUSB",
        ),
        error @ (IdentityError::SelectorAmbiguous(_)
        | IdentityError::CaptureAmbiguous { .. }) => ksx_api::Refusal::with_remedy(
            "staged-device-ambiguous",
            error.to_string(),
            "disconnect the identical spare, choose a port-qualified keyboard, or prepare the exact board for WinUSB",
        ),
        IdentityError::Missing(detail) => ksx_api::Refusal::with_remedy(
            "staged-device-missing",
            detail,
            "reconnect or wake it, then choose the keyboard again",
        ),
        error @ (IdentityError::WrongBinding(_) | IdentityError::Uncorrelated(_)) => {
            ksx_api::Refusal::with_remedy(
                "capture-identity-unavailable",
                error.to_string(),
                "release the keyboard to the HID stack or choose and prepare its exact WinUSB interface",
            )
        }
    }
}

#[cfg(not(windows))]
pub fn preflight_capture(_spec: &CommitSpec) -> Result<(), ksx_api::Refusal> {
    Err(ksx_api::Refusal::new(
        "capture-unavailable",
        "keyboard capture is available only on Windows",
    ))
}

/// What a save landed on disk.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Committed {
    pub config: PathBuf,
    /// The timestamped copy taken before the config write; `None` when there
    /// was no config file yet.
    pub backup: Option<PathBuf>,
    /// The preset files written, in slot order (deduplicated: two slots may
    /// deliberately share one preset).
    pub presets: Vec<PathBuf>,
    /// The timestamped copies taken of preset files that ALREADY EXISTED.
    ///
    /// Empty on a first run, and that is the ordinary case. It is non-empty
    /// when a staged preset name collided with one on disk — see [`apply`] for
    /// why that is a backup and not a refusal.
    pub preset_backups: Vec<PathBuf>,
    /// The `[[device]]` alias every saved slot now names.
    pub alias: String,
    pub slots: Vec<u8>,
}

impl Committed {
    /// The one line a surface prints. It never says "claimed" and never says
    /// "plugged", because saving does neither.
    ///
    /// It DOES say when an existing preset was replaced, and it says it in the
    /// same sentence as the success. A save that quietly overwrote somebody's
    /// mapped preset and reported only "saved" is the shape `FIRST-RUN.md` §6
    /// bans — a screen reporting a success that is not the whole truth — and
    /// the note names the button that undoes it rather than a command.
    pub fn message(&self) -> String {
        let replaced = match self.preset_backups.len() {
            0 => String::new(),
            n => format!(
                ". {n} preset(s) of the same name were already there and have been REPLACED — a \
                 timestamped copy of each was kept, and the mapper's \"Restore backup\" puts one \
                 back"
            ),
        };
        format!(
            "saved {} controller(s) on \"{}\" to {} — nothing was claimed and no pad was plugged; \
             Play starts them{replaced}",
            self.slots.len(),
            self.alias,
            self.config.display()
        )
    }
}

/// The `ConfigFile` a staged setup MEANS, laid over whatever is already there.
///
/// `base` is the config on disk (or [`ConfigFile::default`] for a play that
/// never reads one). Its `[[device]]` and `[[slot]]` tables are *replaced* for
/// the entries this stage names and left alone otherwise:
///
/// - the staged device upserts by ALIAS, so re-picking the same board keeps one
///   entry rather than growing a second one;
/// - a staged slot replaces the `[[slot]]` of that number, because that is what
///   the screen showed for it;
/// - a `[[slot]]` the stage does not mention is untouched. A first-run visit
///   has none, but a returning user's other players must not vanish because
///   somebody re-staged player 1.
///
/// `backend` is the staged, explicitly prepared capture choice.  Save and Play
/// perform a fresh authoritative machine preflight before reaching this pure
/// translation, so persisting it cannot turn a menu intention into a claim.
pub fn to_config(base: &ConfigFile, spec: &CommitSpec) -> ConfigFile {
    let mut config = base.clone();

    // `from_selector`, not `parse`: this is an id ksx is writing for the first
    // time, so the canonical spelling IS the written one.
    let id = DeviceRef::from_selector(spec.device.selector.clone());
    match config
        .devices
        .iter_mut()
        .find(|d| d.alias.eq_ignore_ascii_case(&spec.device.alias))
    {
        Some(existing) => {
            existing.id = id.clone();
            existing.backend = match spec.device.backend {
                StageCaptureBackend::Interception => ksx_config::Backend::Interception,
                StageCaptureBackend::Winusb => ksx_config::Backend::Winusb,
            };
        }
        None => config.devices.push(DeviceEntry {
            id: id.clone(),
            alias: spec.device.alias.clone(),
            backend: match spec.device.backend {
                StageCaptureBackend::Interception => ksx_config::Backend::Interception,
                StageCaptureBackend::Winusb => ksx_config::Backend::Winusb,
            },
        }),
    }

    for staged in &spec.slots {
        // `ConfigFile::slot_entry` — ksx-config's own reverse of the
        // `slot_spec` that `build_plan` reads back. It folds the device id to
        // the alias by matching the `[[device]]` entry pushed above, which is
        // why the device goes in first.
        let entry: SlotEntry = config.slot_entry(&staged.spec);
        match config.slots.iter_mut().find(|s| s.number == entry.number) {
            Some(existing) => *existing = entry,
            None => config.slots.push(entry),
        }
    }
    config.slots.sort_by_key(|s| s.number);
    config.settings.block_keyboards = spec.blocking;
    config
}

/// The preset files a staged setup would write, deduplicated by name.
///
/// Two slots may deliberately share one preset (two players, one key map);
/// `StagedSetup::commit` has already refused the case where two slots hold
/// DIFFERENT bindings under one name, so a duplicate here is genuinely the same
/// preset and writing it twice would be the same bytes.
fn preset_files(spec: &CommitSpec) -> Vec<PresetFile> {
    let mut out: Vec<PresetFile> = Vec::with_capacity(spec.slots.len());
    for slot in &spec.slots {
        if out
            .iter()
            .any(|p| p.name.eq_ignore_ascii_case(&slot.preset.name))
        {
            continue;
        }
        out.push(PresetFile::from_core(&slot.preset));
    }
    out
}

/// **Play without saving.** The runnable plan this staged setup means, built
/// with no filesystem read and no filesystem write.
///
/// It is `build_plan` — the pure planner every other start path funnels through
/// — over the config [`to_config`] composes and the presets the stage is
/// carrying. So a staged session gets the same validation, the same refusals
/// and the same notes a saved one would, and the `[[slot]]`/preset resolution
/// happens through exactly the code `ksx run` uses.
///
/// What this does NOT do, on purpose: resolve selectors against live hardware.
/// That is `crate::run::resolve`'s one pass at session start
/// (`plan::resolve_as`), and doing it here would make merely *planning* a
/// staged setup enumerate USB — which `FIRST-RUN.md` §5 forbids of anything on
/// the looking side. The supervisor still resolves before it captures.
pub fn plan(spec: &CommitSpec) -> Result<RunPlan, PlanError> {
    let config = to_config(&ConfigFile::default(), spec);
    let presets = preset_files(spec);
    let mut plan = build_plan(&config, &GamesFile::default(), &presets, None)?;
    plan.source = PlanSource::Config;
    Ok(plan)
}

/// [`plan`], plus **the one resolution pass** — what a live staged session
/// actually starts on.
///
/// A staged setup names a board by [`ksx_core::DeviceSelector`]
/// (`usb:d209:0430:00`), and a capture backend needs a devnode. That
/// translation is `crate::run::resolve`, run once at session start, and this
/// calls the SAME `plan::resolve_devices` that `plan::resolve_as` calls — not a
/// copy — so a staged session and a saved one resolve "which board is this"
/// identically. A second answer to that question is the one this project has
/// already been wrong about (`docs/DEVICE-IDENTITY.md` §8).
///
/// Kept apart from [`plan`] because the split is the point: [`plan`] touches no
/// hardware and is what a *preview* calls, and enumeration belongs on the
/// starting side of the line `FIRST-RUN.md` §5 draws.
pub fn resolve(spec: &CommitSpec) -> Result<RunPlan, PlanError> {
    let config = to_config(&ConfigFile::default(), spec);
    let mut plan = plan(spec)?;
    crate::run::plan::resolve_devices(&mut plan, &config.devices)?;
    Ok(plan)
}

/// **Save.** Write the staged setup: presets first, then one config write
/// behind one timestamped backup.
///
/// Preset-first is the ordering `ksx setup` documents and for its reason: a
/// `[[slot]]` pointing at a preset that does not exist is the one ordering that
/// leaves a machine worse than it started — it refuses to start at the next
/// boot, long after whoever pressed Save walked away.
///
/// # A preset that already exists is BACKED UP, not silently replaced
///
/// `Store::save_preset` is an atomic overwrite with no backup of its own —
/// correct for the mapper, which is editing the file it just read. A staged
/// setup is not: it names a preset the user picked from a menu, and the name
/// it offers first (`ksx_api::preset_name_for_slot` — "Player 1") is exactly
/// the name a previous run of this same flow would have left on disk. So a
/// second visit through the journey could replace a mapped preset with an empty
/// one, and the only surviving evidence would be a pad that does nothing in a
/// game.
///
/// It is a backup rather than a refusal because the collision is usually the
/// user re-doing the setup they already did, and refusing that would leave them
/// with no way forward that is not a shell. The road back is the one the mapper
/// already renders: `MapperSlot::backup` reads these files and
/// `/map/preset/restore` puts one back — `FIRST-RUN.md` §6's "the way out of a
/// mistake is never a shell command", satisfied by a button that already
/// exists.
pub fn apply(store: &Store, spec: &CommitSpec) -> Result<Committed, ksx_config::ConfigError> {
    let mut preset_backups = Vec::new();
    let mut presets = Vec::with_capacity(spec.slots.len());
    for preset in preset_files(spec) {
        // `preset_path` resolves to the file this store would actually write —
        // the `.json` interop spelling when that is the only one on disk — so
        // the backup and the overwrite cannot land on two different files.
        if let Some(existing) = store
            .preset_path(&preset.name)
            .ok()
            .filter(|path| path.exists())
        {
            preset_backups.extend(store.backup(&existing)?);
        }
        presets.push(store.save_preset(&preset)?);
    }

    let base = store.load_config()?.value;
    let config = to_config(&base, spec);
    let path = store.root().config_path();
    let backup = store.backup(&path)?;
    let config_path = store.save_config(&config)?;

    Ok(Committed {
        config: config_path,
        backup,
        presets,
        preset_backups,
        alias: spec.device.alias.clone(),
        slots: spec.slots.iter().map(|s| s.spec.number).collect(),
    })
}

/// **Adopt the saved configuration into a fresh stage** — the reverse of
/// [`to_config`], built so the everyday screen can show the setup this
/// machine already has without anyone re-staging it by hand.
///
/// A READ of disk producing an in-memory [`StagedSetup`]; nothing is written.
/// `profile` adopts one games.toml entry (its slots, its per-game SOCD and
/// personas, its own blocking answer); absent adopts config.toml.
///
/// # Built THROUGH the staging operations, not by struct literal
///
/// `StagedSetup`'s fields are private and its doctrine is that every mutation
/// revalidates (`ksx-core/src/stage.rs`). Adoption goes through
/// `choose_device` + `add_slot` + `set_socd` + `set_blocking`, so a saved
/// file that breaks a staging rule (a persona this build cannot plug, a
/// sixth XInput slot someone hand-wrote) is REFUSED in the same words a hand
/// edit would be — never smuggled past the rules because it came off disk.
///
/// # One keyboard, and honestly refused otherwise
///
/// The stage models a single-device draft (`FIRST-RUN.md` §2). A saved setup
/// whose slots span several keyboards is real and legal on disk, and it
/// cannot become a draft — the refusal says so and names the surfaces that
/// can edit it instead, rather than silently adopting half the setup.
pub fn adopt(
    store: &Store,
    profile: Option<&str>,
) -> Result<ksx_core::StagedSetup, ksx_api::Refusal> {
    use ksx_api::codes;

    let config = store
        .load_config()
        .map_err(|err| load_refusal("config.toml", &err))?
        .value;
    let presets = store
        .load_presets()
        .map_err(|err| load_refusal("the presets folder", &err))?
        .value;

    // The slot rows + the blocking answer, from the chosen origin. Both
    // resolve through THIS config's [[device]] table (`slot_spec` /
    // `game_slot_spec`), which is what makes an alias mean one thing.
    let (specs, blocking, origin) = match profile {
        None => {
            let specs = config
                .slots
                .iter()
                .map(|slot| config.slot_spec(slot))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| load_refusal("config.toml", &err))?;
            (
                specs,
                config.settings.block_keyboards,
                "config.toml".to_owned(),
            )
        }
        Some(title) => {
            let games = store
                .load_games()
                .map_err(|err| load_refusal("games.toml", &err))?
                .value;
            let game = games
                .games
                .iter()
                .find(|game| game.title.eq_ignore_ascii_case(title.trim()))
                .ok_or_else(|| {
                    ksx_api::Refusal::with_remedy(
                        codes::REFUSED,
                        format!("no saved game is called \"{}\"", title.trim()),
                        "the exact titles are the ones `ksx run --game` and the game list show",
                    )
                })?;
            let specs = game
                .slots
                .iter()
                .map(|slot| config.game_slot_spec(slot))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| load_refusal("games.toml", &err))?;
            (specs, game.block_keyboards, format!("\"{}\"", game.title))
        }
    };
    if specs.is_empty() {
        return Err(ksx_api::Refusal::with_remedy(
            codes::REFUSED,
            format!("{origin} has no slots to adopt — there is nothing saved to show yet"),
            "set a keyboard and a controller up first; Save is what creates the slots",
        ));
    }

    // ONE keyboard. Every slot must resolve to the same [[device]] entry —
    // the entry is what carries the durable selector and the capture backend.
    let mut device: Option<&DeviceEntry> = None;
    for spec in &specs {
        let Some(keyboard) = &spec.keyboard else {
            continue;
        };
        let entry = config
            .devices
            .iter()
            .find(|entry| entry.id.raw().eq_ignore_ascii_case(keyboard.as_str()))
            .ok_or_else(|| {
                ksx_api::Refusal::with_remedy(
                    codes::REFUSED,
                    format!(
                        "slot {} names a keyboard no [[device]] entry describes, so there is no \
                         durable identity to adopt",
                        spec.number
                    ),
                    "re-pick the keyboard (Setup, or `ksx device pick`) so it gains an entry, \
                     then adopt again",
                )
            })?;
        match device {
            None => device = Some(entry),
            Some(chosen) if std::ptr::eq(chosen, entry) => {}
            Some(chosen) => {
                return Err(ksx_api::Refusal::with_remedy(
                    codes::REFUSED,
                    format!(
                        "{origin} uses more than one keyboard (\"{}\" and \"{}\"), and a draft \
                         holds exactly one",
                        chosen.alias, entry.alias
                    ),
                    "edit that setup in Setup or with `ksx slot assign`; the draft screen \
                     adopts single-keyboard setups",
                ));
            }
        }
    }
    let device = match device {
        Some(entry) => entry,
        // Legal older configs may omit per-slot keyboards; unambiguous only
        // when the config names exactly one device.
        None => match config.devices.as_slice() {
            [only] => only,
            [] => {
                return Err(ksx_api::Refusal::with_remedy(
                    codes::REFUSED,
                    format!("{origin} names no keyboard at all"),
                    "pick one in Setup (or `ksx device pick`), then adopt again",
                ))
            }
            _ => {
                return Err(ksx_api::Refusal::with_remedy(
                    codes::REFUSED,
                    format!(
                        "{origin}'s slots name no keyboard and config.toml describes several, \
                         so ksx cannot guess which one the draft should hold"
                    ),
                    "assign the slots a keyboard (`ksx slot assign`), then adopt again",
                ))
            }
        },
    };

    let stage_refusal = |refusal: ksx_core::stage::StageRefusal| {
        ksx_api::Refusal::new(refusal.code(), refusal.to_string())
    };

    let mut setup = ksx_core::StagedSetup::new()
        .choose_device(ksx_core::stage::StagedDevice {
            selector: device.id.selector().clone(),
            alias: device.alias.clone(),
            // The alias is the one human name the saved file carries; the
            // live scan's richer label can replace it on screen when a scan
            // has actually seen the board.
            label: device.alias.clone(),
            backend: match device.backend {
                ksx_config::Backend::Interception => StageCaptureBackend::Interception,
                ksx_config::Backend::Winusb => StageCaptureBackend::Winusb,
            },
        })
        .map_err(stage_refusal)?;

    for spec in &specs {
        let preset = presets
            .iter()
            .find(|preset| preset.name.eq_ignore_ascii_case(&spec.preset))
            .ok_or_else(|| {
                ksx_api::Refusal::with_remedy(
                    codes::REFUSED,
                    format!(
                        "slot {} points at preset \"{}\" and no preset of that name is on disk",
                        spec.number, spec.preset
                    ),
                    "restore or re-create the preset (`ksx preset new`), then adopt again",
                )
            })?
            .to_core()
            .map_err(|err| load_refusal("the presets folder", &err))?;
        setup = setup
            .add_slot(spec.number, spec.persona, preset)
            .map_err(stage_refusal)?
            .set_socd(spec.number, spec.socd)
            .map_err(stage_refusal)?;
    }
    // A saved answer IS an answer: adopting never re-asks §3's question.
    Ok(setup.set_blocking(blocking))
}

/// A failed read is not an absence (`SURFACES.md` §1b): adoption of a file
/// that cannot be read refuses with the reason, never with an empty draft.
fn load_refusal(what: &str, err: &ksx_config::ConfigError) -> ksx_api::Refusal {
    ksx_api::Refusal::with_remedy(
        ksx_api::codes::REFUSED,
        format!("{what} could not be read: {err}"),
        "nothing was adopted and nothing changed; fix the file and try again",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use ksx_config::ConfigRoot;
    use ksx_core::key::Key;
    use ksx_core::pad::XButton;
    use ksx_core::preset::Binding;
    use ksx_core::stage::{StagedDevice, StagedSetup};
    use ksx_core::{Blocking, DeviceSelector, Persona, Preset};

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "ksx-stage-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn store(&self) -> Store {
            let store = Store::new(ConfigRoot::at(&self.0));
            store.save_config(&ConfigFile::default()).unwrap();
            store
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// **What is saved is what adopts back.** Stage a two-player setup with a
    /// non-default SOCD, save it through the one translation (`apply`), then
    /// adopt from the same store — the draft that comes back is the setup
    /// that went in: device identity and backend, every slot's persona,
    /// bindings and SOCD, and the blocking answer (already answered, never
    /// re-asked). The one deliberate delta is the LABEL: a saved file carries
    /// only the alias, and adoption says so instead of inventing a scan.
    #[test]
    fn what_is_saved_is_what_adopts_back() {
        let root = TempRoot::new("adopt-roundtrip");
        let store = root.store();
        let staged = StagedSetup::new()
            .choose_device(device())
            .unwrap()
            .add_slot(1, Persona::Xbox360, preset("Player 1", Key::A, XButton::A))
            .unwrap()
            .add_slot(
                2,
                Persona::PlayStation,
                preset("Player 2", Key::B, XButton::B),
            )
            .unwrap()
            .set_socd(2, ksx_core::Socd::UpPriority)
            .unwrap()
            .set_blocking(Blocking::BoundKeys);
        apply(&store, &staged.commit().unwrap()).unwrap();

        let adopted = adopt(&store, None).expect("a saved setup adopts");
        let dev = adopted.device().expect("the device came back");
        assert_eq!(dev.selector, device().selector);
        assert_eq!(dev.alias, "panel");
        assert_eq!(dev.backend, StageCaptureBackend::Interception);
        assert_eq!(dev.label, "panel", "the saved file carries only the alias");
        assert_eq!(adopted.blocking(), Some(Blocking::BoundKeys));
        let slots = adopted.slots();
        assert_eq!(slots.len(), 2);
        assert_eq!(slots[0].persona, Persona::Xbox360);
        assert_eq!(slots[0].preset.name, "Player 1");
        assert_eq!(slots[0].socd, ksx_core::Socd::Off);
        assert_eq!(slots[1].persona, Persona::PlayStation);
        assert_eq!(slots[1].socd, ksx_core::Socd::UpPriority);
        assert_eq!(
            slots[1].preset.entries,
            preset("Player 2", Key::B, XButton::B).entries,
            "bindings adopt as the preset file holds them"
        );
        // ...and the adopted draft is immediately playable: commit() accepts
        // it, which is what makes adoption an everyday screen's seed.
        adopted.commit().expect("an adopted setup is complete");
    }

    /// Adopting a saved GAME takes the game's own slots and the game's own
    /// blocking answer — the per-game overrides are the whole reason profiles
    /// exist, and adoption must not flatten them into config.toml's.
    #[test]
    fn adopting_a_saved_game_takes_its_slots_and_its_own_blocking() {
        let root = TempRoot::new("adopt-game");
        let store = root.store();
        let staged = StagedSetup::new()
            .choose_device(device())
            .unwrap()
            .add_slot(1, Persona::Xbox360, preset("Panel P1", Key::A, XButton::A))
            .unwrap()
            .set_blocking(Blocking::BoundKeys);
        apply(&store, &staged.commit().unwrap()).unwrap();
        let games: GamesFile = toml::from_str(
            r#"
[[game]]
title = "Fight Night"
path = 'C:\games\fight.exe'
block_keyboards = true

[[game.slot]]
number = 1
preset = "Panel P1"
persona = "playstation"
socd = "neutral"
"#,
        )
        .unwrap();
        store.save_games(&games).unwrap();

        let adopted = adopt(&store, Some("fight night")).expect("titles match case-insensitively");
        assert_eq!(
            adopted.blocking(),
            Some(Blocking::Whole),
            "the game's own answer"
        );
        let slots = adopted.slots();
        assert_eq!(slots.len(), 1);
        assert_eq!(
            slots[0].persona,
            Persona::PlayStation,
            "per-game persona override"
        );
        assert_eq!(slots[0].socd, ksx_core::Socd::Neutral, "per-game SOCD");

        let missing = adopt(&store, Some("No Such Game")).unwrap_err();
        assert!(missing.message.contains("No Such Game"), "{missing:?}");
    }

    /// The states adoption cannot represent are REFUSED with the reason and a
    /// way forward — never half-adopted and never dressed as an empty draft.
    #[test]
    fn adopt_refuses_the_states_it_cannot_represent() {
        // Nothing saved at all.
        let root = TempRoot::new("adopt-empty");
        let empty = adopt(&root.store(), None).unwrap_err();
        assert!(empty.message.contains("has no slots to adopt"), "{empty:?}");

        // A slot whose preset file is gone.
        let root = TempRoot::new("adopt-no-preset");
        let store = root.store();
        let staged = StagedSetup::new()
            .choose_device(device())
            .unwrap()
            .add_slot(1, Persona::Xbox360, preset("Player 1", Key::A, XButton::A))
            .unwrap()
            .set_blocking(Blocking::BoundKeys);
        apply(&store, &staged.commit().unwrap()).unwrap();
        let preset_path = store.preset_path("Player 1").unwrap();
        std::fs::remove_file(&preset_path).unwrap();
        let missing = adopt(&store, None).unwrap_err();
        assert!(missing.message.contains("Player 1"), "{missing:?}");

        // Two keyboards. Legal on disk, not representable as a draft.
        let root = TempRoot::new("adopt-two-boards");
        let store = root.store();
        let staged = StagedSetup::new()
            .choose_device(device())
            .unwrap()
            .add_slot(1, Persona::Xbox360, preset("Player 1", Key::A, XButton::A))
            .unwrap()
            .set_blocking(Blocking::BoundKeys);
        apply(&store, &staged.commit().unwrap()).unwrap();
        let mut config = store.load_config().unwrap().value;
        config.devices.push(DeviceEntry {
            id: DeviceRef::from_selector(DeviceSelector::parse("usb:04d9:0169:00").unwrap()),
            alias: "desk".to_owned(),
            backend: ksx_config::Backend::Interception,
        });
        config.slots.push(SlotEntry {
            number: 2,
            keyboard: Some("desk".to_owned()),
            mouse: None,
            preset: "Player 1".to_owned(),
            persona: ksx_core::Persona::PlayStation,
            socd: ksx_core::Socd::Off,
            macros: Default::default(),
        });
        store.save_config(&config).unwrap();
        let two = adopt(&store, None).unwrap_err();
        assert!(two.message.contains("more than one keyboard"), "{two:?}");
        assert!(two.remedy.is_some(), "a refusal carries its way forward");
    }

    fn device() -> StagedDevice {
        StagedDevice {
            selector: DeviceSelector::parse("usb:d209:0430:00").unwrap(),
            alias: "panel".to_owned(),
            label: "Ultimarc I-PAC 4".to_owned(),
            backend: StageCaptureBackend::Interception,
        }
    }

    fn preset(name: &str, key: Key, button: XButton) -> Preset {
        Preset {
            name: name.to_owned(),
            entries: vec![(key, Binding::Button(button))],
            chords: Vec::new(),
            macros: Default::default(),
            turbo: Vec::new(),
            protected: false,
        }
    }

    /// Two players on one board: an Xbox pad and a PlayStation pad, split
    /// keyboard, which is the shape §3's second answer exists for.
    fn staged() -> StagedSetup {
        StagedSetup::new()
            .choose_device(device())
            .unwrap()
            .add_slot(1, Persona::Xbox360, preset("Player 1", Key::A, XButton::A))
            .unwrap()
            .add_slot(
                2,
                Persona::PlayStation,
                preset("Player 2", Key::L, XButton::B),
            )
            .unwrap()
            .set_blocking(Blocking::BoundKeys)
    }

    /// Everything about a plan a staged setup decides, as one comparable
    /// value. Deliberately not `render_human`: that report omits the persona,
    /// which is the field the whole staging flow is about.
    fn fingerprint(plan: &RunPlan) -> String {
        use std::fmt::Write as _;
        let mut out = String::new();
        let _ = writeln!(
            out,
            "block={} mice={} captureable={:?} winusb={:?} interception={}",
            plan.block_keyboards.as_str(),
            plan.block_mice,
            plan.captureable
                .iter()
                .map(|d| d.as_str())
                .collect::<Vec<_>>(),
            plan.winusb.iter().map(|d| d.as_str()).collect::<Vec<_>>(),
            plan.needs_interception(),
        );
        for slot in &plan.slots {
            let _ = writeln!(
                out,
                "slot {} persona={} preset={} keyboard={:?} socd={} macros={} entries={:?}",
                slot.spec.number,
                slot.spec.persona,
                slot.spec.preset,
                slot.spec.keyboard.as_ref().map(|k| k.as_str()),
                slot.spec.socd.as_str(),
                slot.spec.macros.is_on(),
                slot.preset.entries,
            );
        }
        out
    }

    /// **§2's requirement, pinned: what is staged is what plays.**
    ///
    /// The plan built from the staged setup with no disk anywhere near it, and
    /// the plan built from the bytes a save left behind, must be the same plan.
    ///
    /// Breaks against two versions that were both easy to write:
    ///
    /// 1. a save that fed [`crate::slots::assign`] — the existing `[[slot]]`
    ///    writer — which creates a slot with `keyboard: None`. The staged plan
    ///    has two slots; the saved one has ZERO, because `build_plan` drops a
    ///    slot with no input device as `NoInputDeviceSelected`. A cabinet that
    ///    played correctly before Save and was dead after it;
    /// 2. any save that dropped the persona or the split-or-freeze answer:
    ///    slot 2 comes back as an Xbox pad (`Persona::default()`) and the
    ///    keyboard comes back frozen, so the desk keyboard that was still
    ///    typing during Play stops typing after a restart.
    #[test]
    fn what_is_staged_is_what_plays() {
        let root = TempRoot::new("same-plan");
        let store = root.store();
        let spec = staged().commit().expect("a device and two controllers");

        // Play — no file was read and none was written to build this.
        let live = plan(&spec).expect("a staged setup plans");

        // Save, then plan the way a fresh `ksx run` would: from the bytes.
        apply(&store, &spec).expect("a save");
        let config = store.load_config().unwrap().value;
        let presets = store.load_presets().unwrap().value;
        let saved = build_plan(&config, &GamesFile::default(), &presets, None)
            .expect("the saved config plans");

        assert_eq!(
            fingerprint(&live),
            fingerprint(&saved),
            "a saved setup must mean exactly what the screen showed"
        );
        // ...and it is not two empty plans agreeing about nothing.
        assert_eq!(live.slots.len(), 2);
        assert_eq!(live.slots[1].spec.persona, Persona::PlayStation);
        assert_eq!(live.block_keyboards, Blocking::BoundKeys);
        assert_eq!(live.captureable.len(), 1, "one board, two slots");
    }

    /// Play writes nothing. Not "writes the same thing" — nothing.
    ///
    /// Breaks against a play path that went through `apply` first (the obvious
    /// shortcut: save, then plan from disk). That version makes moment 7's
    /// "saving and playing are separate acts" false, and a user who pressed
    /// Play to try something has a config.toml they never asked for.
    #[test]
    fn playing_leaves_the_config_untouched() {
        let root = TempRoot::new("play-writes-nothing");
        let store = root.store();
        let before = std::fs::read_to_string(store.root().config_path()).unwrap();
        let listing_before = std::fs::read_dir(&root.0).unwrap().count();

        let spec = staged().commit().unwrap();
        let plan = plan(&spec).unwrap();
        assert_eq!(plan.slots.len(), 2);

        assert_eq!(
            std::fs::read_to_string(store.root().config_path()).unwrap(),
            before,
            "playing must not move a byte of config.toml"
        );
        assert_eq!(
            std::fs::read_dir(&root.0).unwrap().count(),
            listing_before,
            "and must not leave a preset file or a backup behind"
        );
    }

    /// A save lands the `[[device]]`, the `[[slot]]` rows with their personas,
    /// the presets and the blocking answer — in one config write, behind one
    /// backup.
    #[test]
    fn a_save_writes_the_device_the_slots_the_presets_and_the_answer() {
        let root = TempRoot::new("save");
        let store = root.store();
        let spec = staged().commit().unwrap();

        let committed = apply(&store, &spec).unwrap();
        assert_eq!(committed.slots, vec![1, 2]);
        assert_eq!(committed.presets.len(), 2);
        assert!(committed.backup.is_some(), "a whole-file write backs up");
        assert!(
            committed.message().contains("nothing was claimed"),
            "{}",
            committed.message()
        );

        let text = std::fs::read_to_string(store.root().config_path()).unwrap();
        assert!(text.contains("alias = \"panel\""), "{text}");
        assert!(text.contains("id = \"usb:d209:0430:00\""), "{text}");
        assert!(text.contains("keyboard = \"panel\""), "{text}");
        assert!(text.contains("persona = \"playstation\""), "{text}");
        assert!(text.contains("block_keyboards = \"bound-keys\""), "{text}");

        // The presets are real files the mapper can go on editing.
        let names: Vec<String> = store
            .load_presets()
            .unwrap()
            .value
            .iter()
            .map(|p| p.name.clone())
            .collect();
        assert!(names.contains(&"Player 1".to_owned()), "{names:?}");
        assert!(names.contains(&"Player 2".to_owned()), "{names:?}");
    }

    /// A returning user's other players survive a re-stage, and re-picking the
    /// same board does not grow a second `[[device]]`.
    ///
    /// Breaks against a `to_config` that replaced the whole `[[slot]]` table:
    /// staging player 1 again would delete players 3 and 4 off a working
    /// cabinet, with a Save button as the only warning.
    #[test]
    fn saving_replaces_the_staged_slots_and_leaves_the_others_alone() {
        let root = TempRoot::new("merge");
        let store = root.store();

        // A cabinet that already has a player 4 and a device entry.
        let mut base = ConfigFile::default();
        base.devices.push(DeviceEntry {
            id: "usb:d209:0430:00".parse().unwrap(),
            alias: "panel".into(),
            backend: ksx_config::Backend::Winusb,
        });
        base.slots.push(SlotEntry {
            number: 4,
            keyboard: Some("panel".into()),
            mouse: None,
            preset: "Player 4".into(),
            persona: Persona::PlayStation,
            socd: Default::default(),
            macros: Default::default(),
        });
        store.save_config(&base).unwrap();

        let spec = staged().commit().unwrap();
        apply(&store, &spec).unwrap();

        let after = store.load_config().unwrap().value;
        assert_eq!(after.devices.len(), 1, "the same board, not a second entry");
        assert_eq!(
            after.devices[0].backend,
            ksx_config::Backend::Interception,
            "the explicitly staged, live-preflighted backend replaces stale config state"
        );
        let numbers: Vec<u8> = after.slots.iter().map(|s| s.number).collect();
        assert_eq!(numbers, vec![1, 2, 4], "player 4 is still there");
        assert_eq!(after.slots[2].preset, "Player 4");
    }

    /// **A returning user's split-or-freeze answer is never overwritten by a
    /// question nobody was asked.**
    ///
    /// `to_config` assigns `settings.block_keyboards` unconditionally, which is
    /// correct — a save writes what the screen showed — and was a data-loss bug
    /// for exactly as long as `commit()` could produce a `blocking` nobody had
    /// chosen. It read `effective_blocking()` (`unwrap_or_default()` == Whole),
    /// so a returning user who had chosen SPLIT, staged a second controller and
    /// pressed Save got their keyboard frozen: the desk keyboard that was still
    /// typing yesterday stops typing today, and nothing on screen ever asked.
    ///
    /// The fix is upstream and structural — `commit()` refuses an unanswered
    /// question — so this test asserts the property through the same door a
    /// surface uses: there is no reachable path from "not asked" to a written
    /// value.
    #[test]
    fn an_unanswered_question_cannot_write_over_the_answer_already_on_disk() {
        let root = TempRoot::new("blocking");
        let store = root.store();

        // Yesterday: this cabinet is SPLIT, so the keyboard still types.
        let mut base = ConfigFile::default();
        base.settings.block_keyboards = Blocking::BoundKeys;
        store.save_config(&base).unwrap();

        // Today: a device, a mapped controller, and §3 never asked.
        let unasked = StagedSetup::new()
            .choose_device(device())
            .unwrap()
            .add_slot(1, Persona::Xbox360, preset("Player 1", Key::A, XButton::A))
            .unwrap();
        assert_eq!(unasked.blocking(), None);
        let refused = unasked.commit().unwrap_err();
        assert_eq!(
            refused.code(),
            "blocking-unanswered",
            "there must be no CommitSpec for an unasked question — that is the only \
             thing standing between it and `to_config`"
        );
        assert_eq!(
            store.load_config().unwrap().value.settings.block_keyboards,
            Blocking::BoundKeys,
            "the answer on disk is untouched"
        );

        // And when they DO answer, the answer is what lands — including the
        // one that happens to equal the default, which must be written because
        // it was chosen and not because it was assumed.
        let spec = unasked.set_blocking(Blocking::Whole).commit().unwrap();
        assert_eq!(spec.blocking, Blocking::Whole);
        apply(&store, &spec).unwrap();
        assert_eq!(
            store.load_config().unwrap().value.settings.block_keyboards,
            Blocking::Whole
        );
    }

    /// **A preset the save would replace is copied first.**
    ///
    /// Breaks against the shipped `apply`, which called `Store::save_preset`
    /// straight — an atomic overwrite with no backup of its own. The staging
    /// flow offers "Player 1" as the FIRST preset name it suggests
    /// (`ksx_api::preset_name_for_slot`), so the second visit through the
    /// journey silently replaced the mapped preset from the first one with an
    /// empty table. The only symptom is a pad that does nothing in a game, and
    /// by then there is no file left to compare against.
    ///
    /// The assertion is on the CONTENTS of the backup, not merely on its
    /// existence: a copy taken after the write would satisfy "a .bak exists"
    /// and preserve nothing.
    #[test]
    fn a_save_copies_a_preset_it_is_about_to_replace() {
        let root = TempRoot::new("preset-backup");
        let store = root.store();

        // What the user mapped on their first visit.
        let mapped = PresetFile::from_core(&preset("Player 1", Key::Z, XButton::X));
        store.save_preset(&mapped).unwrap();
        let before = std::fs::read_to_string(store.preset_path("Player 1").unwrap()).unwrap();

        // The second visit stages a DIFFERENT "Player 1" — a fresh layout,
        // under the name the flow offers first — and saves it. (An empty one
        // cannot get this far any more: `commit()` refuses a controller that
        // binds nothing. The collision is the same either way, and this is the
        // shape a second visit really has.)
        let spec = StagedSetup::new()
            .choose_device(device())
            .unwrap()
            .add_slot(1, Persona::Xbox360, preset("Player 1", Key::Q, XButton::Y))
            .unwrap()
            .set_blocking(Blocking::Whole)
            .commit()
            .unwrap();
        let committed = apply(&store, &spec).unwrap();

        assert_eq!(
            committed.preset_backups.len(),
            1,
            "an existing preset was overwritten with no copy kept: {committed:?}"
        );
        let kept = std::fs::read_to_string(&committed.preset_backups[0]).unwrap();
        assert_eq!(
            kept, before,
            "the copy must be of the file as it was BEFORE the write"
        );
        assert!(kept.contains("Z"), "{kept}");
        // …and the flash says so. A save that reported only "saved" while it
        // had replaced a mapped preset is a screen reporting a success that is
        // not the whole truth.
        let said = committed.message();
        assert!(said.contains("REPLACED"), "{said}");
        assert!(said.contains("Restore backup"), "{said}");

        // ...and a preset that did NOT exist leaves no backup behind, so a
        // first run does not litter the presets folder with copies of nothing.
        let root = TempRoot::new("preset-no-backup");
        let store = root.store();
        let committed = apply(&store, &spec).unwrap();
        assert!(
            committed.preset_backups.is_empty(),
            "{committed:?} backed up a file that was not there"
        );
    }

    /// The device is written as the SELECTOR the stage held, never as a raw
    /// instance path.
    ///
    /// Breaks against a commit path that reached for whatever devnode a scan
    /// had reported: that entry pins the cabinet to one USB socket, and it is
    /// the string `FIRST-RUN.md` §5 bans from ever being the identifier.
    #[test]
    fn the_saved_device_id_is_the_selector_and_survives_a_replug() {
        let root = TempRoot::new("selector");
        let store = root.store();
        apply(&store, &staged().commit().unwrap()).unwrap();

        let entry = &store.load_config().unwrap().value.devices[0];
        assert_eq!(entry.id.raw(), "usb:d209:0430:00");
        assert!(!entry.id.raw().contains('\\'), "never a raw path");
        assert!(entry.id.selector().survives_replug());
        assert_eq!(entry.id.selector().rung(), "model");
    }
}
