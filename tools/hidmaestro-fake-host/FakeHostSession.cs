using Ksx.HidMaestroProbe;

namespace Ksx.HidMaestroFakeHost;

internal sealed record FakeDispatchResult(
    HostFrame Response,
    bool CloseAfterWrite,
    string ExitReason);

internal sealed class FakeHostSession
{
    private sealed class LiveController
    {
        internal LiveController(uint id, FakePersona persona, ulong now)
        {
            Id = id;
            Persona = persona;
            LeaseRenewedAt = now;
            LastPublishedAt = now;
        }

        internal uint Id { get; }
        internal FakePersona Persona { get; }
        internal KsxPadState State { get; set; } = KsxPadState.Neutral;
        internal ulong LastSequence { get; set; }
        internal ulong LeaseRenewedAt { get; set; }
        internal ulong LastPublishedAt { get; set; }
    }

    private readonly SortedDictionary<uint, LiveController> _live = [];
    private readonly FakeSink _sink;
    private readonly FakeFeedbackQueue _feedback;
    private uint _lastRequestId;
    private uint _nextController = 1;
    private int _issued;
    private ulong _nextFeedbackSequence = 1;
    private ulong _lastObservedMicroseconds;
    private bool _handshaken;
    private bool _terminal;
    private int? _liveAtCleanup;

    internal FakeHostSession(FakeSink? sink = null, FakeFeedbackQueue? feedback = null)
    {
        _sink = sink ?? new FakeSink();
        _feedback = feedback ?? new FakeFeedbackQueue();
    }

    internal bool Handshaken => _handshaken;
    internal bool IsTerminal => _terminal;
    internal int IssuedCount => _issued;
    internal int LiveCount => _live.Count;
    internal int LiveAtCleanup => _liveAtCleanup ?? _live.Count;
    internal FakeSink Sink => _sink;
    internal FakeFeedbackQueue Feedback => _feedback;

    internal FakeDispatchResult Dispatch(HostFrame frame, ulong atMicroseconds)
    {
        Observe(atMicroseconds);
        uint requestId = frame.RequestId;

        if (frame.Message.Kind.Direction() != HostDirection.ClientToHost)
            return TerminalFault(requestId, HostFaultCode.InvalidOrder, "host received a response message");
        if (_terminal)
            return TerminalFault(requestId, HostFaultCode.InvalidOrder, "host is closed");
        if (requestId <= _lastRequestId)
            return TerminalFault(requestId, HostFaultCode.InvalidOrder, "request id did not advance");

        _lastRequestId = requestId;
        return frame.Message switch
        {
            HelloMessage hello when !_handshaken => AcceptHello(requestId, hello),
            HelloMessage => TerminalFault(requestId, HostFaultCode.InvalidOrder, "hello already completed"),
            _ when !_handshaken => TerminalFault(requestId, HostFaultCode.InvalidOrder, "hello must be first"),
            CreateMessage create => AcceptCreate(requestId, create, atMicroseconds),
            SubmitMessage submit => AcceptSubmit(requestId, submit, atMicroseconds),
            DestroyMessage destroy => AcceptDestroy(requestId, destroy, atMicroseconds),
            ShutdownMessage => AcceptShutdown(requestId, atMicroseconds),
            ReadyMessage => TerminalFault(requestId, HostFaultCode.InvalidOrder, "host received Ready"),
            CreatedMessage => TerminalFault(requestId, HostFaultCode.InvalidOrder, "host received Created"),
            AppliedMessage => TerminalFault(requestId, HostFaultCode.InvalidOrder, "host received Applied"),
            FeedbackMessage => TerminalFault(requestId, HostFaultCode.InvalidOrder, "host received Feedback"),
            DestroyedMessage => TerminalFault(requestId, HostFaultCode.InvalidOrder, "host received Destroyed"),
            ByeMessage => TerminalFault(requestId, HostFaultCode.InvalidOrder, "host received Bye"),
            FaultMessage => TerminalFault(requestId, HostFaultCode.InvalidOrder, "host received Fault"),
            _ => TerminalFault(requestId, HostFaultCode.Internal, "unhandled message kind"),
        };
    }

    internal void Tick(ulong atMicroseconds)
    {
        Observe(atMicroseconds);
        if (_terminal)
            return;

        uint[] expired = _live.Values
            .Where(controller =>
                atMicroseconds - controller.LeaseRenewedAt
                >= FakePinnedIdentity.ClientLeaseTimeoutMicroseconds)
            .Select(controller => controller.Id)
            .ToArray();
        foreach (uint controller in expired)
        {
            NeutralizeDestroy(
                controller,
                atMicroseconds,
                FakePublicationReason.LeaseExpiredNeutral);
        }

        foreach (LiveController controller in _live.Values)
        {
            if (atMicroseconds - controller.LastPublishedAt
                < FakePinnedIdentity.HostPumpIntervalMicroseconds)
            {
                continue;
            }
            _sink.Publish(
                controller.Id,
                atMicroseconds,
                FakePublicationReason.PeriodicPump,
                controller.State);
            controller.LastPublishedAt = atMicroseconds;
        }
    }

    internal bool TryDequeueFeedback(out byte[]? encoded) =>
        _feedback.TryDequeue(out encoded);

