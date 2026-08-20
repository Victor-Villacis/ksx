using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace Ksx.HidMaestroProbe;

internal static class ProtocolSelfTests
{
    internal static IReadOnlyList<TestResult> Run() =>
    [
        RunOne("all twelve KSXH frames match the Rust golden corpus", AllGoldenFramesMatchRust),
        RunOne("Submit boundary bytes match the Rust golden vector", SubmitBoundaryMatchesRust),
        RunOne("framing and exact payload bounds are enforced", FramingBoundsAreEnforced),
        RunOne("typed values, request ids, and Capacity fault are enforced", TypedValuesAreEnforced),
        RunOne("Ready resource count and profile USB identities are exact", ReadyAndProfilesAreExact),
        RunOne("host owns 16 ms SDK pump; client owns 1 s lease heartbeat", ClientAndHostCadencesAreSeparated),
        RunOne("lease starts at create, expires per controller, and rejects backwards time", LeaseSafetyIsExact),
        RunOne("mixed controller lease deadlines preserve the conversation", MixedLeaseDeadlinesAreScoped),
        RunOne("lifetime identity budget refuses the seventeenth id with Capacity", IdentityBudgetIsEnforced),
        RunOne("feedback pressure retains a full effective motor-stop snapshot", FeedbackSnapshotsAreEffectiveState),
        RunOne("one-controller teardown neutralizes before destroy", TeardownIsDeterministic),
        RunOne("fault UTF-8 is valid and bounded", FaultTextIsBounded),
        RunOne("malformed frame corpus never escapes the decoder", MalformedCorpusDoesNotThrow),
        RunOne("deterministic protocol transcript satisfies every freeze check", TranscriptPasses),
        RunOne("Play vocabulary contains no provisioning escape hatch", VocabularyHasNoProvisioning),
    ];

    private static void AllGoldenFramesMatchRust()
    {
        IReadOnlyList<HostFrame> frames = ProtocolContract.GoldenCorpusFrames();
        IReadOnlyList<GoldenFrame> vectors = ProtocolContract.RustV1GoldenFrames;
        Require(frames.Count == 12 && vectors.Count == 12, "V1 corpus must contain exactly twelve frames.");
        Require(HostMessageKinds.All.SequenceEqual(Enum.GetValues<HostMessageKind>()), "Message kind order drifted.");

        for (int index = 0; index < frames.Count; index++)
        {
            byte[] encoded = frames[index].Encode();
            GoldenFrame expected = vectors[index];
            Require(expected.Message == frames[index].Message.Kind.ToString(), $"Golden label {index} drifted.");
            Require(encoded.Length == expected.Bytes, $"{expected.Message} byte count drifted.");
            Require(Convert.ToHexString(encoded) == expected.Hex, $"{expected.Message} differs from Rust: {Convert.ToHexString(encoded)}.");
            Require(HostProtocolCodec.TryDecode(encoded, out HostFrame? decoded, out HostProtocolError error), $"{expected.Message} failed decode: {error}.");
            Require(decoded is not null && decoded.Encode().AsSpan().SequenceEqual(encoded), $"{expected.Message} failed exact re-encode.");
        }
    }

    private static void SubmitBoundaryMatchesRust()
    {
        GoldenVector vector = ProtocolContract.GoldenSubmitBoundary();
        Require(vector.Hex == ProtocolContract.RustSubmitBoundaryHex, "Standalone Rust Submit boundary vector drifted.");
        Require(vector.Bytes == 40, "Submit must be a 16-byte header plus 24-byte payload.");
        byte[] bytes = Convert.FromHexString(vector.Hex);
        Require(vector.Sha256 == Convert.ToHexString(SHA256.HashData(bytes)), "Submit SHA-256 was not calculated over the vector.");
    }

