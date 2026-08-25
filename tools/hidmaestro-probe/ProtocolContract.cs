using System.Security.Cryptography;
using System.Text;

namespace Ksx.HidMaestroProbe;

internal sealed record ProtocolHeaderField(string Name, int Offset, int Bytes, string Encoding);
internal sealed record ProtocolProfile(byte Value, string Name, string CatalogSlug, string VendorId, string ProductId);
internal sealed record ProtocolMessageShape(ushort Value, string Name, string Direction, string PayloadBytes, string Payload);
internal sealed record GoldenFrame(string Message, int Bytes, string Hex);
internal sealed record GoldenVector(string RustTest, string Message, int Bytes, string Hex, string Sha256);

internal sealed record RequestDeadlines(
    int HelloMilliseconds,
    int CreateMilliseconds,
    int SubmitMilliseconds,
    int DestroyMilliseconds,
    int ShutdownMilliseconds);

internal sealed record ProtocolDescription(
    string Status,
    string ProtocolId,
    string Magic,
    ushort Version,
    string ByteOrder,
    int HeaderBytes,
    int MaximumPayloadBytes,
    int MaximumFrameBytes,
    int MaximumFaultDetailBytes,
    int MaximumControllerIdentitiesPerSession,
    ulong HostSdkPumpMicroseconds,
    ulong ClientLeaseRefreshMicroseconds,
    ulong ClientLeaseTimeoutMicroseconds,
    int MaximumQueuedFeedback,
    RequestDeadlines Deadlines,
    string SourceOfTruth,
    string FreezeSha256,
    IReadOnlyList<ProtocolHeaderField> Header,
    IReadOnlyList<ProtocolProfile> Profiles,
    IReadOnlyList<ProtocolMessageShape> Messages,
    IReadOnlyList<string> BehavioralRules,
    IReadOnlyList<GoldenFrame> RustGoldenFrames,
    GoldenVector RustSubmitBoundaryVector);

internal sealed record ProtocolDocument(int SchemaVersion, string Command, bool Ok, ProtocolDescription Protocol, SafetyReport Safety);

internal sealed record WireExchangeStep(
    string Event,
    ulong AtMicroseconds,
    bool Emitted,
    string? Reason,
    uint? RequestId,
    ulong? Sequence,
    string? SubmitHex,
    string? AppliedHex);

internal sealed record HostSdkStep(
    string Event,
    ulong AtMicroseconds,
    bool Published,
    string? Reason,
    bool HasWireFrame,
    string? State);

internal sealed record FeedbackSimulation(
    bool CallbackBytesCopied,
    int Capacity,
    ulong DroppedOldest,
    IReadOnlyList<ulong> RetainedSequences,
    bool LatestIsFullEffectiveSnapshot,
    bool MotorsKnown,
    byte LargeMotor,
    byte SmallMotor,
    bool LedKnown,
    byte LedNumber,
    bool ClearedAndClosedOnTeardown);

internal sealed record LeaseSimulation(
    ulong RefreshMicroseconds,
    ulong TimeoutMicroseconds,
    bool HealthyIdleStayedOpen,
    bool OneMicrosecondEarlyStayedOpen,
    bool ExpiredAtExactDeadline,
    bool ExpiryHadWireFrame,
    IReadOnlyList<string> ExpirySteps);

internal sealed record TeardownSimulation(
    bool OneControllerOnly,
    bool NeutralBeforeDestroy,
    bool Idempotent,
    uint RequestId,
    string DestroyHex,
    string DestroyedHex,
    IReadOnlyList<string> OrderedSteps);

internal sealed record SimulationDocument(
    int SchemaVersion,
    string Command,
    bool Ok,
    string ProtocolId,
    IReadOnlyList<WireExchangeStep> Wire,
    IReadOnlyList<HostSdkStep> HostSdk,
    FeedbackSimulation Feedback,
    LeaseSimulation Lease,
    TeardownSimulation Teardown,
    IReadOnlyDictionary<string, bool> Checks,
    SafetyReport Safety);

internal static class ProtocolContract
{
    internal const string RustSubmitBoundaryHex =
        "4B535848010005004433221118000000070000000807060504030201011012340080FFFF3412FF7F";

