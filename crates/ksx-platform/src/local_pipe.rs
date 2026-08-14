//! One-use, process-bound local named pipes for privileged helpers.
//!
//! The server is created before a helper is launched. Windows enforces one
//! byte-mode, local-only instance protected by a DACL containing exactly the
//! launcher's logon SID, Builtin Administrators, and LocalSystem. Acceptance
//! is not complete until the kernel-reported pipe client PID correlates with
//! the exact process handle retained by [`crate::process::ElevatedChild`].
//!
//! All I/O is overlapped and bounded. A timeout, cancellation, child exit, or
//! partial exact-transfer failure closes the shared connection. Callers must
//! never retry a failed `read_exact`/`write_all` as if framing position were
//! still known.
//!
//! Clients must open with `SECURITY_SQOS_PRESENT` and either Anonymous or
//! Identification SQOS; they must never grant the server impersonation or
//! delegation authority. The feature-gated Rust fake uses Anonymous, and this
//! module exposes no impersonation operation.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::process::ElevatedChild;
#[cfg(feature = "hidmaestro-fake-host-tests")]
use crate::process::FakeHostChild;

const LOCAL_PIPE_PREFIX: &str = r"\\.\pipe\";
#[cfg(windows)]
const PIPE_BUFFER_BYTES: u32 = 4_096;
#[cfg(windows)]
const CANCEL_DRAIN_TIMEOUT_MS: u32 = 1_000;

/// Why a one-use pipe server could not be created.
#[derive(Debug, thiserror::Error)]
pub enum PipeCreateError {
    #[error("invalid local named-pipe name: {0}")]
    InvalidName(&'static str),
    #[error("could not construct the protected named-pipe DACL: {0}")]
    Security(#[source] io::Error),
    #[error("could not create the one-use local named pipe: {0}")]
    Create(#[source] io::Error),
    #[error("the Windows system random-number generator failed: {0}")]
    Random(#[source] io::Error),
    #[error("secure local named pipes are supported only on Windows")]
    Unsupported,
}

/// Failure while connecting or authenticating the elevated child.
///
/// The retained child can always be recovered with [`Self::into_child`]. This
/// matters after launch: dropping an error must never be the only way to learn
/// which potentially still-running process owns the durable operation.
#[derive(Debug, thiserror::Error)]
pub enum PipeAcceptError {
    #[error("the elevated child did not connect before the bounded deadline")]
    TimedOut { child: Box<ElevatedChild> },
    #[error("the elevated child exited with code {code} before admission")]
    ChildExited {
        code: u32,
        child: Box<ElevatedChild>,
    },
    #[error("the connected endpoint failed elevated-process authentication: {message}")]
    PeerAuthentication {
        message: String,
        child: Box<ElevatedChild>,
    },
    #[error("named-pipe admission failed: {source}")]
    Io {
        #[source]
        source: io::Error,
        child: Box<ElevatedChild>,
    },
    #[error("secure local named pipes are supported only on Windows")]
    Unsupported { child: Box<ElevatedChild> },
}

impl PipeAcceptError {
    /// Recover the exact child whose handle and executable seal were retained.
    pub fn into_child(self) -> ElevatedChild {
        match self {
            Self::TimedOut { child }
            | Self::ChildExited { child, .. }
            | Self::PeerAuthentication { child, .. }
            | Self::Io { child, .. }
            | Self::Unsupported { child } => *child,
        }
    }
}

/// Failure of one bounded pipe read or write.
#[derive(Debug, thiserror::Error)]
pub enum PipeIoError {
    #[error("the local pipe is closed")]
    Closed,
    #[error("the local pipe operation exceeded its bounded deadline")]
    TimedOut,
    #[error("the local pipe operation was cancelled")]
    Cancelled,
    #[error("the retained child exited with code {code}")]
    ChildExited { code: u32 },
    #[error("local pipe I/O failed: {0}")]
    Io(#[source] io::Error),
    #[error("secure local named pipes are supported only on Windows")]
    Unsupported,
}

/// Non-forgeable observation of the process connected to a production pipe.
///
/// Construction is private and always combines `GetNamedPipeClientProcessId`
/// with the retained elevated process handle. This value is deliberately not
/// `Clone` and cannot be built from a caller-supplied PID.
#[derive(Debug, PartialEq, Eq)]
pub struct AuthenticatedPeer {
    pid: u32,
    session_id: u32,
    creation_time: u64,
    canonical_image: PathBuf,
    elevated: bool,
}

impl AuthenticatedPeer {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn session_id(&self) -> u32 {
        self.session_id
    }

    pub fn creation_time(&self) -> u64 {
        self.creation_time
    }

    pub fn canonical_image(&self) -> &Path {
        &self.canonical_image
    }

    pub fn elevated(&self) -> bool {
        self.elevated
    }
}

/// Pre-created, first-instance one-use local pipe server.
pub struct OneUsePipeServer {
    #[cfg(windows)]
    handle: std::os::windows::io::OwnedHandle,
    _private: (),
}

impl std::fmt::Debug for OneUsePipeServer {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OneUsePipeServer")
            .finish_non_exhaustive()
    }
}

impl OneUsePipeServer {
    /// Create the only instance for an exact local pipe name. The name may
    /// contain a rendezvous secret, so it is neither retained nor formatted by
    /// the returned server after Windows opens the kernel object.
    #[cfg(windows)]
    pub fn create(name: &str) -> Result<Self, PipeCreateError> {
        create_server(name)
    }

    #[cfg(not(windows))]
    pub fn create(name: &str) -> Result<Self, PipeCreateError> {
        validate_local_pipe_name(name).map_err(PipeCreateError::InvalidName)?;
        Err(PipeCreateError::Unsupported)
    }

    /// Accept exactly one connection and bind it to the retained elevated
    /// child. The OS pipe-client PID query and process correlation cannot be
    /// called separately through the public API.
    #[cfg(windows)]
    pub fn accept_elevated(
        self,
        child: ElevatedChild,
        timeout: Duration,
    ) -> Result<AuthenticatedPipe, PipeAcceptError> {
        accept_elevated_windows(self, child, timeout)
    }

    #[cfg(not(windows))]
    pub fn accept_elevated(
        self,
        child: ElevatedChild,
        _timeout: Duration,
    ) -> Result<AuthenticatedPipe, PipeAcceptError> {
        let _ = self;
        Err(PipeAcceptError::Unsupported {
            child: Box::new(child),
        })
    }
}

/// An admitted production connection. Its inner allocation owns both the
/// pipe and the retained elevated child, including the executable file seal,
/// until the last reader/writer is dropped.
pub struct AuthenticatedPipe {
    inner: Arc<PipeInner>,
    peer: AuthenticatedPeer,
}

impl std::fmt::Debug for AuthenticatedPipe {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AuthenticatedPipe")
            .field("peer", &self.peer)
            .finish_non_exhaustive()
    }
}

impl AuthenticatedPipe {
    pub fn peer(&self) -> &AuthenticatedPeer {
        &self.peer
    }

    /// Consume the admitted connection into its one reader and one writer.
    pub fn into_split(self) -> (PipeReader, PipeWriter) {
        (
            PipeReader {
                inner: Arc::clone(&self.inner),
            },
            PipeWriter { inner: self.inner },
        )
    }

    pub fn close(&self) {
        self.inner.close();
    }

    /// Observe the exact retained child without reopening its PID.
    pub fn child_exit_code(&self) -> Result<Option<u32>, PipeIoError> {
        self.inner.child_exit_code()
    }
}

/// The unique read half of an authenticated or feature-gated fake connection.
pub struct PipeReader {
    inner: Arc<PipeInner>,
}

impl std::fmt::Debug for PipeReader {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("PipeReader").finish_non_exhaustive()
    }
}

impl PipeReader {
    /// Read exactly `buffer.len()` bytes before one aggregate deadline.
    /// Any error fail-closes both halves; retrying cannot resume a frame.
    pub fn read_exact(&mut self, buffer: &mut [u8], timeout: Duration) -> Result<(), PipeIoError> {
        let result = self.inner.read_exact(buffer, timeout);
        if result.is_err() {
            self.inner.close();
        }
        result
    }

    pub fn close(&self) {
        self.inner.close();
    }

    pub fn child_exit_code(&self) -> Result<Option<u32>, PipeIoError> {
        self.inner.child_exit_code()
    }
}

impl Drop for PipeReader {
    fn drop(&mut self) {
        self.inner.close();
    }
}

/// The unique write half of an authenticated or feature-gated fake connection.
pub struct PipeWriter {
    inner: Arc<PipeInner>,
}

impl std::fmt::Debug for PipeWriter {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("PipeWriter").finish_non_exhaustive()
    }
}

impl PipeWriter {
    /// Write all bytes before one aggregate deadline. Any error fail-closes
    /// both halves; retrying cannot resume a frame.
    pub fn write_all(&mut self, buffer: &[u8], timeout: Duration) -> Result<(), PipeIoError> {
        let result = self.inner.write_all(buffer, timeout);
        if result.is_err() {
            self.inner.close();
        }
        result
    }