    private static void FramingBoundsAreEnforced()
    {
        byte[] hello = ProtocolContract.GoldenCorpusFrames()[0].Encode();
        RequireError(hello.AsSpan(0, 15), HostProtocolError.FrameTooShort);
        byte[] mutated = (byte[])hello.Clone();
        mutated[0] ^= 0xFF;
        RequireError(mutated, HostProtocolError.BadMagic);
        mutated = (byte[])hello.Clone();
        BinaryPrimitives.WriteUInt16LittleEndian(mutated.AsSpan(4, 2), 2);
        RequireError(mutated, HostProtocolError.VersionMismatch);
        mutated = (byte[])hello.Clone();
        BinaryPrimitives.WriteUInt16LittleEndian(mutated.AsSpan(6, 2), 13);
        RequireError(mutated, HostProtocolError.UnknownMessageKind);
        mutated = (byte[])hello.Clone();
        BinaryPrimitives.WriteUInt32LittleEndian(mutated.AsSpan(12, 4), HostProtocolCodec.MaximumPayloadBytes + 1);
        RequireError(mutated, HostProtocolError.PayloadTooLarge);
        RequireError(hello.AsSpan(0, hello.Length - 1), HostProtocolError.PayloadLengthMismatch);
        byte[] trailing = [.. hello, 0];
        RequireError(trailing, HostProtocolError.PayloadLengthMismatch);

        foreach (HostFrame frame in ProtocolContract.GoldenCorpusFrames())
        {
            byte[] encoded = frame.Encode();
            int payloadBytes = encoded.Length - HostProtocolCodec.HeaderBytes;
            byte[] extra = [.. encoded, 0];
            BinaryPrimitives.WriteUInt32LittleEndian(extra.AsSpan(12, 4), (uint)(payloadBytes + 1));
            RequireError(extra, HostProtocolError.WrongPayloadSize);
        }
    }

    private static void TypedValuesAreEnforced()
    {
        IReadOnlyList<HostFrame> frames = ProtocolContract.GoldenCorpusFrames();
        byte[] feedback = frames[6].Encode();
        BinaryPrimitives.WriteUInt32LittleEndian(feedback.AsSpan(8, 4), 1);
        RequireError(feedback, HostProtocolError.InvalidRequestId);
        byte[] shutdown = frames[9].Encode();
        shutdown.AsSpan(8, 4).Clear();
        RequireError(shutdown, HostProtocolError.InvalidRequestId);

        byte[] create = frames[2].Encode();
        create[16] = 6;
        RequireError(create, HostProtocolError.UnknownProfile);
        byte[] submit = frames[4].Encode();
        submit.AsSpan(20, 8).Clear();
        RequireError(submit, HostProtocolError.ZeroSequence);
        submit = frames[4].Encode();
        BinaryPrimitives.WriteUInt16LittleEndian(submit.AsSpan(28, 2), 0x0800);
        RequireError(submit, HostProtocolError.UnknownButtonBits);
        feedback = frames[6].Encode();
        feedback[28] = 5;
        RequireError(feedback, HostProtocolError.UnknownFeedbackSource);
        feedback = frames[6].Encode();
        feedback[29] = 4;
        RequireError(feedback, HostProtocolError.UnknownFeedbackFlags);

        HostFrame capacity = HostFrame.Create(12, new FaultMessage(HostFaultCode.Capacity, "limit"));
        Require(HostProtocolCodec.TryDecode(capacity.Encode(), out HostFrame? decoded, out _)
            && decoded?.Message is FaultMessage { Code: HostFaultCode.Capacity }, "Capacity=8 was not accepted.");
        byte[] fault = frames[11].Encode();
        BinaryPrimitives.WriteUInt16LittleEndian(fault.AsSpan(16, 2), 9);
        RequireError(fault, HostProtocolError.UnknownFaultCode);
    }

    private static void ReadyAndProfilesAreExact()
    {
        byte[] readyBytes = ProtocolContract.GoldenCorpusFrames()[1].Encode();
        Require(HostProtocolCodec.TryDecode(readyBytes, out HostFrame? frame, out _)
            && frame?.Message is ReadyMessage { CatalogResourceCount: 228 }, "Ready must carry all 228 catalog resources.");
        ProtocolDescription description = ProtocolContract.Describe();
        Require(description.Profiles.SequenceEqual(
        [
            new ProtocolProfile(1, "DualSense", "dualsense", "0x054C", "0x0CE6"),
            new ProtocolProfile(2, "SwitchPro", "switch-pro", "0x057E", "0x2009"),
            new ProtocolProfile(3, "XboxSeries", "xbox-series-xs-bt", "0x045E", "0x0B13"),
            new ProtocolProfile(4, "Snes", "ibuffalo-snes", "0x0583", "0x2060"),
            new ProtocolProfile(5, "Genesis", "daemonbite-genesis", "0x2341", "0x8036"),
        ]), "Allowlisted profile USB identity drifted.");
        Require(description.Deadlines == new RequestDeadlines(5_000, 30_000, 250, 30_000, 30_000), "Mandatory request deadlines drifted.");
    }

