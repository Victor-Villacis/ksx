using System;
using HIDMaestro.Internal;

namespace HIDMaestro;

public sealed class HMController : IDisposable
{
    private readonly object _gate = new();
    private readonly object _disposeGate = new();
    private readonly HMContext _context;
    private readonly RuntimeOwnedDeviceSet _ownedDevice;
    private readonly RuntimePlainHidLifecycle _lifecycle;
    private readonly RuntimeOwnedSharedMemoryIO _sharedState;
    private readonly RuntimeDualSenseInputEncoder _inputEncoder = new();
    private readonly RawDualSenseFeedbackAdapter _feedbackAdapter = new();
    private readonly byte[] _inputReport = new byte[RuntimeDualSenseInputEncoder.EncodedReportSize];
    private RawDualSenseFeedbackResult _latestFeedback;
    private bool _disposeRequested;
    private bool _disposed;

    internal HMController(
        HMContext context,
        HMProfile profile,
        RuntimeOwnedDeviceSet ownedDevice,
        RuntimePlainHidLifecycle lifecycle,
        RuntimeOwnedSharedMemoryIO sharedState)
    {
        _context = context ?? throw new ArgumentNullException(nameof(context));
        Profile = profile ?? throw new ArgumentNullException(nameof(profile));
        _ownedDevice = ownedDevice ?? throw new ArgumentNullException(nameof(ownedDevice));
        _lifecycle = lifecycle ?? throw new ArgumentNullException(nameof(lifecycle));
        _sharedState = sharedState ?? throw new ArgumentNullException(nameof(sharedState));
    }

    public HMProfile Profile { get; }

    public event Action<HMController, HMOutputPacket>? OutputReceived;

    internal void StartOutput()
    {
        _sharedState.StartOutput(ReceiveOutput);
    }

    public void SubmitState(in HMGamepadState state)
    {
        lock (_gate)
        {
            ThrowIfUnavailable();
            _inputEncoder.Encode(in state, _inputReport);
            _sharedState.SubmitFullWireInput(_inputReport);
        }
    }

    internal bool TryGetLatestFeedback(out RawDualSenseFeedbackResult result)
    {
        lock (_gate)
        {
            result = _latestFeedback;
            return result.HasSnapshot;
        }
    }

    private void ReceiveOutput(HMOutputPacket packet)
    {
        Action<HMController, HMOutputPacket>? handlers;
        lock (_gate)
        {
            if (_disposeRequested)
            {
                return;
            }

            _latestFeedback = _feedbackAdapter.Apply(in packet);
            handlers = OutputReceived;
        }

        if (handlers is null)
        {
            return;
        }

        foreach (Delegate candidate in handlers.GetInvocationList())
        {
            var handler = (Action<HMController, HMOutputPacket>)candidate;
            try
            {
                handler(this, packet);
            }
            catch
            {
                // A subscriber must not terminate the bounded output reader.
            }
        }
    }

    public void Dispose()
    {
        lock (_disposeGate)
        {
            lock (_gate)
            {
                if (_disposed)
                {
                    return;
                }

                _disposeRequested = true;
            }

            try
            {
                // Device removal is deliberately not attempted until the owned
                // input/output path has neutralized and stopped successfully.
                _sharedState.NeutralizeAndStop();
                _lifecycle.RemoveOwned(_ownedDevice);
            }
            catch (Exception error)
            {
                throw error is RuntimeRecoveryRequiredException
                    ? error
                    : new RuntimeRecoveryRequiredException(
                        "The exact-owned DualSense controller requires teardown recovery.",
                        new RuntimeExactRecovery(_lifecycle, _ownedDevice, _sharedState),
                        error);
            }

            lock (_gate)
            {
                _disposed = true;
            }
        }

        _context.OnControllerDisposed(this);
    }

    private void ThrowIfUnavailable()
    {
        if (_disposeRequested)
        {
            throw new ObjectDisposedException(nameof(HMController));
        }
    }
}
