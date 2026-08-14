using System.Buffers.Binary;
using System.Text;

namespace Ksx.HidMaestroProbe;

[Flags]
internal enum KsxButtons : ushort
{
    None = 0,
    DpadUp = 0x0001,
    DpadDown = 0x0002,
    DpadLeft = 0x0004,
    DpadRight = 0x0008,
    Start = 0x0010,
    Back = 0x0020,
    LeftThumb = 0x0040,
    RightThumb = 0x0080,
    LeftBumper = 0x0100,
    RightBumper = 0x0200,
    Guide = 0x0400,
    A = 0x1000,
    B = 0x2000,
    X = 0x4000,
    Y = 0x8000,
}

internal static class KsxButtonMask
{
    internal const ushort KnownBits = 0xF7FF;
}

internal readonly record struct KsxPadState(
    KsxButtons Buttons,
    byte LeftTrigger,
    byte RightTrigger,
    short LeftX,
    short LeftY,
    short RightX,
    short RightY)
{
    internal static readonly KsxPadState Neutral = new(
        KsxButtons.None,
        0,
        0,
        0,
        0,
        0,
        0);

    internal bool IsNeutral => this == Neutral;
}

internal enum HostProfileId : byte
{
    DualSense = 1,
    SwitchPro = 2,
    XboxSeries = 3,
}

internal enum HostFeedbackSource : byte
{
    XInput = 1,
    HidOutput = 2,
    HidFeature = 3,
    OutputDecoded = 4,
}

internal enum HostFaultCode : ushort
{
    InvalidOrder = 1,
    UnsupportedProfile = 2,
    UnknownController = 3,
    StaleSequence = 4,
    SdkUnavailable = 5,
    SdkFailure = 6,
    Internal = 7,
    Capacity = 8,
}

internal enum HostDirection
{
    ClientToHost,
    HostToClient,
}

internal enum HostMessageKind : ushort
{
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

internal static class HostMessageKinds
{
    internal static readonly IReadOnlyList<HostMessageKind> All =
    [
        HostMessageKind.Hello,
        HostMessageKind.Ready,
        HostMessageKind.Create,
        HostMessageKind.Created,
        HostMessageKind.Submit,
        HostMessageKind.Applied,
        HostMessageKind.Feedback,
        HostMessageKind.Destroy,
        HostMessageKind.Destroyed,
        HostMessageKind.Shutdown,
        HostMessageKind.Bye,
        HostMessageKind.Fault,
    ];

    internal static HostDirection Direction(this HostMessageKind kind) => kind switch
    {
        HostMessageKind.Hello
            or HostMessageKind.Create
            or HostMessageKind.Submit
            or HostMessageKind.Destroy
            or HostMessageKind.Shutdown => HostDirection.ClientToHost,
        _ => HostDirection.HostToClient,
    };
}

internal abstract record HostMessage
{
    internal abstract HostMessageKind Kind { get; }
}

internal sealed record HelloMessage(byte[] Nonce) : HostMessage
{
    internal override HostMessageKind Kind => HostMessageKind.Hello;
}

internal sealed record ReadyMessage(
    byte[] Nonce,
    byte[] SdkSha256,
    byte[] CatalogSha256,
    ushort CatalogResourceCount) : HostMessage
{
    internal override HostMessageKind Kind => HostMessageKind.Ready;
}

internal sealed record CreateMessage(HostProfileId Profile) : HostMessage
{
    internal override HostMessageKind Kind => HostMessageKind.Create;
}

internal sealed record CreatedMessage(
    uint Controller,
    HostProfileId Profile,
    ushort VendorId,
    ushort ProductId) : HostMessage
{
    internal override HostMessageKind Kind => HostMessageKind.Created;
}

internal sealed record SubmitMessage(
    uint Controller,
    ulong Sequence,
    KsxPadState State) : HostMessage
{
    internal override HostMessageKind Kind => HostMessageKind.Submit;
}

internal sealed record AppliedMessage(uint Controller, ulong Sequence) : HostMessage
{
    internal override HostMessageKind Kind => HostMessageKind.Applied;
}

internal sealed record FeedbackMessage(
    uint Controller,
    ulong Sequence,
    HostFeedbackSource Source,
    ushort ReportLength,
    byte LargeMotor,
    byte SmallMotor,
    byte LedNumber,
    bool MotorsValid,
    bool LedValid) : HostMessage
{
    internal override HostMessageKind Kind => HostMessageKind.Feedback;
}

internal sealed record DestroyMessage(uint Controller) : HostMessage
{
    internal override HostMessageKind Kind => HostMessageKind.Destroy;
}

internal sealed record DestroyedMessage(uint Controller) : HostMessage
{
    internal override HostMessageKind Kind => HostMessageKind.Destroyed;
}

internal sealed record ShutdownMessage : HostMessage
{
    internal override HostMessageKind Kind => HostMessageKind.Shutdown;
}

internal sealed record ByeMessage : HostMessage
{
    internal override HostMessageKind Kind => HostMessageKind.Bye;
}

internal sealed record FaultMessage(HostFaultCode Code, string Detail) : HostMessage
{
    internal override HostMessageKind Kind => HostMessageKind.Fault;
}

internal sealed record HostFrame(uint RequestId, HostMessage Message)
{
    internal static HostFrame Create(uint requestId, HostMessage message)
    {
        var frame = new HostFrame(requestId, message);
        HostProtocolCodec.ValidateOrThrow(frame);
        return frame;
    }