    internal static readonly IReadOnlyList<GoldenFrame> RustV1GoldenFrames =
    [
        new("Hello", 48, "4B535848010001000100000020000000000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F"),
        new("Ready", 114, "4B535848010002000200000062000000000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1FA5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A55A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5A5AE400"),
        new("Create", 17, "4B53584801000300030000000100000001"),
        new("Created", 25, "4B53584801000400040000000900000007000000014C05E60C"),
        new("Submit", 40, "4B535848010005000500000018000000070000000100000000000000011012340080FFFF3412FF7F"),
        new("Applied", 28, "4B53584801000600060000000C000000070000000100000000000000"),
        new("Feedback", 35, "4B53584801000700000000001300000007000000010000000000000004033000AA5503"),
        new("Destroy", 20, "4B53584801000800080000000400000007000000"),
        new("Destroyed", 20, "4B53584801000900090000000400000007000000"),
        new("Shutdown", 16, "4B53584801000A000A00000000000000"),
        new("Bye", 16, "4B53584801000B000B00000000000000"),
        new("Fault", 22, "4B53584801000C000C00000006000000070002007631"),
    ];

    private const string FreezeMaterial =
        "ksx.hidmaestro.host.v1|KSXH|le|v=1|header=16|max_payload=512|max_frame=528|" +
        "messages=1..12|fault_codes=1..8|catalog_resource_count=228|identity_budget=16|" +
        "sdk_pump_us=16000|lease_refresh_us=1000000|lease_timeout_us=5000000|" +
        "feedback=full-effective:64:copy:drop-oldest|teardown=neutral:destroy-one|" + RustSubmitBoundaryHex;

