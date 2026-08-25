[CmdletBinding()]
param(
    [string] $WorkspaceRoot,
    [string] $OutputDirectory,
    # Reuse a cached archive for the SDK fetch (CI passes its cache path).
    [string] $ArchivePath
)

# Publish the SDK-lane host. Refuses to build unless the staged SDK bytes and
# this lane's runtime contract match their pins, so a drifted dependency can
# never become a shipped executable.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
    $WorkspaceRoot = Join-Path $PSScriptRoot '..\..'
}
$workspace = [IO.Path]::GetFullPath($WorkspaceRoot)
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $workspace 'target\release'
}
$output = [IO.Path]::GetFullPath($OutputDirectory)

# ── 1. the pinned SDK bytes ─────────────────────────────────────────────
& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'fetch-sdk.ps1') -ArchivePath $ArchivePath
if ($LASTEXITCODE -ne 0) { throw 'The pinned HIDMaestro SDK could not be staged.' }

$sdkDll = Join-Path $PSScriptRoot 'sdk-dist\HIDMaestro.Core.dll'
$sdkHash = (Get-FileHash -LiteralPath $sdkDll -Algorithm SHA256).Hash
if ($sdkHash -cne 'ADADD9E2604B7B6B047F386EBDD03879FEEF48009C6290281E4C665E2190F6D5') {
    throw 'The staged HIDMaestro.Core.dll does not match the pinned v1.6.1 bytes.'
}

# ── 2. this lane's runtime contract ─────────────────────────────────────
$contractPath = Join-Path $PSScriptRoot 'runtime-contract-sdk.json'
$contractBytes = [IO.File]::ReadAllBytes($contractPath)
if ($contractBytes.Length -ge 3 -and
    $contractBytes[0] -eq 0xEF -and $contractBytes[1] -eq 0xBB -and $contractBytes[2] -eq 0xBF) {
    throw 'The SDK-lane runtime contract must be UTF-8 without a BOM.'
}
$strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
$contractText = $strictUtf8.GetString($contractBytes).Replace("`r`n", "`n")
if ($contractText.Contains("`r")) {
    throw 'The SDK-lane runtime contract contains a bare carriage return.'
}
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
    $contractHash = ([BitConverter]::ToString(
        $sha256.ComputeHash($strictUtf8.GetBytes($contractText))
    )).Replace('-', '')
}
finally {
    $sha256.Dispose()
}
if ($contractHash -cne 'EDE64B5F53CB6B8681A66AEFFE4C7C464BC5A37697E8DA160C29B655B60FFE89') {
    throw 'The SDK-lane runtime contract identity changed.'
}

# ── 3. publish ──────────────────────────────────────────────────────────
$publish = Join-Path ([IO.Path]::GetTempPath()) ('ksx-hidmaestro-sdk-host-' + [Guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $publish, $output -Force | Out-Null
    & dotnet publish (Join-Path $PSScriptRoot 'HidMaestroSdkHost.csproj') `
        -c Release `
        -r win-x64 `
        --self-contained true `
        -o $publish 2>&1 | ForEach-Object { Write-Host ([string] $_) }
    if ($LASTEXITCODE -ne 0) { throw 'The SDK-lane host publish failed.' }

    $exe = Join-Path $publish 'ksx-hidmaestro-sdk-host.exe'
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
        throw 'The SDK-lane host executable was not produced.'
    }
    Copy-Item -LiteralPath $exe -Destination (Join-Path $output 'ksx-hidmaestro-sdk-host.exe') -Force
    foreach ($companion in @('Microsoft.Windows.SDK.NET.dll', 'WinRT.Runtime.dll')) {
        $path = Join-Path $publish $companion
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            Copy-Item -LiteralPath $path -Destination (Join-Path $output $companion) -Force
        }
    }

    [ordered]@{
        schemaVersion = 1
        lane = 'pinned-official-sdk'
        sdkAssemblySha256 = $sdkHash
        runtimeContractSha256 = $contractHash
        executableSha256 = (Get-FileHash -LiteralPath (Join-Path $output 'ksx-hidmaestro-sdk-host.exe') -Algorithm SHA256).Hash
    } | ConvertTo-Json -Depth 5 -Compress
}
finally {
    if (Test-Path -LiteralPath $publish) {
        Remove-Item -LiteralPath $publish -Recurse -Force
    }
}