    internal byte[] Encode() => HostProtocolCodec.Encode(this);
}

internal enum HostProtocolError
{
    None,
    FrameTooShort,
    BadMagic,
    VersionMismatch,
    UnknownMessageKind,
    PayloadTooLarge,
    PayloadLengthMismatch,
    WrongPayloadSize,
    UnknownProfile,
    UnknownFeedbackSource,
    UnknownFaultCode,
    ZeroControllerId,
    ZeroSequence,
    ZeroUsbIdentity,
    UnknownButtonBits,
    InvalidRequestId,
    FaultDetailTooLong,
    FaultDetailUtf8,
    UnknownFeedbackFlags,
    InvalidNonceLength,
    InvalidHashLength,
}

/// <summary>
/// Exact C# mirror of crates/ksx-hidmaestro/src/host.rs KSXH protocol V1.
/// This is KSX's transport envelope, never HIDMaestro shared-memory format.
/// </summary>
internal static class HostProtocolCodec
{
    internal const string ProtocolId = "ksx.hidmaestro.host.v1";
    internal const string MagicText = "KSXH";
    internal const ushort Version = 1;
    internal const int HeaderBytes = 16;
    internal const int MaximumPayloadBytes = 512;
    internal const int MaximumFrameBytes = HeaderBytes + MaximumPayloadBytes;
    internal const int NonceBytes = 32;
    internal const int Sha256Bytes = 32;
    internal const int MaximumFaultDetailBytes = 256;
    internal const int SubmitPayloadBytes = 24;
    internal const int FeedbackPayloadBytes = 19;

    private const uint Magic = 0x4858_534B; // ASCII KSXH as a little-endian u32.
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    internal static byte[] Encode(HostFrame frame)
    {
        ValidateOrThrow(frame);
        byte[] payload = EncodePayload(frame.Message);
        if (payload.Length > MaximumPayloadBytes)
            throw new ArgumentOutOfRangeException(nameof(frame), "Host payload exceeds the V1 bound.");

        var bytes = new byte[HeaderBytes + payload.Length];
        Span<byte> output = bytes;
        BinaryPrimitives.WriteUInt32LittleEndian(output[0..4], Magic);
        BinaryPrimitives.WriteUInt16LittleEndian(output[4..6], Version);
        BinaryPrimitives.WriteUInt16LittleEndian(output[6..8], (ushort)frame.Message.Kind);
        BinaryPrimitives.WriteUInt32LittleEndian(output[8..12], frame.RequestId);
        BinaryPrimitives.WriteUInt32LittleEndian(output[12..16], (uint)payload.Length);
        payload.CopyTo(output[HeaderBytes..]);
        return bytes;
    }

