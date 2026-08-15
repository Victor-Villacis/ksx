[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $WorkspaceRoot,
    [Parameter(Mandatory = $true)][string] $OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$archiveSha256 = '00145C23D9838BE6089389CE58B3FD2B6766FA9BC0F1F3C60A3C885361B53C34'
$workspace = [IO.Path]::GetFullPath($WorkspaceRoot)
$output = [IO.Path]::GetFullPath($OutputDirectory)
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('ksx-hidmaestro-driver-build-' + [guid]::NewGuid().ToString('N'))
$publishRoot = Join-Path $temporary 'publish'

try {
    [IO.Directory]::CreateDirectory($publishRoot) | Out-Null
    [IO.Directory]::CreateDirectory($output) | Out-Null

    $project = Join-Path $workspace 'tools\hidmaestro-driver-installer\HidMaestroDriverInstaller.csproj'
    & dotnet publish $project -c Release -r win-x64 --self-contained true `
        -p:PublishSingleFile=true -p:PublishTrimmed=false -o $publishRoot 2>&1 |
        ForEach-Object { Write-Host ([string] $_) }
    $publishExitCode = $LASTEXITCODE
    if ($publishExitCode -ne 0) { throw 'The HIDMaestro driver installer publish failed.' }

    $forbidden = @(
        Get-ChildItem -LiteralPath $publishRoot -Recurse -File |
            Where-Object { $_.Name -in @('HIDMaestro.Core.dll', 'Microsoft.Windows.SDK.NET.dll', 'WinRT.Runtime.dll') }
    )
    if ($forbidden.Count -ne 0) {
        throw 'The HIDMaestro driver installer publish unexpectedly contains upstream assemblies.'
    }

    $executable = Join-Path $publishRoot 'ksx-hidmaestro-driver-installer.exe'
    if (!(Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'The HIDMaestro driver installer executable was not produced.' }
    $destination = Join-Path $output 'ksx-hidmaestro-driver-installer.exe'
    Copy-Item -LiteralPath $executable -Destination $destination -Force
    $result = [ordered]@{
        schemaVersion = 1
        upstreamVersion = '1.6.1'
        upstreamArchiveSha256 = $archiveSha256
        distributionMode = 'runtime-hash-pinned-download'
        bundledUpstreamAssemblyCount = 0
        requiresNetworkAtInstall = $true
        executableSha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
    }
    $result | ConvertTo-Json -Compress
}
finally {
    if (Test-Path -LiteralPath $temporary) {
        Remove-Item -LiteralPath $temporary -Recurse -Force
    }
}
