//! `ksx session` — control a RUNNING daemon over its named pipe.
//!
//! Thin by contract (docs/CONTROL-SURFACE.md): each verb is one pipe request,
//! and the pipe enqueues the same [`crate::daemon::DaemonCommand`] the tray
//! menu produces. Nothing here validates profiles, resolves plans or touches
//! drivers — the daemon does all of that on its own threads, exactly as if
//! the tray had been clicked.
//!
//! Exit codes: 0 = done, 1 = error (the daemon refused, or the pipe broke
//! mid-conversation), 2 = no daemon control channel (no daemon is running, or
//! the one that is predates `ksx session`).

use crate::daemon::pipe::{client, PIPE_NAME};
use std::time::Duration;

/// The verbs `ksx session` offers, as the ONE request type every ksx surface
/// builds (docs/M9-DECISION.md §6). This file used to spell the four request
/// bodies itself with `serde_json::json!`, which is how a CLI and a page end
/// up disagreeing about a field name that only one of them ever exercises.
use ksx_api::Request;

pub const EXIT_ERROR: i32 = 1;
pub const EXIT_DAEMON_NOT_RUNNING: i32 = 2;
const SHUTDOWN_CLOSE_BUDGET: Duration = Duration::from_secs(3);

pub enum Verb {
    Status,
    Start {
        game: Option<String>,
    },
    Stop,
    /// **Put back the session `stop` stopped.** Carries nothing: a staged
    /// session has no profile to name and the daemon is the only thing that
    /// knows which of its two starts ran (`ksx_api::SessionOrigin`).
    Resume,
    Reload,
    Quit,
}

impl Verb {
    /// The typed request this verb is.
    fn typed(&self) -> Request {
        match self {
            Self::Status => Request::Status,
            Self::Start { game } => Request::Start {
                profile: game.clone(),
            },
            Self::Stop => Request::Stop,
            Self::Resume => Request::Resume,
            Self::Reload => Request::Reload,
            Self::Quit => Request::Quit,
        }
    }

    /// The request as it goes on the wire. Serialized from [`Verb::typed`], so
    /// the line this CLI sends is the line the daemon's own reader is written
    /// against — byte for byte the one docs/CONTROL-SURFACE.md documents.
    fn request(&self) -> serde_json::Value {
        serde_json::to_value(self.typed())
            .unwrap_or_else(|err| unreachable!("a control request is always serializable: {err}"))
    }
}

pub fn run(verb: Verb, json: bool) -> anyhow::Result<()> {
    let response = match call(&verb) {
        Ok(response) => response,
        Err(error) => {
            let message = error.message();
            if json {
                println!(
                    "{}",
                    serde_json::json!({
                        "ok": false,
                        "code": error.code(),
                        "error": message,
                    })
                );
            } else {
                eprintln!("{message}");
            }
            std::process::exit(error.exit_code());
        }
    };
    report(&verb, &response, json)
}

/// The uninstall-facing half of the hidden quiesce command. It is deliberately
/// output-free: the orchestrator first verifies the installed executable and
/// removes the fixed autostart task, then calls this and decides what one line
/// to report to Inno Setup.
pub fn quit_for_uninstall() -> anyhow::Result<String> {
    let response = call(&Verb::Quit).map_err(|error| anyhow::anyhow!(error.message()))?;
    if response["ok"].as_bool() != Some(true) {
        anyhow::bail!(
            "daemon refused shutdown: {}",
            response["error"]
                .as_str()
                .unwrap_or("the daemon returned no reason")
        );
    }
    Ok(response["message"]
        .as_str()
        .unwrap_or("daemon stopped")
        .to_owned())
}

fn call(verb: &Verb) -> Result<serde_json::Value, CallError> {
    call_with(
        verb,
        |request| client::request(PIPE_NAME, request),
        || client::wait_until_closed(PIPE_NAME, SHUTDOWN_CLOSE_BUDGET),
    )
}

#[derive(Debug, PartialEq, Eq)]
enum CallError {
    NotRunning,
    Pipe(String),
    Shutdown(String),
}

impl CallError {
    fn code(&self) -> &'static str {
        match self {
            Self::NotRunning => "daemon-not-running",
            Self::Pipe(_) => "pipe-error",
            Self::Shutdown(_) => "shutdown-incomplete",
        }
    }

    fn exit_code(&self) -> i32 {
        match self {
            Self::NotRunning => EXIT_DAEMON_NOT_RUNNING,
            Self::Pipe(_) | Self::Shutdown(_) => EXIT_ERROR,
        }
    }

    fn message(&self) -> String {
        match self {
            Self::NotRunning => client::ClientError::NotRunning.to_string(),
            Self::Pipe(message) | Self::Shutdown(message) => message.clone(),
        }
    }
}