    internal static bool TryDecode(
        ReadOnlySpan<byte> bytes,
        out HostFrame? frame,
        out HostProtocolError error)
    {
        frame = null;
        error = HostProtocolError.None;

        if (bytes.Length < HeaderBytes)
            return Fail(HostProtocolError.FrameTooShort, out error);
        if (BinaryPrimitives.ReadUInt32LittleEndian(bytes[0..4]) != Magic)
            return Fail(HostProtocolError.BadMagic, out error);
        if (BinaryPrimitives.ReadUInt16LittleEndian(bytes[4..6]) != Version)
            return Fail(HostProtocolError.VersionMismatch, out error);
        if (!TryMessageKind(BinaryPrimitives.ReadUInt16LittleEndian(bytes[6..8]), out HostMessageKind kind))
            return Fail(HostProtocolError.UnknownMessageKind, out error);

        uint requestId = BinaryPrimitives.ReadUInt32LittleEndian(bytes[8..12]);
        uint declaredRaw = BinaryPrimitives.ReadUInt32LittleEndian(bytes[12..16]);
        if (declaredRaw > MaximumPayloadBytes)
            return Fail(HostProtocolError.PayloadTooLarge, out error);
        int declared = (int)declaredRaw;
        int actual = bytes.Length - HeaderBytes;
        if (actual != declared)
            return Fail(HostProtocolError.PayloadLengthMismatch, out error);

        if (!TryDecodePayload(kind, bytes[HeaderBytes..], out HostMessage? message, out error)
            || message is null)
        {
            return false;
        }

        var candidate = new HostFrame(requestId, message);
        HostProtocolError validation = Validate(candidate);
        if (validation != HostProtocolError.None)
            return Fail(validation, out error);

        frame = candidate;
        return true;
    }

    internal static void ValidateOrThrow(HostFrame frame)
    {
        HostProtocolError error = Validate(frame);
        if (error != HostProtocolError.None)
            throw new ArgumentException($"Invalid KSXH V1 frame: {error}.", nameof(frame));
    }

    private static HostProtocolError Validate(HostFrame frame)
    {
        HostMessage message = frame.Message;
        if (message.Kind == HostMessageKind.Feedback)
        {
            if (frame.RequestId != 0)
                return HostProtocolError.InvalidRequestId;
        }
        else if (message.Kind != HostMessageKind.Fault && frame.RequestId == 0)
        {
            return HostProtocolError.InvalidRequestId;
        }

        return message switch
        {
            HelloMessage hello when hello.Nonce.Length != NonceBytes => HostProtocolError.InvalidNonceLength,
            ReadyMessage ready when ready.Nonce.Length != NonceBytes => HostProtocolError.InvalidNonceLength,
            ReadyMessage ready when ready.SdkSha256.Length != Sha256Bytes
                                    || ready.CatalogSha256.Length != Sha256Bytes => HostProtocolError.InvalidHashLength,
            CreateMessage create when !IsProfile(create.Profile) => HostProtocolError.UnknownProfile,
            CreatedMessage created when created.Controller == 0 => HostProtocolError.ZeroControllerId,
            CreatedMessage created when !IsProfile(created.Profile) => HostProtocolError.UnknownProfile,
            CreatedMessage created when created.VendorId == 0 || created.ProductId == 0 => HostProtocolError.ZeroUsbIdentity,
            SubmitMessage submit when submit.Controller == 0 => HostProtocolError.ZeroControllerId,
            SubmitMessage submit when submit.Sequence == 0 => HostProtocolError.ZeroSequence,
            SubmitMessage submit when HasUnknownButtons(submit.State) => HostProtocolError.UnknownButtonBits,
            AppliedMessage applied when applied.Controller == 0 => HostProtocolError.ZeroControllerId,
            AppliedMessage applied when applied.Sequence == 0 => HostProtocolError.ZeroSequence,
            FeedbackMessage feedback when feedback.Controller == 0 => HostProtocolError.ZeroControllerId,
            FeedbackMessage feedback when feedback.Sequence == 0 => HostProtocolError.ZeroSequence,
            FeedbackMessage feedback when !IsFeedbackSource(feedback.Source) => HostProtocolError.UnknownFeedbackSource,
            DestroyMessage destroy when destroy.Controller == 0 => HostProtocolError.ZeroControllerId,
            DestroyedMessage destroyed when destroyed.Controller == 0 => HostProtocolError.ZeroControllerId,
            FaultMessage fault when !IsFaultCode(fault.Code) => HostProtocolError.UnknownFaultCode,
            FaultMessage fault when StrictUtf8.GetByteCount(fault.Detail) > MaximumFaultDetailBytes => HostProtocolError.FaultDetailTooLong,
            _ => HostProtocolError.None,
        };
    }

