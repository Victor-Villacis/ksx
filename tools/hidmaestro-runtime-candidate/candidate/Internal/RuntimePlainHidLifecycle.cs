using System;
using System.Collections.Generic;

namespace HIDMaestro.Internal;

internal sealed class RuntimeRecoveryRequiredException : InvalidOperationException
{
    internal RuntimeRecoveryRequiredException(
        string message,
        RuntimeExactRecovery recovery,
        Exception innerException)
        : base(message, innerException)
    {
        Recovery = recovery ?? throw new ArgumentNullException(nameof(recovery));
    }

    internal RuntimeExactRecovery Recovery { get; }

    internal RuntimeOwnedDeviceSet OwnedDevice => Recovery.OwnedDevice;

    internal RuntimeOwnedSharedMemoryIO? StatePath => Recovery.StatePath;

    internal void RetryRecovery()
    {
        Recovery.Retry();
    }
}

internal sealed class RuntimeExactRecovery
{
    private readonly object _gate = new();
    private readonly RuntimePlainHidLifecycle _lifecycle;
    private bool _completed;

    internal RuntimeExactRecovery(
        RuntimePlainHidLifecycle lifecycle,
        RuntimeOwnedDeviceSet ownedDevice,
        RuntimeOwnedSharedMemoryIO? statePath)
    {
        _lifecycle = lifecycle ?? throw new ArgumentNullException(nameof(lifecycle));
        OwnedDevice = ownedDevice ?? throw new ArgumentNullException(nameof(ownedDevice));
        if (statePath is not null && !ReferenceEquals(statePath.OwnedDevice, ownedDevice))
        {
            throw new ArgumentException(
                "The recovery state path must own this exact device set.",
                nameof(statePath));
        }

        StatePath = statePath;
    }

    internal RuntimeOwnedDeviceSet OwnedDevice { get; }

    // A stop failure must retain the only object that owns its partial handles.
    // Retry completes that exact teardown before removing exact identities.
    internal RuntimeOwnedSharedMemoryIO? StatePath { get; }

    internal void Retry()
    {
        lock (_gate)
        {
            if (_completed)
            {
                return;
            }

            StatePath?.NeutralizeAndStop();
            _lifecycle.RemoveOwned(OwnedDevice);
            _completed = true;
        }
    }
}

internal sealed class RuntimePlainHidTransaction
{
    private readonly RuntimePlainHidLifecycle _lifecycle;
    private readonly RuntimePartialOwnedDevice _partialOwnedDevice;
    private readonly RuntimeOwnedDeviceSet _ownedDevice;
    private RuntimeOwnedSharedMemoryIO? _statePath;
    private bool _finished;

    internal RuntimePlainHidTransaction(
        RuntimePlainHidLifecycle lifecycle,
        RuntimePartialOwnedDevice partialOwnedDevice)
    {
        _lifecycle = lifecycle;
        _partialOwnedDevice = partialOwnedDevice;
        _ownedDevice = partialOwnedDevice.Freeze();
    }

    internal RuntimeOwnedDeviceSet OwnedDevice => _ownedDevice;

    internal void AttachStatePath(RuntimeOwnedSharedMemoryIO statePath)
    {
        if (_finished || _statePath is not null)
        {
            throw new InvalidOperationException("The creation transaction cannot accept another state path.");
        }

        if (!ReferenceEquals(statePath.OwnedDevice, _ownedDevice))
        {
            throw new InvalidOperationException("The state path does not own this transaction's exact device set.");
        }

        _statePath = statePath;
    }

    internal RuntimeOwnedDeviceSet Commit()
    {
        if (_finished || _statePath is null)
        {
            throw new InvalidOperationException("The creation transaction is not ready to commit.");
        }

        _finished = true;
        return _ownedDevice;
    }

    internal Exception Rollback(Exception creationFailure)
    {
        ArgumentNullException.ThrowIfNull(creationFailure);
        if (_finished)
        {
            return new RuntimeRecoveryRequiredException(
                "A completed creation transaction was asked to roll back.",
                new RuntimeExactRecovery(_lifecycle, _ownedDevice, _statePath),
                creationFailure);
        }

        IReadOnlyList<Exception> rollbackFailures = _lifecycle.Rollback(_partialOwnedDevice, _statePath);
        if (rollbackFailures.Count == 0)
        {
            _finished = true;
            return new InvalidOperationException(
                "DualSense creation failed; exact-identity rollback completed.",
                creationFailure);
        }

        return new RuntimeRecoveryRequiredException(
            "DualSense creation failed and exact-owned rollback requires recovery.",
            new RuntimeExactRecovery(_lifecycle, _ownedDevice, _statePath),
            new AggregateException(
                "Creation and rollback both failed.",
                Combine(creationFailure, rollbackFailures)));
    }

    private static IReadOnlyList<Exception> Combine(
        Exception creationFailure,
        IReadOnlyList<Exception> rollbackFailures)
    {
        var combined = new List<Exception>(rollbackFailures.Count + 1)
        {
            creationFailure,
        };
        for (int index = 0; index < rollbackFailures.Count; index++)
        {
            combined.Add(rollbackFailures[index]);
        }

        return combined;
    }
}

