using System.Runtime.Versioning;
using Ksx.HidMaestroFakeHost;

[assembly: SupportedOSPlatform("windows")]

namespace Ksx.HidMaestroHost;

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        if (!OperatingSystem.IsWindows() || !LaunchArguments.TryParse(args, out LaunchArguments? launch) || launch is null)
            return 2;
        using var singleton = new Mutex(initiallyOwned: true, "Global\\KSX.HIDMaestro.Host.v1", out bool acquired);
        if (!acquired) return 3;
        using var cancellation = new CancellationTokenSource();
        try
        {
            await using HostConnection connection = await PipeClient.ConnectAsync(launch, cancellation.Token).ConfigureAwait(false);
            var transport = new PipeFrameStream(connection.Pipe);
            using var session = new RuntimeHostSession();
            return await session.RunAsync(transport, connection, cancellation.Token).ConfigureAwait(false);
        }
        catch
        {
            return 4;
        }
    }
}