    private static byte[] EncodePayload(HostMessage message)
    {
        switch (message)
        {
            case HelloMessage hello:
                return (byte[])hello.Nonce.Clone();
            case ReadyMessage ready:
            {
                var payload = new byte[98];
                ready.Nonce.CopyTo(payload, 0);
                ready.SdkSha256.CopyTo(payload, 32);
                ready.CatalogSha256.CopyTo(payload, 64);
                BinaryPrimitives.WriteUInt16LittleEndian(payload.AsSpan(96, 2), ready.CatalogResourceCount);
                return payload;
            }
            case CreateMessage create:
                return [(byte)create.Profile];
            case CreatedMessage created:
            {
                var payload = new byte[9];
                BinaryPrimitives.WriteUInt32LittleEndian(payload.AsSpan(0, 4), created.Controller);
                payload[4] = (byte)created.Profile;
                BinaryPrimitives.WriteUInt16LittleEndian(payload.AsSpan(5, 2), created.VendorId);
                BinaryPrimitives.WriteUInt16LittleEndian(payload.AsSpan(7, 2), created.ProductId);
                return payload;
            }
            case SubmitMessage submit:
            {
                var payload = new byte[SubmitPayloadBytes];
                BinaryPrimitives.WriteUInt32LittleEndian(payload.AsSpan(0, 4), submit.Controller);
                BinaryPrimitives.WriteUInt64LittleEndian(payload.AsSpan(4, 8), submit.Sequence);
                WritePadState(payload.AsSpan(12, 12), submit.State);
                return payload;
            }
            case AppliedMessage applied:
            {
                var payload = new byte[12];
                BinaryPrimitives.WriteUInt32LittleEndian(payload.AsSpan(0, 4), applied.Controller);
                BinaryPrimitives.WriteUInt64LittleEndian(payload.AsSpan(4, 8), applied.Sequence);
                return payload;
            }
            case FeedbackMessage feedback:
            {
                var payload = new byte[FeedbackPayloadBytes];
                BinaryPrimitives.WriteUInt32LittleEndian(payload.AsSpan(0, 4), feedback.Controller);
                BinaryPrimitives.WriteUInt64LittleEndian(payload.AsSpan(4, 8), feedback.Sequence);
                payload[12] = (byte)feedback.Source;
                payload[13] = (byte)((feedback.MotorsValid ? 1 : 0) | (feedback.LedValid ? 2 : 0));
                BinaryPrimitives.WriteUInt16LittleEndian(payload.AsSpan(14, 2), feedback.ReportLength);
                payload[16] = feedback.LargeMotor;
                payload[17] = feedback.SmallMotor;
                payload[18] = feedback.LedNumber;
                return payload;
            }
            case DestroyMessage destroy:
                return U32Payload(destroy.Controller);
            case DestroyedMessage destroyed:
                return U32Payload(destroyed.Controller);
            case ShutdownMessage or ByeMessage:
                return [];
            case FaultMessage fault:
            {
                byte[] detail = StrictUtf8.GetBytes(fault.Detail);
                var payload = new byte[4 + detail.Length];
                BinaryPrimitives.WriteUInt16LittleEndian(payload.AsSpan(0, 2), (ushort)fault.Code);
                BinaryPrimitives.WriteUInt16LittleEndian(payload.AsSpan(2, 2), (ushort)detail.Length);
                detail.CopyTo(payload, 4);
                return payload;
            }
            default:
                throw new ArgumentOutOfRangeException(nameof(message));
        }
    }

