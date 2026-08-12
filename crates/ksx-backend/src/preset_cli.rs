//! `ksx preset` — what presets exist, and starting a new one from an in-box
//! template.
//!
//! Two verbs, both of which exist to answer a question a fresh install cannot
//! otherwise answer:
//!
//! - `ksx preset list` — the presets on disk (and, with `--templates`, the
//!   layouts shipped in the binary).
//! - `ksx preset new <NAME> --from-template <ID>` — one atomic write that
//!   turns a template into an ordinary, editable preset file.
//!
//! The templates themselves live in `ksx_core::templates`, next to the
//! built-ins they sit beside, because they are the SAME kind of thing: data
//! that ships in code. What this module adds is only the file half — naming,
//! refusing to clobber, and the backup that makes `--force` survivable.
//!
//! Why this verb exists at all is `docs/MAPPER-UX.md` commandment 9: the best
//! mapping session is none. A person who bought a standard six-button panel
//! should type one command and be playing, not press twenty buttons to
//! describe a layout MAME has known for thirty years. `ksx setup` is for the
//! panels that are not standard.
//!
//! Exit codes: 0 = listed / written / dry run, 1 = error, [`EXIT_REFUSED`]
//! (2) = refused (unknown template, no such player block, a preset of that
//! name already exists without `--force`); nothing was written.

use ksx_config::{ConfigRoot, Store};
use ksx_core::templates;

use crate::preset_edit;

/// Refused — nothing was written.
pub const EXIT_REFUSED: i32 = 2;

pub enum Action {
    /// What is on disk — or, with `templates`, what ships in the binary.
    List { templates: bool },
    /// Instantiate a template into a new preset file.
    New {
        name: String,
        from_template: String,
        player: u8,
        force: bool,
        dry_run: bool,
    },
    /// Give a preset a different name, carrying every reference with it.
    Rename {
        from: String,
        to: String,
        dry_run: bool,
    },
    /// Remove a preset file. Refused while slots still name it.
    Delete {
        name: String,
        force: bool,
        dry_run: bool,
    },
}

pub struct Options {
    pub action: Action,
    pub json: bool,
}

pub fn run(options: Options) -> anyhow::Result<()> {
    let store = Store::new(ConfigRoot::discover()?);
    match options.action {
        Action::List { templates: true } => {
            list_templates(options.json);
            Ok(())
        }
        Action::List { templates: false } => list_presets(&store, options.json),
        Action::New {
            name,
            from_template,
            player,
            force,
            dry_run,
        } => new(
            &store,
            &name,
            &from_template,
            player,
            force,
            dry_run,
            options.json,
        ),
        Action::Rename { from, to, dry_run } => rename(&store, &from, &to, dry_run, options.json),
        Action::Delete {
            name,
            force,
            dry_run,
        } => delete(&store, &name, force, dry_run, options.json),
    }
}

fn list_templates(json: bool) {
    if json {
        let rows: Vec<serde_json::Value> = templates::TEMPLATES
            .iter()
            .map(|t| {
                serde_json::json!({
                    "id": t.id,
                    "summary": t.summary,
                    "panel": t.panel,
                    "players": t.players,
                    "keys": (1..=t.players)
                        .map(|p| t.keys_for(p).iter().map(|k| k.name()).collect::<Vec<_>>())
                        .collect::<Vec<_>>(),
                })
            })
            .collect();
        println!("{}", serde_json::json!({"ok": true, "templates": rows}));
        return;
    }

    println!("In-box templates (ksx preset new <NAME> --from-template <ID>):");
    println!();
    for template in templates::TEMPLATES {
        let players = match template.players {
            1 => "1 player".to_owned(),
            n => format!("{n} players (--player 1..{n})"),
        };
        println!("  {:<16} {}", template.id, template.summary);
        println!("  {:<16} {players}", "");
        println!();
    }
    println!("`--json` prints each template's panel notes and the exact keys it expects.");
}