    internal void CleanupAll(ulong atMicroseconds)
    {
        Observe(atMicroseconds);
        _liveAtCleanup ??= _live.Count;
        foreach (uint controller in _live.Keys.ToArray())
        {
            NeutralizeDestroy(
                controller,
                atMicroseconds,
                FakePublicationReason.ConversationExitNeutral);
        }
        _feedback.Close();
        _terminal = true;
    }

    private FakeDispatchResult AcceptHello(uint requestId, HelloMessage hello)
    {
        _handshaken = true;
        HostFrame ready = HostFrame.Create(
            requestId,
            new ReadyMessage(
                (byte[])hello.Nonce.Clone(),
                FakePinnedIdentity.SdkSha256(),
                FakePinnedIdentity.CatalogSha256(),
                FakePinnedIdentity.CatalogResourceCount));
        return Continue(ready);
    }

    private FakeDispatchResult AcceptCreate(
        uint requestId,
        CreateMessage create,
        ulong atMicroseconds)
    {
        if (_issued == FakePinnedIdentity.MaximumControllerIdentities)
            return TerminalFault(requestId, HostFaultCode.Capacity, "all controller identities are already issued");

        FakePersona persona;
        try
        {
            persona = FakePinnedIdentity.Persona(create.Profile);
        }
        catch (ArgumentOutOfRangeException)
        {
            return TerminalFault(requestId, HostFaultCode.UnsupportedProfile, "profile is not allowlisted");
        }

        uint controller = _nextController++;
        _issued++;
        var live = new LiveController(controller, persona, atMicroseconds);
        _live.Add(controller, live);
        _sink.Publish(
            controller,
            atMicroseconds,
            FakePublicationReason.ControllerCreatedNeutral,
            KsxPadState.Neutral);

        return Continue(HostFrame.Create(
            requestId,
            new CreatedMessage(controller, persona.Profile, persona.VendorId, persona.ProductId)));
    }

    private FakeDispatchResult AcceptSubmit(
        uint requestId,
        SubmitMessage submit,
        ulong atMicroseconds)
    {
        if (!_live.TryGetValue(submit.Controller, out LiveController? controller))
            return TerminalFault(requestId, HostFaultCode.UnknownController, "controller is not live");
        if (submit.Sequence <= controller.LastSequence)
            return TerminalFault(requestId, HostFaultCode.StaleSequence, "state sequence did not advance");
        if (_nextFeedbackSequence == 0)
            return TerminalFault(requestId, HostFaultCode.Internal, "feedback sequence is exhausted");

        controller.LastSequence = submit.Sequence;
        controller.State = submit.State;
        controller.LeaseRenewedAt = atMicroseconds;
        controller.LastPublishedAt = atMicroseconds;
        _sink.Publish(
            controller.Id,
            atMicroseconds,
            FakePublicationReason.WireSubmit,
            controller.State);

        ulong feedbackSequence = _nextFeedbackSequence;
        _nextFeedbackSequence = feedbackSequence == ulong.MaxValue ? 0 : feedbackSequence + 1;
        _feedback.Enqueue(HostFrame.Create(
            0,
            new FeedbackMessage(
                controller.Id,
                feedbackSequence,
                HostFeedbackSource.OutputDecoded,
                ReportLength: 0,
                LargeMotor: controller.State.LeftTrigger,
                SmallMotor: controller.State.RightTrigger,
                LedNumber: (byte)controller.Persona.Profile,
                MotorsValid: true,
                LedValid: true)));

        return Continue(HostFrame.Create(
            requestId,
            new AppliedMessage(controller.Id, submit.Sequence)));
    }

    private FakeDispatchResult AcceptDestroy(
        uint requestId,
        DestroyMessage destroy,
        ulong atMicroseconds)
    {
        if (!_live.ContainsKey(destroy.Controller))
            return TerminalFault(requestId, HostFaultCode.UnknownController, "controller is not live");

        NeutralizeDestroy(
            destroy.Controller,
            atMicroseconds,
            FakePublicationReason.ExplicitDestroyNeutral);
        return Continue(HostFrame.Create(requestId, new DestroyedMessage(destroy.Controller)));
    }

    private FakeDispatchResult AcceptShutdown(uint requestId, ulong atMicroseconds)
    {
        CleanupAll(atMicroseconds);
        return new FakeDispatchResult(
            HostFrame.Create(requestId, new ByeMessage()),
            CloseAfterWrite: true,
            ExitReason: "shutdown");
    }

    private void NeutralizeDestroy(
        uint controller,
        ulong atMicroseconds,
        FakePublicationReason reason)
    {
        _sink.NeutralizeForDestroy(controller, atMicroseconds, reason);
        _sink.Destroy(controller);
        _live.Remove(controller);
        _feedback.Purge(controller);
    }

    private FakeDispatchResult TerminalFault(
        uint requestId,
        HostFaultCode code,
        string detail)
    {
        _terminal = true;
        return new FakeDispatchResult(
            HostFrame.Create(requestId, new FaultMessage(code, detail)),
            CloseAfterWrite: true,
            ExitReason: "fault");
    }

    private static FakeDispatchResult Continue(HostFrame response) =>
        new(response, CloseAfterWrite: false, ExitReason: string.Empty);

    private void Observe(ulong atMicroseconds)
    {
        if (atMicroseconds < _lastObservedMicroseconds)
            throw new ArgumentOutOfRangeException(nameof(atMicroseconds), "Fake-host time may not move backwards.");
        _lastObservedMicroseconds = atMicroseconds;
    }
}
