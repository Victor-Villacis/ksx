//! Instantiating an in-box template into a preset file — the write half of
//! `ksx preset new`, extracted so it has exactly one implementation.
//!
//! [`crate::preset_cli`] is the console driver: it parses flags, prints TOML
//! for `--dry-run`, and exits with a code. Everything it *decides* is here,
//! in the same typed-spec / pure-plan / one-writer shape as
//! [`crate::device_edit`] — because the console is no longer the only caller.
//! Studio's Profiles page performs the identical verb, and a second copy of
//! "refuse to clobber, then back up, then save" is how the two grow apart:
//! one of them gets the backup, the other does not, and nobody finds out
//! until a preset is gone.
//!
//! The split is drawn where the process boundary is. [`plan_new`] takes the
//! path of the preset already on disk (or `None`) rather than a `Store`, so
//! every refusal is unit-testable with no config root; [`apply_new`] is the
//! only thing that touches the filesystem, and it takes the backup first.

use std::path::{Path, PathBuf};

use ksx_config::{ConfigError, ConfigFile, GamesFile, PresetFile, Store};
use ksx_core::templates::{self, TemplateError};

/// One `ksx preset new`, as any surface spells it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewPresetSpec {
    pub name: String,
    /// The template id (`ksx_core::templates::TEMPLATES`).
    pub template: String,
    /// Which player block, 1-based.
    pub player: u8,
    /// Overwrite an existing preset of that name (a backup is taken first).
    pub force: bool,
}

/// Everything `new` decided, before a byte is written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewPresetPlan {
    /// The file, whole, ready to serialize.
    pub file: PresetFile,
    /// The template it came from, as asked for.
    pub template: String,
    pub player: u8,
    /// A preset of this name is already on disk and `--force` was given.
    pub overwrites: bool,
}

/// Why a preset could not be written.
#[derive(Debug, thiserror::Error)]
pub enum PresetError {
    #[error("{0}")]
    Template(#[from] TemplateError),
    #[error("a preset called \"{name}\" already exists ({})", path.display())]
    Exists { name: String, path: PathBuf },
    #[error("{0}")]
    Config(#[from] ConfigError),
    #[error("a preset called \"{name}\" already exists")]
    NameTaken { name: String },
    #[error("no preset called \"{name}\" is on disk")]
    Unknown { name: String, known: Vec<String> },
    #[error("preset \"{name}\" is still used by {breaks} slot(s)")]
    InUse { name: String, breaks: usize },
}

impl PresetError {
    /// The stable refusal word — the same one `ksx preset new --json` prints,
    /// which is why the mapping lives here and not in the console driver.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Template(TemplateError::Unknown(_)) => "unknown-template",
            Self::Template(TemplateError::NoSuchPlayer { .. }) => "no-such-player",
            Self::Template(TemplateError::EmptyName) => "bad-name",
            Self::Exists { .. } | Self::NameTaken { .. } => "preset-exists",
            Self::Config(_) => "config-error",
            Self::Unknown { .. } => "unknown-preset",
            Self::InUse { .. } => "preset-in-use",
        }
    }

    /// What to do about it.
    pub fn advice(&self) -> Option<String> {
        match self {
            Self::Template(_) => {
                Some("`ksx preset list --templates` names the ones that ship.".to_owned())
            }
            Self::Exists { .. } => {
                Some("--force overwrites it (a timestamped backup is taken first).".to_owned())
            }
            // Deliberately NOT the --force sentence above: `preset rename` has
            // no --force, and pointing at a flag the verb does not have is a
            // refusal that wastes the reader's next minute.
            Self::NameTaken { .. } => Some(
                "pick a different name, or remove that preset first with `ksx preset delete`."
                    .to_owned(),
            ),
            Self::Config(_) => None,
            Self::Unknown { known, .. } => Some(if known.is_empty() {
                "`ksx preset list` names the ones on disk.".to_owned()
            } else {
                format!("on disk: {}", known.join(", "))
            }),
            Self::InUse { .. } => Some(
                "point those slots somewhere else first, or --force to delete anyway and leave them naming a preset that is not there."
                    .to_owned(),
            ),
        }
    }
}

