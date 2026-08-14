//! Pure policy for one future per-Play HIDMaestro host rendezvous.
//!
//! This module grants no authority. It contains no named-pipe calls, process
//! launch, elevation, SDK loading, filesystem access or device lifecycle. It
//! freezes the values which those later OS-facing layers may carry:
//!
//! - one 32-byte token, represented only as exactly 64 lowercase hex digits;
//! - one pipe name derived internally from that token and a fixed V1 prefix;
//! - one three-item host argv containing only the fixed verb, token and daemon
//!   process id; and
//! - one fail-closed comparison between expected and authenticated process
//!   facts.
//!
//! [`RendezvousToken`] is conversation correlation, not authentication on its
//! own. A Windows transport must obtain authenticated endpoint evidence from the
//! connected pipe and the exact process object it holds, not caller-reported
//! fields or a fresh PID lookup, before it sends or accepts a protocol frame.

use std::fmt;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use thiserror::Error;

/// The only pipe-name prefix the V1 per-Play transport may use.
///
/// Callers supply a [`RendezvousToken`], never a path or a complete pipe name.
pub const PIPE_NAME_PREFIX: &str = r"\\.\pipe\KSX.HIDMaestro.Play.v1.";

/// The only host entry verb in this policy. The protocol version is part of
/// the verb so an older host cannot guess how to interpret a newer argv.
pub const HOST_VERB: &str = "serve-v1";

/// Byte width of the V1 rendezvous token. This is frozen independently from
/// any nonce used inside the host protocol.
pub const TOKEN_BYTES: usize = 32;

/// One 256-bit rendezvous value.
///
/// Construction from bytes is intentionally separate from generation: the
/// future Windows boundary must use the operating system CSPRNG, while pure
/// tests can supply deterministic bytes without acquiring any OS authority.
#[derive(Clone, Copy, Hash, PartialEq, Eq, PartialOrd, Ord)]
pub struct RendezvousToken([u8; TOKEN_BYTES]);

impl RendezvousToken {
    pub const ENCODED_LEN: usize = TOKEN_BYTES * 2;

    pub const fn from_bytes(bytes: [u8; TOKEN_BYTES]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; TOKEN_BYTES] {
        &self.0
    }

    /// The one local pipe name for this token.
    pub fn pipe_name(&self) -> String {
        format!("{PIPE_NAME_PREFIX}{self}")
    }
}

impl fmt::Debug for RendezvousToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RendezvousToken([REDACTED])")
    }
}

impl fmt::Display for RendezvousToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in self.0 {
            write!(f, "{byte:02x}")?;
        }
        Ok(())
    }
}

impl FromStr for RendezvousToken {
    type Err = TokenParseError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let bytes = text.as_bytes();
        if bytes.len() != Self::ENCODED_LEN {
            return Err(TokenParseError::WrongLength {
                actual: bytes.len(),
            });
        }

        let mut decoded = [0u8; TOKEN_BYTES];
        for (index, pair) in bytes.chunks_exact(2).enumerate() {
            let high = lower_hex_nibble(pair[0]).ok_or(TokenParseError::NotLowerHex {
                index: index * 2,
                found: pair[0],
            })?;
            let low = lower_hex_nibble(pair[1]).ok_or(TokenParseError::NotLowerHex {
                index: index * 2 + 1,
                found: pair[1],
            })?;
            decoded[index] = high << 4 | low;
        }
        Ok(Self(decoded))
    }
}

const fn lower_hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenParseErrorCode {
    WrongLength,
    NotLowerHex,
}

impl TokenParseErrorCode {
    pub const ALL: &'static [Self] = &[Self::WrongLength, Self::NotLowerHex];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::WrongLength => "rendezvous-token-wrong-length",
            Self::NotLowerHex => "rendezvous-token-not-lower-hex",
        }
    }
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum TokenParseError {
    #[error("the rendezvous token is {actual} bytes; expected exactly 64 lowercase hex bytes")]
    WrongLength { actual: usize },
    #[error("the rendezvous token byte at index {index} is {found:#04x}, not lowercase hex")]
    NotLowerHex { index: usize, found: u8 },
}