    pub fn close(&self) {
        self.inner.close();
    }

    pub fn child_exit_code(&self) -> Result<Option<u32>, PipeIoError> {
        self.inner.child_exit_code()
    }
}

impl Drop for PipeWriter {
    fn drop(&mut self) {
        self.inner.close();
    }
}

/// Return 256 bits from Windows' system-preferred CSPRNG.
#[cfg(windows)]
pub fn random_32() -> Result<[u8; 32], PipeCreateError> {
    use windows_sys::Win32::Security::Cryptography::{
        BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
    };

    let mut bytes = [0u8; 32];
    // SAFETY: a null algorithm handle is required with
    // BCRYPT_USE_SYSTEM_PREFERRED_RNG and `bytes` is a writable exact-size
    // buffer for the duration of the call.
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status < 0 {
        return Err(PipeCreateError::Random(io::Error::other(format!(
            "BCryptGenRandom returned NTSTATUS {status:#010x}"
        ))));
    }
    Ok(bytes)
}

#[cfg(not(windows))]
pub fn random_32() -> Result<[u8; 32], PipeCreateError> {
    Err(PipeCreateError::Unsupported)
}

#[cfg(windows)]
#[derive(Debug)]
enum AcceptFailure {
    TimedOut,
    ChildExited(u32),
    PeerAuthentication(String),
    Io(io::Error),
}

#[cfg(windows)]
impl AcceptFailure {
    fn with_elevated_child(self, child: ElevatedChild) -> PipeAcceptError {
        match self {
            Self::TimedOut => PipeAcceptError::TimedOut {
                child: Box::new(child),
            },
            Self::ChildExited(code) => PipeAcceptError::ChildExited {
                code,
                child: Box::new(child),
            },
            Self::PeerAuthentication(message) => PipeAcceptError::PeerAuthentication {
                message,
                child: Box::new(child),
            },
            Self::Io(source) => PipeAcceptError::Io {
                source,
                child: Box::new(child),
            },
        }
    }
}

#[cfg(windows)]
enum RetainedChild {
    Elevated(ElevatedChild),
    #[cfg(feature = "hidmaestro-fake-host-tests")]
    Fake(FakeHostChild),
}

#[cfg(windows)]
impl std::fmt::Debug for RetainedChild {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Elevated(child) => formatter.debug_tuple("Elevated").field(child).finish(),
            #[cfg(feature = "hidmaestro-fake-host-tests")]
            Self::Fake(child) => formatter.debug_tuple("Fake").field(child).finish(),
        }
    }
}

struct PipeInner {
    #[cfg(windows)]
    pipe: std::sync::RwLock<Option<std::os::windows::io::OwnedHandle>>,
    #[cfg(windows)]
    cancel_event: std::os::windows::io::OwnedHandle,
    /// Owns the process handle and, for production, the sealed image. The raw
    /// handle is never reopened from the PID and remains valid until this
    /// allocation is dropped.
    #[cfg(windows)]
    _retained_child: RetainedChild,
    #[cfg(windows)]
    child_handle: usize,
    closed: AtomicBool,
}

impl PipeInner {
    fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        #[cfg(windows)]
        self.shutdown_windows();
    }

    fn child_exit_code(&self) -> Result<Option<u32>, PipeIoError> {
        #[cfg(windows)]
        {
            crate::process::retained_process_exit_code(self.child_handle as _, Duration::ZERO)
                .map_err(PipeIoError::Io)
        }
        #[cfg(not(windows))]
        {
            Err(PipeIoError::Unsupported)
        }
    }

    fn read_exact(&self, buffer: &mut [u8], timeout: Duration) -> Result<(), PipeIoError> {
        #[cfg(windows)]
        {
            self.read_exact_windows(buffer, timeout)
        }
        #[cfg(not(windows))]
        {
            let _ = (buffer, timeout);
            Err(PipeIoError::Unsupported)
        }
    }

    fn write_all(&self, buffer: &[u8], timeout: Duration) -> Result<(), PipeIoError> {
        #[cfg(windows)]
        {
            self.write_all_windows(buffer, timeout)
        }
        #[cfg(not(windows))]
        {
            let _ = (buffer, timeout);
            Err(PipeIoError::Unsupported)
        }
    }
}

#[cfg(windows)]
impl Drop for PipeInner {
    fn drop(&mut self) {
        self.shutdown_windows();
        // The kernel pipe closes before field destruction releases the
        // retained child and its sealed executable image.
    }
}

