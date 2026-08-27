//! `ksx slot` — which preset a slot uses, listed and assigned.
//!
//! The CLI face of [`crate::slots`]. Two verbs:
//!
//! - `ksx slot list [--profile TITLE]` — read-only, daemon-free.
//! - `ksx slot assign --slot N --preset NAME [--profile TITLE] [--reload]` —
//!   one field of one entry, with a timestamped backup taken first.
//!
//! `--reload` goes through the **daemon's control pipe**, not through a second
//! path into a live session: this process writes the file, then asks the
//! running daemon to re-read it, exactly as `ksx session reload` does. A
//! cabinet with no daemon running needs no reload at all — the next start
//! reads the file — and the verb says so rather than pretending it did
//! something.
//!
//! Exit codes: 0 = listed / assigned, 1 = error (or the daemon refused the
//! reload — the FILE was still written, and the message says so), 2 = refused
//! (unknown preset, unknown profile, bad slot number); nothing was written.

use ksx_config::{ConfigRoot, Store};

use crate::slots::{self, SlotSpec};

/// Refused — nothing was written.
pub const EXIT_REFUSED: i32 = 2;

pub enum Action {
    List {
        profile: Option<String>,
    },
    Assign {
        slot: u8,
        /// `None` = keep the preset the slot already uses.
        preset: Option<String>,
        /// `None` = leave the slot's persona exactly as it is. Never
        /// `Persona::default()`: see [`crate::slots::SlotSpec::persona`].
        persona: Option<ksx_core::Persona>,
        /// `None` = leave the slot's SOCD exactly as it is. Never
        /// `Socd::default()`, which is `off`: see [`crate::slots::SlotSpec::socd`].
        socd: Option<ksx_core::Socd>,
        profile: Option<String>,
        /// Ask a RUNNING daemon to take the new wiring now. A bounce: the pads
        /// replug. With nothing running there is nothing to do.
        reload: bool,
    },
}

pub struct Options {
    pub action: Action,
    pub json: bool,
}

pub fn run(options: Options) -> anyhow::Result<()> {
    let store = Store::new(ConfigRoot::discover()?);
    match options.action {
        Action::List { profile } => list(&store, profile.as_deref(), options.json),
        Action::Assign {
            slot,
            preset,
            persona,
            socd,
            profile,
            reload,
        } => assign(
            &store,
            &SlotSpec {
                slot,
                preset,
                persona,
                socd,
                profile,
            },
            reload,
            options.json,
        ),
    }
}

fn list(store: &Store, profile: Option<&str>, json: bool) -> anyhow::Result<()> {
    let rows = match slots::list(store, profile) {
        Ok(rows) => rows,
        Err(err) => refuse(&err, json),
    };
    let where_ = profile.map_or_else(
        || "config.toml".to_owned(),
        |title| format!("profile \"{title}\" (games.toml)"),
    );
    if json {
        println!(
            "{}",
            serde_json::json!({
                "ok": true,
                "source": where_,
                "slots": rows.iter().map(|row| serde_json::json!({
                    "slot": row.slot,
                    "preset": row.preset,
                    // Canonical spelling, from ksx-core. A file that says
                    // `persona = "ds4"` reports `playstation` here, so a
                    // script never has to hold the alias table either.
                    "persona": row.persona.as_str(),
                    "persona_label": row.persona.label(),
                    "keyboard": row.keyboard,
                    "profile": row.profile,
                })).collect::<Vec<_>>(),
            })
        );
        return Ok(());
    }
    if rows.is_empty() {
        println!("No slots in {where_}.");
        println!("Add one:  ksx slot assign --slot 1 --preset \"<preset>\"");
        println!("...or run `ksx setup`, which identifies the panel by press first.");
        return Ok(());
    }
    println!("Slots in {where_}:");
    println!();
    for row in &rows {
        println!(
            "  slot {}  {:<24} {:<12} keyboard: {}",
            row.slot,
            row.preset,
            row.persona.as_str(),
            row.keyboard
        );
    }
    println!();
    println!("Repoint one:  ksx slot assign --slot N --preset \"<preset>\"");
    println!("Re-persona one:  ksx slot assign --slot N --persona playstation");
    Ok(())
}

fn assign(store: &Store, spec: &SlotSpec, reload: bool, json: bool) -> anyhow::Result<()> {
    let applied = match slots::assign(store, spec) {
        Ok(applied) => applied,
        Err(err) => refuse(&err, json),
    };

    // The file is written. Whatever the daemon says next, THAT is already
    // true — so the reload's outcome is reported beside it, never instead of
    // it.
    let reloaded = if reload && !applied.unchanged {
        Some(ask_daemon_to_reload())
    } else {
        None
    };

    if json {
        println!(
            "{}",
            serde_json::json!({
                "ok": true,
                "message": message(&applied, reloaded.as_ref()),
                "path": applied.path.display().to_string(),
                "slot": applied.slot,
                "preset": applied.preset,
                "previous_preset": applied.previous,
                "persona": applied.persona.as_str(),
                "previous_persona": applied.previous_persona.map(|p| p.as_str()),
                "profile": applied.profile,
                "created": applied.created,
                "unchanged": applied.unchanged,
                "backup": applied.backup.as_ref().map(|b| b.display().to_string()),
                // Never "hot_swap": this verb has no hot path to claim.
                "restarted": reloaded.as_ref().is_some_and(|r| r.restarted),
                "reloaded": reloaded.is_some(),
            })
        );
        return Ok(());
    }

    println!("{}", message(&applied, reloaded.as_ref()));
    if let Some(backup) = &applied.backup {
        println!("  backup: {}", backup.display());
    }
    if !reload && !applied.unchanged {
        println!("  the next session start reads it (add --reload to bounce a running one)");
    }
    Ok(())
}