    internal static ProtocolDescription Describe() =>
        new(
            Status: "cross-language-v1-source-frozen-for-in-memory-conformance",
            ProtocolId: HostProtocolCodec.ProtocolId,
            Magic: HostProtocolCodec.MagicText,
            Version: HostProtocolCodec.Version,
            ByteOrder: "little-endian",
            HeaderBytes: HostProtocolCodec.HeaderBytes,
            MaximumPayloadBytes: HostProtocolCodec.MaximumPayloadBytes,
            MaximumFrameBytes: HostProtocolCodec.MaximumFrameBytes,
            MaximumFaultDetailBytes: HostProtocolCodec.MaximumFaultDetailBytes,
            MaximumControllerIdentitiesPerSession: HostPolicy.MaximumControllerIdentitiesPerSession,
            HostSdkPumpMicroseconds: HostPolicy.SdkPumpIntervalMicroseconds,
            ClientLeaseRefreshMicroseconds: HostPolicy.ClientLeaseRefreshMicroseconds,
            ClientLeaseTimeoutMicroseconds: HostPolicy.ClientLeaseTimeoutMicroseconds,
            MaximumQueuedFeedback: HostPolicy.MaximumQueuedFeedback,
            // Mirrors crates/ksx-hidmaestro/src/host.rs (the SourceOfTruth
            // below): CREATE grew to 30 s when the second Switch Pro create
            // measured 7.7 s, DESTROY/SHUTDOWN to 30 s when the first-ever
            // DIF_REMOVE measured ~12 s (2026-08-20 hardware session).
            Deadlines: new RequestDeadlines(5_000, 30_000, 250, 30_000, 30_000),
            SourceOfTruth: "crates/ksx-hidmaestro/src/host.rs",
            FreezeSha256: Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(FreezeMaterial))),
            Header:
            [
                new("magic", 0, 4, "ASCII KSXH"),
                new("version", 4, 2, "u16"),
                new("kind", 6, 2, "u16"),
                new("requestId", 8, 4, "u32"),
                new("payloadLength", 12, 4, "u32"),
            ],
            Profiles:
            [
                new(1, "DualSense", "dualsense", "0x054C", "0x0CE6"),
                new(2, "SwitchPro", "switch-pro", "0x057E", "0x2009"),
                new(3, "XboxSeries", "xbox-series-xs-bt", "0x045E", "0x0B13"),
                new(4, "Snes", "ibuffalo-snes", "0x0583", "0x2060"),
                new(5, "Genesis", "daemonbite-genesis", "0x2341", "0x8036"),
            ],
            Messages:
            [
                Shape(HostMessageKind.Hello, "client-to-host", "32", "nonce[32]"),
                Shape(HostMessageKind.Ready, "host-to-client", "98", "nonce[32] + sdkSha256[32] + catalogSha256[32] + catalogResourceCount:u16"),
                Shape(HostMessageKind.Create, "client-to-host", "1", "profile:u8"),
                Shape(HostMessageKind.Created, "host-to-client", "9", "controller:u32 + profile:u8 + vid:u16 + pid:u16"),
                Shape(HostMessageKind.Submit, "client-to-host", "24", "controller:u32 + sequence:u64 + PadState[12]"),
                Shape(HostMessageKind.Applied, "host-to-client", "12", "controller:u32 + sequence:u64"),
                Shape(HostMessageKind.Feedback, "host-to-client", "19", "controller:u32 + sequence:u64 + source:u8 + knownFlags:u8 + reportLength:u16 + motors[2] + led:u8"),
                Shape(HostMessageKind.Destroy, "client-to-host", "4", "controller:u32"),
                Shape(HostMessageKind.Destroyed, "host-to-client", "4", "controller:u32"),
                Shape(HostMessageKind.Shutdown, "client-to-host", "0", "empty"),
                Shape(HostMessageKind.Bye, "host-to-client", "0", "empty"),
                Shape(HostMessageKind.Fault, "host-to-client", "4..260", "code:u16 (1..8) + UTF-8 byteLength:u16 + detail[0..256]"),
            ],
            BehavioralRules:
            [
                "Submit carries one complete 12-byte PadState; initial state and changes publish immediately.",
                "The ordinary client emits no 16 ms keepalive traffic; its unchanged full-state lease heartbeat is one second.",
                "The privileged host caches accepted state and republishes it to the SDK every 16 ms without a KSXH frame.",
                "Five seconds without Submit expires that controller's lease even when the pipe remains open; host neutralizes, destroys, and tombstones only that controller while the conversation remains usable.",
                "At most 16 controller identities may ever be issued in one conversation; destroyed ids are not recycled.",
                "Ready authenticates the expected nonce, SDK SHA-256, catalog SHA-256, and all-resource count (228, not deployable-profile count).",
                "Created identity must match the allowlisted profile's exact VID/PID.",
                "Request ids, state sequences, and per-controller feedback sequences strictly advance; gaps are allowed but non-advancing values are rejected.",
                "Feedback validity means known, not changed: every snapshot repeats all known effective motor and LED fields.",
                "A bounded copied feedback queue may drop oldest because each retained item is a full effective-state snapshot.",
                "Destroy addresses one owned controller and neutralizes it before acknowledgement; transport loss or semantic mismatch poisons the conversation and is not retried.",
                "This single-threaded simulation does not approve a production callback queue, OS transport, authentication/ACL implementation, SDK lifecycle, or elevated host.",
            ],
            RustGoldenFrames: RustV1GoldenFrames,
            RustSubmitBoundaryVector: GoldenSubmitBoundary());

    internal static SimulationDocument Simulate(SafetyReport safety)
    {
        const uint controller = 7;
        using var session = new ProtocolSessionSimulator(controller, feedbackCapacity: 2);
        var wire = new List<WireExchangeStep>();
        var sdk = new List<HostSdkStep>();

        ProtocolExchange initial = session.ClientUpdate(KsxPadState.Neutral, 0)
            ?? throw new InvalidOperationException("Initial neutral state was suppressed.");
        wire.Add(WireStep("client-initial", 0, initial));
        sdk.Add(SdkStep("host-accept-submit", initial.SdkPublication));

        ProtocolExchange? unchanged = session.ClientUpdate(KsxPadState.Neutral, 100);
        wire.Add(WireStep("client-unchanged", 100, unchanged));
        SdkPublication? earlyPump = session.HostSdkTick(15_999);
        sdk.Add(SdkStep("host-pump-early", 15_999, earlyPump));
        SdkPublication localPump = session.HostSdkTick(16_000)
            ?? throw new InvalidOperationException("Host-local 16 ms publication was suppressed.");
        sdk.Add(SdkStep("host-pump", localPump));

        ProtocolExchange? earlyHeartbeat = session.ClientLeaseHeartbeatTick(999_999);
        wire.Add(WireStep("client-heartbeat-early", 999_999, earlyHeartbeat));
        ProtocolExchange heartbeat = session.ClientLeaseHeartbeatTick(1_000_000)
            ?? throw new InvalidOperationException("One-second lease heartbeat was suppressed.");
        wire.Add(WireStep("client-lease-heartbeat", 1_000_000, heartbeat));
        sdk.Add(SdkStep("host-accept-heartbeat", heartbeat.SdkPublication));

        var held = new KsxPadState(KsxButtons.DpadRight | KsxButtons.A, 0x40, 0x80, short.MinValue, -1, 0x1234, short.MaxValue);
        ProtocolExchange changed = session.ClientUpdate(held, 1_000_001)
            ?? throw new InvalidOperationException("Changed full state was suppressed.");
        wire.Add(WireStep("client-changed", 1_000_001, changed));
        sdk.Add(SdkStep("host-accept-change", changed.SdkPublication));

        EffectiveFeedbackAccumulator accumulator = session.FeedbackAccumulator;
        byte[] callbackBuffer = accumulator
            .Snapshot(1, HostFeedbackSource.OutputDecoded, 48, new MotorUpdate(0xAA, 0x55))
            .Encode();
        byte[] callbackExpected = (byte[])callbackBuffer.Clone();
        FeedbackEnqueueResult copiedFeedback = session.Feedback.EnqueueEncoded(callbackBuffer);
        callbackBuffer.AsSpan().Fill(0xCC);
        bool callbackCopied = session.Feedback.TryDequeue(out byte[]? copiedBytes)
            && copiedBytes is not null && copiedBytes.AsSpan().SequenceEqual(callbackExpected);
        if (copiedBytes is not null)
            CryptographicOperations.ZeroMemory(copiedBytes);

        FeedbackEnqueueResult firstFeedback = session.Feedback.EnqueueEncoded(
            accumulator.Snapshot(2, HostFeedbackSource.OutputDecoded, 48, new MotorUpdate(0xAA, 0x55)).Encode());
        FeedbackEnqueueResult stopFeedback = session.Feedback.EnqueueEncoded(
            accumulator.Snapshot(3, HostFeedbackSource.OutputDecoded, 48, new MotorUpdate(0, 0)).Encode());
        FeedbackEnqueueResult ledOnly = session.Feedback.EnqueueEncoded(
            accumulator.Snapshot(4, HostFeedbackSource.OutputDecoded, 8, ledNumber: 3).Encode());

        var retained = new List<FeedbackMessage>();
        while (session.Feedback.TryDequeue(out byte[]? encoded))
        {
            if (encoded is null
                || !HostProtocolCodec.TryDecode(encoded, out HostFrame? decoded, out _)
                || decoded?.Message is not FeedbackMessage feedback)
            {
                throw new InvalidOperationException("The simulator queued a non-feedback frame.");
            }
            retained.Add(feedback);
            CryptographicOperations.ZeroMemory(encoded);
        }
        FeedbackMessage latest = retained[^1];

        _ = session.Feedback.EnqueueEncoded(accumulator.Snapshot(5, HostFeedbackSource.OutputDecoded, 8, ledNumber: 4).Encode());
        TeardownResult teardown = session.Teardown(1_000_002)
            ?? throw new InvalidOperationException("First teardown was suppressed.");
        bool teardownIdempotent = session.Teardown(1_000_002) is null;

        bool healthyIdle = HealthyIdleLeaseStaysOpen();
        using var missed = new ProtocolSessionSimulator(controller);
        _ = missed.ClientUpdate(KsxPadState.Neutral, 0);
        bool leaseEarly = missed.HostLeaseTick(HostPolicy.ClientLeaseTimeoutMicroseconds - 1) is null && missed.IsControllerAlive;
        LeaseExpiryResult expired = missed.HostLeaseTick(HostPolicy.ClientLeaseTimeoutMicroseconds)
            ?? throw new InvalidOperationException("Lease did not expire at the exact deadline.");

        bool corpusParity = GoldenCorpusFrames()
            .Select(frame => Convert.ToHexString(frame.Encode()))
            .SequenceEqual(RustV1GoldenFrames.Select(vector => vector.Hex));
        var checks = new Dictionary<string, bool>(StringComparer.Ordinal)
        {
            ["allTwelveRustGoldenFramesMatch"] = corpusParity,
            ["unchangedInputEmitsNoWireFrame"] = unchanged is null,
            ["hostPumpWaitsUntilExactDeadline"] = earlyPump is null,
            ["host16msPumpHasNoWireFrame"] = localPump.State.IsNeutral && !localPump.HasWireFrame,
            ["clientHeartbeatWaitsOneSecond"] = earlyHeartbeat is null,
            ["clientHeartbeatIsFullStateSubmit"] = IsExchange(heartbeat, 2, 2, KsxPadState.Neutral),
            ["changedStateSubmitAppliedCorrelate"] = IsExchange(changed, 3, 3, held),
            ["healthyIdleLeaseStaysOpen"] = healthyIdle,
            ["leaseExpiryIsFiveSeconds"] = leaseEarly && expired.AtMicroseconds == 5_000_000,
            ["leaseExpiryNeutralHasNoWireFrame"] = expired.NeutralPublication.State.IsNeutral && !expired.NeutralPublication.HasWireFrame,
            ["leaseExpiryIsControllerScoped"] = !missed.IsControllerAlive && missed.IsConversationOpen
                && expired.OrderedSteps.SequenceEqual(["host.controller-lease-expired", "host.neutral", "host.destroy-one", "host.tombstone"]),
            ["feedbackCallbackBytesCopied"] = copiedFeedback.Status == FeedbackEnqueueStatus.Enqueued && callbackCopied,
            ["feedbackPressureDroppedOldest"] = firstFeedback.Status == FeedbackEnqueueStatus.Enqueued
                && stopFeedback.Status == FeedbackEnqueueStatus.Enqueued
                && ledOnly.Status == FeedbackEnqueueStatus.DroppedOldest
                && retained.Select(item => item.Sequence).SequenceEqual([3UL, 4UL]),
            ["ledOnlySnapshotRepeatsKnownMotorStop"] = latest.Sequence == 4
                && latest.MotorsValid && latest.LargeMotor == 0 && latest.SmallMotor == 0
                && latest.LedValid && latest.LedNumber == 3,
            ["explicitTeardownNeutralBeforeDestroy"] = teardown.NeutralPublication.State.IsNeutral
                && teardown.OrderedSteps.SequenceEqual(["client.destroy", "host.neutral", "host.destroy-one", "host.destroyed"]),
            ["explicitTeardownCorrelatesAndIsIdempotent"] = teardown.DestroyRequest.RequestId == 4
                && teardown.DestroyedResponse.RequestId == 4 && teardownIdempotent,
            ["teardownClearsAndClosesFeedback"] = session.Feedback.IsClosed && session.Feedback.Count == 0,
            ["identityBudgetIsLifetimeSixteen"] = HostPolicy.MaximumControllerIdentitiesPerSession == 16,
        };

        return new SimulationDocument(
            1,
            "simulate-protocol",
            checks.Values.All(value => value),
            HostProtocolCodec.ProtocolId,
            wire,
            sdk,
            new FeedbackSimulation(
                callbackCopied,
                session.Feedback.Capacity,
                session.Feedback.DroppedTotal,
                retained.Select(item => item.Sequence).ToArray(),
                checks["ledOnlySnapshotRepeatsKnownMotorStop"],
                latest.MotorsValid,
                latest.LargeMotor,
                latest.SmallMotor,
                latest.LedValid,
                latest.LedNumber,
                session.Feedback.IsClosed && session.Feedback.Count == 0),
            new LeaseSimulation(
                HostPolicy.ClientLeaseRefreshMicroseconds,
                HostPolicy.ClientLeaseTimeoutMicroseconds,
                healthyIdle,
                leaseEarly,
                expired.AtMicroseconds == HostPolicy.ClientLeaseTimeoutMicroseconds,
                expired.NeutralPublication.HasWireFrame,
                expired.OrderedSteps),
            new TeardownSimulation(
                true,
                teardown.NeutralPublication.State.IsNeutral,
                teardownIdempotent,
                teardown.DestroyRequest.RequestId,
                Convert.ToHexString(teardown.DestroyRequest.Encode()),
                Convert.ToHexString(teardown.DestroyedResponse.Encode()),
                teardown.OrderedSteps),
            checks,
            safety);
    }

    internal static IReadOnlyList<HostFrame> GoldenCorpusFrames()
    {
        byte[] nonce = Enumerable.Range(0, 32).Select(value => (byte)value).ToArray();
        byte[] sdkHash = Enumerable.Repeat((byte)0xA5, 32).ToArray();
        byte[] catalogHash = Enumerable.Repeat((byte)0x5A, 32).ToArray();
        var state = new KsxPadState(KsxButtons.DpadUp | KsxButtons.A, 0x12, 0x34, short.MinValue, -1, 0x1234, short.MaxValue);
        return
        [
            HostFrame.Create(1, new HelloMessage(nonce)),
            HostFrame.Create(2, new ReadyMessage(nonce, sdkHash, catalogHash, 228)),
            HostFrame.Create(3, new CreateMessage(HostProfileId.DualSense)),
            HostFrame.Create(4, new CreatedMessage(7, HostProfileId.DualSense, 0x054C, 0x0CE6)),
            HostFrame.Create(5, new SubmitMessage(7, 1, state)),
            HostFrame.Create(6, new AppliedMessage(7, 1)),
            HostFrame.Create(0, new FeedbackMessage(7, 1, HostFeedbackSource.OutputDecoded, 48, 0xAA, 0x55, 3, true, true)),
            HostFrame.Create(8, new DestroyMessage(7)),
            HostFrame.Create(9, new DestroyedMessage(7)),
            HostFrame.Create(10, new ShutdownMessage()),
            HostFrame.Create(11, new ByeMessage()),
            HostFrame.Create(12, new FaultMessage(HostFaultCode.Internal, "v1")),
        ];
    }

    internal static GoldenVector GoldenSubmitBoundary()
    {
        HostFrame frame = HostFrame.Create(
            0x1122_3344,
            new SubmitMessage(
                7,
                0x0102_0304_0506_0708,
                new KsxPadState(KsxButtons.DpadUp | KsxButtons.A, 0x12, 0x34, short.MinValue, -1, 0x1234, short.MaxValue)));
        byte[] encoded = frame.Encode();
        return new GoldenVector(
            "crates/ksx-hidmaestro/src/host.rs::submit_frame_v1_has_one_frozen_byte_layout",
            "Submit",
            encoded.Length,
            Convert.ToHexString(encoded),
            Convert.ToHexString(SHA256.HashData(encoded)));
    }

    private static ProtocolMessageShape Shape(HostMessageKind kind, string direction, string bytes, string payload) =>
        new((ushort)kind, kind.ToString(), direction, bytes, payload);

    private static WireExchangeStep WireStep(string eventName, ulong atMicroseconds, ProtocolExchange? exchange)
    {
        if (exchange is null)
            return new WireExchangeStep(eventName, atMicroseconds, false, null, null, null, null, null);
        var submit = (SubmitMessage)exchange.SubmitRequest.Message;
        return new WireExchangeStep(
            eventName,
            atMicroseconds,
            true,
            exchange.Reason.ToString(),
            exchange.SubmitRequest.RequestId,
            submit.Sequence,
            Convert.ToHexString(exchange.SubmitRequest.Encode()),
            Convert.ToHexString(exchange.AppliedResponse.Encode()));
    }

    private static HostSdkStep SdkStep(string eventName, SdkPublication publication) =>
        SdkStep(eventName, publication.AtMicroseconds, publication);

    private static HostSdkStep SdkStep(string eventName, ulong atMicroseconds, SdkPublication? publication) =>
        publication is null
            ? new HostSdkStep(eventName, atMicroseconds, false, null, false, null)
            : new HostSdkStep(eventName, atMicroseconds, true, publication.Reason.ToString(), publication.HasWireFrame, StateText(publication.State));

    private static string StateText(KsxPadState state) =>
        $"buttons=0x{(ushort)state.Buttons:X4};lt={state.LeftTrigger};rt={state.RightTrigger};" +
        $"lx={state.LeftX};ly={state.LeftY};rx={state.RightX};ry={state.RightY}";

    private static bool IsExchange(ProtocolExchange exchange, uint requestId, ulong sequence, KsxPadState state) =>
        exchange.SubmitRequest.RequestId == requestId
        && exchange.AppliedResponse.RequestId == requestId
        && exchange.SubmitRequest.Message is SubmitMessage submit
        && submit.Sequence == sequence && submit.State == state
        && exchange.AppliedResponse.Message is AppliedMessage applied
        && applied.Controller == submit.Controller && applied.Sequence == submit.Sequence;

    private static bool HealthyIdleLeaseStaysOpen()
    {
        using var healthy = new ProtocolSessionSimulator(7);
        _ = healthy.ClientUpdate(KsxPadState.Neutral, 0);
        for (ulong second = 1; second <= 6; second++)
        {
            ulong at = second * HostPolicy.ClientLeaseRefreshMicroseconds;
            if (healthy.HostLeaseTick(at - 1) is not null)
                return false;
            if (healthy.ClientLeaseHeartbeatTick(at) is null)
                return false;
            if (healthy.HostLeaseTick(at) is not null)
                return false;
        }
        return healthy.IsControllerAlive && healthy.IsConversationOpen;
    }
}
