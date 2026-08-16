//! `ksx stage` — the daemon-held staged setup (`docs/FIRST-RUN.md` §2) over
//! its named pipe, as a shell surface.
//!
//! Thin by contract (docs/CONTROL-SURFACE.md), exactly as `ksx session` is:
//! each verb is ONE pipe request built from [`ksx_api::Request`] — never a
//! hand-spelled JSON body — so the line this CLI sends is the line the
//! daemon's reader is written against and the line Studio's own control
//! source sends. Nothing here validates, resolves or writes; the daemon
//! refuses in its own words and this surface prints them.
//!
//! Exit codes mirror `ksx session`: 0 = done, 1 = the daemon refused (or the
//! pipe broke mid-conversation), 2 = no daemon control channel.

use crate::daemon::pipe::{client, PIPE_NAME};
use crate::session::{EXIT_DAEMON_NOT_RUNNING, EXIT_ERROR};
use ksx_api::Request;

pub enum Verb {
    /// Read the staged setup. The one verb here that cannot refuse for a
    /// domain reason.
    View,
    /// Adopt the saved configuration (or one games.toml profile) into an
    /// EMPTY stage. The daemon refuses over a proposal — adoption never
    /// overwrites edits.
    Adopt { game: Option<String> },
    /// Whole-order reorder: the CURRENT slot numbers in the desired new
    /// sequence, renumbered contiguously by the daemon.
    Reorder { numbers: Vec<u8> },
    /// One staged slot's simultaneous-opposite-direction policy
    /// (`off` | `neutral` | `up-priority` | `last-input` | `first-input` — `ksx_core::Socd`'s own names).
    Socd { slot: u8, socd: String },
}

impl Verb {
    fn typed(&self) -> Request {
        match self {
            Self::View => Request::Stage,
            Self::Adopt { game } => Request::StageAdopt {
                profile: game.clone(),
            },
            Self::Reorder { numbers } => {
                Request::StageEdit(Box::new(ksx_api::StageEdit::ReorderSlots {
                    numbers: numbers.clone(),
                }))
            }
            Self::Socd { slot, socd } => {
                Request::StageEdit(Box::new(ksx_api::StageEdit::SetSocd {
                    number: *slot,
                    socd: socd.clone(),
                }))
            }
        }
    }

    /// The request as it goes on the wire, serialized from [`Verb::typed`].
    fn request(&self) -> serde_json::Value {
        serde_json::to_value(self.typed())
            .unwrap_or_else(|err| unreachable!("a stage request is always serializable: {err}"))
    }
}

pub fn run(verb: Verb, json: bool) -> anyhow::Result<()> {
    let response = match client::request(PIPE_NAME, &verb.request()) {
        Ok(response) => response,
        Err(client::ClientError::NotRunning) => {
            let message = client::ClientError::NotRunning.to_string();
            if json {
                println!(
                    "{}",
                    serde_json::json!({
                        "ok": false,
                        "code": "daemon-not-running",
                        "error": message,
                    })
                );
            } else {
                eprintln!("{message}");
            }
            std::process::exit(EXIT_DAEMON_NOT_RUNNING);
        }
        Err(error) => {
            if json {
                println!(
                    "{}",
                    serde_json::json!({
                        "ok": false,
                        "code": "pipe-error",
                        "error": error.to_string(),
                    })
                );
            } else {
                eprintln!("{error}");
            }
            std::process::exit(EXIT_ERROR);
        }
    };

    let ok = response["ok"].as_bool().unwrap_or(false);
    if json {
        // The pipe protocol IS the stable machine interface (`ksx session`'s
        // report says why re-shaping it here would just be a second contract).
        println!("{response}");
    } else if ok {
        if let Some(message) = response["message"].as_str() {
            println!("{}", message.trim_end());
        }
        print_setup(&response["setup"]);
    } else {
        eprintln!(
            "{}",
            response["error"].as_str().unwrap_or("the daemon refused")
        );
    }
    if !ok {
        std::process::exit(EXIT_ERROR);
    }
    Ok(())
}

/// The staged setup, summarized for a shell. Every line prints served facts;
/// nothing is re-derived (docs/SURFACES.md §1).
fn print_setup(setup: &serde_json::Value) {
    if setup["reachable"].as_bool() != Some(true) {
        return;
    }
    if setup["empty"].as_bool() == Some(true) {
        println!("staged: nothing — a fresh visit ( `ksx stage adopt` shows the saved setup )");
        return;
    }
    match setup["device"]["label"].as_str() {
        Some(label) => println!("keyboard: {label}"),
        None => println!("keyboard: none chosen yet"),
    }
    if let Some(slots) = setup["slots"].as_array() {
        for slot in slots {
            let socd = slot["socd"].as_str().unwrap_or("off");
            let socd_note = if socd == "off" || socd.is_empty() {
                String::new()
            } else {
                format!(" · {}", slot["socd_label"].as_str().unwrap_or(socd))
            };
            println!(
                "  P{} {} — \"{}\" ({} control(s)){socd_note}",
                slot["number"],
                slot["persona_label"].as_str().unwrap_or("?"),
                slot["preset"].as_str().unwrap_or("?"),
                slot["bindings"],
            );
        }
    }
    let dirty = setup["dirty"].as_bool() == Some(true);
    let origin = setup["origin"].as_str().unwrap_or("");
    match (dirty, origin) {
        (true, _) => println!("draft: unsaved changes"),
        (false, "") => println!("draft: fresh"),
        (false, origin) => println!("draft: clean, from {origin}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The lines this CLI puts on the pipe — pinned here as well as in
    /// `ksx-api`, for the same reason `ksx session`'s test gives: the two
    /// together say "the type serializes to this" and "this CLI sends that".
    #[test]
    fn each_verb_builds_the_documented_request_line() {
        assert_eq!(Verb::View.request().to_string(), r#"{"verb":"stage"}"#);
        assert_eq!(
            Verb::Adopt { game: None }.request().to_string(),
            r#"{"verb":"stage-adopt"}"#
        );
        assert_eq!(
            Verb::Adopt {
                game: Some("Fight Night".into())
            }
            .request(),
            serde_json::json!({ "verb": "stage-adopt", "profile": "Fight Night" })
        );
        assert_eq!(
            Verb::Reorder {
                numbers: vec![3, 1, 2]
            }
            .request(),
            serde_json::json!({
                "verb": "stage-edit",
                "edit": "reorder-slots",
                "numbers": [3, 1, 2],
            })
        );
        assert_eq!(
            Verb::Socd {
                slot: 2,
                socd: "up-priority".into()
            }
            .request(),
            serde_json::json!({
                "verb": "stage-edit",
                "edit": "set-socd",
                "number": 2,
                "socd": "up-priority",
            })
        );
    }
}
