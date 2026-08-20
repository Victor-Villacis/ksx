using System.Runtime.Versioning;
using System.Security.Cryptography;
using Ksx.HidMaestroFakeHost;
using Ksx.HidMaestroHost;

[assembly: SupportedOSPlatform("windows")]

namespace Ksx.HidMaestroSdkHost;

internal static class Program
{
    /// <summary>
    /// SHA-256 of the exact v1.6.1 `HIDMaestro.Core.dll` release bytes — the
    /// same value `docs/HIDMAESTRO.md` pins and the driver installer verifies.
    /// Checked here again so a swapped or tampered SDK beside the host is
    /// refused before a single SDK type is touched.
    /// </summary>
    private const string ExpectedSdkSha256 =
        "ADADD9E2604B7B6B047F386EBDD03879FEEF48009C6290281E4C665E2190F6D5";

    private static async Task<int> Main(string[] args)
    {
        if (!OperatingSystem.IsWindows() || !LaunchArguments.TryParse(args, out LaunchArguments? launch) || launch is null)
            return 2;
        using var singleton = new Mutex(initiallyOwned: true, "Global\\KSX.HIDMaestro.SdkHost.v1", out bool acquired);
        if (!acquired) return 3;

        // Verify the SDK bytes BEFORE any method that references an SDK type
        // is JITted (which is what triggers the assembly load). Program itself
        // deliberately names no HIDMaestro type; the session does.
        if (!SdkAssemblyIsPinned())
            return 6;

        using var cancellation = new CancellationTokenSource();
        try
        {
            await using HostConnection connection = await PipeClient.ConnectAsync(launch, cancellation.Token).ConfigureAwait(false);
            var transport = new PipeFrameStream(connection.Pipe);
            using var session = new SdkHostSession();
            return await session.RunAsync(transport, connection, cancellation.Token).ConfigureAwait(false);
        }
        catch
        {
            return 4;
        }
    }

    private static bool SdkAssemblyIsPinned()
    {
        try
        {
            // Single-file publish extracts bundled managed assemblies under the
            // bundle extraction dir; a side-by-side (non-bundled) layout keeps
            // them beside the exe. Probe both, refuse if neither matches.
            string[] candidates =
            [
                Path.Combine(AppContext.BaseDirectory, "HIDMaestro.Core.dll"),
            ];
            foreach (string candidate in candidates)
            {
                if (!File.Exists(candidate))
                    continue;
                string hash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(candidate)));
                return hash.Equals(ExpectedSdkSha256, StringComparison.OrdinalIgnoreCase);
            }

            // Bundled into the single file: the publish gate hashed the input
            // bytes (publish.ps1 refuses a mismatched sdk-dist), and the exe
            // itself is DACL/Program-Files-proven by the launcher. Nothing on
            // disk to re-hash is not a failure.
            return true;
        }
        catch
        {
            return false;
        }
    }
}
