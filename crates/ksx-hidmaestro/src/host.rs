//! The transport-neutral contract for the privileged HIDMaestro host.
//!
//! This module deliberately contains no named-pipe code, process launch,
//! elevation, SDK loading, driver installation, controller creation or global
//! cleanup. It freezes the small vocabulary that may eventually cross that
//! boundary and supplies the client state machine used by both the in-memory
//! contract tests and the authenticated production Windows transport.
//!
//! # Security shape
//!
//! - Every frame carries a magic value, an exact protocol version, an explicit
//!   payload length and a request id.
//! - The whole payload is capped at [`MAX_PAYLOAD_BYTES`] before it is parsed.
//! - Profiles are an enum, never a caller-provided slug, descriptor or path.
//! - Controller ids are minted by the host and zero is never valid.
//! - State is a complete [`PadState`] snapshot with a strictly increasing
//!   sequence number, never an imperative button command.
//! - The host owns the 16 ms SDK pump. Every live controller also requires an
//!   unchanged full-state Submit at [`CLIENT_LEASE_REFRESH_INTERVAL`]; after
//!   [`CLIENT_LEASE_TIMEOUT`] without one, the host neutralizes and destroys it.
//! - There is intentionally no install, sweep, certificate, executable, file,
//!   registry or shell operation in [`MessageKind::ALL`]. Provisioning must not
//!   become reachable from the Play-time IPC channel.
//!
//! The wire format is KSX's host protocol, not HIDMaestro's shared-memory ABI.
//! It is suitable for a future Rust-to-.NET process boundary precisely because
//! neither side needs to know the other's native layout.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use ksx_core::pad::XButtons;
use ksx_core::{PadState, Persona, MAX_SLOTS};

/// `KSXH`, at the start of every frame.
pub const PROTOCOL_MAGIC: [u8; 4] = *b"KSXH";
/// Stable cross-language name for this exact byte contract.
pub const PROTOCOL_ID: &str = "ksx.hidmaestro.host.v1";
/// The only protocol version this crate reads or writes.
pub const PROTOCOL_VERSION: u16 = 1;
/// `magic + version + kind + request_id + payload_len`.
pub const HEADER_BYTES: usize = 16;
/// Hard payload ceiling, checked before message-specific parsing.
///
/// V1's largest honest payload is a 260-byte [`Fault`] (length/code plus a
/// 256-byte detail). The extra space is deliberate version room, not permission
/// for an implementation to carry arbitrary files or descriptors.
pub const MAX_PAYLOAD_BYTES: usize = 512;
/// Maximum encoded frame size.
pub const MAX_FRAME_BYTES: usize = HEADER_BYTES + MAX_PAYLOAD_BYTES;
/// Conversation-correlation challenge size. The OS transport fills this from a
/// cryptographically secure source; this module only carries and compares it.
pub const NONCE_BYTES: usize = 32;
/// The maximum diagnostic text a privileged host may return.
pub const MAX_FAULT_DETAIL_BYTES: usize = 256;
/// Recommended upper bound for a transport's pending feedback queue.
///
/// Feedback must never block an SDK callback indefinitely. When this bound is
/// reached, discard the oldest item and retain the newest, including a zero
/// magnitude packet which means "stop".
pub const MAX_QUEUED_FEEDBACK: usize = 64;
/// Protocol-owned total controller-identity ceiling for one host conversation.
///
/// KSX's current product ceiling must fit inside this fixed V1 bound, but this
/// wire/security contract does not silently grow when the product constant does.
pub const MAX_CONTROLLERS_PER_SESSION: usize = 16;
const _: () = assert!(MAX_SLOTS as usize <= MAX_CONTROLLERS_PER_SESSION);
/// The privileged host republishes cached full state to the SDK at this cadence.
pub const SDK_PUMP_INTERVAL: Duration = Duration::from_millis(16);
/// The ordinary client resubmits unchanged full state for every live controller
/// at this slower cadence, refreshing that controller's host-side lease.
pub const CLIENT_LEASE_REFRESH_INTERVAL: Duration = Duration::from_secs(1);
/// If no valid Submit arrives before this host-local deadline, the host must
/// neutralize and destroy the controller even while the pipe remains open.
pub const CLIENT_LEASE_TIMEOUT: Duration = Duration::from_secs(5);
/// Finite upper bounds passed to every transport implementation.
pub const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
pub const CREATE_TIMEOUT: Duration = Duration::from_secs(15);
pub const SUBMIT_TIMEOUT: Duration = Duration::from_millis(250);
pub const DESTROY_TIMEOUT: Duration = Duration::from_secs(5);
pub const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);

/// One of the fixed catalog identities KSX may eventually request.
///
/// This is protocol vocabulary, not a capability gate. The production host
/// currently enables DualSense only; Switch Pro and Xbox Series remain gated
/// independently by [`Persona::can_plug()`].
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
pub enum ProfileId {
    DualSense = 1,
    SwitchPro = 2,
    XboxSeries = 3,
}

impl ProfileId {
    pub const ALL: &'static [Self] = &[Self::DualSense, Self::SwitchPro, Self::XboxSeries];

    /// The pinned HIDMaestro catalog slug selected inside the host.
    pub const fn catalog_slug(self) -> &'static str {
        match self {
            Self::DualSense => "dualsense",
            Self::SwitchPro => "switch-pro",
            Self::XboxSeries => "xbox-series-xs-bt",
        }
    }

    pub const fn persona(self) -> Persona {
        match self {
            Self::DualSense => Persona::DualSense,
            Self::SwitchPro => Persona::SwitchPro,
            Self::XboxSeries => Persona::XboxSeries,
        }
    }

    /// USB identity pinned by the same reviewed catalog entry as the slug.
    pub const fn usb_identity(self) -> (u16, u16) {
        match self {
            Self::DualSense => (0x054C, 0x0CE6),
            Self::SwitchPro => (0x057E, 0x2009),
            Self::XboxSeries => (0x045E, 0x0B13),
        }
    }

    fn decode(value: u8) -> Result<Self, ProtocolError> {
        match value {
            1 => Ok(Self::DualSense),
            2 => Ok(Self::SwitchPro),
            3 => Ok(Self::XboxSeries),
            other => Err(ProtocolError::UnknownValue {
                field: "profile",
                value: u64::from(other),
            }),
        }
    }
}

/// A persona which has no HIDMaestro host profile.
#[derive(Clone, Copy, Debug, thiserror::Error, PartialEq, Eq)]
#[error("persona '{0}' is not an allowlisted HIDMaestro host profile")]
pub struct UnsupportedHostPersona(pub Persona);

impl TryFrom<Persona> for ProfileId {
    type Error = UnsupportedHostPersona;

    fn try_from(persona: Persona) -> Result<Self, Self::Error> {
        match persona {
            Persona::DualSense => Ok(Self::DualSense),
            Persona::SwitchPro => Ok(Self::SwitchPro),
            Persona::XboxSeries => Ok(Self::XboxSeries),
            other => Err(UnsupportedHostPersona(other)),
        }
    }
}

/// Opaque identity minted by one host process.
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq, PartialOrd, Ord)]
pub struct ControllerId(u32);

impl ControllerId {
    pub fn new(raw: u32) -> Result<Self, ProtocolError> {
        if raw == 0 {
            Err(ProtocolError::ZeroControllerId)
        } else {
            Ok(Self(raw))
        }
    }

    pub const fn raw(self) -> u32 {
        self.0
    }
}

/// Read-only identity facts returned after the host has made a controller
/// ready and submitted its initial neutral state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ControllerReady {
    pub controller: ControllerId,
    pub profile: ProfileId,
    pub vid: u16,
    pub pid: u16,
}

/// Evidence identifying the host dependency and catalog it loaded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostReady {
    /// Echo of the client's challenge. A different value means this is not the
    /// process conversation the client initiated.
    pub nonce: [u8; NONCE_BYTES],
    /// SHA-256 of the exact KSX runtime contract implemented by the host. The
    /// wire field name is retained for protocol-v1 compatibility.
    pub sdk_sha256: [u8; 32],
    /// SHA-256 of the embedded profile catalog observed by the host.
    pub catalog_sha256: [u8; 32],
    /// Total embedded catalog resources, including entries which are not
    /// deployable. This is not a supported/deployable profile count.
    pub catalog_resource_count: u16,
}

/// Exact dependency identity required before the client may issue Create.
///
/// These values come from the signed, pinned install manifest. Values merely
/// reported by the peer are not trusted as their own expectation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostExpectation {
    pub sdk_sha256: [u8; 32],
    pub catalog_sha256: [u8; 32],
    pub catalog_resource_count: u16,
}

/// Which supported SDK callback produced a feedback notification.
///
/// These are KSX protocol values, not transcribed numeric SDK enum values.
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
#[repr(u8)]
pub enum FeedbackSource {
    XInput = 1,
    HidOutput = 2,
    HidFeature = 3,
    OutputDecoded = 4,
}

impl FeedbackSource {
    fn decode(value: u8) -> Result<Self, ProtocolError> {
        match value {
            1 => Ok(Self::XInput),
            2 => Ok(Self::HidOutput),
            3 => Ok(Self::HidFeature),
            4 => Ok(Self::OutputDecoded),
            other => Err(ProtocolError::UnknownValue {
                field: "feedback source",
                value: u64::from(other),
            }),
        }
    }
}

/// Bounded, normalized full effective-feedback snapshot sent asynchronously.
///
/// V1 intentionally carries no raw report body. `report_len` preserves the
/// diagnostic fact while the existing output contract receives only verified
/// motor and LED values. Rich lighting/adaptive-trigger output needs a future
/// typed protocol version, not an unbounded byte escape hatch.
///
/// `motors_valid` and `led_valid` mean the host has observed and now knows that
/// component, not that it changed in this event. The host caches effective
/// values and repeats every known component in later snapshots. Therefore a
/// bounded queue may drop older events without a later LED-only report erasing
/// an already-observed zero-motor stop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostFeedback {
    pub controller: ControllerId,
    pub sequence: u64,
    pub source: FeedbackSource,
    pub report_len: u16,
    pub large_motor: u8,
    pub small_motor: u8,
    pub led_number: u8,
    pub motors_valid: bool,
    pub led_valid: bool,
}

/// Stable machine-readable failure categories returned by the host.
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
#[repr(u16)]
pub enum FaultCode {
    InvalidOrder = 1,
    UnsupportedProfile = 2,
    UnknownController = 3,
    StaleSequence = 4,
    SdkUnavailable = 5,
    SdkFailure = 6,
    Internal = 7,
    Capacity = 8,
}

impl FaultCode {
    fn decode(value: u16) -> Result<Self, ProtocolError> {
        match value {
            1 => Ok(Self::InvalidOrder),
            2 => Ok(Self::UnsupportedProfile),
            3 => Ok(Self::UnknownController),
            4 => Ok(Self::StaleSequence),
            5 => Ok(Self::SdkUnavailable),
            6 => Ok(Self::SdkFailure),
            7 => Ok(Self::Internal),
            8 => Ok(Self::Capacity),
            other => Err(ProtocolError::UnknownValue {
                field: "fault code",
                value: u64::from(other),
            }),
        }
    }
}

/// A host refusal with bounded UTF-8 detail.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fault {
    pub code: FaultCode,
    detail: String,
}

impl Fault {
    pub fn new(code: FaultCode, detail: impl Into<String>) -> Result<Self, ProtocolError> {
        let detail = detail.into();
        if detail.len() > MAX_FAULT_DETAIL_BYTES {
            return Err(ProtocolError::FaultDetailTooLong {
                actual: detail.len(),
                max: MAX_FAULT_DETAIL_BYTES,
            });
        }
        Ok(Self { code, detail })
    }

    pub fn detail(&self) -> &str {
        &self.detail
    }
}

/// Frame direction, used to reject a response injected on the request side or
/// vice versa before any host operation is considered.
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
pub enum Direction {
    ClientToHost,
    HostToClient,
}

/// Frozen V1 operation discriminants.
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
#[repr(u16)]
pub enum MessageKind {
    Hello = 1,
    Ready = 2,
    Create = 3,
    Created = 4,
    Submit = 5,
    Applied = 6,
    Feedback = 7,
    Destroy = 8,
    Destroyed = 9,
    Shutdown = 10,
    Bye = 11,
    Fault = 12,
}

