using System.Buffers.Binary;
using Ksx.HidMaestroProbe;

namespace Ksx.HidMaestroFakeHost.Tests;

internal static class Program
{
    private const string CanonicalToken =
        "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    private static async Task<int> Main()
    {
        (string Name, Func<Task> Run)[] tests =
        [
            ("argv is fixed and canonical", () => RunSync(LaunchArgumentsAreExact)),
            ("pinned identity and personas are exact", () => RunSync(PinnedIdentityIsExact)),
            ("hello echoes nonce and real expected pin", () => RunSync(HandshakeIsExact)),
            ("all twelve directions are dispatched", () => RunSync(AllKindsAreAccountedFor)),
            ("three personas and lifetime ids are bounded", () => RunSync(PersonasAndLifetimeBudgetAreExact)),
            ("submit yields full deterministic feedback", () => RunSync(SubmitAndFeedbackAreExact)),
            ("pump and lease deadlines are host-local", () => RunSync(PumpAndLeaseAreExact)),
            ("feedback is global bounded drop-oldest", () => RunSync(FeedbackQueueIsBounded)),
            ("all exits neutralize before destroy", () => RunSync(CleanupIsOrderedAndIdempotent)),
            ("framing is exact and bounded", FramingIsExactAndBounded),
        ];

        int passed = 0;
        foreach ((string name, Func<Task> run) in tests)
        {
            try
            {
                await run().ConfigureAwait(false);
                passed++;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine($"FAIL: {name}: {error.GetType().Name}: {error.Message}");
                return 1;
            }
        }

        Console.Out.WriteLine($"{{\"schemaVersion\":1,\"command\":\"fake-host-pure-tests\",\"passed\":{passed}}}");
        return 0;
    }

    private static Task RunSync(Action action)
    {
        action();
        return Task.CompletedTask;
    }

    private static void LaunchArgumentsAreExact()
    {
        string[] args = ["serve-v1", CanonicalToken, "12345"];
        Require(LaunchArguments.TryParse(args, out LaunchArguments? launch, out _));
        Require(launch is not null);
        Require(launch.DaemonPid == 12345);
        Require(launch.PipeNameComponent == "KSX.HIDMaestro.Play.v1." + CanonicalToken);
        Require(!launch.PipeNameComponent.Contains("\\\\.\\pipe", StringComparison.Ordinal));
        Require(!launch.ToString().Contains(CanonicalToken, StringComparison.Ordinal));

        string[][] refused =
        [
            [],
            ["serve-v1", CanonicalToken],
            ["serve-v2", CanonicalToken, "12345"],
            ["serve-v1", CanonicalToken.ToUpperInvariant(), "12345"],
            ["serve-v1", CanonicalToken + "0", "12345"],
            ["serve-v1", @"..\chosen", "12345"],
            ["serve-v1", CanonicalToken, "0"],
            ["serve-v1", CanonicalToken, "012345"],
            ["serve-v1", CanonicalToken, "+12345"],
            ["serve-v1", CanonicalToken, "12345 "],
        ];
        foreach (string[] candidate in refused)
            Require(!LaunchArguments.TryParse(candidate, out _, out _));
    }

    private static void PinnedIdentityIsExact()
    {
        Require(Convert.ToHexString(FakePinnedIdentity.SdkSha256()) == FakePinnedIdentity.SdkSha256Hex);
        Require(Convert.ToHexString(FakePinnedIdentity.CatalogSha256()) == FakePinnedIdentity.CatalogSha256Hex);
        Require(FakePinnedIdentity.CatalogResourceCount == 228);
        Require(FakePinnedIdentity.ClientLeaseRefreshMicroseconds == 1_000_000);
        Require(FakePinnedIdentity.ClientLeaseTimeoutMicroseconds == 5_000_000);
        Require(FakePinnedIdentity.HostPumpIntervalMicroseconds == 16_000);

        Require(FakePinnedIdentity.Persona(HostProfileId.DualSense) == new FakePersona(HostProfileId.DualSense, 0x054C, 0x0CE6));
        Require(FakePinnedIdentity.Persona(HostProfileId.SwitchPro) == new FakePersona(HostProfileId.SwitchPro, 0x057E, 0x2009));
        Require(FakePinnedIdentity.Persona(HostProfileId.XboxSeries) == new FakePersona(HostProfileId.XboxSeries, 0x045E, 0x0B13));
    }

