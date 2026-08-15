using System.IO.Pipes;

namespace Ksx.HidMaestroFakeHost;

internal static class Program
{
    private const int ArgumentFailureExit = 2;
    private const int ConnectionFailureExit = 3;
    private const int RuntimeFailureExit = 4;

    private static async Task<int> Main(string[] args)
    {
        if (!LaunchArguments.TryParse(args, out LaunchArguments? launch, out string refusal)
            || launch is null)
        {
            WriteSummary(FakeHostSummary.StartupFailure("invalid-" + refusal));
            return ArgumentFailureExit;
        }

        using var cancellation = new CancellationTokenSource();
        ConsoleCancelEventHandler cancel = (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            cancellation.Cancel();
        };
        Console.CancelKeyPress += cancel;

        try
        {
            await using NamedPipeClientStream pipe = await PipeClient.ConnectAsync(
                launch,
                cancellation.Token).ConfigureAwait(false);
            var transport = new PipeFrameStream(pipe);
            FakeHostRunResult result = await FakeHostRuntime.RunAsync(
                transport,
                cancellation.Token).ConfigureAwait(false);
            WriteSummary(result.Summary);
            return result.ExitCode;
        }
        catch (TimeoutException)
        {
            WriteSummary(FakeHostSummary.StartupFailure("connect-timeout"));
            return ConnectionFailureExit;
        }
        catch (PeerValidationException)
        {
            WriteSummary(FakeHostSummary.StartupFailure("peer-refused"));
            return ConnectionFailureExit;
        }
        catch (OperationCanceledException)
        {
            WriteSummary(FakeHostSummary.StartupFailure("connect-cancelled"));
            return ConnectionFailureExit;
        }
        catch (IOException)
        {
            WriteSummary(FakeHostSummary.StartupFailure("connect-io"));
            return ConnectionFailureExit;
        }
        catch (UnauthorizedAccessException)
        {
            WriteSummary(FakeHostSummary.StartupFailure("connect-denied"));
            return ConnectionFailureExit;
        }
        catch (Exception)
        {
            WriteSummary(FakeHostSummary.StartupFailure("startup-internal"));
            return RuntimeFailureExit;
        }
        finally
        {
            Console.CancelKeyPress -= cancel;
        }
    }

    private static void WriteSummary(FakeHostSummary summary) =>
        Console.Out.WriteLine(summary.ToBoundedJson());
}
