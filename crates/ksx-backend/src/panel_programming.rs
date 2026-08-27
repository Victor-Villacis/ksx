//! Lossless, transport-injected I-PAC 4 chart programming.
//!
//! This module owns the protocol and transaction rules, but it cannot open a
//! device.  A platform adapter must implement [`PanelReportIo`], which keeps
//! the write path testable without a cabinet and prevents importing Win32 HID
//! policy into the domain layer.
//!
//! The raw chart is authoritative.  Semantic edits always clone a chart and
//! replace only the addressed byte; opaque settings, alternate assignments,
//! shift state, macros and any firmware-specific tail therefore survive.

use std::collections::BTreeSet;
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use ksx_config::Timestamp;
use ksx_platform::sha256::{hex_upper, Sha256};

pub(crate) const IPAC4_REPORT_ID: u8 = 0x03;
pub(crate) const IPAC4_REPORT_BYTES: usize = 5;
pub(crate) const IPAC4_QUERY: [u8; IPAC4_REPORT_BYTES] = [0x03, 0x59, 0xDD, 0x0F, 0x00];
pub(crate) const IPAC4_READBACK_HEADER: [u8; 3] = [0x50, 0xDD, 0x56];
pub(crate) const IPAC4_WRITE_HEADER: [u8; 3] = [0x50, 0xDD, 0x0F];
pub(crate) const IPAC4_REQUIRED_FRAMES: usize = 64;
pub(crate) const IPAC4_IMAGE_BYTES: usize = 256;
pub(crate) const IPAC4_EXTENDED_IMAGE_BYTES: usize = 260;
pub(crate) const IPAC4_HEADER_BYTES: usize = 4;
pub(crate) const IPAC4_TERMINAL_COUNT: usize = 56;
pub(crate) const IPAC4_BCD_DEVICE: u16 = 0x0056;
pub(crate) const IPAC4_PROTOCOL_PROFILE: &str = "ipac4-pac256-v1";

const REQUIRED_FRAME_TIMEOUT: Duration = Duration::from_millis(750);
const BACKUP_SCHEMA: &str = "ksx.panel-backup.v1";
const BACKUP_EXTENSION: &str = ".ksxpanel.json";
#[cfg(not(windows))]
const PROGRAMMING_LEASE_FILE: &str = "panel-programming.lock";
#[cfg(all(windows, not(test)))]
const PROGRAMMING_LEASE_MUTEX: &str = r"Global\KeyboardSplitterXboxPro.PanelProgramming.v1";
pub(crate) const IPAC4_DRIVER: &str = "ultimarc-ipac4";
const IPAC4_DRIVER_SCHEMA: usize = 1;
const IPAC4_COLLECTION_RULE: &str = "unique exact 5-byte input/output HID collection";

/// Cross-process exclusion shared by EEPROM operations and every daemon
/// transition that can start a Play session.  Owning only one side of this
/// lease would leave a packet-zero race: the daemon could start after the
/// programmer's final status check.  The daemon therefore holds the same
/// lease until it has published Running (or failed), while the programmer
/// holds it for the complete read/backup/write/readback transaction.
pub(crate) struct PanelProgrammingLease {
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
    #[cfg(windows)]
    mutex_name: String,
    #[cfg(not(windows))]
    file: Option<fs::File>,
    #[cfg(not(windows))]
    path: PathBuf,
}

impl PanelProgrammingLease {
    #[cfg(windows)]
    pub(crate) fn acquire(config_dir: &Path) -> std::io::Result<Self> {
        use windows_sys::Win32::Foundation::{WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT};
        use windows_sys::Win32::System::Threading::{CreateMutexW, WaitForSingleObject};

        let mutex_name = programming_lease_mutex_name(config_dir);
        claim_process_panel_lease(&mutex_name)?;
        let name = mutex_name
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        // SAFETY: null security attributes and a fixed NUL-terminated name.
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            release_process_panel_lease(&mutex_name);
            return Err(std::io::Error::last_os_error());
        }
        // A zero wait is intentional. Starting Play or touching persistent
        // memory is a user action; neither silently queues behind the other.
        let wait = unsafe { WaitForSingleObject(handle, 0) };
        if wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED {
            Ok(Self { handle, mutex_name })
        } else {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
            release_process_panel_lease(&mutex_name);
            if wait == WAIT_TIMEOUT {
                Err(std::io::Error::new(
                    std::io::ErrorKind::WouldBlock,
                    "the machine-wide panel programming lease is already held",
                ))
            } else {
                Err(std::io::Error::other(format!(
                    "WaitForSingleObject returned {wait:#x}"
                )))
            }
        }
    }

    #[cfg(not(windows))]
    pub(crate) fn acquire(config_dir: &Path) -> std::io::Result<Self> {
        fs::create_dir_all(config_dir)?;
        let path = config_dir.join(PROGRAMMING_LEASE_FILE);
        let file = open_exclusive_programming_lease(&path)?;
        Ok(Self {
            file: Some(file),
            path,
        })
    }
}

#[cfg(windows)]
fn process_panel_leases() -> &'static std::sync::Mutex<BTreeSet<String>> {
    static LEASES: std::sync::OnceLock<std::sync::Mutex<BTreeSet<String>>> =
        std::sync::OnceLock::new();
    LEASES.get_or_init(|| std::sync::Mutex::new(BTreeSet::new()))
}

#[cfg(windows)]
fn claim_process_panel_lease(name: &str) -> std::io::Result<()> {
    let mut leases = process_panel_leases()
        .lock()
        .map_err(|_| std::io::Error::other("the in-process panel lease registry is poisoned"))?;
    if !leases.insert(name.to_owned()) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::WouldBlock,
            "the machine-wide panel programming lease is already held",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn release_process_panel_lease(name: &str) {
    if let Ok(mut leases) = process_panel_leases().lock() {
        leases.remove(name);
    }
}

#[cfg(all(windows, not(test)))]
fn programming_lease_mutex_name(_config_dir: &Path) -> String {
    PROGRAMMING_LEASE_MUTEX.to_owned()
}

#[cfg(all(windows, test))]
fn programming_lease_mutex_name(config_dir: &Path) -> String {
    // Unit tests construct many independent fake daemons concurrently. Give
    // each fake root a private namespace while preserving reciprocal locking
    // inside that test; production always uses the fixed name above.
    let mut hasher = Sha256::new();
    hasher.update(config_dir.as_os_str().to_string_lossy().as_bytes());
    let suffix = hex_upper(&hasher.finish());
    format!(
        r"Local\KeyboardSplitterXboxPro.PanelProgramming.Test.{}",
        &suffix[..16]
    )
}

impl Drop for PanelProgrammingLease {
    fn drop(&mut self) {
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::Threading::ReleaseMutex;
            unsafe {
                ReleaseMutex(self.handle);
                windows_sys::Win32::Foundation::CloseHandle(self.handle);
            }
            release_process_panel_lease(&self.mutex_name);
        }
        #[cfg(not(windows))]
        {
            drop(self.file.take());
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(not(windows))]
fn open_exclusive_programming_lease(path: &Path) -> std::io::Result<fs::File> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

/// Error supplied by a platform report adapter.  `code` is normally the
/// native OS error code; adapters without one leave it absent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReportIoError {
    pub code: Option<u32>,
    pub message: String,
}

impl ReportIoError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            code: None,
            message: message.into(),
        }
    }

    #[cfg(test)]
    pub fn with_code(code: u32, message: impl Into<String>) -> Self {
        Self {
            code: Some(code),
            message: message.into(),
        }
    }
}

impl fmt::Display for ReportIoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.code {
            Some(code) => write!(f, "{} (OS error {code})", self.message),
            None => f.write_str(&self.message),
        }
    }
}

impl std::error::Error for ReportIoError {}

/// The only hardware-shaped seam in this module.
///
/// A bounded receive returns `Ok(None)` only when its deadline elapsed without
/// a report.  A returned report remains a `Vec` so this layer can reject short
/// and oversized framing rather than trusting the adapter.
pub(crate) trait PanelReportIo {
    fn send_report(&mut self, report: &[u8]) -> Result<(), ReportIoError>;

    fn receive_report(&mut self, timeout: Duration) -> Result<Option<Vec<u8>>, ReportIoError>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum IoOperation {
    Query,
    Read,
    Write,
    VerifyQuery,
    VerifyRead,
}

impl fmt::Display for IoOperation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Query => "chart query",
            Self::Read => "chart read",
            Self::Write => "chart write",
            Self::VerifyQuery => "verification query",
            Self::VerifyRead => "verification read",
        })
    }
}

#[derive(Debug)]
pub(crate) enum PanelProgrammingError {
    Transport {
        operation: IoOperation,
        packet: usize,
        source: ReportIoError,
    },
    RequiredFrameTimedOut {
        operation: IoOperation,
        packet: usize,
    },
    InvalidFrameLength {
        operation: IoOperation,
        packet: usize,
        expected: usize,
        actual: usize,
    },
    InvalidReportId {
        operation: IoOperation,
        packet: usize,
        expected: u8,
        actual: u8,
    },
    UnexpectedFrame {
        operation: IoOperation,
        packet: usize,
        profile: &'static str,
    },
    InvalidImageHeader {
        actual: [u8; 3],
    },
    InvalidImageLength(usize),
    UnsupportedProfileImageLength {
        profile: &'static str,
        expected: usize,
        actual: usize,
    },
    ImageLengthMismatch {
        current: usize,
        desired: usize,
    },
    InvalidKeyboardUsage(u8),
    UnknownTerminal(String),
    DuplicateEdit {
        terminal: String,
        plane: TerminalPlane,
    },
    StaleImage {
        expected_sha256: String,
        actual_sha256: String,
    },
    StaleRestoreTarget {
        expected_sha256: String,
        actual_sha256: String,
    },
    /// A caller-owned safety condition changed after the immutable backup was
    /// reopened but before packet zero.  The transaction stops without
    /// sending chart data.
    WriteGuardRefused {
        reason: String,
    },
    Backup(BackupError),
    VerificationFailed {
        backup: BackupId,
        expected_sha256: String,
        actual_sha256: String,
    },
    TransactionFailed {
        backup: BackupId,
        phase: TransactionPhase,
        source: Box<PanelProgrammingError>,
    },
}

impl fmt::Display for PanelProgrammingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transport {
                operation,
                packet,
                source,
            } => write!(f, "{operation} packet {packet} failed: {source}"),
            Self::RequiredFrameTimedOut { operation, packet } => {
                write!(f, "{operation} packet {packet} timed out")
            }
            Self::InvalidFrameLength {
                operation,
                packet,
                expected,
                actual,
            } => write!(
                f,
                "{operation} packet {packet} was {actual} bytes; expected {expected}"
            ),
            Self::InvalidReportId {
                operation,
                packet,
                expected,
                actual,
            } => write!(
                f,
                "{operation} packet {packet} carried report id {actual:#04x}; expected {expected:#04x}"
            ),
            Self::UnexpectedFrame {
                operation,
                packet,
                profile,
            } => write!(
                f,
                "{operation} packet {packet} exceeds the exact 64-frame boundary for profile {profile}"
            ),
            Self::InvalidImageHeader { actual } => write!(
                f,
                "I-PAC chart readback header was {:02X} {:02X} {:02X}; expected 50 DD 56",
                actual[0], actual[1], actual[2]
            ),
            Self::InvalidImageLength(actual) => write!(
                f,
                "I-PAC 4 chart was {actual} bytes; only {IPAC4_IMAGE_BYTES} or {IPAC4_EXTENDED_IMAGE_BYTES} are supported"
            ),
            Self::UnsupportedProfileImageLength {
                profile,
                expected,
                actual,
            } => write!(
                f,
                "I-PAC profile {profile} requires exactly {expected} bytes; found {actual}"
            ),
            Self::ImageLengthMismatch { current, desired } => write!(
                f,
                "current I-PAC chart is {current} bytes but desired chart is {desired} bytes"
            ),
            Self::InvalidKeyboardUsage(usage) => {
                write!(f, "HID keyboard usage {usage:#04x} is not a regular supported key")
            }
            Self::UnknownTerminal(id) => write!(f, "unknown I-PAC 4 terminal '{id}'"),
            Self::DuplicateEdit { terminal, plane } => {
                write!(f, "terminal '{terminal}' has more than one {plane} edit")
            }
            Self::StaleImage {
                expected_sha256,
                actual_sha256,
            } => write!(
                f,
                "I-PAC chart changed after review (expected {expected_sha256}, found {actual_sha256})"
            ),
            Self::StaleRestoreTarget {
                expected_sha256,
                actual_sha256,
            } => write!(
                f,
                "I-PAC restore backup changed after review (expected {expected_sha256}, found {actual_sha256})"
            ),
            Self::WriteGuardRefused { reason } => {
                write!(f, "I-PAC write guard refused before packet zero: {reason}")
            }
            Self::Backup(source) => write!(f, "panel backup failed: {source}"),
            Self::VerificationFailed {
                backup,
                expected_sha256,
                actual_sha256,
            } => write!(
                f,
                "I-PAC write did not verify (expected {expected_sha256}, read {actual_sha256}); restore backup {backup}"
            ),
            Self::TransactionFailed {
                backup,
                phase,
                source,
            } => write!(
                f,
                "I-PAC {phase} failed after backup {backup}: {source}"
            ),
        }
    }
}