/// Decide the whole file. Pure: no store, no disk.
///
/// `existing` is the path of the preset already on disk under this name, or
/// `None`. It is a path rather than a bool so the refusal can print WHICH file
/// it is protecting — a user with a portable install and an installed one has
/// two, and "already exists" without a path is a sentence about neither.
pub fn plan_new(
    existing: Option<&Path>,
    spec: &NewPresetSpec,
) -> Result<NewPresetPlan, PresetError> {
    let preset = templates::instantiate(&spec.template, &spec.name, spec.player)?;
    if let Some(path) = existing {
        if !spec.force {
            return Err(PresetError::Exists {
                name: spec.name.clone(),
                path: path.to_path_buf(),
            });
        }
    }
    Ok(NewPresetPlan {
        file: PresetFile::from_core(&preset),
        template: spec.template.clone(),
        player: spec.player,
        overwrites: existing.is_some(),
    })
}

/// What landed on disk.
#[derive(Clone, Debug)]
pub struct NewPresetOutcome {
    pub path: PathBuf,
    /// The timestamped copy taken before an overwrite; `None` for a new file.
    pub backup: Option<PathBuf>,
    pub plan: NewPresetPlan,
}

/// Write the file `plan` describes. Only ever destructive with `force`, and
/// never without a copy first.
pub fn apply_new(store: &Store, plan: &NewPresetPlan) -> Result<NewPresetOutcome, PresetError> {
    let backup = if plan.overwrites {
        store.backup(&store.preset_path(&plan.file.name)?)?
    } else {
        None
    };
    let written = store.save_preset(&plan.file)?;
    Ok(NewPresetOutcome {
        path: written,
        backup,
        plan: plan.clone(),
    })
}

