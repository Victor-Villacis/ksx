using System;
using System.Collections.Generic;

namespace HIDMaestro.Internal;

internal sealed class RuntimePreinstalledPackageProof
{
    internal RuntimePreinstalledPackageProof(string packageIdentity)
    {
        if (string.IsNullOrWhiteSpace(packageIdentity))
        {
            throw new ArgumentException("A verified package identity is required.", nameof(packageIdentity));
        }

        PackageIdentity = packageIdentity;
    }

    internal string PackageIdentity { get; }
}

internal sealed class RuntimeDeviceRegistration
{
    internal RuntimeDeviceRegistration(string parentInstanceId)
    {
        if (string.IsNullOrWhiteSpace(parentInstanceId))
        {
            throw new ArgumentException("An exact parent instance id is required.", nameof(parentInstanceId));
        }

        ParentInstanceId = parentInstanceId;
    }

    internal string ParentInstanceId { get; }
}

internal sealed class RuntimeOwnedDeviceSet
{
    private readonly string[] _childInstanceIds;
    private readonly IReadOnlyList<string> _readOnlyChildInstanceIds;

    internal RuntimeOwnedDeviceSet(string parentInstanceId, IReadOnlyList<string> childInstanceIds)
    {
        if (string.IsNullOrWhiteSpace(parentInstanceId))
        {
            throw new ArgumentException("An exact parent instance id is required.", nameof(parentInstanceId));
        }

        ArgumentNullException.ThrowIfNull(childInstanceIds);
        ParentInstanceId = parentInstanceId;
        _childInstanceIds = new string[childInstanceIds.Count];
        var identities = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            parentInstanceId,
        };

        for (int index = 0; index < childInstanceIds.Count; index++)
        {
            string child = childInstanceIds[index];
            if (string.IsNullOrWhiteSpace(child) || !identities.Add(child))
            {
                throw new ArgumentException("Owned child instance ids must be non-empty and unique.", nameof(childInstanceIds));
            }

            _childInstanceIds[index] = child;
        }

        _readOnlyChildInstanceIds = Array.AsReadOnly(_childInstanceIds);
    }

    internal string ParentInstanceId { get; }

    internal IReadOnlyList<string> ChildInstanceIds => _readOnlyChildInstanceIds;
}

internal sealed class RuntimePartialOwnedDevice
{
    private IReadOnlyList<string> _childInstanceIds = Array.Empty<string>();

    internal RuntimePartialOwnedDevice(string parentInstanceId)
    {
        ParentInstanceId = parentInstanceId;
    }

    internal string ParentInstanceId { get; }

    internal void CaptureChildren(IReadOnlyList<string> childInstanceIds)
    {
        RuntimeOwnedDeviceSet validated = new(ParentInstanceId, childInstanceIds);
        _childInstanceIds = validated.ChildInstanceIds;
    }

    internal RuntimeOwnedDeviceSet Freeze()
    {
        return new RuntimeOwnedDeviceSet(ParentInstanceId, _childInstanceIds);
    }
}

internal interface IRuntimeExactDeviceManager
{
    // This operation is evidence-only. Implementations may inspect the exact
    // expected signed package but may not add, update, repair, or remove one.
    RuntimePreinstalledPackageProof ProvePreinstalledDualSensePackage();

    // The implementation contract is atomic with respect to ownership: it
    // either registers nothing or returns the exact parent identity created.
    RuntimeDeviceRegistration RegisterPlainHidDualSense(RuntimePreinstalledPackageProof proof);

    void ProveExactParentBound(RuntimeDeviceRegistration registration);

    // Discovery must be scoped to registration.ParentInstanceId only.
    IReadOnlyList<string> ReadExactChildInstanceIds(RuntimeDeviceRegistration registration);

    // Removal must be idempotent and target only this exact identity.
    void RemoveExactInstance(string exactInstanceId);
}

internal static class RuntimeExactDeviceManager
{
    internal static IRuntimeExactDeviceManager CreateUnavailable()
    {
        return new UnavailableRuntimeExactDeviceManager();
    }

    private sealed class UnavailableRuntimeExactDeviceManager : IRuntimeExactDeviceManager
    {
        public RuntimePreinstalledPackageProof ProvePreinstalledDualSensePackage()
        {
            throw new NotSupportedException(
                "The S1.5d candidate has no reviewed Windows device-registration backend.");
        }

        public RuntimeDeviceRegistration RegisterPlainHidDualSense(RuntimePreinstalledPackageProof proof)
        {
            _ = proof;
            throw new NotSupportedException(
                "The S1.5d candidate has no reviewed Windows device-registration backend.");
        }

        public void ProveExactParentBound(RuntimeDeviceRegistration registration)
        {
            _ = registration;
            throw new NotSupportedException(
                "The S1.5d candidate has no reviewed Windows device-registration backend.");
        }

        public IReadOnlyList<string> ReadExactChildInstanceIds(RuntimeDeviceRegistration registration)
        {
            _ = registration;
            throw new NotSupportedException(
                "The S1.5d candidate has no reviewed Windows device-registration backend.");
        }

        public void RemoveExactInstance(string exactInstanceId)
        {
            _ = exactInstanceId;
            throw new NotSupportedException(
                "The S1.5d candidate has no reviewed Windows device-registration backend.");
        }
    }
}
