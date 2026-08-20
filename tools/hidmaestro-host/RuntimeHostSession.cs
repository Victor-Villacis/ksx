using System.Collections.Concurrent;
using System.Diagnostics;
using HIDMaestro;
using Ksx.HidMaestroFakeHost;
using Ksx.HidMaestroProbe;

namespace Ksx.HidMaestroHost;

internal sealed class RuntimeHostSession : IDisposable
{
    private static readonly byte[] RuntimeSha = Convert.FromHexString("4F76F31C049390A1342388E09F9D0D0E3547162D08EA501FD829AF3CF64F67DA");
    private static readonly byte[] CatalogSha = Convert.FromHexString("8F407E6E1C3C241E16CF6BEF387216AD4D1F5DE055A2C4CC041CA16CE7954A6A");
    private static readonly TimeSpan Lease = TimeSpan.FromSeconds(5);

    private readonly ConcurrentQueue<HostFrame> _feedback = new();
    private readonly HMContext _context = new(new WindowsDeviceManager(), new HostSharedMemoryFactory());
    private HMController? _controller;
    private KsxPadState _state = KsxPadState.Neutral;
    private long _leaseTimestamp;
    private uint _lastRequest;
    private ulong _lastSubmit;
    private ulong _nextFeedback = 1;
    private bool _hello;
    private bool _closed;
    private bool _disposed;