#[cfg(feature = "hidmaestro-fake-host-tests")]
#[derive(Debug, thiserror::Error)]
pub enum FakePipeAcceptError {
    #[error("the fixed SDK-free fake did not connect before the bounded deadline")]
    TimedOut { child: Box<FakeHostChild> },
    #[error("the fixed SDK-free fake exited with code {code} before admission")]
    ChildExited {
        code: u32,
        child: Box<FakeHostChild>,
    },
    #[error("the connected endpoint is not the retained fixed SDK-free fake: {message}")]
    PeerAuthentication {
        message: String,
        child: Box<FakeHostChild>,
    },
    #[error("fake-host named-pipe admission failed: {source}")]
    Io {
        #[source]
        source: io::Error,
        child: Box<FakeHostChild>,
    },
    #[error("secure local named pipes are supported only on Windows")]
    Unsupported { child: Box<FakeHostChild> },
}

#[cfg(feature = "hidmaestro-fake-host-tests")]
impl FakePipeAcceptError {
    pub fn into_child(self) -> FakeHostChild {
        match self {
            Self::TimedOut { child }
            | Self::ChildExited { child, .. }
            | Self::PeerAuthentication { child, .. }
            | Self::Io { child, .. }
            | Self::Unsupported { child } => *child,
        }
    }
}

#[cfg(all(windows, feature = "hidmaestro-fake-host-tests"))]
impl AcceptFailure {
    fn with_fake_child(self, child: FakeHostChild) -> FakePipeAcceptError {
        match self {
            Self::TimedOut => FakePipeAcceptError::TimedOut {
                child: Box::new(child),
            },
            Self::ChildExited(code) => FakePipeAcceptError::ChildExited {
                code,
                child: Box::new(child),
            },
            Self::PeerAuthentication(message) => FakePipeAcceptError::PeerAuthentication {
                message,
                child: Box::new(child),
            },
            Self::Io(source) => FakePipeAcceptError::Io {
                source,
                child: Box::new(child),
            },
        }
    }
}

/// Process identity captured by the fixed fake-only test admission path.
#[cfg(feature = "hidmaestro-fake-host-tests")]
#[derive(Debug, PartialEq, Eq)]
pub struct FakeAuthenticatedPeer {
    pid: u32,
    session_id: u32,
    canonical_image: PathBuf,
    elevated: bool,
}

#[cfg(feature = "hidmaestro-fake-host-tests")]
impl FakeAuthenticatedPeer {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn session_id(&self) -> u32 {
        self.session_id
    }

    pub fn canonical_image(&self) -> &Path {
        &self.canonical_image
    }

    /// Measured child state. Fake admission requires equality with the parent,
    /// so this may be true on hosted admin/UAC-off runners.
    pub fn elevated(&self) -> bool {
        self.elevated
    }
}

/// Feature-gated fake connection. It is intentionally not convertible into a
/// production [`AuthenticatedPipe`].
#[cfg(feature = "hidmaestro-fake-host-tests")]
pub struct FakeAuthenticatedPipe {
    inner: Arc<PipeInner>,
    peer: FakeAuthenticatedPeer,
}

#[cfg(feature = "hidmaestro-fake-host-tests")]
impl std::fmt::Debug for FakeAuthenticatedPipe {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("FakeAuthenticatedPipe")
            .field("peer", &self.peer)
            .finish_non_exhaustive()
    }
}

#[cfg(feature = "hidmaestro-fake-host-tests")]
impl FakeAuthenticatedPipe {
    pub fn peer(&self) -> &FakeAuthenticatedPeer {
        &self.peer
    }

    pub fn into_split(self) -> (PipeReader, PipeWriter) {
        (
            PipeReader {
                inner: Arc::clone(&self.inner),
            },
            PipeWriter { inner: self.inner },
        )
    }

    pub fn close(&self) {
        self.inner.close();
    }

    pub fn child_exit_code(&self) -> Result<Option<u32>, PipeIoError> {
        self.inner.child_exit_code()
    }
}

#[cfg(all(windows, feature = "hidmaestro-fake-host-tests"))]
impl OneUsePipeServer {
    /// Test-only admission for the one fixed fake child. Its required session
    /// and elevation are inherited from the parent and never feed production
    /// elevated-peer policy.
    pub fn accept_hidmaestro_fake(
        self,
        child: FakeHostChild,
        timeout: Duration,
    ) -> Result<FakeAuthenticatedPipe, FakePipeAcceptError> {
        accept_fake_windows(self, child, timeout)
    }
}

#[cfg(all(not(windows), feature = "hidmaestro-fake-host-tests"))]
impl OneUsePipeServer {
    pub fn accept_hidmaestro_fake(
        self,
        child: FakeHostChild,
        _timeout: Duration,
    ) -> Result<FakeAuthenticatedPipe, FakePipeAcceptError> {
        let _ = self;
        Err(FakePipeAcceptError::Unsupported {
            child: Box::new(child),
        })
    }
}

fn validate_local_pipe_name(name: &str) -> Result<(), &'static str> {
    if name.contains('\0') {
        return Err("name contains a NUL character");
    }
    let Some(prefix) = name.get(..LOCAL_PIPE_PREFIX.len()) else {
        return Err("name is not a local \\\\.\\pipe\\ path");
    };
    if !prefix.eq_ignore_ascii_case(LOCAL_PIPE_PREFIX) {
        return Err("name is not a local \\\\.\\pipe\\ path");
    }
    let leaf = &name[LOCAL_PIPE_PREFIX.len()..];
    if leaf.is_empty() {
        return Err("name has no pipe component");
    }
    if leaf
        .chars()
        .any(|character| character == '\\' || character == '/' || character.is_control())
    {
        return Err("pipe component contains a separator or control character");
    }
    // The documented Windows pipe-name limit includes the local prefix.
    if name.encode_utf16().count() > 256 {
        return Err("name exceeds Windows' 256-code-unit pipe-name limit");
    }
    Ok(())
}

