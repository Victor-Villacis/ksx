using System.Diagnostics;
using System.Security.Cryptography;
using Ksx.HidMaestroProbe;

namespace Ksx.HidMaestroFakeHost;

internal sealed record FakeHostRunResult(int ExitCode, FakeHostSummary Summary);

internal static class FakeHostRuntime
{
    internal const int CleanExit = 0;
    internal const int RuntimeFailureExit = 4;

    internal static async Task<FakeHostRunResult> RunAsync(
        PipeFrameStream transport,
        CancellationToken cancellationToken)
    {
        var session = new FakeHostSession();
        long origin = Stopwatch.GetTimestamp();
        string exitReason = "internal";
        int exitCode = RuntimeFailureExit;

        using var runCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        using var timer = new PeriodicTimer(
            TimeSpan.FromMilliseconds(FakePinnedIdentity.HostPumpIntervalMicroseconds / 1_000d));

        Task<HostFrame?> pendingRead = transport.ReadFrameAsync(runCancellation.Token).AsTask();
        Task<bool> pendingTick = timer.WaitForNextTickAsync(runCancellation.Token).AsTask();

        try
        {
            while (true)
            {
                Task completed = await Task.WhenAny(pendingRead, pendingTick).ConfigureAwait(false);
                if (completed == pendingTick)
                {
                    if (!await pendingTick.ConfigureAwait(false))
                    {
                        exitReason = "cancelled";
                        break;
                    }
                    session.Tick(NowMicroseconds(origin));
                    pendingTick = timer.WaitForNextTickAsync(runCancellation.Token).AsTask();
                    continue;
                }

                HostFrame? request = await pendingRead.ConfigureAwait(false);
                ulong now = NowMicroseconds(origin);
                session.Tick(now);
                if (request is null)
                {
                    exitReason = "eof";
                    exitCode = CleanExit;
                    break;
                }

                FakeDispatchResult dispatch = session.Dispatch(request, now);
                if (!dispatch.CloseAfterWrite)
                {
                    // Feedback precedes the correlated response. The Rust
                    // reader demultiplexes request-id-zero events while its
                    // round trip is pending, so Applied completion makes the
                    // synthetic snapshot immediately observable.
                    while (session.TryDequeueFeedback(out byte[]? feedback) && feedback is not null)
                    {
                        try
                        {
                            await transport.WriteEncodedAsync(feedback, runCancellation.Token).ConfigureAwait(false);
                        }
                        finally
                        {
                            CryptographicOperations.ZeroMemory(feedback);
                        }
                    }
                }
                await transport.WriteFrameAsync(dispatch.Response, runCancellation.Token).ConfigureAwait(false);
                if (dispatch.CloseAfterWrite)
                {
                    exitReason = dispatch.ExitReason;
                    exitCode = dispatch.ExitReason == "shutdown" ? CleanExit : RuntimeFailureExit;
                    break;
                }

                pendingRead = transport.ReadFrameAsync(runCancellation.Token).AsTask();
            }
        }
        catch (EndOfStreamException)
        {
            exitReason = "truncated-frame";
        }
        catch (InvalidDataException)
        {
            exitReason = "malformed-frame";
        }
        catch (TimeoutException)
        {
            exitReason = "write-timeout";
        }
        catch (IOException)
        {
            exitReason = "pipe-io";
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            exitReason = "cancelled";
        }
        catch (Exception)
        {
            exitReason = "internal";
        }
        finally
        {
            runCancellation.Cancel();
            try
            {
                session.CleanupAll(NowMicroseconds(origin));
            }
            catch (Exception)
            {
                exitReason = "cleanup-failed";
                exitCode = RuntimeFailureExit;
            }
        }

        return new FakeHostRunResult(
            exitCode,
            FakeHostSummary.FromSession(exitReason, session));
    }

    private static ulong NowMicroseconds(long origin) =>
        checked((ulong)(Stopwatch.GetElapsedTime(origin).Ticks / 10));
}