impl std::error::Error for PanelProgrammingError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Transport { source, .. } => Some(source),
            Self::Backup(source) => Some(source),
            Self::TransactionFailed { source, .. } => Some(source.as_ref()),
            _ => None,
        }
    }
}

impl From<BackupError> for PanelProgrammingError {
    fn from(value: BackupError) -> Self {
        Self::Backup(value)
    }
}

/// A complete chart snapshot.  Construction validates the only two lengths
/// observed by the protocol; callers cannot mutate bytes in place or let the
/// cached identity hash drift.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RawPanelImage {
    bytes: Vec<u8>,
    sha256: String,
}

impl RawPanelImage {
    pub fn new(bytes: Vec<u8>) -> Result<Self, PanelProgrammingError> {
        if !matches!(bytes.len(), IPAC4_IMAGE_BYTES | IPAC4_EXTENDED_IMAGE_BYTES) {
            return Err(PanelProgrammingError::InvalidImageLength(bytes.len()));
        }
        if bytes[..3] != IPAC4_READBACK_HEADER {
            return Err(PanelProgrammingError::InvalidImageHeader {
                actual: [bytes[0], bytes[1], bytes[2]],
            });
        }
        let sha256 = sha256_hex(&bytes);
        Ok(Self { bytes, sha256 })
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    pub fn sha256(&self) -> &str {
        &self.sha256
    }

    fn with_replaced_bytes(&self, bytes: Vec<u8>) -> Self {
        // A HARD assert, not `debug_assert_eq!`. Every read in
        // `decode_ipac4_terminals` and `plan_between` is an unchecked index
        // up to offset 195, safe only because `RawPanelImage::new` refuses
        // any length but 256 or 260. This constructor bypasses `new`, and a
        // `debug_assert` compiles out of the binary ksx ships — leaving the
        // one path that can build a structurally invalid image, whose
        // failure mode is an out-of-bounds panic inside a parser handling
        // device bytes. It costs nothing on a path that already hashes 256.
        assert_eq!(
            bytes.len(),
            self.bytes.len(),
            "a replaced chart image must keep its admitted length"
        );
        let sha256 = sha256_hex(&bytes);
        Self { bytes, sha256 }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex_upper(&hasher.finish())
}

/// Read the `ipac4-pac256-v1` chart and prove its boundary.
///
/// The supported profile is exactly 64 report-03 frames.  After those 256
/// payload bytes, KSX waits one full frame deadline and refuses any 65th
/// report.  That deliberate latency prevents a newer/longer firmware image
/// from being silently truncated and later overwritten as a PAC256 chart.
pub(crate) fn read_ipac4_image(
    io: &mut impl PanelReportIo,
) -> Result<RawPanelImage, PanelProgrammingError> {
    read_ipac4_image_for(io, IoOperation::Query, IoOperation::Read)
}

fn read_ipac4_image_for(
    io: &mut impl PanelReportIo,
    query_operation: IoOperation,
    read_operation: IoOperation,
) -> Result<RawPanelImage, PanelProgrammingError> {
    io.send_report(&IPAC4_QUERY)
        .map_err(|source| PanelProgrammingError::Transport {
            operation: query_operation,
            packet: 0,
            source,
        })?;

    let mut bytes = Vec::with_capacity(IPAC4_IMAGE_BYTES);
    for packet in 0..IPAC4_REQUIRED_FRAMES {
        let frame = io
            .receive_report(REQUIRED_FRAME_TIMEOUT)
            .map_err(|source| PanelProgrammingError::Transport {
                operation: read_operation,
                packet,
                source,
            })?
            .ok_or(PanelProgrammingError::RequiredFrameTimedOut {
                operation: read_operation,
                packet,
            })?;
        append_frame(&mut bytes, &frame, read_operation, packet)?;
    }

    if io
        .receive_report(REQUIRED_FRAME_TIMEOUT)
        .map_err(|source| PanelProgrammingError::Transport {
            operation: read_operation,
            packet: IPAC4_REQUIRED_FRAMES,
            source,
        })?
        .is_some()
    {
        return Err(PanelProgrammingError::UnexpectedFrame {
            operation: read_operation,
            packet: IPAC4_REQUIRED_FRAMES,
            profile: IPAC4_PROTOCOL_PROFILE,
        });
    }

    RawPanelImage::new(bytes)
}

fn append_frame(
    bytes: &mut Vec<u8>,
    frame: &[u8],
    operation: IoOperation,
    packet: usize,
) -> Result<(), PanelProgrammingError> {
    if frame.len() != IPAC4_REPORT_BYTES {
        return Err(PanelProgrammingError::InvalidFrameLength {
            operation,
            packet,
            expected: IPAC4_REPORT_BYTES,
            actual: frame.len(),
        });
    }
    if frame[0] != IPAC4_REPORT_ID {
        return Err(PanelProgrammingError::InvalidReportId {
            operation,
            packet,
            expected: IPAC4_REPORT_ID,
            actual: frame[0],
        });
    }
    bytes.extend_from_slice(&frame[1..]);
    Ok(())
}

pub(crate) fn write_ipac4_image(
    io: &mut impl PanelReportIo,
    image: &RawPanelImage,
) -> Result<(), PanelProgrammingError> {
    require_pac256_image(image)?;
    // The persistent image is read back with firmware/release byte 0x56 in
    // header byte three. The programming command requires 0x0F in that byte;
    // the remaining 253 bytes are the reviewed logical image. QtPyUltimarc's
    // I-PAC4 writer performs this same readback-to-command conversion.
    let mut command = image.bytes().to_vec();
    command[..3].copy_from_slice(&IPAC4_WRITE_HEADER);
    for (packet, chunk) in command.chunks_exact(4).enumerate() {
        let report = [IPAC4_REPORT_ID, chunk[0], chunk[1], chunk[2], chunk[3]];
        io.send_report(&report)
            .map_err(|source| PanelProgrammingError::Transport {
                operation: IoOperation::Write,
                packet,
                source,
            })?;
    }
    Ok(())
}

fn require_pac256_image(image: &RawPanelImage) -> Result<(), PanelProgrammingError> {
    if image.len() == IPAC4_IMAGE_BYTES {
        Ok(())
    } else {
        Err(PanelProgrammingError::UnsupportedProfileImageLength {
            profile: IPAC4_PROTOCOL_PROFILE,
            expected: IPAC4_IMAGE_BYTES,
            actual: image.len(),
        })
    }
}

/// A regular Keyboard/Keypad-page usage that the post-2015 chart can encode.
/// Printable/function/keypad usages retain their HID value.  The eight HID
/// modifier usages are compacted into the chart's `0x70..=0x77` range.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct KeyboardUsage(u8);

impl KeyboardUsage {
    pub fn new(usage: u8) -> Result<Self, PanelProgrammingError> {
        if (0x04..=0x67).contains(&usage) || (0xE0..=0xE7).contains(&usage) {
            Ok(Self(usage))
        } else {
            Err(PanelProgrammingError::InvalidKeyboardUsage(usage))
        }
    }

    pub const fn hid_usage(self) -> u8 {
        self.0
    }

    pub const fn encode(self) -> u8 {
        if self.0 >= 0xE0 {
            0x70 + (self.0 - 0xE0)
        } else {
            self.0
        }
    }

    pub fn decode(wire: u8) -> Option<Self> {
        match wire {
            0x04..=0x67 => Some(Self(wire)),
            0x70..=0x77 => Some(Self(0xE0 + (wire - 0x70))),
            _ => None,
        }
    }
}

impl fmt::Display for KeyboardUsage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "HID 0x{:02X}", self.0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum TerminalPlane {
    Normal,
    Alternate,
    Shift,
}

impl TerminalPlane {
    const fn payload_delta(self) -> usize {
        match self {
            Self::Normal => 0,
            Self::Alternate => 64,
            Self::Shift => 128,
        }
    }

    const fn rank(self) -> u8 {
        match self {
            Self::Normal => 0,
            Self::Alternate => 1,
            Self::Shift => 2,
        }
    }
}

impl fmt::Display for TerminalPlane {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Normal => "normal",
            Self::Alternate => "alternate",
            Self::Shift => "shift",
        })
    }
}

/// One physical switch input.  `base` is its slot in the normal 64-byte
/// plane.  Alternate and shift offsets are derived, never independently
/// entered, which rules out cross-plane table drift.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Ipac4Terminal {
    pub id: &'static str,
    pub player: u8,
    base: u8,
}

impl Ipac4Terminal {
    pub const fn payload_offset(self, plane: TerminalPlane) -> usize {
        self.base as usize + plane.payload_delta()
    }

    pub const fn image_offset(self, plane: TerminalPlane) -> usize {
        IPAC4_HEADER_BYTES + self.payload_offset(plane)
    }
}

macro_rules! terminal {
    ($id:literal, $player:literal, $base:literal) => {
        Ipac4Terminal {
            id: $id,
            player: $player,
            base: $base,
        }
    };
}

/// Physical/UI order: directions, eight action switches, Start and Coin for
/// each player.  The sparse base slots are the board's electrical channel
/// numbering; the other two planes are coherently `base + 64` and `base + 128`.
pub(crate) const IPAC4_TERMINALS: [Ipac4Terminal; IPAC4_TERMINAL_COUNT] = [
    terminal!("1up", 1, 15),
    terminal!("1down", 1, 13),
    terminal!("1left", 1, 17),
    terminal!("1right", 1, 19),
    terminal!("1sw1", 1, 11),
    terminal!("1sw2", 1, 9),
    terminal!("1sw3", 1, 31),
    terminal!("1sw4", 1, 29),
    terminal!("1sw5", 1, 27),
    terminal!("1sw6", 1, 52),
    terminal!("1sw7", 1, 63),
    terminal!("1sw8", 1, 55),
    terminal!("1start", 1, 61),
    terminal!("1coin", 1, 53),
    terminal!("2up", 2, 12),
    terminal!("2down", 2, 10),
    terminal!("2left", 2, 14),
    terminal!("2right", 2, 16),
    terminal!("2sw1", 2, 8),
    terminal!("2sw2", 2, 30),
    terminal!("2sw3", 2, 28),
    terminal!("2sw4", 2, 26),
    terminal!("2sw5", 2, 59),
    terminal!("2sw6", 2, 60),
    terminal!("2sw7", 2, 48),
    terminal!("2sw8", 2, 56),
    terminal!("2start", 2, 54),
    terminal!("2coin", 2, 62),
    terminal!("3up", 3, 47),
    terminal!("3down", 3, 37),
    terminal!("3left", 3, 39),
    terminal!("3right", 3, 46),
    terminal!("3sw1", 3, 35),
    terminal!("3sw2", 3, 33),
    terminal!("3sw3", 3, 7),
    terminal!("3sw4", 3, 5),
    terminal!("3sw5", 3, 3),
    terminal!("3sw6", 3, 1),
    terminal!("3sw7", 3, 49),
    terminal!("3sw8", 3, 57),
    terminal!("3start", 3, 23),
    terminal!("3coin", 3, 21),
    terminal!("4up", 4, 36),
    terminal!("4down", 4, 34),
    terminal!("4left", 4, 44),
    terminal!("4right", 4, 38),
    terminal!("4sw1", 4, 32),
    terminal!("4sw2", 4, 6),
    terminal!("4sw3", 4, 4),
    terminal!("4sw4", 4, 2),
    terminal!("4sw5", 4, 0),
    terminal!("4sw6", 4, 22),
    terminal!("4sw7", 4, 58),
    terminal!("4sw8", 4, 50),
    terminal!("4start", 4, 20),
    terminal!("4coin", 4, 18),
];