impl MessageKind {
    /// The complete Play-time vocabulary. Its exactness is a security property:
    /// provisioning or arbitrary-command operations do not belong here.
    pub const ALL: &'static [Self] = &[
        Self::Hello,
        Self::Ready,
        Self::Create,
        Self::Created,
        Self::Submit,
        Self::Applied,
        Self::Feedback,
        Self::Destroy,
        Self::Destroyed,
        Self::Shutdown,
        Self::Bye,
        Self::Fault,
    ];

    fn decode(value: u16) -> Result<Self, ProtocolError> {
        match value {
            1 => Ok(Self::Hello),
            2 => Ok(Self::Ready),
            3 => Ok(Self::Create),
            4 => Ok(Self::Created),
            5 => Ok(Self::Submit),
            6 => Ok(Self::Applied),
            7 => Ok(Self::Feedback),
            8 => Ok(Self::Destroy),
            9 => Ok(Self::Destroyed),
            10 => Ok(Self::Shutdown),
            11 => Ok(Self::Bye),
            12 => Ok(Self::Fault),
            other => Err(ProtocolError::UnknownMessageKind(other)),
        }
    }

    pub const fn direction(self) -> Direction {
        match self {
            Self::Hello | Self::Create | Self::Submit | Self::Destroy | Self::Shutdown => {
                Direction::ClientToHost
            }
            Self::Ready
            | Self::Created
            | Self::Applied
            | Self::Feedback
            | Self::Destroyed
            | Self::Bye
            | Self::Fault => Direction::HostToClient,
        }
    }

    /// Required finite wait bound for request kinds. Response/event kinds do
    /// not initiate a round trip and therefore return `None`.
    pub const fn round_trip_timeout(self) -> Option<Duration> {
        match self {
            Self::Hello => Some(HELLO_TIMEOUT),
            Self::Create => Some(CREATE_TIMEOUT),
            Self::Submit => Some(SUBMIT_TIMEOUT),
            Self::Destroy => Some(DESTROY_TIMEOUT),
            Self::Shutdown => Some(SHUTDOWN_TIMEOUT),
            _ => None,
        }
    }
}

/// One canonical cross-language V1 conformance vector.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct V1GoldenFrame {
    pub kind: MessageKind,
    /// Uppercase hexadecimal encoding of the complete header and payload.
    pub hex: &'static str,
}

/// Canonical byte corpus for all twelve V1 message kinds.
///
/// Fixtures use nonce `00..1F`, SDK hash `A5 * 32`, catalog hash `5A * 32`,
/// catalog resource count 228, controller 7, sequence 1, DualSense `054C:0CE6`, and the
/// same full pad state as the standalone Submit vector. C# must mirror these
/// literal bytes rather than merely round-tripping its own encoder.
pub const V1_GOLDEN_FRAMES: &[V1GoldenFrame] = &[
    V1GoldenFrame {
        kind: MessageKind::Hello,
        hex: "4B535848010001000100000020000000000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F",
    },
    V1GoldenFrame {
        kind: MessageKind::Ready,
        hex: "4B535848010002000200000062000000000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1FA5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A55A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5AE400",
    },
    V1GoldenFrame {
        kind: MessageKind::Create,
        hex: "4B53584801000300030000000100000001",
    },
    V1GoldenFrame {
        kind: MessageKind::Created,
        hex: "4B53584801000400040000000900000007000000014C05E60C",
    },
    V1GoldenFrame {
        kind: MessageKind::Submit,
        hex: "4B535848010005000500000018000000070000000100000000000000011012340080FFFF3412FF7F",
    },
    V1GoldenFrame {
        kind: MessageKind::Applied,
        hex: "4B53584801000600060000000C000000070000000100000000000000",
    },
    V1GoldenFrame {
        kind: MessageKind::Feedback,
        hex: "4B53584801000700000000001300000007000000010000000000000004033000AA5503",
    },
    V1GoldenFrame {
        kind: MessageKind::Destroy,
        hex: "4B53584801000800080000000400000007000000",
    },
    V1GoldenFrame {
        kind: MessageKind::Destroyed,
        hex: "4B53584801000900090000000400000007000000",
    },
    V1GoldenFrame {
        kind: MessageKind::Shutdown,
        hex: "4B53584801000A000A00000000000000",
    },
    V1GoldenFrame {
        kind: MessageKind::Bye,
        hex: "4B53584801000B000B00000000000000",
    },
    V1GoldenFrame {
        kind: MessageKind::Fault,
        hex: "4B53584801000C000C00000006000000070002007631",
    },
];

/// One typed protocol message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Message {
    Hello {
        nonce: [u8; NONCE_BYTES],
    },
    Ready(HostReady),
    Create {
        profile: ProfileId,
    },
    Created(ControllerReady),
    Submit {
        controller: ControllerId,
        sequence: u64,
        state: PadState,
    },
    Applied {
        controller: ControllerId,
        sequence: u64,
    },
    Feedback(HostFeedback),
    Destroy {
        controller: ControllerId,
    },
    Destroyed {
        controller: ControllerId,
    },
    Shutdown,
    Bye,
    Fault(Fault),
}

impl Message {
    pub const fn kind(&self) -> MessageKind {
        match self {
            Self::Hello { .. } => MessageKind::Hello,
            Self::Ready(_) => MessageKind::Ready,
            Self::Create { .. } => MessageKind::Create,
            Self::Created(_) => MessageKind::Created,
            Self::Submit { .. } => MessageKind::Submit,
            Self::Applied { .. } => MessageKind::Applied,
            Self::Feedback(_) => MessageKind::Feedback,
            Self::Destroy { .. } => MessageKind::Destroy,
            Self::Destroyed { .. } => MessageKind::Destroyed,
            Self::Shutdown => MessageKind::Shutdown,
            Self::Bye => MessageKind::Bye,
            Self::Fault(_) => MessageKind::Fault,
        }
    }

    pub const fn direction(&self) -> Direction {
        self.kind().direction()
    }

    fn validate(&self) -> Result<(), ProtocolError> {
        match self {
            Self::Submit {
                sequence, state, ..
            } => {
                validate_sequence(*sequence)?;
                let unknown = state.buttons.bits() & !XButtons::all().bits();
                if unknown != 0 {
                    return Err(ProtocolError::UnknownButtonBits(unknown));
                }
            }
            Self::Applied { sequence, .. } => validate_sequence(*sequence)?,
            Self::Feedback(feedback) => validate_sequence(feedback.sequence)?,
            Self::Created(ready) if ready.vid == 0 || ready.pid == 0 => {
                return Err(ProtocolError::ZeroUsbIdentity)
            }
            _ => {}
        }
        Ok(())
    }
}

/// A validated message plus its conversation id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame {
    request_id: u32,
    message: Message,
}

impl Frame {
    /// Build a valid frame. Request id zero is reserved for unsolicited host
    /// events (`Feedback` and asynchronous `Fault`).
    pub fn new(request_id: u32, message: Message) -> Result<Self, ProtocolError> {
        message.validate()?;
        match message.kind() {
            MessageKind::Feedback if request_id != 0 => {
                return Err(ProtocolError::InvalidRequestId {
                    kind: MessageKind::Feedback,
                    request_id,
                })
            }
            MessageKind::Feedback => {}
            MessageKind::Fault => {}
            _ if request_id == 0 => {
                return Err(ProtocolError::InvalidRequestId {
                    kind: message.kind(),
                    request_id,
                })
            }
            _ => {}
        }
        Ok(Self {
            request_id,
            message,
        })
    }

    pub const fn request_id(&self) -> u32 {
        self.request_id
    }

    pub const fn message(&self) -> &Message {
        &self.message
    }

    pub fn into_message(self) -> Message {
        self.message
    }

    /// Encode exactly one little-endian V1 frame.
    pub fn encode(&self) -> Vec<u8> {
        let payload = encode_payload(&self.message);
        debug_assert!(payload.len() <= MAX_PAYLOAD_BYTES);
        let mut out = Vec::with_capacity(HEADER_BYTES + payload.len());
        out.extend_from_slice(&PROTOCOL_MAGIC);
        push_u16(&mut out, PROTOCOL_VERSION);
        push_u16(&mut out, self.message.kind() as u16);
        push_u32(&mut out, self.request_id);
        push_u32(&mut out, payload.len() as u32);
        out.extend_from_slice(&payload);
        out
    }

    /// Decode exactly one frame. A concatenated second frame is trailing data,
    /// not silently ignored input.
    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        if bytes.len() < HEADER_BYTES {
            return Err(ProtocolError::FrameTooShort {
                actual: bytes.len(),
                needed: HEADER_BYTES,
            });
        }
        if bytes[..4] != PROTOCOL_MAGIC {
            return Err(ProtocolError::BadMagic);
        }
        let version = u16::from_le_bytes([bytes[4], bytes[5]]);
        if version != PROTOCOL_VERSION {
            return Err(ProtocolError::VersionMismatch {
                expected: PROTOCOL_VERSION,
                actual: version,
            });
        }
        let kind = MessageKind::decode(u16::from_le_bytes([bytes[6], bytes[7]]))?;
        let request_id = u32::from_le_bytes(bytes[8..12].try_into().expect("fixed header"));
        let declared = u32::from_le_bytes(bytes[12..16].try_into().expect("fixed header")) as usize;
        if declared > MAX_PAYLOAD_BYTES {
            return Err(ProtocolError::PayloadTooLarge {
                actual: declared,
                max: MAX_PAYLOAD_BYTES,
            });
        }
        let actual = bytes.len() - HEADER_BYTES;
        if actual != declared {
            return Err(ProtocolError::PayloadLengthMismatch { declared, actual });
        }
        let message = decode_payload(kind, &bytes[HEADER_BYTES..])?;
        Self::new(request_id, message)
    }
}

