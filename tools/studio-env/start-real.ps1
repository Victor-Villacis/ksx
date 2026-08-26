[CmdletBinding()]
param(
    [switch]$SkipBuild,

    [ValidateNotNullOrEmpty()]
    [string]$LaunchReason = "manual"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-probe.ps1")
. (Join-Path $PSScriptRoot "build-graph.ps1")
. (Join-Path $PSScriptRoot "source-graph.ps1")

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

function Read-RealManagedRecord {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    try {
        return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    } catch {
        throw "Refusing real-hardware replacement: the managed process record is unreadable. Resolve it with status/teardown before retrying. $($_.Exception.Message)"
    }
}

function Get-ValidatedRealRecordArtifact {
    param([Parameter(Mandatory = $true)]$Record)

    if (-not ($Record.PSObject.Properties.Name -contains "schema_version") -or
        [int]$Record.schema_version -ne 2 -or
        -not ($Record.PSObject.Properties.Name -contains "processes") -or
        -not ($Record.PSObject.Properties.Name -contains "executable") -or
        -not ($Record.PSObject.Properties.Name -contains "artifact_sha256")) {
        throw "Refusing real-hardware replacement: the managed record has no complete schema-2 artifact identity. Run the supervised teardown/status recovery first."
    }
    $Artifact = [System.IO.Path]::GetFullPath([string]$Record.executable)
    $ManagedPrefix = [System.IO.Path]::GetFullPath($BinRoot).TrimEnd('\', '/') +
        [System.IO.Path]::DirectorySeparatorChar
    if (-not $Artifact.StartsWith($ManagedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        [string]$Record.artifact_sha256 -notmatch '^[0-9A-Fa-f]{64}$' -or
        -not (Test-Path -LiteralPath $Artifact -PathType Leaf) -or
        (Get-FileHash -LiteralPath $Artifact -Algorithm SHA256).Hash -ne [string]$Record.artifact_sha256) {
        throw "Refusing real-hardware replacement: the record-derived probe artifact is outside the managed bin or fails its SHA-256 identity."
    }
    $Daemons = @($Record.processes | Where-Object { [string]$_.role -eq "daemon" })
    if ($Daemons.Count -ne 1) {
        throw "Refusing real-hardware replacement: schema 2 does not name exactly one daemon."
    }
    foreach ($ProcessRecord in @($Record.processes)) {
        if (-not ($ProcessRecord.PSObject.Properties.Name -contains "executable") -or
            -not ([System.IO.Path]::GetFullPath([string]$ProcessRecord.executable)).Equals(
                $Artifact,
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
            throw "Refusing real-hardware replacement: the managed record mixes artifact paths."
        }
    }
    return $Artifact
}

function Get-PreBuildProbeExecutable {
    param(
        [AllowNull()][object]$Record,
        [Parameter(Mandatory = $true)][string]$BuiltExecutable
    )

    $Candidates = New-Object System.Collections.Generic.List[string]
    if ($Record) {
        # A mutable ignored receipt never becomes command authority merely by
        # containing an executable string. Validate its managed path, one-artifact
        # shape and hash before any record-derived file can be invoked.
        $Candidates.Add((Get-ValidatedRealRecordArtifact -Record $Record))
    }
    $Candidates.Add($BuiltExecutable)
    $Candidates.Add((Join-Path $env:ProgramFiles "ksx\ksx.exe"))

    foreach ($Candidate in $Candidates) {
        if (-not [string]::IsNullOrWhiteSpace($Candidate) -and
            (Test-Path -LiteralPath $Candidate -PathType Leaf)) {
            return [System.IO.Path]::GetFullPath($Candidate)
        }
    }
    return ""
}

function Assert-RealDaemonSafeForReplacement {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string]$RecordPath,
        [Parameter(Mandatory = $true)][string]$Phase
    )

    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
        throw "Refusing real-hardware replacement during ${Phase}: daemon probe executable is missing at $Executable."
    }

    $Record = Read-RealManagedRecord -Path $RecordPath
    $RecordedDaemon = $null
    $ExactRecordedDaemon = $null
    try {
        if ($Record -and ($Record.PSObject.Properties.Name -contains "schema_version")) {
            $null = Get-ValidatedRealRecordArtifact -Record $Record
            if ([int]$Record.schema_version -ne 2 -or
                -not ($Record.PSObject.Properties.Name -contains "processes")) {
                throw "Refusing real-hardware replacement during ${Phase}: the managed record has an incomplete schema-2 shape."
            }
            $RecordedDaemons = @($Record.processes | Where-Object { [string]$_.role -eq "daemon" })
            if ($RecordedDaemons.Count -ne 1) {
                throw "Refusing real-hardware replacement during ${Phase}: schema 2 does not name exactly one managed daemon."
            }
            $RecordedDaemon = $RecordedDaemons[0]
            foreach ($Required in @("process_id", "executable", "creation_time_utc")) {
                if (-not ($RecordedDaemon.PSObject.Properties.Name -contains $Required) -or
                    [string]::IsNullOrWhiteSpace([string]$RecordedDaemon.$Required)) {
                    throw "Refusing real-hardware replacement during ${Phase}: the recorded daemon has no $Required."
                }
            }
            try {
                $ExactRecordedDaemon = Open-KsxExactProcess `
                    -ProcessId ([int]$RecordedDaemon.process_id) `
                    -ExpectedExecutable ([string]$RecordedDaemon.executable) `
                    -ExpectedCreationTimeUtc $RecordedDaemon.creation_time_utc
            } catch {
                throw "Refusing real-hardware replacement during ${Phase}: the recorded daemon identity is ambiguous. $($_.Exception.Message)"
            }
        }

        $Probe = Invoke-KsxDaemonStatusProbe -Executable $Executable
        $Payload = $Probe.payload
        $HasOk = $Payload -and ($Payload.PSObject.Properties.Name -contains "ok")
        $HasRun = $Payload -and ($Payload.PSObject.Properties.Name -contains "run")
        $HasCode = $Payload -and ($Payload.PSObject.Properties.Name -contains "code")
        $ExactStopped = $Probe.exit_code -eq 0 -and $HasOk -and
            [bool]$Payload.ok -and $HasRun -and [string]$Payload.run -ceq "stopped"
        $ExactAbsent = $Probe.exit_code -eq 2 -and $HasOk -and
            -not [bool]$Payload.ok -and $HasCode -and
            [string]$Payload.code -ceq "daemon-not-running"

        $ControlServerPid = Get-KsxPipeServerProcessId `
            -PipeName "ksx-daemon" `
            -TimeoutMilliseconds 1000
        $LiveServerPid = Get-KsxPipeServerProcessId `
            -PipeName "ksx-live" `
            -ReadOnly `
            -TimeoutMilliseconds 1000
        $RecordedPid = if ($ExactRecordedDaemon) { [int]$ExactRecordedDaemon.ProcessId } else { 0 }
        $RecordedDaemonStillLive = $ExactRecordedDaemon -and -not $ExactRecordedDaemon.HasExited
        $RecordedIdentityOwnsPipes = $RecordedPid -ne 0 -and $RecordedDaemonStillLive -and
            [int]$ControlServerPid -eq $RecordedPid -and
            [int]$LiveServerPid -eq $RecordedPid

        if ($ExactStopped) {
            if (-not $RecordedIdentityOwnsPipes) {
                throw "Refusing real-hardware replacement during ${Phase}: a stopped daemon answers, but it is not the exact daemon recorded for this managed runtime (recorded=$RecordedPid, control=$ControlServerPid, live=$LiveServerPid)."
            }
            return
        }
        if ($ExactAbsent) {
            if ($ExactRecordedDaemon -or [int]$ControlServerPid -ne 0 -or [int]$LiveServerPid -ne 0) {
                throw "Refusing real-hardware replacement during ${Phase}: the client reports daemon-not-running while a recorded process or daemon pipe still exists (recorded=$RecordedPid, control=$ControlServerPid, live=$LiveServerPid)."
            }
            return
        }

        if ($Probe.exit_code -eq 0 -and $HasOk -and [bool]$Payload.ok -and $HasRun) {
            if (-not $RecordedIdentityOwnsPipes) {
                throw "Refusing real-hardware replacement during ${Phase}: an unrecorded or mismatched daemon reports run state '$([string]$Payload.run)' (recorded=$RecordedPid, control=$ControlServerPid, live=$LiveServerPid)."
            }
            throw "KSX_WATCH_DEFERRED: the current KSX session is '$([string]$Payload.run)'; stop Play before replacing the real-hardware development runtime."
        }

        $Detail = if ($Probe.text) { $Probe.text } else { "exit $($Probe.exit_code), no typed response" }
        throw "Refusing real-hardware replacement during ${Phase}: daemon state is ambiguous. Only typed stopped or typed daemon-not-running permits replacement. Probe: $Detail"
    } finally {
        if ($ExactRecordedDaemon) {
            $ExactRecordedDaemon.Dispose()
        }
    }
}

function Invoke-RealHardwarePreBuildPreflight {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$ProbeExecutable,
        [Parameter(Mandatory = $true)][string]$RecordPath
    )

    if ($ProbeExecutable) {
            Assert-RealDaemonSafeForReplacement `
                -Executable $ProbeExecutable `
                -RecordPath $RecordPath `
                -Phase "pre-build preflight"
        } else {
            # A completely fresh checkout may have no compatible client until
            # its first build. Building is non-destructive, but an existing
            # pipe without a typed client is ambiguous and may not be built
            # past toward teardown. The post-build probe remains mandatory.
            $ControlServerPid = Get-KsxPipeServerProcessId `
                -PipeName "ksx-daemon" `
                -TimeoutMilliseconds 250
            $LiveServerPid = Get-KsxPipeServerProcessId `
                -PipeName "ksx-live" `
                -ReadOnly `
                -TimeoutMilliseconds 250
            if ([int]$ControlServerPid -ne 0 -or [int]$LiveServerPid -ne 0) {
                throw "Refusing real-hardware replacement before build: a daemon pipe exists but no compatible executable is available for the required typed status probe (control=$ControlServerPid, live=$LiveServerPid)."
            }
        Write-Verbose "No prior KSX client exists; the first build will provide the typed pre-swap probe."
    }
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
$BuildGraphLock = $null
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

    $BuiltExe = Join-Path $BuildRoot "debug\ksx.exe"
    $PreflightRecord = Read-RealManagedRecord -Path $RecordPath
    $PreflightProbeExecutable = Get-PreBuildProbeExecutable `
        -Record $PreflightRecord `
        -BuiltExecutable $BuiltExe
    # This pass is deliberately before Cargo. A watched refresh that is waiting
    # on Play or an EEPROM transaction must stay cheap; the post-build pass
    # below remains authoritative for the actual swap.
    Invoke-RealHardwarePreBuildPreflight `
        -ProbeExecutable $PreflightProbeExecutable `
        -RecordPath $RecordPath

    # Cargo embeds the generated Studio asset tree. Hold the same graph lock as
    # build-assets.ps1 and require its receipt so a failed/partial Node build
    # can never become a real-hardware executable.
    $BuildGraphLock = Enter-KsxStudioBuildGraphLock -Operation "building real-hardware Studio"
    try {
        $StudioInputHashBefore = Get-KsxSourceGraphFingerprint -Kind Studio -RepoRoot $RepoRoot
        $ZoneProducerHashBefore = Get-KsxSourceGraphFingerprint -Kind ZoneProducers -RepoRoot $RepoRoot
        $SourceGraphHashBefore = Get-KsxSourceGraphFingerprint -Kind Runtime -RepoRoot $RepoRoot
        $AssetStateBefore = Assert-KsxStudioAssetGraphReady `
            -RepoRoot $RepoRoot `
            -ExpectedStudioInputSha256 $StudioInputHashBefore `
            -ExpectedZoneProducerSha256 $ZoneProducerHashBefore

        # Compile the replacement before stopping the current QA process. The
        # running instance is a timestamped copy, so this output remains writable.
        & cargo build -p ksx-app --features studio --target-dir $BuildRoot
        if ($LASTEXITCODE -ne 0) {
            throw "real Studio build failed with exit code $LASTEXITCODE"
        }

        # Editors can save without taking the build mutex. Re-read every input
        # after Cargo and revalidate the asset receipt; an executable is usable
        # only when one stable source/asset graph surrounded its whole build.
        $StudioInputHashAfter = Get-KsxSourceGraphFingerprint -Kind Studio -RepoRoot $RepoRoot
        $ZoneProducerHashAfter = Get-KsxSourceGraphFingerprint -Kind ZoneProducers -RepoRoot $RepoRoot
        $SourceGraphHashAfter = Get-KsxSourceGraphFingerprint -Kind Runtime -RepoRoot $RepoRoot
        $AssetStateAfter = Assert-KsxStudioAssetGraphReady `
            -RepoRoot $RepoRoot `
            -ExpectedStudioInputSha256 $StudioInputHashAfter `
            -ExpectedZoneProducerSha256 $ZoneProducerHashAfter
        if ($StudioInputHashBefore -cne $StudioInputHashAfter -or
            $ZoneProducerHashBefore -cne $ZoneProducerHashAfter -or
            $SourceGraphHashBefore -cne $SourceGraphHashAfter -or
            [string]$AssetStateBefore.studio_input_sha256 -cne [string]$AssetStateAfter.studio_input_sha256 -or
            [string]$AssetStateBefore.asset_graph_sha256 -cne [string]$AssetStateAfter.asset_graph_sha256) {
            throw "Studio or runtime source changed while Cargo was building. The completed executable was not served; retry after the source graph settles."
        }
        $StudioInputHash = $StudioInputHashAfter
        $ZoneProducerHash = $ZoneProducerHashAfter
        $SourceGraphHash = $SourceGraphHashAfter
        $AssetGraphHash = [string]$AssetStateAfter.asset_graph_sha256
    } finally {
        Exit-KsxStudioBuildGraphLock -Lock $BuildGraphLock
        $BuildGraphLock = $null
    }

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

    # Repeat the typed probe after compilation: this is the authoritative
    # authorization for teardown, and the cheap pre-build pass deliberately
    # did not span a long Cargo build.
    Assert-RealDaemonSafeForReplacement `
        -Executable $BuiltExe `
        -RecordPath $RecordPath `
        -Phase "authoritative post-build preflight"

    & (Join-Path $PSScriptRoot "teardown.ps1") -Environment real -AllowMissing
    $Conflicts = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($Conflicts.Count -gt 0) {
        $Owners = ($Conflicts | Select-Object -ExpandProperty OwningProcess -Unique) -join ", "
        throw "Refusing to start real QA: port $Port is already owned by unmanaged PID(s) $Owners."
    }

    # Teardown must have changed the only permitted pre-state (our exact idle
    # daemon) into the other permitted state (typed daemon-not-running).
    Assert-RealDaemonSafeForReplacement `
        -Executable $BuiltExe `
        -RecordPath $RecordPath `
        -Phase "post-teardown absence proof"

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
        launch_reason = $LaunchReason
        source_graph_sha256 = $SourceGraphHash
        studio_input_sha256 = $StudioInputHash
        zone_producer_sha256 = $ZoneProducerHash
        asset_graph_sha256 = $AssetGraphHash
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
        $Probe = Invoke-KsxDaemonStatusProbe -Executable $RuntimeExe
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
            $IdleProbe = Invoke-KsxDaemonStatusProbe -Executable $RuntimeExe
            if ($IdleProbe.exit_code -ne 0 -or -not $IdleProbe.payload -or
                -not [bool]$IdleProbe.payload.ok -or
                [string]$IdleProbe.payload.run -ne "stopped") {
                $IdleDetail = if ($IdleProbe.text) { $IdleProbe.text } else { "no typed daemon response" }
                throw "managed development replacement did not remain idle: $IdleDetail"
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
    Write-Host "Build graph: source $($SourceGraphHash.Substring(0, 12)); assets $($AssetGraphHash.Substring(0, 12)); reason $LaunchReason."
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
    if ($BuildGraphLock) {
        Exit-KsxStudioBuildGraphLock -Lock $BuildGraphLock
    }
    if ($TransitionLockHeld) {
        $TransitionMutex.ReleaseMutex()
    }
    if ($TransitionMutex) {
        $TransitionMutex.Dispose()
    }
}