pub(crate) fn ipac4_terminal(id: &str) -> Option<Ipac4Terminal> {
    IPAC4_TERMINALS
        .iter()
        .copied()
        .find(|terminal| terminal.id.eq_ignore_ascii_case(id))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TerminalAction {
    Unassigned,
    Keyboard(KeyboardUsage),
    Opaque(u8),
}

impl TerminalAction {
    fn decode(raw: u8) -> Self {
        if raw == 0 {
            Self::Unassigned
        } else if let Some(usage) = KeyboardUsage::decode(raw) {
            Self::Keyboard(usage)
        } else {
            Self::Opaque(raw)
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SemanticValue {
    Action(TerminalAction),
    ShiftDisabled,
    ShiftEnabled,
    ShiftOpaque(u8),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Ipac4TerminalState {
    pub terminal: Ipac4Terminal,
    pub normal_raw: u8,
    pub normal: TerminalAction,
    pub alternate_raw: u8,
    pub alternate: TerminalAction,
    pub shift_raw: u8,
    pub shift: SemanticValue,
}

/// Decode all 56 semantic terminal rows while retaining each original byte.
/// Unknown firmware actions remain [`TerminalAction::Opaque`] rather than
/// being discarded or normalized.
pub(crate) fn decode_ipac4_terminals(image: &RawPanelImage) -> Vec<Ipac4TerminalState> {
    IPAC4_TERMINALS
        .iter()
        .copied()
        .map(|terminal| {
            let normal_raw = image.bytes()[terminal.image_offset(TerminalPlane::Normal)];
            let alternate_raw = image.bytes()[terminal.image_offset(TerminalPlane::Alternate)];
            let shift_raw = image.bytes()[terminal.image_offset(TerminalPlane::Shift)];
            Ipac4TerminalState {
                terminal,
                normal_raw,
                normal: TerminalAction::decode(normal_raw),
                alternate_raw,
                alternate: TerminalAction::decode(alternate_raw),
                shift_raw,
                shift: semantic_value(TerminalPlane::Shift, shift_raw),
            }
        })
        .collect()
}

fn semantic_value(plane: TerminalPlane, raw: u8) -> SemanticValue {
    match plane {
        TerminalPlane::Normal | TerminalPlane::Alternate => {
            SemanticValue::Action(TerminalAction::decode(raw))
        }
        TerminalPlane::Shift => match raw {
            0x01 => SemanticValue::ShiftDisabled,
            0x41 => SemanticValue::ShiftEnabled,
            other => SemanticValue::ShiftOpaque(other),
        },
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum TerminalEdit {
    Normal {
        terminal: String,
        usage: Option<KeyboardUsage>,
    },
    Alternate {
        terminal: String,
        usage: Option<KeyboardUsage>,
    },
    Shift {
        terminal: String,
        enabled: bool,
    },
}

impl TerminalEdit {
    pub fn normal(terminal: impl Into<String>, usage: Option<KeyboardUsage>) -> Self {
        Self::Normal {
            terminal: terminal.into(),
            usage,
        }
    }

    pub fn alternate(terminal: impl Into<String>, usage: Option<KeyboardUsage>) -> Self {
        Self::Alternate {
            terminal: terminal.into(),
            usage,
        }
    }

    pub fn shift(terminal: impl Into<String>, enabled: bool) -> Self {
        Self::Shift {
            terminal: terminal.into(),
            enabled,
        }
    }

    fn terminal_id(&self) -> &str {
        match self {
            Self::Normal { terminal, .. }
            | Self::Alternate { terminal, .. }
            | Self::Shift { terminal, .. } => terminal,
        }
    }

    fn plane(&self) -> TerminalPlane {
        match self {
            Self::Normal { .. } => TerminalPlane::Normal,
            Self::Alternate { .. } => TerminalPlane::Alternate,
            Self::Shift { .. } => TerminalPlane::Shift,
        }
    }

    fn encoded_value(&self) -> u8 {
        match self {
            Self::Normal { usage, .. } | Self::Alternate { usage, .. } => {
                usage.map(KeyboardUsage::encode).unwrap_or(0)
            }
            Self::Shift { enabled, .. } => {
                if *enabled {
                    0x41
                } else {
                    0x01
                }
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SemanticDiff {
    pub terminal: &'static str,
    pub plane: TerminalPlane,
    pub before: SemanticValue,
    pub after: SemanticValue,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ByteDiff {
    pub offset: usize,
    pub before: u8,
    pub after: u8,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PanelProgramPlan {
    pub baseline_sha256: String,
    pub desired_sha256: String,
    pub desired: RawPanelImage,
    pub semantic_diff: Vec<SemanticDiff>,
    pub byte_diff: Vec<ByteDiff>,
}

impl PanelProgramPlan {
    pub fn is_noop(&self) -> bool {
        self.byte_diff.is_empty()
    }
}

pub(crate) fn plan_program(
    baseline: &RawPanelImage,
    edits: &[TerminalEdit],
) -> Result<PanelProgramPlan, PanelProgrammingError> {
    let mut resolved = Vec::with_capacity(edits.len());
    let mut occupied = BTreeSet::new();

    for edit in edits {
        let terminal = ipac4_terminal(edit.terminal_id())
            .ok_or_else(|| PanelProgrammingError::UnknownTerminal(edit.terminal_id().to_owned()))?;
        let plane = edit.plane();
        let key = (terminal.image_offset(plane), plane.rank());
        if !occupied.insert(key) {
            return Err(PanelProgrammingError::DuplicateEdit {
                terminal: terminal.id.to_owned(),
                plane,
            });
        }
        resolved.push((terminal, plane, edit.encoded_value()));
    }

    resolved.sort_by_key(|(terminal, plane, _)| (terminal.image_offset(*plane), plane.rank()));
    let mut bytes = baseline.bytes.clone();
    for (terminal, plane, value) in resolved {
        bytes[terminal.image_offset(plane)] = value;
    }
    let desired = baseline.with_replaced_bytes(bytes);
    Ok(plan_between(baseline, desired))
}

pub(crate) fn plan_restore(
    current: &RawPanelImage,
    backup: &RawPanelImage,
) -> Result<PanelProgramPlan, PanelProgrammingError> {
    if current.len() != backup.len() {
        return Err(PanelProgrammingError::ImageLengthMismatch {
            current: current.len(),
            desired: backup.len(),
        });
    }
    Ok(plan_between(current, backup.clone()))
}

fn plan_between(baseline: &RawPanelImage, desired: RawPanelImage) -> PanelProgramPlan {
    let byte_diff = baseline
        .bytes()
        .iter()
        .zip(desired.bytes())
        .enumerate()
        .filter_map(|(offset, (&before, &after))| {
            (before != after).then_some(ByteDiff {
                offset,
                before,
                after,
            })
        })
        .collect();

    let mut semantic_diff = Vec::new();
    for terminal in IPAC4_TERMINALS {
        for plane in [
            TerminalPlane::Normal,
            TerminalPlane::Alternate,
            TerminalPlane::Shift,
        ] {
            let offset = terminal.image_offset(plane);
            let before = baseline.bytes()[offset];
            let after = desired.bytes()[offset];
            if before != after {
                semantic_diff.push(SemanticDiff {
                    terminal: terminal.id,
                    plane,
                    before: semantic_value(plane, before),
                    after: semantic_value(plane, after),
                });
            }
        }
    }

    PanelProgramPlan {
        baseline_sha256: baseline.sha256.clone(),
        desired_sha256: desired.sha256.clone(),
        desired,
        semantic_diff,
        byte_diff,
    }
}

/// A deterministic, duplicate-free `ipac4-pac256-v1` chart.
///
/// Every physical terminal receives a normal key and every alternate
/// assignment is cleared. Known-enabled shift roles are disabled by
/// [`canonical_four_player_edits_for_image`]; opaque shift bytes are never
/// normalized. The pool deliberately avoids Escape, Enter, Backspace, Tab,
/// Space, navigation and modifiers. It uses 56
/// distinct keys KSX can actually observe: 26 letters, 10 digits, 10
/// punctuation keys and F1-F10. HID usages 0x31 and 0x32 intentionally do not
/// both appear because they collapse to the same KSX `BackslashPipe` key.
/// Bytes outside the three terminal planes (including onboard macros and
/// opaque vendor state) are never addressed by these edits and remain intact.
pub(crate) fn canonical_four_player_edits() -> Vec<TerminalEdit> {
    let mut pool: Vec<u8> = (0x04..=0x27).collect();
    pool.extend([0x2D, 0x2E, 0x2F, 0x30, 0x31, 0x33, 0x34, 0x35, 0x36, 0x37]);
    pool.extend(0x3A..=0x43);
    debug_assert_eq!(pool.len(), IPAC4_TERMINAL_COUNT);

    let mut edits = Vec::with_capacity(IPAC4_TERMINAL_COUNT * 2);
    for (terminal, usage) in IPAC4_TERMINALS.iter().zip(pool) {
        edits.extend([
            TerminalEdit::normal(
                terminal.id,
                Some(KeyboardUsage::new(usage).expect("canonical usages are regular keys")),
            ),
            TerminalEdit::alternate(terminal.id, None),
        ]);
    }
    edits
}

pub(crate) fn canonical_four_player_edits_for_image(image: &RawPanelImage) -> Vec<TerminalEdit> {
    with_known_enabled_shifts_disabled(canonical_four_player_edits(), image)
}

/// A clean semantic chart for first-time wiring and explicit Clear hardware.
///
/// Every modeled action plane is reset: no normal key and no shifted key.
/// Shift bytes are baseline-sensitive and are handled by
/// [`blank_edits_for_image`], because an opaque shift value is vendor state,
/// not permission to normalize that byte. Header bytes, onboard macros and all
/// other vendor-owned offsets remain byte-for-byte from the baseline image.
pub(crate) fn blank_edits() -> Vec<TerminalEdit> {
    let mut edits = Vec::with_capacity(IPAC4_TERMINAL_COUNT * 2);
    for terminal in IPAC4_TERMINALS {
        edits.extend([
            TerminalEdit::normal(terminal.id, None),
            TerminalEdit::alternate(terminal.id, None),
        ]);
    }
    edits
}

/// Complete the blank layout against the chart being reviewed. Only a byte
/// decoded exactly as ShiftEnabled (0x41) is changed to ShiftDisabled (0x01).
/// Opaque shift bytes survive exactly, including values observed on live
/// I-PAC4 terminals that WinIPAC does not expose semantically.
pub(crate) fn blank_edits_for_image(image: &RawPanelImage) -> Vec<TerminalEdit> {
    with_known_enabled_shifts_disabled(blank_edits(), image)
}

fn with_known_enabled_shifts_disabled(
    mut edits: Vec<TerminalEdit>,
    image: &RawPanelImage,
) -> Vec<TerminalEdit> {
    edits.extend(
        decode_ipac4_terminals(image)
            .into_iter()
            .filter(|state| state.shift == SemanticValue::ShiftEnabled)
            .map(|state| TerminalEdit::shift(state.terminal.id, false)),
    );
    edits
}

/// Identity of the exact ordered terminal model portable panel layouts use.
///
/// This is intentionally distinct from the USB/protocol profile: firmware can
/// retain the same 256-byte transport while assigning different physical
/// channels. A saved semantic layout is portable only when this signature is
/// identical.
pub(crate) fn ipac4_terminal_signature() -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"ksx.ipac4-terminals.v1\0");
    for terminal in IPAC4_TERMINALS {
        hasher.update(terminal.id.as_bytes());
        hasher.update(&[0, terminal.player, terminal.base]);
        for plane in [
            TerminalPlane::Normal,
            TerminalPlane::Alternate,
            TerminalPlane::Shift,
        ] {
            hasher.update(&(terminal.image_offset(plane) as u16).to_le_bytes());
        }
    }
    format!("ipac4-56-v1-{}", hex_upper(&hasher.finish()))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BoardIdentity {
    pub driver: String,
    pub vid: u16,
    pub pid: u16,
    pub bcd_device: u16,
    pub serial: Option<String>,
    pub fingerprint: String,
}

impl BoardIdentity {
    #[cfg(test)]
    pub fn ipac4(bcd_device: u16, serial: Option<String>, fingerprint: impl Into<String>) -> Self {
        Self {
            driver: IPAC4_DRIVER.to_owned(),
            vid: 0xD209,
            pid: 0x0430,
            bcd_device,
            serial,
            fingerprint: fingerprint.into(),
        }
    }

    fn compatible_with(&self, other: &Self) -> bool {
        if !self.driver.eq_ignore_ascii_case(&other.driver)
            || self.vid != other.vid
            || self.pid != other.pid
            || self.bcd_device != other.bcd_device
            || self.fingerprint != other.fingerprint
        {
            return false;
        }
        match (&self.serial, &other.serial) {
            (Some(left), Some(right)) => left == right,
            (None, None) => true,
            _ => false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BackupReason {
    InitialCapture,
    Manual,
    BeforeProgram,
    BeforeRestore,
}

impl BackupReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::InitialCapture => "initial_capture",
            Self::Manual => "manual",
            Self::BeforeProgram => "before_program",
            Self::BeforeRestore => "before_restore",
        }
    }

    fn parse(value: &str) -> Result<Self, BackupError> {
        match value {
            "initial_capture" => Ok(Self::InitialCapture),
            "manual" => Ok(Self::Manual),
            "before_program" => Ok(Self::BeforeProgram),
            "before_restore" => Ok(Self::BeforeRestore),
            other => Err(BackupError::InvalidDocument(format!(
                "unknown backup reason '{other}'"
            ))),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct BackupId(String);

impl BackupId {
    pub fn new(value: impl Into<String>) -> Result<Self, BackupError> {
        let value = value.into();
        let mut components = Path::new(&value).components();
        let safe = matches!(components.next(), Some(Component::Normal(_)))
            && components.next().is_none()
            && value.ends_with(BACKUP_EXTENSION);
        if !safe {
            return Err(BackupError::UnsafeBackupId(value));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for BackupId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StoredBackup {
    pub id: BackupId,
    pub path: PathBuf,
    pub created_at: String,
    pub image_sha256: String,
    pub image_len: usize,
    pub reason: BackupReason,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LoadedBackup {
    pub stored: StoredBackup,
    pub identity: BoardIdentity,
    pub image: RawPanelImage,
}

#[derive(Debug)]
pub(crate) enum BackupError {
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    Json {
        path: PathBuf,
        source: serde_json::Error,
    },
    InvalidDocument(String),
    UnsafeBackupId(String),
    HashMismatch {
        recorded: String,
        actual: String,
    },
    IncompatibleBoard {
        expected: Box<BoardIdentity>,
        backup: Box<BoardIdentity>,
    },
    NameExhausted(PathBuf),
}

impl fmt::Display for BackupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { path, source } => write!(f, "{}: {source}", path.display()),
            Self::Json { path, source } => {
                write!(f, "{} is not valid backup JSON: {source}", path.display())
            }
            Self::InvalidDocument(message) => f.write_str(message),
            Self::UnsafeBackupId(id) => write!(f, "unsafe panel backup id '{id}'"),
            Self::HashMismatch { recorded, actual } => write!(
                f,
                "panel backup hash mismatch (recorded {recorded}, actual {actual})"
            ),
            Self::IncompatibleBoard { expected, backup } => write!(
                f,
                "backup belongs to {:04x}:{:04x} '{}' rather than selected {:04x}:{:04x} '{}'",
                backup.vid,
                backup.pid,
                backup.fingerprint,
                expected.vid,
                expected.pid,
                expected.fingerprint
            ),
            Self::NameExhausted(path) => write!(
                f,
                "could not allocate an immutable backup name beneath {}",
                path.display()
            ),
        }
    }
}

impl std::error::Error for BackupError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Json { source, .. } => Some(source),
            _ => None,
        }
    }
}

/// Backup seam used by the transaction core.  The filesystem implementation
/// is [`BackupStore`]; tests and future encrypted stores can substitute one
/// without weakening the transaction order.
pub(crate) trait PanelBackupRepository {
    fn save_immutable(
        &mut self,
        identity: &BoardIdentity,
        image: &RawPanelImage,
        timestamp: Timestamp,
        reason: BackupReason,
    ) -> Result<StoredBackup, BackupError>;

    fn load_verified(
        &mut self,
        identity: &BoardIdentity,
        id: &BackupId,
    ) -> Result<LoadedBackup, BackupError>;
}

#[derive(Clone, Debug)]
pub(crate) struct BackupStore {
    root: PathBuf,
}

impl BackupStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn board_dir(&self, identity: &BoardIdentity) -> PathBuf {
        self.root
            .join(sanitize_component(&identity.driver))
            .join(sanitize_component(&identity.fingerprint))
    }

    /// Newest first.  A corrupt file is reported instead of silently omitted;
    /// hiding a broken escape route would make the restore screen dishonest.
    pub fn list_verified(
        &self,
        identity: &BoardIdentity,
    ) -> Result<Vec<StoredBackup>, BackupError> {
        let dir = self.board_dir(identity);
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(source) => return Err(BackupError::Io { path: dir, source }),
        };
        let mut backups = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|source| BackupError::Io {
                path: dir.clone(),
                source,
            })?;
            if !entry
                .file_type()
                .map_err(|source| BackupError::Io {
                    path: entry.path(),
                    source,
                })?
                .is_file()
            {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !name.ends_with(BACKUP_EXTENSION) {
                continue;
            }
            let id = BackupId::new(name)?;
            backups.push(self.load_path(identity, &id)?.stored);
        }
        backups.sort_by(|left, right| {
            backup_timestamp_key(&right.id)
                .cmp(backup_timestamp_key(&left.id))
                .then_with(|| {
                    backup_collision_rank(&right.id).cmp(&backup_collision_rank(&left.id))
                })
                .then_with(|| right.id.cmp(&left.id))
        });
        Ok(backups)
    }

    fn load_path(
        &self,
        expected_identity: &BoardIdentity,
        id: &BackupId,
    ) -> Result<LoadedBackup, BackupError> {
        let path = self.board_dir(expected_identity).join(id.as_str());
        let raw = fs::read(&path).map_err(|source| BackupError::Io {
            path: path.clone(),
            source,
        })?;
        let document: serde_json::Value =
            serde_json::from_slice(&raw).map_err(|source| BackupError::Json {
                path: path.clone(),
                source,
            })?;

        if json_str(&document, "/schema")? != BACKUP_SCHEMA {
            return Err(BackupError::InvalidDocument(
                "unsupported panel backup schema".to_owned(),
            ));
        }
        validate_backup_contract(&document)?;

        let identity = BoardIdentity {
            driver: json_str(&document, "/driver")?.to_owned(),
            vid: json_u16(&document, "/device/vid")?,
            pid: json_u16(&document, "/device/pid")?,
            bcd_device: json_u16(&document, "/device/bcd_device")?,
            serial: json_optional_str(&document, "/device/serial")?.map(str::to_owned),
            fingerprint: json_str(&document, "/device/fingerprint")?.to_owned(),
        };
        if !expected_identity.compatible_with(&identity) {
            return Err(BackupError::IncompatibleBoard {
                expected: Box::new(expected_identity.clone()),
                backup: Box::new(identity),
            });
        }

        let reason = BackupReason::parse(json_str(&document, "/reason")?)?;
        let created_at = json_str(&document, "/created_at")?.to_owned();
        let recorded_len = json_usize(&document, "/image/length")?;
        let recorded_hash = json_str(&document, "/image/sha256")?.to_owned();
        let bytes = decode_hex(json_str(&document, "/image/data")?)?;
        if bytes.len() != recorded_len {
            return Err(BackupError::InvalidDocument(format!(
                "panel backup records {recorded_len} bytes but contains {}",
                bytes.len()
            )));
        }
        let actual_hash = sha256_hex(&bytes);
        if !recorded_hash.eq_ignore_ascii_case(&actual_hash) {
            return Err(BackupError::HashMismatch {
                recorded: recorded_hash,
                actual: actual_hash,
            });
        }
        let image = RawPanelImage::new(bytes)
            .map_err(|error| BackupError::InvalidDocument(error.to_string()))?;

        Ok(LoadedBackup {
            stored: StoredBackup {
                id: id.clone(),
                path,
                created_at,
                image_sha256: image.sha256().to_owned(),
                image_len: image.len(),
                reason,
            },
            identity,
            image,
        })
    }
}

impl PanelBackupRepository for BackupStore {
    fn save_immutable(
        &mut self,
        identity: &BoardIdentity,
        image: &RawPanelImage,
        timestamp: Timestamp,
        reason: BackupReason,
    ) -> Result<StoredBackup, BackupError> {
        validate_pac256_backup_identity(identity)?;
        validate_pac256_backup_image(image)?;
        let dir = self.board_dir(identity);
        fs::create_dir_all(&dir).map_err(|source| BackupError::Io {
            path: dir.clone(),
            source,
        })?;

        let document = serde_json::json!({
            "schema": BACKUP_SCHEMA,
            "profile": IPAC4_PROTOCOL_PROFILE,
            "created_at": timestamp_rfc3339(timestamp),
            "reason": reason.as_str(),
            "driver": identity.driver,
            "driver_schema": IPAC4_DRIVER_SCHEMA,
            "device": {
                "vid": identity.vid,
                "pid": identity.pid,
                "bcd_device": identity.bcd_device,
                "serial": identity.serial,
                "fingerprint": identity.fingerprint,
            },
            "transport": {
                "collection_rule": IPAC4_COLLECTION_RULE,
                "report_id": IPAC4_REPORT_ID,
                "input_report_bytes": IPAC4_REPORT_BYTES,
                "output_report_bytes": IPAC4_REPORT_BYTES,
            },
            "image": {
                "encoding": "hex",
                "length": image.len(),
                "sha256": image.sha256(),
                "data": encode_hex(image.bytes()),
            },
        });
        let mut rendered =
            serde_json::to_vec_pretty(&document).map_err(|source| BackupError::Json {
                path: dir.clone(),
                source,
            })?;
        rendered.push(b'\n');

        let tmp = create_temp_backup(&dir)?;
        let write_result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&tmp)
                .map_err(|source| BackupError::Io {
                    path: tmp.clone(),
                    source,
                })?;
            file.write_all(&rendered)
                .and_then(|_| file.sync_all())
                .map_err(|source| BackupError::Io {
                    path: tmp.clone(),
                    source,
                })
        })();
        if let Err(error) = write_result {
            let _ = fs::remove_file(&tmp);
            return Err(error);
        }

        let stem = format!(
            "{}-{}",
            timestamp.backup_suffix(),
            image.sha256()[..12].to_ascii_lowercase()
        );
        let mut linked = None;
        for collision in 1..=10_000usize {
            let suffix = if collision == 1 {
                String::new()
            } else {
                format!("-{collision}")
            };
            let file_name = format!("{stem}{suffix}{BACKUP_EXTENSION}");
            let candidate = dir.join(&file_name);
            match finalize_backup_no_replace(&tmp, &candidate) {
                Ok(()) => {
                    linked = Some((file_name, candidate));
                    break;
                }
                Err(source) if is_backup_name_collision(&source) => continue,
                Err(source) => {
                    let _ = fs::remove_file(&tmp);
                    return Err(BackupError::Io {
                        path: candidate,
                        source,
                    });
                }
            }
        }
        let _ = fs::remove_file(&tmp);
        let Some((file_name, path)) = linked else {
            return Err(BackupError::NameExhausted(dir));
        };
        sync_parent_directory(&path)?;

        Ok(StoredBackup {
            id: BackupId::new(file_name)?,
            path,
            created_at: timestamp_rfc3339(timestamp),
            image_sha256: image.sha256().to_owned(),
            image_len: image.len(),
            reason,
        })
    }

    fn load_verified(
        &mut self,
        identity: &BoardIdentity,
        id: &BackupId,
    ) -> Result<LoadedBackup, BackupError> {
        self.load_path(identity, id)
    }
}

fn create_temp_backup(dir: &Path) -> Result<PathBuf, BackupError> {
    for nonce in 0..10_000usize {
        let path = dir.join(format!(".panel-backup.tmp-{}-{nonce}", std::process::id()));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => {
                drop(file);
                return Ok(path);
            }
            Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(source) => return Err(BackupError::Io { path, source }),
        }
    }
    Err(BackupError::NameExhausted(dir.to_owned()))
}

fn is_backup_name_collision(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::AlreadyExists
        // Windows distinguishes ERROR_FILE_EXISTS (80) from
        // ERROR_ALREADY_EXISTS (183); both mean that the immutable candidate
        // name must be retried with the next collision suffix.
        || matches!(error.raw_os_error(), Some(80 | 183))
}

#[cfg(windows)]
fn finalize_backup_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    let source: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: both paths are NUL-terminated Rust-owned buffers and remain
    // valid for the call.  Omitting MOVEFILE_REPLACE_EXISTING preserves the
    // immutable collision contract; WRITE_THROUGH makes the successful
    // directory entry durable before this function returns.
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn finalize_backup_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::hard_link(source, destination)
}

#[cfg(unix)]
fn sync_parent_directory(path: &Path) -> Result<(), BackupError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::File::open(parent)
        .and_then(|file| file.sync_all())
        .map_err(|source| BackupError::Io {
            path: parent.to_owned(),
            source,
        })
}

#[cfg(not(unix))]
fn sync_parent_directory(_path: &Path) -> Result<(), BackupError> {
    // Windows finalizes with no-replace MoveFileExW + WRITE_THROUGH above, so
    // the directory entry is already durable. Other non-Unix targets retain
    // the file-level sync performed before finalization.
    Ok(())
}

fn sanitize_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
            out.push(character.to_ascii_lowercase());
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('.').trim_matches('_');
    if trimmed.is_empty() {
        "unknown".to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn timestamp_rfc3339(timestamp: Timestamp) -> String {
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        timestamp.year,
        timestamp.month,
        timestamp.day,
        timestamp.hour,
        timestamp.minute,
        timestamp.second
    )
}

fn backup_timestamp_key(id: &BackupId) -> &str {
    id.as_str().get(..15).unwrap_or_default()
}

fn backup_collision_rank(id: &BackupId) -> usize {
    let stem = id
        .as_str()
        .strip_suffix(BACKUP_EXTENSION)
        .unwrap_or_default();
    stem.get(28..)
        .and_then(|suffix| suffix.strip_prefix('-'))
        .and_then(|suffix| suffix.parse().ok())
        .unwrap_or(1)
}

fn encode_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use fmt::Write as _;
        let _ = write!(out, "{byte:02X}");
    }
    out
}

fn decode_hex(value: &str) -> Result<Vec<u8>, BackupError> {
    if value.len() % 2 != 0 {
        return Err(BackupError::InvalidDocument(
            "panel backup image has odd-length hex".to_owned(),
        ));
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .enumerate()
        .map(|(index, pair)| {
            let pair = std::str::from_utf8(pair).map_err(|_| {
                BackupError::InvalidDocument(format!(
                    "panel backup image has invalid hex at byte {index}"
                ))
            })?;
            u8::from_str_radix(pair, 16).map_err(|_| {
                BackupError::InvalidDocument(format!(
                    "panel backup image has invalid hex at byte {index}"
                ))
            })
        })
        .collect()
}

fn validate_pac256_backup_identity(identity: &BoardIdentity) -> Result<(), BackupError> {
    if identity.driver != IPAC4_DRIVER
        || identity.vid != 0xD209
        || identity.pid != 0x0430
        || identity.bcd_device != IPAC4_BCD_DEVICE
    {
        return Err(BackupError::InvalidDocument(format!(
            "profile {IPAC4_PROTOCOL_PROFILE} requires driver {IPAC4_DRIVER} for d209:0430 release {IPAC4_BCD_DEVICE:04X}"
        )));
    }
    Ok(())
}

fn validate_pac256_backup_image(image: &RawPanelImage) -> Result<(), BackupError> {
    if image.len() != IPAC4_IMAGE_BYTES {
        return Err(BackupError::InvalidDocument(format!(
            "profile {IPAC4_PROTOCOL_PROFILE} requires a {IPAC4_IMAGE_BYTES}-byte image; found {}",
            image.len()
        )));
    }
    Ok(())
}

fn validate_backup_contract(document: &serde_json::Value) -> Result<(), BackupError> {
    if json_str(document, "/profile")? != IPAC4_PROTOCOL_PROFILE {
        return Err(BackupError::InvalidDocument(format!(
            "panel backup profile must be '{IPAC4_PROTOCOL_PROFILE}'"
        )));
    }
    if json_str(document, "/driver")? != IPAC4_DRIVER {
        return Err(BackupError::InvalidDocument(format!(
            "profile {IPAC4_PROTOCOL_PROFILE} requires driver '{IPAC4_DRIVER}'"
        )));
    }
    if json_usize(document, "/driver_schema")? != IPAC4_DRIVER_SCHEMA {
        return Err(BackupError::InvalidDocument(format!(
            "profile {IPAC4_PROTOCOL_PROFILE} requires driver schema {IPAC4_DRIVER_SCHEMA}"
        )));
    }
    if json_u16(document, "/device/vid")? != 0xD209
        || json_u16(document, "/device/pid")? != 0x0430
        || json_u16(document, "/device/bcd_device")? != IPAC4_BCD_DEVICE
    {
        return Err(BackupError::InvalidDocument(format!(
            "profile {IPAC4_PROTOCOL_PROFILE} requires device d209:0430 release {IPAC4_BCD_DEVICE:04X}"
        )));
    }
    if json_str(document, "/transport/collection_rule")? != IPAC4_COLLECTION_RULE
        || json_usize(document, "/transport/report_id")? != usize::from(IPAC4_REPORT_ID)
        || json_usize(document, "/transport/input_report_bytes")? != IPAC4_REPORT_BYTES
        || json_usize(document, "/transport/output_report_bytes")? != IPAC4_REPORT_BYTES
    {
        return Err(BackupError::InvalidDocument(format!(
            "profile {IPAC4_PROTOCOL_PROFILE} requires report 03 with exact 5-byte input/output framing"
        )));
    }
    if json_str(document, "/image/encoding")? != "hex" {
        return Err(BackupError::InvalidDocument(
            "panel backup image encoding must be 'hex'".to_owned(),
        ));
    }
    let image_len = json_usize(document, "/image/length")?;
    if image_len != IPAC4_IMAGE_BYTES {
        return Err(BackupError::InvalidDocument(format!(
            "profile {IPAC4_PROTOCOL_PROFILE} requires a {IPAC4_IMAGE_BYTES}-byte image; backup records {image_len}"
        )));
    }
    Ok(())
}

fn json_str<'a>(document: &'a serde_json::Value, pointer: &str) -> Result<&'a str, BackupError> {
    document
        .pointer(pointer)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| BackupError::InvalidDocument(format!("missing string at {pointer}")))
}