impl TokenParseError {
    pub const fn code(&self) -> TokenParseErrorCode {
        match self {
            Self::WrongLength { .. } => TokenParseErrorCode::WrongLength,
            Self::NotLowerHex { .. } => TokenParseErrorCode::NotLowerHex,
        }
    }
}

/// The complete caller-controlled input to the future host launch.
///
/// It intentionally has no executable, working-directory, pipe-path, profile,
/// descriptor or command field. The OS layer resolves the one installed host
/// sibling independently; this value supplies only the fixed host mode and the
/// two bounded conversation identities.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostLaunchSpec {
    token: RendezvousToken,
    daemon_pid: u32,
}

impl HostLaunchSpec {
    pub fn new(token: RendezvousToken, daemon_pid: u32) -> Result<Self, LaunchSpecError> {
        if daemon_pid == 0 {
            return Err(LaunchSpecError::ZeroDaemonPid);
        }
        Ok(Self { token, daemon_pid })
    }

    pub const fn token(&self) -> RendezvousToken {
        self.token
    }

    pub const fn daemon_pid(&self) -> u32 {
        self.daemon_pid
    }

    pub fn pipe_name(&self) -> String {
        self.token.pipe_name()
    }

    /// Exact arguments passed after the protected host executable.
    ///
    /// The array length is part of the API: later launch code cannot append a
    /// caller path or an open-ended option without changing this contract.
    pub fn argv(&self) -> [String; 3] {
        [
            HOST_VERB.to_owned(),
            self.token.to_string(),
            self.daemon_pid.to_string(),
        ]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaunchSpecErrorCode {
    ZeroDaemonPid,
}

impl LaunchSpecErrorCode {
    pub const ALL: &'static [Self] = &[Self::ZeroDaemonPid];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ZeroDaemonPid => "rendezvous-zero-daemon-pid",
        }
    }
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum LaunchSpecError {
    #[error("the daemon process id must not be zero")]
    ZeroDaemonPid,
}

impl LaunchSpecError {
    pub const fn code(&self) -> LaunchSpecErrorCode {
        match self {
            Self::ZeroDaemonPid => LaunchSpecErrorCode::ZeroDaemonPid,
        }
    }
}

/// Which side of the per-Play boundary is being verified.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PeerRole {
    /// The ordinary, interactive KSX daemon.
    Daemon,
    /// The elevated, interactive HIDMaestro host.
    Host,
}

impl PeerRole {
    pub const ALL: &'static [Self] = &[Self::Daemon, Self::Host];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Daemon => "daemon",
            Self::Host => "host",
        }
    }
}

/// Identity the verifier expects before a pipe connection is trusted.
///
/// `canonical_image` is not canonicalized here. Both this value and
/// [`PeerEvidence::canonical_image`] must come from the same OS canonical-image
/// provider. Exact comparison is deliberate: normalizing a caller string in
/// this pure layer would turn an unverified spelling into identity evidence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExpectedPeer {
    role: PeerRole,
    pid: u32,
    session_id: u32,
    canonical_image: PathBuf,
}

impl ExpectedPeer {
    pub fn new(
        role: PeerRole,
        pid: u32,
        session_id: u32,
        canonical_image: impl Into<PathBuf>,
    ) -> Result<Self, ExpectedPeerError> {
        if pid == 0 {
            return Err(ExpectedPeerError::ZeroPid);
        }
        if session_id == 0 {
            return Err(ExpectedPeerError::ZeroSession);
        }
        let canonical_image = canonical_image.into();
        if !canonical_image.is_absolute() {
            return Err(ExpectedPeerError::ImageNotAbsolute);
        }
        Ok(Self {
            role,
            pid,
            session_id,
            canonical_image,
        })
    }

    pub const fn role(&self) -> PeerRole {
        self.role
    }

    pub const fn pid(&self) -> u32 {
        self.pid
    }

    pub const fn session_id(&self) -> u32 {
        self.session_id
    }