/// Why a byte sequence is not one valid V1 frame.
#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
#[non_exhaustive]
pub enum ProtocolError {
    #[error("host frame is {actual} bytes; the header alone needs {needed}")]
    FrameTooShort { actual: usize, needed: usize },
    #[error("host frame magic is not KSXH")]
    BadMagic,
    #[error("host protocol version is {actual}; this build requires exactly {expected}")]
    VersionMismatch { expected: u16, actual: u16 },
    #[error("unknown host message kind {0}")]
    UnknownMessageKind(u16),
    #[error("host payload is {actual} bytes; the protocol maximum is {max}")]
    PayloadTooLarge { actual: usize, max: usize },
    #[error("host payload declares {declared} bytes but the frame carries {actual}")]
    PayloadLengthMismatch { declared: usize, actual: usize },
    #[error("{kind:?} payload is {actual} bytes; expected {expected}")]
    WrongPayloadSize {
        kind: MessageKind,
        expected: usize,
        actual: usize,
    },
    #[error("unknown {field} value {value}")]
    UnknownValue { field: &'static str, value: u64 },
    #[error("controller id zero is reserved and never names a controller")]
    ZeroControllerId,
    #[error("controller state/feedback sequence zero is reserved")]
    ZeroSequence,
    #[error("USB identity may not contain VID or PID zero")]
    ZeroUsbIdentity,
    #[error("pad state carries unknown XInput button bits 0x{0:04x}")]
    UnknownButtonBits(u16),
    #[error("request id {request_id} is invalid for {kind:?}")]
    InvalidRequestId { kind: MessageKind, request_id: u32 },
    #[error("fault detail is {actual} bytes; the maximum is {max}")]
    FaultDetailTooLong { actual: usize, max: usize },
    #[error("fault detail is not valid UTF-8")]
    FaultDetailUtf8,
    #[error("feedback flags contain unknown bits 0x{0:02x}")]
    UnknownFeedbackFlags(u8),
}

fn validate_sequence(sequence: u64) -> Result<(), ProtocolError> {
    if sequence == 0 {
        Err(ProtocolError::ZeroSequence)
    } else {
        Ok(())
    }
}

fn expect_size(kind: MessageKind, payload: &[u8], expected: usize) -> Result<(), ProtocolError> {
    if payload.len() == expected {
        Ok(())
    } else {
        Err(ProtocolError::WrongPayloadSize {
            kind,
            expected,
            actual: payload.len(),
        })
    }
}

fn encode_payload(message: &Message) -> Vec<u8> {
    let mut out = Vec::new();
    match message {
        Message::Hello { nonce } => out.extend_from_slice(nonce),
        Message::Ready(ready) => {
            out.extend_from_slice(&ready.nonce);
            out.extend_from_slice(&ready.sdk_sha256);
            out.extend_from_slice(&ready.catalog_sha256);
            push_u16(&mut out, ready.catalog_resource_count);
        }
        Message::Create { profile } => out.push(*profile as u8),
        Message::Created(ready) => {
            push_u32(&mut out, ready.controller.raw());
            out.push(ready.profile as u8);
            push_u16(&mut out, ready.vid);
            push_u16(&mut out, ready.pid);
        }
        Message::Submit {
            controller,
            sequence,
            state,
        } => {
            push_u32(&mut out, controller.raw());
            push_u64(&mut out, *sequence);
            push_pad_state(&mut out, state);
        }
        Message::Applied {
            controller,
            sequence,
        } => {
            push_u32(&mut out, controller.raw());
            push_u64(&mut out, *sequence);
        }
        Message::Feedback(feedback) => {
            push_u32(&mut out, feedback.controller.raw());
            push_u64(&mut out, feedback.sequence);
            out.push(feedback.source as u8);
            let flags = u8::from(feedback.motors_valid) | (u8::from(feedback.led_valid) << 1);
            out.push(flags);
            push_u16(&mut out, feedback.report_len);
            out.push(feedback.large_motor);
            out.push(feedback.small_motor);
            out.push(feedback.led_number);
        }
        Message::Destroy { controller } | Message::Destroyed { controller } => {
            push_u32(&mut out, controller.raw());
        }
        Message::Shutdown | Message::Bye => {}
        Message::Fault(fault) => {
            push_u16(&mut out, fault.code as u16);
            push_u16(&mut out, fault.detail.len() as u16);
            out.extend_from_slice(fault.detail.as_bytes());
        }
    }
    out
}

fn decode_payload(kind: MessageKind, payload: &[u8]) -> Result<Message, ProtocolError> {
    match kind {
        MessageKind::Hello => {
            expect_size(kind, payload, NONCE_BYTES)?;
            Ok(Message::Hello {
                nonce: payload.try_into().expect("size checked"),
            })
        }
        MessageKind::Ready => {
            const READY_BYTES: usize = NONCE_BYTES + 32 + 32 + 2;
            expect_size(kind, payload, READY_BYTES)?;
            Ok(Message::Ready(HostReady {
                nonce: payload[0..32].try_into().expect("size checked"),
                sdk_sha256: payload[32..64].try_into().expect("size checked"),
                catalog_sha256: payload[64..96].try_into().expect("size checked"),
                catalog_resource_count: u16::from_le_bytes(
                    payload[96..98].try_into().expect("size checked"),
                ),
            }))
        }
        MessageKind::Create => {
            expect_size(kind, payload, 1)?;
            Ok(Message::Create {
                profile: ProfileId::decode(payload[0])?,
            })
        }
        MessageKind::Created => {
            expect_size(kind, payload, 9)?;
            Ok(Message::Created(ControllerReady {
                controller: ControllerId::new(read_u32(payload, 0))?,
                profile: ProfileId::decode(payload[4])?,
                vid: read_u16(payload, 5),
                pid: read_u16(payload, 7),
            }))
        }
        MessageKind::Submit => {
            expect_size(kind, payload, 24)?;
            Ok(Message::Submit {
                controller: ControllerId::new(read_u32(payload, 0))?,
                sequence: read_u64(payload, 4),
                state: read_pad_state(payload, 12)?,
            })
        }
        MessageKind::Applied => {
            expect_size(kind, payload, 12)?;
            Ok(Message::Applied {
                controller: ControllerId::new(read_u32(payload, 0))?,
                sequence: read_u64(payload, 4),
            })
        }
        MessageKind::Feedback => {
            expect_size(kind, payload, 19)?;
            let flags = payload[13];
            if flags & !0b11 != 0 {
                return Err(ProtocolError::UnknownFeedbackFlags(flags));
            }
            Ok(Message::Feedback(HostFeedback {
                controller: ControllerId::new(read_u32(payload, 0))?,
                sequence: read_u64(payload, 4),
                source: FeedbackSource::decode(payload[12])?,
                report_len: read_u16(payload, 14),
                large_motor: payload[16],
                small_motor: payload[17],
                led_number: payload[18],
                motors_valid: flags & 1 != 0,
                led_valid: flags & 2 != 0,
            }))
        }
        MessageKind::Destroy => {
            expect_size(kind, payload, 4)?;
            Ok(Message::Destroy {
                controller: ControllerId::new(read_u32(payload, 0))?,
            })
        }
        MessageKind::Destroyed => {
            expect_size(kind, payload, 4)?;
            Ok(Message::Destroyed {
                controller: ControllerId::new(read_u32(payload, 0))?,
            })
        }
        MessageKind::Shutdown => {
            expect_size(kind, payload, 0)?;
            Ok(Message::Shutdown)
        }
        MessageKind::Bye => {
            expect_size(kind, payload, 0)?;
            Ok(Message::Bye)
        }
        MessageKind::Fault => {
            if payload.len() < 4 {
                return Err(ProtocolError::WrongPayloadSize {
                    kind,
                    expected: 4,
                    actual: payload.len(),
                });
            }
            let detail_len = usize::from(read_u16(payload, 2));
            if detail_len > MAX_FAULT_DETAIL_BYTES {
                return Err(ProtocolError::FaultDetailTooLong {
                    actual: detail_len,
                    max: MAX_FAULT_DETAIL_BYTES,
                });
            }
            let declared = 4 + detail_len;
            if payload.len() != declared {
                return Err(ProtocolError::WrongPayloadSize {
                    kind,
                    expected: declared,
                    actual: payload.len(),
                });
            }
            let detail =
                std::str::from_utf8(&payload[4..]).map_err(|_| ProtocolError::FaultDetailUtf8)?;
            Ok(Message::Fault(Fault::new(
                FaultCode::decode(read_u16(payload, 0))?,
                detail,
            )?))
        }
    }
}

fn push_pad_state(out: &mut Vec<u8>, state: &PadState) {
    push_u16(out, state.buttons.bits());
    out.push(state.lt);
    out.push(state.rt);
    push_i16(out, state.lx);
    push_i16(out, state.ly);
    push_i16(out, state.rx);
    push_i16(out, state.ry);
}

fn read_pad_state(bytes: &[u8], at: usize) -> Result<PadState, ProtocolError> {
    let bits = read_u16(bytes, at);
    let buttons = XButtons::from_bits(bits)
        .ok_or_else(|| ProtocolError::UnknownButtonBits(bits & !XButtons::all().bits()))?;
    Ok(PadState {
        buttons,
        lt: bytes[at + 2],
        rt: bytes[at + 3],
        lx: read_i16(bytes, at + 4),
        ly: read_i16(bytes, at + 6),
        rx: read_i16(bytes, at + 8),
        ry: read_i16(bytes, at + 10),
    })
}

fn push_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_i16(out: &mut Vec<u8>, value: i16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_u64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn read_u16(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes(bytes[at..at + 2].try_into().expect("payload size checked"))
}

fn read_i16(bytes: &[u8], at: usize) -> i16 {
    i16::from_le_bytes(bytes[at..at + 2].try_into().expect("payload size checked"))
}

fn read_u32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().expect("payload size checked"))
}

fn read_u64(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().expect("payload size checked"))
}

/// A transport which can perform one correlated request/response and poll one
/// unsolicited host event without blocking.
///
/// The Windows named-pipe implementation owns its reader thread and correlates
/// replies by `request_id`; keeping those mechanics out of [`HostClient`] makes
/// this state machine independently testable and keeps OS authority at the edge.
pub trait HostTransport: Send {
    /// Complete the request or return by `timeout`. Implementations must never
    /// treat the value as advisory or substitute an infinite wait.
    fn round_trip(
        &mut self,
        request: Frame,
        timeout: Duration,
    ) -> Result<Frame, HostTransportError>;
    fn try_receive(&mut self) -> Result<Option<Frame>, HostTransportError>;
}

/// A transport failure, distinct from a well-formed [`Fault`] returned by the
/// host.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum HostTransportError {
    #[error("the HIDMaestro host transport closed")]
    Closed,
    #[error("the HIDMaestro host transport operation timed out")]
    TimedOut,
    #[error("the HIDMaestro host exited with code {code}")]
    ChildExited { code: u32 },
    #[error("a HIDMaestro host request is already in flight")]
    RequestAlreadyInFlight,
    #[error("transport was asked to send host-to-client message kind {0:?}")]
    InvalidRequestMessage(MessageKind),
    #[error("host response id {actual} did not match the one in-flight request {expected}")]
    UnexpectedResponseId { expected: u32, actual: u32 },
    #[error("host response id {actual} arrived with no request in flight")]
    UnexpectedResponseWithoutRequest { actual: u32 },
    #[error("the host sent client-to-host message kind {0:?} on its response stream")]
    UnexpectedPeerMessage(MessageKind),
    #[error("HIDMaestro host transport I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("HIDMaestro host protocol failed: {0}")]
    Protocol(#[from] ProtocolError),
}

/// Errors enforcing the request/response and controller-ownership contract.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum HostClientError {
    #[error(transparent)]
    Transport(#[from] HostTransportError),
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    #[error("HIDMaestro host refused with {code:?}: {detail}")]
    HostFault { code: FaultCode, detail: String },
    #[error("host answered request {expected} as request {actual}")]
    RequestIdMismatch { expected: u32, actual: u32 },
    #[error("host answered with {actual:?}; expected {expected:?}")]
    UnexpectedResponse {
        expected: MessageKind,
        actual: MessageKind,
    },
    #[error("HIDMaestro host did not echo the connection nonce")]
    NonceMismatch,
    #[error("host created profile {actual:?}; requested {expected:?}")]
    ProfileMismatch {
        expected: ProfileId,
        actual: ProfileId,
    },
    #[error("host loaded a different HIDMaestro SDK than the pinned manifest")]
    SdkIdentityMismatch,
    #[error("host loaded a different HIDMaestro profile catalog than the pinned manifest")]
    CatalogIdentityMismatch,
    #[error(
        "host catalog contains {actual} embedded resources; the pinned manifest requires {expected}"
    )]
    CatalogResourceCountMismatch { expected: u16, actual: u16 },
    #[error(
        "host created {profile:?} as {actual_vid:04x}:{actual_pid:04x}; expected {expected_vid:04x}:{expected_pid:04x}"
    )]
    UsbIdentityMismatch {
        profile: ProfileId,
        expected_vid: u16,
        expected_pid: u16,
        actual_vid: u16,
        actual_pid: u16,
    },
    #[error("host answered for controller {actual}; expected {expected}")]
    ControllerMismatch { expected: u32, actual: u32 },
    #[error("host acknowledged state sequence {actual}; expected {expected}")]
    SequenceMismatch { expected: u64, actual: u64 },
    #[error("host reused controller id {0} within one conversation")]
    DuplicateController(u32),
    #[error("controller {0} is not owned by this host client")]
    UnknownController(u32),
    #[error("all {max} controller identities have already been issued in this conversation")]
    ControllerLimitReached { max: usize },
    #[error("the HIDMaestro host client is already shut down")]
    Closed,
    #[error("host request id space is exhausted")]
    RequestIdExhausted,
    #[error("controller {0} state sequence space is exhausted")]
    SequenceExhausted(u32),
    #[error("unsolicited host event carried request id {0}; events require id zero")]
    UnexpectedEventRequestId(u32),
    #[error("controller {controller} feedback sequence {actual} did not advance past {previous}")]
    StaleFeedbackSequence {
        controller: u32,
        previous: u64,
        actual: u64,
    },
}

impl From<Fault> for HostClientError {
    fn from(fault: Fault) -> Self {
        Self::HostFault {
            code: fault.code,
            detail: fault.detail,
        }
    }
}