fn list_presets(store: &Store, json: bool) -> anyhow::Result<()> {
    let loaded = store.load_presets()?;
    let rows: Vec<serde_json::Value> = loaded
        .value
        .iter()
        .map(|preset| {
            serde_json::json!({
                "name": preset.name,
                "bindings": preset.bindings.len(),
                "macros": preset.macros.len(),
                "path": store
                    .preset_path(&preset.name)
                    .map(|p| p.display().to_string())
                    .unwrap_or_default(),
            })
        })
        .collect();

    if json {
        println!(
            "{}",
            serde_json::json!({
                "ok": true,
                "presets": rows,
                "warnings": loaded.warnings.iter().map(ToString::to_string).collect::<Vec<_>>(),
            })
        );
        return Ok(());
    }

    if loaded.value.is_empty() {
        println!("No presets yet.");
        println!();
        println!("  ksx preset list --templates       what ships in the box");
        println!("  ksx preset new \"P1\" --from-template arcade-6button");
        println!("  ksx setup                         map a panel by pressing it");
        return Ok(());
    }
    println!("{:<28} {:>8}  FILE", "PRESET", "CONTROLS");
    for preset in &loaded.value {
        let path = store
            .preset_path(&preset.name)
            .map(|p| p.display().to_string())
            .unwrap_or_default();
        println!("{:<28} {:>8}  {path}", preset.name, preset.bindings.len());
    }
    for warning in &loaded.warnings {
        eprintln!("warning: {warning}");
    }
    Ok(())
}

/// The console driver. Every DECISION below — instantiate, refuse to clobber,
/// back up, save — belongs to [`crate::preset_edit`]; this function is the
/// flags, the printing and the exit code, and nothing else. Studio's Profiles
/// page performs the same verb through the same two calls, which is the only
/// way "the backup was taken" can be true of both.
#[allow(clippy::too_many_arguments)]
fn new(
    store: &Store,
    name: &str,
    from_template: &str,
    player: u8,
    force: bool,
    dry_run: bool,
    json: bool,
) -> anyhow::Result<()> {
    let spec = preset_edit::NewPresetSpec {
        name: name.to_owned(),
        template: from_template.to_owned(),
        player,
        force,
    };
    let path = store.canonical_preset_path(name)?;
    let existing = store.load_preset(name)?.is_some();
    let plan = match preset_edit::plan_new(existing.then(|| path.clone()).as_deref(), &spec) {
        Ok(plan) => plan,
        Err(error) => refuse(
            json,
            error.code(),
            &error.to_string(),
            error.advice().as_deref(),
        ),
    };
    let file = &plan.file;

    if dry_run {
        let text = toml::to_string(file)?;
        if json {
            println!(
                "{}",
                serde_json::json!({
                    "ok": true,
                    "dry_run": true,
                    "preset": name,
                    "template": from_template,
                    "player": player,
                    "path": path.display().to_string(),
                    "overwrites": existing,
                    "toml": text,
                })
            );
        } else {
            eprintln!(
                "--dry-run: would write {} ({}{})",
                path.display(),
                if existing { "OVERWRITING, " } else { "" },
                format_args!("{} controls", file.bindings.len())
            );
            print!("{text}");
        }
        return Ok(());
    }

    let outcome = preset_edit::apply_new(store, &plan)?;
    let (written, backup) = (outcome.path.clone(), outcome.backup.clone());

    if json {
        println!(
            "{}",
            serde_json::json!({
                "ok": true,
                "preset": name,
                "template": from_template,
                "player": player,
                "path": written.display().to_string(),
                "controls": file.bindings.len(),
                "backup": backup.as_ref().map(|p| p.display().to_string()),
            })
        );
    } else {
        if let Some(backup) = &backup {
            println!("backed up the old one to {}", backup.display());
        }
        // The outcome's own sentence, not a second copy of it. It also says
        // "replaced" where this used to say "wrote" for both cases — the one
        // word that distinguishes a new file from a clobbered one.
        println!("{}", outcome.message());
        println!("  {}", written.display());
        println!();
        println!("Point a slot at it in config.toml:");
        println!("  [[slot]]");
        println!("  number = 1");
        println!("  keyboard = \"<your panel>\"    # `ksx devices` lists them");
        println!("  preset = \"{name}\"");
        println!();
        println!("...or let the wizard do it: `ksx setup`.");
    }
    Ok(())
}

