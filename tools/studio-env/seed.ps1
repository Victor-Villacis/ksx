<#
.SYNOPSIS
    Build and start ONE disposable fixture lane: 'seeded' (4476) or
    'first-run' (4520).

.DESCRIPTION
    Builds the macro_fixture example under the machine-wide build-graph lock,
    copies it to a stamped disposable executable, starts it on its assigned
    port, and records a managed process generation that status.ps1 and
    teardown.ps1 validate against.

    Every device, chart, session and saved configuration a fixture serves is
    SYNTHETIC, and the Studio banner says so. That is why this script cannot be
    pointed at 4460: -Environment accepts only the two fixture lanes, and the
    body refuses a second time if a definition's port is 4460 or one of the ten
    Playwright-owned test ports. A fixture answering on the real-hardware port
    would put an invented device list in front of someone about to claim a
    keyboard.

    Stop the lane with teardown.ps1. See tools/studio-env/README.md.

.PARAMETER Environment
    'seeded' -- controllers, mappings and macros already present (UI work and
    screenshots). 'first-run' -- KSX has no saved configuration (onboarding QA).

.PARAMETER SkipBuild
    Reuse the existing fixture build. Legitimate here and refused by
    start-real.ps1: a fixture touches no hardware, so a stale build costs
    nothing but a stale screenshot.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/seed.ps1 -Environment seeded

.LINK
    docs/STUDIO-ENVIRONMENTS.md
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("seeded", "first-run")]
    [string]$Environment,

    [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "build-graph.ps1")
. (Join-Path $PSScriptRoot "source-graph.ps1")

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$RuntimeRoot = Join-Path $RepoRoot "tmp\studio-env"
$BinRoot = Join-Path $RuntimeRoot "bin"
$LogRoot = Join-Path $RuntimeRoot "logs"
$BuildRoot = Join-Path $RepoRoot "target\studio-env-fixture"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
$CopiedExe = Join-Path $BinRoot "macro_fixture-$Environment-$Stamp.exe"

$Definitions = @{
    "seeded" = @{ Port = 4476; Arguments = @(); Label = "seeded demo"; Id = "fixture-seeded-demo" }
    "first-run" = @{ Port = 4520; Arguments = @("--first-run"); Label = "first KSX visit, nothing configured"; Id = "fixture-first-run" }
}
$Definition = $Definitions[$Environment]
$Port = [int]$Definition.Port
$AutomatedTestPorts = @(4478, 4479, 4488, 4489, 4490, 4496, 4500, 4510, 4511, 4512)
if ($Port -eq 4460 -or $AutomatedTestPorts -contains $Port) {
    throw "Fixture environment '$Environment' is assigned reserved live/test port $Port. Correct the environment roster instead of starting it."
}

New-Item -ItemType Directory -Force -Path $BinRoot, $LogRoot | Out-Null