#[cfg(windows)]
fn create_server(name: &str) -> Result<OneUsePipeServer, PipeCreateError> {
    use std::os::windows::ffi::OsStrExt as _;
    use std::os::windows::io::{FromRawHandle as _, OwnedHandle};
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX,
    };
    use windows_sys::Win32::System::Pipes::{
        CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
    };

    validate_local_pipe_name(name).map_err(PipeCreateError::InvalidName)?;
    let descriptor = protected_pipe_security_descriptor().map_err(PipeCreateError::Security)?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.as_ptr(),
        // The pipe handle itself must never cross CreateProcess/ShellExecute.
        bInheritHandle: 0,
    };
    let wide_name: Vec<u16> = std::ffi::OsStr::new(name)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let open_mode = PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED;
    let pipe_mode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;
    // SAFETY: `wide_name` and `attributes` remain live for this call. The
    // self-relative security descriptor allocation is owned by `descriptor`.
    let raw = unsafe {
        CreateNamedPipeW(
            wide_name.as_ptr(),
            open_mode,
            pipe_mode,
            1,
            PIPE_BUFFER_BYTES,
            PIPE_BUFFER_BYTES,
            0,
            &attributes,
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(PipeCreateError::Create(io::Error::last_os_error()));
    }
    // SAFETY: CreateNamedPipeW returned one owned, non-inheritable handle.
    let handle = unsafe { OwnedHandle::from_raw_handle(raw.cast()) };
    Ok(OneUsePipeServer {
        handle,
        _private: (),
    })
}

#[cfg(windows)]
struct LocalAllocation(*mut std::ffi::c_void);

#[cfg(windows)]
impl LocalAllocation {
    fn as_ptr(&self) -> *mut std::ffi::c_void {
        self.0
    }
}

#[cfg(windows)]
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::LocalFree;

        if !self.0.is_null() {
            // SAFETY: this allocation came from a Windows API documented to
            // require LocalFree and has not been freed elsewhere.
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

#[cfg(windows)]
fn protected_pipe_security_descriptor() -> io::Result<LocalAllocation> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };

    let logon_sid = current_logon_sid_string()?;
    let sddl = pipe_dacl_sddl(&logon_sid);
    let wide: Vec<u16> = std::ffi::OsStr::new(&sddl)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut descriptor = std::ptr::null_mut();
    // SAFETY: `wide` is a NUL-terminated SDDL string and `descriptor` is a
    // valid out-pointer. The returned allocation is owned by LocalAllocation.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if descriptor.is_null() {
        return Err(io::Error::other(
            "SDDL conversion returned a null security descriptor",
        ));
    }
    Ok(LocalAllocation(descriptor))
}

#[cfg(any(windows, test))]
fn pipe_dacl_sddl(logon_sid: &str) -> String {
    // D:P protects against inherited ACEs. There are no broad WD/AU ACEs:
    // only LocalSystem, Builtin Administrators (needed for OTS UAC), and the
    // launcher's exact logon SID receive access.
    format!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{logon_sid})")
}

#[cfg(windows)]
fn current_logon_sid_string() -> io::Result<String> {
    use std::os::windows::io::{AsRawHandle as _, FromRawHandle as _, OwnedHandle};
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenGroups, TOKEN_GROUPS, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::SystemServices::SE_GROUP_LOGON_ID;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut raw_token: HANDLE = std::ptr::null_mut();
    // SAFETY: GetCurrentProcess returns a process pseudo-handle and raw_token
    // is a valid out-pointer. Only query access is requested.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw_token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: OpenProcessToken returned one owned token handle.
    let token = unsafe { OwnedHandle::from_raw_handle(raw_token.cast()) };

    let mut required = 0u32;
    // SAFETY: the first query intentionally supplies no buffer to obtain the
    // exact variable-sized TOKEN_GROUPS allocation requirement.
    unsafe {
        GetTokenInformation(
            token.as_raw_handle().cast(),
            TokenGroups,
            std::ptr::null_mut(),
            0,
            &mut required,
        );
    }
    if required < std::mem::size_of::<TOKEN_GROUPS>() as u32 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "TokenGroups did not report a complete header size",
        ));
    }
    let word = std::mem::size_of::<usize>();
    let words = (required as usize).div_ceil(word);
    // usize storage supplies alignment suitable for TOKEN_GROUPS and remains
    // fixed while all borrowed SID pointers are inspected.
    let mut storage = vec![0usize; words];
    let mut returned = required;
    // SAFETY: storage is aligned and writable for at least `required` bytes.
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle().cast(),
            TokenGroups,
            storage.as_mut_ptr().cast(),
            required,
            &mut returned,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if returned > required {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "TokenGroups grew beyond its allocated buffer",
        ));
    }

    let groups = storage.as_ptr().cast::<TOKEN_GROUPS>();
    // SAFETY: GetTokenInformation initialized a TOKEN_GROUPS header.
    let count = unsafe { (*groups).GroupCount as usize };
    let offset = std::mem::offset_of!(TOKEN_GROUPS, Groups);
    let bytes_needed = offset
        .checked_add(
            count
                .checked_mul(std::mem::size_of::<
                    windows_sys::Win32::Security::SID_AND_ATTRIBUTES,
                >())
                .ok_or_else(|| io::Error::other("TokenGroups count overflow"))?,
        )
        .ok_or_else(|| io::Error::other("TokenGroups size overflow"))?;
    if bytes_needed > returned as usize {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "TokenGroups returned a truncated group array",
        ));
    }
    // SAFETY: the bounds check above proves all `count` entries reside in the
    // initialized result buffer.
    let entries = unsafe { std::slice::from_raw_parts((*groups).Groups.as_ptr(), count) };
    let logon_mask = SE_GROUP_LOGON_ID as u32;
    let mut matches = entries
        .iter()
        .filter(|entry| entry.Attributes & logon_mask == logon_mask);
    let sid = matches
        .next()
        .ok_or_else(|| io::Error::other("current token has no logon SID"))?
        .Sid;
    if matches.next().is_some() {
        return Err(io::Error::other("current token has multiple logon SIDs"));
    }

    let mut string_sid = std::ptr::null_mut();
    // SAFETY: `sid` points into the live token information buffer and
    // string_sid is a writable out-pointer.
    if unsafe { ConvertSidToStringSidW(sid, &mut string_sid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if string_sid.is_null() {
        return Err(io::Error::other(
            "ConvertSidToStringSidW returned a null string",
        ));
    }
    let allocation = LocalAllocation(string_sid.cast());
    let mut length = 0usize;
    // SAFETY: ConvertSidToStringSidW returns a NUL-terminated UTF-16 string.
    unsafe {
        while length < 256 && *string_sid.add(length) != 0 {
            length += 1;
        }
    }
    if length == 256 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "logon SID string exceeded its defensive bound",
        ));
    }
    // SAFETY: `length` was measured within the returned NUL-terminated string.
    let wide = unsafe { std::slice::from_raw_parts(string_sid, length) };
    let result = String::from_utf16(wide)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "logon SID was not UTF-16"));
    drop(allocation);
    result
}