fn json_optional_str<'a>(
    document: &'a serde_json::Value,
    pointer: &str,
) -> Result<Option<&'a str>, BackupError> {
    match document.pointer(pointer) {
        Some(serde_json::Value::Null) => Ok(None),
        Some(value) => value
            .as_str()
            .map(Some)
            .ok_or_else(|| BackupError::InvalidDocument(format!("invalid string at {pointer}"))),
        None => Err(BackupError::InvalidDocument(format!(
            "missing value at {pointer}"
        ))),
    }
}

fn json_usize(document: &serde_json::Value, pointer: &str) -> Result<usize, BackupError> {
    let value = document
        .pointer(pointer)
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| BackupError::InvalidDocument(format!("missing integer at {pointer}")))?;
    usize::try_from(value)
        .map_err(|_| BackupError::InvalidDocument(format!("integer at {pointer} is too large")))
}

fn json_u16(document: &serde_json::Value, pointer: &str) -> Result<u16, BackupError> {
    let value = document
        .pointer(pointer)
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| BackupError::InvalidDocument(format!("missing integer at {pointer}")))?;
    u16::try_from(value)
        .map_err(|_| BackupError::InvalidDocument(format!("integer at {pointer} is not u16")))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TransactionPhase {
    Program,
    VerificationRead,
    Restore,
}