impl NewPresetOutcome {
    /// The one-line report a surface flashes — one line, and under the
    /// 300-character cap `ksx-studio`'s flash truncates at.
    pub fn message(&self) -> String {
        format!(
            "{} preset \"{}\" — {} controls from \"{}\" (player {})",
            if self.plan.overwrites {
                "replaced"
            } else {
                "created"
            },
            self.plan.file.name,
            self.plan.file.bindings.len(),
            self.plan.template,
            self.plan.player,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// A throwaway config root holding two presets, a `[[slot]]` naming one,
    /// and a games.toml profile naming it too.
    struct TempRoot(std::path::PathBuf);

    impl TempRoot {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "ksx-presetedit-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn store(&self) -> Store {
            let store = Store::new(ksx_config::ConfigRoot::at(&self.0));
            for name in ["Panel P1", "Panel P2"] {
                let file: PresetFile =
                    toml::from_str(&format!("name = \"{name}\"\n[bindings]\nA = \"S\"\n")).unwrap();
                store.save_preset(&file).unwrap();
            }
            let config: ConfigFile = toml::from_str(
                "schema_version = 1\n[[slot]]\nnumber = 1\npreset = \"Panel P1\"\n[[slot]]\nnumber = 2\npreset = \"Panel P2\"\n",
            )
            .unwrap();
            store.save_config(&config).unwrap();
            let games: GamesFile = toml::from_str(
                "[[game]]\ntitle = \"Example\"\npath = \"C:/x.exe\"\n[[game.slot]]\nnumber = 1\npreset = \"Panel P1\"\n",
            )
            .unwrap();
            store.save_games(&games).unwrap();
            store
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// **A rename carries every reference with it.**
    ///
    /// This is why rename is a plan/apply pair and not a file move: a preset is
    /// named by config.toml's slots AND by every games.toml profile, so moving
    /// the file alone leaves a config that still parses and then refuses to run.
    #[test]
    fn renaming_a_preset_rewrites_the_slots_that_name_it() {
        let root = TempRoot::new("rename");
        let store = root.store();
        let presets = store.load_presets().unwrap().value;
        let config = store.load_config().unwrap().value;
        let games = store.load_games().unwrap().value;

        let plan = plan_rename(
            &presets,
            &config,
            &games,
            &RenameSpec {
                from: "panel p1".into(),
                to: "Player One".into(),
            },
        )
        .expect("a rename of a preset that exists");
        assert_eq!(plan.from, "Panel P1", "the file's own spelling wins");
        assert_eq!(
            plan.references.len(),
            2,
            "one config slot, one profile slot"
        );

        let out = apply_rename(&store, &plan).expect("the rename applies");

        let config = store.load_config().unwrap().value;
        assert_eq!(config.slots[0].preset, "Player One");
        assert_eq!(config.slots[1].preset, "Panel P2", "untouched");
        let games = store.load_games().unwrap().value;
        assert_eq!(games.games[0].slots[0].preset, "Player One");

        let names: Vec<String> = store
            .load_presets()
            .unwrap()
            .value
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert!(names.contains(&"Player One".to_owned()));
        assert!(
            !names.contains(&"Panel P1".to_owned()),
            "the old file is gone: {names:?}"
        );
        assert!(!out.backups.is_empty(), "the rewrite took a backup first");
    }

    #[test]
    fn renaming_a_preset_rewrites_canonical_source_rows() {
        let root = TempRoot::new("rename-canonical-sources");
        let store = root.store();

        let mut config = store.load_config().unwrap().value;
        config.slots[0].preset.clear();
        config.slots[0].sources = vec![ksx_config::SourceEntry::new(
            "panel",
            ksx_core::SourceKind::Keyboard,
            "panel p1",
        )];
        store.save_config(&config).unwrap();

        let mut games = store.load_games().unwrap().value;
        games.games[0].slots[0].preset.clear();
        games.games[0].slots[0].sources = vec![ksx_config::SourceEntry::new(
            r"HID\PANEL\ONE",
            ksx_core::SourceKind::Keyboard,
            "Panel P1",
        )];
        store.save_games(&games).unwrap();

        let plan = plan_rename(
            &store.load_presets().unwrap().value,
            &config,
            &games,
            &RenameSpec {
                from: "Panel P1".to_owned(),
                to: "Player One".to_owned(),
            },
        )
        .unwrap();
        assert_eq!(plan.references.len(), 2, "one reference per slot");
        apply_rename(&store, &plan).unwrap();

        let config = store.load_config().unwrap().value;
        assert!(config.slots[0].preset.is_empty());
        assert_eq!(config.slots[0].sources[0].preset, "Player One");
        let games = store.load_games().unwrap().value;
        assert!(games.games[0].slots[0].preset.is_empty());
        assert_eq!(games.games[0].slots[0].sources[0].preset, "Player One");
    }

    /// Renaming ONTO another preset is refused. A rename is not an overwrite,
    /// and `new --force` is where overwriting lives.
    #[test]
    fn renaming_onto_an_existing_preset_is_refused() {
        let root = TempRoot::new("clash");
        let store = root.store();
        let presets = store.load_presets().unwrap().value;
        let err = plan_rename(
            &presets,
            &store.load_config().unwrap().value,
            &store.load_games().unwrap().value,
            &RenameSpec {
                from: "Panel P1".into(),
                to: "Panel P2".into(),
            },
        )
        .expect_err("that name is taken");
        assert_eq!(err.code(), "preset-exists", "{err}");
    }

    /// **Deleting a preset that slots still name is refused, and says how many.**
    ///
    /// `--force` goes through and leaves them dangling, which `ksx run` refuses
    /// in words -- a visible break rather than a silent repair, because nothing
    /// here can know which preset the user meant instead.
    #[test]
    fn deleting_a_preset_in_use_is_refused_unless_forced() {
        let root = TempRoot::new("delete");
        let store = root.store();
        let presets = store.load_presets().unwrap().value;
        let config = store.load_config().unwrap().value;
        let games = store.load_games().unwrap().value;

        let err = plan_delete(
            &presets,
            &config,
            &games,
            &store,
            &DeleteSpec {
                name: "Panel P1".into(),
                force: false,
            },
        )
        .expect_err("two slots still name it");
        assert_eq!(err.code(), "preset-in-use", "{err}");
        assert!(err.advice().is_some_and(|a| a.contains("--force")), "{err}");

        let plan = plan_delete(
            &presets,
            &config,
            &games,
            &store,
            &DeleteSpec {
                name: "Panel P1".into(),
                force: true,
            },
        )
        .expect("forced");
        assert_eq!(plan.breaks.len(), 2, "it says what it is about to break");
        let out = apply_delete(&store, &plan).expect("the delete applies");
        assert!(out.backup.is_some(), "a hand-authored file is copied first");

        let names: Vec<String> = store
            .load_presets()
            .unwrap()
            .value
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert_eq!(names, vec!["Panel P2".to_owned()]);
        assert_eq!(
            store.load_config().unwrap().value.slots[0].preset,
            "Panel P1",
            "the dangling reference is LEFT, not silently repointed"
        );
    }

    /// An unknown name is refused by name, and the refusal lists what is there.
    #[test]
    fn deleting_something_that_is_not_there_says_what_is() {
        let root = TempRoot::new("unknown");
        let store = root.store();
        let presets = store.load_presets().unwrap().value;
        let err = plan_delete(
            &presets,
            &store.load_config().unwrap().value,
            &store.load_games().unwrap().value,
            &store,
            &DeleteSpec {
                name: "Nope".into(),
                force: false,
            },
        )
        .expect_err("no such preset");
        assert_eq!(err.code(), "unknown-preset", "{err}");
        let advice = err.advice().unwrap_or_default();
        assert!(
            advice.contains("Panel P1") && advice.contains("Panel P2"),
            "{advice}"
        );
    }

    fn spec(name: &str, template: &str) -> NewPresetSpec {
        NewPresetSpec {
            name: name.to_owned(),
            template: template.to_owned(),
            player: 1,
            force: false,
        }
    }

    /// Task #14's template, which is the one a desk-keyboard owner needs and
    /// the reason the Profiles page offers a template list at all.
    #[test]
    fn the_two_player_desktop_keyboard_template_instantiates() {
        let plan = plan_new(None, &spec("Couch", "keyboard-2p")).unwrap();
        assert_eq!(plan.file.name, "Couch");
        assert!(!plan.file.bindings.is_empty());
        assert!(!plan.overwrites);
    }

    #[test]
    fn an_unknown_template_refuses_and_names_the_list() {
        let err = plan_new(None, &spec("X", "nope")).unwrap_err();
        assert_eq!(err.code(), "unknown-template");
        assert!(err.advice().unwrap().contains("--templates"));
    }

    #[test]
    fn a_player_block_the_template_does_not_carry_refuses() {
        let mut asked = spec("X", "keyboard-wasd");
        asked.player = 3;
        let err = plan_new(None, &asked).unwrap_err();
        assert_eq!(err.code(), "no-such-player");
    }

    /// The clobber guard, and the path in the sentence.
    #[test]
    fn an_existing_preset_is_never_overwritten_without_force() {
        let path = PathBuf::from("C:\\cfg\\presets\\Couch.toml");
        let err = plan_new(Some(&path), &spec("Couch", "keyboard-2p")).unwrap_err();
        assert_eq!(err.code(), "preset-exists");
        assert!(err.to_string().contains("Couch.toml"), "{err}");

        let mut forced = spec("Couch", "keyboard-2p");
        forced.force = true;
        let plan = plan_new(Some(&path), &forced).unwrap();
        assert!(plan.overwrites);
    }

    #[test]
    fn an_empty_name_refuses() {
        let err = plan_new(None, &spec("   ", "keyboard-2p")).unwrap_err();
        assert_eq!(err.code(), "bad-name");
    }
}

// ---------------------------------------------------------------------------
// rename / delete — the two verbs a preset has never had
// ---------------------------------------------------------------------------

/// Where a preset NAME is written down, outside the file itself.
///
/// A preset is referenced BY NAME from `config.toml`'s `[[slot]]` list and from
/// every `games.toml` profile's slots. Those names are the whole reason rename
/// and delete are not file operations: a rename that moves the file and leaves
/// the references behind produces a config that validates and then fails to
/// run, which is the worst of both.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PresetRef {
    pub slot: u8,
    /// `None` for `config.toml`'s own slots; otherwise the games.toml title.
    pub profile: Option<String>,
}

/// Every place `name` is named. Case-insensitive, like the rest of preset
/// lookup — the store matches a preset file that way, so the references have
/// to be found the same way or a rename would miss the ones spelled
/// differently.
pub fn preset_references(config: &ConfigFile, games: &GamesFile, name: &str) -> Vec<PresetRef> {
    let mut out = Vec::new();
    for slot in &config.slots {
        if slot.preset.eq_ignore_ascii_case(name)
            || slot
                .sources
                .iter()
                .any(|source| source.preset.eq_ignore_ascii_case(name))
        {
            out.push(PresetRef {
                slot: slot.number,
                profile: None,
            });
        }
    }
    for game in &games.games {
        for slot in &game.slots {
            if slot.preset.eq_ignore_ascii_case(name)
                || slot
                    .sources
                    .iter()
                    .any(|source| source.preset.eq_ignore_ascii_case(name))
            {
                out.push(PresetRef {
                    slot: slot.number,
                    profile: Some(game.title.clone()),
                });
            }
        }
    }
    out
}

/// What to rename, and to what.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RenameSpec {
    pub from: String,
    pub to: String,
}

/// A decided rename. Pure: nothing has moved yet.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RenamePlan {
    /// The name as the FILE spells it, not as the caller typed it.
    pub from: String,
    pub to: String,
    /// The references that will be rewritten to point at the new name.
    pub references: Vec<PresetRef>,
}

