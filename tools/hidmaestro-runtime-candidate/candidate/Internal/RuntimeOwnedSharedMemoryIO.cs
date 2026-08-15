using System;
using System.Collections.Generic;

namespace HIDMaestro.Internal;

internal interface IRuntimeOwnedSharedMemoryEndpoint : IDisposable
{
    // Start must retain every partially-created handle inside this endpoint so
    // NeutralizeAndStop can close it after any thrown exception.
    void Start(Action<HMOutputPacket> outputCallback);

    // The frozen input contract requires the endpoint to receive the 63
    // descriptor data bytes only. The report ID is configured on the exact
    // device and is prepended by the driver.
    void SubmitLegacyInputData(ReadOnlySpan<byte> dataWithoutReportId);

    void Neutralize();

    void StopOutput();
}

internal interface IRuntimeOwnedSharedMemoryFactory
{
    // Create is object construction only. All mapping/event effects begin in
    // RuntimeOwnedSharedMemoryIO.StartOutput after the transaction owns it.
    RuntimeOwnedSharedMemoryIO Create(RuntimeOwnedDeviceSet ownedDevice);
}

internal sealed class RuntimeOwnedSharedMemoryIO
{
    private readonly object _gate = new();
    private readonly IRuntimeOwnedSharedMemoryEndpoint _endpoint;
    private bool _startAttempted;
    private bool _neutralized;
    private bool _outputStopped;
    private bool _endpointDisposed;

    internal RuntimeOwnedSharedMemoryIO(
        RuntimeOwnedDeviceSet ownedDevice,
        IRuntimeOwnedSharedMemoryEndpoint endpoint)
    {
        OwnedDevice = ownedDevice ?? throw new ArgumentNullException(nameof(ownedDevice));
        _endpoint = endpoint ?? throw new ArgumentNullException(nameof(endpoint));
    }

    internal RuntimeOwnedDeviceSet OwnedDevice { get; }

    internal void StartOutput(Action<HMOutputPacket> outputCallback)
    {
        ArgumentNullException.ThrowIfNull(outputCallback);
        lock (_gate)
        {
            if (_startAttempted)
            {
                throw new InvalidOperationException("The owned shared-state path has already been started.");
            }

            _startAttempted = true;
            _endpoint.Start(outputCallback);
        }
    }

    internal void SubmitFullWireInput(ReadOnlySpan<byte> fullWireReport)
    {
        lock (_gate)
        {
            if (!_startAttempted || _neutralized || _outputStopped || _endpointDisposed)
            {
                throw new ObjectDisposedException(nameof(RuntimeOwnedSharedMemoryIO));
            }

            if (fullWireReport.Length != RuntimeDualSenseInputEncoder.EncodedReportSize)
            {
                throw new ArgumentException(
                    $"The full DualSense wire report must be exactly {RuntimeDualSenseInputEncoder.EncodedReportSize} bytes.",
                    nameof(fullWireReport));
            }

            if (fullWireReport[0] != RuntimeDualSenseInputEncoder.ReportId)
            {
                throw new ArgumentException(
                    $"The full DualSense wire report must begin with report ID 0x{RuntimeDualSenseInputEncoder.ReportId:X2}.",
                    nameof(fullWireReport));
            }

            _endpoint.SubmitLegacyInputData(fullWireReport.Slice(1, 63));
        }
    }

    internal void NeutralizeAndStop()
    {
        lock (_gate)
        {
            var failures = new List<Exception>();
            if (_startAttempted && !_neutralized)
            {
                TryStep(_endpoint.Neutralize, value => _neutralized = value, failures);
            }

            if (_startAttempted && !_outputStopped)
            {
                TryStep(_endpoint.StopOutput, value => _outputStopped = value, failures);
            }

            // Preserve a retryable endpoint when neutralize/stop failed. A
            // successful Dispose could otherwise destroy the only handles
            // capable of completing exact teardown on the next call.
            bool readyToDispose = !_startAttempted || (_neutralized && _outputStopped);
            if (readyToDispose && !_endpointDisposed)
            {
                TryStep(_endpoint.Dispose, value => _endpointDisposed = value, failures);
            }

            if (failures.Count != 0)
            {
                throw new AggregateException("The exact-owned shared-state path did not close completely.", failures);
            }
        }
    }

    private static void TryStep(Action step, Action<bool> markComplete, List<Exception> failures)
    {
        try
        {
            step();
            markComplete(true);
        }
        catch (Exception error)
        {
            failures.Add(error);
        }
    }
}

internal static class RuntimeOwnedSharedMemoryFactory
{
    internal static IRuntimeOwnedSharedMemoryFactory CreateUnavailable()
    {
        return new UnavailableRuntimeOwnedSharedMemoryFactory();
    }

    private sealed class UnavailableRuntimeOwnedSharedMemoryFactory : IRuntimeOwnedSharedMemoryFactory
    {
        public RuntimeOwnedSharedMemoryIO Create(RuntimeOwnedDeviceSet ownedDevice)
        {
            return new RuntimeOwnedSharedMemoryIO(ownedDevice, new UnavailableRuntimeOwnedSharedMemoryEndpoint());
        }
    }

    private sealed class UnavailableRuntimeOwnedSharedMemoryEndpoint : IRuntimeOwnedSharedMemoryEndpoint
    {
        public void Start(Action<HMOutputPacket> outputCallback)
        {
            _ = outputCallback;
            throw new NotSupportedException(
                "The S1.5d candidate has no reviewed shared-memory/event backend.");
        }

        public void SubmitLegacyInputData(ReadOnlySpan<byte> dataWithoutReportId)
        {
            _ = dataWithoutReportId;
            throw new NotSupportedException(
                "The S1.5d candidate has no reviewed shared-memory/event backend.");
        }

        public void Neutralize()
        {
        }

        public void StopOutput()
        {
        }

        public void Dispose()
        {
        }
    }
}