internal sealed class RuntimePlainHidLifecycle
{
    private readonly IRuntimeExactDeviceManager _deviceManager;

    internal RuntimePlainHidLifecycle(IRuntimeExactDeviceManager deviceManager)
    {
        _deviceManager = deviceManager ?? throw new ArgumentNullException(nameof(deviceManager));
    }

    internal RuntimePlainHidTransaction BeginCreate(HMProfile profile)
    {
        ArgumentNullException.ThrowIfNull(profile);
        EnsureExactDualSense(profile);

        RuntimePreinstalledPackageProof proof = _deviceManager.ProvePreinstalledDualSensePackage();
        RuntimeDeviceRegistration registration = _deviceManager.RegisterPlainHidDualSense(proof);

        // No later fallible binding or child-discovery operation may run
        // before this exact parent identity is retained.
        var partial = new RuntimePartialOwnedDevice(registration.ParentInstanceId);
        try
        {
            _deviceManager.ProveExactParentBound(registration);
            IReadOnlyList<string> childInstanceIds =
                _deviceManager.ReadExactChildInstanceIds(registration);
            partial.CaptureChildren(childInstanceIds);
            return new RuntimePlainHidTransaction(this, partial);
        }
        catch (Exception creationFailure)
        {
            IReadOnlyList<Exception> rollbackFailures = Rollback(partial, statePath: null);
            if (rollbackFailures.Count == 0)
            {
                throw new InvalidOperationException(
                    "DualSense registration failed; the exact parent identity was removed.",
                    creationFailure);
            }

            RuntimeOwnedDeviceSet owned = partial.Freeze();
            throw new RuntimeRecoveryRequiredException(
                "DualSense registration failed and its exact parent identity requires recovery.",
                new RuntimeExactRecovery(this, owned, statePath: null),
                new AggregateException(
                    "Registration and rollback both failed.",
                    RuntimePlainHidTransactionCombine(creationFailure, rollbackFailures)));
        }
    }

    internal void RemoveOwned(RuntimeOwnedDeviceSet ownedDevice)
    {
        ArgumentNullException.ThrowIfNull(ownedDevice);
        IReadOnlyList<Exception> failures = RemoveExactIdentities(ownedDevice);
        if (failures.Count != 0)
        {
            throw new RuntimeRecoveryRequiredException(
                "The exact-owned DualSense device set was not removed completely.",
                new RuntimeExactRecovery(this, ownedDevice, statePath: null),
                new AggregateException(failures));
        }
    }

    internal IReadOnlyList<Exception> Rollback(
        RuntimePartialOwnedDevice partialOwnedDevice,
        RuntimeOwnedSharedMemoryIO? statePath)
    {
        var failures = new List<Exception>();
        if (statePath is not null)
        {
            try
            {
                statePath.NeutralizeAndStop();
            }
            catch (Exception error)
            {
                failures.Add(error);
                // Device identity removal is forbidden until the exact-owned
                // input/output path has neutralized and stopped successfully.
                // The caller retains statePath in its recovery record so this
                // same teardown can be retried without rediscovery.
                return failures;
            }
        }

        RuntimeOwnedDeviceSet ownedDevice = partialOwnedDevice.Freeze();
        foreach (Exception failure in RemoveExactIdentities(ownedDevice))
        {
            failures.Add(failure);
        }

        return failures;
    }

    private IReadOnlyList<Exception> RemoveExactIdentities(RuntimeOwnedDeviceSet ownedDevice)
    {
        var failures = new List<Exception>();
        for (int index = ownedDevice.ChildInstanceIds.Count - 1; index >= 0; index--)
        {
            TryRemove(ownedDevice.ChildInstanceIds[index], failures);
        }

        TryRemove(ownedDevice.ParentInstanceId, failures);
        return failures;
    }

    private void TryRemove(string exactInstanceId, List<Exception> failures)
    {
        try
        {
            _deviceManager.RemoveExactInstance(exactInstanceId);
        }
        catch (Exception error)
        {
            failures.Add(error);
        }
    }

    private static void EnsureExactDualSense(HMProfile profile)
    {
        if (!string.Equals(profile.Id, "dualsense", StringComparison.Ordinal) ||
            profile.VendorId != 0x054C ||
            profile.ProductId != 0x0CE6 ||
            !string.Equals(profile.Connection, "usb", StringComparison.Ordinal) ||
            profile.InputReportSize != 64 ||
            !profile.HasDescriptor)
        {
            throw new NotSupportedException("Only the frozen plain-USB DualSense profile is permitted.");
        }
    }

    private static IReadOnlyList<Exception> RuntimePlainHidTransactionCombine(
        Exception creationFailure,
        IReadOnlyList<Exception> rollbackFailures)
    {
        var combined = new List<Exception>(rollbackFailures.Count + 1)
        {
            creationFailure,
        };
        foreach (Exception rollbackFailure in rollbackFailures)
        {
            combined.Add(rollbackFailure);
        }

        return combined;
    }
}