    private static void HandshakeIsExact()
    {
        var session = new FakeHostSession();
        byte[] nonce = Enumerable.Range(0, HostProtocolCodec.NonceBytes).Select(value => (byte)value).ToArray();
        FakeDispatchResult result = session.Dispatch(
            HostFrame.Create(1, new HelloMessage(nonce)),
            atMicroseconds: 0);

        Require(!result.CloseAfterWrite);
        Require(result.Response.RequestId == 1);
        ReadyMessage ready = RequireMessage<ReadyMessage>(result.Response);
        Require(ready.Nonce.SequenceEqual(nonce));
        Require(ready.SdkSha256.SequenceEqual(FakePinnedIdentity.SdkSha256()));
        Require(ready.CatalogSha256.SequenceEqual(FakePinnedIdentity.CatalogSha256()));
        Require(ready.CatalogResourceCount == FakePinnedIdentity.CatalogResourceCount);
        session.CleanupAll(0);
    }

    private static void AllKindsAreAccountedFor()
    {
        Require(Enum.GetValues<HostMessageKind>().Length == 12);
        HostMessage[] wrongDirection =
        [
            new ReadyMessage(new byte[32], new byte[32], new byte[32], 228),
            new CreatedMessage(1, HostProfileId.DualSense, 0x054C, 0x0CE6),
            new AppliedMessage(1, 1),
            new FeedbackMessage(1, 1, HostFeedbackSource.OutputDecoded, 0, 0, 0, 0, true, true),
            new DestroyedMessage(1),
            new ByeMessage(),
            new FaultMessage(HostFaultCode.Internal, "test"),
        ];

        foreach (HostMessage message in wrongDirection)
        {
            var session = HandshakenSession();
            uint requestId = message is FeedbackMessage ? 0u : 2u;
            FakeDispatchResult result = session.Dispatch(HostFrame.Create(requestId, message), 0);
            Require(result.CloseAfterWrite);
            Require(RequireMessage<FaultMessage>(result.Response).Code == HostFaultCode.InvalidOrder);
            session.CleanupAll(0);
        }

        var beforeHello = new FakeHostSession();
        FakeDispatchResult createFirst = beforeHello.Dispatch(
            HostFrame.Create(1, new CreateMessage(HostProfileId.DualSense)),
            0);
        Require(createFirst.CloseAfterWrite);
        Require(RequireMessage<FaultMessage>(createFirst.Response).Code == HostFaultCode.InvalidOrder);
        beforeHello.CleanupAll(0);

        var shutdown = HandshakenSession();
        _ = shutdown.Dispatch(HostFrame.Create(2, new CreateMessage(HostProfileId.DualSense)), 0);
        FakeDispatchResult bye = shutdown.Dispatch(HostFrame.Create(3, new ShutdownMessage()), 1);
        Require(bye.CloseAfterWrite && bye.ExitReason == "shutdown");
        Require(bye.Response.Message is ByeMessage);
        Require(shutdown.LiveCount == 0);

        var replay = HandshakenSession();
        FakeDispatchResult replayed = replay.Dispatch(
            HostFrame.Create(1, new CreateMessage(HostProfileId.DualSense)),
            0);
        Require(replayed.CloseAfterWrite);
        Require(RequireMessage<FaultMessage>(replayed.Response).Code == HostFaultCode.InvalidOrder);
        replay.CleanupAll(0);
    }

    private static void PersonasAndLifetimeBudgetAreExact()
    {
        var profiles = HandshakenSession();
        HostProfileId[] expected =
        [
            HostProfileId.DualSense,
            HostProfileId.SwitchPro,
            HostProfileId.XboxSeries,
        ];
        for (int index = 0; index < expected.Length; index++)
        {
            FakeDispatchResult created = profiles.Dispatch(
                HostFrame.Create((uint)(index + 2), new CreateMessage(expected[index])),
                0);
            CreatedMessage message = RequireMessage<CreatedMessage>(created.Response);
            FakePersona persona = FakePinnedIdentity.Persona(expected[index]);
            Require(message.Controller == index + 1);
            Require(message.Profile == persona.Profile);
            Require(message.VendorId == persona.VendorId && message.ProductId == persona.ProductId);
            FakeSinkEvent initial = profiles.Sink.Events.Last();
            Require(initial.Controller == message.Controller);
            Require(initial.Reason == FakePublicationReason.ControllerCreatedNeutral && initial.State.IsNeutral);
        }
        _ = profiles.Dispatch(HostFrame.Create(5, new DestroyMessage(1)), 0);
        CreatedMessage afterDestroy = RequireMessage<CreatedMessage>(profiles.Dispatch(
            HostFrame.Create(6, new CreateMessage(HostProfileId.DualSense)),
            0).Response);
        Require(afterDestroy.Controller == 4);
        profiles.CleanupAll(0);

        var capacity = HandshakenSession();
        for (uint index = 0; index < FakePinnedIdentity.MaximumControllerIdentities; index++)
        {
            FakeDispatchResult created = capacity.Dispatch(
                HostFrame.Create(index + 2, new CreateMessage(HostProfileId.DualSense)),
                0);
            Require(created.Response.Message is CreatedMessage);
        }
        FakeDispatchResult refused = capacity.Dispatch(
            HostFrame.Create(18, new CreateMessage(HostProfileId.DualSense)),
            0);
        Require(refused.CloseAfterWrite);
        Require(RequireMessage<FaultMessage>(refused.Response).Code == HostFaultCode.Capacity);
        capacity.CleanupAll(0);
    }

