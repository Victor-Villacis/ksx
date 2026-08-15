using Ksx.HidMaestroProbe;

namespace Ksx.HidMaestroFakeHost;

internal enum FakePublicationReason
{
    ControllerCreatedNeutral,
    WireSubmit,
    PeriodicPump,
    ExplicitDestroyNeutral,
    LeaseExpiredNeutral,
    ConversationExitNeutral,
}

internal sealed record FakeSinkEvent(
    uint Controller,
    ulong AtMicroseconds,
    FakePublicationReason Reason,
    KsxPadState State);

/// <summary>
/// SDK-free output sink. It retains only a bounded audit tail and enforces the
/// safety ordering which a later real adapter must preserve.
/// </summary>
internal sealed class FakeSink
{
    private const int MaximumAuditEvents = 256;

    private readonly Queue<FakeSinkEvent> _events = [];
    private readonly HashSet<uint> _awaitingDestroy = [];
    private readonly List<uint> _neutralized = [];
    private readonly List<uint> _destroyed = [];
    private ulong _pumpPublications;

    internal IReadOnlyList<FakeSinkEvent> Events => _events.ToArray();
    internal IReadOnlyList<uint> NeutralizedControllers => _neutralized;
    internal IReadOnlyList<uint> DestroyedControllers => _destroyed;
    internal ulong PumpPublications => _pumpPublications;

    internal void Publish(
        uint controller,
        ulong atMicroseconds,
        FakePublicationReason reason,
        KsxPadState state)
    {
        if (controller == 0)
            throw new ArgumentOutOfRangeException(nameof(controller));
        if (reason is not (FakePublicationReason.ControllerCreatedNeutral
            or FakePublicationReason.WireSubmit
            or FakePublicationReason.PeriodicPump))
        {
            throw new ArgumentOutOfRangeException(nameof(reason));
        }
        if (reason == FakePublicationReason.ControllerCreatedNeutral && !state.IsNeutral)
            throw new ArgumentException("A newly created fake controller must start neutral.", nameof(state));
        if (reason == FakePublicationReason.PeriodicPump)
            _pumpPublications = IncrementSaturating(_pumpPublications);

        Record(new FakeSinkEvent(controller, atMicroseconds, reason, state));
    }

    internal void NeutralizeForDestroy(
        uint controller,
        ulong atMicroseconds,
        FakePublicationReason reason)
    {
        if (controller == 0)
            throw new ArgumentOutOfRangeException(nameof(controller));
        if (reason is not (FakePublicationReason.ExplicitDestroyNeutral
            or FakePublicationReason.LeaseExpiredNeutral
            or FakePublicationReason.ConversationExitNeutral))
        {
            throw new ArgumentOutOfRangeException(nameof(reason));
        }
        if (!_awaitingDestroy.Add(controller))
            throw new InvalidOperationException("A controller was neutralized twice without destruction.");

        _neutralized.Add(controller);
        Record(new FakeSinkEvent(controller, atMicroseconds, reason, KsxPadState.Neutral));
    }

    internal void Destroy(uint controller)
    {
        if (!_awaitingDestroy.Remove(controller))
            throw new InvalidOperationException("A fake controller cannot be destroyed before neutralization.");
        _destroyed.Add(controller);
    }

    private void Record(FakeSinkEvent value)
    {
        if (_events.Count == MaximumAuditEvents)
            _events.Dequeue();
        _events.Enqueue(value);
    }

    private static ulong IncrementSaturating(ulong value) =>
        value == ulong.MaxValue ? value : value + 1;
}
