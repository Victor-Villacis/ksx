using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace Ksx.HidMaestroHost;

internal sealed class HostConnection : IAsyncDisposable
{
    internal HostConnection(NamedPipeClientStream pipe, SafeFileHandle daemon)
    {
        Pipe = pipe;
        Daemon = daemon;
    }
    internal NamedPipeClientStream Pipe { get; }
    internal SafeFileHandle Daemon { get; }
    internal bool DaemonAlive => WaitForSingleObject(Daemon.DangerousGetHandle(), 0) == 258;
    public async ValueTask DisposeAsync()
    {
        Daemon.Dispose();
        await Pipe.DisposeAsync().ConfigureAwait(false);
    }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(nint handle, uint milliseconds);
}

internal static class PipeClient
{
    private const uint Query = 0x1000;
    private const uint Synchronize = 0x00100000;
    private const uint TokenQuery = 0x0008;

    internal static async Task<HostConnection> ConnectAsync(LaunchArguments launch, CancellationToken cancellation)
    {
        var pipe = new NamedPipeClientStream(".", launch.PipeName, PipeDirection.InOut,
            PipeOptions.Asynchronous | PipeOptions.WriteThrough,
            TokenImpersonationLevel.Anonymous, HandleInheritability.None);
        try
        {
            await pipe.ConnectAsync(5_000, cancellation).ConfigureAwait(false);
            pipe.ReadMode = PipeTransmissionMode.Byte;
            SafeFileHandle daemon = Validate(pipe.SafePipeHandle, launch.DaemonPid);
            return new HostConnection(pipe, daemon);
        }
        catch
        {
            await pipe.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    private static SafeFileHandle Validate(SafePipeHandle pipe, uint expectedPid)
    {
        uint first = ServerPid(pipe);
        if (first != expectedPid) throw new UnauthorizedAccessException("The pipe server is not the expected daemon.");
        nint raw = OpenProcess(Query | Synchronize, false, first);
        if (raw == 0) throw Last("The daemon process could not be retained.");
        var daemon = new SafeFileHandle(raw, ownsHandle: true);
        try
        {
            if (WaitForSingleObject(raw, 0) != 258) throw new UnauthorizedAccessException("The daemon is not alive.");
            uint current = unchecked((uint)Environment.ProcessId);
            uint currentSession = Session(current);
            if (currentSession == 0 || Session(first) != currentSession)
                throw new UnauthorizedAccessException("The daemon is not in the same interactive session.");
            if (!Elevated(GetCurrentProcess()) || Elevated(raw))
                throw new UnauthorizedAccessException("The host/daemon privilege boundary is not exact.");

            string expected = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "ksx.exe"));
            string actual = ProcessImage(raw);
            if (!File.Exists(expected) || !actual.Equals(expected, StringComparison.OrdinalIgnoreCase))
                throw new UnauthorizedAccessException("The pipe server is not the fixed installed KSX daemon.");
            if (ServerPid(pipe) != first || WaitForSingleObject(raw, 0) != 258)
                throw new UnauthorizedAccessException("The daemon identity changed during validation.");
            return daemon;
        }
        catch
        {
            daemon.Dispose();
            throw;
        }
    }

    private static uint ServerPid(SafePipeHandle pipe)
    {
        if (!GetNamedPipeServerProcessId(pipe, out uint pid) || pid == 0) throw Last("The pipe server identity was unavailable.");
        return pid;
    }

    private static uint Session(uint pid)
    {
        if (!ProcessIdToSessionId(pid, out uint session)) throw Last("A process session was unavailable.");
        return session;
    }

    private static bool Elevated(nint process)
    {
        if (!OpenProcessToken(process, TokenQuery, out nint token) || token == 0) throw Last("A process token was unavailable.");
        try
        {
            if (!GetTokenInformation(token, 20, out int elevated, sizeof(int), out int returned)
                || returned != sizeof(int)) throw Last("A process elevation fact was unavailable.");
            return elevated != 0;
        }
        finally { _ = CloseHandle(token); }
    }

    private static string ProcessImage(nint process)
    {
        var buffer = new char[32_768];
        uint size = (uint)buffer.Length;
        if (!QueryFullProcessImageNameW(process, 0, buffer, ref size) || size == 0) throw Last("The daemon image was unavailable.");
        return Path.GetFullPath(new string(buffer, 0, checked((int)size)));
    }

    private static Win32Exception Last(string message) => new(message, Marshal.GetLastWin32Error());
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern nint OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint pid);
    [DllImport("kernel32.dll")] private static extern nint GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(nint handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool ProcessIdToSessionId(uint pid, out uint session);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool QueryFullProcessImageNameW(nint process, uint flags, [Out] char[] image, ref uint size);
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool OpenProcessToken(nint process, uint access, out nint token);
    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetTokenInformation(nint token, int kind, out int value, int size, out int returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(nint handle);
}