impl fmt::Display for TransactionPhase {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Program => "program",
            Self::VerificationRead => "verification read",
            Self::Restore => "restore",
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TransactionOutcome {
    pub wrote: bool,
    pub before_sha256: String,
    pub desired_sha256: String,
    pub verified_sha256: String,
    pub backup: Option<StoredBackup>,
    pub restored_from: Option<BackupId>,
    pub semantic_diff: Vec<SemanticDiff>,
    pub byte_diff: Vec<ByteDiff>,
}

fn check_baseline(
    image: &RawPanelImage,
    expected_sha256: &str,
) -> Result<(), PanelProgrammingError> {
    if image.sha256().eq_ignore_ascii_case(expected_sha256.trim()) {
        Ok(())
    } else {
        Err(PanelProgrammingError::StaleImage {
            expected_sha256: expected_sha256.trim().to_owned(),
            actual_sha256: image.sha256().to_owned(),
        })
    }
}

/// Re-read, stale-check, backup, program, and fully re-read/verify one plan.
/// The caller supplies the process/interprocess exclusion policy; this
/// function supplies the immutable transaction order.
#[cfg(test)]
pub(crate) fn apply_program(
    io: &mut impl PanelReportIo,
    backups: &mut impl PanelBackupRepository,
    identity: &BoardIdentity,
    expected_sha256: &str,
    edits: &[TerminalEdit],
    timestamp: Timestamp,
) -> Result<TransactionOutcome, PanelProgrammingError> {
    apply_program_guarded(
        io,
        backups,
        identity,
        expected_sha256,
        edits,
        timestamp,
        |_, _| Ok(()),
    )
}

/// The guarded transaction used by hardware-facing composition roots.
/// `before_write` runs after the lossless backup has been reopened and
/// compared, immediately before the first persistent chart packet.
pub(crate) fn apply_program_guarded(
    io: &mut impl PanelReportIo,
    backups: &mut impl PanelBackupRepository,
    identity: &BoardIdentity,
    expected_sha256: &str,
    edits: &[TerminalEdit],
    timestamp: Timestamp,
    before_write: impl FnOnce(&StoredBackup, &PanelProgramPlan) -> Result<(), PanelProgrammingError>,
) -> Result<TransactionOutcome, PanelProgrammingError> {
    let current = read_ipac4_image(io)?;
    require_pac256_image(&current)?;
    check_baseline(&current, expected_sha256)?;
    let plan = plan_program(&current, edits)?;
    require_pac256_image(&plan.desired)?;
    if plan.is_noop() {
        return Ok(noop_outcome(&plan, None));
    }

    let backup =
        backups.save_immutable(identity, &current, timestamp, BackupReason::BeforeProgram)?;
    verify_saved_backup(backups, identity, &backup, &current)?;
    before_write(&backup, &plan)?;
    write_ipac4_image(io, &plan.desired).map_err(|source| {
        transaction_failure(backup.id.clone(), TransactionPhase::Program, source)
    })?;
    let verified = read_ipac4_image_for(io, IoOperation::VerifyQuery, IoOperation::VerifyRead)
        .map_err(|source| {
            transaction_failure(
                backup.id.clone(),
                TransactionPhase::VerificationRead,
                source,
            )
        })?;
    if verified.bytes() != plan.desired.bytes() {
        return Err(PanelProgrammingError::VerificationFailed {
            backup: backup.id,
            expected_sha256: plan.desired_sha256,
            actual_sha256: verified.sha256().to_owned(),
        });
    }

    Ok(TransactionOutcome {
        wrote: true,
        before_sha256: plan.baseline_sha256,
        desired_sha256: plan.desired_sha256,
        verified_sha256: verified.sha256().to_owned(),
        backup: Some(backup),
        restored_from: None,
        semantic_diff: plan.semantic_diff,
        byte_diff: plan.byte_diff,
    })
}

/// Restore a verified lossless image.  The current state receives its own new
/// backup before the first restore packet, so restore remains reversible.
#[cfg(test)]
pub(crate) fn apply_restore(
    io: &mut impl PanelReportIo,
    backups: &mut impl PanelBackupRepository,
    identity: &BoardIdentity,
    backup_id: &BackupId,
    expected_current_sha256: &str,
    timestamp: Timestamp,
) -> Result<TransactionOutcome, PanelProgrammingError> {
    // Bind the guarded reload below to the exact verified backup image seen
    // here. A mutable/tampered repository cannot swap a different valid image
    // into the restore after this review boundary.
    let reviewed_target = backups.load_verified(identity, backup_id)?;
    let expected_desired_sha256 = reviewed_target.image.sha256().to_owned();
    apply_restore_guarded(
        io,
        backups,
        identity,
        backup_id,
        expected_current_sha256,
        &expected_desired_sha256,
        timestamp,
        |_, _| Ok(()),
    )
}

/// Restore variant with the same packet-zero safety hook as
/// [`apply_program_guarded`].
#[allow(clippy::too_many_arguments)] // Restore binds the reviewed target and a final packet-zero guard.
pub(crate) fn apply_restore_guarded(
    io: &mut impl PanelReportIo,
    backups: &mut impl PanelBackupRepository,
    identity: &BoardIdentity,
    backup_id: &BackupId,
    expected_current_sha256: &str,
    expected_desired_sha256: &str,
    timestamp: Timestamp,
    before_write: impl FnOnce(&StoredBackup, &PanelProgramPlan) -> Result<(), PanelProgrammingError>,
) -> Result<TransactionOutcome, PanelProgrammingError> {
    let target = backups.load_verified(identity, backup_id)?;
    require_pac256_image(&target.image)?;
    if !target
        .image
        .sha256()
        .eq_ignore_ascii_case(expected_desired_sha256.trim())
    {
        return Err(PanelProgrammingError::StaleRestoreTarget {
            expected_sha256: expected_desired_sha256.trim().to_owned(),
            actual_sha256: target.image.sha256().to_owned(),
        });
    }
    let current = read_ipac4_image(io)?;
    require_pac256_image(&current)?;
    check_baseline(&current, expected_current_sha256)?;
    let plan = plan_restore(&current, &target.image)?;
    require_pac256_image(&plan.desired)?;
    if plan.is_noop() {
        return Ok(noop_outcome(&plan, Some(backup_id.clone())));
    }

    let safety_backup =
        backups.save_immutable(identity, &current, timestamp, BackupReason::BeforeRestore)?;
    verify_saved_backup(backups, identity, &safety_backup, &current)?;
    before_write(&safety_backup, &plan)?;
    write_ipac4_image(io, &plan.desired).map_err(|source| {
        transaction_failure(safety_backup.id.clone(), TransactionPhase::Restore, source)
    })?;
    let verified = read_ipac4_image_for(io, IoOperation::VerifyQuery, IoOperation::VerifyRead)
        .map_err(|source| {
            transaction_failure(
                safety_backup.id.clone(),
                TransactionPhase::VerificationRead,
                source,
            )
        })?;
    if verified.bytes() != plan.desired.bytes() {
        return Err(PanelProgrammingError::VerificationFailed {
            backup: safety_backup.id,
            expected_sha256: plan.desired_sha256,
            actual_sha256: verified.sha256().to_owned(),
        });
    }

    Ok(TransactionOutcome {
        wrote: true,
        before_sha256: plan.baseline_sha256,
        desired_sha256: plan.desired_sha256,
        verified_sha256: verified.sha256().to_owned(),
        backup: Some(safety_backup),
        restored_from: Some(backup_id.clone()),
        semantic_diff: plan.semantic_diff,
        byte_diff: plan.byte_diff,
    })
}

fn noop_outcome(plan: &PanelProgramPlan, restored_from: Option<BackupId>) -> TransactionOutcome {
    TransactionOutcome {
        wrote: false,
        before_sha256: plan.baseline_sha256.clone(),
        desired_sha256: plan.desired_sha256.clone(),
        verified_sha256: plan.baseline_sha256.clone(),
        backup: None,
        restored_from,
        semantic_diff: plan.semantic_diff.clone(),
        byte_diff: plan.byte_diff.clone(),
    }
}

fn verify_saved_backup(
    backups: &mut impl PanelBackupRepository,
    identity: &BoardIdentity,
    stored: &StoredBackup,
    expected: &RawPanelImage,
) -> Result<(), PanelProgrammingError> {
    let reopened = backups.load_verified(identity, &stored.id)?;
    if reopened.image.bytes() != expected.bytes() {
        return Err(BackupError::HashMismatch {
            recorded: expected.sha256().to_owned(),
            actual: reopened.image.sha256().to_owned(),
        }
        .into());
    }
    Ok(())
}

fn transaction_failure(
    backup: BackupId,
    phase: TransactionPhase,
    source: PanelProgrammingError,
) -> PanelProgrammingError {
    PanelProgrammingError::TransactionFailed {
        backup,
        phase,
        source: Box::new(source),
    }
}

mod facade;
pub use facade::*;

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::{BTreeMap, BTreeSet, VecDeque};
    use std::rc::Rc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Default)]
    struct FakeIo {
        incoming: VecDeque<Result<Option<Vec<u8>>, ReportIoError>>,
        sent: Vec<Vec<u8>>,
        receive_timeouts: Vec<Duration>,
        write_packets: usize,
        fail_write_packet: Option<usize>,
        log: Option<Rc<RefCell<Vec<String>>>>,
    }

    impl FakeIo {
        fn queue_image(&mut self, image: &RawPanelImage) {
            for chunk in image.bytes().chunks_exact(4) {
                self.incoming.push_back(Ok(Some(vec![
                    IPAC4_REPORT_ID,
                    chunk[0],
                    chunk[1],
                    chunk[2],
                    chunk[3],
                ])));
            }
            // The PAC256 reader waits one full frame deadline after the 64th
            // frame to prove a newer chart was not silently truncated.
            self.incoming.push_back(Ok(None));
        }

        fn writes(&self) -> impl Iterator<Item = &[u8]> {
            self.sent
                .iter()
                .filter(|report| report.as_slice() != IPAC4_QUERY)
                .map(Vec::as_slice)
        }
    }

    impl PanelReportIo for FakeIo {
        fn send_report(&mut self, report: &[u8]) -> Result<(), ReportIoError> {
            let is_query = report == IPAC4_QUERY;
            if !is_query && self.fail_write_packet == Some(self.write_packets) {
                return Err(ReportIoError::with_code(1234, "injected write failure"));
            }
            if let Some(log) = &self.log {
                log.borrow_mut().push(if is_query {
                    "query".to_owned()
                } else {
                    format!("write:{}", self.write_packets)
                });
            }
            self.sent.push(report.to_vec());
            if !is_query {
                self.write_packets += 1;
            }
            Ok(())
        }

        fn receive_report(&mut self, timeout: Duration) -> Result<Option<Vec<u8>>, ReportIoError> {
            self.receive_timeouts.push(timeout);
            self.incoming.pop_front().unwrap_or(Ok(None))
        }
    }

    fn patterned_image(len: usize, seed: u8) -> RawPanelImage {
        let mut bytes: Vec<u8> = (0..len)
            .map(|index| seed.wrapping_add((index % 239) as u8))
            .collect();
        bytes[..4].copy_from_slice(&[0x50, 0xDD, 0x56, seed]);
        RawPanelImage::new(bytes).unwrap()
    }

    fn zero_image(len: usize) -> RawPanelImage {
        let mut bytes = vec![0; len];
        bytes[..3].copy_from_slice(&IPAC4_READBACK_HEADER);
        RawPanelImage::new(bytes).unwrap()
    }

    fn usage(value: u8) -> KeyboardUsage {
        KeyboardUsage::new(value).unwrap()
    }

    fn identity() -> BoardIdentity {
        BoardIdentity::ipac4(0x0056, Some("4".to_owned()), "usb-d209-0430-serial-4")
    }

    fn stamp() -> Timestamp {
        Timestamp::from_unix(1_787_442_720)
    }

    #[test]
    fn read_requires_exactly_64_frames_and_proves_the_full_timeout_boundary() {
        let expected = patterned_image(IPAC4_IMAGE_BYTES, 1);
        let mut io = FakeIo::default();
        io.queue_image(&expected);

        let actual = read_ipac4_image(&mut io).unwrap();
        assert_eq!(actual, expected);
        assert_eq!(io.sent, vec![IPAC4_QUERY.to_vec()]);
        assert!(io.incoming.is_empty());
        assert_eq!(io.receive_timeouts.len(), IPAC4_REQUIRED_FRAMES + 1);
        assert!(io
            .receive_timeouts
            .iter()
            .all(|timeout| *timeout == REQUIRED_FRAME_TIMEOUT));
    }

    #[test]
    fn required_timeout_names_the_exact_packet() {
        let expected = patterned_image(IPAC4_IMAGE_BYTES, 3);
        let mut io = FakeIo::default();
        io.queue_image(&expected);
        io.incoming[17] = Ok(None);

        assert!(matches!(
            read_ipac4_image(&mut io),
            Err(PanelProgrammingError::RequiredFrameTimedOut {
                operation: IoOperation::Read,
                packet: 17
            })
        ));
    }

    #[test]
    fn read_rejects_short_frames_and_wrong_report_ids() {
        let expected = patterned_image(IPAC4_IMAGE_BYTES, 7);

        let mut short = FakeIo::default();
        short.queue_image(&expected);
        short.incoming[9] = Ok(Some(vec![IPAC4_REPORT_ID, 1, 2, 3]));
        assert!(matches!(
            read_ipac4_image(&mut short),
            Err(PanelProgrammingError::InvalidFrameLength {
                operation: IoOperation::Read,
                packet: 9,
                expected: 5,
                actual: 4
            })
        ));

        let mut wrong_id = FakeIo::default();
        wrong_id.queue_image(&expected);
        wrong_id.incoming[12].as_mut().unwrap().as_mut().unwrap()[0] = 0x04;
        assert!(matches!(
            read_ipac4_image(&mut wrong_id),
            Err(PanelProgrammingError::InvalidReportId {
                operation: IoOperation::Read,
                packet: 12,
                expected: IPAC4_REPORT_ID,
                actual: 0x04
            })
        ));
    }

    #[test]
    fn any_sixty_fifth_frame_is_an_unsupported_profile() {
        let expected = patterned_image(IPAC4_IMAGE_BYTES, 9);
        let mut io = FakeIo::default();
        io.queue_image(&expected);
        *io.incoming.back_mut().unwrap() = Ok(Some(vec![IPAC4_REPORT_ID, 1]));
        assert!(matches!(
            read_ipac4_image(&mut io),
            Err(PanelProgrammingError::UnexpectedFrame {
                operation: IoOperation::Read,
                packet: IPAC4_REQUIRED_FRAMES,
                profile: IPAC4_PROTOCOL_PROFILE,
            })
        ));
    }

    #[test]
    fn read_rejects_an_unknown_chart_header_before_it_can_be_backed_up_or_written() {
        let mut bytes = patterned_image(IPAC4_IMAGE_BYTES, 10).bytes().to_vec();
        bytes[..3].copy_from_slice(&[0x51, 0xDD, 0x0F]);
        let mut io = FakeIo::default();
        for chunk in bytes.chunks_exact(4) {
            io.incoming.push_back(Ok(Some(vec![
                IPAC4_REPORT_ID,
                chunk[0],
                chunk[1],
                chunk[2],
                chunk[3],
            ])));
        }
        io.incoming.push_back(Ok(None));

        assert!(matches!(
            read_ipac4_image(&mut io),
            Err(PanelProgrammingError::InvalidImageHeader {
                actual: [0x51, 0xDD, 0x0F]
            })
        ));
    }

    #[test]
    fn read_refuses_a_well_formed_sixty_fifth_frame() {
        let expected = patterned_image(IPAC4_EXTENDED_IMAGE_BYTES, 12);
        let mut io = FakeIo::default();
        io.queue_image(&expected);

        assert!(matches!(
            read_ipac4_image(&mut io),
            Err(PanelProgrammingError::UnexpectedFrame {
                operation: IoOperation::Read,
                packet: IPAC4_REQUIRED_FRAMES,
                profile: IPAC4_PROTOCOL_PROFILE,
            })
        ));
        assert_eq!(io.receive_timeouts.last(), Some(&REQUIRED_FRAME_TIMEOUT));
    }

    #[test]
    fn write_frames_every_four_bytes_and_contextualizes_failure() {
        let image = patterned_image(IPAC4_IMAGE_BYTES, 11);
        let mut io = FakeIo::default();
        write_ipac4_image(&mut io, &image).unwrap();
        let sent: Vec<_> = io.writes().collect();
        assert_eq!(sent.len(), 64);
        assert_eq!(sent[0], &[IPAC4_REPORT_ID, 0x50, 0xDD, 0x0F, 11]);
        assert_eq!(&sent[63][1..], &image.bytes()[252..256]);

        let mut failing = FakeIo {
            fail_write_packet: Some(23),
            ..FakeIo::default()
        };
        assert!(matches!(
            write_ipac4_image(&mut failing, &image),
            Err(PanelProgrammingError::Transport {
                operation: IoOperation::Write,
                packet: 23,
                source: ReportIoError {
                    code: Some(1234),
                    ..
                }
            })
        ));

        let extended = patterned_image(IPAC4_EXTENDED_IMAGE_BYTES, 13);
        let mut refused = FakeIo::default();
        assert!(matches!(
            write_ipac4_image(&mut refused, &extended),
            Err(PanelProgrammingError::UnsupportedProfileImageLength {
                profile: IPAC4_PROTOCOL_PROFILE,
                expected: IPAC4_IMAGE_BYTES,
                actual: IPAC4_EXTENDED_IMAGE_BYTES,
            })
        ));
        assert!(refused.sent.is_empty());
    }

    #[test]
    fn terminal_model_has_56_unique_inputs_and_three_coherent_planes() {
        assert_eq!(IPAC4_TERMINALS.len(), 56);
        let ids: BTreeSet<_> = IPAC4_TERMINALS.iter().map(|terminal| terminal.id).collect();
        let bases: BTreeSet<_> = IPAC4_TERMINALS
            .iter()
            .map(|terminal| terminal.base)
            .collect();
        assert_eq!(ids.len(), 56);
        assert_eq!(bases.len(), 56);
        for player in 1..=4 {
            assert_eq!(
                IPAC4_TERMINALS
                    .iter()
                    .filter(|terminal| terminal.player == player)
                    .count(),
                14
            );
        }
        for terminal in IPAC4_TERMINALS {
            assert_eq!(
                terminal.payload_offset(TerminalPlane::Alternate),
                terminal.payload_offset(TerminalPlane::Normal) + 64
            );
            assert_eq!(
                terminal.payload_offset(TerminalPlane::Shift),
                terminal.payload_offset(TerminalPlane::Normal) + 128
            );
            assert!(terminal.image_offset(TerminalPlane::Shift) < 196);
        }
    }

    #[test]
    fn coherent_plane_rule_corrects_the_two_known_table_anomalies() {
        let three_sw1 = ipac4_terminal("3sw1").unwrap();
        assert_eq!(three_sw1.payload_offset(TerminalPlane::Normal), 35);
        assert_eq!(three_sw1.payload_offset(TerminalPlane::Alternate), 99);
        assert_eq!(three_sw1.payload_offset(TerminalPlane::Shift), 163);

        let four_sw3 = ipac4_terminal("4sw3").unwrap();
        assert_eq!(four_sw3.payload_offset(TerminalPlane::Normal), 4);
        assert_eq!(four_sw3.payload_offset(TerminalPlane::Alternate), 68);
        assert_eq!(four_sw3.payload_offset(TerminalPlane::Shift), 132);
    }

    #[test]
    fn regular_keyboard_usage_codec_round_trips_without_special_actions() {
        for hid in (0x04..=0x67).chain(0xE0..=0xE7) {
            let key = KeyboardUsage::new(hid).unwrap();
            assert_eq!(KeyboardUsage::decode(key.encode()), Some(key));
        }
        assert_eq!(usage(0xE0).encode(), 0x70);
        assert_eq!(usage(0xE7).encode(), 0x77);
        for invalid in [0x00, 0x03, 0x68, 0x80, 0xDF, 0xE8, 0xFF] {
            assert!(matches!(
                KeyboardUsage::new(invalid),
                Err(PanelProgrammingError::InvalidKeyboardUsage(value)) if value == invalid
            ));
        }
    }

    #[test]
    fn semantic_edits_change_only_the_three_addressed_bytes() {
        let baseline = zero_image(IPAC4_IMAGE_BYTES);
        let edits = [
            TerminalEdit::normal("3sw1", Some(usage(0x0D))),
            TerminalEdit::alternate("4sw3", Some(usage(0xE4))),
            TerminalEdit::shift("1up", true),
        ];
        let plan = plan_program(&baseline, &edits).unwrap();
        let expected_offsets = BTreeSet::from([
            ipac4_terminal("3sw1")
                .unwrap()
                .image_offset(TerminalPlane::Normal),
            ipac4_terminal("4sw3")
                .unwrap()
                .image_offset(TerminalPlane::Alternate),
            ipac4_terminal("1up")
                .unwrap()
                .image_offset(TerminalPlane::Shift),
        ]);
        let actual_offsets: BTreeSet<_> =
            plan.byte_diff.iter().map(|change| change.offset).collect();
        assert_eq!(actual_offsets, expected_offsets);
        for offset in 0..baseline.len() {
            if !expected_offsets.contains(&offset) {
                assert_eq!(baseline.bytes()[offset], plan.desired.bytes()[offset]);
            }
        }
        assert_eq!(plan.semantic_diff.len(), 3);

        let rows = decode_ipac4_terminals(&plan.desired);
        assert_eq!(rows.len(), IPAC4_TERMINAL_COUNT);
        let three_sw1 = rows.iter().find(|row| row.terminal.id == "3sw1").unwrap();
        assert_eq!(three_sw1.normal, TerminalAction::Keyboard(usage(0x0D)));
        let four_sw3 = rows.iter().find(|row| row.terminal.id == "4sw3").unwrap();
        assert_eq!(four_sw3.alternate, TerminalAction::Keyboard(usage(0xE4)));
    }

    #[test]
    fn duplicate_and_unknown_edits_refuse_instead_of_becoming_order_dependent() {
        let baseline = zero_image(IPAC4_IMAGE_BYTES);
        let duplicate = [
            TerminalEdit::normal("1sw1", Some(usage(0x04))),
            TerminalEdit::normal("1SW1", Some(usage(0x05))),
        ];
        assert!(matches!(
            plan_program(&baseline, &duplicate),
            Err(PanelProgrammingError::DuplicateEdit {
                terminal,
                plane: TerminalPlane::Normal
            }) if terminal == "1sw1"
        ));
        assert!(matches!(
            plan_program(
                &baseline,
                &[TerminalEdit::normal("wire-57", Some(usage(0x04)))]
            ),
            Err(PanelProgrammingError::UnknownTerminal(id)) if id == "wire-57"
        ));
    }

    #[test]
    fn plans_and_diffs_are_deterministic_for_any_edit_order() {
        let baseline = patterned_image(IPAC4_EXTENDED_IMAGE_BYTES, 31);
        let mut edits = vec![
            TerminalEdit::shift("2sw8", false),
            TerminalEdit::alternate("1coin", None),
            TerminalEdit::normal("4up", Some(usage(0x3A))),
        ];
        let first = plan_program(&baseline, &edits).unwrap();
        edits.reverse();
        let second = plan_program(&baseline, &edits).unwrap();
        assert_eq!(first, second);
        assert!(first
            .byte_diff
            .windows(2)
            .all(|pair| pair[0].offset < pair[1].offset));
    }

    #[test]
    fn canonical_four_player_chart_preserves_opaque_shift_and_vendor_bytes() {
        let edits = canonical_four_player_edits();
        assert_eq!(edits.len(), IPAC4_TERMINAL_COUNT * 2);
        let mut terminals = BTreeSet::new();
        let mut usages = BTreeSet::new();
        for (terminal, edits) in IPAC4_TERMINALS.iter().zip(edits.chunks_exact(2)) {
            match &edits[0] {
                TerminalEdit::Normal {
                    terminal: edited_terminal,
                    usage: Some(usage),
                } => {
                    assert_eq!(edited_terminal, terminal.id);
                    assert!(terminals.insert(edited_terminal.clone()));
                    assert!(usages.insert(usage.hid_usage()));
                }
                other => panic!("canonical normal edit was {other:?}"),
            }
            assert_eq!(
                edits[1],
                TerminalEdit::alternate(terminal.id, None),
                "{} alternate",
                terminal.id
            );
        }
        assert_eq!(terminals.len(), 56);
        assert_eq!(usages.len(), 56);

        let patterned = patterned_image(IPAC4_IMAGE_BYTES, 37);
        let mut bytes = patterned.bytes().to_vec();
        for terminal in IPAC4_TERMINALS {
            bytes[terminal.image_offset(TerminalPlane::Shift)] = 0x7F;
        }
        bytes[IPAC4_TERMINALS[0].image_offset(TerminalPlane::Shift)] = 0x41;
        bytes[IPAC4_TERMINALS[1].image_offset(TerminalPlane::Shift)] = 0x01;
        let baseline = RawPanelImage::new(bytes).unwrap();
        let edits = canonical_four_player_edits_for_image(&baseline);
        let plan = plan_program(&baseline, &edits).unwrap();
        let rows = decode_ipac4_terminals(&plan.desired);
        let assigned: BTreeSet<_> = rows
            .iter()
            .map(|row| match row.normal {
                TerminalAction::Keyboard(usage) => usage.hid_usage(),
                other => panic!("{} normal was {other:?}", row.terminal.id),
            })
            .collect();
        assert_eq!(assigned.len(), IPAC4_TERMINAL_COUNT);
        assert!(rows
            .iter()
            .all(|row| row.alternate == TerminalAction::Unassigned));
        assert_eq!(rows[0].shift, SemanticValue::ShiftDisabled);
        assert_eq!(rows[1].shift_raw, 0x01);
        assert!(rows[2..].iter().all(|row| row.shift_raw == 0x7F));

        let addressed: BTreeSet<_> = IPAC4_TERMINALS
            .iter()
            .flat_map(|terminal| {
                [
                    terminal.image_offset(TerminalPlane::Normal),
                    terminal.image_offset(TerminalPlane::Alternate),
                ]
            })
            .chain(std::iter::once(
                IPAC4_TERMINALS[0].image_offset(TerminalPlane::Shift),
            ))
            .collect();
        for offset in 0..baseline.len() {
            if !addressed.contains(&offset) {
                assert_eq!(
                    plan.desired.bytes()[offset],
                    baseline.bytes()[offset],
                    "opaque byte {offset} changed"
                );
            }
        }
    }

    /// Catches the unsafe clear implementation that rewrote every shift byte
    /// to 0x01, including opaque live-board values.
    #[test]
    fn blank_chart_clears_actions_and_only_known_enabled_shift_roles() {
        let mut bytes = vec![0xA5; IPAC4_IMAGE_BYTES];
        bytes[..4].copy_from_slice(&[0x50, 0xDD, 0x56, 0x01]);
        for terminal in IPAC4_TERMINALS {
            bytes[terminal.image_offset(TerminalPlane::Normal)] = 0x04;
            bytes[terminal.image_offset(TerminalPlane::Alternate)] = 0x05;
            bytes[terminal.image_offset(TerminalPlane::Shift)] = 0x7F;
        }
        bytes[IPAC4_TERMINALS[0].image_offset(TerminalPlane::Shift)] = 0x41;
        bytes[IPAC4_TERMINALS[1].image_offset(TerminalPlane::Shift)] = 0x01;
        let baseline = RawPanelImage::new(bytes).unwrap();
        let edits = blank_edits_for_image(&baseline);
        assert_eq!(edits.len(), IPAC4_TERMINAL_COUNT * 2 + 1);
        let plan = plan_program(&baseline, &edits).unwrap();
        let rows = decode_ipac4_terminals(&plan.desired);
        assert!(rows
            .iter()
            .all(|row| row.normal == TerminalAction::Unassigned));
        assert!(rows
            .iter()
            .all(|row| row.alternate == TerminalAction::Unassigned));
        assert_eq!(rows[0].shift, SemanticValue::ShiftDisabled);
        assert_eq!(rows[1].shift_raw, 0x01);
        assert!(rows[2..].iter().all(|row| row.shift_raw == 0x7F));

        let addressed: BTreeSet<_> = IPAC4_TERMINALS
            .iter()
            .flat_map(|terminal| {
                [
                    terminal.image_offset(TerminalPlane::Normal),
                    terminal.image_offset(TerminalPlane::Alternate),
                ]
            })
            .chain(std::iter::once(
                IPAC4_TERMINALS[0].image_offset(TerminalPlane::Shift),
            ))
            .collect();
        for offset in 0..baseline.len() {
            if !addressed.contains(&offset) {
                assert_eq!(
                    plan.desired.bytes()[offset],
                    baseline.bytes()[offset],
                    "opaque/reserved byte {offset} changed"
                );
            }
        }
    }

    #[test]
    fn portable_terminal_signature_is_stable_and_names_all_56_channels() {
        let signature = ipac4_terminal_signature();
        assert_eq!(
            signature,
            "ipac4-56-v1-B94D226C60D460BA5EE3E7A5C99AB6F135F91161DEF4845EF8CCC4D287B59420"
        );
        assert_eq!(IPAC4_TERMINALS.len(), 56);
    }

    static TEST_DIR_COUNTER: AtomicUsize = AtomicUsize::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let serial = TEST_DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "ksx-panel-programming-test-{}-{label}-{serial}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn backup_store_is_lossless_immutable_and_collision_safe() {
        let dir = TestDir::new("backup");
        let mut store = BackupStore::new(dir.path());
        let identity = identity();
        let image = patterned_image(IPAC4_IMAGE_BYTES, 41);
        let first = store
            .save_immutable(&identity, &image, stamp(), BackupReason::Manual)
            .unwrap();
        let second = store
            .save_immutable(&identity, &image, stamp(), BackupReason::BeforeProgram)
            .unwrap();

        assert_ne!(first.id, second.id);
        assert!(second.id.as_str().contains("-2.ksxpanel.json"));
        let loaded = store.load_verified(&identity, &first.id).unwrap();
        assert_eq!(loaded.image, image);
        assert_eq!(loaded.identity, identity);
        assert_eq!(loaded.stored.reason, BackupReason::Manual);
        let document: serde_json::Value =
            serde_json::from_slice(&fs::read(&first.path).unwrap()).unwrap();
        assert_eq!(
            document
                .pointer("/profile")
                .and_then(|value| value.as_str()),
            Some(IPAC4_PROTOCOL_PROFILE)
        );
        assert_eq!(
            document
                .pointer("/driver_schema")
                .and_then(|value| value.as_u64()),
            Some(IPAC4_DRIVER_SCHEMA as u64)
        );
        assert_eq!(
            document
                .pointer("/transport/report_id")
                .and_then(|value| value.as_u64()),
            Some(u64::from(IPAC4_REPORT_ID))
        );
        assert_eq!(
            document
                .pointer("/image/length")
                .and_then(|value| value.as_u64()),
            Some(IPAC4_IMAGE_BYTES as u64)
        );
        let listed = store.list_verified(&identity).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, second.id);
        assert_eq!(listed[1].id, first.id);

        let board_dir = first.path.parent().unwrap();
        assert!(fs::read_dir(board_dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".tmp-")));
    }

    #[test]
    fn backup_store_refuses_non_profile_images_and_tampered_contract_facts() {
        let dir = TestDir::new("backup-contract");
        let mut store = BackupStore::new(dir.path());
        let identity = identity();
        let extended = patterned_image(IPAC4_EXTENDED_IMAGE_BYTES, 42);
        assert!(matches!(
            store.save_immutable(&identity, &extended, stamp(), BackupReason::Manual),
            Err(BackupError::InvalidDocument(message))
                if message.contains(IPAC4_PROTOCOL_PROFILE)
                    && message.contains("256-byte")
        ));

        let image = patterned_image(IPAC4_IMAGE_BYTES, 44);
        let backup = store
            .save_immutable(&identity, &image, stamp(), BackupReason::Manual)
            .unwrap();
        let original: serde_json::Value =
            serde_json::from_slice(&fs::read(&backup.path).unwrap()).unwrap();
        let mutations = [
            ("/profile", serde_json::json!("ipac4-unknown-v9")),
            ("/driver", serde_json::json!("ultimarc-ipac2")),
            ("/driver_schema", serde_json::json!(2)),
            ("/device/bcd_device", serde_json::json!(0x0055)),
            (
                "/transport/collection_rule",
                serde_json::json!("first HID collection"),
            ),
            ("/transport/report_id", serde_json::json!(4)),
            ("/transport/input_report_bytes", serde_json::json!(64)),
            ("/transport/output_report_bytes", serde_json::json!(64)),
            ("/image/length", serde_json::json!(260)),
        ];
        for (pointer, replacement) in mutations {
            let mut mutated = original.clone();
            *mutated.pointer_mut(pointer).unwrap() = replacement;
            fs::write(&backup.path, serde_json::to_vec_pretty(&mutated).unwrap()).unwrap();
            assert!(matches!(
                store.load_verified(&identity, &backup.id),
                Err(BackupError::InvalidDocument(_))
            ));
        }
    }

    #[test]
    fn backup_store_rejects_corruption_unsafe_ids_and_identity_drift() {
        assert!(matches!(
            BackupId::new("../escape.ksxpanel.json"),
            Err(BackupError::UnsafeBackupId(_))
        ));

        let dir = TestDir::new("corrupt");
        let mut store = BackupStore::new(dir.path());
        let identity = identity();
        let image = patterned_image(IPAC4_IMAGE_BYTES, 43);
        let backup = store
            .save_immutable(&identity, &image, stamp(), BackupReason::Manual)
            .unwrap();

        let original = fs::read_to_string(&backup.path).unwrap();
        let mut json: serde_json::Value = serde_json::from_str(&original).unwrap();
        let data = json.pointer_mut("/image/data").unwrap().as_str().unwrap();
        let replacement = format!("00{}", &data[2..]);
        *json.pointer_mut("/image/data").unwrap() = serde_json::json!(replacement);
        fs::write(&backup.path, serde_json::to_vec_pretty(&json).unwrap()).unwrap();
        assert!(matches!(
            store.load_verified(&identity, &backup.id),
            Err(BackupError::HashMismatch { .. })
        ));

        *json.pointer_mut("/image/data").unwrap() = serde_json::json!(encode_hex(image.bytes()));
        *json.pointer_mut("/device/serial").unwrap() = serde_json::json!("another-board");
        fs::write(&backup.path, serde_json::to_vec_pretty(&json).unwrap()).unwrap();
        assert!(matches!(
            store.load_verified(&identity, &backup.id),
            Err(BackupError::IncompatibleBoard { .. })
        ));
    }

    struct MemoryRepository {
        entries: BTreeMap<BackupId, LoadedBackup>,
        saves: usize,
        loads: usize,
        log: Option<Rc<RefCell<Vec<String>>>>,
        fail_save: bool,
        corrupt_load: bool,
        replace_after_first_load: Option<RawPanelImage>,
    }

    impl MemoryRepository {
        fn new(log: Option<Rc<RefCell<Vec<String>>>>) -> Self {
            Self {
                entries: BTreeMap::new(),
                saves: 0,
                loads: 0,
                log,
                fail_save: false,
                corrupt_load: false,
                replace_after_first_load: None,
            }
        }

        fn insert(&mut self, identity: &BoardIdentity, image: RawPanelImage) -> BackupId {
            let id = BackupId::new(format!(
                "memory-loaded-{}{BACKUP_EXTENSION}",
                self.entries.len()
            ))
            .unwrap();
            let stored = StoredBackup {
                id: id.clone(),
                path: PathBuf::from(id.as_str()),
                created_at: "memory".to_owned(),
                image_sha256: image.sha256().to_owned(),
                image_len: image.len(),
                reason: BackupReason::Manual,
            };
            self.entries.insert(
                id.clone(),
                LoadedBackup {
                    stored,
                    identity: identity.clone(),
                    image,
                },
            );
            id
        }
    }

    impl PanelBackupRepository for MemoryRepository {
        fn save_immutable(
            &mut self,
            identity: &BoardIdentity,
            image: &RawPanelImage,
            _timestamp: Timestamp,
            reason: BackupReason,
        ) -> Result<StoredBackup, BackupError> {
            if self.fail_save {
                return Err(BackupError::InvalidDocument(
                    "injected backup failure".to_owned(),
                ));
            }
            if let Some(log) = &self.log {
                log.borrow_mut().push("backup".to_owned());
            }
            self.saves += 1;
            let id = BackupId::new(format!("memory-saved-{}{BACKUP_EXTENSION}", self.saves))?;
            let stored = StoredBackup {
                id: id.clone(),
                path: PathBuf::from(id.as_str()),
                created_at: "memory".to_owned(),
                image_sha256: image.sha256().to_owned(),
                image_len: image.len(),
                reason,
            };
            self.entries.insert(
                id,
                LoadedBackup {
                    stored: stored.clone(),
                    identity: identity.clone(),
                    image: image.clone(),
                },
            );
            Ok(stored)
        }

        fn load_verified(
            &mut self,
            identity: &BoardIdentity,
            id: &BackupId,
        ) -> Result<LoadedBackup, BackupError> {
            self.loads += 1;
            let mut loaded = self.entries.get(id).cloned().ok_or_else(|| {
                BackupError::InvalidDocument(format!("missing memory backup {id}"))
            })?;
            if !identity.compatible_with(&loaded.identity) {
                return Err(BackupError::IncompatibleBoard {
                    expected: Box::new(identity.clone()),
                    backup: Box::new(loaded.identity),
                });
            }
            if self.corrupt_load {
                let mut bytes = loaded.image.bytes().to_vec();
                bytes[8] ^= 0xFF;
                loaded.image = RawPanelImage::new(bytes).unwrap();
            }
            if self.loads == 1 {
                if let Some(replacement) = self.replace_after_first_load.take() {
                    let replacement_entry = self.entries.get_mut(id).unwrap();
                    replacement_entry.image = replacement.clone();
                    replacement_entry.stored.image_sha256 = replacement.sha256().to_owned();
                    replacement_entry.stored.image_len = replacement.len();
                }
            }
            Ok(loaded)
        }
    }

    #[test]
    fn program_transaction_backups_before_packet_zero_and_verifies_every_byte() {
        let log = Rc::new(RefCell::new(Vec::new()));
        let baseline = zero_image(IPAC4_IMAGE_BYTES);
        let edits = vec![TerminalEdit::normal("1sw1", Some(usage(0x04)))];
        let plan = plan_program(&baseline, &edits).unwrap();
        let mut io = FakeIo {
            log: Some(log.clone()),
            ..FakeIo::default()
        };
        io.queue_image(&baseline);
        io.queue_image(&plan.desired);
        let mut repository = MemoryRepository::new(Some(log.clone()));

        let outcome = apply_program(
            &mut io,
            &mut repository,
            &identity(),
            baseline.sha256(),
            &edits,
            stamp(),
        )
        .unwrap();
        assert!(outcome.wrote);
        assert_eq!(outcome.verified_sha256, plan.desired_sha256);
        assert_eq!(repository.saves, 1);
        let events = log.borrow();
        let backup_at = events.iter().position(|event| event == "backup").unwrap();
        let first_write_at = events.iter().position(|event| event == "write:0").unwrap();
        assert!(backup_at < first_write_at, "events: {events:?}");
        assert_eq!(events.last().unwrap(), "query");
    }

    #[test]
    fn stale_or_noop_program_never_writes_or_creates_a_backup() {
        let baseline = zero_image(IPAC4_IMAGE_BYTES);

        let mut stale_io = FakeIo::default();
        stale_io.queue_image(&baseline);
        let mut stale_repository = MemoryRepository::new(None);
        assert!(matches!(
            apply_program(
                &mut stale_io,
                &mut stale_repository,
                &identity(),
                &"AA".repeat(32),
                &[TerminalEdit::normal("1sw1", Some(usage(0x04)))],
                stamp()
            ),
            Err(PanelProgrammingError::StaleImage { .. })
        ));
        assert_eq!(stale_repository.saves, 0);
        assert_eq!(stale_io.writes().count(), 0);

        let mut noop_io = FakeIo::default();
        noop_io.queue_image(&baseline);
        let mut noop_repository = MemoryRepository::new(None);
        let outcome = apply_program(
            &mut noop_io,
            &mut noop_repository,
            &identity(),
            baseline.sha256(),
            &[TerminalEdit::normal("1sw1", None)],
            stamp(),
        )
        .unwrap();
        assert!(!outcome.wrote);
        assert!(outcome.backup.is_none());
        assert_eq!(noop_repository.saves, 0);
        assert_eq!(noop_io.writes().count(), 0);
    }

    #[test]
    fn backup_failure_or_failed_reopen_prevents_the_first_program_packet() {
        let baseline = zero_image(IPAC4_IMAGE_BYTES);
        let edits = [TerminalEdit::normal("1sw1", Some(usage(0x04)))];

        let mut save_io = FakeIo::default();
        save_io.queue_image(&baseline);
        let mut save_repository = MemoryRepository::new(None);
        save_repository.fail_save = true;
        assert!(matches!(
            apply_program(
                &mut save_io,
                &mut save_repository,
                &identity(),
                baseline.sha256(),
                &edits,
                stamp()
            ),
            Err(PanelProgrammingError::Backup(_))
        ));
        assert_eq!(save_io.writes().count(), 0);

        let mut reopen_io = FakeIo::default();
        reopen_io.queue_image(&baseline);
        let mut reopen_repository = MemoryRepository::new(None);
        reopen_repository.corrupt_load = true;
        assert!(matches!(
            apply_program(
                &mut reopen_io,
                &mut reopen_repository,
                &identity(),
                baseline.sha256(),
                &edits,
                stamp()
            ),
            Err(PanelProgrammingError::Backup(
                BackupError::HashMismatch { .. }
            ))
        ));
        assert_eq!(reopen_io.writes().count(), 0);
    }

    #[test]
    fn packet_zero_guard_runs_after_verified_backup_and_prevents_every_write() {
        let baseline = zero_image(IPAC4_IMAGE_BYTES);
        let edits = [TerminalEdit::normal("1sw1", Some(usage(0x04)))];
        let mut io = FakeIo::default();
        io.queue_image(&baseline);
        let mut repository = MemoryRepository::new(None);
        let error = apply_program_guarded(
            &mut io,
            &mut repository,
            &identity(),
            baseline.sha256(),
            &edits,
            stamp(),
            |backup, plan| {
                assert_eq!(backup.reason, BackupReason::BeforeProgram);
                assert_ne!(plan.desired_sha256, plan.baseline_sha256);
                Err(PanelProgrammingError::WriteGuardRefused {
                    reason: "session state became unknown".to_owned(),
                })
            },
        )
        .unwrap_err();

        assert!(matches!(
            error,
            PanelProgrammingError::WriteGuardRefused { .. }
        ));
        assert_eq!(repository.saves, 1, "the recovery image exists first");
        assert_eq!(io.writes().count(), 0, "packet zero was never sent");
    }

    #[test]
    fn write_failure_retains_backup_and_packet_context() {
        let baseline = zero_image(IPAC4_IMAGE_BYTES);
        let edits = [TerminalEdit::normal("1sw1", Some(usage(0x04)))];
        let mut io = FakeIo {
            fail_write_packet: Some(6),
            ..FakeIo::default()
        };
        io.queue_image(&baseline);
        let mut repository = MemoryRepository::new(None);
        let error = apply_program(
            &mut io,
            &mut repository,
            &identity(),
            baseline.sha256(),
            &edits,
            stamp(),
        )
        .unwrap_err();
        match error {
            PanelProgrammingError::TransactionFailed {
                backup,
                phase: TransactionPhase::Program,
                source,
            } => {
                assert!(repository.entries.contains_key(&backup));
                assert!(matches!(
                    *source,
                    PanelProgrammingError::Transport {
                        operation: IoOperation::Write,
                        packet: 6,
                        ..
                    }
                ));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn verification_mismatch_is_a_recovery_state_with_backup_id() {
        let baseline = zero_image(IPAC4_IMAGE_BYTES);
        let edits = [TerminalEdit::normal("1sw1", Some(usage(0x04)))];
        let wrong = patterned_image(IPAC4_IMAGE_BYTES, 77);
        let mut io = FakeIo::default();
        io.queue_image(&baseline);
        io.queue_image(&wrong);
        let mut repository = MemoryRepository::new(None);
        let error = apply_program(
            &mut io,
            &mut repository,
            &identity(),
            baseline.sha256(),
            &edits,
            stamp(),
        )
        .unwrap_err();
        match error {
            PanelProgrammingError::VerificationFailed { backup, .. } => {
                assert!(repository.entries.contains_key(&backup));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn restore_backs_up_current_state_then_restores_and_verifies_target() {
        let current = patterned_image(IPAC4_IMAGE_BYTES, 81);
        let target = patterned_image(IPAC4_IMAGE_BYTES, 83);
        let mut repository = MemoryRepository::new(None);
        let target_id = repository.insert(&identity(), target.clone());
        let mut io = FakeIo::default();
        io.queue_image(&current);
        io.queue_image(&target);

        let outcome = apply_restore(
            &mut io,
            &mut repository,
            &identity(),
            &target_id,
            current.sha256(),
            stamp(),
        )
        .unwrap();
        assert!(outcome.wrote);
        assert_eq!(outcome.restored_from, Some(target_id));
        let safety = outcome.backup.unwrap();
        assert_eq!(safety.reason, BackupReason::BeforeRestore);
        assert_eq!(repository.entries.get(&safety.id).unwrap().image, current);
        assert_eq!(outcome.verified_sha256, target.sha256());
    }

    #[test]
    fn restore_rejects_a_repository_target_swapped_after_review() {
        let current = patterned_image(IPAC4_IMAGE_BYTES, 91);
        let reviewed_target = patterned_image(IPAC4_IMAGE_BYTES, 93);
        let swapped_target = patterned_image(IPAC4_IMAGE_BYTES, 95);
        let mut repository = MemoryRepository::new(None);
        let target_id = repository.insert(&identity(), reviewed_target.clone());
        repository.replace_after_first_load = Some(swapped_target);
        let mut io = FakeIo::default();

        let error = apply_restore(
            &mut io,
            &mut repository,
            &identity(),
            &target_id,
            current.sha256(),
            stamp(),
        )
        .unwrap_err();

        assert!(matches!(
            error,
            PanelProgrammingError::StaleRestoreTarget {
                expected_sha256,
                actual_sha256,
            } if expected_sha256 == reviewed_target.sha256()
                && actual_sha256 != expected_sha256
        ));
        assert!(
            io.sent.is_empty(),
            "no query or write crossed the stale target gate"
        );
        assert_eq!(repository.saves, 0);
    }

    #[test]
    fn restore_transaction_refuses_a_non_profile_backup_before_device_io() {
        let target = patterned_image(IPAC4_EXTENDED_IMAGE_BYTES, 85);
        let mut repository = MemoryRepository::new(None);
        let target_id = repository.insert(&identity(), target);
        let mut io = FakeIo::default();

        assert!(matches!(
            apply_restore(
                &mut io,
                &mut repository,
                &identity(),
                &target_id,
                &"00".repeat(32),
                stamp(),
            ),
            Err(PanelProgrammingError::UnsupportedProfileImageLength {
                profile: IPAC4_PROTOCOL_PROFILE,
                expected: IPAC4_IMAGE_BYTES,
                actual: IPAC4_EXTENDED_IMAGE_BYTES,
            })
        ));
        assert!(io.sent.is_empty());
        assert!(io.receive_timeouts.is_empty());
        assert_eq!(repository.saves, 0);
    }
}
