[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "build-graph.ps1")
. (Join-Path $PSScriptRoot "source-graph.ps1")

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$StudioRoot = Join-Path $RepoRoot "studio-ui"
$DirtyMarker = Get-KsxStudioAssetsDirtyMarkerPath -RepoRoot $RepoRoot
$AssetStatePath = Get-KsxStudioAssetStatePath -RepoRoot $RepoRoot
$RequiredNodeVersion = "24.19.0"
$RequiredNpmVersion = "11.17.0"
$NodeVersionPinPath = Join-Path $RepoRoot ".node-version"
$script:StudioNodeExecutable = ""

function Resolve-KsxStudioToolchain {
    [CmdletBinding()]
    param()

    $NodeCommand = Get-Command node -ErrorAction SilentlyContinue
    $NpmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $NpmCommand) { $NpmCommand = Get-Command npm -ErrorAction SilentlyContinue }

    $PathNodeVersion = ""
    if ($NodeCommand) {
        $VersionOutput = @(& $NodeCommand.Source --version 2>&1)
        if ($LASTEXITCODE -eq 0) { $PathNodeVersion = ($VersionOutput -join "`n").Trim().TrimStart('v') }
    }
    $PathNpmVersion = ""
    if ($NpmCommand) {
        $VersionOutput = @(& $NpmCommand.Source --version 2>&1)
        if ($LASTEXITCODE -eq 0) { $PathNpmVersion = ($VersionOutput -join "`n").Trim().TrimStart('v') }
    }
    if ($NodeCommand -and $NpmCommand -and
        [string]::Equals($PathNodeVersion, $RequiredNodeVersion, [System.StringComparison]::Ordinal) -and
        [string]::Equals($PathNpmVersion, $RequiredNpmVersion, [System.StringComparison]::Ordinal)) {
        return [pscustomobject]@{
            NodeExecutable = $NodeCommand.Source
            NpmCommand = $NpmCommand.Source
            NpxCommand = ""
            NpxArguments = @()
            ViaNpx = $false
        }
    }

    $NpxCommand = Get-Command npx.cmd -ErrorAction SilentlyContinue
    if (-not $NpxCommand) { $NpxCommand = Get-Command npx -ErrorAction SilentlyContinue }
    if (-not $NpxCommand) {
        throw "Studio assets require Node.js $RequiredNodeVersion and npm $RequiredNpmVersion. PATH has Node '$PathNodeVersion' and npm '$PathNpmVersion', and npx is unavailable to resolve the pinned toolchain."
    }

    $NpxArguments = [string[]]@(
        "--yes",
        "--prefer-offline",
        "--package", "node@$RequiredNodeVersion",
        "--package", "npm@$RequiredNpmVersion",
        "--"
    )
    $VersionOutput = @(& $NpxCommand.Source @NpxArguments node --version 2>&1)
    if ($LASTEXITCODE -ne 0 -or
        -not [string]::Equals(($VersionOutput -join "`n").Trim(), "v$RequiredNodeVersion", [System.StringComparison]::Ordinal)) {
        throw "npx could not resolve the pinned Node.js $RequiredNodeVersion compiler. $($VersionOutput -join ' ')"
    }
    $VersionOutput = @(& $NpxCommand.Source @NpxArguments npm --version 2>&1)
    if ($LASTEXITCODE -ne 0 -or
        -not [string]::Equals(($VersionOutput -join "`n").Trim(), $RequiredNpmVersion, [System.StringComparison]::Ordinal)) {
        throw "npx could not resolve pinned npm $RequiredNpmVersion. $($VersionOutput -join ' ')"
    }
    $ExecutableOutput = @(& $NpxCommand.Source @NpxArguments node --print process.execPath 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "npx resolved Node.js but could not report its executable path. $($ExecutableOutput -join ' ')"
    }
    $NodeExecutable = @($ExecutableOutput | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -Last 1)
    if ($NodeExecutable.Count -ne 1) {
        throw "npx did not return one usable Node.js executable path. $($ExecutableOutput -join ' ')"
    }

    return [pscustomobject]@{
        NodeExecutable = [System.IO.Path]::GetFullPath([string]$NodeExecutable[0])
        NpmCommand = ""
        NpxCommand = $NpxCommand.Source
        NpxArguments = $NpxArguments
        ViaNpx = $true
    }
}

function Invoke-StudioAssetBuild {
    [CmdletBinding()]
    param()

    & $script:StudioNodeExecutable "build.mjs"
    if ($LASTEXITCODE -ne 0) {
        throw "Studio asset build failed with exit code $LASTEXITCODE."
    }
}