    private static void SubmitAndFeedbackAreExact()
    {
        var session = HandshakenSession();
        uint controller = RequireMessage<CreatedMessage>(session.Dispatch(
            HostFrame.Create(2, new CreateMessage(HostProfileId.SwitchPro)),
            0).Response).Controller;
        var state = new KsxPadState(
            KsxButtons.A | KsxButtons.Start,
            LeftTrigger: 0xAA,
            RightTrigger: 0x55,
            LeftX: short.MinValue,
            LeftY: -1,
            RightX: 0x1234,
            RightY: short.MaxValue);
        FakeDispatchResult applied = session.Dispatch(
            HostFrame.Create(3, new SubmitMessage(controller, 1, state)),
            10);
        AppliedMessage response = RequireMessage<AppliedMessage>(applied.Response);
        Require(response.Controller == controller && response.Sequence == 1);
        Require(session.TryDequeueFeedback(out byte[]? encoded) && encoded is not null);
        Require(HostProtocolCodec.TryDecode(encoded, out HostFrame? frame, out _));
        Require(frame is not null && frame.RequestId == 0);
        FeedbackMessage feedback = RequireMessage<FeedbackMessage>(frame);
        Require(feedback.Controller == controller && feedback.Sequence == 1);
        Require(feedback.Source == HostFeedbackSource.OutputDecoded && feedback.ReportLength == 0);
        Require(feedback.MotorsValid && feedback.LedValid);
        Require(feedback.LargeMotor == 0xAA && feedback.SmallMotor == 0x55);
        Require(feedback.LedNumber == (byte)HostProfileId.SwitchPro);

        FakeDispatchResult stale = session.Dispatch(
            HostFrame.Create(4, new SubmitMessage(controller, 1, state)),
            11);
        Require(stale.CloseAfterWrite);
        Require(RequireMessage<FaultMessage>(stale.Response).Code == HostFaultCode.StaleSequence);
        session.CleanupAll(11);
    }

    private static void PumpAndLeaseAreExact()
    {
        var session = HandshakenSession();
        uint controller = RequireMessage<CreatedMessage>(session.Dispatch(
            HostFrame.Create(2, new CreateMessage(HostProfileId.DualSense)),
            0).Response).Controller;

        session.Tick(15_999);
        Require(session.Sink.PumpPublications == 0);
        session.Tick(16_000);
        Require(session.Sink.PumpPublications == 1);
        session.Tick(1_000_000);
        var state = new KsxPadState(KsxButtons.B, 1, 2, 3, 4, 5, 6);
        _ = session.Dispatch(HostFrame.Create(3, new SubmitMessage(controller, 1, state)), 1_000_000);
        session.Tick(5_999_999);
        Require(session.LiveCount == 1);
        session.Tick(6_000_000);
        Require(session.LiveCount == 0);
        Require(session.Sink.NeutralizedControllers.SequenceEqual([controller]));
        Require(session.Sink.DestroyedControllers.SequenceEqual([controller]));
        Require(session.Sink.Events.Last().Reason == FakePublicationReason.LeaseExpiredNeutral);
        session.CleanupAll(6_000_000);
    }

    private static void FeedbackQueueIsBounded()
    {
        using var queue = new FakeFeedbackQueue(capacity: 2);
        queue.Enqueue(FeedbackFrame(1, 1));
        queue.Enqueue(FeedbackFrame(2, 2));
        queue.Enqueue(FeedbackFrame(1, 3));
        Require(queue.Count == 2 && queue.Dropped == 1);

        queue.Purge(1);
        Require(queue.Count == 1);
        Require(queue.TryDequeue(out byte[]? encoded) && encoded is not null);
        Require(HostProtocolCodec.TryDecode(encoded, out HostFrame? retained, out _));
        Require(RequireMessage<FeedbackMessage>(retained!).Controller == 2);
    }

    private static void CleanupIsOrderedAndIdempotent()
    {
        var session = HandshakenSession();
        _ = session.Dispatch(HostFrame.Create(2, new CreateMessage(HostProfileId.DualSense)), 0);
        _ = session.Dispatch(HostFrame.Create(3, new CreateMessage(HostProfileId.XboxSeries)), 0);
        session.CleanupAll(20);
        session.CleanupAll(20);

        Require(session.LiveAtCleanup == 2 && session.LiveCount == 0);
        Require(session.Sink.NeutralizedControllers.SequenceEqual([1u, 2u]));
        Require(session.Sink.DestroyedControllers.SequenceEqual([1u, 2u]));
        string summary = FakeHostSummary.FromSession("eof", session).ToBoundedJson();
        Require(summary.Length <= FakeHostSummary.MaximumJsonCharacters);
        Require(!summary.Contains('\n') && !summary.Contains('\r'));
        Require(!summary.Contains(CanonicalToken, StringComparison.Ordinal));
        Require(summary.Contains("\"liveAtCleanup\":2", StringComparison.Ordinal));
    }

