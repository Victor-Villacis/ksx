use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use ksx_platform::local_pipe::{PipeIoError, PipeReader, PipeWriter};

use super::{declared_payload_len, decode_parts, Inbox, ReaderAction, ReaderWorker, Terminal};
use crate::host::{
    Direction, Frame, HostTransport, HostTransportError, HEADER_BYTES, MAX_FRAME_BYTES,
};

/// A finite ceiling for an otherwise idle background read.
///
/// Active controllers refresh their lease every second and all command waits
/// are much shorter. Keeping this ceiling generous avoids inventing a new idle
/// lifecycle while still ensuring no OS read is ever issued with `INFINITE`.
const MAX_IDLE_READ: Duration = Duration::from_secs(24 * 60 * 60);

struct Shared {
    inbox: Mutex<Inbox>,
    changed: Condvar,
}

impl Shared {
    fn new() -> Self {
        Self {
            inbox: Mutex::new(Inbox::default()),
            changed: Condvar::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inbox> {
        self.inbox
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn fail(&self, terminal: Terminal) {
        self.lock().fail(terminal);
        self.changed.notify_all();
    }
}

/// One authenticated, one-use Windows pipe conversation.
///
/// Callers cannot pass an executable, PID, privilege bit, raw handle, or
/// already-open pipe. Production construction resolves one fixed protected
/// installed sibling; the test-only constructor remains below its feature
/// boundary.
pub struct WindowsHostTransport {
    writer: Option<PipeWriter>,
    reader_thread: ReaderWorker,
    shared: Arc<Shared>,
}

impl std::fmt::Debug for WindowsHostTransport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WindowsHostTransport")
            .field("open", &self.writer.is_some())
            .finish_non_exhaustive()
    }
}

impl WindowsHostTransport {
    fn from_authenticated_halves(
        mut reader: PipeReader,
        writer: PipeWriter,
    ) -> Result<Self, HostTransportError> {
        let shared = Arc::new(Shared::new());
        let reader_shared = Arc::clone(&shared);
        let reader_thread = std::thread::Builder::new()
            .name("ksx-hidmaestro-pipe-reader".to_owned())
            .spawn(move || {
                let result = catch_unwind(AssertUnwindSafe(|| {
                    reader_loop(&mut reader, &reader_shared)
                }));
                if result.is_err() {
                    reader_shared.fail(Terminal::Io(
                        "the authenticated pipe reader thread panicked".to_owned(),
                    ));
                    reader.close();
                }
            })
            .map_err(HostTransportError::Io)?;
        Ok(Self {
            writer: Some(writer),
            reader_thread: ReaderWorker::new(reader_thread),
            shared,
        })
    }

    fn close_with(&mut self, terminal: Terminal) -> HostTransportError {
        let error = terminal.error();
        self.shared.fail(terminal);
        if let Some(writer) = self.writer.take() {
            writer.close();
        }
        self.reader_thread.join();
        error
    }

    fn close_and_join(&mut self) {
        if let Some(writer) = self.writer.take() {
            writer.close();
        }
        self.reader_thread.join();
    }

    /// Start and authenticate the one fixed installed production host, then
    /// complete the KSXH nonce and pinned-runtime handshake.
    pub fn connect_production(
        expected: crate::host::HostExpectation,
    ) -> Result<crate::host::HostClient<Self>, ProductionHostConnectError> {
        use ksx_platform::local_pipe::{random_32, OneUsePipeServer};
        use ksx_platform::process::{is_elevated, launch_elevated, protected_hidmaestro_host};

        use crate::host::{HostClient, NONCE_BYTES};
        use crate::rendezvous::{HostLaunchSpec, RendezvousToken};

        match is_elevated() {
            Some(false) => {}
            Some(true) => return Err(ProductionHostConnectError::DaemonElevated),
            None => return Err(ProductionHostConnectError::PrivilegeUnknown),
        }

        let token_bytes = random_32().map_err(setup_error)?;
        let hello_nonce: [u8; NONCE_BYTES] = random_32().map_err(setup_error)?;
        let launch =
            HostLaunchSpec::new(RendezvousToken::from_bytes(token_bytes), std::process::id())
                .map_err(setup_error)?;

        // This ordering is security-significant: the first-instance listener
        // exists before UAC can start the fixed child.
        let server = OneUsePipeServer::create(&launch.pipe_name()).map_err(setup_error)?;
        let executable = protected_hidmaestro_host().map_err(setup_error)?;
        let child = launch_elevated(executable, &launch.argv()).map_err(setup_error)?;
        let pipe = server
            .accept_elevated(child, crate::host::HELLO_TIMEOUT)
            .map_err(setup_error)?;
        let (reader, writer) = pipe.into_split();
        let transport = Self::from_authenticated_halves(reader, writer).map_err(setup_error)?;
        HostClient::connect(transport, hello_nonce, expected).map_err(Into::into)
    }
}

/// Failures before or during establishment of the fixed production host.
#[derive(Debug, thiserror::Error)]
pub enum ProductionHostConnectError {
    #[error("the KSX daemon must not already be elevated when it starts the HIDMaestro host")]
    DaemonElevated,
    #[error("the KSX daemon privilege state could not be determined")]
    PrivilegeUnknown,
    #[error("the fixed HIDMaestro host could not be established: {0}")]
    Setup(String),
    #[error(transparent)]
    Client(#[from] crate::host::HostClientError),
}

fn setup_error(error: impl std::fmt::Display) -> ProductionHostConnectError {
    ProductionHostConnectError::Setup(error.to_string())
}

impl HostTransport for WindowsHostTransport {
    fn round_trip(
        &mut self,
        request: Frame,
        timeout: Duration,
    ) -> Result<Frame, HostTransportError> {
        if request.message().direction() != Direction::ClientToHost {
            return Err(self.close_with(Terminal::InvalidRequestMessage(request.message().kind())));
        }
        if timeout.is_zero() {
            return Err(self.close_with(Terminal::TimedOut));
        }
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| self.close_with(Terminal::TimedOut))?;
        let request_id = request.request_id();
        let encoded = request.encode();
        debug_assert!(encoded.len() <= MAX_FRAME_BYTES);

