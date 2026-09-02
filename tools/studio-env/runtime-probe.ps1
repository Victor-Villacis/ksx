Set-StrictMode -Version Latest

# A detached Windows PowerShell child can inherit PowerShell 7 module paths.
# Load this host's module explicitly so Get-FileHash cannot resolve through an
# incompatible sibling installation.
Import-Module (Join-Path $PSHOME "Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1") -ErrorAction Stop

function Invoke-KsxDaemonStatusProbe {
    param([Parameter(Mandatory = $true)][string]$Executable)

    # Parse STDOUT ONLY. `ksx` writes its logging banner to stderr on purpose,
    # precisely so stdout stays valid `--json` (see `announce` in
    # crates/ksx-backend/src/logging.rs: "stdout belongs to --json"). Joining
    # both streams and parsing the union made EVERY probe unparseable as soon
    # as a banner appeared, and a caller holding the correct typed answer in
    # `text` would then refuse with "daemon state is ambiguous".
    $Captured = @(& $Executable session status --json 2>&1)
    $ExitCode = $LASTEXITCODE
    $StdOut = @(
        $Captured |
            Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } |
            ForEach-Object { [string]$_ }
    )
    # `text` keeps BOTH streams: whoever diagnoses an ambiguous probe needs the
    # stderr line as much as the payload.
    $Text = (@($Captured | ForEach-Object { [string]$_ })) -join "`n"
    $Payload = $null
    try {
        $Payload = ($StdOut -join "`n") | ConvertFrom-Json
    } catch {
        # Callers inspect exit code plus raw text when a responder is absent,
        # incompatible, or otherwise ambiguous.
    }
    [pscustomobject]@{
        exit_code = $ExitCode
        text = $Text
        payload = $Payload
    }
}

