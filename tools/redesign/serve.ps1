<#
.SYNOPSIS
    Build and serve the redesign lane on 127.0.0.1:4469 from THIS checkout.

.DESCRIPTION
    The transplant rebuild's own lane: a fixture-backed studio server (the
    macro_fixture example, which runs the real Router with synthetic
    providers) on port 4469 — reserved by nothing in studio-env or pwtest —
    so it can run beside the real 4460 lane forever without touching the
    daemon or the hardware.

    Three measured facts shape this script:
    - A DEBUG exe serves assets from the checkout that COMPILED it (rust-embed
      bakes CARGO_MANIFEST_DIR at expansion time), so building here is what
      binds the lane to this worktree's assets — and a running server picks
      up every build-assets.ps1 rebuild per request, no restart needed.
    - Windows locks a running exe, so cargo can never relink it (LNK1104).
      The served process runs a timestamped COPY out of tmp\, like every
      studio-env lane.
    - A private --target-dir keeps this lane's builds from contending with
      pwtest's fixture builds in the shared target\.

.PARAMETER SkipBuild
    Serve the last built exe without rebuilding.

.EXAMPLE
    pwsh -NoProfile -ExecutionPolicy Bypass -File tools/redesign/serve.ps1
#>
[CmdletBinding()]
param(
    [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$Port = 4469
$BuildRoot = Join-Path $RepoRoot "target\studio-env-redesign"
$BinDir = Join-Path $RepoRoot "tmp\studio-env\bin"
$LogDir = Join-Path $RepoRoot "tmp\studio-env\logs"
New-Item -ItemType Directory -Force $BinDir | Out-Null
New-Item -ItemType Directory -Force $LogDir | Out-Null

if (-not $SkipBuild) {
    Push-Location $RepoRoot
    try {
        cargo build -p ksx-studio --example macro_fixture --target-dir $BuildRoot
        if ($LASTEXITCODE -ne 0) { throw "fixture build failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}
$Built = Join-Path $BuildRoot "debug\examples\macro_fixture.exe"
if (-not (Test-Path $Built)) { throw "no built fixture at $Built — run without -SkipBuild" }

# Stop the previous lane process (ours are the only redesign-4469-*.exe).
Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and $_.Path -like (Join-Path $BinDir "redesign-4469-*.exe")
} | ForEach-Object {
    Write-Host "Stopping previous redesign lane (PID $($_.Id))."
    Stop-Process -Id $_.Id -Force
}
Start-Sleep -Milliseconds 300

$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$CopiedExe = Join-Path $BinDir "redesign-4469-$Stamp.exe"
Copy-Item $Built $CopiedExe

$Out = Join-Path $LogDir "redesign-4469-$Stamp.out.log"
$Err = Join-Path $LogDir "redesign-4469-$Stamp.err.log"
$Process = Start-Process -FilePath $CopiedExe -ArgumentList @("$Port") `
    -WorkingDirectory $RepoRoot -PassThru `
    -RedirectStandardOutput $Out -RedirectStandardError $Err

$Deadline = [DateTime]::UtcNow.AddSeconds(30)
$Ready = $false
while ([DateTime]::UtcNow -lt $Deadline) {
    try {
        $res = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/redesign" -UseBasicParsing -TimeoutSec 2
        if ($res.StatusCode -eq 200) { $Ready = $true; break }
    } catch {}
    if ($Process.HasExited) { break }
    Start-Sleep -Milliseconds 250
}
if (-not $Ready) {
    $tail = if (Test-Path $Err) { Get-Content $Err -Tail 5 | Out-String } else { "(no log)" }
    throw "redesign lane never answered on port ${Port}:`n$tail"
}
Write-Host "Redesign lane PID $($Process.Id) (artifact $Stamp)."
Write-Host "Open: http://127.0.0.1:$Port/redesign"
Write-Host "Rebuild assets (tools/studio-env/build-assets.ps1) and the running page follows; rerun this script only for Rust changes."