        {
            let mut inbox = self.shared.lock();
            if let Err(error) = inbox.begin_request(request_id) {
                drop(inbox);
                self.shared.fail(Terminal::Closed);
                self.close_and_join();
                return Err(error);
            }
        }

        let write_timeout = deadline.saturating_duration_since(Instant::now());
        if write_timeout.is_zero() {
            return Err(self.close_with(Terminal::TimedOut));
        }
        let Some(writer) = self.writer.as_mut() else {
            return Err(self.close_with(Terminal::Closed));
        };
        let write_result = writer.write_all(&encoded, write_timeout);
        if let Err(error) = write_result {
            return Err(self.close_with(terminal_from_pipe(error)));
        }

        loop {
            let mut inbox = self.shared.lock();
            if let Some(response) = inbox.take_response(request_id) {
                self.shared.changed.notify_all();
                return Ok(response);
            }
            if let Some(terminal) = inbox.terminal.clone() {
                let error = terminal.error();
                drop(inbox);
                self.close_and_join();
                return Err(error);
            }

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                drop(inbox);
                return Err(self.close_with(Terminal::TimedOut));
            }
            let (next, waited) = self
                .shared
                .changed
                .wait_timeout(inbox, remaining)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            inbox = next;
            if waited.timed_out() && inbox.response.is_none() && inbox.terminal.is_none() {
                drop(inbox);
                return Err(self.close_with(Terminal::TimedOut));
            }
        }
    }

    fn try_receive(&mut self) -> Result<Option<Frame>, HostTransportError> {
        let result = self.shared.lock().try_take_event();
        if result.is_err() {
            self.close_and_join();
        }
        result
    }
}

impl Drop for WindowsHostTransport {
    fn drop(&mut self) {
        self.shared.fail(Terminal::Closed);
        self.close_and_join();
    }
}

fn reader_loop(reader: &mut PipeReader, shared: &Shared) {
    loop {
        let frame = match read_frame(reader) {
            Ok(frame) => frame,
            Err(error) => {
                shared.fail(error);
                reader.close();
                return;
            }
        };
        let mut inbox = shared.lock();
        match inbox.accept(frame) {
            ReaderAction::Continue => {
                shared.changed.notify_all();
            }
            ReaderAction::PauseForResponse => {
                shared.changed.notify_all();
                while inbox.response.is_some() && inbox.terminal.is_none() {
                    inbox = shared
                        .changed
                        .wait(inbox)
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                }
                if inbox.terminal.is_some() {
                    drop(inbox);
                    reader.close();
                    return;
                }
            }
            ReaderAction::Close => {
                shared.changed.notify_all();
                drop(inbox);
                reader.close();
                return;
            }
        }
    }
}

fn read_frame(reader: &mut PipeReader) -> Result<Frame, Terminal> {
    let started = Instant::now();
    let mut header = [0u8; HEADER_BYTES];
    reader
        .read_exact(&mut header, MAX_IDLE_READ)
        .map_err(terminal_from_pipe)?;
    let payload_len = declared_payload_len(&header).map_err(Terminal::Protocol)?;
    let mut payload = vec![0u8; payload_len];
    if !payload.is_empty() {
        let remaining = MAX_IDLE_READ.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            reader.close();
            return Err(Terminal::TimedOut);
        }
        reader
            .read_exact(&mut payload, remaining)
            .map_err(terminal_from_pipe)?;
    }
    decode_parts(header, &payload).map_err(Terminal::Protocol)
}

