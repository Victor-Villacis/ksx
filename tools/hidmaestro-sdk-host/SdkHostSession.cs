using System.Diagnostics;
using HIDMaestro;
using Ksx.HidMaestroFakeHost;
using Ksx.HidMaestroProbe;

namespace Ksx.HidMaestroSdkHost;

/// <summary>
/// The SDK-lane session: the same bounded pipe protocol as the candidate host,
/// mapped onto the pinned official SDK's <see cref="HMContext"/> /
/// <see cref="HMController"/> — the two-call lifecycle PadForge proves.
/// </summary>
/// <remarks>
/// This lane serves Switch Pro and Xbox Series only. DualSense is deliberately
/// refused here: the conformance persona is served by the audited candidate
/// host, and one persona must never be creatable through two lanes.
///
/// The host calls exactly the API surface `runtime-contract-sdk.json` lists —
/// profile lookup, controller create/submit/dispose — and never the SDK's
/// install, certificate, or global-sweep surfaces. Feedback frames are not
/// emitted in v1; rumble decode is a recorded follow-up.
/// </remarks>
internal sealed class SdkHostSession : IDisposable
{
    // Canonical SHA-256 of runtime-contract-sdk.json (BOM-free, CRLF->LF),
    // asserted by publish-sdk.ps1 and pinned by the Rust client's
    // HostExpectation for this lane.
    private static readonly byte[] RuntimeSha = Convert.FromHexString("3FC74E0AD063CE02A22DB9866842BD02987D1027315AE899EAE90305847CDBAF");
    private static readonly byte[] CatalogSha = Convert.FromHexString("8F407E6E1C3C241E16CF6BEF387216AD4D1F5DE055A2C4CC041CA16CE7954A6A");
    private static readonly TimeSpan Lease = TimeSpan.FromSeconds(5);

    private readonly HMContext _context = new();
    private HMController? _controller;
    private SdkStateMapper? _mapper;
    private KsxPadState _state = KsxPadState.Neutral;
    private long _leaseTimestamp;
    private uint _lastRequest;
    private ulong _lastSubmit;
    private bool _hello;
    private bool _closed;
    private bool _disposed;

    internal async Task<int> RunAsync(PipeFrameStream pipe, HostConnection connection, CancellationToken cancellation)
    {
        // 16 ms idle republish, NOT longer: the GIP companion's stale watchdog
        // counts READS and tears the mapping down after >500 unchanged-SeqNo
        // reads — PadForge's own audit measured a 250 ms keepalive forcing
        // one-frame releases of held inputs under heavy consumer mixes.
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
                    if (_controller is not null && _mapper is not null)
                    {
                        if (Stopwatch.GetElapsedTime(_leaseTimestamp) >= Lease)
                        {
                            await pipe.WriteFrameAsync(Fault(0, HostFaultCode.InvalidOrder, "controller lease expired"), linked.Token).ConfigureAwait(false);
                            return 5;
                        }

                        _controller.SubmitState(_mapper.Map(in _state));
                    }

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
                catch
                {
                    response = Fault(request.RequestId, HostFaultCode.SdkFailure, "the pinned HIDMaestro SDK operation failed");
                    closeAfter = true;
                }

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
            // The SDK lane's personas. DualSense is deliberately not here.
            case CreateMessage create when create.Profile is HostProfileId.SwitchPro
                                                          or HostProfileId.XboxSeries:
                if (_controller is not null)
                    return (Fault(frame.RequestId, HostFaultCode.Capacity, "one controller is already live"), true);
                if (_context.LoadDefaultProfiles() != 228)
                    return (Fault(frame.RequestId, HostFaultCode.SdkUnavailable, "the pinned SDK's profile catalog is unavailable"), true);
                (string profileSlug, ushort vendorId, ushort productId) = create.Profile switch
                {
                    HostProfileId.SwitchPro => ("switch-pro", (ushort)0x057E, (ushort)0x2009),
                    HostProfileId.XboxSeries => ("xbox-series-xs-bt", (ushort)0x045E, (ushort)0x0B13),
                    _ => throw new InvalidOperationException("unreachable: guarded by the case pattern"),
                };
                HMProfile profile = _context.GetProfile(profileSlug)
                    ?? throw new InvalidOperationException($"The {profileSlug} profile is unavailable.");
                _mapper = new SdkStateMapper(profile);
                _controller = _context.CreateController(profile);
                _state = KsxPadState.Neutral;
                _controller.SubmitState(_mapper.Map(in _state));
                _leaseTimestamp = Stopwatch.GetTimestamp();
                return (HostFrame.Create(frame.RequestId,
                    new CreatedMessage(1, create.Profile, vendorId, productId)), false);
            case CreateMessage:
                return (Fault(frame.RequestId, HostFaultCode.UnsupportedProfile, "this lane serves Switch Pro and Xbox Series; DualSense is served by the candidate host"), true);
            case SubmitMessage submit when _controller is not null && _mapper is not null && submit.Controller == 1:
                if (submit.Sequence <= _lastSubmit)
                    return (Fault(frame.RequestId, HostFaultCode.StaleSequence, "state sequence did not advance"), true);
                _state = submit.State;
                _controller.SubmitState(_mapper.Map(in _state));
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

    private static HostFrame Fault(uint request, HostFaultCode code, string detail) =>
        HostFrame.Create(request, new FaultMessage(code, detail));

    private void DestroyController()
    {
        HMController? controller = _controller;
        _controller = null;
        _mapper = null;
        controller?.Dispose();
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try
        {
            DestroyController();
        }
        finally
        {
            _context.Dispose();
        }
    }
}