/// Where a reference lives, in the words the file uses.
fn where_ref(reference: &preset_edit::PresetRef) -> String {
    match &reference.profile {
        None => format!("config.toml slot {}", reference.slot),
        Some(title) => format!("profile \"{}\" slot {}", title, reference.slot),
    }
}

/// `ksx preset rename <FROM> <TO>` — the file AND every slot that names it.
///
/// The reason this is not `mv`: a preset is named by `config.toml`'s slots and
/// by every games.toml profile. Moving the file alone leaves a config that
/// still parses and then refuses to start, at the next boot, in front of
/// whoever is standing at the cabinet.
fn rename(store: &Store, from: &str, to: &str, dry_run: bool, json: bool) -> anyhow::Result<()> {
    let presets = store.load_presets()?.value;
    let config = store.load_config()?.value;
    let games = store.load_games()?.value;
    let spec = preset_edit::RenameSpec {
        from: from.to_owned(),
        to: to.to_owned(),
    };
    let plan = match preset_edit::plan_rename(&presets, &config, &games, &spec) {
        Ok(plan) => plan,
        Err(error) => refuse(
            json,
            error.code(),
            &error.to_string(),
            error.advice().as_deref(),
        ),
    };

    if dry_run {
        let places: Vec<String> = plan.references.iter().map(where_ref).collect();
        if json {
            println!(
                "{}",
                serde_json::json!({
                    "ok": true,
                    "dry_run": true,
                    "from": plan.from,
                    "to": plan.to,
                    "references": places,
                })
            );
        } else {
            eprintln!(
                "--dry-run: would rename \"{}\" to \"{}\"",
                plan.from, plan.to
            );
            if places.is_empty() {
                eprintln!("           nothing points at it yet");
            } else {
                eprintln!(
                    "           and repoint {} place{}:",
                    places.len(),
                    if places.len() == 1 { "" } else { "s" }
                );
                for place in &places {
                    eprintln!("             {place}");
                }
            }
        }
        return Ok(());
    }

    let outcome = preset_edit::apply_rename(store, &plan)?;
    if json {
        println!(
            "{}",
            serde_json::json!({
                "ok": true,
                "from": plan.from,
                "to": plan.to,
                "path": outcome.written.display().to_string(),
                "removed": outcome.removed.display().to_string(),
                "references": plan.references.iter().map(where_ref).collect::<Vec<_>>(),
                "backups": outcome.backups.iter().map(|p| p.display().to_string()).collect::<Vec<_>>(),
            })
        );
    } else {
        for backup in &outcome.backups {
            println!("backed up {}", backup.display());
        }
        println!("renamed \"{}\" to \"{}\"", plan.from, plan.to);
        println!("  {}", outcome.written.display());
        for reference in &plan.references {
            println!("  repointed {}", where_ref(reference));
        }
    }
    Ok(())
}