    private static void ClientAndHostCadencesAreSeparated()
    {
        using var session = new ProtocolSessionSimulator(7);
        Require(session.CreationNeutralPublication.State.IsNeutral && !session.CreationNeutralPublication.HasWireFrame, "Create did not initialize host-neutral state.");
        ProtocolExchange initial = session.ClientUpdate(KsxPadState.Neutral, 0)
            ?? throw new InvalidOperationException("Initial full state was suppressed.");
        Require(IsExchange(initial, 1, 1, KsxPadState.Neutral), "Initial Submit/Applied drifted.");
        Require(session.ClientUpdate(KsxPadState.Neutral, 100) is null, "Unchanged input emitted wire traffic.");
        Require(session.HostSdkTick(15_999) is null, "Host SDK pump fired early.");
        SdkPublication pump = session.HostSdkTick(16_000)
            ?? throw new InvalidOperationException("Host SDK pump did not fire at 16 ms.");
        Require(pump.Reason == SdkPublicationReason.PeriodicPump && !pump.HasWireFrame && pump.State.IsNeutral, "16 ms pump became a KSXH request.");
        Require(session.ClientLeaseHeartbeatTick(999_999) is null, "Lease heartbeat fired early.");
        ProtocolExchange heartbeat = session.ClientLeaseHeartbeatTick(1_000_000)
            ?? throw new InvalidOperationException("Lease heartbeat did not fire at one second.");
        Require(IsExchange(heartbeat, 2, 2, KsxPadState.Neutral), "Lease heartbeat was not a correlated full-state Submit.");
        var held = KsxPadState.Neutral with { Buttons = KsxButtons.A, LeftTrigger = 255 };
        ProtocolExchange changed = session.ClientUpdate(held, 1_000_001)
            ?? throw new InvalidOperationException("Changed state was suppressed.");
        Require(IsExchange(changed, 3, 3, held), "Changed Submit/Applied drifted.");
    }

    private static void LeaseSafetyIsExact()
    {
        using var preSubmit = new ProtocolSessionSimulator(7);
        Require(preSubmit.HostLeaseTick(4_999_999) is null && preSubmit.IsControllerAlive, "Pre-Submit lease expired early.");
        LeaseExpiryResult expired = preSubmit.HostLeaseTick(5_000_000)
            ?? throw new InvalidOperationException("Created controller did not expire without first Submit.");
        Require(!preSubmit.IsControllerAlive && preSubmit.IsConversationOpen, "One lease expiry closed the conversation.");
        Require(expired.NeutralPublication.State.IsNeutral && !expired.NeutralPublication.HasWireFrame, "Expiry did not neutralize internally.");
        Require(expired.OrderedSteps.SequenceEqual(["host.controller-lease-expired", "host.neutral", "host.destroy-one", "host.tombstone"]), "Expiry scope/order drifted.");

        using var monotonic = new ProtocolSessionSimulator(8, createdAtMicroseconds: 100);
        RequireThrows<ArgumentOutOfRangeException>(() => monotonic.HostLeaseTick(99));
        RequireThrows<ArgumentOutOfRangeException>(() => monotonic.Teardown(99));
    }

    private static void MixedLeaseDeadlinesAreScoped()
    {
        var leases = new ControllerLeaseBook();
        leases.Add(1, 0);
        leases.Add(2, 0);
        leases.Renew(2, 4_000_000);
        Require(leases.ExpireDue(4_999_999).Count == 0, "Controller expired early.");
        Require(leases.ExpireDue(5_000_000).SequenceEqual([1U]), "First deadline did not expire only controller 1.");
        Require(leases.Contains(2) && leases.Count == 1, "Controller 2 was killed by controller 1 expiry.");
        Require(leases.ExpireDue(9_000_000).SequenceEqual([2U]), "Renewed controller deadline drifted.");
    }

