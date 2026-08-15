using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace Ksx.HidMaestroFakeHost;

internal sealed class PeerValidationException : Exception
{
    internal PeerValidationException(string message)
        : base(message)
    {
    }

    internal PeerValidationException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}

internal static class PipeClient
{
    internal const int ConnectTimeoutMilliseconds = 5_000;

    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint Synchronize = 0x0010_0000;
    private const uint TokenQuery = 0x0008;
    private const uint WaitObject0 = 0x0000_0000;
    private const uint WaitTimeout = 0x0000_0102;
    private const uint WaitFailed = 0xFFFF_FFFF;
    private const int TokenElevationInformationClass = 20;

    internal static async Task<NamedPipeClientStream> ConnectAsync(
        LaunchArguments launch,
        CancellationToken cancellationToken)
    {
        var pipe = new NamedPipeClientStream(
            ".",
            launch.PipeNameComponent,
            PipeDirection.InOut,
            PipeOptions.Asynchronous | PipeOptions.WriteThrough,
            TokenImpersonationLevel.Anonymous,
            HandleInheritability.None);

        try
        {
            await pipe.ConnectAsync(ConnectTimeoutMilliseconds, cancellationToken).ConfigureAwait(false);
            pipe.ReadMode = PipeTransmissionMode.Byte;
            ValidateServer(pipe.SafePipeHandle, launch.DaemonPid);
            return pipe;
        }
        catch
        {
            await pipe.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    private static void ValidateServer(SafePipeHandle pipe, uint expectedPid)
    {
        uint firstPid = NamedPipeServerPid(pipe);
        if (firstPid != expectedPid)
            throw new PeerValidationException("The connected pipe server is not the expected daemon process.");

        nint serverProcess = OpenProcess(
            ProcessQueryLimitedInformation | Synchronize,
            bInheritHandle: false,
            firstPid);
        if (serverProcess == 0)
            throw LastPeerError("The daemon process could not be retained for validation.");

        try
        {
            RequireAlive(serverProcess);

            uint currentPid = unchecked((uint)Environment.ProcessId);
            uint currentSession = SessionId(currentPid);
            uint serverSession = SessionId(firstPid);
            if (currentSession != serverSession)
                throw new PeerValidationException("The pipe server is not in the same inherited Windows session.");

            bool currentElevated = IsElevated(GetCurrentProcess());
            bool serverElevated = IsElevated(serverProcess);
            if (currentElevated != serverElevated)
                throw new PeerValidationException("The fake host and daemon did not inherit the same privilege state.");

            uint secondPid = NamedPipeServerPid(pipe);
            if (secondPid != firstPid)
                throw new PeerValidationException("The pipe server identity changed during validation.");
            RequireAlive(serverProcess);
        }
        finally
        {
            _ = CloseHandle(serverProcess);
        }
    }

    private static uint NamedPipeServerPid(SafePipeHandle pipe)
    {
        if (!GetNamedPipeServerProcessId(pipe, out uint serverPid) || serverPid == 0)
            throw LastPeerError("The pipe server process identity was unavailable.");
        return serverPid;
    }

    private static uint SessionId(uint processId)
    {
        if (!ProcessIdToSessionId(processId, out uint sessionId))
            throw LastPeerError("A process session identity was unavailable.");
        return sessionId;
    }

    private static bool IsElevated(nint process)
    {
        if (!OpenProcessToken(process, TokenQuery, out nint token) || token == 0)
            throw LastPeerError("A process token was unavailable.");
        try
        {
            if (!GetTokenInformation(
                    token,
                    TokenElevationInformationClass,
                    out int tokenIsElevated,
                    sizeof(int),
                    out int returned)
                || returned != sizeof(int))
            {
                throw LastPeerError("A process elevation fact was unavailable.");
            }
            return tokenIsElevated != 0;
        }
        finally
        {
            _ = CloseHandle(token);
        }
    }

    private static void RequireAlive(nint process)
    {
        uint result = WaitForSingleObject(process, 0);
        if (result == WaitTimeout)
            return;
        if (result == WaitObject0)
            throw new PeerValidationException("The daemon exited during pipe validation.");
        if (result == WaitFailed)
            throw LastPeerError("The daemon liveness check failed.");
        throw new PeerValidationException("The daemon liveness check returned an unexpected result.");
    }

    private static PeerValidationException LastPeerError(string message) =>
        new(message, new Win32Exception(Marshal.GetLastWin32Error()));

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeServerProcessId(
        SafePipeHandle pipe,
        out uint serverProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint OpenProcess(
        uint desiredAccess,
        [MarshalAs(UnmanagedType.Bool)] bool bInheritHandle,
        uint processId);

    [DllImport("kernel32.dll")]
    private static extern nint GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(nint handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(nint handle);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(
        nint processHandle,
        uint desiredAccess,
        out nint tokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(
        nint tokenHandle,
        int tokenInformationClass,
        out int tokenInformation,
        int tokenInformationLength,
        out int returnLength);
}
