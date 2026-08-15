using System.Security.Cryptography;

namespace Ksx.HidMaestroProbe;

internal static class HostPolicy
{
    // Lifetime identity budget: destroyed ids are never recycled in-session.
    internal const int MaximumControllerIdentitiesPerSession = 16;
    internal const ulong SdkPumpIntervalMicroseconds = 16_000;
    internal const ulong ClientLeaseRefreshMicroseconds = 1_000_000;
    internal const ulong ClientLeaseTimeoutMicroseconds = 5_000_000;
    internal const int MaximumQueuedFeedback = 64;
}

internal enum ClientSubmissionReason
{
    Initial,
    Changed,
    LeaseHeartbeat,
}

internal enum SdkPublicationReason
{
    ControllerCreatedNeutral,
    WireSubmit,
    PeriodicPump,
    ExplicitTeardownNeutral,
    LeaseExpiredNeutral,
}

internal sealed record ClientSubmission(
    ClientSubmissionReason Reason,
    ulong AtMicroseconds,
    ulong Sequence,
    KsxPadState State);

internal sealed record SdkPublication(
    SdkPublicationReason Reason,
    ulong AtMicroseconds,
    KsxPadState State,
    bool HasWireFrame);

/// <summary>
/// Ordinary-process policy. Input changes become full-state Submit requests;
/// unchanged input does not. A separate slow timer sends the cached full state
/// at one second only to renew the host's safety lease.
/// </summary>
internal sealed class ClientSubmissionCadence
{
    private bool _hasObservedTime;
    private bool _hasSubmitted;
    private ulong _lastObservedMicroseconds;
    private ulong _lastSubmittedMicroseconds;
    private ulong _nextSequence = 1;
    private KsxPadState _cached = KsxPadState.Neutral;

    internal KsxPadState Cached => _cached;

    internal ClientSubmission? Update(KsxPadState state, ulong atMicroseconds)
    {
        Observe(atMicroseconds);
        if (!_hasSubmitted)
        {
            _cached = state;
            return Publish(ClientSubmissionReason.Initial, atMicroseconds);
        }
        if (state == _cached)
            return null;

        _cached = state;
        return Publish(ClientSubmissionReason.Changed, atMicroseconds);
    }

    internal ClientSubmission? LeaseHeartbeatTick(ulong atMicroseconds)
    {
        Observe(atMicroseconds);
        if (!_hasSubmitted
            || atMicroseconds - _lastSubmittedMicroseconds < HostPolicy.ClientLeaseRefreshMicroseconds)
        {
            return null;
        }
        return Publish(ClientSubmissionReason.LeaseHeartbeat, atMicroseconds);
    }

    private ClientSubmission Publish(ClientSubmissionReason reason, ulong atMicroseconds)
    {
        if (_nextSequence == 0)
            throw new InvalidOperationException("The KSXH state sequence is exhausted.");

        ulong sequence = _nextSequence;
        _nextSequence = sequence == ulong.MaxValue ? 0 : sequence + 1;
        _hasSubmitted = true;
        _lastSubmittedMicroseconds = atMicroseconds;
        return new ClientSubmission(reason, atMicroseconds, sequence, _cached);
    }

    private void Observe(ulong atMicroseconds)
    {
        if (_hasObservedTime && atMicroseconds < _lastObservedMicroseconds)
            throw new ArgumentOutOfRangeException(nameof(atMicroseconds), "Simulation time may not move backwards.");
        _hasObservedTime = true;
        _lastObservedMicroseconds = atMicroseconds;
    }
}

/// <summary>
/// Privileged-host policy. The host caches each accepted full state and pumps
/// it to the SDK every 16 ms internally. Periodic publications carry no KSXH
/// request and therefore cause no synchronous client round trip.
/// </summary>
internal sealed class HostSdkPump
{
    private bool _hasObservedTime;
    private bool _hasState;
    private ulong _lastObservedMicroseconds;
    private ulong _lastPublishedMicroseconds;
    private KsxPadState _cached = KsxPadState.Neutral;

