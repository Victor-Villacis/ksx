using System.Security.Cryptography;
using Ksx.HidMaestroProbe;

namespace Ksx.HidMaestroFakeHost;

internal sealed class FakeFeedbackQueue : IDisposable
{
    private sealed record Entry(uint Controller, byte[] Encoded);

    private readonly Queue<Entry> _entries = [];
    private readonly int _capacity;
    private bool _closed;
    private ulong _dropped;

    internal FakeFeedbackQueue(int capacity = FakePinnedIdentity.MaximumQueuedFeedback)
    {
        if (capacity is < 1 or > FakePinnedIdentity.MaximumQueuedFeedback)
            throw new ArgumentOutOfRangeException(nameof(capacity));
        _capacity = capacity;
    }

    internal int Count => _entries.Count;
    internal ulong Dropped => _dropped;

    internal void Enqueue(HostFrame frame)
    {
        if (_closed)
            throw new ObjectDisposedException(nameof(FakeFeedbackQueue));
        if (frame.RequestId != 0 || frame.Message is not FeedbackMessage feedback)
            throw new ArgumentException("Only request-id-zero Feedback frames may enter the event queue.", nameof(frame));

        byte[] encoded = frame.Encode();
        if (_entries.Count == _capacity)
        {
            Entry dropped = _entries.Dequeue();
            CryptographicOperations.ZeroMemory(dropped.Encoded);
            _dropped = _dropped == ulong.MaxValue ? _dropped : _dropped + 1;
        }
        _entries.Enqueue(new Entry(feedback.Controller, encoded));
    }

    internal bool TryDequeue(out byte[]? encoded)
    {
        if (_entries.TryDequeue(out Entry? entry))
        {
            encoded = entry.Encoded;
            return true;
        }
        encoded = null;
        return false;
    }

    internal void Purge(uint controller)
    {
        int retained = _entries.Count;
        for (int index = 0; index < retained; index++)
        {
            Entry entry = _entries.Dequeue();
            if (entry.Controller == controller)
            {
                CryptographicOperations.ZeroMemory(entry.Encoded);
            }
            else
            {
                _entries.Enqueue(entry);
            }
        }
    }

    internal void Close()
    {
        if (_closed)
            return;
        while (_entries.TryDequeue(out Entry? entry))
            CryptographicOperations.ZeroMemory(entry.Encoded);
        _closed = true;
    }

    public void Dispose() => Close();
}
