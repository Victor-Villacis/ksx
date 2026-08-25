//! Daemon-owned simultaneous keyboard-signal diagnostic.
//!
//! This is intentionally separate from the running session's live feed: a
//! new encoder with no bindings has no captureable keys yet, and an ordinary
//! keyboard must be testable while emulation is stopped. The pipe starts one
//! bounded observation and polls snapshots; it never parks on a human-held
//! chord.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ksx_api::InputTestSpec;

pub const MIN_DURATION_MS: u64 = 1_000;
pub const MAX_DURATION_MS: u64 = 60_000;
pub const MAX_SELECTOR_BYTES: usize = 1_024;

/// One decoded transition from the exact source selected for the test.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InputTransition {
    pub key: String,
    pub down: bool,
}

/// Production fans Raw Input and claimed-panel transitions into this callback.
/// The returned count is how many transitions the bounded fan-in had to drop.
pub type ObserveEventsFn = Arc<
    dyn Fn(
            String,
            Instant,
            Arc<AtomicBool>,
            Arc<dyn Fn(InputTransition) + Send + Sync>,
        ) -> Result<u64, String>
        + Send
        + Sync,
>;

#[derive(Clone, Debug, PartialEq, Eq)]
enum Phase {
    Idle,
    Listening,
    TimedOut,
    Cancelled,
    Failed(String),
}

impl Phase {
    fn word(&self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Listening => "listening",
            Self::TimedOut => "timeout",
            Self::Cancelled => "cancelled",
            Self::Failed(_) => "failed",
        }
    }
}

struct InputTest {
    generation: u64,
    phase: Phase,
    selector: Option<String>,
    deadline: Option<Instant>,
    cancel: Arc<AtomicBool>,
    held: BTreeSet<String>,
    seen: BTreeSet<String>,
    peak: u32,
    events: u64,
    dropped: u64,
}

/// One per daemon. State is bounded by KSX's finite key vocabulary; no event
/// history is retained.
#[derive(Clone)]
pub struct InputTestService {
    state: Arc<Mutex<InputTest>>,
    observe: ObserveEventsFn,
    /// Zero when the worker has exited; otherwise the exact live generation.
    /// A cancel is terminal to the caller immediately but keeps this nonzero
    /// until the Raw Input window/claim has actually been released, preventing
    /// Learn from opening a competing observer in that gap.
    active_generation: Arc<AtomicU64>,
    refusal: Option<&'static str>,
}

impl InputTestService {
    pub fn new(observe: ObserveEventsFn) -> Self {
        Self {
            state: Arc::new(Mutex::new(InputTest {
                generation: 0,
                phase: Phase::Idle,
                selector: None,
                deadline: None,
                cancel: Arc::new(AtomicBool::new(false)),
                held: BTreeSet::new(),
                seen: BTreeSet::new(),
                peak: 0,
                events: 0,
                dropped: 0,
            })),
            observe,
            active_generation: Arc::new(AtomicU64::new(0)),
            refusal: None,
        }
    }

    #[cfg(feature = "cabinet")]
    pub fn refusing(reason: &'static str) -> Self {
        Self {
            refusal: Some(reason),
            ..Self::new(Arc::new(|_, _, _, _| Ok(0)))
        }
    }

    pub fn observer_active(&self) -> bool {
        self.active_generation.load(Ordering::SeqCst) != 0
    }