    private static bool TryDecodePayload(
        HostMessageKind kind,
        ReadOnlySpan<byte> payload,
        out HostMessage? message,
        out HostProtocolError error)
    {
        message = null;
        error = HostProtocolError.None;

        switch (kind)
        {
            case HostMessageKind.Hello:
                if (!Exact(payload, NonceBytes, out error)) return false;
                message = new HelloMessage(payload.ToArray());
                return true;
            case HostMessageKind.Ready:
                if (!Exact(payload, 98, out error)) return false;
                message = new ReadyMessage(
                    payload[0..32].ToArray(),
                    payload[32..64].ToArray(),
                    payload[64..96].ToArray(),
                    BinaryPrimitives.ReadUInt16LittleEndian(payload[96..98]));
                return true;
            case HostMessageKind.Create:
                if (!Exact(payload, 1, out error)) return false;
                if (!TryProfile(payload[0], out HostProfileId profile))
                    return Fail(HostProtocolError.UnknownProfile, out error);
                message = new CreateMessage(profile);
                return true;
            case HostMessageKind.Created:
                if (!Exact(payload, 9, out error)) return false;
                if (!TryProfile(payload[4], out HostProfileId createdProfile))
                    return Fail(HostProtocolError.UnknownProfile, out error);
                message = new CreatedMessage(
                    BinaryPrimitives.ReadUInt32LittleEndian(payload[0..4]),
                    createdProfile,
                    BinaryPrimitives.ReadUInt16LittleEndian(payload[5..7]),
                    BinaryPrimitives.ReadUInt16LittleEndian(payload[7..9]));
                return true;
            case HostMessageKind.Submit:
                if (!Exact(payload, SubmitPayloadBytes, out error)) return false;
                if (!TryReadPadState(payload[12..24], out KsxPadState state, out error)) return false;
                message = new SubmitMessage(
                    BinaryPrimitives.ReadUInt32LittleEndian(payload[0..4]),
                    BinaryPrimitives.ReadUInt64LittleEndian(payload[4..12]),
                    state);
                return true;
            case HostMessageKind.Applied:
                if (!Exact(payload, 12, out error)) return false;
                message = new AppliedMessage(
                    BinaryPrimitives.ReadUInt32LittleEndian(payload[0..4]),
                    BinaryPrimitives.ReadUInt64LittleEndian(payload[4..12]));
                return true;
            case HostMessageKind.Feedback:
                if (!Exact(payload, FeedbackPayloadBytes, out error)) return false;
                if (!TryFeedbackSource(payload[12], out HostFeedbackSource source))
                    return Fail(HostProtocolError.UnknownFeedbackSource, out error);
                byte flags = payload[13];
                if ((flags & ~0b11) != 0)
                    return Fail(HostProtocolError.UnknownFeedbackFlags, out error);
                message = new FeedbackMessage(
                    BinaryPrimitives.ReadUInt32LittleEndian(payload[0..4]),
                    BinaryPrimitives.ReadUInt64LittleEndian(payload[4..12]),
                    source,
                    BinaryPrimitives.ReadUInt16LittleEndian(payload[14..16]),
                    payload[16],
                    payload[17],
                    payload[18],
                    (flags & 1) != 0,
                    (flags & 2) != 0);
                return true;
            case HostMessageKind.Destroy:
                if (!Exact(payload, 4, out error)) return false;
                message = new DestroyMessage(BinaryPrimitives.ReadUInt32LittleEndian(payload));
                return true;
            case HostMessageKind.Destroyed:
                if (!Exact(payload, 4, out error)) return false;
                message = new DestroyedMessage(BinaryPrimitives.ReadUInt32LittleEndian(payload));
                return true;
            case HostMessageKind.Shutdown:
                if (!Exact(payload, 0, out error)) return false;
                message = new ShutdownMessage();
                return true;
            case HostMessageKind.Bye:
                if (!Exact(payload, 0, out error)) return false;
                message = new ByeMessage();
                return true;
            case HostMessageKind.Fault:
                return TryDecodeFault(payload, out message, out error);
            default:
                return Fail(HostProtocolError.UnknownMessageKind, out error);
        }
    }