    private static void IdentityBudgetIsEnforced()
    {
        var budget = new ControllerIdentityBudget();
        var issued = new List<uint>();
        for (int index = 0; index < 16; index++)
        {
            IdentityIssueResult result = budget.Issue();
            Require(result is { Ok: true, Controller: not null, Fault: null }, $"Identity {index + 1} was refused.");
            uint controller = result.Controller!.Value;
            issued.Add(controller);
            Require(budget.Destroy(controller) && budget.IsTombstoned(controller), "Destroyed identity was not tombstoned.");
        }
        Require(issued.SequenceEqual(Enumerable.Range(1, 16).Select(value => (uint)value)), "Controller identities were reused or skipped.");
        IdentityIssueResult seventeenth = budget.Issue();
        Require(seventeenth == new IdentityIssueResult(false, null, HostFaultCode.Capacity), "Seventeenth identity was not refused with Capacity.");
        Require(budget.Issued == 16 && budget.Live == 0 && budget.Tombstones == 16, "Lifetime budget accounting drifted.");
        var reconnect = new ControllerIdentityBudget();
        Require(reconnect.Issue().Controller == 1, "New conversation did not reset the lifetime budget.");
    }

    private static void FeedbackSnapshotsAreEffectiveState()
    {
        var accumulator = new EffectiveFeedbackAccumulator(7);
        using var queue = new BoundedFeedbackQueue(7, 2);
        byte[] callback = accumulator.Snapshot(1, HostFeedbackSource.OutputDecoded, 48, new MotorUpdate(0xAA, 0x55)).Encode();
        byte[] expectedCopy = (byte[])callback.Clone();
        Require(queue.EnqueueEncoded(callback).Status == FeedbackEnqueueStatus.Enqueued, "Initial callback was rejected.");
        callback.AsSpan().Fill(0xCC);
        Require(queue.TryDequeue(out byte[]? copied) && copied is not null && copied.AsSpan().SequenceEqual(expectedCopy), "Queue retained the caller-owned callback buffer.");
        if (copied is not null) CryptographicOperations.ZeroMemory(copied);

        Require(queue.EnqueueEncoded(accumulator.Snapshot(2, HostFeedbackSource.OutputDecoded, 48, new MotorUpdate(0xAA, 0x55)).Encode()).Status == FeedbackEnqueueStatus.Enqueued, "Initial motors were rejected.");
        Require(queue.EnqueueEncoded(accumulator.Snapshot(3, HostFeedbackSource.OutputDecoded, 48, new MotorUpdate(0, 0)).Encode()).Status == FeedbackEnqueueStatus.Enqueued, "Motor stop was rejected.");
        Require(queue.EnqueueEncoded(accumulator.Snapshot(4, HostFeedbackSource.OutputDecoded, 8, ledNumber: 3).Encode()).Status == FeedbackEnqueueStatus.DroppedOldest, "Pressure did not drop oldest.");

        var retained = new List<FeedbackMessage>();
        while (queue.TryDequeue(out byte[]? bytes))
        {
            HostFrame? frame = null;
            Require(bytes is not null && HostProtocolCodec.TryDecode(bytes, out frame, out _)
                && frame?.Message is FeedbackMessage, "Queued feedback did not decode.");
            retained.Add((FeedbackMessage)frame!.Message);
            CryptographicOperations.ZeroMemory(bytes!);
        }
        FeedbackMessage latest = retained[^1];
        Require(retained.Select(item => item.Sequence).SequenceEqual([3UL, 4UL]), "Wrong feedback snapshots survived pressure.");
        Require(latest.MotorsValid && latest.LargeMotor == 0 && latest.SmallMotor == 0
            && latest.LedValid && latest.LedNumber == 3, "LED-only callback failed to repeat known motor stop.");
        RequireThrows<ArgumentOutOfRangeException>(() => accumulator.Snapshot(4, HostFeedbackSource.OutputDecoded, 1));
    }

    private static void TeardownIsDeterministic()
    {
        using var session = new ProtocolSessionSimulator(7);
        _ = session.ClientUpdate(KsxPadState.Neutral with { Buttons = KsxButtons.A }, 0);
        _ = session.Feedback.EnqueueEncoded(session.FeedbackAccumulator.Snapshot(1, HostFeedbackSource.OutputDecoded, 48, new MotorUpdate(9, 9)).Encode());
        TeardownResult teardown = session.Teardown(1)
            ?? throw new InvalidOperationException("First teardown was suppressed.");
        Require(teardown.DestroyRequest.RequestId == 2 && teardown.DestroyedResponse.RequestId == 2, "Destroy response lost correlation.");
        Require(teardown.NeutralPublication.State.IsNeutral && !teardown.NeutralPublication.HasWireFrame, "Teardown neutral became wire traffic.");
        Require(teardown.OrderedSteps.SequenceEqual(["client.destroy", "host.neutral", "host.destroy-one", "host.destroyed"]), "Teardown order drifted.");
        Require(session.Teardown(1) is null && !session.IsControllerAlive && session.IsConversationOpen, "Teardown was not controller-scoped/idempotent.");
        Require(session.Feedback.IsClosed && session.Feedback.Count == 0, "Teardown did not clear feedback.");
        RequireThrows<ObjectDisposedException>(() => session.ClientUpdate(KsxPadState.Neutral, 2));
    }

