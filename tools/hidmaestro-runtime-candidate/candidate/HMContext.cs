using System;
using System.Reflection;
using System.Runtime.Versioning;
using HIDMaestro.Internal;

[assembly: AssemblyVersion("1.6.1.0")]
[assembly: AssemblyFileVersion("1.6.1.0")]
[assembly: AssemblyInformationalVersion("1.6.1-ksx-s1.5c+upstream.2a0dac0857901a63d365a36dcf99cf50114ca954")]
[assembly: TargetFramework(".NETCoreApp,Version=v10.0", FrameworkDisplayName = ".NET 10.0")]

namespace HIDMaestro;

public sealed class HMContext : IDisposable
{
    private readonly object _gate = new();
    private readonly RuntimeProfileCatalog _catalog;
    private readonly RuntimePlainHidLifecycle _lifecycle;
    private readonly IRuntimeOwnedSharedMemoryFactory _sharedStateFactory;
    private HMController? _controller;
    private RuntimeExactRecovery? _pendingRecovery;
    private bool _disposeRequested;
    private bool _disposed;

    public HMContext()
        : this(
            RuntimeExactDeviceManager.CreateUnavailable(),
            RuntimeOwnedSharedMemoryFactory.CreateUnavailable())
    {
    }

    internal HMContext(
        IRuntimeExactDeviceManager deviceManager,
        IRuntimeOwnedSharedMemoryFactory sharedStateFactory)
    {
        _catalog = new RuntimeProfileCatalog();
        _lifecycle = new RuntimePlainHidLifecycle(deviceManager);
        _sharedStateFactory = sharedStateFactory ?? throw new ArgumentNullException(nameof(sharedStateFactory));
    }

    public int LoadDefaultProfiles()
    {
        lock (_gate)
        {
            ThrowIfUnavailable();
            return _catalog.LoadDefaultProfiles();
        }
    }

    public HMProfile? GetProfile(string id)
    {
        ArgumentNullException.ThrowIfNull(id);
        lock (_gate)
        {
            ThrowIfUnavailable();
            return _catalog.GetProfile(id);
        }
    }

    public HMController CreateController(HMProfile profile)
    {
        ArgumentNullException.ThrowIfNull(profile);
        lock (_gate)
        {
            ThrowIfUnavailable();
            if (_controller is not null)
            {
                throw new InvalidOperationException("The S1.5d candidate permits only one live controller.");
            }

            if (_pendingRecovery is not null)
            {
                throw new InvalidOperationException(
                    "Exact-owned recovery must complete through Dispose before another controller can be created.");
            }

            // A profile is admissible only when this candidate carries an encoder
            // bound to it AND the caller handed back the catalog's own embedded
            // instance. The second half is what keeps a look-alike profile built
            // elsewhere from reaching a device, and it is unchanged.
            if (!RuntimeInputWireShape.TryGet(profile.Id, out _))
            {
                throw new NotSupportedException(
                    $"CreateController accepts only profiles with a bound candidate encoder; '{profile.Id}' has none.");
            }

            HMProfile? frozenProfile = _catalog.GetProfile(profile.Id);
            if (!ReferenceEquals(profile, frozenProfile))
            {
                throw new NotSupportedException(
                    "CreateController accepts only an exact embedded conformance profile instance.");
            }

            try
            {
                RuntimePlainHidTransaction transaction = _lifecycle.BeginCreate(profile);
                try
                {
                    RuntimeOwnedSharedMemoryIO sharedState =
                        _sharedStateFactory.Create(transaction.OwnedDevice);
                    transaction.AttachStatePath(sharedState);

                    var controller = new HMController(
                        this,
                        profile,
                        transaction.OwnedDevice,
                        _lifecycle,
                        sharedState);
                    controller.StartOutput();
                    RuntimeOwnedDeviceSet committed = transaction.Commit();
                    if (!ReferenceEquals(committed, transaction.OwnedDevice))
                    {
                        throw new InvalidOperationException("The lifecycle committed an unexpected ownership record.");
                    }

                    _controller = controller;
                    return controller;
                }
                catch (Exception creationFailure)
                {
                    throw transaction.Rollback(creationFailure);
                }
            }
            catch (RuntimeRecoveryRequiredException recoveryFailure)
            {
                // The public surface remains unchanged: a failed create is
                // recoverable by disposing this context. Retain the exact
                // action here so it cannot disappear with a transaction local.
                _pendingRecovery = recoveryFailure.Recovery;
                throw;
            }
        }
    }

    internal void OnControllerDisposed(HMController controller)
    {
        lock (_gate)
        {
            if (ReferenceEquals(_controller, controller))
            {
                _controller = null;
            }

            if (_disposeRequested && _pendingRecovery is null)
            {
                _disposed = true;
            }
        }
    }

    public void Dispose()
    {
        HMController? controller;
        RuntimeExactRecovery? pendingRecovery;
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            _disposeRequested = true;
            controller = _controller;
            pendingRecovery = _pendingRecovery;
            if (controller is null && pendingRecovery is null)
            {
                _disposed = true;
                return;
            }
        }

        controller?.Dispose();
        pendingRecovery?.Retry();

        lock (_gate)
        {
            if (ReferenceEquals(_pendingRecovery, pendingRecovery))
            {
                _pendingRecovery = null;
            }

            if (_controller is null && _pendingRecovery is null)
            {
                _disposed = true;
            }
        }
    }

    private void ThrowIfUnavailable()
    {
        if (_disposeRequested)
        {
            throw new ObjectDisposedException(nameof(HMContext));
        }
    }
}