/// What to delete.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeleteSpec {
    pub name: String,
    /// Delete even though slots still name it. They are left pointing at a
    /// preset that is not there, which `ksx run` refuses — deliberately a
    /// visible break rather than a silent repair, because ksx cannot know
    /// which preset the user meant instead.
    pub force: bool,
}

/// A decided delete.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeletePlan {
    pub name: String,
    pub path: PathBuf,
    /// Slots that will be left dangling. Empty unless `force`.
    pub breaks: Vec<PresetRef>,
}

/// Decide a rename. Pure except for the two lookups it is given.
pub fn plan_rename(
    presets: &[PresetFile],
    config: &ConfigFile,
    games: &GamesFile,
    spec: &RenameSpec,
) -> Result<RenamePlan, PresetError> {
    let to = spec.to.trim();
    if to.is_empty() {
        return Err(PresetError::Template(TemplateError::EmptyName));
    }
    // The file's own spelling wins, exactly as `plan_new` lets disk decide.
    let Some(from) = presets
        .iter()
        .find(|p| p.name.eq_ignore_ascii_case(spec.from.trim()))
        .map(|p| p.name.clone())
    else {
        return Err(PresetError::Unknown {
            name: spec.from.trim().to_owned(),
            known: presets.iter().map(|p| p.name.clone()).collect(),
        });
    };
    // Renaming to the name it already has is not an error and not a write.
    // Renaming ONTO another preset is refused: a rename is not an overwrite,
    // and `--force` on `new` is where overwriting lives.
    if !to.eq_ignore_ascii_case(&from) {
        if let Some(clash) = presets.iter().find(|p| p.name.eq_ignore_ascii_case(to)) {
            return Err(PresetError::NameTaken {
                name: clash.name.clone(),
            });
        }
    }
    Ok(RenamePlan {
        references: preset_references(config, games, &from),
        from,
        to: to.to_owned(),
    })
}

