//! `ksx input-test` — the daemon-owned simultaneous-input diagnostic as a
//! shell surface.
//!
//! Thin by contract (`docs/CONTROL-SURFACE.md`): start, poll and cancel each
//! send exactly one typed [`ksx_api::Request`] over the daemon control pipe.
//! This module does not resolve a selector, observe a keyboard, reduce events
//! or decide whether Play/Learn may run; the daemon owns all of those rules.
//!
//! Exit codes mirror `ksx session`: 0 = the daemon answered successfully,
//! 1 = refusal / observer failure / protocol / pipe error, 2 = no daemon
//! control channel.

use crate::daemon::pipe::{client, PIPE_NAME};
use crate::session::{EXIT_DAEMON_NOT_RUNNING, EXIT_ERROR};
use ksx_api::{InputTestResponse, InputTestSpec, Refusal, Request, Response};

/// Clap reads these through the backend instead of retyping the daemon's
/// accepted range or taking a direct dependency on `ksx-api`.
pub const MIN_DURATION_MS: u64 = crate::daemon::input_test::MIN_DURATION_MS;
pub const MAX_DURATION_MS: u64 = crate::daemon::input_test::MAX_DURATION_MS;
pub const DEFAULT_DURATION_MS: u64 = ksx_api::control::default_input_test_duration_ms();

pub enum Verb {
    Start { selector: String, duration_ms: u64 },
    Poll,
    Cancel { generation: u64 },
}

impl Verb {
    fn typed(&self) -> Request {
        match self {
            Self::Start {
                selector,
                duration_ms,
            } => Request::InputTestStart(InputTestSpec {
                selector: selector.clone(),
                duration_ms: *duration_ms,
            }),
            Self::Poll => Request::InputTestPoll,
            Self::Cancel { generation } => Request::InputTestCancel {
                generation: Some(*generation),
            },
        }
    }

    /// The request exactly as it goes on the pipe. Kept as a value rather than
    /// a hand-written JSON object so CLI, Studio and daemon cannot disagree on
    /// the spelling or optional-generation semantics.
    fn request(&self) -> serde_json::Value {
        serde_json::to_value(self.typed()).unwrap_or_else(|err| {
            unreachable!("an input-test request is always serializable: {err}")
        })
    }

    #[cfg(test)]
    fn request_line(&self) -> String {
        self.typed().to_line()
    }
}

pub fn run(verb: Verb, json: bool) -> anyhow::Result<()> {
    let (answer, wire) = match call(&verb) {
        Ok(answer) => answer,
        Err(refusal) => {
            let exit_code = if refusal.is_no_channel() {
                EXIT_DAEMON_NOT_RUNNING
            } else {
                EXIT_ERROR
            };
            if json {
                println!(
                    "{}",
                    serde_json::json!({
                        "ok": false,
                        "code": refusal.code,
                        "error": refusal.message,
                    })
                );
            } else {
                eprintln!("{}", refusal.message);
                if let Some(remedy) = refusal.remedy {
                    eprintln!("{remedy}");
                }
            }
            std::process::exit(exit_code);
        }
    };

    if json {
        // Preserve the daemon's exact JSON shape. The typed parse above proves
        // the response belongs to this verb without creating a second machine
        // contract by re-serializing it.
        println!("{wire}");
    } else if answer.ok {
        print_snapshot(&answer);
    }
    if !json {
        if let Some(error) = answer_error(&answer) {
            eprintln!("{error}");
        }
    }
    if answer_exit_code(&answer) != 0 {
        std::process::exit(EXIT_ERROR);
    }
    Ok(())
}

fn answer_exit_code(answer: &InputTestResponse) -> i32 {
    if answer_error(answer).is_none() {
        0
    } else {
        EXIT_ERROR
    }
}

fn answer_error(answer: &InputTestResponse) -> Option<&str> {
    if answer.ok && answer.state != "failed" {
        return None;
    }
    Some(answer.error.as_deref().unwrap_or(if answer.ok {
        "the simultaneous-input observer failed"
    } else {
        "the daemon refused"
    }))
}

/// One typed request and one typed answer, while retaining the original JSON
/// for `--json`. A mismatched or incomplete response is a protocol refusal,
/// never a plausible-looking empty diagnostic.
fn call(verb: &Verb) -> Result<(InputTestResponse, serde_json::Value), Refusal> {
    call_with(verb, |request| client::request(PIPE_NAME, request))
}

