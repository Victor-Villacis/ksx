//! Fail-closed Windows transport for one HIDMaestro host conversation.
//!
//! The production constructor resolves and seals exactly the installed sibling
//! `ksx-hidmaestro-host.exe`, launches it elevated, and hands the retained
//! process object to `ksx-platform`'s elevated-only admission path. The separate
//! `hidmaestro-fake-host-tests` constructor remains available only to tests.
//!
//! The rendezvous token and protocol Hello nonce are independent CSPRNG draws.
//! The pipe listener exists before either launcher runs, and an authenticated
//! opaque pipe exists before the first Hello byte is written. Raw pipe handles,
//! peer-supplied PIDs, caller-selected executables, and arbitrary pipe names
//! never cross this module's API.

use std::collections::VecDeque;
use std::thread::JoinHandle;

use crate::host::{
    Direction, Frame, HostTransportError, MessageKind, ProtocolError, HEADER_BYTES,
    MAX_PAYLOAD_BYTES, MAX_QUEUED_FEEDBACK, PROTOCOL_MAGIC, PROTOCOL_VERSION,
};

#[cfg(windows)]
pub use windows::ProductionHostConnectError;

/// Read the one length field which must be trusted before the body is read.
///
/// The fixed-size argument makes it impossible for this helper to inspect a
/// partial header. No allocation or body read occurs until all structural
/// header checks and the 512-byte ceiling have passed.
fn declared_payload_len(header: &[u8; HEADER_BYTES]) -> Result<usize, ProtocolError> {
    if header[..4] != PROTOCOL_MAGIC {
        return Err(ProtocolError::BadMagic);
    }
    let version = u16::from_le_bytes([header[4], header[5]]);
    if version != PROTOCOL_VERSION {
        return Err(ProtocolError::VersionMismatch {
            expected: PROTOCOL_VERSION,
            actual: version,
        });
    }
    let declared = u32::from_le_bytes(header[12..16].try_into().expect("fixed header")) as usize;
    if declared > MAX_PAYLOAD_BYTES {
        return Err(ProtocolError::PayloadTooLarge {
            actual: declared,
            max: MAX_PAYLOAD_BYTES,
        });
    }
    Ok(declared)
}

fn decode_parts(header: [u8; HEADER_BYTES], payload: &[u8]) -> Result<Frame, ProtocolError> {
    let declared = declared_payload_len(&header)?;
    if payload.len() != declared {
        return Err(ProtocolError::PayloadLengthMismatch {
            declared,
            actual: payload.len(),
        });
    }
    let mut encoded = Vec::with_capacity(HEADER_BYTES + declared);
    encoded.extend_from_slice(&header);
    encoded.extend_from_slice(payload);
    Frame::decode(&encoded)
}

/// Owned reader-worker completion. Joining is explicit so the transport can
/// cancel the shared pipe first; joining from `Drop` without that ordering
/// could wait on an otherwise valid idle read.
struct ReaderWorker(Option<JoinHandle<()>>);

impl ReaderWorker {
    fn new(handle: JoinHandle<()>) -> Self {
        Self(Some(handle))
    }

    fn join(&mut self) {
        let Some(handle) = self.0.take() else {
            return;
        };
        // The current implementation never transfers transport ownership to
        // its reader, but keep teardown robust if that internal shape changes.
        if handle.thread().id() == std::thread::current().id() {
            return;
        }
        let _ = handle.join();
    }
}

#[derive(Clone, Debug)]
enum Terminal {
    Closed,
    TimedOut,
    ChildExited(u32),
    Io(String),
    Protocol(ProtocolError),
    InvalidRequestMessage(MessageKind),
    UnexpectedResponseId { expected: u32, actual: u32 },
    UnexpectedResponseWithoutRequest { actual: u32 },
    UnexpectedPeerMessage(MessageKind),
}