    internal KsxPadState Cached => _cached;

    internal SdkPublication InitializeNeutral(ulong atMicroseconds)
    {
        Observe(atMicroseconds);
        _cached = KsxPadState.Neutral;
        _hasState = true;
        _lastPublishedMicroseconds = atMicroseconds;
        return new SdkPublication(
            SdkPublicationReason.ControllerCreatedNeutral,
            atMicroseconds,
            _cached,
            HasWireFrame: false);
    }

    internal SdkPublication Accept(ClientSubmission submission)
    {
        Observe(submission.AtMicroseconds);
        _cached = submission.State;
        _hasState = true;
        _lastPublishedMicroseconds = submission.AtMicroseconds;
        return new SdkPublication(
            SdkPublicationReason.WireSubmit,
            submission.AtMicroseconds,
            _cached,
            HasWireFrame: true);
    }

    internal SdkPublication? Tick(ulong atMicroseconds)
    {
        Observe(atMicroseconds);
        if (!_hasState
            || atMicroseconds - _lastPublishedMicroseconds < HostPolicy.SdkPumpIntervalMicroseconds)
        {
            return null;
        }

        _lastPublishedMicroseconds = atMicroseconds;
        return new SdkPublication(
            SdkPublicationReason.PeriodicPump,
            atMicroseconds,
            _cached,
            HasWireFrame: false);
    }

    private void Observe(ulong atMicroseconds)
    {
        if (_hasObservedTime && atMicroseconds < _lastObservedMicroseconds)
            throw new ArgumentOutOfRangeException(nameof(atMicroseconds), "Host time may not move backwards.");
        _hasObservedTime = true;
        _lastObservedMicroseconds = atMicroseconds;
    }
}

internal enum FeedbackEnqueueStatus
{
    Enqueued,
    DroppedOldest,
    InvalidFrame,
    WrongController,
    StaleSequence,
    TooLarge,
    Closed,
}

internal sealed record FeedbackEnqueueResult(
    FeedbackEnqueueStatus Status,
    HostProtocolError ProtocolError,
    ulong DroppedTotal);

/// <summary>
/// Single-threaded conformance model of the callback boundary. A production
/// queue needs an explicitly reviewed synchronization/nonblocking strategy.
/// </summary>
internal sealed class BoundedFeedbackQueue : IDisposable
{
    private readonly Queue<byte[]> _frames = new();
    private readonly int _capacity;
    private readonly uint _controller;
    private bool _closed;
    private ulong _droppedTotal;
    private ulong _lastAcceptedSequence;

    internal BoundedFeedbackQueue(uint controller, int capacity = HostPolicy.MaximumQueuedFeedback)
    {
        if (controller == 0)
            throw new ArgumentOutOfRangeException(nameof(controller));
        if (capacity is < 1 or > HostPolicy.MaximumQueuedFeedback)
            throw new ArgumentOutOfRangeException(nameof(capacity));
        _controller = controller;
        _capacity = capacity;
    }

    internal int Count => _frames.Count;
    internal int Capacity => _capacity;
    internal bool IsClosed => _closed;
    internal ulong DroppedTotal => _droppedTotal;

    internal FeedbackEnqueueResult EnqueueEncoded(ReadOnlySpan<byte> encoded)
    {
        if (_closed)
            return Result(FeedbackEnqueueStatus.Closed);
        if (encoded.Length > HostProtocolCodec.MaximumFrameBytes)
            return Result(FeedbackEnqueueStatus.TooLarge);
        if (!HostProtocolCodec.TryDecode(encoded, out HostFrame? frame, out HostProtocolError error)
            || frame?.Message is not FeedbackMessage feedback)
        {
            return Result(FeedbackEnqueueStatus.InvalidFrame, error);
        }
        if (feedback.Controller != _controller)
            return Result(FeedbackEnqueueStatus.WrongController);
        if (feedback.Sequence <= _lastAcceptedSequence)
            return Result(FeedbackEnqueueStatus.StaleSequence);

        FeedbackEnqueueStatus status = FeedbackEnqueueStatus.Enqueued;
        if (_frames.Count == _capacity)
        {
            byte[] dropped = _frames.Dequeue();
            CryptographicOperations.ZeroMemory(dropped);
            _droppedTotal++;
            status = FeedbackEnqueueStatus.DroppedOldest;
        }

        _frames.Enqueue(encoded.ToArray());
        _lastAcceptedSequence = feedback.Sequence;
        return Result(status);
    }