#[cfg(windows)]
fn accept_elevated_windows(
    server: OneUsePipeServer,
    mut child: ElevatedChild,
    timeout: Duration,
) -> Result<AuthenticatedPipe, PipeAcceptError> {
    use std::os::windows::io::AsRawHandle as _;

    let pipe = server.handle.as_raw_handle().cast();
    if let Err(failure) = connect_server_windows(pipe, child.retained_handle(), timeout) {
        return Err(failure.with_elevated_child(child));
    }
    let first_pid = match pipe_client_pid(pipe) {
        Ok(pid) => pid,
        Err(source) => return Err(AcceptFailure::Io(source).with_elevated_child(child)),
    };
    let evidence = match child.correlate_process_pid(first_pid) {
        Ok(evidence) => evidence,
        Err(error) => return Err(map_elevated_correlation(error).with_elevated_child(child)),
    };
    let second_pid = match pipe_client_pid(pipe) {
        Ok(pid) => pid,
        Err(source) => return Err(AcceptFailure::Io(source).with_elevated_child(child)),
    };
    if second_pid != first_pid {
        return Err(AcceptFailure::PeerAuthentication(format!(
            "kernel pipe-client pid changed from {first_pid} to {second_pid}"
        ))
        .with_elevated_child(child));
    }
    if evidence.session_id() == 0 || !evidence.elevated() {
        return Err(AcceptFailure::PeerAuthentication(
            "production admission requires an elevated interactive-session child".to_owned(),
        )
        .with_elevated_child(child));
    }
    let peer = AuthenticatedPeer {
        pid: evidence.pid(),
        session_id: evidence.session_id(),
        creation_time: evidence.creation_time(),
        canonical_image: evidence.canonical_image().to_path_buf(),
        elevated: evidence.elevated(),
    };
    let child_handle = child.retained_handle() as usize;
    let OneUsePipeServer {
        handle,
        _private: _,
    } = server;
    let cancel_event = match new_event_windows(true, false) {
        Ok(event) => event,
        Err(source) => {
            return Err(PipeAcceptError::Io {
                source,
                child: Box::new(child),
            })
        }
    };
    let inner = PipeInner {
        pipe: std::sync::RwLock::new(Some(handle)),
        cancel_event,
        _retained_child: RetainedChild::Elevated(child),
        child_handle,
        closed: AtomicBool::new(false),
    };
    Ok(AuthenticatedPipe {
        inner: Arc::new(inner),
        peer,
    })
}

#[cfg(windows)]
fn map_elevated_correlation(
    error: crate::process::ElevatedProcessCorrelationError,
) -> AcceptFailure {
    match error {
        crate::process::ElevatedProcessCorrelationError::ChildExited { code } => {
            AcceptFailure::ChildExited(code)
        }
        other => AcceptFailure::PeerAuthentication(other.to_string()),
    }
}

#[cfg(windows)]
fn pipe_client_pid(pipe: windows_sys::Win32::Foundation::HANDLE) -> io::Result<u32> {
    use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;

    let mut pid = 0u32;
    // SAFETY: `pipe` is the live connected server handle and `pid` is a valid
    // out-pointer. Failure is propagated and zero is never accepted.
    if unsafe { GetNamedPipeClientProcessId(pipe, &mut pid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if pid == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "GetNamedPipeClientProcessId returned zero",
        ));
    }
    Ok(pid)
}

#[cfg(windows)]
struct PendingOverlapped {
    event: std::os::windows::io::OwnedHandle,
    overlapped: windows_sys::Win32::System::IO::OVERLAPPED,
    /// Kernel-visible storage owned by the operation. If Windows cannot
    /// confirm cancellation inside the cleanup ceiling, the whole allocation
    /// is intentionally leaked so no borrowed Rust buffer can become dangling.
    buffer: Vec<u8>,
}

#[cfg(windows)]
impl PendingOverlapped {
    fn new(buffer: Vec<u8>) -> io::Result<Box<Self>> {
        use std::os::windows::io::AsRawHandle as _;
        use windows_sys::Win32::System::IO::OVERLAPPED;

        let event = new_event_windows(true, false)?;
        let mut pending = Box::new(Self {
            event,
            overlapped: OVERLAPPED::default(),
            buffer,
        });
        pending.overlapped.hEvent = pending.event.as_raw_handle().cast();
        Ok(pending)
    }
}

#[cfg(windows)]
fn connect_server_windows(
    pipe: windows_sys::Win32::Foundation::HANDLE,
    child: windows_sys::Win32::Foundation::HANDLE,
    timeout: Duration,
) -> Result<(), AcceptFailure> {
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Foundation::{
        ERROR_IO_PENDING, ERROR_PIPE_CONNECTED, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Pipes::ConnectNamedPipe;
    use windows_sys::Win32::System::Threading::WaitForMultipleObjects;
    use windows_sys::Win32::System::IO::GetOverlappedResult;

    let mut pending = PendingOverlapped::new(Vec::new()).map_err(AcceptFailure::Io)?;
    // SAFETY: `pipe` was created for overlapped operation and the boxed state
    // remains stable until completion is observed, boundedly drained, or
    // deliberately leaked.
    if unsafe { ConnectNamedPipe(pipe, &mut pending.overlapped) } != 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    match error.raw_os_error().map(|code| code as u32) {
        Some(ERROR_PIPE_CONNECTED) => return Ok(()),
        Some(ERROR_IO_PENDING) => {}
        _ => return Err(AcceptFailure::Io(error)),
    }

    let handles = [pending.event.as_raw_handle().cast(), child];
    // SAFETY: both handles and the array remain valid through this bounded
    // wait. The first is the exact operation event, the second the retained
    // child process object.
    let waited = unsafe {
        WaitForMultipleObjects(
            handles.len() as u32,
            handles.as_ptr(),
            0,
            bounded_wait_millis(timeout),
        )
    };
    if waited == WAIT_OBJECT_0 {
        let mut transferred = 0u32;
        // SAFETY: the operation event is signalled and the OVERLAPPED storage
        // is still live; a nonblocking result query completes the observation.
        if unsafe { GetOverlappedResult(pipe, &pending.overlapped, &mut transferred, 0) } == 0 {
            return Err(AcceptFailure::Io(io::Error::last_os_error()));
        }
        return Ok(());
    }
    if waited == WAIT_OBJECT_0 + 1 {
        cancel_pending_windows(pipe, pending).map_err(AcceptFailure::Io)?;
        let code = crate::process::retained_process_exit_code(child, Duration::ZERO)
            .map_err(AcceptFailure::Io)?
            .ok_or_else(|| {
                AcceptFailure::Io(io::Error::other(
                    "child wait signalled without an observable exit code",
                ))
            })?;
        return Err(AcceptFailure::ChildExited(code));
    }
    if waited == WAIT_TIMEOUT {
        cancel_pending_windows(pipe, pending).map_err(AcceptFailure::Io)?;
        return Err(AcceptFailure::TimedOut);
    }
    if waited == WAIT_FAILED {
        let failure = io::Error::last_os_error();
        cancel_pending_windows(pipe, pending).map_err(AcceptFailure::Io)?;
        return Err(AcceptFailure::Io(failure));
    }
    cancel_pending_windows(pipe, pending).map_err(AcceptFailure::Io)?;
    Err(AcceptFailure::Io(io::Error::other(format!(
        "WaitForMultipleObjects returned unexpected status {waited:#x}"
    ))))
}

#[cfg(windows)]
fn new_event_windows(
    manual_reset: bool,
    initial_state: bool,
) -> io::Result<std::os::windows::io::OwnedHandle> {
    use std::os::windows::io::{FromRawHandle as _, OwnedHandle};
    use windows_sys::Win32::System::Threading::CreateEventW;

    // SAFETY: this creates an unnamed, non-inheritable event because security
    // attributes and the name are null.
    let raw = unsafe {
        CreateEventW(
            std::ptr::null(),
            manual_reset as i32,
            initial_state as i32,
            std::ptr::null(),
        )
    };
    if raw.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateEventW returned one owned handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw.cast()) })
}