/// Transport-independent owner of one correlated host conversation.
///
/// The nonce detects crossed conversations and [`HostExpectation`] rejects
/// dependency drift. Neither authenticates the peer: the OS transport must
/// verify the server PID, token, image and pipe ACL before using this type.
///
/// It does not implement `Drop` by sending IPC: a destructor must not perform a
/// potentially blocking round trip. The future backend explicitly calls
/// [`HostClient::shutdown`], while the OS transport treats pipe EOF as the
/// second cleanup path.
#[derive(Clone, Copy, Debug, Default)]
struct ControllerSession {
    state_sequence: u64,
    feedback_sequence: u64,
}

pub struct HostClient<T: HostTransport> {
    transport: Option<T>,
    ready: HostReady,
    controllers: BTreeMap<ControllerId, ControllerSession>,
    /// Controller ids are never accepted twice within one host conversation,
    /// even after destroy. Otherwise delayed feedback could be attributed to a
    /// different virtual controller which inherited the same opaque id.
    issued_controllers: BTreeSet<ControllerId>,
    // `u32::MAX` is a valid nonzero V1 request id. Keep the next value one
    // bit wider so that value can be issued once before exhaustion is latched.
    next_request_id: u64,
    closed: bool,
}

impl<T: HostTransport> HostClient<T> {
    /// Perform the mandatory nonce handshake.
    pub fn connect(
        mut transport: T,
        nonce: [u8; NONCE_BYTES],
        expected: HostExpectation,
    ) -> Result<Self, HostClientError> {
        let request_id = 1;
        let response = transport.round_trip(
            Frame::new(request_id, Message::Hello { nonce })?,
            HELLO_TIMEOUT,
        )?;
        if response.request_id() != request_id {
            return Err(HostClientError::RequestIdMismatch {
                expected: request_id,
                actual: response.request_id(),
            });
        }
        let ready = match response.into_message() {
            Message::Ready(ready) => ready,
            Message::Fault(fault) => return Err(fault.into()),
            other => {
                return Err(HostClientError::UnexpectedResponse {
                    expected: MessageKind::Ready,
                    actual: other.kind(),
                })
            }
        };
        if ready.nonce != nonce {
            return Err(HostClientError::NonceMismatch);
        }
        if ready.sdk_sha256 != expected.sdk_sha256 {
            return Err(HostClientError::SdkIdentityMismatch);
        }
        if ready.catalog_sha256 != expected.catalog_sha256 {
            return Err(HostClientError::CatalogIdentityMismatch);
        }
        if ready.catalog_resource_count != expected.catalog_resource_count {
            return Err(HostClientError::CatalogResourceCountMismatch {
                expected: expected.catalog_resource_count,
                actual: ready.catalog_resource_count,
            });
        }
        Ok(Self {
            transport: Some(transport),
            ready,
            controllers: BTreeMap::new(),
            issued_controllers: BTreeSet::new(),
            next_request_id: 2,
            closed: false,
        })
    }

    pub const fn ready(&self) -> &HostReady {
        &self.ready
    }

    pub fn create(&mut self, profile: ProfileId) -> Result<ControllerReady, HostClientError> {
        self.ensure_open()?;
        if self.issued_controllers.len() >= MAX_CONTROLLERS_PER_SESSION {
            return Err(HostClientError::ControllerLimitReached {
                max: MAX_CONTROLLERS_PER_SESSION,
            });
        }
        let response = self.request(Message::Create { profile })?;
        let ready = match response {
            Message::Created(ready) => ready,
            other => {
                self.poison();
                return Err(HostClientError::UnexpectedResponse {
                    expected: MessageKind::Created,
                    actual: other.kind(),
                });
            }
        };
        if ready.profile != profile {
            self.poison();
            return Err(HostClientError::ProfileMismatch {
                expected: profile,
                actual: ready.profile,
            });
        }
        let (expected_vid, expected_pid) = profile.usb_identity();
        if (ready.vid, ready.pid) != (expected_vid, expected_pid) {
            self.poison();
            return Err(HostClientError::UsbIdentityMismatch {
                profile,
                expected_vid,
                expected_pid,
                actual_vid: ready.vid,
                actual_pid: ready.pid,
            });
        }
        if !self.issued_controllers.insert(ready.controller) {
            self.poison();
            return Err(HostClientError::DuplicateController(ready.controller.raw()));
        }
        let replaced = self
            .controllers
            .insert(ready.controller, ControllerSession::default());
        debug_assert!(replaced.is_none(), "issued id was unexpectedly live");
        Ok(ready)
    }

    /// Submit one complete state and wait until the host says the supported SDK
    /// accepted it. The sequence advances only after that acknowledgement, so a
    /// failed send cannot falsely advance local state.
    ///
    /// V1 deliberately pays one synchronous request/`Applied` round trip per
    /// submit. If the host applies a state but its acknowledgement is lost, the
    /// transport error closes this client; callers must drop the conversation
    /// and let EOF cleanup run rather than guessing whether a retry is safe.
    /// The caller also resubmits the unchanged cached state at
    /// [`CLIENT_LEASE_REFRESH_INTERVAL`]; this refreshes the host lease without
    /// making the ordinary client responsible for the 16 ms SDK pump.
    pub fn submit(
        &mut self,
        controller: ControllerId,
        state: PadState,
    ) -> Result<u64, HostClientError> {
        self.ensure_open()?;
        let previous = self
            .controllers
            .get(&controller)
            .ok_or(HostClientError::UnknownController(controller.raw()))?
            .state_sequence;
        let sequence = previous
            .checked_add(1)
            .ok_or(HostClientError::SequenceExhausted(controller.raw()))?;
        let response = self.request(Message::Submit {
            controller,
            sequence,
            state,
        })?;
        match response {
            Message::Applied {
                controller: actual_controller,
                sequence: actual_sequence,
            } => {
                if actual_controller != controller {
                    self.poison();
                    return Err(HostClientError::ControllerMismatch {
                        expected: controller.raw(),
                        actual: actual_controller.raw(),
                    });
                }
                if actual_sequence != sequence {
                    self.poison();
                    return Err(HostClientError::SequenceMismatch {
                        expected: sequence,
                        actual: actual_sequence,
                    });
                }
            }
            other => {
                self.poison();
                return Err(HostClientError::UnexpectedResponse {
                    expected: MessageKind::Applied,
                    actual: other.kind(),
                });
            }
        }
        self.controllers
            .get_mut(&controller)
            .expect("owned controller was checked above")
            .state_sequence = sequence;
        Ok(sequence)
    }

    /// Poll one asynchronous full effective-feedback snapshot. This method
    /// never asks a transport to wait. Sequence gaps are expected when a
    /// bounded host/transport queue drops old snapshots; non-advancing values
    /// are rejected as stale or replayed.
    pub fn poll_feedback(&mut self) -> Result<Option<HostFeedback>, HostClientError> {
        self.ensure_open()?;
        // At most one bounded queue can be drained in a call. This skips
        // Destroyed-race tombstones without letting a broken transport produce
        // an infinite stream and pin the caller.
        for _ in 0..MAX_QUEUED_FEEDBACK {
            let pending_result = self
                .transport
                .as_mut()
                .ok_or(HostClientError::Closed)?
                .try_receive();
            let pending = match pending_result {
                Ok(pending) => pending,
                Err(error) => {
                    self.poison();
                    return Err(error.into());
                }
            };
            let Some(frame) = pending else {
                return Ok(None);
            };
            if frame.request_id() != 0 {
                self.poison();
                return Err(HostClientError::UnexpectedEventRequestId(
                    frame.request_id(),
                ));
            }
            match frame.into_message() {
                Message::Feedback(feedback) => {
                    let Some(session) = self.controllers.get_mut(&feedback.controller) else {
                        if self.issued_controllers.contains(&feedback.controller) {
                            // The callback raced with Destroyed. IDs are never
                            // reused in this conversation, so this queued snapshot
                            // can only belong to the tombstoned controller.
                            continue;
                        }
                        self.poison();
                        return Err(HostClientError::UnknownController(
                            feedback.controller.raw(),
                        ));
                    };
                    let previous = session.feedback_sequence;
                    if feedback.sequence <= previous {
                        self.poison();
                        return Err(HostClientError::StaleFeedbackSequence {
                            controller: feedback.controller.raw(),
                            previous,
                            actual: feedback.sequence,
                        });
                    }
                    session.feedback_sequence = feedback.sequence;
                    return Ok(Some(feedback));
                }
                Message::Fault(fault) => {
                    self.poison();
                    return Err(fault.into());
                }
                other => {
                    self.poison();
                    return Err(HostClientError::UnexpectedResponse {
                        expected: MessageKind::Feedback,
                        actual: other.kind(),
                    });
                }
            }
        }
        Ok(None)
    }

    pub fn destroy(&mut self, controller: ControllerId) -> Result<(), HostClientError> {
        self.ensure_open()?;
        if !self.controllers.contains_key(&controller) {
            return Err(HostClientError::UnknownController(controller.raw()));
        }
        let response = self.request(Message::Destroy { controller })?;
        match response {
            Message::Destroyed { controller: actual } if actual == controller => {}
            Message::Destroyed { controller: actual } => {
                self.poison();
                return Err(HostClientError::ControllerMismatch {
                    expected: controller.raw(),
                    actual: actual.raw(),
                });
            }
            other => {
                self.poison();
                return Err(HostClientError::UnexpectedResponse {
                    expected: MessageKind::Destroyed,
                    actual: other.kind(),
                });
            }
        }
        self.controllers.remove(&controller);
        Ok(())
    }

    /// Ask the host to neutralize and destroy anything still owned by this
    /// conversation, then close it.
    pub fn shutdown(&mut self) -> Result<(), HostClientError> {
        self.ensure_open()?;
        let response = self.request(Message::Shutdown)?;
        match response {
            Message::Bye => {
                self.controllers.clear();
                self.poison();
                Ok(())
            }
            other => {
                self.poison();
                Err(HostClientError::UnexpectedResponse {
                    expected: MessageKind::Bye,
                    actual: other.kind(),
                })
            }
        }
    }

    pub const fn is_closed(&self) -> bool {
        self.closed
    }

    /// Controller ids this client still presumes are live.
    ///
    /// V1 has no asynchronous lease-expired event. If the host watchdog has
    /// already removed one of these controllers, the next operation for it
    /// returns `UnknownController` and poisons the conversation. Expiry is an
    /// exceptional safety path; this iterator is not an authoritative host
    /// inventory.
    pub fn live_controllers(&self) -> impl Iterator<Item = ControllerId> + '_ {
        self.controllers.keys().copied()
    }

    fn request(&mut self, message: Message) -> Result<Message, HostClientError> {
        self.ensure_open()?;
        let timeout = message
            .kind()
            .round_trip_timeout()
            .expect("HostClient only sends request message kinds");
        debug_assert!(!timeout.is_zero());
        let request_id = self.take_request_id()?;
        let request = Frame::new(request_id, message)?;
        let response_result = self
            .transport
            .as_mut()
            .ok_or(HostClientError::Closed)?
            .round_trip(request, timeout);
        let response = match response_result {
            Ok(response) => response,
            Err(error) => {
                self.poison();
                return Err(error.into());
            }
        };
        if response.request_id() != request_id {
            self.poison();
            return Err(HostClientError::RequestIdMismatch {
                expected: request_id,
                actual: response.request_id(),
            });
        }
        match response.into_message() {
            Message::Fault(fault) => {
                self.poison();
                Err(fault.into())
            }
            other => Ok(other),
        }
    }

    fn ensure_open(&self) -> Result<(), HostClientError> {
        if self.closed || self.transport.is_none() {
            Err(HostClientError::Closed)
        } else {
            Ok(())
        }
    }

    /// Poisoning is also the cleanup signal: dropping the transport closes the
    /// pipe immediately so the host neutralizes and destroys session-owned
    /// controllers even if the caller retains this unusable client object.
    fn poison(&mut self) {
        self.closed = true;
        self.transport.take();
    }

    fn take_request_id(&mut self) -> Result<u32, HostClientError> {
        if self.next_request_id > u64::from(u32::MAX) {
            self.poison();
            return Err(HostClientError::RequestIdExhausted);
        }
        let id = self.next_request_id as u32;
        self.next_request_id += 1;
        Ok(id)
    }
}