    internal bool TryDequeue(out byte[]? encoded)
    {
        if (_frames.TryDequeue(out byte[]? owned))
        {
            encoded = owned;
            return true;
        }
        encoded = null;
        return false;
    }

    internal void Close()
    {
        if (_closed)
            return;
        while (_frames.TryDequeue(out byte[]? encoded))
            CryptographicOperations.ZeroMemory(encoded);
        _closed = true;
    }

    public void Dispose() => Close();

    private FeedbackEnqueueResult Result(
        FeedbackEnqueueStatus status,
        HostProtocolError error = HostProtocolError.None) =>
        new(status, error, _droppedTotal);
}

internal readonly record struct MotorUpdate(byte Large, byte Small);

/// <summary>
/// Converts partial SDK callbacks into complete effective feedback snapshots.
/// Validity bits mean "known", never "changed". Later snapshots repeat every
/// known field, making drop-oldest/coalescing safe.
/// </summary>
internal sealed class EffectiveFeedbackAccumulator
{
    private readonly uint _controller;
    private bool _motorsKnown;
    private bool _ledKnown;
    private byte _largeMotor;
    private byte _smallMotor;
    private byte _ledNumber;
    private ulong _lastSequence;

    internal EffectiveFeedbackAccumulator(uint controller)
    {
        if (controller == 0)
            throw new ArgumentOutOfRangeException(nameof(controller));
        _controller = controller;
    }

    internal HostFrame Snapshot(
        ulong sequence,
        HostFeedbackSource source,
        ushort reportLength,
        MotorUpdate? motors = null,
        byte? ledNumber = null)
    {
        if (sequence == 0 || sequence <= _lastSequence)
            throw new ArgumentOutOfRangeException(nameof(sequence), "Feedback sequence must strictly advance.");
        if (motors is MotorUpdate motorUpdate)
        {
            _motorsKnown = true;
            _largeMotor = motorUpdate.Large;
            _smallMotor = motorUpdate.Small;
        }
        if (ledNumber is byte led)
        {
            _ledKnown = true;
            _ledNumber = led;
        }
        _lastSequence = sequence;
        return HostFrame.Create(
            0,
            new FeedbackMessage(
                _controller,
                sequence,
                source,
                reportLength,
                _largeMotor,
                _smallMotor,
                _ledNumber,
                MotorsValid: _motorsKnown,
                LedValid: _ledKnown));
    }
}

internal sealed record ProtocolExchange(
    ClientSubmissionReason Reason,
    ulong AtMicroseconds,
    HostFrame SubmitRequest,
    SdkPublication SdkPublication,
    HostFrame AppliedResponse);

internal sealed record TeardownResult(
    HostFrame DestroyRequest,
    SdkPublication NeutralPublication,
    HostFrame DestroyedResponse,
    IReadOnlyList<string> OrderedSteps);

internal sealed record LeaseExpiryResult(
    ulong AtMicroseconds,
    SdkPublication NeutralPublication,
    IReadOnlyList<string> OrderedSteps);

internal sealed record IdentityIssueResult(bool Ok, uint? Controller, HostFaultCode? Fault);

/// <summary>
/// Minimal lifetime allocator model: at most sixteen identities are minted in
/// a conversation. Destroy tombstones an id; it never restores capacity or
/// allows that id to be reused. A new instance represents reconnect/reset.
/// </summary>
internal sealed class ControllerIdentityBudget
{
    private readonly HashSet<uint> _live = [];
    private readonly HashSet<uint> _tombstones = [];
    private uint _next = 1;
    private int _issued;