# A successful JSON status proves that *a* daemon answered. The server PID on
# the connected handle proves which daemon answered. Keep this tiny Windows
# interop at the environment boundary instead of weakening the product pipe
# protocol with a development-only identity field.
if (-not ([System.Management.Automation.PSTypeName]'KsxStudioEnvironment.PipeIdentity').Type) {
    Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace KsxStudioEnvironment
{
    public static class PipeIdentity
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetNamedPipeServerProcessId(
            SafePipeHandle pipe,
            out uint serverProcessId);

        public static uint ServerProcessId(
            string component,
            bool readOnly,
            int timeoutMilliseconds)
        {
            PipeDirection direction = readOnly ? PipeDirection.In : PipeDirection.InOut;
            using (var pipe = new NamedPipeClientStream(
                ".",
                component,
                direction,
                PipeOptions.None,
                TokenImpersonationLevel.Anonymous,
                HandleInheritability.None))
            {
                pipe.Connect(timeoutMilliseconds);
                uint processId;
                if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out processId) || processId == 0)
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "The named-pipe server process identity was unavailable.");
                }
                return processId;
            }
        }

        public static void RequestExactDaemonQuit(
            uint expectedProcessId,
            int timeoutMilliseconds)
        {
            using (var pipe = new NamedPipeClientStream(
                ".",
                "ksx-daemon",
                PipeDirection.InOut,
                PipeOptions.WriteThrough,
                TokenImpersonationLevel.Anonymous,
                HandleInheritability.None))
            {
                pipe.Connect(timeoutMilliseconds);
                uint processId;
                if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out processId) || processId == 0)
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "The daemon pipe server process identity was unavailable.");
                }
                if (processId != expectedProcessId)
                {
                    throw new InvalidOperationException(
                        "The daemon pipe changed owners before graceful shutdown.");
                }

                // Validate and write on the SAME connected handle. A separate
                // `ksx session quit` process would reopen the global name and
                // could address a replacement daemon after a TOCTOU race.
                using (var writer = new StreamWriter(
                    pipe,
                    new UTF8Encoding(false),
                    1024,
                    true))
                {
                    writer.WriteLine("{\"verb\":\"quit\"}");
                    writer.Flush();
                }
            }
        }
    }

    // PowerShell's Stop-Process -Id reopens a process by its numeric ID. If the
    // recorded process exits and Windows reuses that ID between validation and
    // termination, the replacement could be killed. This object retains one
    // query/synchronize handle for identity and waits. Termination opens a
    // second, privileged handle only when needed, then matches its image and
    // creation time to the retained handle before using it.
    public sealed class ExactProcess : IDisposable
    {
        private const uint ProcessTerminate = 0x0001;
        private const uint ProcessQueryLimitedInformation = 0x1000;
        private const uint Synchronize = 0x00100000;
        private const uint WaitObject0 = 0x00000000;
        private const uint WaitTimeout = 0x00000102;
        private const uint WaitFailed = 0xFFFFFFFF;
        private const int ErrorInvalidParameter = 87;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern SafeProcessHandle OpenProcess(
            uint desiredAccess,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
            uint processId);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool QueryFullProcessImageName(
            SafeProcessHandle process,
            uint flags,
            StringBuilder executablePath,
            ref uint executablePathLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetProcessTimes(
            SafeProcessHandle process,
            out System.Runtime.InteropServices.ComTypes.FILETIME creation,
            out System.Runtime.InteropServices.ComTypes.FILETIME exit,
            out System.Runtime.InteropServices.ComTypes.FILETIME kernel,
            out System.Runtime.InteropServices.ComTypes.FILETIME user);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(
            SafeProcessHandle process,
            uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateProcess(
            SafeProcessHandle process,
            uint exitCode);

        private SafeProcessHandle process;

        private ExactProcess(
            uint processId,
            SafeProcessHandle process,
            string imagePath,
            DateTime creationTimeUtc)
        {
            ProcessId = processId;
            this.process = process;
            ImagePath = imagePath;
            CreationTimeUtc = creationTimeUtc;
        }

        public uint ProcessId { get; private set; }
        public string ImagePath { get; private set; }
        public DateTime CreationTimeUtc { get; private set; }

        public static ExactProcess TryOpen(uint processId)
        {
            // Establish identity before requesting destructive authority. A
            // stale receipt can point at a PID Windows has since assigned to
            // an unrelated (and possibly non-terminable) process. Requiring
            // PROCESS_TERMINATE here made that ordinary stale state look
            // ambiguous before its image and creation time could be checked.
            SafeProcessHandle process = OpenProcess(
                ProcessQueryLimitedInformation | Synchronize,
                false,
                processId);
            if (process == null || process.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                if (process != null)
                {
                    process.Dispose();
                }
                if (error == ErrorInvalidParameter)
                {
                    return null;
                }
                throw new Win32Exception(error, "The managed process handle could not be opened.");
            }

            try
            {
                var path = new StringBuilder(32768);
                uint pathLength = (uint)path.Capacity;
                if (!QueryFullProcessImageName(process, 0, path, ref pathLength))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "The managed process image could not be identified.");
                }

                System.Runtime.InteropServices.ComTypes.FILETIME creation;
                System.Runtime.InteropServices.ComTypes.FILETIME exit;
                System.Runtime.InteropServices.ComTypes.FILETIME kernel;
                System.Runtime.InteropServices.ComTypes.FILETIME user;
                if (!GetProcessTimes(process, out creation, out exit, out kernel, out user))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "The managed process creation time could not be identified.");
                }

                long creationFileTime =
                    ((long)(uint)creation.dwHighDateTime << 32) |
                    (uint)creation.dwLowDateTime;
                return new ExactProcess(
                    processId,
                    process,
                    path.ToString(),
                    DateTime.FromFileTimeUtc(creationFileTime));
            }
            catch
            {
                process.Dispose();
                throw;
            }
        }

        public bool HasExited
        {
            get { return Wait(0); }
        }

        public bool Wait(int milliseconds)
        {
            EnsureOpen();
            uint result = WaitForSingleObject(process, unchecked((uint)milliseconds));
            if (result == WaitObject0)
            {
                return true;
            }
            if (result == WaitTimeout)
            {
                return false;
            }
            if (result == WaitFailed)
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Waiting for the managed process failed.");
            }
            throw new InvalidOperationException("Waiting for the managed process returned an unexpected result.");
        }

        public void Terminate(uint exitCode)
        {
            EnsureOpen();
            if (HasExited)
            {
                return;
            }

            // Open a second handle with termination rights only after the
            // query-only handle has been matched to the receipt. Validate the
            // second handle against that first handle before using it, so PID
            // reuse between the two opens can never target the replacement.
            SafeProcessHandle terminatingProcess = OpenProcess(
                ProcessTerminate | ProcessQueryLimitedInformation | Synchronize,
                false,
                ProcessId);
            if (terminatingProcess == null || terminatingProcess.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                if (terminatingProcess != null)
                {
                    terminatingProcess.Dispose();
                }
                if (error == ErrorInvalidParameter && HasExited)
                {
                    return;
                }
                throw new Win32Exception(error, "Termination access to the exact managed process could not be opened.");
            }

            try
            {
                var path = new StringBuilder(32768);
                uint pathLength = (uint)path.Capacity;
                if (!QueryFullProcessImageName(terminatingProcess, 0, path, ref pathLength))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "The termination handle image could not be identified.");
                }

                System.Runtime.InteropServices.ComTypes.FILETIME creation;
                System.Runtime.InteropServices.ComTypes.FILETIME exit;
                System.Runtime.InteropServices.ComTypes.FILETIME kernel;
                System.Runtime.InteropServices.ComTypes.FILETIME user;
                if (!GetProcessTimes(terminatingProcess, out creation, out exit, out kernel, out user))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "The termination handle creation time could not be identified.");
                }
                long creationFileTime =
                    ((long)(uint)creation.dwHighDateTime << 32) |
                    (uint)creation.dwLowDateTime;
                DateTime terminationCreationTimeUtc = DateTime.FromFileTimeUtc(creationFileTime);
                if (!String.Equals(path.ToString(), ImagePath, StringComparison.OrdinalIgnoreCase) ||
                    terminationCreationTimeUtc != CreationTimeUtc)
                {
                    if (HasExited)
                    {
                        return;
                    }
                    throw new InvalidOperationException(
                        "The process ID changed generations before termination access was acquired.");
                }

                if (HasExited)
                {
                    return;
                }
                if (!TerminateProcess(terminatingProcess, exitCode))
                {
                    int error = Marshal.GetLastWin32Error();
                    if (!HasExited)
                    {
                        throw new Win32Exception(error, "The exact managed process could not be terminated.");
                    }
                }
            }
            finally
            {
                terminatingProcess.Dispose();
            }
        }

        private void EnsureOpen()
        {
            if (process == null || process.IsClosed || process.IsInvalid)
            {
                throw new ObjectDisposedException("ExactProcess");
            }
        }

        public void Dispose()
        {
            if (process != null)
            {
                process.Dispose();
                process = null;
            }
        }
    }
}
"@
}