#[cfg(windows)]
fn cancel_pending_windows(
    pipe: windows_sys::Win32::Foundation::HANDLE,
    pending: Box<PendingOverlapped>,
) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Foundation::{
        ERROR_IO_INCOMPLETE, ERROR_NOT_FOUND, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Threading::WaitForSingleObject;
    use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult};

    // SAFETY: the boxed OVERLAPPED identifies the exact operation and cannot
    // move during cancellation.
    if unsafe { CancelIoEx(pipe, &pending.overlapped) } == 0 {
        let cancellation = io::Error::last_os_error();
        if cancellation.raw_os_error().map(|code| code as u32) != Some(ERROR_NOT_FOUND) {
            // The kernel may still own OVERLAPPED/buffer pointers. Leaking is
            // the only memory-safe bounded return when cancellation itself is
            // unavailable; closing the pipe immediately afterwards finishes
            // the operation without exposing borrowed caller memory.
            let _ = Box::leak(pending);
            return Err(io::Error::other(format!(
                "CancelIoEx failed; pending storage was quarantined: {cancellation}"
            )));
        }
    }

    // SAFETY: the operation event remains owned by `pending` for this finite
    // wait. No TRUE/unbounded GetOverlappedResult call is used.
    let waited = unsafe {
        WaitForSingleObject(
            pending.event.as_raw_handle().cast(),
            CANCEL_DRAIN_TIMEOUT_MS,
        )
    };
    if waited == WAIT_OBJECT_0 {
        let mut transferred = 0u32;
        // SAFETY: a signalled operation event makes this a nonblocking terminal
        // status read. ERROR_OPERATION_ABORTED is a completed cancellation.
        if unsafe { GetOverlappedResult(pipe, &pending.overlapped, &mut transferred, 0) } == 0 {
            let terminal = io::Error::last_os_error();
            if terminal.raw_os_error().map(|code| code as u32) == Some(ERROR_IO_INCOMPLETE) {
                let _ = Box::leak(pending);
                return Err(io::Error::other(
                    "cancelled operation remained incomplete; pending storage was quarantined",
                ));
            }
        }
        return Ok(());
    }
    let failure = if waited == WAIT_TIMEOUT {
        io::Error::new(
            io::ErrorKind::TimedOut,
            "cancelled operation did not drain inside the cleanup ceiling",
        )
    } else if waited == WAIT_FAILED {
        io::Error::last_os_error()
    } else {
        io::Error::other(format!(
            "cancel drain wait returned unexpected status {waited:#x}"
        ))
    };
    let _ = Box::leak(pending);
    Err(failure)
}

#[cfg(any(windows, test))]
fn bounded_wait_millis(timeout: Duration) -> u32 {
    if timeout.is_zero() {
        return 0;
    }
    let millis = timeout.as_millis().min((u32::MAX - 1) as u128) as u32;
    millis.max(1)
}

#[cfg(windows)]
#[derive(Clone, Copy)]
enum TransferDirection {
    Read,
    Write,
}

#[cfg(windows)]
impl PipeInner {
    fn shutdown_windows(&self) {
        use std::os::windows::io::AsRawHandle as _;
        use windows_sys::Win32::System::Threading::SetEvent;
        use windows_sys::Win32::System::IO::CancelIoEx;

        // SAFETY: this allocation owns the event. Signalling it wakes every
        // bounded waiter before the pipe handle is taken.
        unsafe {
            SetEvent(self.cancel_event.as_raw_handle().cast());
        }
        {
            let guard = self
                .pipe
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(pipe) = guard.as_ref() {
                // SAFETY: the read guard keeps the handle live while all
                // outstanding overlapped operations receive cancellation.
                unsafe {
                    CancelIoEx(pipe.as_raw_handle().cast(), std::ptr::null());
                }
            }
        }
        // Operations retain a read guard until their OVERLAPPED and borrowed
        // buffers are drained. The write guard therefore makes CloseHandle
        // memory-safe and gives the remote endpoint immediate EOF even when a
        // Rust reader/writer allocation still exists.
        let mut guard = self
            .pipe
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        drop(guard.take());
    }