    internal int Issued => _issued;
    internal int Live => _live.Count;
    internal int Tombstones => _tombstones.Count;

    internal IdentityIssueResult Issue()
    {
        if (_issued == HostPolicy.MaximumControllerIdentitiesPerSession)
            return new IdentityIssueResult(false, null, HostFaultCode.Capacity);

        uint controller = _next++;
        _issued++;
        _live.Add(controller);
        return new IdentityIssueResult(true, controller, null);
    }

    internal bool Destroy(uint controller)
    {
        if (!_live.Remove(controller))
            return false;
        _tombstones.Add(controller);
        return true;
    }

    internal bool IsTombstoned(uint controller) => _tombstones.Contains(controller);
}

/// <summary>
/// Per-controller lease model used to prove mixed deadlines: expiry removes
/// only due controllers and does not close the surrounding conversation.
/// </summary>
internal sealed class ControllerLeaseBook
{
    private readonly Dictionary<uint, ulong> _renewedAt = [];
    private ulong _lastObservedMicroseconds;

    internal int Count => _renewedAt.Count;

    internal void Add(uint controller, ulong createdAtMicroseconds)
    {
        Observe(createdAtMicroseconds);
        if (controller == 0 || !_renewedAt.TryAdd(controller, createdAtMicroseconds))
            throw new ArgumentOutOfRangeException(nameof(controller));
    }

    internal void Renew(uint controller, ulong atMicroseconds)
    {
        Observe(atMicroseconds);
        if (!_renewedAt.ContainsKey(controller))
            throw new KeyNotFoundException($"Unknown controller {controller}.");
        _renewedAt[controller] = atMicroseconds;
    }

    internal IReadOnlyList<uint> ExpireDue(ulong atMicroseconds)
    {
        Observe(atMicroseconds);
        uint[] due = _renewedAt
            .Where(pair => atMicroseconds - pair.Value >= HostPolicy.ClientLeaseTimeoutMicroseconds)
            .Select(pair => pair.Key)
            .Order()
            .ToArray();
        foreach (uint controller in due)
            _renewedAt.Remove(controller);
        return due;
    }

    internal bool Contains(uint controller) => _renewedAt.ContainsKey(controller);

    private void Observe(ulong atMicroseconds)
    {
        if (atMicroseconds < _lastObservedMicroseconds)
            throw new ArgumentOutOfRangeException(nameof(atMicroseconds), "Lease-book time may not move backwards.");
        _lastObservedMicroseconds = atMicroseconds;
    }
}

/// <summary>
/// One-controller, single-threaded in-memory conversation. No SDK object or
/// lifecycle API is constructed or called.
/// </summary>
internal sealed class ProtocolSessionSimulator : IDisposable
{
    private readonly ClientSubmissionCadence _client = new();
    private readonly HostSdkPump _hostPump = new();
    private uint _nextRequestId = 1;
    private ulong _leaseRenewedAtMicroseconds;
    private ulong _lastHostObservedMicroseconds;
    private bool _controllerAlive = true;
    private bool _conversationOpen = true;

    internal ProtocolSessionSimulator(
        uint controller,
        int feedbackCapacity = HostPolicy.MaximumQueuedFeedback,
        ulong createdAtMicroseconds = 0)
    {
        if (controller == 0)
            throw new ArgumentOutOfRangeException(nameof(controller));
        Controller = controller;
        Feedback = new BoundedFeedbackQueue(controller, feedbackCapacity);
        FeedbackAccumulator = new EffectiveFeedbackAccumulator(controller);
        _leaseRenewedAtMicroseconds = createdAtMicroseconds;
        _lastHostObservedMicroseconds = createdAtMicroseconds;
        CreationNeutralPublication = _hostPump.InitializeNeutral(createdAtMicroseconds);
    }

    internal uint Controller { get; }
    internal BoundedFeedbackQueue Feedback { get; }
    internal EffectiveFeedbackAccumulator FeedbackAccumulator { get; }
    internal SdkPublication CreationNeutralPublication { get; }
    internal bool IsControllerAlive => _controllerAlive;
    internal bool IsConversationOpen => _conversationOpen;