    private static async Task FramingIsExactAndBounded()
    {
        byte[] first = HostFrame.Create(1, new HelloMessage(new byte[32])).Encode();
        byte[] second = HostFrame.Create(2, new CreateMessage(HostProfileId.DualSense)).Encode();
        byte[] joined = [.. first, .. second];
        using var chunks = new ChunkedDuplexStream(joined, maximumRead: 1);
        var framing = new PipeFrameStream(chunks);
        Require((await framing.ReadFrameAsync(CancellationToken.None).ConfigureAwait(false))?.Message is HelloMessage);
        Require((await framing.ReadFrameAsync(CancellationToken.None).ConfigureAwait(false))?.Message is CreateMessage);
        Require(await framing.ReadFrameAsync(CancellationToken.None).ConfigureAwait(false) is null);

        byte[] oversized = new byte[HostProtocolCodec.HeaderBytes];
        BinaryPrimitives.WriteUInt32LittleEndian(oversized.AsSpan(12, 4), HostProtocolCodec.MaximumPayloadBytes + 1u);
        using var oversizeStream = new ChunkedDuplexStream(oversized, maximumRead: oversized.Length);
        await RequireThrowsAsync<InvalidDataException>(() =>
            new PipeFrameStream(oversizeStream).ReadFrameAsync(CancellationToken.None).AsTask());

        using var partial = new ChunkedDuplexStream(first[..5], maximumRead: 2);
        await RequireThrowsAsync<EndOfStreamException>(() =>
            new PipeFrameStream(partial).ReadFrameAsync(CancellationToken.None).AsTask());
    }

    private static FakeHostSession HandshakenSession()
    {
        var session = new FakeHostSession();
        FakeDispatchResult hello = session.Dispatch(
            HostFrame.Create(1, new HelloMessage(new byte[32])),
            0);
        Require(hello.Response.Message is ReadyMessage && !hello.CloseAfterWrite);
        return session;
    }

    private static HostFrame FeedbackFrame(uint controller, ulong sequence) =>
        HostFrame.Create(
            0,
            new FeedbackMessage(
                controller,
                sequence,
                HostFeedbackSource.OutputDecoded,
                0,
                1,
                2,
                3,
                MotorsValid: true,
                LedValid: true));

    private static T RequireMessage<T>(HostFrame frame)
        where T : HostMessage =>
        frame.Message is T message
            ? message
            : throw new InvalidOperationException($"Expected {typeof(T).Name}; got {frame.Message.Kind}.");

    private static async Task RequireThrowsAsync<T>(Func<Task> action)
        where T : Exception
    {
        try
        {
            await action().ConfigureAwait(false);
        }
        catch (T)
        {
            return;
        }
        throw new InvalidOperationException($"Expected {typeof(T).Name}.");
    }

    private static void Require(bool condition)
    {
        if (!condition)
            throw new InvalidOperationException("Contract assertion failed.");
    }

    private sealed class ChunkedDuplexStream : Stream
    {
        private readonly byte[] _input;
        private readonly int _maximumRead;
        private int _offset;

        internal ChunkedDuplexStream(byte[] input, int maximumRead)
        {
            _input = input;
            _maximumRead = maximumRead;
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => _input.Length;
        public override long Position
        {
            get => _offset;
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            int available = Math.Min(Math.Min(count, _maximumRead), _input.Length - _offset);
            if (available == 0)
                return 0;
            _input.AsSpan(_offset, available).CopyTo(buffer.AsSpan(offset, available));
            _offset += available;
            return available;
        }

        public override ValueTask<int> ReadAsync(
            Memory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            int available = Math.Min(Math.Min(buffer.Length, _maximumRead), _input.Length - _offset);
            if (available == 0)
                return ValueTask.FromResult(0);
            _input.AsMemory(_offset, available).CopyTo(buffer);
            _offset += available;
            return ValueTask.FromResult(available);
        }

        public override void Write(byte[] buffer, int offset, int count)
        {
        }

        public override ValueTask WriteAsync(
            ReadOnlyMemory<byte> buffer,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return ValueTask.CompletedTask;
        }

        public override void Flush()
        {
        }

        public override Task FlushAsync(CancellationToken cancellationToken) =>
            Task.CompletedTask;

        public override long Seek(long offset, SeekOrigin origin) =>
            throw new NotSupportedException();

        public override void SetLength(long value) =>
            throw new NotSupportedException();
    }
}
