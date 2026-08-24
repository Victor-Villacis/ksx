[CmdletBinding()]
param(
    [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-probe.ps1")

if ($SkipBuild) {
    throw "-SkipBuild is intentionally unavailable for real-hardware QA. The launcher must rebuild so the disposable runtime is guaranteed to carry the current machine-lifecycle safety fences. Use -SkipBuild only with isolated fixtures."
}

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$RuntimeRoot = Join-Path $RepoRoot "tmp\studio-env"
$BinRoot = Join-Path $RuntimeRoot "bin"
$LogRoot = Join-Path $RuntimeRoot "logs"
$BuildRoot = Join-Path $RepoRoot "target\studio-env-real"
$Port = 4460
$ReservedNonRealPorts = @(4476, 4478, 4479, 4488, 4489, 4490, 4496, 4500, 4510, 4511, 4512, 4520, 4521)
if ($ReservedNonRealPorts -contains $Port) {
    throw "Real-hardware QA is assigned reserved fixture/test port $Port. Correct the environment roster instead of starting it."
}

New-Item -ItemType Directory -Force -Path $BinRoot, $LogRoot | Out-Null

function Invoke-DaemonStatusProbe {
    param([Parameter(Mandatory = $true)][string]$Executable)

    $Lines = @(& $Executable session status --json 2>&1)
    $ExitCode = $LASTEXITCODE
    $Text = $Lines -join "`n"
    $Payload = $null
    try {
        $Payload = $Text | ConvertFrom-Json
    } catch {
        # The caller needs both the exit code and unparsed text to distinguish
        # a cleanly absent channel from a broken or incompatible responder.
    }
    [pscustomobject]@{
        exit_code = $ExitCode
        text = $Text
        payload = $Payload
    }
}

function Write-ManagedRecord {
    param(
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Record,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $Temporary = "$Path.$PID.tmp"
    try {
        $Record | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Temporary -Encoding utf8
        Move-Item -LiteralPath $Temporary -Destination $Path -Force
    } finally {
        Remove-Item -LiteralPath $Temporary -Force -ErrorAction SilentlyContinue
    }
}

$WinIpac = Get-Process WinIPAC -ErrorAction SilentlyContinue
if ($WinIpac) {
    Write-Warning "WinIPAC is open. KSX can observe keyboard input, but I-PAC chart reads may be blocked until WinIPAC releases MI_02. This script will not close it."
}

$TransitionMutex = $null
try {
    # The daemon pipes and managed record are machine-wide. The transition
    # lock must therefore cross Windows sessions as well.
    $TransitionMutex = [System.Threading.Mutex]::new(
        $false,
        "Global\KSXStudioEnvironment-real-transition"
    )
} catch [System.UnauthorizedAccessException] {
    throw "The machine-wide real-QA transition lock is owned by another Windows identity. Refusing to race that environment."
}
$TransitionLockHeld = $false
$LocationPushed = $false
$RecordPath = Join-Path $RuntimeRoot "real.json"
$RecordWritten = $false
$DisposableExecutables = @()
$StartedProcesses = @()
$LaunchId = ""
$ManagedDevEnvironmentName = "KSX_MANAGED_DEV_RUNTIME"
$PreviousManagedDevEnvironment = [Environment]::GetEnvironmentVariable(
    $ManagedDevEnvironmentName,
    [EnvironmentVariableTarget]::Process
)
$ManagedDevEnvironmentSet = $false
try {
    try {
        $TransitionLockHeld = $TransitionMutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
        $TransitionLockHeld = $true
    }
    if (-not $TransitionLockHeld) {
        throw "Another process is already building or swapping the real Studio environment. Wait for it to finish, then retry."
    }

    Push-Location $RepoRoot
    $LocationPushed = $true

    # Compile the replacement before stopping the current QA process. The
    # running instance is a timestamped copy, so this output remains writable.
    & cargo build -p ksx-app --features studio --target-dir $BuildRoot
    if ($LASTEXITCODE -ne 0) {
        throw "real Studio build failed with exit code $LASTEXITCODE"
    }

    $BuiltExe = Join-Path $BuildRoot "debug\ksx.exe"
    if (-not (Test-Path -LiteralPath $BuiltExe -PathType Leaf)) {
        throw "Studio-enabled ksx.exe is missing at $BuiltExe."
    }

    # ConfigRoot::discover uses a ksx.toml beside the running executable as
    # its portable-mode authority. Copying across that marker would silently
    # switch roots, so this managed launcher is deliberately installed-mode
    # only rather than pretending a different configuration is Victor's real
    # one. A portable build must be launched in place.
    $BuiltMarker = Join-Path (Split-Path -Parent $BuiltExe) "ksx.toml"
    $RuntimeMarker = Join-Path $BinRoot "ksx.toml"
    if ((Test-Path -LiteralPath $BuiltMarker -PathType Leaf) -or
        (Test-Path -LiteralPath $RuntimeMarker -PathType Leaf)) {
        throw "Refusing the managed real-QA copy because ksx.toml would change portable config-root discovery. Launch the portable ksx.exe in place on port 4460 instead."
    }

    & (Join-Path $PSScriptRoot "teardown.ps1") -Environment real -AllowMissing
    $Conflicts = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($Conflicts.Count -gt 0) {
        $Owners = ($Conflicts | Select-Object -ExpandProperty OwningProcess -Unique) -join ", "
        throw "Refusing to start real QA: port $Port is already owned by unmanaged PID(s) $Owners."
    }

    # The named daemon pipe is machine-global. A listener from an installed or
    # another branch build would make Studio look writable while serving a
    # different protocol/config implementation. Only the exact, typed
    # daemon-not-running response authorizes a replacement launch.
    $Before = Invoke-DaemonStatusProbe -Executable $BuiltExe
    $AbsentCode = if ($Before.payload) { [string]$Before.payload.code } else { "" }
    if ($Before.exit_code -ne 2 -or $AbsentCode -ne "daemon-not-running") {
        $Detail = if ($Before.text) { $Before.text } else { "exit $($Before.exit_code), no response" }
        throw "Refusing to mix builds: a daemon channel already answers or is unhealthy. Stop that daemon explicitly before starting current-branch QA. Probe: $Detail"
    }

    $Stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
    $LaunchId = $Stamp
    $RuntimeExe = Join-Path $BinRoot "ksx-real-$Stamp.exe"
    Copy-Item -LiteralPath $BuiltExe -Destination $RuntimeExe
    $DisposableExecutables = @($RuntimeExe)
    $ArtifactHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $BuiltExe).Hash
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $RuntimeExe).Hash -ne $ArtifactHash) {
        throw "The managed runtime copy is not byte-identical to the current build."
    }
    $WorkingTreeRevision = (& git rev-parse --short=12 HEAD 2>$null)
    if ($LASTEXITCODE -ne 0) { $WorkingTreeRevision = "unknown" }
    $DirtyRows = @(& git status --porcelain --untracked-files=normal 2>$null)
    if ($LASTEXITCODE -ne 0 -or $DirtyRows.Count -gt 0) {
        $WorkingTreeRevision = "$WorkingTreeRevision+dirty"
    }
    $SourceRevision = [string]$WorkingTreeRevision

    $DaemonStdout = Join-Path $LogRoot "real-daemon-$Stamp.stdout.log"
    $DaemonStderr = Join-Path $LogRoot "real-daemon-$Stamp.stderr.log"
    $StudioStdout = Join-Path $LogRoot "real-studio-$Stamp.stdout.log"
    $StudioStderr = Join-Path $LogRoot "real-studio-$Stamp.stderr.log"

    # --console keeps stdout/stderr attached to the managed log files. The
    # window is still hidden and the daemon remains idle: no --start is passed,
    # so no emulation session, pads, or game begin merely because QA opened.
    # This marker also makes machine-lifecycle writes such as autostart refuse
    # from the disposable development artifact.
    [Environment]::SetEnvironmentVariable(
        $ManagedDevEnvironmentName,
        $Stamp,
        [EnvironmentVariableTarget]::Process
    )
    $ManagedDevEnvironmentSet = $true
    $DaemonProcess = Start-Process -FilePath $RuntimeExe `
        -ArgumentList @("daemon", "--console") `
        -WorkingDirectory $RepoRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $DaemonStdout `
        -RedirectStandardError $DaemonStderr `
        -PassThru
    $DaemonStarted = [pscustomobject]@{
        process_id = $DaemonProcess.Id
        executable = $RuntimeExe
        role = "daemon"
        process_object = $DaemonProcess
        exact_process = $null
    }
    $StartedProcesses += $DaemonStarted
    # Record cleanup authority before any accessor can throw, then force
    # Process to retain its original OS handle immediately. The durable exact
    # handle below is validated from that same process generation; neither
    # failed-start cleanup path ever reopens a recycled numeric PID.
    $null = $DaemonProcess.Handle
    $DaemonExact = Open-KsxExactProcess `
        -ProcessId $DaemonProcess.Id `
        -ExpectedExecutable $RuntimeExe
    if (-not $DaemonExact) {
        throw "The managed daemon exited before its exact process handle could be retained."
    }
    $DaemonStarted.exact_process = $DaemonExact
    $DaemonCreation = $DaemonExact.CreationTimeUtc.ToString("o")

    $Record = [ordered]@{
        schema_version = 2
        launch_id = $Stamp
        state = "starting"
        environment = "real"
        kind = "live-machine"
        label = "Victor real-hardware QA"
        port = $Port
        process_id = $DaemonProcess.Id
        executable = $RuntimeExe
        stdout = $DaemonStdout
        stderr = $DaemonStderr
        started_at = (Get-Date).ToString("o")
        environment_id = "live-machine"
        generation = ""
        config_root = (Join-Path ([Environment]::GetFolderPath("ApplicationData")) "ksx")
        source_revision = $SourceRevision
        working_tree_revision = [string]$WorkingTreeRevision
        build_reused = $false
        managed_dev_runtime = $Stamp
        artifact_sha256 = $ArtifactHash
        artifact = [ordered]@{
            executable = $RuntimeExe
            sha256 = $ArtifactHash
        }
        processes = @(
            [ordered]@{
                role = "daemon"
                process_id = $DaemonProcess.Id
                creation_time_utc = $DaemonCreation
                executable = $RuntimeExe
                stdout = $DaemonStdout
                stderr = $DaemonStderr
            }
        )
    }
    Write-ManagedRecord -Record $Record -Path $RecordPath
    $RecordWritten = $true

    $DaemonReady = $false
    $LastDaemonError = "the control channel has not answered"
    for ($Attempt = 0; $Attempt -lt 80; $Attempt += 1) {
        if ($DaemonProcess.HasExited) { break }
        $Probe = Invoke-DaemonStatusProbe -Executable $RuntimeExe
        if ($Probe.exit_code -eq 0 -and $Probe.payload -and
            [bool]$Probe.payload.ok -and [string]$Probe.payload.run -eq "stopped") {
            $DaemonReady = $true
            break
        }
        $LastDaemonError = if ($Probe.text) { $Probe.text } else { "exit $($Probe.exit_code), no response" }
        Start-Sleep -Milliseconds 125
    }
    if (-not $DaemonReady) {
        $ExitDetail = if ($DaemonProcess.HasExited) { " Process exited with code $($DaemonProcess.ExitCode)." } else { "" }
        throw "The current-build daemon did not become ready: $LastDaemonError.$ExitDetail Inspect $DaemonStderr"
    }
    $ControlServerPid = Get-KsxPipeServerProcessId -PipeName "ksx-daemon" -TimeoutMilliseconds 1000
    $LiveServerPid = Get-KsxPipeServerProcessId -PipeName "ksx-live" -ReadOnly -TimeoutMilliseconds 1000
    if ([int]$ControlServerPid -ne $DaemonProcess.Id -or [int]$LiveServerPid -ne $DaemonProcess.Id) {
        throw "Refusing mixed runtime: daemon PID $($DaemonProcess.Id) does not own both KSX pipes (control=$ControlServerPid, live=$LiveServerPid)."
    }

    $StudioProcess = Start-Process -FilePath $RuntimeExe `
        -ArgumentList @("studio", "--port", [string]$Port) `
        -WorkingDirectory $RepoRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $StudioStdout `
        -RedirectStandardError $StudioStderr `
        -PassThru
    $StudioStarted = [pscustomobject]@{
        process_id = $StudioProcess.Id
        executable = $RuntimeExe
        role = "studio"
        process_object = $StudioProcess
        exact_process = $null
    }
    $StartedProcesses += $StudioStarted
    $null = $StudioProcess.Handle
    $StudioExact = Open-KsxExactProcess `
        -ProcessId $StudioProcess.Id `
        -ExpectedExecutable $RuntimeExe
    if (-not $StudioExact) {
        throw "Managed Studio exited before its exact process handle could be retained."
    }
    $StudioStarted.exact_process = $StudioExact
    $StudioCreation = $StudioExact.CreationTimeUtc.ToString("o")
    $Record.process_id = $StudioProcess.Id
    $Record.executable = $RuntimeExe
    $Record.stdout = $StudioStdout
    $Record.stderr = $StudioStderr
    $Record.processes += [ordered]@{
        role = "studio"
        process_id = $StudioProcess.Id
        creation_time_utc = $StudioCreation
        executable = $RuntimeExe
        stdout = $StudioStdout
        stderr = $StudioStderr
    }
    Write-ManagedRecord -Record $Record -Path $RecordPath

    $Ready = $false
    $LastHealthError = "the process has not opened its listener"
    for ($Attempt = 0; $Attempt -lt 160; $Attempt += 1) {
        if ($StudioProcess.HasExited -or $DaemonProcess.HasExited) { break }
        try {
            $Listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
            $OwnedListeners = @($Listeners | Where-Object { [int]$_.OwningProcess -eq $StudioProcess.Id })
            $ForeignListeners = @($Listeners | Where-Object { [int]$_.OwningProcess -ne $StudioProcess.Id })
            if ($ForeignListeners.Count -gt 0) {
                $Owners = ($ForeignListeners | Select-Object -ExpandProperty OwningProcess -Unique) -join ", "
                throw "port $Port also has foreign listener PID(s) $Owners"
            }
            if ($OwnedListeners.Count -eq 0) {
                throw "port $Port is not owned by new Studio PID $($StudioProcess.Id)"
            }
            $Response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/nocturne" -TimeoutSec 1
            if ($Response.StatusCode -ne 200) {
                throw "health endpoint returned HTTP $($Response.StatusCode)"
            }
            $Payload = $Response.Content | ConvertFrom-Json
            if ([bool]$Payload.environment.fixture) {
                throw "health payload claims fixture provenance"
            }
            if ([string]$Payload.environment.id -ne "live-machine") {
                throw "health payload environment '$($Payload.environment.id)' is not 'live-machine'"
            }
            if (-not [string]::IsNullOrEmpty([string]$Payload.environment.generation)) {
                throw "live-machine health payload unexpectedly carries fixture generation '$($Payload.environment.generation)'"
            }
            if (-not [bool]$Payload.staged.reachable) {
                throw "Studio cannot reach the managed daemon: $($Payload.staged.error)"
            }
            $StatusResponse = Invoke-WebRequest `
                -UseBasicParsing `
                -Uri "http://127.0.0.1:$Port/api/status" `
                -TimeoutSec 1
            if ($StatusResponse.StatusCode -ne 200) {
                throw "status endpoint returned HTTP $($StatusResponse.StatusCode)"
            }
            $StatusPayload = $StatusResponse.Content | ConvertFrom-Json
            $ExpectedConfigRoot = [System.IO.Path]::GetFullPath(
                (Join-Path ([Environment]::GetFolderPath("ApplicationData")) "ksx")
            )
            $ActualConfigRoot = [System.IO.Path]::GetFullPath(
                [string]$StatusPayload.snapshot.config_root
            )
            if (-not $ActualConfigRoot.Equals(
                $ExpectedConfigRoot,
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
                throw "managed runtime opened unexpected config root '$ActualConfigRoot' instead of '$ExpectedConfigRoot'"
            }
            $Record.config_root = $ActualConfigRoot
            $ControlServerPid = Get-KsxPipeServerProcessId -PipeName "ksx-daemon" -TimeoutMilliseconds 500
            $LiveServerPid = Get-KsxPipeServerProcessId -PipeName "ksx-live" -ReadOnly -TimeoutMilliseconds 500
            if ([int]$ControlServerPid -ne $DaemonProcess.Id -or [int]$LiveServerPid -ne $DaemonProcess.Id) {
                throw "managed daemon no longer owns both KSX pipes (control=$ControlServerPid, live=$LiveServerPid)"
            }
            $Ready = $true
            break
        } catch {
            $LastHealthError = $_.Exception.Message
            Start-Sleep -Milliseconds 125
        }
    }
    if (-not $Ready) {
        $ExitDetail = if ($StudioProcess.HasExited) { " Studio exited with code $($StudioProcess.ExitCode)." } elseif ($DaemonProcess.HasExited) { " Daemon exited with code $($DaemonProcess.ExitCode)." } else { "" }
        throw "Real Studio did not become healthy: $LastHealthError.$ExitDetail Inspect $StudioStderr and $DaemonStderr"
    }
    $Record.state = "ready"
    Write-ManagedRecord -Record $Record -Path $RecordPath

    Write-Host "Started a matched real-hardware QA artifact built by this invocation (source $SourceRevision)."
    Write-Host "Daemon PID $($DaemonProcess.Id) and Studio PID $($StudioProcess.Id) share artifact $($ArtifactHash.Substring(0, 12))."
    Write-Host "Config: $($Record.config_root)"
    Write-Host "Open: http://127.0.0.1:$Port/nocturne"
    Write-Host "Warning: confirmed hardware actions on this instance can affect the selected physical device."
} catch {
    $Failure = $_
    if ($RecordWritten -and (Test-Path -LiteralPath $RecordPath -PathType Leaf)) {
        try {
            & (Join-Path $PSScriptRoot "teardown.ps1") -Environment real -AllowMissing
        } catch {
            Write-Warning "Startup cleanup could not complete: $($_.Exception.Message)"
        }
    }
    # Always sweep the processes retained in memory. The durable record can
    # legitimately lag one spawn (for example, a failed second record write),
    # so successful record-based cleanup is not proof that every new child was
    # represented in it.
    $AllStartedProcessesGone = $true
    foreach ($StartedProcess in @($StartedProcesses | Sort-Object { if ($_.role -eq "studio") { 0 } else { 1 } })) {
        $ExactProcess = $StartedProcess.exact_process
        if ($ExactProcess) {
            if (-not $ExactProcess.HasExited) {
                try {
                    $ExactProcess.Terminate(1)
                } catch {
                    Write-Warning "Startup cleanup could not terminate exact $($StartedProcess.role) PID $([int]$StartedProcess.process_id): $($_.Exception.Message)"
                }
            }
            if (-not $ExactProcess.Wait(10000)) {
                $AllStartedProcessesGone = $false
                Write-Warning "Startup cleanup timed out waiting for exact $($StartedProcess.role) PID $([int]$StartedProcess.process_id)."
            }
        } else {
            # This branch is only reachable if exact-handle acquisition failed
            # immediately after Start-Process. Its Process object already had
            # the original handle forced, so Kill cannot address a reused PID.
            $ProcessObject = $StartedProcess.process_object
            if (-not $ProcessObject.HasExited) {
                try {
                    $ProcessObject.Kill()
                    if (-not $ProcessObject.WaitForExit(10000)) {
                        $AllStartedProcessesGone = $false
                    }
                } catch {
                    $AllStartedProcessesGone = $false
                    Write-Warning "Startup cleanup could not stop the retained $($StartedProcess.role) process handle: $($_.Exception.Message)"
                }
            }
        }
    }
    if ($AllStartedProcessesGone -and $LaunchId -and (Test-Path -LiteralPath $RecordPath -PathType Leaf)) {
        try {
            $FailedRecord = Get-Content -LiteralPath $RecordPath -Raw | ConvertFrom-Json
            if (($FailedRecord.PSObject.Properties.Name -contains "launch_id") -and
                [string]$FailedRecord.launch_id -eq $LaunchId) {
                Remove-Item -LiteralPath $RecordPath -Force
            }
        } catch {
            Write-Warning "The failed launch's managed record could not be inspected; it was retained. $($_.Exception.Message)"
        }
    }
    foreach ($DisposableExecutable in $DisposableExecutables) {
        $StillInUse = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
            $_.ExecutablePath -and ([System.IO.Path]::GetFullPath([string]$_.ExecutablePath)).Equals(
                [System.IO.Path]::GetFullPath($DisposableExecutable),
                [System.StringComparison]::OrdinalIgnoreCase)
        }).Count -gt 0
        if (-not $StillInUse) {
            Remove-Item -LiteralPath $DisposableExecutable -Force -ErrorAction SilentlyContinue
        }
    }
    throw $Failure
} finally {
    if ($ManagedDevEnvironmentSet) {
        [Environment]::SetEnvironmentVariable(
            $ManagedDevEnvironmentName,
            $PreviousManagedDevEnvironment,
            [EnvironmentVariableTarget]::Process
        )
    }
    foreach ($StartedProcess in $StartedProcesses) {
        if ($StartedProcess.exact_process) {
            $StartedProcess.exact_process.Dispose()
        }
        if ($StartedProcess.process_object) {
            $StartedProcess.process_object.Dispose()
        }
    }
    if ($LocationPushed) {
        Pop-Location
    }
    if ($TransitionLockHeld) {
        $TransitionMutex.ReleaseMutex()
    }
    if ($TransitionMutex) {
        $TransitionMutex.Dispose()
    }
}
