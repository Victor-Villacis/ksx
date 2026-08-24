[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("seeded", "first-run", "blank-encoder")]
    [string]$Environment,

    [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$RuntimeRoot = Join-Path $RepoRoot "tmp\studio-env"
$BinRoot = Join-Path $RuntimeRoot "bin"
$LogRoot = Join-Path $RuntimeRoot "logs"
$BuildRoot = Join-Path $RepoRoot "target\studio-env-fixture"

$Definitions = @{
    "seeded" = @{ Port = 4476; Arguments = @(); Label = "seeded demo"; Id = "fixture-seeded-demo" }
    "first-run" = @{ Port = 4520; Arguments = @("--first-run"); Label = "first-run with preconfigured encoder"; Id = "fixture-first-run" }
    "blank-encoder" = @{ Port = 4521; Arguments = @("--blank-panel"); Label = "first-run with blank encoder chart"; Id = "fixture-blank-encoder" }
}
$Definition = $Definitions[$Environment]
$Port = [int]$Definition.Port
$AutomatedTestPorts = @(4478, 4479, 4488, 4489, 4490, 4496, 4500, 4510, 4511, 4512)
if ($Port -eq 4460 -or $AutomatedTestPorts -contains $Port) {
    throw "Fixture environment '$Environment' is assigned reserved live/test port $Port. Correct the environment roster instead of starting it."
}

New-Item -ItemType Directory -Force -Path $BinRoot, $LogRoot | Out-Null

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

    # Compile the replacement before disturbing a healthy fixture. The served
    # process runs a timestamped copy, so Windows never locks this build output.
    if (-not $SkipBuild) {
        & cargo build -p ksx-studio --example macro_fixture --target-dir $BuildRoot
        if ($LASTEXITCODE -ne 0) {
            throw "macro_fixture build failed with exit code $LASTEXITCODE"
        }
    }

    $BuiltExe = Join-Path $BuildRoot "debug\examples\macro_fixture.exe"
    if (-not (Test-Path -LiteralPath $BuiltExe -PathType Leaf)) {
        throw "Fixture executable is missing at $BuiltExe. Run without -SkipBuild first."
    }

    $Stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
    $CopiedExe = Join-Path $BinRoot "macro_fixture-$Environment-$Stamp.exe"
    Copy-Item -LiteralPath $BuiltExe -Destination $CopiedExe
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
    $Process = Start-Process -FilePath $CopiedExe `
        -ArgumentList $Arguments `
        -WorkingDirectory $RepoRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $Stdout `
        -RedirectStandardError $Stderr `
        -PassThru

    $Record = [ordered]@{
        environment = $Environment
        kind = "fixture"
        label = $Definition.Label
        port = $Port
        process_id = $Process.Id
        executable = $CopiedExe
        stdout = $Stdout
        stderr = $Stderr
        started_at = (Get-Date).ToString("o")
        environment_id = [string]$Definition.Id
        generation = $Generation
    }
    $Record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RuntimeRoot "$Environment.json") -Encoding utf8

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
            $Response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/nocturne" -TimeoutSec 1
            if ($Response.StatusCode -ne 200) {
                throw "health endpoint returned HTTP $($Response.StatusCode)"
            }
            $Payload = $Response.Content | ConvertFrom-Json
            $ExpectedGeneration = $Generation
            if (-not [bool]$Payload.environment.fixture) {
                throw "health payload claims live-machine provenance"
            }
            if ([string]$Payload.environment.id -ne [string]$Definition.Id) {
                throw "health payload environment '$($Payload.environment.id)' is not '$($Definition.Id)'"
            }
            if ([string]$Payload.environment.generation -ne $ExpectedGeneration) {
                throw "health payload generation '$($Payload.environment.generation)' is not '$ExpectedGeneration'"
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
        & (Join-Path $PSScriptRoot "teardown.ps1") -Environment $Environment -AllowMissing
        throw "Fixture did not become healthy: $LastHealthError.$ExitDetail Inspect $Stderr"
    }

    Write-Host "Seeded $Environment ($($Definition.Label))."
    Write-Host "Open: http://127.0.0.1:$Port/nocturne"
    Write-Host "Banner: fixture provenance is embedded by the server."
} finally {
    if ($LocationPushed) {
        Pop-Location
    }
    if ($TransitionLockHeld) {
        $TransitionMutex.ReleaseMutex()
    }
    $TransitionMutex.Dispose()
}
