[CmdletBinding()]
param(
    # Reuse an already-downloaded archive (CI cache, or a local copy) instead
    # of fetching. It is verified identically either way.
    [string] $ArchivePath
)

# Fetch the pinned official HIDMaestro v1.6.1 release and stage the three
# managed assemblies the SDK-lane host references into sdk-dist\ (gitignored).
#
# Every byte is verified against the same pins the driver installer uses:
# the archive length + SHA-256, then each staged assembly's SHA-256. A
# mismatch deletes the staging and fails — there is no partially-verified
# state to build against.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$archiveUrl = 'https://github.com/hifihedgehog/HIDMaestro/releases/download/v1.6.1/HIDMaestro-v1.6.1.zip'
$archiveLength = 118879222L
$archiveSha256 = '00145C23D9838BE6089389CE58B3FD2B6766FA9BC0F1F3C60A3C885361B53C34'

# entry path inside the archive -> staged name, SHA-256
$assemblies = @(
    @{ Entry = 'HIDMaestro.Core.dll';                       Name = 'HIDMaestro.Core.dll';               Sha256 = 'ADADD9E2604B7B6B047F386EBDD03879FEEF48009C6290281E4C665E2190F6D5' },
    @{ Entry = 'HIDMaestroTest/Microsoft.Windows.SDK.NET.dll'; Name = 'Microsoft.Windows.SDK.NET.dll'; Sha256 = 'C633AB241CD09846C2AA409F0BEE2026962610404A7BF132C75CBD66B0E5A9F4' },
    @{ Entry = 'HIDMaestroTest/WinRT.Runtime.dll';          Name = 'WinRT.Runtime.dll';                 Sha256 = 'BCF3A14E8712A90837FC5C0D8C8A24696AF2BD7F74E9767597EC81EDEDFB23DB' }
)

$dist = Join-Path $PSScriptRoot 'sdk-dist'

# Fast path: everything already staged and exact.
$allPresent = $true
foreach ($assembly in $assemblies) {
    $path = Join-Path $dist $assembly.Name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or
        (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -cne $assembly.Sha256) {
        $allPresent = $false
        break
    }
}
if ($allPresent) {
    Write-Host 'sdk-dist is already staged and pin-exact.'
    exit 0
}

$ownedDownload = $false
if ([string]::IsNullOrWhiteSpace($ArchivePath)) {
    $ArchivePath = Join-Path ([IO.Path]::GetTempPath()) ('ksx-hidmaestro-sdk-' + [Guid]::NewGuid().ToString('N') + '.zip')
    $ownedDownload = $true
    Write-Host "downloading $archiveUrl"
    Invoke-WebRequest -Uri $archiveUrl -OutFile $ArchivePath -UseBasicParsing
}

try {
    $item = Get-Item -LiteralPath $ArchivePath
    if ($item.Length -ne $archiveLength) {
        throw "The HIDMaestro archive is $($item.Length) bytes; the pin requires $archiveLength."
    }
    $actual = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash
    if ($actual -cne $archiveSha256) {
        throw "The HIDMaestro archive hash $actual does not match the pin $archiveSha256."
    }

    if (Test-Path -LiteralPath $dist) {
        Remove-Item -LiteralPath $dist -Recurse -Force
    }
    New-Item -ItemType Directory -Path $dist -Force | Out-Null

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        foreach ($assembly in $assemblies) {
            $entry = $zip.Entries |
                Where-Object { $_.FullName.Replace('\', '/') -ceq $assembly.Entry } |
                Select-Object -First 1
            if ($null -eq $entry) {
                throw "The archive does not contain $($assembly.Entry)."
            }
            $target = Join-Path $dist $assembly.Name
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
            $staged = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
            if ($staged -cne $assembly.Sha256) {
                throw "$($assembly.Name) hashed $staged; the pin requires $($assembly.Sha256)."
            }
            Write-Host "staged $($assembly.Name) ($staged)"
        }
    }
    finally {
        $zip.Dispose()
    }
}
catch {
    if (Test-Path -LiteralPath $dist) {
        Remove-Item -LiteralPath $dist -Recurse -Force
    }
    throw
}
finally {
    if ($ownedDownload -and (Test-Path -LiteralPath $ArchivePath)) {
        Remove-Item -LiteralPath $ArchivePath -Force
    }
}
