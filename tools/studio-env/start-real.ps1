[CmdletBinding()]
param(
    [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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

$WinIpac = Get-Process WinIPAC -ErrorAction SilentlyContinue
if ($WinIpac) {
    Write-Warning "WinIPAC is open. KSX can observe keyboard input, but I-PAC chart reads may be blocked until WinIPAC releases MI_02. This script will not close it."
}

$TransitionMutex = [System.Threading.Mutex]::new(
    $false,
    "Local\KSXStudioEnvironment-real-transition"
)
$TransitionLockHeld = $false
$LocationPushed = $false
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
    if (-not $SkipBuild) {
        & cargo build -p ksx-app --features studio --target-dir $BuildRoot
        if ($LASTEXITCODE -ne 0) {
            throw "real Studio build failed with exit code $LASTEXITCODE"
        }
    }

    $BuiltExe = Join-Path $BuildRoot "debug\ksx.exe"
    if (-not (Test-Path -LiteralPath $BuiltExe -PathType Leaf)) {
        throw "Studio-enabled ksx.exe is missing at $BuiltExe. Run without -SkipBuild first."
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

    $Stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
    $CopiedExe = Join-Path $BinRoot "ksx-real-$Stamp.exe"
    Copy-Item -LiteralPath $BuiltExe -Destination $CopiedExe
    $Stdout = Join-Path $LogRoot "real-$Stamp.stdout.log"
    $Stderr = Join-Path $LogRoot "real-$Stamp.stderr.log"

    & (Join-Path $PSScriptRoot "teardown.ps1") -Environment real -AllowMissing
    $Conflicts = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($Conflicts.Count -gt 0) {
        Remove-Item -LiteralPath $CopiedExe -Force -ErrorAction SilentlyContinue
        $Owners = ($Conflicts | Select-Object -ExpandProperty OwningProcess -Unique) -join ", "
        throw "Refusing to start real QA: port $Port is already owned by unmanaged PID(s) $Owners."
    }

    $Process = Start-Process -FilePath $CopiedExe `
        -ArgumentList @("studio", "--port", [string]$Port) `
        -WorkingDirectory $RepoRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $Stdout `
        -RedirectStandardError $Stderr `
        -PassThru

    $Record = [ordered]@{
        environment = "real"
        kind = "live-machine"
        label = "Victor real-hardware QA"
        port = $Port
        process_id = $Process.Id
        executable = $CopiedExe
        stdout = $Stdout
        stderr = $Stderr
        started_at = (Get-Date).ToString("o")
        environment_id = "live-machine"
        generation = ""
    }
    $Record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RuntimeRoot "real.json") -Encoding utf8

    $Ready = $false
    $LastHealthError = "the process has not opened its listener"
    for ($Attempt = 0; $Attempt -lt 160; $Attempt += 1) {
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
            if ([bool]$Payload.environment.fixture) {
                throw "health payload claims fixture provenance"
            }
            if ([string]$Payload.environment.id -ne "live-machine") {
                throw "health payload environment '$($Payload.environment.id)' is not 'live-machine'"
            }
            if (-not [string]::IsNullOrEmpty([string]$Payload.environment.generation)) {
                throw "live-machine health payload unexpectedly carries fixture generation '$($Payload.environment.generation)'"
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
        & (Join-Path $PSScriptRoot "teardown.ps1") -Environment real -AllowMissing
        throw "Real Studio did not become healthy: $LastHealthError.$ExitDetail Inspect $Stderr"
    }

    Write-Host "Started Victor real-hardware QA. No fixture provider is involved."
    Write-Host "Open: http://127.0.0.1:$Port/nocturne"
    Write-Host "Warning: confirmed hardware actions on this instance can affect the selected physical device."
} finally {
    if ($LocationPushed) {
        Pop-Location
    }
    if ($TransitionLockHeld) {
        $TransitionMutex.ReleaseMutex()
    }
    $TransitionMutex.Dispose()
}