/// Decide a delete.
pub fn plan_delete(
    presets: &[PresetFile],
    config: &ConfigFile,
    games: &GamesFile,
    store: &Store,
    spec: &DeleteSpec,
) -> Result<DeletePlan, PresetError> {
    let Some(name) = presets
        .iter()
        .find(|p| p.name.eq_ignore_ascii_case(spec.name.trim()))
        .map(|p| p.name.clone())
    else {
        return Err(PresetError::Unknown {
            name: spec.name.trim().to_owned(),
            known: presets.iter().map(|p| p.name.clone()).collect(),
        });
    };
    let breaks = preset_references(config, games, &name);
    if !breaks.is_empty() && !spec.force {
        return Err(PresetError::InUse {
            name,
            breaks: breaks.len(),
        });
    }
    Ok(DeletePlan {
        path: store.canonical_preset_path(&name)?,
        name,
        breaks,
    })
}

/// What a rename did.
#[derive(Clone, Debug)]
pub struct RenameOutcome {
    pub plan: RenamePlan,
    /// The file now on disk under the new name.
    pub written: PathBuf,
    /// The old file, removed.
    pub removed: PathBuf,
    /// Config/games backups, when references had to be rewritten.
    pub backups: Vec<PathBuf>,
}

/// What a delete did.
#[derive(Clone, Debug)]
pub struct DeleteOutcome {
    pub plan: DeletePlan,
    /// The timestamped copy taken before the file was removed. A preset is a
    /// hand-authored document; deleting one with no copy is the kind of thing
    /// a person only discovers they minded afterwards.
    pub backup: Option<PathBuf>,
}