$BuildLock = $null
$LocationPushed = $false
$Validated = $false
try {
    $BuildLock = Enter-KsxStudioBuildGraphLock -Operation "regenerating Studio assets"

    # Capture every semantic input before preflight, dependency resolution, or
    # generation. zones.json is a generated output—not an authoring input—so
    # this graph can remain stable while the Rust handoff refreshes it below.
    $StudioInputBefore = Get-KsxSourceGraphFingerprint -Kind Studio -RepoRoot $RepoRoot
    $ZoneProducerBefore = Get-KsxSourceGraphFingerprint -Kind ZoneProducers -RepoRoot $RepoRoot

    $RuntimeRoot = Split-Path -Parent $DirtyMarker
    New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null

    if (-not (Test-Path -LiteralPath $NodeVersionPinPath -PathType Leaf)) {
        throw ".node-version is the authoritative Studio/release Node pin and is missing."
    }
    $PinnedNodeVersion = (Get-Content -LiteralPath $NodeVersionPinPath -Raw).Trim().TrimStart('v')
    if (-not [string]::Equals($PinnedNodeVersion, $RequiredNodeVersion, [System.StringComparison]::Ordinal)) {
        throw ".node-version pins Node.js $PinnedNodeVersion, but the Studio asset contract requires $RequiredNodeVersion. Update the contract and pin together."
    }
    $PackageContract = Get-Content -LiteralPath (Join-Path $StudioRoot "package.json") -Raw | ConvertFrom-Json
    if ([string]$PackageContract.engines.node -cne $RequiredNodeVersion -or
        [string]$PackageContract.engines.npm -cne $RequiredNpmVersion -or
        [string]$PackageContract.packageManager -cne "npm@$RequiredNpmVersion") {
        throw "studio-ui/package.json must pin Node $RequiredNodeVersion and npm $RequiredNpmVersion exactly; npm engine warnings are not an enforcement boundary."
    }
    $Toolchain = Resolve-KsxStudioToolchain
    $script:StudioNodeExecutable = [string]$Toolchain.NodeExecutable
    if (-not (Test-Path -LiteralPath (Join-Path $StudioRoot "package-lock.json") -PathType Leaf)) {
        throw "studio-ui/package-lock.json is missing; refusing a non-reproducible dependency install."
    }

    $DependencySentinels = @(
        (Join-Path $StudioRoot "node_modules\@getforma\build\package.json")
        (Join-Path $StudioRoot "node_modules\@getforma\compiler\package.json")
        (Join-Path $StudioRoot "node_modules\@getforma\core\package.json")
    )
    $PackageLockHash = (Get-FileHash -LiteralPath (Join-Path $StudioRoot "package-lock.json") -Algorithm SHA256).Hash.ToLowerInvariant()
    $DependencyReceipt = "$PackageLockHash|node=$RequiredNodeVersion|npm=$RequiredNpmVersion"
    $InstalledLockHashPath = Join-Path $StudioRoot "node_modules\.ksx-package-lock.sha256"
    $InstalledDependencyReceipt = if (Test-Path -LiteralPath $InstalledLockHashPath -PathType Leaf) {
        (Get-Content -LiteralPath $InstalledLockHashPath -Raw).Trim()
    } else {
        ""
    }
    if (@($DependencySentinels | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }).Count -gt 0 -or
        $InstalledDependencyReceipt -ne $DependencyReceipt) {
        Push-Location $StudioRoot
        $LocationPushed = $true
        if ([bool]$Toolchain.ViaNpx) {
            $PinnedNpxArguments = [string[]]@($Toolchain.NpxArguments)
            & $Toolchain.NpxCommand @PinnedNpxArguments npm ci
        } else {
            & $Toolchain.NpmCommand ci
        }
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci failed with exit code $LASTEXITCODE."
        }
        Set-Content -LiteralPath $InstalledLockHashPath -Value $DependencyReceipt -Encoding ascii
        Pop-Location
        $LocationPushed = $false
    }
    $PackageLockHashAfterInstall = (Get-FileHash -LiteralPath (Join-Path $StudioRoot "package-lock.json") -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not [string]::Equals($PackageLockHash, $PackageLockHashAfterInstall, [System.StringComparison]::Ordinal)) {
        throw "studio-ui/package-lock.json changed while dependencies were being prepared. Run the asset build again against one stable lockfile revision."
    }

    # Preflight failures above do not touch generated outputs. Mark the graph
    # dirty immediately before the first persistent generator (the Rust JSON
    # handoff), and leave the marker in place on every failure after this line.
    [ordered]@{
        operation = "studio-assets"
        process_id = $PID
        started_at = (Get-Date).ToUniversalTime().ToString("o")
        repository = $RepoRoot
    } | ConvertTo-Json | Set-Content -LiteralPath $DirtyMarker -Encoding utf8

    # Rust owns the mappable vocabulary and persona zone geometry. Refresh its
    # committed JSON handoff before Node consumes it so one locked command
    # cannot bless a stale zones.json against newer Rust tables.
    Push-Location $RepoRoot
    $LocationPushed = $true
    & cargo test --locked -p ksx-studio write_generated_zone_tokens_json -- --ignored
    if ($LASTEXITCODE -ne 0) {
        throw "Rust zone-token handoff failed with exit code $LASTEXITCODE."
    }
    Pop-Location
    $LocationPushed = $false
    $ZoneProducerAfter = Get-KsxSourceGraphFingerprint -Kind ZoneProducers -RepoRoot $RepoRoot
    if (-not [string]::Equals($ZoneProducerBefore, $ZoneProducerAfter, [System.StringComparison]::Ordinal)) {
        throw "Rust zone producers changed while tokens/zones.json was being generated. Run the asset build again against one stable source revision."
    }

    Push-Location $StudioRoot
    $LocationPushed = $true
    Invoke-StudioAssetBuild
    $FirstSnapshot = @(Get-KsxStudioGeneratedOutputSnapshot -RepoRoot $RepoRoot)
    $FirstGraphHash = Get-KsxStudioGeneratedOutputGraphHash -Snapshot $FirstSnapshot

    Invoke-StudioAssetBuild
    $SecondSnapshot = @(Get-KsxStudioGeneratedOutputSnapshot -RepoRoot $RepoRoot)
    $SecondGraphHash = Get-KsxStudioGeneratedOutputGraphHash -Snapshot $SecondSnapshot

    if (-not [string]::Equals($FirstGraphHash, $SecondGraphHash, [System.StringComparison]::Ordinal)) {
        $Changed = @(Get-KsxStudioGeneratedOutputChanges -Before $FirstSnapshot -After $SecondSnapshot)
        throw "Studio asset build is not deterministic across two consecutive runs. Changed outputs: $($Changed -join ', '). The dirty marker remains at $DirtyMarker."
    }

    $StudioInputAfter = Get-KsxSourceGraphFingerprint -Kind Studio -RepoRoot $RepoRoot
    $ZoneProducerAtReceipt = Get-KsxSourceGraphFingerprint -Kind ZoneProducers -RepoRoot $RepoRoot
    if (-not [string]::Equals($StudioInputBefore, $StudioInputAfter, [System.StringComparison]::Ordinal)) {
        throw "Studio authoring inputs changed while assets were being compiled. Run the asset build again against one stable source revision."
    }
    if (-not [string]::Equals($ZoneProducerAfter, $ZoneProducerAtReceipt, [System.StringComparison]::Ordinal)) {
        throw "Rust zone producers changed after tokens/zones.json was generated. Run the asset build again against one stable source revision."
    }

    # Snapshot once more at the receipt boundary. This is the canonical set
    # Assert-KsxStudioAssetGraphReady will independently re-enumerate and hash.
    $ReceiptSnapshot = @(Get-KsxStudioGeneratedOutputSnapshot -RepoRoot $RepoRoot)
    $AssetGraphHash = Get-KsxStudioGeneratedOutputGraphHash -Snapshot $ReceiptSnapshot
    if (-not [string]::Equals($SecondGraphHash, $AssetGraphHash, [System.StringComparison]::Ordinal)) {
        $Changed = @(Get-KsxStudioGeneratedOutputChanges -Before $SecondSnapshot -After $ReceiptSnapshot)
        throw "Studio generated outputs changed before their receipt could be written. Changed outputs: $($Changed -join ', ')."
    }
    $AssetState = [ordered]@{
        schema_version = 2
        built_at = (Get-Date).ToUniversalTime().ToString("o")
        process_id = $PID
        node_version = $RequiredNodeVersion
        npm_version = $RequiredNpmVersion
        package_lock_sha256 = $PackageLockHash
        zone_producer_sha256 = $ZoneProducerAtReceipt
        studio_input_sha256 = $StudioInputAfter
        asset_graph_sha256 = $AssetGraphHash
        generated_file_count = $ReceiptSnapshot.Count
        generated_files = @($ReceiptSnapshot)
    }
    $AssetStateTemporary = "$AssetStatePath.$PID.tmp"
    try {
        $AssetState | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $AssetStateTemporary -Encoding utf8
        Move-Item -LiteralPath $AssetStateTemporary -Destination $AssetStatePath -Force
    } finally {
        Remove-Item -LiteralPath $AssetStateTemporary -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $DirtyMarker -Force
    $Validated = $true
    Write-Host "Studio assets are deterministic across two consecutive builds ($($ReceiptSnapshot.Count) generated files, graph $($AssetGraphHash.Substring(0, 12)))."
} finally {
    if ($LocationPushed) {
        Pop-Location
    }
    if (-not $Validated -and (Test-Path -LiteralPath $DirtyMarker -PathType Leaf)) {
        Write-Warning "Studio generated outputs may be partial or unverified. The dirty marker remains at $DirtyMarker."
    }
    if ($BuildLock) {
        Exit-KsxStudioBuildGraphLock -Lock $BuildLock
    }
}