    pub fn canonical_image(&self) -> &Path {
        &self.canonical_image
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExpectedPeerErrorCode {
    ZeroPid,
    ZeroSession,
    ImageNotAbsolute,
}

impl ExpectedPeerErrorCode {
    pub const ALL: &'static [Self] = &[Self::ZeroPid, Self::ZeroSession, Self::ImageNotAbsolute];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ZeroPid => "rendezvous-zero-peer-pid",
            Self::ZeroSession => "rendezvous-zero-peer-session",
            Self::ImageNotAbsolute => "rendezvous-peer-image-not-absolute",
        }
    }
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum ExpectedPeerError {
    #[error("the expected peer process id must not be zero")]
    ZeroPid,
    #[error("interactive per-Play peers must not run in Windows session zero")]
    ZeroSession,
    #[error("the expected peer image must be an absolute OS-canonical path")]
    ImageNotAbsolute,
}

impl ExpectedPeerError {
    pub const fn code(&self) -> ExpectedPeerErrorCode {
        match self {
            Self::ZeroPid => ExpectedPeerErrorCode::ZeroPid,
            Self::ZeroSession => ExpectedPeerErrorCode::ZeroSession,
            Self::ImageNotAbsolute => ExpectedPeerErrorCode::ImageNotAbsolute,
        }
    }
}

/// Authenticated process facts observed by an OS transport.
///
/// Its fields are private and construction is crate-private so an external
/// caller cannot turn matching strings and booleans into evidence. The later
/// OS boundary may construct it only after binding the connected pipe PID to
/// the exact, live process object it holds and deriving every field from that
/// object or an authoritative kernel query. Caller claims, argv, payload data,
/// and a fresh PID lookup are not evidence. [`verify_peer`] applies policy to
/// the authenticated snapshot; it does not replace that kernel proof.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PeerEvidence {
    pid: u32,
    session_id: u32,
    canonical_image: PathBuf,
    elevated: bool,
    alive: bool,
}

impl PeerEvidence {
    /// Package facts only after the connected endpoint has been authenticated
    /// as the exact process object from which all fields were queried.
    #[allow(
        dead_code,
        reason = "retained as the pure rendezvous-policy evidence model"
    )]
    pub(crate) fn from_authenticated_process(
        pid: u32,
        session_id: u32,
        canonical_image: impl Into<PathBuf>,
        elevated: bool,
        alive: bool,
    ) -> Self {
        Self {
            pid,
            session_id,
            canonical_image: canonical_image.into(),
            elevated,
            alive,
        }
    }
}

/// Stable reason a peer is refused before any host-protocol frame is trusted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PeerRefusalCode {
    PidMismatch,
    SessionMismatch,
    ImageMismatch,
    NotAlive,
    DaemonElevated,
    HostNotElevated,
}

impl PeerRefusalCode {
    pub const ALL: &'static [Self] = &[
        Self::PidMismatch,
        Self::SessionMismatch,
        Self::ImageMismatch,
        Self::NotAlive,
        Self::DaemonElevated,
        Self::HostNotElevated,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PidMismatch => "rendezvous-peer-pid-mismatch",
            Self::SessionMismatch => "rendezvous-peer-session-mismatch",
            Self::ImageMismatch => "rendezvous-peer-image-mismatch",
            Self::NotAlive => "rendezvous-peer-not-alive",
            Self::DaemonElevated => "rendezvous-daemon-elevated",
            Self::HostNotElevated => "rendezvous-host-not-elevated",
        }
    }
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
#[error("{role:?} rendezvous peer refused: {code:?}")]
pub struct PeerRefusal {
    role: PeerRole,
    code: PeerRefusalCode,
}

impl PeerRefusal {
    const fn new(role: PeerRole, code: PeerRefusalCode) -> Self {
        Self { role, code }
    }

    pub const fn role(&self) -> PeerRole {
        self.role
    }

    pub const fn code(&self) -> PeerRefusalCode {
        self.code
    }
}