    fn read_exact_windows(
        &self,
        mut buffer: &mut [u8],
        timeout: Duration,
    ) -> Result<(), PipeIoError> {
        let started = std::time::Instant::now();
        while !buffer.is_empty() {
            let chunk_len = buffer.len().min(PIPE_BUFFER_BYTES as usize);
            let remaining = remaining_duration(started, timeout);
            let (owned, transferred) = self.transfer_once_windows(
                vec![0u8; chunk_len],
                TransferDirection::Read,
                remaining,
            )?;
            if transferred == 0 {
                return Err(PipeIoError::Closed);
            }
            let consumed = transferred as usize;
            if consumed > chunk_len {
                return Err(PipeIoError::Io(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "ReadFile reported more bytes than requested",
                )));
            }
            buffer[..consumed].copy_from_slice(&owned[..consumed]);
            buffer = &mut buffer[consumed..];
        }
        Ok(())
    }

    fn write_all_windows(&self, mut buffer: &[u8], timeout: Duration) -> Result<(), PipeIoError> {
        let started = std::time::Instant::now();
        while !buffer.is_empty() {
            let chunk_len = buffer.len().min(PIPE_BUFFER_BYTES as usize);
            let remaining = remaining_duration(started, timeout);
            let transferred = self
                .transfer_once_windows(
                    buffer[..chunk_len].to_vec(),
                    TransferDirection::Write,
                    remaining,
                )?
                .1;
            if transferred == 0 {
                return Err(PipeIoError::Closed);
            }
            let consumed = transferred as usize;
            if consumed > chunk_len {
                return Err(PipeIoError::Io(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "WriteFile reported more bytes than requested",
                )));
            }
            buffer = &buffer[consumed..];
        }
        Ok(())
    }

    fn transfer_once_windows(
        &self,
        buffer: Vec<u8>,
        direction: TransferDirection,
        timeout: Duration,
    ) -> Result<(Vec<u8>, u32), PipeIoError> {
        use std::os::windows::io::AsRawHandle as _;
        use windows_sys::Win32::Foundation::{
            ERROR_IO_PENDING, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
        };
        use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
        use windows_sys::Win32::System::Threading::WaitForMultipleObjects;

        if self.closed.load(Ordering::Acquire) {
            return Err(PipeIoError::Closed);
        }
        let mut pending = PendingOverlapped::new(buffer).map_err(PipeIoError::Io)?;
        let length = pending.buffer.len() as u32;
        let pipe_guard = self
            .pipe
            .read()
            .map_err(|_| PipeIoError::Io(io::Error::other("pipe handle lock was poisoned")))?;
        let pipe = pipe_guard
            .as_ref()
            .ok_or(PipeIoError::Closed)?
            .as_raw_handle()
            .cast();
        // SAFETY: the boxed operation owns a stable `length`-byte region until
        // completion, bounded drain, or deliberate quarantine. Direction
        // determines whether Windows writes or only reads that region.
        let started = unsafe {
            match direction {
                TransferDirection::Read => ReadFile(
                    pipe,
                    pending.buffer.as_mut_ptr(),
                    length,
                    std::ptr::null_mut(),
                    &mut pending.overlapped,
                ),
                TransferDirection::Write => WriteFile(
                    pipe,
                    pending.buffer.as_ptr(),
                    length,
                    std::ptr::null_mut(),
                    &mut pending.overlapped,
                ),
            }
        };
        if started != 0 {
            let transferred = overlapped_result_windows(pipe, &pending.overlapped)?;
            return Ok((std::mem::take(&mut pending.buffer), transferred));
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error().map(|code| code as u32) != Some(ERROR_IO_PENDING) {
            return Err(map_pipe_io_error(error));
        }

        let handles: [windows_sys::Win32::Foundation::HANDLE; 3] = [
            pending.event.as_raw_handle().cast(),
            self.cancel_event.as_raw_handle().cast(),
            self.child_handle as _,
        ];
        // SAFETY: all handles stay owned by self/event through the wait.
        let waited = unsafe {
            WaitForMultipleObjects(
                handles.len() as u32,
                handles.as_ptr(),
                0,
                bounded_wait_millis(timeout),
            )
        };
        if waited == WAIT_OBJECT_0 {
            let transferred = overlapped_result_windows(pipe, &pending.overlapped)?;
            return Ok((std::mem::take(&mut pending.buffer), transferred));
        }
        if waited == WAIT_OBJECT_0 + 1 {
            cancel_pending_windows(pipe, pending).map_err(PipeIoError::Io)?;
            return Err(PipeIoError::Cancelled);
        }
        if waited == WAIT_OBJECT_0 + 2 {
            cancel_pending_windows(pipe, pending).map_err(PipeIoError::Io)?;
            let code =
                crate::process::retained_process_exit_code(self.child_handle as _, Duration::ZERO)
                    .map_err(PipeIoError::Io)?
                    .ok_or_else(|| {
                        PipeIoError::Io(io::Error::other(
                            "child wait signalled without an observable exit code",
                        ))
                    })?;
            return Err(PipeIoError::ChildExited { code });
        }
        if waited == WAIT_TIMEOUT {
            cancel_pending_windows(pipe, pending).map_err(PipeIoError::Io)?;
            return Err(PipeIoError::TimedOut);
        }
        if waited == WAIT_FAILED {
            let failure = io::Error::last_os_error();
            cancel_pending_windows(pipe, pending).map_err(PipeIoError::Io)?;
            return Err(PipeIoError::Io(failure));
        }
        cancel_pending_windows(pipe, pending).map_err(PipeIoError::Io)?;
        Err(PipeIoError::Io(io::Error::other(format!(
            "WaitForMultipleObjects returned unexpected status {waited:#x}"
        ))))
    }
}

#[cfg(windows)]
fn overlapped_result_windows(
    pipe: windows_sys::Win32::Foundation::HANDLE,
    overlapped: &windows_sys::Win32::System::IO::OVERLAPPED,
) -> Result<u32, PipeIoError> {
    use windows_sys::Win32::System::IO::GetOverlappedResult;

    let mut transferred = 0u32;
    // SAFETY: the operation has completed synchronously or its event is
    // signalled, and the exact OVERLAPPED remains live.
    if unsafe { GetOverlappedResult(pipe, overlapped, &mut transferred, 0) } == 0 {
        Err(map_pipe_io_error(io::Error::last_os_error()))
    } else {
        Ok(transferred)
    }
}

#[cfg(windows)]
fn map_pipe_io_error(error: io::Error) -> PipeIoError {
    use windows_sys::Win32::Foundation::{
        ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_OPERATION_ABORTED, ERROR_PIPE_NOT_CONNECTED,
    };

    match error.raw_os_error().map(|code| code as u32) {
        Some(ERROR_BROKEN_PIPE) | Some(ERROR_NO_DATA) | Some(ERROR_PIPE_NOT_CONNECTED) => {
            PipeIoError::Closed
        }
        Some(ERROR_OPERATION_ABORTED) => PipeIoError::Cancelled,
        _ => PipeIoError::Io(error),
    }
}

#[cfg(windows)]
fn remaining_duration(started: std::time::Instant, timeout: Duration) -> Duration {
    timeout.saturating_sub(started.elapsed())
}