/// One CLI transaction with the transport injected for exact exit-semantics
/// tests. Quit alone treats an initially absent daemon as success; after an
/// affirmative response it cannot succeed until the pipe name is absent.
fn call_with(
    verb: &Verb,
    request: impl FnOnce(&serde_json::Value) -> Result<serde_json::Value, client::ClientError>,
    wait_closed: impl FnOnce() -> Result<(), client::ClientError>,
) -> Result<serde_json::Value, CallError> {
    let response = match request(&verb.request()) {
        Ok(response) => response,
        Err(client::ClientError::NotRunning) if matches!(verb, Verb::Quit) => {
            return Ok(serde_json::json!({
                "ok": true,
                "message": "daemon already stopped",
            }));
        }
        Err(client::ClientError::NotRunning) => return Err(CallError::NotRunning),
        Err(error) => return Err(CallError::Pipe(error.to_string())),
    };

    if matches!(verb, Verb::Quit) && response["ok"].as_bool() == Some(true) {
        wait_closed().map_err(|error| CallError::Shutdown(error.to_string()))?;
    }
    Ok(response)
}

/// Render the daemon's answer. `--json` prints the response verbatim — the
/// pipe protocol IS the stable machine interface, so re-shaping it here would
/// just create a second contract to keep.
fn report(verb: &Verb, response: &serde_json::Value, json: bool) -> anyhow::Result<()> {
    let ok = response["ok"].as_bool().unwrap_or(false);
    if json {
        println!("{response}");
    } else if ok {
        match verb {
            Verb::Status => print_status(response),
            _ => println!(
                "{}",
                response["message"].as_str().unwrap_or("done").trim_end()
            ),
        }
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

fn print_status(response: &serde_json::Value) {
    // The tooltip is the daemon's own one-line self-description (state, game,
    // worst health note) — reuse it rather than re-deriving a fourth wording.
    if let Some(tooltip) = response["tooltip"].as_str() {
        println!("{tooltip}");
    }
    match response["profiles"].as_array() {
        Some(rows) if !rows.is_empty() => {
            println!("profiles:");
            for row in rows {
                println!(
                    "  {} — {}",
                    row["title"].as_str().unwrap_or("?"),
                    row["detail"].as_str().unwrap_or("")
                );
            }
        }
        _ => println!("profiles: none in games.toml"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The lines this CLI puts on the pipe, unchanged by the move to the
    /// shared type — which is the point of pinning them here as well as in
    /// `ksx-api`: the two tests together say "the type serializes to this" and
    /// "this CLI sends that".
    #[test]
    fn each_verb_builds_the_documented_request_line() {
        assert_eq!(Verb::Status.request().to_string(), r#"{"verb":"status"}"#);
        assert_eq!(
            Verb::Start { game: None }.request().to_string(),
            r#"{"verb":"start"}"#
        );
        assert_eq!(
            Verb::Start {
                game: Some("Example Game".into())
            }
            .request(),
            serde_json::json!({ "verb": "start", "profile": "Example Game" })
        );
        assert_eq!(Verb::Stop.request().to_string(), r#"{"verb":"stop"}"#);
        // Resume takes NO argument, and that is the fix: the shipped mapper
        // resumed by sending `start` with the profile it had remembered, which
        // is `None` for a staged session and means "the config on disk".
        assert_eq!(Verb::Resume.request().to_string(), r#"{"verb":"resume"}"#);
        assert_eq!(Verb::Reload.request().to_string(), r#"{"verb":"reload"}"#);
        assert_eq!(Verb::Quit.request().to_string(), r#"{"verb":"quit"}"#);
    }

    #[test]
    fn quit_is_idempotent_when_the_daemon_is_already_absent() {
        let waited = std::cell::Cell::new(false);
        let response = call_with(
            &Verb::Quit,
            |_| Err(client::ClientError::NotRunning),
            || {
                waited.set(true);
                Ok(())
            },
        )
        .expect("absence is the requested end state");
        assert_eq!(response["ok"], true);
        assert_eq!(response["message"], "daemon already stopped");
        assert!(!waited.get(), "an absent name needs no closure wait");
    }

    #[test]
    fn every_other_verb_keeps_absent_daemon_exit_two() {
        let error = call_with(
            &Verb::Stop,
            |_| Err(client::ClientError::NotRunning),
            || Ok(()),
        )
        .unwrap_err();
        assert_eq!(error, CallError::NotRunning);
        assert_eq!(error.exit_code(), EXIT_DAEMON_NOT_RUNNING);
    }

    #[test]
    fn quit_ack_is_not_success_until_the_pipe_name_is_absent() {
        let error = call_with(
            &Verb::Quit,
            |_| Ok(serde_json::json!({"ok": true, "message": "daemon stopped"})),
            || Err(client::ClientError::ShutdownTimedOut),
        )
        .unwrap_err();
        assert!(matches!(error, CallError::Shutdown(_)));
        assert_eq!(error.exit_code(), EXIT_ERROR);

        let response = call_with(
            &Verb::Quit,
            |_| Ok(serde_json::json!({"ok": true, "message": "daemon stopped"})),
            || Ok(()),
        )
        .expect("ack plus closed pipe is success");
        assert_eq!(response["ok"], true);
    }
}
