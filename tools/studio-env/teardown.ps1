[CmdletBinding(DefaultParameterSetName = "One")]
param(
    [Parameter(Mandatory = $true, ParameterSetName = "One")]
    [ValidateSet("seeded", "first-run", "blank-encoder", "real")]
    [string]$Environment,

    [Parameter(Mandatory = $true, ParameterSetName = "All")]
    [switch]$All,

    [switch]$AllowMissing
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-probe.ps1")

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$RuntimeRoot = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot "tmp\studio-env"))
$Targets = if ($All) { @("seeded", "first-run", "blank-encoder", "real") } else { @($Environment) }

foreach ($Target in $Targets) {
    $TransitionMutex = $null
    $TransitionLockHeld = $false
    $OpenedProcessHandles = @()
    try {
        # Windows mutex ownership is recursive for the owning thread. A seed
        # or real-start transition can therefore call teardown while holding
        # this same mutex, while every direct caller remains unable to bypass
        # the lock.
        try {
            $TransitionMutex = [System.Threading.Mutex]::new(
                $false,
                "Global\KSXStudioEnvironment-$Target-transition"
            )
        } catch [System.UnauthorizedAccessException] {
            throw "The machine-wide '$Target' transition lock is owned by another Windows identity. Teardown refused to race it."
        }
        try {
            $TransitionLockHeld = $TransitionMutex.WaitOne(0)
        } catch [System.Threading.AbandonedMutexException] {
            $TransitionLockHeld = $true
        }
        if (-not $TransitionLockHeld) {
            throw "Another process is building or swapping the '$Target' Studio environment. Teardown refused to race it."
        }

        $RecordPath = Join-Path $RuntimeRoot "$Target.json"
        if (-not (Test-Path -LiteralPath $RecordPath -PathType Leaf)) {
            if (-not $AllowMissing) { Write-Host "${Target}: no managed process record." }
            continue
        }

        $Record = Get-Content -LiteralPath $RecordPath -Raw | ConvertFrom-Json
        $HasProcessArray = ($Record.PSObject.Properties.Name -contains "processes") -and
            @($Record.processes).Count -gt 0
        $HasSchemaVersion = $Record.PSObject.Properties.Name -contains "schema_version"
        if ($HasProcessArray -or $HasSchemaVersion) {
            if (-not $HasSchemaVersion -or [int]$Record.schema_version -ne 2 -or -not $HasProcessArray) {
                throw "Refusing to stop ${Target}: the managed record is neither a complete schema-2 record nor the explicit legacy scalar shape."
            }
            foreach ($RequiredField in @("launch_id", "state", "artifact_sha256", "executable")) {
                if (-not ($Record.PSObject.Properties.Name -contains $RequiredField) -or
                    [string]::IsNullOrWhiteSpace([string]$Record.$RequiredField)) {
                    throw "Refusing to stop ${Target}: schema-2 field '$RequiredField' is missing."
                }
            }
            if ([string]$Record.artifact_sha256 -notmatch '^[0-9A-Fa-f]{64}$') {
                throw "Refusing to stop ${Target}: schema-2 artifact_sha256 is invalid."
            }
            foreach ($SchemaProcess in @($Record.processes)) {
                if (-not ($SchemaProcess.PSObject.Properties.Name -contains "creation_time_utc") -or
                    [string]::IsNullOrWhiteSpace([string]$SchemaProcess.creation_time_utc)) {
                    throw "Refusing to stop ${Target}: a schema-2 process has no creation_time_utc."
                }
            }
            if ($Target -eq "real") {
                $SchemaDaemons = @($Record.processes | Where-Object { [string]$_.role -eq "daemon" })
                $SchemaStudios = @($Record.processes | Where-Object { [string]$_.role -eq "studio" })
                $SchemaState = [string]$Record.state
                $ValidStarting = $SchemaState -eq "starting" -and
                    $SchemaDaemons.Count -eq 1 -and $SchemaStudios.Count -le 1 -and
                    @($Record.processes).Count -eq (1 + $SchemaStudios.Count)
                $ValidReady = $SchemaState -eq "ready" -and
                    $SchemaDaemons.Count -eq 1 -and $SchemaStudios.Count -eq 1 -and
                    @($Record.processes).Count -eq 2
                if (-not $ValidStarting -and -not $ValidReady) {
                    throw "Refusing to stop real: schema 2 must be a starting daemon (optionally with Studio) or a ready daemon/Studio pair."
                }
            }
        }
        # Schema 2 records every long-lived process in the environment. The
        # legacy scalar pair remains readable so a script upgrade can tear
        # down the process started by the previous version instead of
        # orphaning it.
        $RecordedProcesses = if ($HasProcessArray) {
            @($Record.processes)
        } else {
            @([pscustomobject]@{
                role = "studio"
                process_id = $Record.process_id
                executable = $Record.executable
            })
        }
        $ManagedPrefix = $RuntimeRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
        $SeenPids = @{}
        $ValidatedProcesses = @()
        $SkipExecutableRemoval = @{}
        $RecordedArtifactPath = [System.IO.Path]::GetFullPath([string]$Record.executable)

        # Validate the complete stop set before stopping any member. A stale
        # PID in one role must not cause us to kill the valid member and leave
        # an environment half-managed.
        foreach ($RecordedProcess in $RecordedProcesses) {
            $Role = [string]$RecordedProcess.role
            $ManagedProcessId = [int]$RecordedProcess.process_id
            $ExpectedExe = [System.IO.Path]::GetFullPath([string]$RecordedProcess.executable)
            if ([string]::IsNullOrWhiteSpace($Role)) {
                throw "Refusing to stop ${Target}: a recorded process has no role."
            }
            if ($ManagedProcessId -le 0 -or $SeenPids.ContainsKey($ManagedProcessId)) {
                throw "Refusing to stop ${Target}: recorded PID $ManagedProcessId is invalid or duplicated."
            }
            $SeenPids[$ManagedProcessId] = $true
            if (-not $ExpectedExe.StartsWith($ManagedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Refusing to stop ${Target}: recorded $Role executable is outside $RuntimeRoot"
            }
            if ($Target -eq "real" -and
                ($Record.PSObject.Properties.Name -contains "schema_version") -and
                -not $ExpectedExe.Equals($RecordedArtifactPath, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Refusing to stop real: the $Role process does not use the one recorded runtime artifact."
            }

            $ExpectedCreation = if ($RecordedProcess.PSObject.Properties.Name -contains "creation_time_utc") {
                $RecordedProcess.creation_time_utc
            } else {
                ""
            }
            # Open once, validate identity from that handle, and retain the
            # handle until teardown completes. No destructive action below
            # ever reopens this numeric PID after Windows could recycle it.
            $ExactProcess = Open-KsxExactProcess `
                -ProcessId $ManagedProcessId `
                -ExpectedExecutable $ExpectedExe `
                -ExpectedCreationTimeUtc $ExpectedCreation
            if ($ExactProcess) {
                $OpenedProcessHandles += $ExactProcess
            }
            $ValidatedProcesses += [pscustomobject]@{
                role = $Role
                process_id = $ManagedProcessId
                executable = $ExpectedExe
                live = [bool]($ExactProcess -and -not $ExactProcess.HasExited)
                exact_process = $ExactProcess
            }
        }

        # A hash is a live-process identity gate, not a stale-record poison
        # pill. With no process alive, a missing file is ordinary debris and a
        # mismatched file is left untouched while the stale record is cleared.
        if (($Record.PSObject.Properties.Name -contains "artifact_sha256") -and
            -not [string]::IsNullOrWhiteSpace([string]$Record.artifact_sha256)) {
            $AnyProcessAlive = @($ValidatedProcesses | Where-Object live).Count -gt 0
            $ArtifactExists = Test-Path -LiteralPath $RecordedArtifactPath -PathType Leaf
            $ArtifactMatches = $ArtifactExists -and
                (Get-FileHash -Algorithm SHA256 -LiteralPath $RecordedArtifactPath).Hash -eq [string]$Record.artifact_sha256
            if ($AnyProcessAlive -and -not $ArtifactMatches) {
                throw "Refusing to stop ${Target}: the live managed artifact no longer matches its recorded SHA-256."
            }
            if (-not $AnyProcessAlive -and $ArtifactExists -and -not $ArtifactMatches) {
                $SkipExecutableRemoval[$RecordedArtifactPath] = $true
                Write-Warning "Clearing stale $Target record but leaving the changed artifact untouched: $RecordedArtifactPath"
            }
        }

        $ControlServerPid = [uint32]0
        $LiveServerPid = [uint32]0
        if ($Target -eq "real") {
            $ManagedDaemon = @($ValidatedProcesses | Where-Object { $_.role -eq "daemon" -and $_.live })
            if ($ManagedDaemon.Count -gt 1) {
                throw "Refusing to stop real: more than one managed daemon is recorded."
            }
            if ($ManagedDaemon.Count -eq 1) {
                $DaemonPid = [int]$ManagedDaemon[0].process_id
                try {
                    $ControlServerPid = Get-KsxPipeServerProcessId -PipeName "ksx-daemon" -TimeoutMilliseconds 250
                } catch {
                    Write-Warning "The control pipe owner could not be proven, so graceful quit is disabled. Only the exact recorded process handle will be stopped. $($_.Exception.Message)"
                    $ControlServerPid = [uint32]0
                }
                try {
                    $LiveServerPid = Get-KsxPipeServerProcessId -PipeName "ksx-live" -ReadOnly -TimeoutMilliseconds 250
                } catch {
                    Write-Warning "The live pipe owner could not be proven. Only the exact recorded process handle will be stopped. $($_.Exception.Message)"
                    $LiveServerPid = [uint32]0
                }
                if (($ControlServerPid -ne 0 -and [int]$ControlServerPid -ne $DaemonPid) -or
                    ($LiveServerPid -ne 0 -and [int]$LiveServerPid -ne $DaemonPid)) {
                    # Never send a verb to those foreign pipes. The recorded
                    # process identity is still exact, so it is safe—and
                    # necessary for failed-start rollback—to stop only that
                    # process while leaving the foreign daemon untouched.
                    Write-Warning "Mixed runtime: recorded daemon PID $DaemonPid does not own the answering KSX pipes (control=$ControlServerPid, live=$LiveServerPid). Only the exact recorded process will be stopped."
                }
            }
        }

        # Stop the web view before its daemon. This prevents a still-serving
        # page from accepting a mutation during the daemon's shutdown window.
        $StopOrder = @($ValidatedProcesses | Sort-Object @{ Expression = {
            if ($_.role -eq "studio") { 0 } elseif ($_.role -eq "daemon") { 1 } else { 2 }
        } })
        foreach ($ManagedProcess in $StopOrder) {
            $ManagedProcessId = [int]$ManagedProcess.process_id
            $ExpectedExe = [string]$ManagedProcess.executable
            $Role = [string]$ManagedProcess.role
            if ([bool]$ManagedProcess.live) {
                $ExactProcess = $ManagedProcess.exact_process
                $GracefulQuit = $Target -eq "real" -and $Role -eq "daemon" -and
                    [int]$ControlServerPid -eq $ManagedProcessId
                if ($GracefulQuit) {
                    try {
                        # Server-PID validation and the quit write happen on
                        # one pipe handle, closing the check/use race against
                        # an installed daemon acquiring the fixed name.
                        Stop-KsxDaemonGracefully -ExpectedProcessId $ManagedProcessId
                    } catch {
                        Write-Warning "Managed daemon did not accept graceful quit; the exact recorded PID will be stopped. $($_.Exception.Message)"
                    }
                    $null = $ExactProcess.Wait(10000)
                }
                if (-not $ExactProcess.HasExited) {
                    $ExactProcess.Terminate(1)
                }
                if (-not $ExactProcess.Wait(10000)) {
                    throw "Refusing to forget ${Target}: the exact $Role process handle (recorded PID $ManagedProcessId) did not exit within 10 seconds. Its managed record was retained."
                }
                Write-Host "Stopped $Target $Role (PID $ManagedProcessId)."
            } elseif (-not $AllowMissing) {
                Write-Host "${Target}: recorded $Role process is already stopped."
            }
        }

        Remove-Item -LiteralPath $RecordPath -Force
        $ExpectedExecutables = @($ValidatedProcesses | Select-Object -ExpandProperty executable -Unique)
        foreach ($ExpectedExe in $ExpectedExecutables) {
            if ($SkipExecutableRemoval.ContainsKey([string]$ExpectedExe)) { continue }
            if (-not (Test-Path -LiteralPath $ExpectedExe -PathType Leaf)) { continue }
            $RemovedExecutable = $false
            for ($Attempt = 0; $Attempt -lt 20; $Attempt += 1) {
                try {
                    Remove-Item -LiteralPath $ExpectedExe -Force -ErrorAction Stop
                    $RemovedExecutable = -not (Test-Path -LiteralPath $ExpectedExe)
                    if ($RemovedExecutable) { break }
                } catch {
                    if ($Attempt -lt 19) {
                        Start-Sleep -Milliseconds 100
                    }
                }
            }
            if (-not $RemovedExecutable) {
                Write-Warning "Stopped $Target, but Windows still has the disposable managed copy open. It remains under ignored tmp/studio-env and may be removed after the lock clears: $ExpectedExe"
            }
        }
    } finally {
        foreach ($OpenedProcessHandle in $OpenedProcessHandles) {
            $OpenedProcessHandle.Dispose()
        }
        if ($TransitionLockHeld) {
            $TransitionMutex.ReleaseMutex()
        }
        if ($TransitionMutex) {
            $TransitionMutex.Dispose()
        }
    }
}