    /// Give a terminal generation a small, bounded chance to release its Raw
    /// Input window, panel tap, or temporary WinUSB claim before a new owner
    /// starts. A genuinely listening test is never waited out: it still owns
    /// the user's action and its generation must be cancelled first.
    pub fn wait_for_terminal_observer_release(&self, budget: Duration) -> bool {
        let deadline = Instant::now() + budget;
        loop {
            let terminal = self
                .state
                .lock()
                .map(|test| test.phase != Phase::Listening)
                .unwrap_or(false);
            if !terminal {
                return false;
            }
            if !self.observer_active() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn refused(&self, reason: impl Into<String>, code: &'static str) -> serde_json::Value {
        serde_json::json!({
            "ok": false,
            "state": "unavailable",
            "generation": serde_json::Value::Null,
            "selector": serde_json::Value::Null,
            "remaining_ms": serde_json::Value::Null,
            "held": [],
            "seen": [],
            "peak": 0,
            "events": 0,
            "dropped": 0,
            "rollover_visibility": "unavailable",
            "detail": "No simultaneous-input observation was made.",
            "error": reason.into(),
            "code": code,
        })
    }

    pub fn start(&self, spec: InputTestSpec) -> serde_json::Value {
        if let Some(reason) = self.refusal {
            return self.refused(reason, "not-here");
        }
        let selector = spec.selector.trim();
        if selector.is_empty() || selector.len() > MAX_SELECTOR_BYTES {
            return self.refused(
                format!(
                    "input-test-start needs a non-empty selector no longer than {MAX_SELECTOR_BYTES} bytes"
                ),
                "bad-request",
            );
        }
        if !(MIN_DURATION_MS..=MAX_DURATION_MS).contains(&spec.duration_ms) {
            return self.refused(
                format!(
                    "input-test-start duration_ms must be {MIN_DURATION_MS}..={MAX_DURATION_MS}"
                ),
                "bad-request",
            );
        }
        let duration = Duration::from_millis(spec.duration_ms);
        let deadline = Instant::now() + duration;
        let selector = selector.to_owned();
        let (generation, cancel) = {
            let Ok(mut test) = self.state.lock() else {
                return self.refused(
                    "the simultaneous-input state is unavailable",
                    "state-poisoned",
                );
            };
            let generation = test.generation.saturating_add(1).max(1);
            if self
                .active_generation
                .compare_exchange(0, generation, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
            {
                return self.refused(
                    "a simultaneous-input test is already releasing or listening; stop it and poll until its observer has closed",
                    "busy",
                );
            }
            test.generation = generation;
            test.phase = Phase::Listening;
            test.selector = Some(selector.clone());
            test.deadline = Some(deadline);
            test.cancel = Arc::new(AtomicBool::new(false));
            test.held.clear();
            test.seen.clear();
            test.peak = 0;
            test.events = 0;
            test.dropped = 0;
            (test.generation, Arc::clone(&test.cancel))
        };
        let state = Arc::clone(&self.state);
        let active = Arc::clone(&self.active_generation);
        let observe = Arc::clone(&self.observe);
        let selector_for_worker = selector;
        let spawned = std::thread::Builder::new()
            .name("ksx-input-test".into())
            .spawn(move || {
                let event_state = Arc::clone(&state);
                let on_event: Arc<dyn Fn(InputTransition) + Send + Sync> = Arc::new(move |event| {
                    let Ok(mut test) = event_state.lock() else {
                        return;
                    };
                    if test.generation != generation || test.phase != Phase::Listening {
                        return;
                    }
                    test.events = test.events.saturating_add(1);
                    if event.down {
                        test.seen.insert(event.key.clone());
                        test.held.insert(event.key);
                        test.peak = test.peak.max(test.held.len() as u32);
                    } else {
                        test.held.remove(&event.key);
                    }
                });
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    observe(selector_for_worker, deadline, Arc::clone(&cancel), on_event)
                }))
                .unwrap_or_else(|_| Err("the simultaneous-input observer panicked".to_owned()));
                if let Ok(mut test) = state.lock() {
                    if test.generation == generation {
                        match outcome {
                            Ok(dropped) => {
                                test.dropped = test.dropped.saturating_add(dropped);
                                if test.phase == Phase::Listening {
                                    test.phase = if cancel.load(Ordering::SeqCst) {
                                        Phase::Cancelled
                                    } else {
                                        Phase::TimedOut
                                    };
                                }
                            }
                            Err(error) => {
                                if test.phase == Phase::Listening {
                                    test.phase = Phase::Failed(error);
                                }
                            }
                        }
                        test.deadline = None;
                    }
                }
                let _ = active.compare_exchange(generation, 0, Ordering::SeqCst, Ordering::SeqCst);
            });
        if let Err(err) = spawned {
            let _ = self.active_generation.compare_exchange(
                generation,
                0,
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
            if let Ok(mut test) = self.state.lock() {
                if test.generation == generation {
                    test.phase = Phase::Failed(format!(
                        "could not spawn the simultaneous-input observer: {err}"
                    ));
                    test.deadline = None;
                }
            }
        }
        self.poll()
    }

    pub fn poll(&self) -> serde_json::Value {
        if let Some(reason) = self.refusal {
            return self.refused(reason, "not-here");
        }
        let Ok(test) = self.state.lock() else {
            return self.refused(
                "the simultaneous-input state is unavailable",
                "state-poisoned",
            );
        };
        let remaining_ms = match (&test.phase, test.deadline) {
            (Phase::Listening, Some(deadline)) => Some(
                deadline
                    .saturating_duration_since(Instant::now())
                    .as_millis() as u64,
            ),
            _ => None,
        };
        let error = match &test.phase {
            Phase::Failed(error) => Some(error.clone()),
            _ => None,
        };
        let detail = match test.phase {
            Phase::Idle => "Release every key, then start the test.".to_owned(),
            Phase::Listening => format!(
                "KSX currently observes {} held signal(s); peak {}. USB rollover reports are unavailable on this Windows signal path.",
                test.held.len(), test.peak
            ),
            _ => format!(
                "KSX observed a peak of {} simultaneous KSX-readable signal(s) and {} distinct signal(s). USB rollover reports were unavailable on this Windows signal path.",
                test.peak,
                test.seen.len()
            ),
        };
        // Zero is an internal never-started sentinel, not a generation a
        // client can own or cancel. Once any attempt exists its terminal
        // generation remains visible with the retained metrics.
        let generation = (test.phase != Phase::Idle).then_some(test.generation);
        serde_json::json!({
            "ok": true,
            "state": test.phase.word(),
            "generation": generation,
            "selector": test.selector,
            "remaining_ms": remaining_ms,
            "held": test.held.iter().cloned().collect::<Vec<_>>(),
            "seen": test.seen.iter().cloned().collect::<Vec<_>>(),
            "peak": test.peak,
            "events": test.events,
            "dropped": test.dropped,
            "rollover_visibility": "unavailable",
            "detail": detail,
            "error": error,
        })
    }

    pub fn cancel(&self, expected_generation: Option<u64>) -> serde_json::Value {
        if let Some(reason) = self.refusal {
            return self.refused(reason, "not-here");
        }
        let Ok(mut test) = self.state.lock() else {
            return self.refused(
                "the simultaneous-input state is unavailable",
                "state-poisoned",
            );
        };
        if expected_generation.is_some_and(|expected| expected != test.generation) {
            drop(test);
            return self.poll();
        }
        test.cancel.store(true, Ordering::SeqCst);
        if test.phase == Phase::Listening {
            test.phase = Phase::Cancelled;
            test.deadline = None;
        }
        drop(test);
        self.poll()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    type Script = Result<(Vec<InputTransition>, u64), String>;

    fn scripted() -> (InputTestService, mpsc::Sender<Script>) {
        let (tx, rx) = mpsc::channel::<Script>();
        let rx = Arc::new(Mutex::new(rx));
        let service =
            InputTestService::new(Arc::new(move |_selector, _deadline, cancel, emit| loop {
                if cancel.load(Ordering::SeqCst) {
                    return Ok(0);
                }
                match rx.lock().unwrap().recv_timeout(Duration::from_millis(2)) {
                    Ok(Ok((events, dropped))) => {
                        for event in events {
                            emit(event);
                        }
                        return Ok(dropped);
                    }
                    Ok(Err(error)) => return Err(error),
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(0),
                }
            }));
        (service, tx)
    }

    fn spec() -> InputTestSpec {
        InputTestSpec {
            selector: "usb:d209:0430:00".into(),
            duration_ms: 5_000,
        }
    }

    fn wait_terminal(service: &InputTestService) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let view = service.poll();
            if view["state"] != "listening" {
                return view;
            }
            assert!(Instant::now() < deadline, "test did not finish: {view}");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn reducer_keeps_held_seen_and_peak_without_double_counting_repeats() {
        let (service, tx) = scripted();
        service.start(spec());
        tx.send(Ok((
            vec![
                InputTransition {
                    key: "A".into(),
                    down: true,
                },
                InputTransition {
                    key: "A".into(),
                    down: true,
                },
                InputTransition {
                    key: "S".into(),
                    down: true,
                },
                InputTransition {
                    key: "A".into(),
                    down: false,
                },
            ],
            3,
        )))
        .unwrap();
        let view = wait_terminal(&service);
        assert_eq!(view["state"], "timeout");
        assert_eq!(view["held"], serde_json::json!(["S"]));
        assert_eq!(view["seen"], serde_json::json!(["A", "S"]));
        assert_eq!(view["peak"], 2);
        assert_eq!(view["events"], 4);
        assert_eq!(view["dropped"], 3);
    }

    #[test]
    fn generation_specific_cancel_cannot_stop_a_newer_attempt() {
        let (service, _tx) = scripted();
        let first = service.start(spec())["generation"].as_u64().unwrap();
        service.cancel(Some(first));
        let deadline = Instant::now() + Duration::from_secs(2);
        while service.observer_active() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        }
        let second = service.start(spec())["generation"].as_u64().unwrap();
        let stale = service.cancel(Some(first));
        assert_eq!(stale["generation"], second);
        assert_eq!(stale["state"], "listening");
        service.cancel(Some(second));
    }

    #[test]
    fn selector_and_duration_are_bounded_before_a_thread_starts() {
        let (service, _tx) = scripted();
        let blank = service.start(InputTestSpec::default());
        assert_eq!(blank["code"], "bad-request");
        assert!(!service.observer_active());
        let too_long = service.start(InputTestSpec {
            selector: "x".repeat(MAX_SELECTOR_BYTES + 1),
            duration_ms: MIN_DURATION_MS,
        });
        assert_eq!(too_long["code"], "bad-request");
        let bad_time = service.start(InputTestSpec {
            selector: "usb:1:2:0".into(),
            duration_ms: MAX_DURATION_MS + 1,
        });
        assert_eq!(bad_time["code"], "bad-request");
    }

    #[test]
    fn idle_exposes_no_cancellable_generation() {
        let (service, _tx) = scripted();
        let view = service.poll();
        assert_eq!(view["state"], "idle");
        assert_eq!(view["generation"], serde_json::Value::Null);
    }
}
