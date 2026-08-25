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
    // Exactly one encoder is constructed, chosen by the profile's frozen wire
    // shape; the other stays null for the life of the controller.
    private readonly RuntimeDualSenseInputEncoder? _dualSenseEncoder;
    private readonly RuntimeXboxSeriesInputEncoder? _xboxSeriesEncoder;
    private readonly RuntimeSwitchProInputEncoder? _switchProEncoder;
    private readonly RuntimeInputWireShape _wireShape;
    private readonly RawDualSenseFeedbackAdapter _feedbackAdapter = new();
    private readonly byte[] _inputReport;
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

        if (!RuntimeInputWireShape.TryGet(profile.Id, out _wireShape))
        {
            throw new NotSupportedException(
                $"No candidate input encoder is bound to profile '{profile.Id}'.");
        }

        switch (_wireShape.ProfileId)
        {
            case RuntimeInputWireShape.DualSenseProfileId:
                _dualSenseEncoder = new RuntimeDualSenseInputEncoder();
                break;
            case RuntimeInputWireShape.XboxSeriesProfileId:
                _xboxSeriesEncoder = new RuntimeXboxSeriesInputEncoder();
                break;
            case RuntimeInputWireShape.SwitchProProfileId:
                _switchProEncoder = new RuntimeSwitchProInputEncoder();
                break;
            default:
                throw new NotSupportedException(
                    $"No candidate input encoder is bound to profile '{_wireShape.ProfileId}'.");
        }

        _inputReport = new byte[_wireShape.FullWireLength];
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
            if (_dualSenseEncoder is not null)
            {
                _dualSenseEncoder.Encode(in state, _inputReport);
            }
            else if (_xboxSeriesEncoder is not null)
            {
                _xboxSeriesEncoder.Encode(in state, _inputReport);
            }
            else
            {
                _switchProEncoder!.Encode(in state, _inputReport);
            }

            _sharedState.SubmitFullWireInput(_inputReport, in _wireShape);
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
                        $"The exact-owned {_wireShape.ProfileId} controller requires teardown recovery.",
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