#[cfg(all(windows, feature = "hidmaestro-fake-host-tests"))]
fn accept_fake_windows(
    server: OneUsePipeServer,
    child: FakeHostChild,
    timeout: Duration,
) -> Result<FakeAuthenticatedPipe, FakePipeAcceptError> {
    use std::os::windows::io::AsRawHandle as _;

    let pipe = server.handle.as_raw_handle().cast();
    if let Err(failure) = connect_server_windows(pipe, child.retained_handle(), timeout) {
        return Err(failure.with_fake_child(child));
    }
    let first_pid = match pipe_client_pid(pipe) {
        Ok(pid) => pid,
        Err(source) => return Err(AcceptFailure::Io(source).with_fake_child(child)),
    };
    let evidence = match child.correlate_fake_process_pid(first_pid) {
        Ok(evidence) => evidence,
        Err(error) => {
            let failure = match error {
                crate::process::FakeHostCorrelationError::ChildExited { code } => {
                    AcceptFailure::ChildExited(code)
                }
                other => AcceptFailure::PeerAuthentication(other.to_string()),
            };
            return Err(failure.with_fake_child(child));
        }
    };
    let second_pid = match pipe_client_pid(pipe) {
        Ok(pid) => pid,
        Err(source) => return Err(AcceptFailure::Io(source).with_fake_child(child)),
    };
    if first_pid != second_pid {
        return Err(AcceptFailure::PeerAuthentication(format!(
            "kernel pipe-client pid changed from {first_pid} to {second_pid}"
        ))
        .with_fake_child(child));
    }
    let peer = FakeAuthenticatedPeer {
        pid: evidence.pid(),
        session_id: evidence.session_id(),
        canonical_image: evidence.canonical_image().to_path_buf(),
        elevated: evidence.elevated(),
    };
    let child_handle = child.retained_handle() as usize;
    let OneUsePipeServer {
        handle,
        _private: _,
    } = server;
    let cancel_event = match new_event_windows(true, false) {
        Ok(event) => event,
        Err(source) => {
            return Err(FakePipeAcceptError::Io {
                source,
                child: Box::new(child),
            })
        }
    };
    let inner = PipeInner {
        pipe: std::sync::RwLock::new(Some(handle)),
        cancel_event,
        _retained_child: RetainedChild::Fake(child),
        child_handle,
        closed: AtomicBool::new(false),
    };
    Ok(FakeAuthenticatedPipe {
        inner: Arc::new(inner),
        peer,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_pipe_names_cannot_select_remote_or_nested_namespaces() {
        assert!(validate_local_pipe_name(r"\\.\pipe\KSX.HIDMaestro.Play.v1.0123").is_ok());
        assert!(validate_local_pipe_name(r"\\server\pipe\KSX").is_err());
        assert!(validate_local_pipe_name(r"\\.\pipe\").is_err());
        assert!(validate_local_pipe_name(r"\\.\pipe\KSX\nested").is_err());
        assert!(validate_local_pipe_name("\\\\.\\pipe\\KSX\0other").is_err());
    }

    #[test]
    fn rendezvous_name_is_not_retained_or_debug_formatted() {
        let source = include_str!("local_pipe.rs").replace("\r\n", "\n");
        let server = source
            .split("pub struct OneUsePipeServer")
            .nth(1)
            .expect("one-use server")
            .split("impl OneUsePipeServer")
            .next()
            .unwrap();
        assert!(!server.contains("name: String"));
        assert!(!server.contains(".field(\"name\""));
    }

    #[test]
    fn dacl_is_protected_and_has_only_logon_admin_system_aces() {
        assert_eq!(
            pipe_dacl_sddl("S-1-5-5-123-456"),
            "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;S-1-5-5-123-456)"
        );
        let source = include_str!("local_pipe.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(!source.contains(";;;WD)"));
        assert!(!source.contains(";;;AU)"));
    }

    #[test]
    fn bounded_wait_rounds_up_without_ever_selecting_infinite() {
        assert_eq!(bounded_wait_millis(Duration::ZERO), 0);
        assert_eq!(bounded_wait_millis(Duration::from_nanos(1)), 1);
        assert_eq!(bounded_wait_millis(Duration::from_millis(9)), 9);
        assert_eq!(bounded_wait_millis(Duration::MAX), u32::MAX - 1);
    }

    /// Pure source check: no named pipe or process is created by this test.
    #[test]
    fn server_creation_is_first_instance_max_one_local_byte_overlapped_and_noninheritable() {
        let source = include_str!("local_pipe.rs").replace("\r\n", "\n");
        let create = source
            .split("fn create_server(")
            .nth(1)
            .expect("Windows server creator")
            .split("struct LocalAllocation")
            .next()
            .unwrap();
        for required in [
            "PIPE_ACCESS_DUPLEX",
            "FILE_FLAG_FIRST_PIPE_INSTANCE",
            "FILE_FLAG_OVERLAPPED",
            "PIPE_TYPE_BYTE",
            "PIPE_READMODE_BYTE",
            "PIPE_WAIT",
            "PIPE_REJECT_REMOTE_CLIENTS",
            "bInheritHandle: 0",
        ] {
            assert!(
                create.contains(required),
                "missing server invariant {required}"
            );
        }
        assert!(create.contains("pipe_mode,\n            1,"));
    }

    /// Broken version caught: callers could pass `child.pid()` directly into
    /// a public correlation method and mint endpoint trust without a pipe.
    #[test]
    fn production_admission_combines_kernel_pipe_pid_and_retained_child_correlation() {
        let source = include_str!("local_pipe.rs").replace("\r\n", "\n");
        let public_accept = source
            .split("pub fn accept_elevated(")
            .nth(1)
            .expect("production accept")
            .split(") -> Result<AuthenticatedPipe")
            .next()
            .unwrap();
        assert!(!public_accept.contains("pid:"));
        assert!(!public_accept.contains("expected_elevation"));

        let authenticate = source
            .split("fn accept_elevated_windows(")
            .nth(1)
            .expect("combined authenticator")
            .split("fn map_elevated_correlation")
            .next()
            .unwrap();
        let first_kernel_pid = authenticate
            .find("pipe_client_pid(pipe)")
            .expect("first kernel client-pid query");
        let correlation = authenticate
            .find("child.correlate_process_pid(first_pid)")
            .expect("retained-child correlation");
        let second_kernel_pid = authenticate
            .rfind("pipe_client_pid(pipe)")
            .expect("second kernel client-pid query");
        assert!(first_kernel_pid < correlation && correlation < second_kernel_pid);
        assert!(authenticate.contains("evidence.session_id() == 0"));
        assert!(authenticate.contains("!evidence.elevated()"));
    }

    #[test]
    fn exact_io_errors_fail_close_the_shared_connection() {
        let source = include_str!("local_pipe.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap()
            .replace("\r\n", "\n");
        for method in ["pub fn read_exact(", "pub fn write_all("] {
            let body = source
                .split(method)
                .nth(1)
                .expect("public exact I/O method")
                .split("\n    }")
                .next()
                .unwrap();
            assert!(body.contains("if result.is_err()"));
            assert!(body.contains("self.inner.close()"));
        }
        assert!(source.contains("CancelIoEx(pipe, &pending.overlapped)"));
        assert!(source.contains("CANCEL_DRAIN_TIMEOUT_MS"));
        assert!(source.contains("Box::leak(pending)"));
        assert!(!source.contains("GetOverlappedResult(pipe, overlapped, &mut transferred, 1)"));
    }

    #[cfg(feature = "hidmaestro-fake-host-tests")]
    #[test]
    fn fake_admission_is_a_distinct_fixed_child_type_without_a_downgrade_bool() {
        let source = include_str!("local_pipe.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(source.contains("Result<FakeAuthenticatedPipe, FakePipeAcceptError>"));
        assert!(!source.contains("expected_elevation: bool"));
        assert!(!source.contains("pub fn connect_hidmaestro_fake"));
    }
}
