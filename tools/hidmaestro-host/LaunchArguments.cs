using System.Globalization;

namespace Ksx.HidMaestroHost;

internal sealed class LaunchArguments
{
    private const string Verb = "serve-v1";
    private const string PipePrefix = "KSX.HIDMaestro.Play.v1.";

    private LaunchArguments(string pipeName, uint daemonPid)
    {
        PipeName = pipeName;
        DaemonPid = daemonPid;
    }

    internal string PipeName { get; }
    internal uint DaemonPid { get; }

    internal static bool TryParse(string[] args, out LaunchArguments? result)
    {
        result = null;
        if (args.Length != 3 || !args[0].Equals(Verb, StringComparison.Ordinal))
            return false;
        string token = args[1];
        if (token.Length != 64 || !token.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f'))
            return false;
        if (!uint.TryParse(args[2], NumberStyles.None, CultureInfo.InvariantCulture, out uint pid)
            || pid == 0
            || !pid.ToString(CultureInfo.InvariantCulture).Equals(args[2], StringComparison.Ordinal))
            return false;
        result = new LaunchArguments(PipePrefix + token, pid);
        return true;
    }
}