    internal ProtocolExchange? ClientUpdate(KsxPadState state, ulong atMicroseconds)
    {
        ThrowIfClosed();
        return Exchange(_client.Update(state, atMicroseconds));
    }

    internal ProtocolExchange? ClientLeaseHeartbeatTick(ulong atMicroseconds)
    {
        ThrowIfClosed();
        return Exchange(_client.LeaseHeartbeatTick(atMicroseconds));
    }

    internal SdkPublication? HostSdkTick(ulong atMicroseconds)
    {
        ThrowIfClosed();
        ObserveHostTime(atMicroseconds);
        return _hostPump.Tick(atMicroseconds);
    }

    internal LeaseExpiryResult? HostLeaseTick(ulong atMicroseconds)
    {
        if (!_controllerAlive)
            return null;
        ObserveHostTime(atMicroseconds);
        if (atMicroseconds - _leaseRenewedAtMicroseconds < HostPolicy.ClientLeaseTimeoutMicroseconds)
            return null;

        var neutral = new SdkPublication(
            SdkPublicationReason.LeaseExpiredNeutral,
            atMicroseconds,
            KsxPadState.Neutral,
            HasWireFrame: false);
        Feedback.Close();
        _controllerAlive = false;
        return new LeaseExpiryResult(
            atMicroseconds,
            neutral,
            ["host.controller-lease-expired", "host.neutral", "host.destroy-one", "host.tombstone"]);
    }

    internal TeardownResult? Teardown(ulong atMicroseconds)
    {
        if (!_controllerAlive)
            return null;
        ObserveHostTime(atMicroseconds);

        uint requestId = TakeRequestId();
        HostFrame destroy = HostFrame.Create(requestId, new DestroyMessage(Controller));
        var neutral = new SdkPublication(
            SdkPublicationReason.ExplicitTeardownNeutral,
            atMicroseconds,
            KsxPadState.Neutral,
            HasWireFrame: false);
        HostFrame destroyed = HostFrame.Create(requestId, new DestroyedMessage(Controller));
        Feedback.Close();
        _controllerAlive = false;
        return new TeardownResult(
            destroy,
            neutral,
            destroyed,
            ["client.destroy", "host.neutral", "host.destroy-one", "host.destroyed"]);
    }

    public void Dispose()
    {
        _ = Teardown(_lastHostObservedMicroseconds);
        _conversationOpen = false;
    }

    private ProtocolExchange? Exchange(ClientSubmission? submission)
    {
        if (submission is null)
            return null;
        ObserveHostTime(submission.AtMicroseconds);
        uint requestId = TakeRequestId();
        HostFrame request = HostFrame.Create(
            requestId,
            new SubmitMessage(Controller, submission.Sequence, submission.State));
        SdkPublication sdk = _hostPump.Accept(submission);
        _leaseRenewedAtMicroseconds = submission.AtMicroseconds;
        HostFrame response = HostFrame.Create(requestId, new AppliedMessage(Controller, submission.Sequence));
        return new ProtocolExchange(submission.Reason, submission.AtMicroseconds, request, sdk, response);
    }

    private uint TakeRequestId()
    {
        if (_nextRequestId == 0)
            throw new InvalidOperationException("The KSXH request id space is exhausted.");
        uint requestId = _nextRequestId;
        _nextRequestId = requestId == uint.MaxValue ? 0 : requestId + 1;
        return requestId;
    }

    private void ThrowIfClosed()
    {
        if (!_controllerAlive)
            throw new ObjectDisposedException(nameof(ProtocolSessionSimulator));
    }

    private void ObserveHostTime(ulong atMicroseconds)
    {
        if (atMicroseconds < _lastHostObservedMicroseconds)
            throw new ArgumentOutOfRangeException(nameof(atMicroseconds), "Host time may not move backwards.");
        _lastHostObservedMicroseconds = atMicroseconds;
    }
}