/// Carry out a rename: write under the new name, rewrite every reference, then
/// remove the old file.
///
/// ORDER MATTERS AND IS THE POINT. The new file is written FIRST and the old
/// one removed LAST, so every intermediate state has at least one file a slot
/// can resolve. Crash between them and the machine has a duplicate, which
/// `ksx run` handles; crash the other way round and it has nothing.
pub fn apply_rename(store: &Store, plan: &RenamePlan) -> Result<RenameOutcome, PresetError> {
    let Some(loaded) = store.load_preset(&plan.from)? else {
        return Err(PresetError::Unknown {
            name: plan.from.clone(),
            known: Vec::new(),
        });
    };
    let mut file = loaded.value;
    file.name = plan.to.clone();
    let written = store.save_preset(&file)?;

    let mut backups = Vec::new();
    if !plan.references.is_empty() {
        let mut config = store.load_config()?.value;
        let mut touched = false;
        for slot in &mut config.slots {
            if slot.preset.eq_ignore_ascii_case(&plan.from) {
                slot.preset = plan.to.clone();
                touched = true;
            }
            for source in &mut slot.sources {
                if source.preset.eq_ignore_ascii_case(&plan.from) {
                    source.preset = plan.to.clone();
                    touched = true;
                }
            }
        }
        if touched {
            let path = store.root().config_path();
            backups.extend(store.backup(&path)?);
            store.save_config(&config)?;
        }

        let mut games = store.load_games()?.value;
        let mut touched = false;
        for game in &mut games.games {
            for slot in &mut game.slots {
                if slot.preset.eq_ignore_ascii_case(&plan.from) {
                    slot.preset = plan.to.clone();
                    touched = true;
                }
                for source in &mut slot.sources {
                    if source.preset.eq_ignore_ascii_case(&plan.from) {
                        source.preset = plan.to.clone();
                        touched = true;
                    }
                }
            }
        }
        if touched {
            let path = store.root().games_path();
            backups.extend(store.backup(&path)?);
            store.save_games(&games)?;
        }
    }

    let removed = store.canonical_preset_path(&plan.from)?;
    if removed != written {
        std::fs::remove_file(&removed).map_err(|err| {
            PresetError::Config(ConfigError::Io {
                path: removed.clone(),
                source: err,
            })
        })?;
    }
    Ok(RenameOutcome {
        plan: plan.clone(),
        written,
        removed,
        backups,
    })
}

/// Carry out a delete: back the file up, then remove it.
///
/// References are NOT rewritten. A slot naming a preset that is gone is a
/// refusal `ksx run` already makes in words, and ksx cannot know which preset
/// the user meant instead — inventing one would be worse than the break.
pub fn apply_delete(store: &Store, plan: &DeletePlan) -> Result<DeleteOutcome, PresetError> {
    let backup = store.backup(&plan.path)?;
    std::fs::remove_file(&plan.path).map_err(|err| {
        PresetError::Config(ConfigError::Io {
            path: plan.path.clone(),
            source: err,
        })
    })?;
    Ok(DeleteOutcome {
        plan: plan.clone(),
        backup,
    })
}