fn terminal_from_pipe(error: PipeIoError) -> Terminal {
    match error {
        PipeIoError::Closed | PipeIoError::Cancelled => Terminal::Closed,
        PipeIoError::TimedOut => Terminal::TimedOut,
        PipeIoError::ChildExited { code } => Terminal::ChildExited(code),
        PipeIoError::Io(source) => Terminal::Io(source.to_string()),
        PipeIoError::Unsupported => {
            Terminal::Io("authenticated local pipes are unsupported on this platform".to_owned())
        }
    }
}

#[cfg(feature = "hidmaestro-fake-host-tests")]
#[derive(Debug, thiserror::Error)]
enum FakeHostConnectError {
    #[error("could not create the fixed HIDMaestro fake-host rendezvous: {0}")]
    Setup(String),
    #[error(transparent)]
    Client(#[from] crate::host::HostClientError),
}

#[cfg(feature = "hidmaestro-fake-host-tests")]
fn connect_fixed_fake_host(
    expected: crate::host::HostExpectation,
) -> Result<crate::host::HostClient<WindowsHostTransport>, FakeHostConnectError> {
    use ksx_platform::local_pipe::{random_32, OneUsePipeServer};
    use ksx_platform::process::launch_hidmaestro_fake_host;

    use crate::host::{HostClient, NONCE_BYTES};
    use crate::rendezvous::{HostLaunchSpec, RendezvousToken};

    let token_bytes =
        random_32().map_err(|error| FakeHostConnectError::Setup(error.to_string()))?;
    let hello_nonce: [u8; NONCE_BYTES] =
        random_32().map_err(|error| FakeHostConnectError::Setup(error.to_string()))?;
    let launch = HostLaunchSpec::new(RendezvousToken::from_bytes(token_bytes), std::process::id())
        .map_err(|error| FakeHostConnectError::Setup(error.to_string()))?;

    // Ordering is security-significant: the first-instance listener exists
    // before the fixed child can attempt to connect.
    let server = OneUsePipeServer::create(&launch.pipe_name())
        .map_err(|error| FakeHostConnectError::Setup(error.to_string()))?;
    let child = launch_hidmaestro_fake_host(&launch.argv())
        .map_err(|error| FakeHostConnectError::Setup(error.to_string()))?;
    // Fake admission performs endpoint/process correlation. Only after it has
    // returned an authenticated opaque pipe may HostClient send Hello.
    let pipe = server
        .accept_hidmaestro_fake(child, crate::host::HELLO_TIMEOUT)
        .map_err(|error| FakeHostConnectError::Setup(error.to_string()))?;
    let (reader, writer) = pipe.into_split();
    let transport = WindowsHostTransport::from_authenticated_halves(reader, writer)
        .map_err(|error| FakeHostConnectError::Setup(error.to_string()))?;
    HostClient::connect(transport, hello_nonce, expected).map_err(Into::into)
}

#[cfg(all(test, feature = "hidmaestro-fake-host-tests"))]
mod integration_tests {
    use ksx_core::pad::XButtons;
    use ksx_core::PadState;

    use super::*;
    use crate::host::{HostExpectation, ProfileId};

    const SDK_SHA256: [u8; 32] = [
        0xAD, 0xAD, 0xD9, 0xE2, 0x60, 0x4B, 0x7B, 0x6B, 0x04, 0x7F, 0x38, 0x6E, 0xBD, 0xD0, 0x38,
        0x79, 0xFE, 0xEF, 0x48, 0x00, 0x9C, 0x62, 0x90, 0x28, 0x1E, 0x4C, 0x66, 0x5E, 0x21, 0x90,
        0xF6, 0xD5,
    ];
    const CATALOG_SHA256: [u8; 32] = [
        0x8F, 0x40, 0x7E, 0x6E, 0x1C, 0x3C, 0x24, 0x1E, 0x16, 0xCF, 0x6B, 0xEF, 0x38, 0x72, 0x16,
        0xAD, 0x4D, 0x1F, 0x5D, 0xE0, 0x55, 0xA2, 0xC4, 0xCC, 0x04, 0x1C, 0xA1, 0x6C, 0xE7, 0x95,
        0x4A, 0x6A,
    ];

    fn expectation() -> HostExpectation {
        HostExpectation {
            sdk_sha256: SDK_SHA256,
            catalog_sha256: CATALOG_SHA256,
            catalog_resource_count: 228,
        }
    }

    #[test]
    fn fixed_cross_language_fake_exercises_authenticated_framing_and_feedback() {
        let mut client = connect_fixed_fake_host(expectation()).unwrap();
        for profile in ProfileId::ALL.iter().copied() {
            let controller = client.create(profile).unwrap().controller;
            let sequence = client
                .submit(
                    controller,
                    PadState {
                        buttons: XButtons::A,
                        ..PadState::default()
                    },
                )
                .unwrap();
            assert_eq!(sequence, 1);
            let feedback = client.poll_feedback().unwrap().unwrap();
            assert_eq!(feedback.controller, controller);
            client.destroy(controller).unwrap();
        }
        client.shutdown().unwrap();
    }
}