/// Require an exact, live process in the expected nonzero Windows session and
/// with the privilege state fixed for its role.
///
/// This function performs no fallback matching. In particular, it does not
/// compare filenames, fold path case, resolve links, clean `..`, substitute a
/// parent pid, or treat an unreadable fact as a match.
pub fn verify_peer(expected: &ExpectedPeer, evidence: &PeerEvidence) -> Result<(), PeerRefusal> {
    let refuse = |code| PeerRefusal::new(expected.role, code);
    if evidence.pid != expected.pid {
        return Err(refuse(PeerRefusalCode::PidMismatch));
    }
    if evidence.session_id != expected.session_id {
        return Err(refuse(PeerRefusalCode::SessionMismatch));
    }
    if evidence.canonical_image != expected.canonical_image {
        return Err(refuse(PeerRefusalCode::ImageMismatch));
    }
    if !evidence.alive {
        return Err(refuse(PeerRefusalCode::NotAlive));
    }
    match expected.role {
        PeerRole::Daemon if evidence.elevated => Err(refuse(PeerRefusalCode::DaemonElevated)),
        PeerRole::Host if !evidence.elevated => Err(refuse(PeerRefusalCode::HostNotElevated)),
        PeerRole::Daemon | PeerRole::Host => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN_TEXT: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    fn token() -> RendezvousToken {
        TOKEN_TEXT.parse().expect("a canonical token")
    }

    fn image(name: &str) -> PathBuf {
        std::env::current_dir()
            .expect("test working directory")
            .join("protected")
            .join(name)
    }

    fn expected(role: PeerRole) -> ExpectedPeer {
        let name = match role {
            PeerRole::Daemon => "ksx.exe",
            PeerRole::Host => "ksx-hidmaestro-host.exe",
        };
        ExpectedPeer::new(role, 4242, 7, image(name)).unwrap()
    }

    fn matching(role: PeerRole) -> PeerEvidence {
        let expected = expected(role);
        PeerEvidence::from_authenticated_process(
            expected.pid(),
            expected.session_id(),
            expected.canonical_image(),
            role == PeerRole::Host,
            true,
        )
    }

    #[test]
    fn token_is_exactly_32_bytes_spelled_as_64_lowercase_hex() {
        let bytes = std::array::from_fn(|index| index as u8);
        let value = RendezvousToken::from_bytes(bytes);
        assert_eq!(value.to_string(), TOKEN_TEXT);
        assert_eq!(value.as_bytes(), &bytes);
        assert_eq!(value.to_string().parse::<RendezvousToken>(), Ok(value));
        assert_eq!(TOKEN_BYTES, 32);
        assert_eq!(RendezvousToken::ENCODED_LEN, 64);
    }

    #[test]
    fn debug_does_not_disclose_the_rendezvous_token() {
        let value = token();
        assert_eq!(format!("{value:?}"), "RendezvousToken([REDACTED])");
        assert!(!format!("{value:?}").contains(TOKEN_TEXT));

        let launch = HostLaunchSpec::new(value, 12345).unwrap();
        assert!(!format!("{launch:?}").contains(TOKEN_TEXT));
    }

    #[test]
    fn token_parser_refuses_every_non_exact_length() {
        for length in 0..128 {
            if length == RendezvousToken::ENCODED_LEN {
                continue;
            }
            let text = "a".repeat(length);
            let error = text.parse::<RendezvousToken>().unwrap_err();
            assert_eq!(error.code(), TokenParseErrorCode::WrongLength, "{length}");
        }
        let unicode = "é".repeat(32);
        assert_eq!(unicode.len(), 64, "this reaches the byte validator");
        assert_eq!(
            unicode.parse::<RendezvousToken>().unwrap_err().code(),
            TokenParseErrorCode::NotLowerHex
        );
    }

    #[test]
    fn uppercase_nonhex_and_path_spellings_are_never_tokens() {
        let mut rejected = vec![
            TOKEN_TEXT.to_uppercase(),
            format!("{}G", &TOKEN_TEXT[..63]),
            format!("{}\\", &TOKEN_TEXT[..63]),
            format!("{}/", &TOKEN_TEXT[..63]),
            format!("{}.", &TOKEN_TEXT[..63]),
            format!("{}:", &TOKEN_TEXT[..63]),
        ];
        rejected.extend([
            r"..\pipe\chosen-by-caller".to_owned(),
            r"\\.\pipe\chosen-by-caller".to_owned(),
        ]);
        for text in rejected {
            assert!(
                text.parse::<RendezvousToken>().is_err(),
                "accepted {text:?}"
            );
        }
    }

    #[test]
    fn pipe_name_is_derived_from_the_fixed_prefix_and_token_only() {
        let name = token().pipe_name();
        assert_eq!(name, format!("{PIPE_NAME_PREFIX}{TOKEN_TEXT}"));
        assert_eq!(
            name.strip_prefix(PIPE_NAME_PREFIX).unwrap(),
            TOKEN_TEXT,
            "there is no caller-selected path segment"
        );
        assert_eq!(name.matches(r"\pipe\").count(), 1);
    }

    #[test]
    fn host_launch_argv_is_exactly_verb_token_and_decimal_daemon_pid() {
        let spec = HostLaunchSpec::new(token(), 12345).unwrap();
        assert_eq!(
            spec.argv(),
            [HOST_VERB, TOKEN_TEXT, "12345"].map(str::to_owned)
        );
        assert_eq!(spec.argv().len(), 3);
        assert_eq!(spec.token(), token());
        assert_eq!(spec.daemon_pid(), 12345);
        assert_eq!(spec.pipe_name(), token().pipe_name());
        assert!(
            spec.argv()
                .iter()
                .all(|argument| !argument.contains(r"\pipe\")),
            "the pipe path is reconstructed, never passed"
        );
    }

    #[test]
    fn zero_is_not_a_process_identity() {
        let launch = HostLaunchSpec::new(token(), 0).unwrap_err();
        assert_eq!(launch.code(), LaunchSpecErrorCode::ZeroDaemonPid);

        let peer = ExpectedPeer::new(PeerRole::Daemon, 0, 7, image("ksx.exe")).unwrap_err();
        assert_eq!(peer.code(), ExpectedPeerErrorCode::ZeroPid);

        let session = ExpectedPeer::new(PeerRole::Daemon, 1, 0, image("ksx.exe")).unwrap_err();
        assert_eq!(session.code(), ExpectedPeerErrorCode::ZeroSession);
    }

    #[test]
    fn expected_image_must_already_be_absolute() {
        let error = ExpectedPeer::new(PeerRole::Host, 1, 7, "ksx-hidmaestro-host.exe").unwrap_err();
        assert_eq!(error.code(), ExpectedPeerErrorCode::ImageNotAbsolute);
    }

    #[test]
    fn exact_ordinary_live_daemon_is_accepted() {
        let expected = expected(PeerRole::Daemon);
        let evidence = matching(PeerRole::Daemon);
        assert_eq!(verify_peer(&expected, &evidence), Ok(()));
    }

    #[test]
    fn exact_elevated_live_host_is_accepted() {
        let expected = expected(PeerRole::Host);
        let evidence = matching(PeerRole::Host);
        assert_eq!(verify_peer(&expected, &evidence), Ok(()));
    }

    fn assert_refused(
        role: PeerRole,
        mutate: impl FnOnce(&mut PeerEvidence),
        code: PeerRefusalCode,
    ) {
        let expected = expected(role);
        let mut evidence = matching(role);
        mutate(&mut evidence);
        let refusal = verify_peer(&expected, &evidence).unwrap_err();
        assert_eq!(refusal.role(), role);
        assert_eq!(refusal.code(), code);
    }

    #[test]
    fn pid_session_image_and_liveness_each_fail_closed() {
        for role in PeerRole::ALL.iter().copied() {
            assert_refused(role, |peer| peer.pid += 1, PeerRefusalCode::PidMismatch);
            assert_refused(
                role,
                |peer| peer.session_id += 1,
                PeerRefusalCode::SessionMismatch,
            );
            assert_refused(
                role,
                |peer| peer.canonical_image = image("lookalike.exe"),
                PeerRefusalCode::ImageMismatch,
            );
            assert_refused(role, |peer| peer.alive = false, PeerRefusalCode::NotAlive);
        }
    }

    #[test]
    fn daemon_must_be_ordinary_and_host_must_be_elevated() {
        assert_refused(
            PeerRole::Daemon,
            |peer| peer.elevated = true,
            PeerRefusalCode::DaemonElevated,
        );
        assert_refused(
            PeerRole::Host,
            |peer| peer.elevated = false,
            PeerRefusalCode::HostNotElevated,
        );
    }

    #[test]
    fn image_comparison_is_exact_and_does_not_normalize_caller_text() {
        let expected = expected(PeerRole::Host);
        let mut case_changed = matching(PeerRole::Host);
        case_changed.canonical_image = image("KSX-HIDMAESTRO-HOST.EXE");
        assert_eq!(
            verify_peer(&expected, &case_changed).unwrap_err().code(),
            PeerRefusalCode::ImageMismatch
        );

        let mut dot_segment = matching(PeerRole::Host);
        dot_segment.canonical_image = image("nested").join("..").join("ksx-hidmaestro-host.exe");
        assert_eq!(
            verify_peer(&expected, &dot_segment).unwrap_err().code(),
            PeerRefusalCode::ImageMismatch
        );
    }

    #[test]
    fn every_typed_code_has_one_stable_machine_word() {
        let token_codes: Vec<_> = TokenParseErrorCode::ALL
            .iter()
            .map(|code| code.as_str())
            .collect();
        assert_eq!(
            token_codes,
            [
                "rendezvous-token-wrong-length",
                "rendezvous-token-not-lower-hex"
            ]
        );
        assert_eq!(
            LaunchSpecErrorCode::ALL[0].as_str(),
            "rendezvous-zero-daemon-pid"
        );
        assert_eq!(
            ExpectedPeerErrorCode::ALL
                .iter()
                .map(|code| code.as_str())
                .collect::<Vec<_>>(),
            [
                "rendezvous-zero-peer-pid",
                "rendezvous-zero-peer-session",
                "rendezvous-peer-image-not-absolute"
            ]
        );
        assert_eq!(
            PeerRefusalCode::ALL
                .iter()
                .map(|code| code.as_str())
                .collect::<Vec<_>>(),
            [
                "rendezvous-peer-pid-mismatch",
                "rendezvous-peer-session-mismatch",
                "rendezvous-peer-image-mismatch",
                "rendezvous-peer-not-alive",
                "rendezvous-daemon-elevated",
                "rendezvous-host-not-elevated",
            ]
        );
    }

    /// SOURCE FREEZE: this slice is pure policy. A later transport belongs in
    /// another module and must not quietly acquire authority here.
    #[test]
    fn rendezvous_policy_has_no_os_or_device_lifecycle_authority() {
        let production = include_str!("rendezvous.rs")
            .split("#[cfg(test)]")
            .next()
            .expect("production source precedes tests");
        for forbidden in [
            concat!("windows", "_sys"),
            concat!("CreateNamed", "Pipe"),
            concat!("Shell", "Execute"),
            concat!("std::", "process::Command"),
            concat!("std::", "fs"),
            concat!("HM", "Context"),
            concat!("Install", "Driver"),
            concat!("Create", "Controller"),
            concat!("RemoveAll", "VirtualControllers"),
            concat!("unsafe", " {"),
        ] {
            assert!(
                !production.contains(forbidden),
                "pure rendezvous policy gained forbidden authority `{forbidden}`"
            );
        }

        assert!(production.contains("pub(crate) fn from_authenticated_process("));
        for forgeable in [
            "pub fn from_authenticated_process(",
            "pub pid:",
            "pub session_id:",
            "pub canonical_image:",
            "pub elevated:",
            "pub alive:",
            "interactive: bool",
        ] {
            assert!(
                !production.contains(forgeable),
                "external callers gained a forgeable evidence surface `{forgeable}`"
            );
        }
    }
}
