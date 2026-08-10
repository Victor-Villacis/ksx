[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $DllPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$dll = [IO.Path]::GetFullPath($DllPath)
if (-not (Test-Path -LiteralPath $dll -PathType Leaf)) {
    throw "libwdi DLL was not found at $dll"
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
    throw "Visual Studio Installer's vswhere.exe was not found at $vswhere"
}
$install = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -property installationPath
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($install)) {
    throw 'No Visual Studio installation with MSBuild was found.'
}
$dumpbin = Get-ChildItem -Path (Join-Path $install.Trim() 'VC\Tools\MSVC') `
    -Filter dumpbin.exe -Recurse |
    Where-Object FullName -Match '\\Hostx64\\x64\\dumpbin\.exe$' |
    Sort-Object FullName -Descending |
    Select-Object -First 1
if ($null -eq $dumpbin) {
    throw 'The x64 dumpbin.exe was not found.'
}

$headers = (& $dumpbin.FullName /nologo /headers $dll | Out-String)
if ($LASTEXITCODE -ne 0 -or $headers -notmatch '(?im)^\s+8664 machine \(x64\)') {
    throw 'libwdi.dll is not an x64 PE image.'
}

$exportsText = (& $dumpbin.FullName /nologo /exports $dll | Out-String)
if ($LASTEXITCODE -ne 0) {
    throw 'dumpbin could not read libwdi exports.'
}
$exports = @(
    $exportsText -split "`r?`n" |
    ForEach-Object {
        if ($_ -match '^\s+\d+\s+[0-9A-F]+\s+[0-9A-F]+\s+(\S+)\s*$') { $Matches[1] }
    }
)
$expectedExports = @('wdi_is_driver_supported', 'wdi_prepare_driver', 'wdi_strerror')
if (($exports.Count -ne $expectedExports.Count) -or
    (Compare-Object ($exports | Sort-Object) ($expectedExports | Sort-Object))) {
    throw "libwdi export surface drifted: $($exports -join ', ')"
}

$importsText = (& $dumpbin.FullName /nologo /imports $dll | Out-String)
if ($LASTEXITCODE -ne 0) {
    throw 'dumpbin could not read libwdi imports.'
}
foreach ($forbiddenImport in @(
    'newdev.dll',
    'setupapi.dll',
    'vcruntime140.dll',
    'vcruntime140_1.dll',
    'msvcp140.dll',
    'ucrtbase.dll'
)) {
    if ($importsText -match "(?im)^\s*$([regex]::Escape($forbiddenImport))\s*$") {
        throw "libwdi has forbidden install/dynamic-runtime import $forbiddenImport"
    }
}

$bytes = [IO.File]::ReadAllBytes($dll)
$ascii = [Text.Encoding]::ASCII.GetString($bytes)
$unicode = [Text.Encoding]::Unicode.GetString($bytes)
foreach ($forbiddenString in @(
    'wdi_install_driver',
    'wdi_create_list',
    'wdi_destroy_list',
    'wdi-simple',
    'Zadig',
    'coinstaller',
    'installer_x',
    'libusb0.sys',
    'libusbK.sys',
    'Windows Driver Kit',
    'C:\Projects\'
)) {
    if ($ascii.IndexOf($forbiddenString, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $unicode.IndexOf($forbiddenString, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        throw "libwdi contains forbidden payload/API/path string '$forbiddenString'"
    }
}

$hash = (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash
Write-Host "Verified x64 prepare-only libwdi.dll SHA256 $hash"