/// What actually happened, in one sentence: the write, and then the pads.
fn message(applied: &slots::AppliedSlot, reloaded: Option<&Reloaded>) -> String {
    let mut text = applied.message();
    if let Some(reloaded) = reloaded {
        text.push_str(" — ");
        text.push_str(&reloaded.message);
    }
    text
}

/// The daemon's answer to the bounce.
struct Reloaded {
    restarted: bool,
    message: String,
}

/// Ask the RUNNING daemon to re-read the config: one `reload` on the control
/// pipe, which is the same `DaemonCommand::Reload` a tray click enqueues.
///
/// Not `ApplyBindings`. That verb picks the cheapest correct answer and would
/// hot-swap a preset re-point with the pads left plugged — see
/// [`ksx_api::SlotOutcome::restarted`] for why this verb does not take that
/// road.
fn ask_daemon_to_reload() -> Reloaded {
    use ksx_api::ControlSource as _;
    let client = ksx_api::Client::new(ksx_api::PipeTransport::new());
    match client.reload() {
        Ok(message) => Reloaded {
            restarted: true,
            message: format!("the session restarted: {message} (the pads replugged)"),
        },
        Err(refusal) if refusal.is_no_channel() => Reloaded {
            restarted: false,
            message: "no daemon is running, so nothing had to restart".to_owned(),
        },
        Err(refusal) => Reloaded {
            restarted: false,
            message: format!(
                "the file was written, but the daemon would not reload: {}",
                refusal.message
            ),
        },
    }
}

/// One refusal, in both spellings, then exit 2 with nothing written.
fn refuse(err: &slots::SlotError, json: bool) -> ! {
    if json {
        println!(
            "{}",
            serde_json::json!({ "ok": false, "code": err.code(), "error": err.to_string() })
        );
    } else {
        eprintln!("refusing: {err}");
    }
    std::process::exit(EXIT_REFUSED)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn applied() -> slots::AppliedSlot {
        slots::AppliedSlot {
            path: std::path::PathBuf::from(r"C:\cfg\ksx\config.toml"),
            slot: 3,
            preset: "IPAC P3".to_owned(),
            previous: Some("Panel P1".to_owned()),
            persona: ksx_core::Persona::Xbox360,
            previous_persona: None,
            profile: None,
            created: false,
            unchanged: false,
            backup: None,
        }
    }

    /// **The pad bounce is the half a user must not have to infer.**
    ///
    /// `ksx slot assign` prints exactly one sentence, and this function is the
    /// only place the two things that happened — the FILE was written, and then
    /// the PADS did something — are joined into it. Dropping the second half is
    /// silent: the write still succeeded, the exit code is still 0, and the
    /// player is left holding a controller that stopped working with no line on
    /// screen about it.
    ///
    /// The writer's own sentence is `slots::AppliedSlot::message`, pinned in
    /// `slots.rs`; what is asserted here is that the CLI carries it through
    /// unedited and appends rather than replaces.
    #[test]
    fn the_sentence_names_the_write_and_then_what_happened_to_the_pads() {
        let applied = applied();

        // No reload asked for: the writer's sentence, which already names what
        // the change NEEDS ("the pads replugged"), and no claim about what any
        // daemon DID.
        let alone = message(&applied, None);
        assert!(alone.contains("slot 3"), "{alone}");
        assert!(alone.contains("IPAC P3"), "{alone}");
        assert!(
            !alone.contains("the session restarted") && !alone.contains("no daemon is running"),
            "with no reload asked for, nothing may be claimed about a daemon: {alone}"
        );

        // A daemon that took it: both halves, the write first.
        let restarted = message(
            &applied,
            Some(&Reloaded {
                restarted: true,
                message: "the session restarted: 4 pad(s) (the pads replugged)".to_owned(),
            }),
        );
        assert!(
            restarted.starts_with(&alone),
            "the write's own sentence must survive the join: {restarted}"
        );
        assert!(
            restarted.contains("the session restarted:"),
            "the daemon's answer must reach the user, not just the exit code: {restarted}"
        );

        // A daemon that was not there: still both halves, and the second one
        // says why there was nothing to do.
        let idle = message(
            &applied,
            Some(&Reloaded {
                restarted: false,
                message: "no daemon is running, so nothing had to restart".to_owned(),
            }),
        );
        assert!(idle.starts_with(&alone), "{idle}");
        assert!(idle.contains("nothing had to restart"), "{idle}");
    }

    /// 2 means the same thing in every ksx command: refused, nothing written.
    /// `refuse()` exits with this and cannot be called from a test (it ends the
    /// process), so the constant it uses is pinned instead.
    #[test]
    fn refusing_exits_the_way_every_other_refusal_does() {
        assert_eq!(EXIT_REFUSED, crate::run::EXIT_CANNOT_START);
    }
}