impl Terminal {
    fn error(&self) -> HostTransportError {
        match self {
            Self::Closed => HostTransportError::Closed,
            Self::TimedOut => HostTransportError::TimedOut,
            Self::ChildExited(code) => HostTransportError::ChildExited { code: *code },
            Self::Io(message) => HostTransportError::Io(std::io::Error::other(message.clone())),
            Self::Protocol(error) => HostTransportError::Protocol(error.clone()),
            Self::InvalidRequestMessage(kind) => HostTransportError::InvalidRequestMessage(*kind),
            Self::UnexpectedResponseId { expected, actual } => {
                HostTransportError::UnexpectedResponseId {
                    expected: *expected,
                    actual: *actual,
                }
            }
            Self::UnexpectedResponseWithoutRequest { actual } => {
                HostTransportError::UnexpectedResponseWithoutRequest { actual: *actual }
            }
            Self::UnexpectedPeerMessage(kind) => HostTransportError::UnexpectedPeerMessage(*kind),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReaderAction {
    Continue,
    PauseForResponse,
    Close,
}

#[derive(Default)]
struct Inbox {
    pending_request: Option<u32>,
    response: Option<Frame>,
    feedback: VecDeque<Frame>,
    terminal_event: Option<Frame>,
    terminal: Option<Terminal>,
}

impl Inbox {
    fn begin_request(&mut self, request_id: u32) -> Result<(), HostTransportError> {
        if let Some(terminal) = &self.terminal {
            return Err(terminal.error());
        }
        if self.pending_request.is_some() || self.response.is_some() {
            return Err(HostTransportError::RequestAlreadyInFlight);
        }
        self.pending_request = Some(request_id);
        Ok(())
    }

    fn accept(&mut self, frame: Frame) -> ReaderAction {
        if frame.message().direction() != Direction::HostToClient {
            self.fail(Terminal::UnexpectedPeerMessage(frame.message().kind()));
            return ReaderAction::Close;
        }

        let request_id = frame.request_id();
        if request_id == 0 {
            return match frame.message().kind() {
                MessageKind::Feedback => {
                    if self.feedback.len() == MAX_QUEUED_FEEDBACK {
                        self.feedback.pop_front();
                    }
                    self.feedback.push_back(frame);
                    ReaderAction::Continue
                }
                // An asynchronous Fault is useful diagnostic evidence, but the
                // authenticated connection is already poisoned when it arrives.
                MessageKind::Fault => {
                    self.pending_request = None;
                    self.response = None;
                    self.feedback.clear();
                    self.terminal_event = Some(frame);
                    self.terminal = Some(Terminal::Closed);
                    ReaderAction::Close
                }
                kind => {
                    self.fail(Terminal::UnexpectedPeerMessage(kind));
                    ReaderAction::Close
                }
            };
        }

        let Some(expected) = self.pending_request else {
            self.fail(Terminal::UnexpectedResponseWithoutRequest { actual: request_id });
            return ReaderAction::Close;
        };
        if request_id != expected {
            self.fail(Terminal::UnexpectedResponseId {
                expected,
                actual: request_id,
            });
            return ReaderAction::Close;
        }
        if self.response.is_some() {
            self.fail(Terminal::UnexpectedResponseId {
                expected,
                actual: request_id,
            });
            return ReaderAction::Close;
        }

        let closes = frame.message().kind() == MessageKind::Fault;
        self.response = Some(frame);
        if closes {
            self.terminal = Some(Terminal::Closed);
            ReaderAction::Close
        } else {
            ReaderAction::PauseForResponse
        }
    }

    fn take_response(&mut self, request_id: u32) -> Option<Frame> {
        let matches = self
            .response
            .as_ref()
            .is_some_and(|frame| frame.request_id() == request_id);
        if !matches {
            return None;
        }
        self.pending_request = None;
        self.response.take()
    }

    fn try_take_event(&mut self) -> Result<Option<Frame>, HostTransportError> {
        if let Some(frame) = self.terminal_event.take() {
            return Ok(Some(frame));
        }
        if let Some(terminal) = &self.terminal {
            return Err(terminal.error());
        }
        Ok(self.feedback.pop_front())
    }

    fn fail(&mut self, terminal: Terminal) {
        if self.terminal.is_none() {
            self.terminal = Some(terminal);
        }
        self.pending_request = None;
        self.response = None;
        self.feedback.clear();
        self.terminal_event = None;
    }
}

#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub use windows::WindowsHostTransport;

#[cfg(test)]
mod tests {
    use ksx_core::PadState;

    use super::*;
    use crate::host::{ControllerId, FeedbackSource, HostFeedback, Message};

    /// Every `fn` declared in a span of Rust source, in declaration order.
    ///
    /// Line-based on purpose: it must see a function that a name blacklist
    /// would miss, so it strips visibility rather than matching known names.
    fn declared_fns(span: &str) -> Vec<&str> {
        span.lines()
            .filter_map(|line| {
                let mut rest = line.trim_start();
                // Strip visibility and every modifier that may precede `fn`, so
                // a `const`/`unsafe`/`async`/`extern` function cannot slip past
                // this guard the way a renamed one slips past a blacklist.
                while let Some(next) = [
                    "pub(crate) ",
                    "pub(super) ",
                    "pub ",
                    "default ",
                    "const ",
                    "async ",
                    "unsafe ",
                    "extern \"C\" ",
                    "extern ",
                ]
                .into_iter()
                .find_map(|prefix| rest.strip_prefix(prefix))
                {
                    rest = next;
                }
                let rest = rest.strip_prefix("fn ")?;
                let end = rest
                    .find(|c: char| !c.is_alphanumeric() && c != '_')
                    .unwrap_or(rest.len());
                (end > 0).then(|| &rest[..end])
            })
            .collect()
    }

    #[test]
    fn the_fn_extractor_sees_what_a_name_blacklist_would_miss() {
        // Companion to `source_keeps_production_and_fake_admission_separate`:
        // if this helper silently returned an empty list, that guard's
        // allowlist would be worthless. So prove it reads every shape.
        let sample = "\
pub fn a() {}
    pub(crate) unsafe fn b() {}
const fn c() -> u8 { 0 }
        fn d(&self) {}
pub async fn e() {}
pub const MAX: usize = 4;
// fn commented_out() {}
";
        assert_eq!(declared_fns(sample), ["a", "b", "c", "d", "e"]);
    }

    fn feedback(sequence: u64) -> Frame {
        Frame::new(
            0,
            Message::Feedback(HostFeedback {
                controller: ControllerId::new(7).unwrap(),
                sequence,
                source: FeedbackSource::OutputDecoded,
                report_len: 48,
                large_motor: sequence as u8,
                small_motor: 0,
                led_number: 0,
                motors_valid: true,
                led_valid: false,
            }),
        )
        .unwrap()
    }

    #[test]
    fn header_ceiling_is_checked_before_a_body_is_needed() {
        let mut header = [0u8; HEADER_BYTES];
        header[..4].copy_from_slice(&PROTOCOL_MAGIC);
        header[4..6].copy_from_slice(&PROTOCOL_VERSION.to_le_bytes());
        header[12..16].copy_from_slice(&((MAX_PAYLOAD_BYTES + 1) as u32).to_le_bytes());
        assert!(matches!(
            declared_payload_len(&header),
            Err(ProtocolError::PayloadTooLarge {
                actual,
                max: MAX_PAYLOAD_BYTES
            }) if actual == MAX_PAYLOAD_BYTES + 1
        ));
    }

    #[test]
    fn split_decoder_requires_one_exact_frame() {
        let encoded = Frame::new(
            9,
            Message::Submit {
                controller: ControllerId::new(7).unwrap(),
                sequence: 1,
                state: PadState::default(),
            },
        )
        .unwrap()
        .encode();
        let header: [u8; HEADER_BYTES] = encoded[..HEADER_BYTES].try_into().unwrap();
        assert_eq!(
            decode_parts(header, &encoded[HEADER_BYTES..])
                .unwrap()
                .encode(),
            encoded
        );
        assert!(matches!(
            decode_parts(header, &encoded[HEADER_BYTES..encoded.len() - 1]),
            Err(ProtocolError::PayloadLengthMismatch { .. })
        ));
    }

    #[test]
    fn feedback_queue_drops_only_the_oldest_and_keeps_64() {
        let mut inbox = Inbox::default();
        for sequence in 1..=65 {
            assert_eq!(inbox.accept(feedback(sequence)), ReaderAction::Continue);
        }
        assert_eq!(inbox.feedback.len(), MAX_QUEUED_FEEDBACK);
        let first = inbox.try_take_event().unwrap().unwrap();
        let last = inbox.feedback.back().unwrap();
        assert!(matches!(
            first.message(),
            Message::Feedback(value) if value.sequence == 2
        ));
        assert!(matches!(
            last.message(),
            Message::Feedback(value) if value.sequence == 65
        ));
    }

    #[test]
    fn only_the_exact_in_flight_response_is_accepted() {
        let mut inbox = Inbox::default();
        inbox.begin_request(12).unwrap();
        let wrong = Frame::new(13, Message::Bye).unwrap();
        assert_eq!(inbox.accept(wrong), ReaderAction::Close);
        assert!(matches!(
            inbox.try_take_event(),
            Err(HostTransportError::UnexpectedResponseId {
                expected: 12,
                actual: 13
            })
        ));
    }

    #[test]
    fn source_keeps_production_and_fake_admission_separate() {
        let source = include_str!("windows_transport/windows.rs");
        let fake_marker = source
            .find("cfg(feature = \"hidmaestro-fake-host-tests\")")
            .expect("fake admission is feature gated");
        let production = &source[..fake_marker];
        for required in [
            "reader_thread: ReaderWorker",
            "writer.close();",
            "self.reader_thread.join();",
            "pub fn connect_production(",
            "protected_hidmaestro_host()",
            "pub fn connect_production_sdk(",
            "protected_hidmaestro_sdk_host()",
            "launch_elevated(executable, &launch.argv())",
            ".accept_elevated(child, crate::host::HELLO_TIMEOUT)",
        ] {
            assert!(
                production.contains(required),
                "fail-closed worker teardown lost `{required}`"
            );
        }
        for forbidden in [
            "accept_fake(",
            "accept_hidmaestro_fake(",
            "launch_hidmaestro_fake_host(",
            "std::process::Command",
            "pub fn from_authenticated_halves(",
            "pub(crate) fn from_authenticated_halves(",
        ] {
            assert!(
                !production.contains(forbidden),
                "production transport gained an unfixed launcher/admission path: {forbidden}"
            );
        }

        // The list above is a NAME BLACKLIST, and a name blacklist over a
        // privilege boundary fails OPEN: rename the fake admission entry point
        // and the guard passes while the property it protects is gone. So the
        // real gate is this allowlist — the production span must declare
        // EXACTLY these functions, so a new admission path is a failure by
        // construction rather than a name somebody forgot to ban.
        assert_eq!(
            declared_fns(production),
            [
                "new",
                "lock",
                "fail",
                "fmt",
                // Private, and deliberately so: the one constructor both the
                // production and the fake path funnel through AFTER their own
                // authentication. It must never become `pub`/`pub(crate)`.
                "from_authenticated_halves",
                "close_with",
                "close_and_join",
                "connect_production",
                "connect_production_sdk",
                "setup_error",
                "round_trip",
                "try_receive",
                "drop",
                "reader_loop",
                "read_frame",
                "terminal_from_pipe",
            ],
            "the production span of windows.rs changed shape; if the new function \
             admits a host, it needs the elevation checks connect_production does"
        );
        assert_eq!(
            production
                .lines()
                .filter(|l| l.trim_start().starts_with("pub fn "))
                .count(),
            2,
            "only connect_production and connect_production_sdk may be public doors"
        );
        let create = production.find("OneUsePipeServer::create").unwrap();
        let seal = production.find("protected_hidmaestro_host()").unwrap();
        let launch = production
            .find("launch_elevated(executable, &launch.argv())")
            .unwrap();
        let accept = production.find(".accept_elevated(child").unwrap();
        let hello = production.find("HostClient::connect(transport").unwrap();
        assert!(create < seal && seal < launch && launch < accept && accept < hello);

        let fake = &source[fake_marker..];
        let create = fake.find("OneUsePipeServer::create").unwrap();
        let launch = fake
            .find("launch_hidmaestro_fake_host(&launch.argv())")
            .unwrap();
        let accept = fake.find(".accept_hidmaestro_fake(").unwrap();
        let hello = fake.find("HostClient::connect(").unwrap();
        assert!(create < launch && launch < accept && accept < hello);
        assert_eq!(
            fake.matches("random_32().map_err").count(),
            2,
            "token and Hello nonce require independent CSPRNG calls"
        );
    }

    #[test]
    fn reader_worker_join_observes_completion() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let completed = Arc::new(AtomicBool::new(false));
        let worker_completed = Arc::clone(&completed);
        let mut worker = ReaderWorker::new(std::thread::spawn(move || {
            worker_completed.store(true, Ordering::Release);
        }));
        worker.join();
        assert!(completed.load(Ordering::Acquire));
        assert!(worker.0.is_none(), "a joined worker cannot be joined twice");
    }
}
