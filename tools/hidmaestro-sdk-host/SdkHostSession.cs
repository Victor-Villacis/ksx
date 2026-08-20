using System.Diagnostics;
using HIDMaestro;
using Ksx.HidMaestroFakeHost;
using Ksx.HidMaestroHost;
using Ksx.HidMaestroProbe;

namespace Ksx.HidMaestroSdkHost;

/// <summary>
/// The SDK-lane session: the same bounded pipe protocol as the candidate host,
/// mapped onto the pinned official SDK's <see cref="HMContext"/> /
/// <see cref="HMController"/> — the two-call lifecycle PadForge proves.
/// </summary>
/// <remarks>
/// Serves every HIDMaestro persona — DualSense, Switch Pro, Xbox Series —
/// with up to <see cref="TotalCap"/> live controllers at once (the SDK
/// allocates controller indices with no bound of its own; measured note in
/// upstream's <c>CreateController</c>). Xbox-family pads additionally cap at
/// <see cref="XinputCap"/>: each claims a real XInput slot (measured
/// 2026-08-20, "XInput slot wait: before=0 after=1"), and Windows seats four.
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
    private static readonly byte[] RuntimeSha = Convert.FromHexString("B744C0F3F0D80054BBD23E8682820C2B2C42575C09A83627CB6856B0FD22F240");
    private static readonly byte[] CatalogSha = Convert.FromHexString("8F407E6E1C3C241E16CF6BEF387216AD4D1F5DE055A2C4CC041CA16CE7954A6A");
    private static readonly TimeSpan Lease = TimeSpan.FromSeconds(5);

    /// <summary>Live controllers this host will carry at once — ksx's own
    /// eight-player couch ceiling, not an SDK bound.</summary>
    private const int TotalCap = 8;

    /// <summary>XInput seats four; a fifth companion would come up slotless.</summary>
    private const int XinputCap = 4;

    private sealed class Live
    {
        internal required HMController Controller { get; init; }
        internal required SdkStateMapper Mapper { get; init; }
        internal required HostProfileId Profile { get; init; }
        internal KsxPadState State = KsxPadState.Neutral;
        internal long LeaseTimestamp = Stopwatch.GetTimestamp();
        internal ulong LastSubmit;
    }

    private readonly HMContext _context = new();
    private readonly Dictionary<uint, Live> _live = new();
    private bool _profilesLoaded;
    private uint _lastRequest;
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
                    foreach ((uint id, Live live) in _live)
                    {
                        if (Stopwatch.GetElapsedTime(live.LeaseTimestamp) >= Lease)
                        {
                            await pipe.WriteFrameAsync(Fault(0, HostFaultCode.InvalidOrder, $"controller {id} lease expired"), linked.Token).ConfigureAwait(false);
                            return 5;
                        }

                        live.Controller.SubmitState(live.Mapper.Map(in live.State));
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
                catch (Exception failure)
                {
                    response = Fault(request.RequestId, HostFaultCode.SdkFailure, FailureDetail(failure));
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
            case CreateMessage create when create.Profile is HostProfileId.DualSense
                                                          or HostProfileId.SwitchPro
                                                          or HostProfileId.XboxSeries:
                if (_live.Count >= TotalCap)
                    return (Fault(frame.RequestId, HostFaultCode.Capacity, $"this host carries at most {TotalCap} live controllers"), true);
                if (create.Profile is HostProfileId.XboxSeries
                    && CountLive(HostProfileId.XboxSeries) >= XinputCap)
                {
                    return (Fault(frame.RequestId, HostFaultCode.Capacity, "XInput seats four pads; a fifth Xbox Series pad would come up slotless"), true);
                }

                if (!_profilesLoaded)
                {
                    if (_context.LoadDefaultProfiles() != 228)
                        return (Fault(frame.RequestId, HostFaultCode.SdkUnavailable, "the pinned SDK's profile catalog is unavailable"), true);
                    _profilesLoaded = true;
                }

                (string profileSlug, ushort vendorId, ushort productId) = create.Profile switch
                {
                    HostProfileId.DualSense => ("dualsense", (ushort)0x054C, (ushort)0x0CE6),
                    HostProfileId.SwitchPro => ("switch-pro", (ushort)0x057E, (ushort)0x2009),
                    HostProfileId.XboxSeries => ("xbox-series-xs-bt", (ushort)0x045E, (ushort)0x0B13),
                    _ => throw new InvalidOperationException("unreachable: guarded by the case pattern"),
                };
                HMProfile profile = _context.GetProfile(profileSlug)
                    ?? throw new InvalidOperationException($"The {profileSlug} profile is unavailable.");
                uint id = NextControllerId();
                var mapper = new SdkStateMapper(profile);
                HMController controller = _context.CreateController(profile);
                var live = new Live { Controller = controller, Mapper = mapper, Profile = create.Profile };
                controller.SubmitState(mapper.Map(in live.State));
                _live[id] = live;
                return (HostFrame.Create(frame.RequestId,
                    new CreatedMessage(id, create.Profile, vendorId, productId)), false);
            case CreateMessage:
                return (Fault(frame.RequestId, HostFaultCode.UnsupportedProfile, "this lane serves DualSense, Switch Pro and Xbox Series"), true);
            case SubmitMessage submit when _live.TryGetValue(submit.Controller, out Live? target):
                if (submit.Sequence <= target.LastSubmit)
                    return (Fault(frame.RequestId, HostFaultCode.StaleSequence, "state sequence did not advance"), true);
                target.State = submit.State;
                target.Controller.SubmitState(target.Mapper.Map(in target.State));
                target.LastSubmit = submit.Sequence;
                target.LeaseTimestamp = Stopwatch.GetTimestamp();
                return (HostFrame.Create(frame.RequestId, new AppliedMessage(submit.Controller, submit.Sequence)), false);
            case SubmitMessage:
                return (Fault(frame.RequestId, HostFaultCode.UnknownController, "controller is not live"), true);
            case DestroyMessage destroy when _live.Remove(destroy.Controller, out Live? gone):
                gone.Controller.Dispose();
                return (HostFrame.Create(frame.RequestId, new DestroyedMessage(destroy.Controller)), false);
            case DestroyMessage:
                return (Fault(frame.RequestId, HostFaultCode.UnknownController, "controller is not live"), true);
            case ShutdownMessage:
                DestroyAll();
                _closed = true;
                return (HostFrame.Create(frame.RequestId, new ByeMessage()), true);
            default:
                return (Fault(frame.RequestId, HostFaultCode.InvalidOrder, "message is not valid in this state"), true);
        }
    }

    private int CountLive(HostProfileId profile)
    {
        int count = 0;
        foreach (Live live in _live.Values)
        {
            if (live.Profile == profile) count++;
        }

        return count;
    }

    private uint NextControllerId()
    {
        for (uint candidate = 1; candidate <= TotalCap; candidate++)
        {
            if (!_live.ContainsKey(candidate)) return candidate;
        }

        throw new InvalidOperationException("unreachable: guarded by the capacity check");
    }

    /// <summary>
    /// The fault detail names the real exception — a generic sentence cost a
    /// full CI round trip per defect during the 2026-08-20 hardware session.
    /// Bounded to the V1 fault-detail budget.
    /// </summary>
    private static string FailureDetail(Exception failure)
    {
        string text = $"{failure.GetType().Name}: {failure.Message}";
        while (System.Text.Encoding.UTF8.GetByteCount(text) > HostProtocolCodec.MaximumFaultDetailBytes)
            text = text[..^1];
        return text;
    }

    private static HostFrame Fault(uint request, HostFaultCode code, string detail) =>
        HostFrame.Create(request, new FaultMessage(code, detail));

    private void DestroyAll()
    {
        foreach (Live live in _live.Values)
        {
            try
            {
                live.Controller.Dispose();
            }
            catch
            {
                // Best-effort: a controller that refuses to tear down must
                // not keep its siblings alive.
            }
        }

        _live.Clear();
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try
        {
            DestroyAll();
        }
        finally
        {
            _context.Dispose();
        }
    }
}