/// `ksx preset delete <NAME>` — refused while anything still names it.
///
/// `--force` goes through and leaves those slots pointing at a preset that is
/// not there, which `ksx run` refuses in words. That is deliberate: a break
/// you can see beats a silent repair, because nothing here can know which
/// preset the person meant instead.
fn delete(store: &Store, name: &str, force: bool, dry_run: bool, json: bool) -> anyhow::Result<()> {
    let presets = store.load_presets()?.value;
    let config = store.load_config()?.value;
    let games = store.load_games()?.value;
    let spec = preset_edit::DeleteSpec {
        name: name.to_owned(),
        // A dry run writes nothing, so the in-use guard has nothing to
        // protect -- and being stopped by it is exactly backwards: the list of
        // slots it would break is the thing the person ran --dry-run to read.
        // The refusal is still reported below, with the list attached.
        force: force || dry_run,
    };
    let plan = match preset_edit::plan_delete(&presets, &config, &games, store, &spec) {
        Ok(plan) => plan,
        Err(error) => refuse(
            json,
            error.code(),
            &error.to_string(),
            error.advice().as_deref(),
        ),
    };
    let breaks: Vec<String> = plan.breaks.iter().map(where_ref).collect();

    if dry_run {
        if json {
            println!(
                "{}",
                serde_json::json!({
                    "ok": true,
                    "dry_run": true,
                    "preset": plan.name,
                    "path": plan.path.display().to_string(),
                    "breaks": breaks,
                    "would_refuse": !breaks.is_empty() && !force,
                })
            );
        } else {
            eprintln!("--dry-run: would delete {}", plan.path.display());
            for place in &breaks {
                eprintln!("           LEAVING {place} pointing at nothing");
            }
            if !breaks.is_empty() && !force {
                eprintln!("           ...so it would be REFUSED. Repoint those first, or --force.");
            }
        }
        return Ok(());
    }

    let outcome = preset_edit::apply_delete(store, &plan)?;
    if json {
        println!(
            "{}",
            serde_json::json!({
                "ok": true,
                "preset": plan.name,
                "path": plan.path.display().to_string(),
                "breaks": breaks,
                "backup": outcome.backup.as_ref().map(|p| p.display().to_string()),
            })
        );
    } else {
        if let Some(backup) = &outcome.backup {
            println!("copied it to {} first", backup.display());
        }
        println!("deleted \"{}\"", plan.name);
        for place in &breaks {
            println!("  {place} now points at nothing — repoint it before the next start");
        }
    }
    Ok(())
}

/// Refuse in the house style: a stable code for `--json`, a sentence and a
/// next step for a human, and exit 2 with nothing written.
fn refuse(json: bool, code: &str, error: &str, hint: Option<&str>) -> ! {
    if json {
        println!(
            "{}",
            serde_json::json!({"ok": false, "code": code, "error": error})
        );
    } else {
        eprintln!("refused: {error}");
        if let Some(hint) = hint {
            eprintln!("         {hint}");
        }
    }
    std::process::exit(EXIT_REFUSED);
}

#[cfg(test)]
mod tests {
    use ksx_config::PresetFile;
    use ksx_core::templates;

    /// Every shipped template must survive the file schema: instantiate,
    /// serialize, parse back, and land on the same bindings. A template that
    /// cannot round-trip is a template `ksx preset new` would write and
    /// `ksx run` would refuse.
    #[test]
    fn every_template_round_trips_through_the_preset_file() {
        for template in templates::TEMPLATES {
            for player in 1..=template.players {
                let preset = template.instantiate("Round trip", player).unwrap();
                let file = PresetFile::from_core(&preset);
                let text = toml::to_string(&file).expect("serialize");
                let parsed: PresetFile = toml::from_str(&text).expect("parse");
                let back = parsed.to_core().expect("to core");

                let mut a = preset.entries.clone();
                let mut b = back.entries.clone();
                a.sort();
                b.sort();
                assert_eq!(a, b, "{} p{player}", template.id);
                assert_eq!(back.name, "Round trip");
            }
        }
    }

    /// The names templates emit must be the vocabulary the validator accepts —
    /// that is the contract between `ksx-core` data and `ksx-config` naming.
    #[test]
    fn template_function_names_are_the_documented_vocabulary() {
        let preset = templates::instantiate("arcade-6button", "P1", 1).unwrap();
        let file = PresetFile::from_core(&preset);
        for function in file.bindings.keys() {
            ksx_config::parse_function(function).unwrap_or_else(|e| panic!("{function}: {e}"));
        }
        // Spot-check the shape a person would read in the file.
        assert!(file.bindings.contains_key("dpad.up"));
        assert!(file.bindings.contains_key("lx.min"));
        assert!(file.bindings.contains_key("start"));
    }
}