    private static bool TryDecodeFault(
        ReadOnlySpan<byte> payload,
        out HostMessage? message,
        out HostProtocolError error)
    {
        message = null;
        error = HostProtocolError.None;
        if (payload.Length < 4)
            return Fail(HostProtocolError.WrongPayloadSize, out error);

        ushort detailLength = BinaryPrimitives.ReadUInt16LittleEndian(payload[2..4]);
        if (detailLength > MaximumFaultDetailBytes)
            return Fail(HostProtocolError.FaultDetailTooLong, out error);
        if (payload.Length != 4 + detailLength)
            return Fail(HostProtocolError.WrongPayloadSize, out error);
        if (!TryFaultCode(BinaryPrimitives.ReadUInt16LittleEndian(payload[0..2]), out HostFaultCode code))
            return Fail(HostProtocolError.UnknownFaultCode, out error);

        string detail;
        try
        {
            detail = StrictUtf8.GetString(payload[4..]);
        }
        catch (DecoderFallbackException)
        {
            return Fail(HostProtocolError.FaultDetailUtf8, out error);
        }
        message = new FaultMessage(code, detail);
        return true;
    }

    private static void WritePadState(Span<byte> destination, KsxPadState state)
    {
        BinaryPrimitives.WriteUInt16LittleEndian(destination[0..2], (ushort)state.Buttons);
        destination[2] = state.LeftTrigger;
        destination[3] = state.RightTrigger;
        BinaryPrimitives.WriteInt16LittleEndian(destination[4..6], state.LeftX);
        BinaryPrimitives.WriteInt16LittleEndian(destination[6..8], state.LeftY);
        BinaryPrimitives.WriteInt16LittleEndian(destination[8..10], state.RightX);
        BinaryPrimitives.WriteInt16LittleEndian(destination[10..12], state.RightY);
    }

    private static bool TryReadPadState(
        ReadOnlySpan<byte> source,
        out KsxPadState state,
        out HostProtocolError error)
    {
        ushort buttonBits = BinaryPrimitives.ReadUInt16LittleEndian(source[0..2]);
        if ((buttonBits & ~KsxButtonMask.KnownBits) != 0)
        {
            state = default;
            return Fail(HostProtocolError.UnknownButtonBits, out error);
        }

        state = new KsxPadState(
            (KsxButtons)buttonBits,
            source[2],
            source[3],
            BinaryPrimitives.ReadInt16LittleEndian(source[4..6]),
            BinaryPrimitives.ReadInt16LittleEndian(source[6..8]),
            BinaryPrimitives.ReadInt16LittleEndian(source[8..10]),
            BinaryPrimitives.ReadInt16LittleEndian(source[10..12]));
        error = HostProtocolError.None;
        return true;
    }

    private static byte[] U32Payload(uint value)
    {
        var payload = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(payload, value);
        return payload;
    }

    private static bool HasUnknownButtons(KsxPadState state) =>
        (((ushort)state.Buttons) & ~KsxButtonMask.KnownBits) != 0;

    private static bool Exact(ReadOnlySpan<byte> payload, int expected, out HostProtocolError error)
    {
        if (payload.Length == expected)
        {
            error = HostProtocolError.None;
            return true;
        }
        return Fail(HostProtocolError.WrongPayloadSize, out error);
    }

    private static bool TryMessageKind(ushort value, out HostMessageKind kind)
    {
        kind = (HostMessageKind)value;
        return value is >= 1 and <= 12;
    }

    private static bool TryProfile(byte value, out HostProfileId profile)
    {
        profile = (HostProfileId)value;
        return value is >= 1 and <= 3;
    }

    private static bool TryFeedbackSource(byte value, out HostFeedbackSource source)
    {
        source = (HostFeedbackSource)value;
        return value is >= 1 and <= 4;
    }

    private static bool TryFaultCode(ushort value, out HostFaultCode code)
    {
        code = (HostFaultCode)value;
        return value is >= 1 and <= 8;
    }

    private static bool IsProfile(HostProfileId profile) => (byte)profile is >= 1 and <= 3;
    private static bool IsFeedbackSource(HostFeedbackSource source) => (byte)source is >= 1 and <= 4;
    private static bool IsFaultCode(HostFaultCode code) => (ushort)code is >= 1 and <= 8;

    private static bool Fail(HostProtocolError value, out HostProtocolError error)
    {
        error = value;
        return false;
    }
}