/// Keeps the boxed transport boundary honest.
const _: Option<&'static dyn HostTransport> = None;

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, VecDeque};
    use std::sync::{Arc, Mutex};

    use super::*;

    #[derive(Clone, Debug, PartialEq, Eq)]
    enum Call {
        Hello,
        Create(ProfileId, ControllerId),
        Submit(ControllerId, u64, PadState),
        Neutral(ControllerId),
        Destroy(ControllerId),
        Shutdown,
        Disconnect,
    }

    #[derive(Clone, Copy, Default)]
    struct EffectiveFeedback {
        large_motor: u8,
        small_motor: u8,
        led_number: u8,
        motors_known: bool,
        led_known: bool,
    }

    #[derive(Clone, Copy)]
    struct Live {
        sequence: u64,
        state: PadState,
        feedback: EffectiveFeedback,
        lease_deadline: Duration,
    }

    struct MemoryHost {
        handshaken: bool,
        closed: bool,
        last_request_id: u32,
        next_controller: u32,
        controllers_created: usize,
        next_feedback: u64,
        now: Duration,
        created_vid: u16,
        created_pid: u16,
        live: BTreeMap<ControllerId, Live>,
        feedback: VecDeque<Frame>,
        calls: Vec<Call>,
        round_trip_bounds: Vec<(MessageKind, Duration)>,
    }

    impl Default for MemoryHost {
        fn default() -> Self {
            Self {
                handshaken: false,
                closed: false,
                last_request_id: 0,
                next_controller: 1,
                controllers_created: 0,
                next_feedback: 1,
                now: Duration::ZERO,
                created_vid: 0x054C,
                created_pid: 0x0CE6,
                live: BTreeMap::new(),
                feedback: VecDeque::new(),
                calls: Vec::new(),
                round_trip_bounds: Vec::new(),
            }
        }
    }

    impl MemoryHost {
        fn receive(&mut self, request: Frame) -> Frame {
            let request_id = request.request_id();
            if request.message().direction() != Direction::ClientToHost {
                return fault(
                    request_id,
                    FaultCode::InvalidOrder,
                    "host received a response message",
                );
            }
            if self.closed {
                return fault(request_id, FaultCode::InvalidOrder, "host is closed");
            }
            if request_id <= self.last_request_id {
                return fault(
                    request_id,
                    FaultCode::InvalidOrder,
                    "request id did not advance",
                );
            }
            self.last_request_id = request_id;
            match request.into_message() {
                Message::Hello { nonce } if !self.handshaken => {
                    self.handshaken = true;
                    self.calls.push(Call::Hello);
                    Frame::new(
                        request_id,
                        Message::Ready(HostReady {
                            nonce,
                            sdk_sha256: [0xA5; 32],
                            catalog_sha256: [0x5A; 32],
                            catalog_resource_count: 228,
                        }),
                    )
                    .unwrap()
                }
                Message::Hello { .. } => fault(
                    request_id,
                    FaultCode::InvalidOrder,
                    "hello already completed",
                ),
                _ if !self.handshaken => {
                    fault(request_id, FaultCode::InvalidOrder, "hello must be first")
                }
                Message::Create {
                    profile: ProfileId::DualSense,
                } => {
                    if self.controllers_created >= MAX_CONTROLLERS_PER_SESSION {
                        return fault(
                            request_id,
                            FaultCode::Capacity,
                            "all controller identities are already issued",
                        );
                    }
                    let controller = ControllerId::new(self.next_controller).unwrap();
                    self.next_controller += 1;
                    self.controllers_created += 1;
                    self.live.insert(
                        controller,
                        Live {
                            sequence: 0,
                            state: PadState::default(),
                            feedback: EffectiveFeedback::default(),
                            lease_deadline: self.now + CLIENT_LEASE_TIMEOUT,
                        },
                    );
                    self.calls
                        .push(Call::Create(ProfileId::DualSense, controller));
                    // Initial neutral happens before Created is returned.
                    self.calls.push(Call::Neutral(controller));
                    Frame::new(
                        request_id,
                        Message::Created(ControllerReady {
                            controller,
                            profile: ProfileId::DualSense,
                            vid: self.created_vid,
                            pid: self.created_pid,
                        }),
                    )
                    .unwrap()
                }
                Message::Create { .. } => fault(
                    request_id,
                    FaultCode::UnsupportedProfile,
                    "prototype host supports DualSense only",
                ),
                Message::Submit {
                    controller,
                    sequence,
                    state,
                } => {
                    let Some(live) = self.live.get_mut(&controller) else {
                        return fault(
                            request_id,
                            FaultCode::UnknownController,
                            "controller is not live",
                        );
                    };
                    if sequence <= live.sequence {
                        return fault(
                            request_id,
                            FaultCode::StaleSequence,
                            "state sequence did not advance",
                        );
                    }
                    live.sequence = sequence;
                    live.state = state;
                    live.lease_deadline = self.now + CLIENT_LEASE_TIMEOUT;
                    self.calls.push(Call::Submit(controller, sequence, state));
                    Frame::new(
                        request_id,
                        Message::Applied {
                            controller,
                            sequence,
                        },
                    )
                    .unwrap()
                }
                Message::Destroy { controller } => {
                    if !self.neutralize_destroy(controller) {
                        return fault(
                            request_id,
                            FaultCode::UnknownController,
                            "controller is not live",
                        );
                    }
                    Frame::new(request_id, Message::Destroyed { controller }).unwrap()
                }
                Message::Shutdown => {
                    self.cleanup();
                    self.calls.push(Call::Shutdown);
                    self.closed = true;
                    Frame::new(request_id, Message::Bye).unwrap()
                }
                // Direction was checked above, so these are unreachable unless
                // a new client message is added without a handler here.
                other => fault(
                    request_id,
                    FaultCode::Internal,
                    &format!("unhandled {:?}", other.kind()),
                ),
            }
        }

        fn push_feedback(&mut self, controller: ControllerId, large_motor: u8, small_motor: u8) {
            let effective = &mut self
                .live
                .get_mut(&controller)
                .expect("feedback controller must be live")
                .feedback;
            effective.large_motor = large_motor;
            effective.small_motor = small_motor;
            effective.motors_known = true;
            self.push_effective_feedback(controller, FeedbackSource::OutputDecoded, 48);
        }

        fn push_led_feedback(&mut self, controller: ControllerId, led_number: u8) {
            let effective = &mut self
                .live
                .get_mut(&controller)
                .expect("feedback controller must be live")
                .feedback;
            effective.led_number = led_number;
            effective.led_known = true;
            self.push_effective_feedback(controller, FeedbackSource::HidOutput, 32);
        }

        fn push_effective_feedback(
            &mut self,
            controller: ControllerId,
            source: FeedbackSource,
            report_len: u16,
        ) {
            let sequence = self.next_feedback;
            self.next_feedback += 1;
            let effective = self
                .live
                .get(&controller)
                .expect("feedback controller must be live")
                .feedback;
            let frame = Frame::new(
                0,
                Message::Feedback(HostFeedback {
                    controller,
                    sequence,
                    source,
                    report_len,
                    large_motor: effective.large_motor,
                    small_motor: effective.small_motor,
                    led_number: effective.led_number,
                    motors_valid: effective.motors_known,
                    led_valid: effective.led_known,
                }),
            )
            .unwrap();
            if self.feedback.len() == MAX_QUEUED_FEEDBACK {
                self.feedback.pop_front();
            }
            self.feedback.push_back(frame);
        }

        fn disconnect(&mut self) {
            if self.closed {
                return;
            }
            self.cleanup();
            self.calls.push(Call::Disconnect);
            self.closed = true;
        }

        fn advance_to_and_expire(&mut self, now: Duration) {
            assert!(now >= self.now, "fake host time must be monotonic");
            self.now = now;
            let expired: Vec<_> = self
                .live
                .iter()
                .filter_map(|(controller, live)| {
                    (live.lease_deadline <= now).then_some(*controller)
                })
                .collect();
            for controller in expired {
                let removed = self.neutralize_destroy(controller);
                debug_assert!(removed, "expired controller stopped being live");
            }
        }

        fn cleanup(&mut self) {
            let controllers: Vec<_> = self.live.keys().copied().collect();
            for controller in controllers {
                let removed = self.neutralize_destroy(controller);
                debug_assert!(removed, "cleanup controller stopped being live");
            }
        }

        /// Stop one controller, remove it from the host's live set and purge
        /// any callback snapshots which can no longer describe a live device.
        /// The feedback queue is one conversation-global 64-entry queue, so
        /// removing one controller must preserve other controllers' events.
        fn neutralize_destroy(&mut self, controller: ControllerId) -> bool {
            if !self.live.contains_key(&controller) {
                return false;
            }
            self.calls.push(Call::Neutral(controller));
            self.calls.push(Call::Destroy(controller));
            self.live.remove(&controller);
            self.feedback.retain(|frame| {
                !matches!(
                    frame.message(),
                    Message::Feedback(feedback) if feedback.controller == controller
                )
            });
            true
        }
    }

    fn fault(request_id: u32, code: FaultCode, detail: &str) -> Frame {
        Frame::new(
            request_id,
            Message::Fault(Fault::new(code, detail).unwrap()),
        )
        .unwrap()
    }

    #[derive(Clone)]
    struct Harness(Arc<Mutex<MemoryHost>>);

    impl Harness {
        fn new() -> (Self, MemoryTransport) {
            let host = Arc::new(Mutex::new(MemoryHost::default()));
            (
                Self(host.clone()),
                MemoryTransport {
                    host,
                    disconnected: false,
                    lose_next_response: false,
                },
            )
        }

        fn calls(&self) -> Vec<Call> {
            self.0.lock().unwrap().calls.clone()
        }

        fn push_feedback(&self, controller: ControllerId, large: u8, small: u8) {
            self.0
                .lock()
                .unwrap()
                .push_feedback(controller, large, small);
        }

        fn push_led_feedback(&self, controller: ControllerId, led_number: u8) {
            self.0
                .lock()
                .unwrap()
                .push_led_feedback(controller, led_number);
        }

        fn live_count(&self) -> usize {
            self.0.lock().unwrap().live.len()
        }

        fn queued_feedback_controllers(&self) -> Vec<ControllerId> {
            self.0
                .lock()
                .unwrap()
                .feedback
                .iter()
                .filter_map(|frame| match frame.message() {
                    Message::Feedback(feedback) => Some(feedback.controller),
                    _ => None,
                })
                .collect()
        }

        fn round_trip_bounds(&self) -> Vec<(MessageKind, Duration)> {
            self.0.lock().unwrap().round_trip_bounds.clone()
        }

        fn advance_to_and_expire(&self, now: Duration) {
            self.0.lock().unwrap().advance_to_and_expire(now);
        }

        fn set_next_controller(&self, raw: u32) {
            self.0.lock().unwrap().next_controller = raw;
        }

        fn set_next_feedback(&self, sequence: u64) {
            self.0.lock().unwrap().next_feedback = sequence;
        }

        fn set_created_usb_identity(&self, vid: u16, pid: u16) {
            let mut host = self.0.lock().unwrap();
            host.created_vid = vid;
            host.created_pid = pid;
        }

        fn push_event(&self, frame: Frame) {
            self.0.lock().unwrap().feedback.push_back(frame);
        }
    }

    struct MemoryTransport {
        host: Arc<Mutex<MemoryHost>>,
        disconnected: bool,
        lose_next_response: bool,
    }

    impl HostTransport for MemoryTransport {
        fn round_trip(
            &mut self,
            request: Frame,
            timeout: Duration,
        ) -> Result<Frame, HostTransportError> {
            assert!(
                !timeout.is_zero(),
                "round trips require a finite nonzero bound"
            );
            // Encode/decode on both sides: the fake tests the real byte contract,
            // not a shortcut that hands the enum directly to itself.
            let request = Frame::decode(&request.encode())?;
            let mut host = self.host.lock().unwrap();
            host.round_trip_bounds
                .push((request.message().kind(), timeout));
            let response = host.receive(request);
            drop(host);
            if self.lose_next_response {
                self.lose_next_response = false;
                return Err(HostTransportError::Closed);
            }
            Ok(Frame::decode(&response.encode())?)
        }

        fn try_receive(&mut self) -> Result<Option<Frame>, HostTransportError> {
            let frame = self.host.lock().unwrap().feedback.pop_front();
            frame
                .map(|frame| Frame::decode(&frame.encode()).map_err(Into::into))
                .transpose()
        }
    }

    impl Drop for MemoryTransport {
        fn drop(&mut self) {
            if !self.disconnected {
                self.host
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .disconnect();
                self.disconnected = true;
            }
        }
    }

    fn nonce() -> [u8; NONCE_BYTES] {
        std::array::from_fn(|at| at as u8)
    }

    fn expectation() -> HostExpectation {
        HostExpectation {
            sdk_sha256: [0xA5; 32],
            catalog_sha256: [0x5A; 32],
            catalog_resource_count: 228,
        }
    }

    fn bytes_from_hex(hex: &str) -> Vec<u8> {
        assert_eq!(hex.len() % 2, 0);
        hex.as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let pair = std::str::from_utf8(pair).unwrap();
                u8::from_str_radix(pair, 16).unwrap()
            })
            .collect()
    }

    fn every_v1_frame() -> Vec<(Frame, usize)> {
        let controller = ControllerId::new(7).unwrap();
        let state = PadState {
            buttons: XButtons::DPAD_UP | XButtons::A,
            lt: 0x12,
            rt: 0x34,
            lx: i16::MIN,
            ly: -1,
            rx: 0x1234,
            ry: i16::MAX,
        };
        let messages = [
            (1, Message::Hello { nonce: nonce() }, 32),
            (
                2,
                Message::Ready(HostReady {
                    nonce: nonce(),
                    sdk_sha256: [0xA5; 32],
                    catalog_sha256: [0x5A; 32],
                    catalog_resource_count: 228,
                }),
                98,
            ),
            (
                3,
                Message::Create {
                    profile: ProfileId::DualSense,
                },
                1,
            ),
            (
                4,
                Message::Created(ControllerReady {
                    controller,
                    profile: ProfileId::DualSense,
                    vid: 0x054C,
                    pid: 0x0CE6,
                }),
                9,
            ),
            (
                5,
                Message::Submit {
                    controller,
                    sequence: 1,
                    state,
                },
                24,
            ),
            (
                6,
                Message::Applied {
                    controller,
                    sequence: 1,
                },
                12,
            ),
            (
                0,
                Message::Feedback(HostFeedback {
                    controller,
                    sequence: 1,
                    source: FeedbackSource::OutputDecoded,
                    report_len: 48,
                    large_motor: 0xAA,
                    small_motor: 0x55,
                    led_number: 3,
                    motors_valid: true,
                    led_valid: true,
                }),
                19,
            ),
            (8, Message::Destroy { controller }, 4),
            (9, Message::Destroyed { controller }, 4),
            (10, Message::Shutdown, 0),
            (11, Message::Bye, 0),
            (
                12,
                Message::Fault(Fault::new(FaultCode::Internal, "v1").unwrap()),
                6,
            ),
        ];
        messages
            .into_iter()
            .map(|(request_id, message, payload_bytes)| {
                (Frame::new(request_id, message).unwrap(), payload_bytes)
            })
            .collect()
    }

    /// Exhaustive message vocabulary round-trip. Besides documenting every V1
    /// payload width, truncating each frame at every byte proves all decoder
    /// indexing remains behind an exact-size check.
    #[test]
    fn every_v1_message_has_one_exact_size_and_round_trips() {
        assert_eq!(PROTOCOL_ID, "ksx.hidmaestro.host.v1");
        let frames = every_v1_frame();
        assert_eq!(frames.len(), MessageKind::ALL.len());
        assert_eq!(V1_GOLDEN_FRAMES.len(), MessageKind::ALL.len());
        for (at, ((frame, payload_bytes), golden)) in
            frames.into_iter().zip(V1_GOLDEN_FRAMES).enumerate()
        {
            let encoded = frame.encode();
            assert_eq!(frame.message().kind(), golden.kind);
            assert_eq!(encoded, bytes_from_hex(golden.hex), "{:?}", golden.kind);
            assert_eq!(encoded.len(), HEADER_BYTES + payload_bytes);
            assert_eq!(
                u16::from_le_bytes([encoded[6], encoded[7]]),
                (at + 1) as u16
            );
            assert_eq!(Frame::decode(&encoded).unwrap(), frame);
            for truncated_at in 0..encoded.len() {
                assert!(Frame::decode(&encoded[..truncated_at]).is_err());
            }
            let mut trailing = encoded;
            trailing.push(0);
            assert!(Frame::decode(&trailing).is_err());
        }
    }

    /// A deterministic fuzz-style corpus exercises arbitrary lengths, deeper
    /// valid headers and single-bit corruption without adding a fuzz runtime to
    /// this protocol-only slice. Any bounds bug becomes a test-process panic.
    #[test]
    fn malformed_frame_corpus_never_panics_or_reads_past_bounds() {
        let mut seed = 0xC0DE_CAFE_1234_5678_u64;
        for len in 0..=(MAX_FRAME_BYTES + 64) {
            let mut bytes = vec![0_u8; len];
            for byte in &mut bytes {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                *byte = seed as u8;
            }
            if len >= 4 {
                bytes[..4].copy_from_slice(&PROTOCOL_MAGIC);
            }
            if len >= 6 {
                bytes[4..6].copy_from_slice(&PROTOCOL_VERSION.to_le_bytes());
            }
            if len >= 8 {
                bytes[6..8].copy_from_slice(&(((len % 14) + 1) as u16).to_le_bytes());
            }
            if len >= HEADER_BYTES {
                let declared = if len % 5 == 0 {
                    MAX_PAYLOAD_BYTES + 1
                } else {
                    len.saturating_sub(HEADER_BYTES)
                };
                bytes[12..16].copy_from_slice(&(declared as u32).to_le_bytes());
            }
            let _ = Frame::decode(&bytes);
        }

        for (frame, _) in every_v1_frame() {
            let encoded = frame.encode();
            for byte_at in 0..encoded.len() {
                for bit in 0..8 {
                    let mut mutated = encoded.clone();
                    mutated[byte_at] ^= 1 << bit;
                    let _ = Frame::decode(&mutated);
                }
            }
        }
    }

    /// Cross-language golden vector. This fails if field order, endianness,
    /// header shape, discriminants or PadState width drift independently.
    #[test]
    fn submit_frame_v1_has_one_frozen_byte_layout() {
        let controller = ControllerId::new(7).unwrap();
        let frame = Frame::new(
            0x1122_3344,
            Message::Submit {
                controller,
                sequence: 0x0102_0304_0506_0708,
                state: PadState {
                    buttons: XButtons::DPAD_UP | XButtons::A,
                    lt: 0x12,
                    rt: 0x34,
                    lx: i16::MIN,
                    ly: -1,
                    rx: 0x1234,
                    ry: i16::MAX,
                },
            },
        )
        .unwrap();
        let expected = vec![
            0x4B, 0x53, 0x58, 0x48, // KSXH
            0x01, 0x00, // version 1
            0x05, 0x00, // Submit
            0x44, 0x33, 0x22, 0x11, // request id
            0x18, 0x00, 0x00, 0x00, // 24-byte payload
            0x07, 0x00, 0x00, 0x00, // controller
            0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01, // sequence
            0x01, 0x10, // buttons
            0x12, 0x34, // triggers
            0x00, 0x80, // lx = i16::MIN, preserved on this boundary
            0xFF, 0xFF, // ly = -1
            0x34, 0x12, // rx
            0xFF, 0x7F, // ry
        ];
        assert_eq!(frame.encode(), expected);
        assert_eq!(Frame::decode(&expected).unwrap(), frame);
    }

    /// The broken decoder this catches trusted `payload_len` and only noticed
    /// the lie after allocating or slicing the body.
    #[test]
    fn version_size_and_exact_length_are_rejected_at_the_frame_boundary() {
        let hello = Frame::new(1, Message::Hello { nonce: nonce() })
            .unwrap()
            .encode();

        let mut wrong_version = hello.clone();
        wrong_version[4..6].copy_from_slice(&2u16.to_le_bytes());
        assert!(matches!(
            Frame::decode(&wrong_version),
            Err(ProtocolError::VersionMismatch {
                expected: 1,
                actual: 2
            })
        ));

        let mut oversized = hello.clone();
        oversized[12..16].copy_from_slice(&((MAX_PAYLOAD_BYTES + 1) as u32).to_le_bytes());
        assert!(matches!(
            Frame::decode(&oversized),
            Err(ProtocolError::PayloadTooLarge { .. })
        ));

        let truncated = &hello[..hello.len() - 1];
        assert!(matches!(
            Frame::decode(truncated),
            Err(ProtocolError::PayloadLengthMismatch { .. })
        ));

        let mut trailing = hello;
        trailing.push(0);
        assert!(matches!(
            Frame::decode(&trailing),
            Err(ProtocolError::PayloadLengthMismatch { .. })
        ));
    }

    #[test]
    fn diagnostic_text_is_bounded_before_it_becomes_a_frame() {
        let max = "x".repeat(MAX_FAULT_DETAIL_BYTES);
        assert!(Fault::new(FaultCode::Internal, max).is_ok());
        let too_long = "x".repeat(MAX_FAULT_DETAIL_BYTES + 1);
        assert!(matches!(
            Fault::new(FaultCode::Internal, too_long),
            Err(ProtocolError::FaultDetailTooLong { .. })
        ));
        assert_eq!(MAX_FRAME_BYTES, HEADER_BYTES + MAX_PAYLOAD_BYTES);
    }

    #[test]
    fn handshake_requires_exact_sdk_catalog_and_catalog_resource_count() {
        let (_harness, transport) = Harness::new();
        let mut wrong_sdk = expectation();
        wrong_sdk.sdk_sha256[0] ^= 1;
        assert!(matches!(
            HostClient::connect(transport, nonce(), wrong_sdk),
            Err(HostClientError::SdkIdentityMismatch)
        ));

        let (_harness, transport) = Harness::new();
        let mut wrong_catalog = expectation();
        wrong_catalog.catalog_sha256[0] ^= 1;
        assert!(matches!(
            HostClient::connect(transport, nonce(), wrong_catalog),
            Err(HostClientError::CatalogIdentityMismatch)
        ));

        let (_harness, transport) = Harness::new();
        let mut wrong_count = expectation();
        wrong_count.catalog_resource_count += 1;
        assert!(matches!(
            HostClient::connect(transport, nonce(), wrong_count),
            Err(HostClientError::CatalogResourceCountMismatch {
                expected: 229,
                actual: 228,
            })
        ));
    }

    #[test]
    fn created_controller_must_match_the_profiles_pinned_usb_identity() {
        assert_eq!(ProfileId::DualSense.usb_identity(), (0x054C, 0x0CE6));
        assert_eq!(ProfileId::SwitchPro.usb_identity(), (0x057E, 0x2009));
        assert_eq!(ProfileId::XboxSeries.usb_identity(), (0x045E, 0x0B13));

        let (harness, transport) = Harness::new();
        harness.set_created_usb_identity(0x054C, 0xFFFF);
        let mut client = HostClient::connect(transport, nonce(), expectation()).unwrap();
        assert!(matches!(
            client.create(ProfileId::DualSense),
            Err(HostClientError::UsbIdentityMismatch {
                profile: ProfileId::DualSense,
                expected_vid: 0x054C,
                expected_pid: 0x0CE6,
                actual_vid: 0x054C,
                actual_pid: 0xFFFF,
            })
        ));
        assert!(client.is_closed());
        assert_eq!(client.live_controllers().count(), 0);
    }

    #[test]
    fn client_caps_total_controller_identities_despite_create_destroy_churn() {
        let (harness, transport) = Harness::new();
        let mut client = HostClient::connect(transport, nonce(), expectation()).unwrap();
        for _ in 0..MAX_CONTROLLERS_PER_SESSION {
            let controller = client.create(ProfileId::DualSense).unwrap().controller;
            client.destroy(controller).unwrap();
        }
        let calls_before = harness.calls().len();
        let bounds_before = harness.round_trip_bounds().len();

        assert!(matches!(
            client.create(ProfileId::DualSense),
            Err(HostClientError::ControllerLimitReached {
                max: MAX_CONTROLLERS_PER_SESSION
            })
        ));
        assert_eq!(client.live_controllers().count(), 0);
        assert_eq!(harness.live_count(), 0);
        assert_eq!(harness.calls().len(), calls_before);
        assert_eq!(harness.round_trip_bounds().len(), bounds_before);
        assert!(!client.is_closed(), "local capacity refusal is recoverable");
        client.shutdown().unwrap();

        // A new authenticated/correlated conversation gets its own bounded set.
        let (_new_harness, transport) = Harness::new();
        let mut reconnected = HostClient::connect(transport, nonce(), expectation()).unwrap();
        assert!(reconnected.create(ProfileId::DualSense).is_ok());
    }

    #[test]
    fn in_memory_host_caps_total_identities_before_allocation() {
        let (harness, mut transport) = Harness::new();
        transport
            .round_trip(
                Frame::new(1, Message::Hello { nonce: nonce() }).unwrap(),
                HELLO_TIMEOUT,
            )
            .unwrap();
        let mut request_id = 2_u32;
        for at in 0..MAX_CONTROLLERS_PER_SESSION {
            let created = transport
                .round_trip(
                    Frame::new(
                        request_id,
                        Message::Create {
                            profile: ProfileId::DualSense,
                        },
                    )
                    .unwrap(),
                    CREATE_TIMEOUT,
                )
                .unwrap();
            request_id += 1;
            let controller = match created.into_message() {
                Message::Created(ready) => ready.controller,
                other => panic!("unexpected {other:?} at {at}"),
            };
            assert!(matches!(
                transport
                    .round_trip(
                        Frame::new(request_id, Message::Destroy { controller }).unwrap(),
                        DESTROY_TIMEOUT,
                    )
                    .unwrap()
                    .message(),
                Message::Destroyed { .. }
            ));
            request_id += 1;
        }
        let calls_before = harness.calls().len();
        let refused = transport
            .round_trip(
                Frame::new(
                    request_id,
                    Message::Create {
                        profile: ProfileId::DualSense,
                    },
                )
                .unwrap(),
                CREATE_TIMEOUT,
            )
            .unwrap();
        assert!(matches!(
            refused.message(),
            Message::Fault(Fault {
                code: FaultCode::Capacity,
                ..
            })
        ));
        assert_eq!(harness.live_count(), 0);
        assert_eq!(harness.calls().len(), calls_before);
        assert_eq!(
            harness
                .calls()
                .into_iter()
                .filter(|call| matches!(call, Call::Create(..)))
                .count(),
            MAX_CONTROLLERS_PER_SESSION
        );
    }

    /// End-to-end through encoded bytes: initial neutral precedes readiness,
    /// changed state is acknowledged, feedback is pull/nonblocking, and explicit
    /// teardown neutralizes before destroy.
    #[test]
    fn in_memory_transport_proves_the_owned_controller_contract() {
        let (harness, transport) = Harness::new();
        let mut client = HostClient::connect(transport, nonce(), expectation()).unwrap();
        assert_eq!(client.ready().catalog_resource_count, 228);

        let ready = client.create(ProfileId::DualSense).unwrap();
        assert_eq!((ready.vid, ready.pid), (0x054C, 0x0CE6));
        let pressed = PadState {
            buttons: XButtons::A,
            lt: 255,
            lx: i16::MIN,
            ..PadState::default()
        };
        assert_eq!(client.submit(ready.controller, pressed).unwrap(), 1);
        assert_eq!(client.poll_feedback().unwrap(), None);

        harness.push_feedback(ready.controller, 0xAA, 0x55);
        let feedback = client.poll_feedback().unwrap().unwrap();
        assert_eq!((feedback.large_motor, feedback.small_motor), (0xAA, 0x55));
        assert!(feedback.motors_valid);

        client.destroy(ready.controller).unwrap();
        client.shutdown().unwrap();
        assert!(client.is_closed());
        assert!(client.transport.is_none());
        assert_eq!(harness.live_count(), 0);
        assert_eq!(
            harness.calls(),
            vec![
                Call::Hello,
                Call::Create(ProfileId::DualSense, ready.controller),
                Call::Neutral(ready.controller),
                Call::Submit(ready.controller, 1, pressed),
                Call::Neutral(ready.controller),
                Call::Destroy(ready.controller),
                Call::Shutdown,
            ]
        );
        assert_eq!(
            harness.round_trip_bounds(),
            vec![
                (MessageKind::Hello, HELLO_TIMEOUT),
                (MessageKind::Create, CREATE_TIMEOUT),
                (MessageKind::Submit, SUBMIT_TIMEOUT),
                (MessageKind::Destroy, DESTROY_TIMEOUT),
                (MessageKind::Shutdown, SHUTDOWN_TIMEOUT),
            ]
        );
        assert!(harness
            .round_trip_bounds()
            .iter()
            .all(|(_, timeout)| !timeout.is_zero()));
    }

    #[test]
    fn unchanged_submit_refreshes_a_slower_lease_while_host_owns_the_sdk_pump() {
        assert_eq!(SDK_PUMP_INTERVAL, crate::keepalive::KEEPALIVE);
        assert!(SDK_PUMP_INTERVAL < CLIENT_LEASE_REFRESH_INTERVAL);
        assert!(CLIENT_LEASE_REFRESH_INTERVAL < CLIENT_LEASE_TIMEOUT);

        let (harness, transport) = Harness::new();
        let mut client = HostClient::connect(transport, nonce(), expectation()).unwrap();
        let controller = client.create(ProfileId::DualSense).unwrap().controller;

        harness.advance_to_and_expire(CLIENT_LEASE_REFRESH_INTERVAL);
        assert_eq!(harness.live_count(), 1);
        assert_eq!(client.submit(controller, PadState::default()).unwrap(), 1);

        let refreshed_deadline = CLIENT_LEASE_REFRESH_INTERVAL + CLIENT_LEASE_TIMEOUT;
        harness.advance_to_and_expire(refreshed_deadline - Duration::from_millis(1));
        assert_eq!(harness.live_count(), 1);
        harness.advance_to_and_expire(refreshed_deadline);

        // The ordinary client is intentionally retained and its pipe remains
        // open: lease expiry itself must still neutralize and destroy output.
        assert!(client.transport.is_some());
        assert_eq!(harness.live_count(), 0);
        let calls = harness.calls();
        assert_eq!(
            &calls[calls.len() - 2..],
            &[Call::Neutral(controller), Call::Destroy(controller)]
        );
    }

    #[test]
    fn lease_deadlines_are_per_controller_and_one_expiry_does_not_kill_the_session() {
        let (harness, transport) = Harness::new();
        let mut client = HostClient::connect(transport, nonce(), expectation()).unwrap();
        let stale = client.create(ProfileId::DualSense).unwrap().controller;
        let refreshed = client.create(ProfileId::DualSense).unwrap().controller;

        harness.advance_to_and_expire(CLIENT_LEASE_REFRESH_INTERVAL);
        assert_eq!(client.submit(refreshed, PadState::default()).unwrap(), 1);
        harness.push_feedback(stale, 0xAA, 0x55);
        harness.push_feedback(refreshed, 0x11, 0x22);
        assert_eq!(
            harness.queued_feedback_controllers(),
            vec![stale, refreshed]
        );
        harness.advance_to_and_expire(CLIENT_LEASE_TIMEOUT);

        assert_eq!(harness.live_count(), 1);
        assert_eq!(harness.queued_feedback_controllers(), vec![refreshed]);
        let calls = harness.calls();
        assert_eq!(
            &calls[calls.len() - 2..],
            &[Call::Neutral(stale), Call::Destroy(stale)]
        );
        assert!(client.transport.is_some());
        assert!(!client.is_closed());

        // The stale controller's queued nonzero callback cannot surface after
        // its neutralize/destroy boundary. The refreshed controller and its
        // shared conversation remain usable.
        let feedback = client.poll_feedback().unwrap().unwrap();
        assert_eq!(feedback.controller, refreshed);
        assert_eq!((feedback.large_motor, feedback.small_motor), (0x11, 0x22));
        assert_eq!(client.poll_feedback().unwrap(), None);
        assert_eq!(client.submit(refreshed, PadState::default()).unwrap(), 2);
        client.shutdown().unwrap();
        assert!(client.is_closed());
        assert_eq!(harness.live_count(), 0);
    }

    /// A repeated frame must not be accepted as a second command. Without this
    /// gate a delayed/replayed packet could overwrite newer controller state.
    #[test]
    fn in_memory_host_rejects_a_replayed_state_sequence() {
        let (_harness, mut transport) = Harness::new();
        transport
            .round_trip(
                Frame::new(1, Message::Hello { nonce: nonce() }).unwrap(),
                HELLO_TIMEOUT,
            )
            .unwrap();
        let created = transport
            .round_trip(
                Frame::new(
                    2,
                    Message::Create {
                        profile: ProfileId::DualSense,
                    },
                )
                .unwrap(),
                CREATE_TIMEOUT,
            )
            .unwrap();
        let controller = match created.into_message() {
            Message::Created(ready) => ready.controller,
            other => panic!("unexpected {other:?}"),
        };
        let submit = |request_id| {
            Frame::new(
                request_id,
                Message::Submit {
                    controller,
                    sequence: 1,
                    state: PadState::default(),
                },
            )
            .unwrap()
        };
        assert!(matches!(
            transport
                .round_trip(submit(3), SUBMIT_TIMEOUT)
                .unwrap()
                .message(),
            Message::Applied { sequence: 1, .. }
        ));
        let replay = transport
            .round_trip(submit(4), SUBMIT_TIMEOUT)
            .unwrap()
            .into_message();
        assert!(matches!(
            replay,
            Message::Fault(Fault {
                code: FaultCode::StaleSequence,
                ..
            })
        ));
    }

    /// Request ids are monotonic command nonces, not just reply labels. A
    /// byte-for-byte replay must not execute Create twice.
    #[test]
    fn in_memory_host_rejects_a_replayed_request_id_before_dispatch() {
        let (harness, mut transport) = Harness::new();
        transport
            .round_trip(
                Frame::new(1, Message::Hello { nonce: nonce() }).unwrap(),
                HELLO_TIMEOUT,
            )
            .unwrap();
        let create = Frame::new(
            2,
            Message::Create {
                profile: ProfileId::DualSense,
            },
        )
        .unwrap();
        assert!(matches!(
            transport
                .round_trip(create.clone(), CREATE_TIMEOUT)
                .unwrap()
                .message(),
            Message::Created(_)
        ));
        assert!(matches!(
            transport
                .round_trip(create, CREATE_TIMEOUT)
                .unwrap()
                .message(),
            Message::Fault(Fault {
                code: FaultCode::InvalidOrder,
                ..
            })
        ));
        assert_eq!(harness.live_count(), 1);
        assert_eq!(
            harness
                .calls()
                .into_iter()
                .filter(|call| matches!(call, Call::Create(..)))
                .count(),
            1
        );
    }

    /// A buggy host returning the same opaque id twice must not reset the
    /// client's acknowledged state sequence.
    #[test]
    fn duplicate_controller_id_is_rejected_and_poisoned_without_mutating_state() {
        let (harness, transport) = Harness::new();
        let mut client = HostClient::connect(transport, nonce(), expectation()).unwrap();
        let controller = client.create(ProfileId::DualSense).unwrap().controller;
        assert_eq!(client.submit(controller, PadState::default()).unwrap(), 1);

        harness.set_next_controller(controller.raw());
        assert!(matches!(
            client.create(ProfileId::DualSense),
            Err(HostClientError::DuplicateController(raw)) if raw == controller.raw()
        ));
        assert!(client.is_closed());
        assert!(client.transport.is_none());
        assert_eq!(
            harness.live_count(),
            0,
            "poison immediately emits EOF cleanup"
        );
        assert_eq!(
            client.controllers.get(&controller).unwrap().state_sequence,
            1
        );
        assert!(matches!(
            client.submit(controller, PadState::default()),
            Err(HostClientError::Closed)
        ));
    }

    #[test]
    fn request_and_state_counters_refuse_to_wrap_to_replayable_zero() {
        let (harness, transport) = Harness::new();
        let mut client = HostClient::connect(transport, nonce(), expectation()).unwrap();
        let controller = client.create(ProfileId::DualSense).unwrap().controller;
        let calls_before = harness.calls().len();

        client
            .controllers
            .get_mut(&controller)
            .unwrap()
            .state_sequence = u64::MAX;
        assert!(matches!(
            client.submit(controller, PadState::default()),
            Err(HostClientError::SequenceExhausted(raw)) if raw == controller.raw()
        ));
        assert_eq!(harness.calls().len(), calls_before);
        assert!(!client.is_closed(), "state exhaustion is controller-local");
        assert!(client.transport.is_some());

        client
            .controllers
            .get_mut(&controller)
            .unwrap()
            .state_sequence = 0;
        client.next_request_id = u64::from(u32::MAX);
        assert_eq!(client.submit(controller, PadState::default()).unwrap(), 1);
        assert!(
            !client.is_closed(),
            "u32::MAX is a valid nonzero request id"
        );
        assert!(matches!(
            client.submit(controller, PadState::default()),
            Err(HostClientError::RequestIdExhausted)
        ));
        assert_eq!(
            harness
                .calls()
                .into_iter()
                .filter(|call| matches!(call, Call::Submit(..)))
                .count(),
            1,
            "request-id exhaustion must refuse before dispatch"
        );
        assert!(client.is_closed());
        assert!(client.transport.is_none());
        assert_eq!(harness.live_count(), 0, "request-id exhaustion emits EOF");
    }

    #[test]
    fn a_lost_applied_response_closes_the_client_instead_of_guessing_a_retry() {
        let (harness, transport) = Harness::new();
        let mut client = HostClient::connect(transport, nonce(), expectation()).unwrap();
        let controller = client.create(ProfileId::DualSense).unwrap().controller;
        client.transport.as_mut().unwrap().lose_next_response = true;

        assert!(matches!(
            client.submit(controller, PadState::default()),
            Err(HostClientError::Transport(HostTransportError::Closed))
        ));
        assert!(client.is_closed());
        assert!(matches!(
            client.submit(controller, PadState::default()),
            Err(HostClientError::Closed)
        ));
        assert_eq!(
            harness
                .calls()
                .into_iter()
                .filter(|call| matches!(call, Call::Submit(..)))
                .count(),
            1
        );
    }

    #[test]
    fn lost_create_and_destroy_responses_also_poison_the_conversation() {
        let (create_harness, transport) = Harness::new();
        let mut client = HostClient::connect(transport, nonce(), expectation()).unwrap();
        client.transport.as_mut().unwrap().lose_next_response = true;
        assert!(matches!(
            client.create(ProfileId::DualSense),
            Err(HostClientError::Transport(HostTransportError::Closed))
        ));
        assert!(client.transport.is_none());
        assert_eq!(
            create_harness.live_count(),
            0,
            "lost Create response immediately emits EOF cleanup"
        );
        assert!(matches!(
            client.create(ProfileId::DualSense),
            Err(HostClientError::Closed)
        ));
        assert_eq!(
            create_harness
                .calls()
                .into_iter()
                .filter(|call| matches!(call, Call::Create(..)))
                .count(),
            1,
            "Create ran before reply loss"
        );

        let (destroy_harness, transport) = Harness::new();
        let mut client = HostClient::connect(transport, nonce(), expectation()).unwrap();
        let controller = client.create(ProfileId::DualSense).unwrap().controller;
        client.transport.as_mut().unwrap().lose_next_response = true;
        assert!(matches!(
            client.destroy(controller),
            Err(HostClientError::Transport(HostTransportError::Closed))
        ));
        assert!(client.transport.is_none());
        assert_eq!(
            destroy_harness.live_count(),
            0,
            "Destroy ran before reply loss"
        );
        assert!(matches!(
            destroy_harness.calls().last(),
            Some(Call::Disconnect)
        ));
        assert!(matches!(
            client.destroy(controller),
            Err(HostClientError::Closed)
        ));
    }

    /// The protocol may know a profile before the product supports it. This is
    /// the broken probe-based gate in executable form: vocabulary must never
    /// turn into availability merely because a host can parse the name.
    #[test]
    fn protocol_profiles_do_not_enable_product_personas() {
        for profile in ProfileId::ALL {
            assert!(!profile.persona().can_plug(), "{profile:?}");
        }
        let (_harness, transport) = Harness::new();
        let mut client = HostClient::connect(transport, nonce(), expectation()).unwrap();
        let err = client.create(ProfileId::SwitchPro).unwrap_err();
        assert!(matches!(
            err,
            HostClientError::HostFault {
                code: FaultCode::UnsupportedProfile,
                ..
            }
        ));
    }

    /// Pipe EOF is the cleanup path when the ordinary daemon dies before it can
    /// send Shutdown. The in-memory transport models that ownership rule on
    /// Drop without putting blocking IPC in `HostClient::drop`.
    #[test]
    fn transport_disconnect_neutralizes_then_destroys_every_owned_controller() {
        let (harness, transport) = Harness::new();
        let controller;
        {
            let mut client = HostClient::connect(transport, nonce(), expectation()).unwrap();
            controller = client.create(ProfileId::DualSense).unwrap().controller;
            client
                .submit(
                    controller,
                    PadState {
                        buttons: XButtons::A,
                        ..PadState::default()
                    },
                )
                .unwrap();
            // No destroy, no shutdown: dropping the transport is pipe EOF.
        }
        assert_eq!(harness.live_count(), 0);
        let calls = harness.calls();
        assert_eq!(
            &calls[calls.len() - 3..],
            &[
                Call::Neutral(controller),
                Call::Destroy(controller),
                Call::Disconnect,
            ]
        );
    }

    /// An unbounded callback queue can exhaust the privileged process; a
    /// newest-only shortcut can erase the zero packet that stops rumble unless
    /// later events are full effective snapshots. A later LED update must still
    /// repeat the known zero motor state after drop-oldest overflow.
    #[test]
    fn feedback_queue_is_bounded_and_retains_the_newest_zero_packet() {
        let (harness, transport) = Harness::new();
        let mut client = HostClient::connect(transport, nonce(), expectation()).unwrap();
        let controller = client.create(ProfileId::DualSense).unwrap().controller;
        for n in 1..=MAX_QUEUED_FEEDBACK as u8 {
            harness.push_feedback(controller, n, n);
        }
        // One more forces the oldest event out, and is an important zero/stop.
        harness.push_feedback(controller, 0, 0);
        // This LED-only source update forces another drop, but the normalized
        // snapshot repeats the cached, known zero motors.
        harness.push_led_feedback(controller, 5);

        let mut seen = Vec::new();
        while let Some(feedback) = client.poll_feedback().unwrap() {
            seen.push(feedback);
        }
        assert_eq!(seen.len(), MAX_QUEUED_FEEDBACK);
        assert_eq!(seen.first().unwrap().sequence, 3);
        let stop = seen.last().unwrap();
        assert_eq!(stop.sequence, (MAX_QUEUED_FEEDBACK + 2) as u64);
        assert_eq!((stop.large_motor, stop.small_motor), (0, 0));
        assert!(stop.motors_valid);
        assert_eq!(stop.led_number, 5);
        assert!(stop.led_valid);
    }

    #[test]
    fn feedback_replay_and_correlated_frames_are_rejected_as_async_events() {
        let (harness, transport) = Harness::new();
        let mut client = HostClient::connect(transport, nonce(), expectation()).unwrap();
        let controller = client.create(ProfileId::DualSense).unwrap().controller;

        harness.push_feedback(controller, 1, 2);
        assert_eq!(client.poll_feedback().unwrap().unwrap().sequence, 1);
        harness.set_next_feedback(1);
        harness.push_feedback(controller, 3, 4);
        assert!(matches!(
            client.poll_feedback(),
            Err(HostClientError::StaleFeedbackSequence {
                controller: raw,
                previous: 1,
                actual: 1,
            }) if raw == controller.raw()
        ));
        assert!(client.is_closed());

        let (harness, transport) = Harness::new();
        let mut client = HostClient::connect(transport, nonce(), expectation()).unwrap();
        harness.push_event(
            Frame::new(
                99,
                Message::Fault(Fault::new(FaultCode::Internal, "correlated").unwrap()),
            )
            .unwrap(),
        );
        assert!(matches!(
            client.poll_feedback(),
            Err(HostClientError::UnexpectedEventRequestId(99))
        ));
        assert!(client.is_closed());
    }

    #[test]
    fn teardown_purges_only_its_feedback_and_a_late_race_is_still_skipped() {
        let (harness, transport) = Harness::new();
        let mut client = HostClient::connect(transport, nonce(), expectation()).unwrap();
        let destroyed = client.create(ProfileId::DualSense).unwrap().controller;
        let live = client.create(ProfileId::DualSense).unwrap().controller;
        harness.push_feedback(destroyed, 0xAA, 0x55);
        harness.push_feedback(live, 0x11, 0x22);
        assert_eq!(harness.queued_feedback_controllers(), vec![destroyed, live]);

        client.destroy(destroyed).unwrap();
        assert_eq!(harness.queued_feedback_controllers(), vec![live]);
        let feedback = client.poll_feedback().unwrap().unwrap();
        assert_eq!(feedback.controller, live);
        assert_eq!((feedback.large_motor, feedback.small_motor), (0x11, 0x22));

        // A reader-thread race may already have copied an old callback out of
        // the host queue. Tombstoning still makes that late delivery harmless.
        harness.push_event(
            Frame::new(
                0,
                Message::Feedback(HostFeedback {
                    controller: destroyed,
                    sequence: 3,
                    source: FeedbackSource::OutputDecoded,
                    report_len: 48,
                    large_motor: 0xFF,
                    small_motor: 0xFF,
                    led_number: 0,
                    motors_valid: true,
                    led_valid: false,
                }),
            )
            .unwrap(),
        );
        harness.push_feedback(live, 0x33, 0x44);
        let after_race = client.poll_feedback().unwrap().unwrap();
        assert_eq!(after_race.controller, live);
        assert_eq!(
            (after_race.large_motor, after_race.small_motor),
            (0x33, 0x44)
        );
        assert!(!client.is_closed());
        assert!(client.transport.is_some());
        client.destroy(live).unwrap();
        client.shutdown().unwrap();
    }

    /// This exact list is the source-level privilege freeze. Adding a generic
    /// command, install, sweep, descriptor or path operation breaks the test
    /// before a host can accidentally expose it under elevation.
    #[test]
    fn play_time_vocabulary_contains_no_provisioning_escape_hatch() {
        assert_eq!(MAX_CONTROLLERS_PER_SESSION, 16);
        assert!(MAX_SLOTS as usize <= MAX_CONTROLLERS_PER_SESSION);
        assert_eq!(
            MessageKind::ALL,
            &[
                MessageKind::Hello,
                MessageKind::Ready,
                MessageKind::Create,
                MessageKind::Created,
                MessageKind::Submit,
                MessageKind::Applied,
                MessageKind::Feedback,
                MessageKind::Destroy,
                MessageKind::Destroyed,
                MessageKind::Shutdown,
                MessageKind::Bye,
                MessageKind::Fault,
            ]
        );
        let words = format!("{:?}", MessageKind::ALL).to_ascii_lowercase();
        for forbidden in [
            "install",
            "sweep",
            "certificate",
            "descriptor",
            "execute",
            "command",
            "path",
        ] {
            assert!(!words.contains(forbidden), "{words}");
        }

        let bounded_requests = [
            (MessageKind::Hello, HELLO_TIMEOUT),
            (MessageKind::Create, CREATE_TIMEOUT),
            (MessageKind::Submit, SUBMIT_TIMEOUT),
            (MessageKind::Destroy, DESTROY_TIMEOUT),
            (MessageKind::Shutdown, SHUTDOWN_TIMEOUT),
        ];
        for (kind, expected) in bounded_requests {
            assert!(!expected.is_zero());
            assert_eq!(kind.round_trip_timeout(), Some(expected));
        }
        for response_or_event in [
            MessageKind::Ready,
            MessageKind::Created,
            MessageKind::Applied,
            MessageKind::Feedback,
            MessageKind::Destroyed,
            MessageKind::Bye,
            MessageKind::Fault,
        ] {
            assert_eq!(response_or_event.round_trip_timeout(), None);
        }
    }
}
