using System.Globalization;

namespace Ksx.HidMaestroFakeHost;

internal sealed class LaunchArguments
{
    internal const string HostVerb = "serve-v1";
    internal const string PipeNamePrefix = "KSX.HIDMaestro.Play.v1.";
    internal const int TokenCharacters = 64;

    private LaunchArguments(string pipeNameComponent, uint daemonPid)
    {
        PipeNameComponent = pipeNameComponent;
        DaemonPid = daemonPid;
    }

    internal string PipeNameComponent { get; }
    internal uint DaemonPid { get; }

    public override string ToString() =>
        $"{nameof(LaunchArguments)} {{ PipeNameComponent = [REDACTED], DaemonPid = {DaemonPid} }}";

    internal static bool TryParse(string[] args, out LaunchArguments? launch, out string refusal)
    {
        launch = null;
        refusal = "argv";

        if (args.Length != 3 || !args[0].Equals(HostVerb, StringComparison.Ordinal))
            return false;

        string token = args[1];
        if (token.Length != TokenCharacters || !token.All(IsLowerHex))
        {
            refusal = "token";
            return false;
        }

        string pidText = args[2];
        if (!uint.TryParse(pidText, NumberStyles.None, CultureInfo.InvariantCulture, out uint daemonPid)
            || daemonPid == 0
            || !daemonPid.ToString(CultureInfo.InvariantCulture).Equals(pidText, StringComparison.Ordinal))
        {
            refusal = "daemon-pid";
            return false;
        }

        launch = new LaunchArguments(PipeNamePrefix + token, daemonPid);
        refusal = string.Empty;
        return true;
    }

    private static bool IsLowerHex(char value) =>
        value is >= '0' and <= '9' or >= 'a' and <= 'f';
}