function Test-KsxProcessNameProvesStaleIdentity {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$ExpectedExecutable
    )

    # Protected Windows processes can deny even a query/synchronize handle.
    # The system process snapshot still exposes their non-path image name. A
    # different base name proves this cannot be our timestamped managed image;
    # a matching/unknown name remains ambiguous and must never be cleared.
    try {
        $ObservedProcess = Get-Process -Id $ProcessId -ErrorAction Stop
    } catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
        # Failure to inspect the process name is not proof that the receipt is
        # stale. Keep the receipt and fail closed rather than risk treating an
        # exact-but-protected managed process as unrelated.
        return $false
    }
    $ExpectedName = [System.IO.Path]::GetFileNameWithoutExtension($ExpectedExecutable)
    $ObservedName = [string]$ObservedProcess.ProcessName
    return -not [string]::IsNullOrWhiteSpace($ExpectedName) -and
        -not [string]::IsNullOrWhiteSpace($ObservedName) -and
        -not $ObservedName.Equals($ExpectedName, [System.StringComparison]::OrdinalIgnoreCase)
}

function Open-KsxExactProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedExecutable,

        [AllowNull()]
        [object]$ExpectedCreationTimeUtc = $null,

        [switch]$StaleIdentityAsMissing
    )

    try {
        $ExactProcess = [KsxStudioEnvironment.ExactProcess]::TryOpen([uint32]$ProcessId)
    } catch {
        $Cause = $_.Exception
        while ($Cause.InnerException) { $Cause = $Cause.InnerException }
        # Protected pseudo-processes vary by host policy: some reject
        # OpenProcess, while others grant the limited handle but reject its
        # image/path query. Either is a native identity-probe failure. A
        # different snapshot name still conclusively proves that the PID no
        # longer belongs to our expected executable; a matching or unreadable
        # name remains ambiguous and falls through to the original exception.
        $NativeProbeFailed = $Cause -is [System.ComponentModel.Win32Exception]
        if ($StaleIdentityAsMissing -and $NativeProbeFailed -and
            (Test-KsxProcessNameProvesStaleIdentity `
                -ProcessId $ProcessId `
                -ExpectedExecutable $ExpectedExecutable)) {
            Write-Verbose "Recorded PID $ProcessId failed native identity inspection but exposes an unrelated process name; treating the receipt generation as stale."
            return $null
        }
        throw
    }
    if (-not $ExactProcess) {
        return $null
    }
    try {
        $ActualExe = [System.IO.Path]::GetFullPath([string]$ExactProcess.ImagePath)
        $ExpectedExe = [System.IO.Path]::GetFullPath($ExpectedExecutable)
        if (-not $ActualExe.Equals($ExpectedExe, [System.StringComparison]::OrdinalIgnoreCase)) {
            if ($StaleIdentityAsMissing) {
                Write-Verbose "Recorded PID $ProcessId now owns '$ActualExe', not '$ExpectedExe'; treating the receipt generation as stale."
                $ExactProcess.Dispose()
                return $null
            }
            throw "PID $ProcessId no longer owns the expected executable."
        }
        if ($null -ne $ExpectedCreationTimeUtc -and
            -not [string]::IsNullOrWhiteSpace([string]$ExpectedCreationTimeUtc)) {
            $ExpectedCreation = if ($ExpectedCreationTimeUtc -is [datetime]) {
                ([datetime]$ExpectedCreationTimeUtc).ToUniversalTime()
            } else {
                [datetime]::Parse(
                    [string]$ExpectedCreationTimeUtc,
                    [System.Globalization.CultureInfo]::InvariantCulture,
                    [System.Globalization.DateTimeStyles]::RoundtripKind
                ).ToUniversalTime()
            }
            # Records created by the first schema-2 launcher came through CIM,
            # which truncates Windows' 100 ns FILETIME to microseconds. A PID
            # cannot exit and be reused inside this sub-microsecond tolerance;
            # accepting at most nine ticks preserves those live records while
            # retaining generation identity.
            $CreationDeltaTicks = [Math]::Abs(
                ($ExactProcess.CreationTimeUtc - $ExpectedCreation).Ticks
            )
            if ($CreationDeltaTicks -gt 9) {
                if ($StaleIdentityAsMissing) {
                    Write-Verbose "Recorded PID $ProcessId has a different creation time; treating the receipt generation as stale."
                    $ExactProcess.Dispose()
                    return $null
                }
                throw "PID $ProcessId was reused after its identity was recorded (expected $($ExpectedCreation.ToString('o')), actual $($ExactProcess.CreationTimeUtc.ToString('o')), delta $CreationDeltaTicks ticks)."
            }
        }
        return $ExactProcess
    } catch {
        $ExactProcess.Dispose()
        throw
    }
}

function Stop-KsxDaemonGracefully {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [int]$ExpectedProcessId,

        [int]$TimeoutMilliseconds = 1000
    )

    [KsxStudioEnvironment.PipeIdentity]::RequestExactDaemonQuit(
        [uint32]$ExpectedProcessId,
        $TimeoutMilliseconds
    )
}

function Get-KsxPipeServerProcessId {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("ksx-daemon", "ksx-live")]
        [string]$PipeName,

        [int]$TimeoutMilliseconds = 150,

        [switch]$ReadOnly
    )

    try {
        [uint32][KsxStudioEnvironment.PipeIdentity]::ServerProcessId(
            $PipeName,
            [bool]$ReadOnly,
            $TimeoutMilliseconds
        )
    } catch [System.TimeoutException] {
        [uint32]0
    } catch [System.IO.IOException] {
        # File-not-found, an instance-rotation race, and a busy pipe all mean
        # "not proven yet" to bounded polling callers. Other failures retain
        # their exception because treating access/identity failure as absence
        # could authorize a second daemon.
        $Code = $_.Exception.HResult -band 0xFFFF
        if ($Code -in @(2, 231)) {
            [uint32]0
        } else {
            throw
        }
    }
}