fn call_with(
    verb: &Verb,
    request: impl FnOnce(&serde_json::Value) -> Result<serde_json::Value, client::ClientError>,
) -> Result<(InputTestResponse, serde_json::Value), Refusal> {
    let typed_request = verb.typed();
    let wire = request(&verb.request()).map_err(Refusal::from)?;
    match Response::parse(&typed_request, wire.clone())? {
        Response::InputTest(answer) => Ok((answer, wire)),
        _ => unreachable!("Response::parse follows the input-test request variant"),
    }
}

/// Human output is a direct rendering of daemon-owned facts. In particular it
/// prints `detail` and `rollover_visibility` instead of inferring a keyboard's
/// physical rollover from the number of decoded Windows signals.
fn print_snapshot(answer: &InputTestResponse) {
    println!("state: {}", word(&answer.state, "unknown"));
    if let Some(selector) = answer.selector.as_deref() {
        println!("source: {selector}");
    }
    if let Some(generation) = answer.generation {
        println!("generation: {generation}");
    }
    if let Some(remaining_ms) = answer.remaining_ms {
        println!("remaining: {remaining_ms} ms");
    }
    println!("held ({}): {}", answer.held.len(), names(&answer.held));
    println!("seen ({}): {}", answer.seen.len(), names(&answer.seen));
    println!("peak: {}", answer.peak);
    println!("events: {}", answer.events);
    println!("dropped: {}", answer.dropped);
    println!(
        "rollover visibility: {}",
        word(&answer.rollover_visibility, "unavailable")
    );
    if !answer.detail.trim().is_empty() {
        println!("{}", answer.detail.trim_end());
    }
}

fn word<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    if value.trim().is_empty() {
        fallback
    } else {
        value
    }
}

fn names(values: &[String]) -> String {
    if values.is_empty() {
        "none".to_owned()
    } else {
        values.join(", ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_cli_action_sends_the_existing_typed_wire_verb() {
        let start = Verb::Start {
            selector: "usb:d209:0430:00".to_owned(),
            duration_ms: 30_000,
        };
        assert_eq!(
            start.request_line(),
            r#"{"verb":"input-test-start","selector":"usb:d209:0430:00","duration_ms":30000}"#
        );
        assert_eq!(Verb::Poll.request_line(), r#"{"verb":"input-test-poll"}"#);
        assert_eq!(
            Verb::Cancel { generation: 42 }.request_line(),
            r#"{"verb":"input-test-cancel","generation":42}"#
        );
    }

    #[test]
    fn typed_response_validation_rejects_a_malformed_answer() {
        let wrong = call_with(&Verb::Poll, |_| {
            Ok(serde_json::json!({
                "ok": true,
                "state": "listening",
                "held": "J",
            }))
        });
        assert!(
            wrong.is_err(),
            "a malformed input-test response must not render as an empty result"
        );
    }

    #[test]
    fn the_machine_json_is_retained_byte_for_field_while_the_answer_is_typed() {
        let raw = serde_json::json!({
            "ok": true,
            "state": "listening",
            "generation": 7,
            "selector": "usb:d209:0430:00",
            "remaining_ms": 12_345,
            "held": ["J", "K"],
            "seen": ["J", "K", "L"],
            "peak": 2,
            "events": 5,
            "dropped": 0,
            "rollover_visibility": "unavailable",
            "detail": "served by the daemon"
        });
        let (answer, retained) = call_with(&Verb::Poll, |_| Ok(raw.clone())).unwrap();
        assert_eq!(retained, raw);
        assert_eq!(answer.generation, Some(7));
        assert_eq!(answer.held, ["J", "K"]);
    }

    #[test]
    fn transport_absence_stays_the_distinct_exit_two_condition() {
        let refusal = call_with(&Verb::Poll, |_| Err(client::ClientError::NotRunning))
            .expect_err("an absent daemon cannot answer a poll");
        assert!(refusal.is_no_channel());
    }

    #[test]
    fn observer_failure_is_nonzero_even_though_the_snapshot_is_readable() {
        let failed = InputTestResponse {
            ok: true,
            state: "failed".to_owned(),
            error: Some("observer lost the selected device".to_owned()),
            ..InputTestResponse::default()
        };
        assert_eq!(answer_exit_code(&failed), EXIT_ERROR);
        assert_eq!(
            answer_error(&failed),
            Some("observer lost the selected device"),
            "the nonzero outcome must also expose the daemon's failure sentence"
        );
        for state in ["timeout", "cancelled"] {
            assert_eq!(
                answer_exit_code(&InputTestResponse {
                    ok: true,
                    state: state.to_owned(),
                    ..InputTestResponse::default()
                }),
                0,
                "{state} is a successful terminal snapshot"
            );
        }
    }
}