function Write-KsxFixtureRecord {
    param(
        [Parameter(Mandatory = $true)]$Record,
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

$TransitionMutex = $null
try {
    $TransitionMutex = [System.Threading.Mutex]::new(
        $false,
        "Global\KSXStudioEnvironment-$Environment-transition"
    )
} catch [System.UnauthorizedAccessException] {
    throw "The machine-wide '$Environment' transition lock is owned by another Windows identity. Refusing to race that environment."
}
$TransitionLockHeld = $false
$BuildGraphLock = $null
$LocationPushed = $false
try {
    try {
        $TransitionLockHeld = $TransitionMutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
        $TransitionLockHeld = $true
    }
    if (-not $TransitionLockHeld) {
        throw "Another process is already building or swapping the '$Environment' Studio environment. Wait for it to finish, then retry."
    }

    Push-Location $RepoRoot
    $LocationPushed = $true

    $BuildReceiptPath = Join-Path $BuildRoot "ksx-fixture-build.json"
    $BuildGraphLock = Enter-KsxStudioBuildGraphLock -Operation "building the '$Environment' fixture"
    try {
        $StudioInputHashBefore = Get-KsxSourceGraphFingerprint -Kind Studio -RepoRoot $RepoRoot
        $ZoneProducerHashBefore = Get-KsxSourceGraphFingerprint -Kind ZoneProducers -RepoRoot $RepoRoot
        $SourceGraphHashBefore = Get-KsxSourceGraphFingerprint -Kind Runtime -RepoRoot $RepoRoot
        $AssetStateBefore = Assert-KsxStudioAssetGraphReady `
            -RepoRoot $RepoRoot `
            -ExpectedStudioInputSha256 $StudioInputHashBefore `
            -ExpectedZoneProducerSha256 $ZoneProducerHashBefore

        # Compile the replacement before disturbing a healthy fixture. The served
        # process runs a timestamped copy, so Windows never locks this build output.
        if (-not $SkipBuild) {
            & cargo build -p ksx-studio --example macro_fixture --target-dir $BuildRoot
            if ($LASTEXITCODE -ne 0) {
                throw "macro_fixture build failed with exit code $LASTEXITCODE"
            }
        }

        # Source editors do not take the build mutex. Re-read both authoring and
        # runtime inputs after Cargo (or the skip-build receipt check window),
        # and revalidate the asset receipt against that final Studio graph.
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
            throw "Studio or runtime source changed while the fixture artifact was being selected. Nothing was served; retry after the source graph settles."
        }
        $StudioInputHash = $StudioInputHashAfter
        $ZoneProducerHash = $ZoneProducerHashAfter
        $SourceGraphHash = $SourceGraphHashAfter
        $AssetState = $AssetStateAfter

        $BuiltExe = Join-Path $BuildRoot "debug\examples\macro_fixture.exe"
        if (-not (Test-Path -LiteralPath $BuiltExe -PathType Leaf)) {
            throw "Fixture executable is missing at $BuiltExe. Run without -SkipBuild first."
        }
        $BuiltExeHash = (Get-FileHash -LiteralPath $BuiltExe -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($SkipBuild) {
            if (-not (Test-Path -LiteralPath $BuildReceiptPath -PathType Leaf)) {
                throw "-SkipBuild has no validated fixture build receipt. Run without -SkipBuild first."
            }
            try {
                $BuildReceipt = Get-Content -LiteralPath $BuildReceiptPath -Raw | ConvertFrom-Json
            } catch {
                throw "The fixture build receipt is unreadable. Run without -SkipBuild first. $($_.Exception.Message)"
            }
            if ([string]$BuildReceipt.source_graph_sha256 -cne $SourceGraphHash -or
                [string]$BuildReceipt.asset_graph_sha256 -cne [string]$AssetState.asset_graph_sha256 -or
                [string]$BuildReceipt.executable_sha256 -cne $BuiltExeHash) {
                throw "-SkipBuild would serve an executable from a different source or asset graph. Run without -SkipBuild."
            }
        } else {
            New-Item -ItemType Directory -Path $BuildRoot -Force | Out-Null
            [ordered]@{
                schema_version = 1
                built_at = (Get-Date).ToUniversalTime().ToString("o")
                source_graph_sha256 = $SourceGraphHash
                studio_input_sha256 = $StudioInputHash
                zone_producer_sha256 = $ZoneProducerHash
                asset_graph_sha256 = [string]$AssetState.asset_graph_sha256
                executable_sha256 = $BuiltExeHash
            } | ConvertTo-Json | Set-Content -LiteralPath $BuildReceiptPath -Encoding utf8
        }

        # Copy while the shared graph lock still pins the build output selected
        # above. Another fixture lane may compile to the same Cargo target as
        # soon as this lock is released, so the served copy must already exist
        # and prove the exact selected hash before then.
        Copy-Item -LiteralPath $BuiltExe -Destination $CopiedExe
        $CopiedExeHash = (Get-FileHash -LiteralPath $CopiedExe -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($CopiedExeHash -cne $BuiltExeHash) {
            throw "The copied fixture artifact changed while it was selected. Nothing was served."
        }
    } finally {
        Exit-KsxStudioBuildGraphLock -Lock $BuildGraphLock
        $BuildGraphLock = $null
    }

    $Stdout = Join-Path $LogRoot "$Environment-$Stamp.stdout.log"
    $Stderr = Join-Path $LogRoot "$Environment-$Stamp.stderr.log"
    $Generation = "launch-$([Guid]::NewGuid().ToString('N'))"

    # Swap only after the replacement artifact exists. Teardown validates the
    # recorded executable and PID; an unrecorded listener is never killed.
    & (Join-Path $PSScriptRoot "teardown.ps1") -Environment $Environment -AllowMissing
    $Conflicts = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($Conflicts.Count -gt 0) {
        Remove-Item -LiteralPath $CopiedExe -Force -ErrorAction SilentlyContinue
        $Owners = ($Conflicts | Select-Object -ExpandProperty OwningProcess -Unique) -join ", "
        throw "Refusing to start ${Environment}: port $Port is already owned by unmanaged PID(s) $Owners."
    }

    $Arguments = @([string]$Port) + @($Definition.Arguments) + @("--generation=$Generation")
    $Process = $null
    $RecordPath = Join-Path $RuntimeRoot "$Environment.json"
    try {
        $Process = Start-Process -FilePath $CopiedExe `
            -ArgumentList $Arguments `
            -WorkingDirectory $RepoRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput $Stdout `
            -RedirectStandardError $Stderr `
            -PassThru
        # Force the native process handle while this is unquestionably the
        # child we just launched. Failure cleanup must never reopen a numeric
        # PID after Windows may have reused it.
        $null = $Process.Handle
        $CreationTime = $Process.StartTime.ToUniversalTime().ToString("o")
        $Record = [ordered]@{
            schema_version = 2
            launch_id = $Generation
            state = "starting"
            environment = $Environment
            kind = "fixture"
            label = $Definition.Label
            port = $Port
            process_id = $Process.Id
            executable = $CopiedExe
            processes = @([ordered]@{
                role = "studio"
                process_id = $Process.Id
                executable = $CopiedExe
                creation_time_utc = $CreationTime
            })
            stdout = $Stdout
            stderr = $Stderr
            started_at = (Get-Date).ToString("o")
            environment_id = [string]$Definition.Id
            generation = $Generation
            artifact_sha256 = $CopiedExeHash
            source_graph_sha256 = $SourceGraphHash
            studio_input_sha256 = $StudioInputHash
            zone_producer_sha256 = $ZoneProducerHash
            asset_graph_sha256 = [string]$AssetState.asset_graph_sha256
        }
        Write-KsxFixtureRecord -Record $Record -Path $RecordPath

        $Ready = $false
        $LastHealthError = "the process has not opened its listener"
        for ($Attempt = 0; $Attempt -lt 80; $Attempt += 1) {
            if ($Process.HasExited) { break }
            try {
                $Listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
                $OwnedListeners = @($Listeners | Where-Object { [int]$_.OwningProcess -eq $Process.Id })
                $ForeignListeners = @($Listeners | Where-Object { [int]$_.OwningProcess -ne $Process.Id })
                if ($ForeignListeners.Count -gt 0) {
                    $Owners = ($ForeignListeners | Select-Object -ExpandProperty OwningProcess -Unique) -join ", "
                    throw "port $Port also has foreign listener PID(s) $Owners"
                }
                if ($OwnedListeners.Count -eq 0) {
                    throw "port $Port is not owned by new PID $($Process.Id)"
                }
                $Response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 1
                if ($Response.StatusCode -ne 200) {
                    throw "health endpoint returned HTTP $($Response.StatusCode)"
                }
                $Payload = $Response.Content | ConvertFrom-Json
                if (-not [bool]$Payload.environment.fixture) {
                    throw "health payload claims live-machine provenance"
                }
                if ([string]$Payload.environment.id -ne [string]$Definition.Id) {
                    throw "health payload environment '$($Payload.environment.id)' is not '$($Definition.Id)'"
                }
                if ([string]$Payload.environment.generation -ne $Generation) {
                    throw "health payload generation '$($Payload.environment.generation)' is not '$Generation'"
                }
                $Ready = $true
                break
            } catch {
                $LastHealthError = $_.Exception.Message
                Start-Sleep -Milliseconds 125
            }
        }
        if (-not $Ready) {
            $ExitDetail = if ($Process.HasExited) { " Process exited with code $($Process.ExitCode)." } else { "" }
            throw "Fixture did not become healthy: $LastHealthError.$ExitDetail Inspect $Stderr"
        }
        $Record.state = "ready"
        Write-KsxFixtureRecord -Record $Record -Path $RecordPath
    } catch {
        $Failure = $_
        # Record-based teardown validates the durable identity first, but it
        # can fail when startup stopped between record states. The retained
        # Process object is an independent rollback layer tied to the original
        # native handle rather than a reusable PID.
        if (Test-Path -LiteralPath $RecordPath -PathType Leaf) {
            try {
                & (Join-Path $PSScriptRoot "teardown.ps1") -Environment $Environment -AllowMissing
            } catch {
                Write-Warning "Fixture startup cleanup could not complete through the managed record: $($_.Exception.Message)"
            }
        }
        $SpawnedProcessGone = $true
        if ($Process) {
            try {
                if (-not $Process.HasExited) { $Process.Kill() }
                if (-not $Process.WaitForExit(10000)) {
                    $SpawnedProcessGone = $false
                    Write-Warning "Fixture startup cleanup timed out waiting for the retained process handle."
                }
            } catch {
                $SpawnedProcessGone = $false
                Write-Warning "Fixture startup cleanup could not stop the retained process handle: $($_.Exception.Message)"
            }
        }
        if ($SpawnedProcessGone -and (Test-Path -LiteralPath $RecordPath -PathType Leaf)) {
            try {
                $FailedRecord = Get-Content -LiteralPath $RecordPath -Raw | ConvertFrom-Json
                if (($FailedRecord.PSObject.Properties.Name -contains "launch_id") -and
                    [string]$FailedRecord.launch_id -ceq $Generation) {
                    Remove-Item -LiteralPath $RecordPath -Force
                }
            } catch {
                Write-Warning "The failed fixture launch's managed record could not be inspected; it was retained. $($_.Exception.Message)"
            }
        }
        if ($SpawnedProcessGone) {
            Remove-Item -LiteralPath $CopiedExe -Force -ErrorAction SilentlyContinue
        }
        throw $Failure
    }

    Write-Host "Seeded $Environment ($($Definition.Label))."
    Write-Host "Open: http://127.0.0.1:$Port/redesign"
    Write-Host "Banner: fixture provenance is embedded by the server."
    Write-Host "Stop it with: tools/studio-env/teardown.ps1 -Environment $Environment"
} finally {
    if ($LocationPushed) {
        Pop-Location
    }
    if ($BuildGraphLock) {
        Exit-KsxStudioBuildGraphLock -Lock $BuildGraphLock
    }
    if ($TransitionLockHeld) {
        $TransitionMutex.ReleaseMutex()
    }
    $TransitionMutex.Dispose()
}