    private static void FaultTextIsBounded()
    {
        string exact = string.Concat(Enumerable.Repeat("é", 128));
        HostFrame maximum = HostFrame.Create(1, new FaultMessage(HostFaultCode.Internal, exact));
        Require(maximum.Encode().Length == HostProtocolCodec.HeaderBytes + 260, "256-byte UTF-8 detail did not fit exactly.");
        RequireThrows<ArgumentException>(() => HostFrame.Create(1, new FaultMessage(HostFaultCode.Internal, exact + "é")));
        byte[] invalid = HostFrame.Create(1, new FaultMessage(HostFaultCode.Internal, "x")).Encode();
        invalid[^1] = 0xFF;
        RequireError(invalid, HostProtocolError.FaultDetailUtf8);
    }

    private static void MalformedCorpusDoesNotThrow()
    {
        ulong seed = 0xC0DE_CAFE_1234_5678;
        for (int length = 0; length <= HostProtocolCodec.MaximumFrameBytes + 64; length++)
        {
            var bytes = new byte[length];
            for (int index = 0; index < bytes.Length; index++)
            {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                bytes[index] = (byte)seed;
            }
            if (length >= 4) Encoding.ASCII.GetBytes("KSXH").CopyTo(bytes, 0);
            if (length >= 6) BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(4, 2), 1);
            if (length >= 8) BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(6, 2), (ushort)((length % 14) + 1));
            if (length >= HostProtocolCodec.HeaderBytes)
            {
                int declared = length % 5 == 0 ? HostProtocolCodec.MaximumPayloadBytes + 1 : length - HostProtocolCodec.HeaderBytes;
                BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(12, 4), (uint)declared);
            }
            _ = HostProtocolCodec.TryDecode(bytes, out _, out _);
        }
    }

    private static void TranscriptPasses()
    {
        SimulationDocument transcript = ProtocolContract.Simulate(new SafetyReport(true, false, false, "deferred", "pure test"));
        Require(transcript.Ok, string.Join(", ", transcript.Checks.Where(check => !check.Value).Select(check => check.Key)));
    }

    private static void VocabularyHasNoProvisioning()
    {
        string words = string.Join(',', HostMessageKinds.All).ToLowerInvariant();
        foreach (string forbidden in new[] { "install", "sweep", "certificate", "descriptor", "execute", "command", "path" })
            Require(!words.Contains(forbidden, StringComparison.Ordinal), $"Play vocabulary contains '{forbidden}'.");
    }

    private static bool IsExchange(ProtocolExchange exchange, uint requestId, ulong sequence, KsxPadState state) =>
        exchange.SubmitRequest.RequestId == requestId
        && exchange.AppliedResponse.RequestId == requestId
        && exchange.SubmitRequest.Message is SubmitMessage submit
        && submit.Sequence == sequence && submit.State == state
        && exchange.AppliedResponse.Message is AppliedMessage applied
        && applied.Controller == submit.Controller && applied.Sequence == submit.Sequence;

    private static void RequireError(ReadOnlySpan<byte> bytes, HostProtocolError expected)
    {
        bool ok = HostProtocolCodec.TryDecode(bytes, out _, out HostProtocolError actual);
        Require(!ok && actual == expected, $"Expected {expected}, got {(ok ? "success" : actual)}.");
    }

    private static void RequireThrows<TException>(Action action) where TException : Exception
    {
        try { action(); }
        catch (TException) { return; }
        throw new InvalidOperationException($"Expected {typeof(TException).Name}.");
    }

    private static TestResult RunOne(string name, Action test)
    {
        try { test(); return new TestResult(name, true, "passed"); }
        catch (Exception exception) { return new TestResult(name, false, exception.Message); }
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
