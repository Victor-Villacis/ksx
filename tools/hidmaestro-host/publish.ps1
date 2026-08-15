[CmdletBinding()]
param(
    [string] $WorkspaceRoot,
    [string] $OutputDirectory
)

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
$commit = '2a0dac0857901a63d365a36dcf99cf50114ca954'
$temp = Join-Path ([IO.Path]::GetTempPath()) ('ksx-hidmaestro-host-' + [Guid]::NewGuid().ToString('N'))
$source = Join-Path $temp 'source'
$publish = Join-Path $temp 'publish'

try {
    New-Item -ItemType Directory -Path $source, $publish, $output -Force | Out-Null
    & git init --quiet $source
    if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the pinned HIDMaestro source checkout.' }
    & git -C $source config core.autocrlf true
    & git -C $source -c protocol.allow=never -c protocol.https.allow=always fetch --quiet --depth=1 `
        https://github.com/hifihedgehog/HIDMaestro.git $commit
    if ($LASTEXITCODE -ne 0) { throw 'Could not fetch the pinned HIDMaestro source commit.' }
    & git -C $source --no-replace-objects checkout --quiet --detach FETCH_HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Could not check out the pinned HIDMaestro source commit.' }
    $actualCommit = (& git -C $source --no-replace-objects rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $actualCommit -cne $commit) {
        throw 'The HIDMaestro source checkout is not the pinned commit.'
    }

    $sourceReceipt = & pwsh -NoProfile -File `
        (Join-Path $workspace 'tools\hidmaestro-runtime-candidate\test-source-contract.ps1') `
        -SourceRoot $source
    if ($LASTEXITCODE -ne 0) { throw 'The pinned HIDMaestro source contract failed.' }
    $profileReceipt = & pwsh -NoProfile -File `
        (Join-Path $workspace 'tools\hidmaestro-runtime-candidate\profiles\verify-profile-catalog.ps1') `
        -SourceRoot $source
    if ($LASTEXITCODE -ne 0) { throw 'The pinned HIDMaestro profile catalog contract failed.' }

    $runtimeContract = Join-Path $PSScriptRoot 'runtime-contract.json'
    $runtimeBytes = [IO.File]::ReadAllBytes($runtimeContract)
    if ($runtimeBytes.Length -ge 3 -and
        $runtimeBytes[0] -eq 0xEF -and
        $runtimeBytes[1] -eq 0xBB -and
        $runtimeBytes[2] -eq 0xBF) {
        throw 'The HIDMaestro runtime contract must be UTF-8 without a BOM.'
    }
    $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
    $runtimeText = $strictUtf8.GetString($runtimeBytes)
    $runtimeText = $runtimeText.Replace("`r`n", "`n")
    if ($runtimeText.Contains("`r")) {
        throw 'The HIDMaestro runtime contract contains a bare carriage return.'
    }
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $runtimeHash = ([BitConverter]::ToString(
            $sha256.ComputeHash($strictUtf8.GetBytes($runtimeText))
        )).Replace('-', '')
    }
    finally {
        $sha256.Dispose()
    }
    if ($runtimeHash -cne '1C49F9CE3F406ED3163935B759EDC35B9B3CBEBD6396A99DDFE3DC9F07E468B0') {
        throw 'The HIDMaestro runtime contract identity changed.'
    }

    & dotnet publish (Join-Path $PSScriptRoot 'HidMaestroHost.csproj') `
        -c Release `
        -r win-x64 `
        --self-contained true `
        -p:PublishAot=true `
        -p:HidMaestroSourceRoot=$source `
        -o $publish
    if ($LASTEXITCODE -ne 0) { throw 'The production HIDMaestro host publish failed.' }

    $exe = Join-Path $publish 'ksx-hidmaestro-host.exe'
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
        throw 'The production HIDMaestro host executable was not produced.'
    }
    Copy-Item -LiteralPath $exe -Destination (Join-Path $output 'ksx-hidmaestro-host.exe') -Force
    $pdb = Join-Path $publish 'ksx-hidmaestro-host.pdb'
    if (Test-Path -LiteralPath $pdb -PathType Leaf) {
        Copy-Item -LiteralPath $pdb -Destination (Join-Path $output 'ksx-hidmaestro-host.pdb') -Force
    }
    [ordered]@{
        schemaVersion = 1
        upstreamCommit = $actualCommit
        runtimeContractSha256 = $runtimeHash
        executableSha256 = (Get-FileHash -LiteralPath (Join-Path $output 'ksx-hidmaestro-host.exe') -Algorithm SHA256).Hash
        sourceContract = ($sourceReceipt -join "`n")
        profileContract = ($profileReceipt -join "`n")
    } | ConvertTo-Json -Depth 5 -Compress
}
finally {
    if (Test-Path -LiteralPath $temp) {
        Remove-Item -LiteralPath $temp -Recurse -Force
    }
}