    internal async Task<int> RunAsync(PipeFrameStream pipe, HostConnection connection, CancellationToken cancellation)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(16));
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        Task<HostFrame?> read = pipe.ReadFrameAsync(linked.Token).AsTask();
        Task<bool> tick = timer.WaitForNextTickAsync(linked.Token).AsTask();
        try
        {
            while (!_closed && connection.DaemonAlive)
            {
                Task completed = await Task.WhenAny(read, tick).ConfigureAwait(false);
                if (completed == tick)
                {
                    if (!await tick.ConfigureAwait(false)) break;
                    if (_controller is not null)
                    {
                        if (Stopwatch.GetElapsedTime(_leaseTimestamp) >= Lease)
                        {
                            await pipe.WriteFrameAsync(Fault(0, HostFaultCode.InvalidOrder, "controller lease expired"), linked.Token).ConfigureAwait(false);
                            return 5;
                        }
                        _controller.SubmitState(StateMapper.Map(in _state));
                    }
                    await FlushFeedback(pipe, linked.Token).ConfigureAwait(false);
                    tick = timer.WaitForNextTickAsync(linked.Token).AsTask();
                    continue;
                }

                HostFrame? request = await read.ConfigureAwait(false);
                if (request is null) return 0;
                HostFrame response;
                bool closeAfter = false;
                try
                {
                    (response, closeAfter) = Dispatch(request);
                }
                catch (HidMaestroPackageUnavailableException)
                {
                    response = Fault(request.RequestId, HostFaultCode.SdkUnavailable,
                        "the pinned HIDMaestro v1.6.1 Driver Store package is not installed");
                    closeAfter = true;
                }
                catch (Exception failure)
                {
                    response = Fault(request.RequestId, HostFaultCode.SdkFailure, FailureDetail(failure));
                    closeAfter = true;
                }
                await FlushFeedback(pipe, linked.Token).ConfigureAwait(false);
                await pipe.WriteFrameAsync(response, linked.Token).ConfigureAwait(false);
                if (closeAfter) return response.Message is ByeMessage ? 0 : 5;
                read = pipe.ReadFrameAsync(linked.Token).AsTask();
            }
            return 0;
        }
        finally
        {
            linked.Cancel();
        }
    }

    private (HostFrame Response, bool Close) Dispatch(HostFrame frame)
    {
        if (frame.RequestId == 0 || frame.RequestId <= _lastRequest)
            return (Fault(frame.RequestId, HostFaultCode.InvalidOrder, "request id did not advance"), true);
        _lastRequest = frame.RequestId;
        if (frame.Message is HelloMessage hello && !_hello)
        {
            _hello = true;
            return (HostFrame.Create(frame.RequestId, new ReadyMessage(
                hello.Nonce, RuntimeSha, CatalogSha, 228)), false);
        }
        if (!_hello || frame.Message is HelloMessage)
            return (Fault(frame.RequestId, HostFaultCode.InvalidOrder, "hello ordering is invalid"), true);

        switch (frame.Message)
        {
            // Every profile this host build can actually REGISTER a device for
            // — which is narrower than the set it carries encoders for. The
            // identity triple is stated here once so the CREATED answer can
            // never disagree with the profile that was actually opened.
            //
            // Xbox Series is deliberately absent: its profile is driverMode
            // xinputhid, which upstream creates as a software-device companion
            // rather than a plain-HID node, and that lane does not exist here
            // yet. Admitting it would reach the lifecycle's refusal, escape as
            // an unhandled fault and kill the session, instead of the clean
            // UnsupportedProfile answer the fallback arm below gives.
            //
            // Switch Pro is absent for a different reason: the lifecycle would
            // accept it, but WindowsDeviceManager still registers the hard-coded
            // DualSense identity, so the device would claim to be a DualSense
            // while streaming Switch Pro reports. It returns once that registry
            // and hardware-id path is profile-driven.
            case CreateMessage create when create.Profile is HostProfileId.DualSense:
                if (_controller is not null)
                    return (Fault(frame.RequestId, HostFaultCode.Capacity, "one controller is already live"), true);
                if (_context.LoadDefaultProfiles() != 228)
                    return (Fault(frame.RequestId, HostFaultCode.SdkUnavailable, "the profile catalog is unavailable"), true);
                (string profileSlug, ushort vendorId, ushort productId) = create.Profile switch
                {
                    HostProfileId.DualSense => ("dualsense", (ushort)0x054C, (ushort)0x0CE6),
                    _ => throw new InvalidOperationException("unreachable: guarded by the case pattern"),
                };
                HMProfile profile = _context.GetProfile(profileSlug)
                    ?? throw new InvalidOperationException($"The {profileSlug} profile is unavailable.");
                _controller = _context.CreateController(profile);
                _controller.OutputReceived += OnOutput;
                _state = KsxPadState.Neutral;
                _controller.SubmitState(StateMapper.Map(in _state));
                _leaseTimestamp = Stopwatch.GetTimestamp();
                return (HostFrame.Create(frame.RequestId,
                    new CreatedMessage(1, create.Profile, vendorId, productId)), false);
            case CreateMessage:
                return (Fault(frame.RequestId, HostFaultCode.UnsupportedProfile, "this host build can create only the DualSense profile; Switch Pro awaits a profile-driven device registration and Xbox Series awaits the software-device companion lane"), true);
            case SubmitMessage submit when _controller is not null && submit.Controller == 1:
                if (submit.Sequence <= _lastSubmit)
                    return (Fault(frame.RequestId, HostFaultCode.StaleSequence, "state sequence did not advance"), true);
                _state = submit.State;
                _controller.SubmitState(StateMapper.Map(in _state));
                _lastSubmit = submit.Sequence;
                _leaseTimestamp = Stopwatch.GetTimestamp();
                return (HostFrame.Create(frame.RequestId, new AppliedMessage(1, submit.Sequence)), false);
            case SubmitMessage:
                return (Fault(frame.RequestId, HostFaultCode.UnknownController, "controller is not live"), true);
            case DestroyMessage destroy when _controller is not null && destroy.Controller == 1:
                DestroyController();
                return (HostFrame.Create(frame.RequestId, new DestroyedMessage(1)), false);
            case DestroyMessage:
                return (Fault(frame.RequestId, HostFaultCode.UnknownController, "controller is not live"), true);
            case ShutdownMessage:
                DestroyController();
                _closed = true;
                return (HostFrame.Create(frame.RequestId, new ByeMessage()), true);
            default:
                return (Fault(frame.RequestId, HostFaultCode.InvalidOrder, "message is not valid in this state"), true);
        }
    }

    private void OnOutput(HMController sender, HMOutputPacket packet)
    {
        if (!ReferenceEquals(sender, _controller) || !sender.TryGetLatestFeedback(out var result) || !result.HasSnapshot)
            return;
        ulong sequence = _nextFeedback++;
        if (sequence == 0) return;
        _feedback.Enqueue(HostFrame.Create(0, new FeedbackMessage(
            1, sequence, HostFeedbackSource.OutputDecoded, checked((ushort)packet.Data.Length),
            result.Snapshot.LargeMotor, result.Snapshot.SmallMotor, 0, true, false)));
        while (_feedback.Count > 64) _feedback.TryDequeue(out _);
    }

    private async Task FlushFeedback(PipeFrameStream pipe, CancellationToken cancellation)
    {
        while (_feedback.TryDequeue(out HostFrame? frame))
            await pipe.WriteFrameAsync(frame, cancellation).ConfigureAwait(false);
    }

    /// <summary>
    /// The fault detail names the real exception. A generic sentence here cost
    /// one full CI round trip per defect during the 2026-08-20 hardware
    /// session — the client saw "the exact HIDMaestro operation failed" for
    /// three different root causes. Bounded to the V1 fault-detail budget.
    /// </summary>
    private static string FailureDetail(Exception failure)
    {
        string text = $"{failure.GetType().Name}: {failure.Message}";
        // Exception text is arbitrary WTF-16 (NTFS names can carry unpaired
        // surrogates); the codec's STRICT encoder refuses those, so round-trip
        // through lenient UTF-8 first — invalid units become U+FFFD and every
        // remaining char is encodable.
        text = System.Text.Encoding.UTF8.GetString(System.Text.Encoding.UTF8.GetBytes(text));
        // Also strip a trailing high surrogate: trimming can land mid-pair,
        // lenient GetByteCount still accepts the lone half (3 bytes), and the
        // codec's STRICT UTF-8 encoder would then throw while building the
        // Fault — inside the very catch handler that reports failures.
        while (System.Text.Encoding.UTF8.GetByteCount(text) > HostProtocolCodec.MaximumFaultDetailBytes
               || (text.Length > 0 && char.IsHighSurrogate(text[^1])))
        {
            text = text[..^1];
        }

        return text;
    }

    private static HostFrame Fault(uint request, HostFaultCode code, string detail) =>
        HostFrame.Create(request, new FaultMessage(code, detail));

    private void DestroyController()
    {
        HMController? controller = _controller;
        _controller = null;
        if (controller is null) return;
        controller.OutputReceived -= OnOutput;
        controller.Dispose();
        while (_feedback.TryDequeue(out _)) { }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try { DestroyController(); }
        finally { _context.Dispose(); }
    }
}
