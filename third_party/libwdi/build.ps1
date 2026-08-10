[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $OutputDirectory,

    [ValidateSet('v142', 'v143')]
    [string] $PlatformToolset = 'v143',

    [ValidatePattern('^14\.[0-9]+\.[0-9]+$')]
    [string] $VCToolsVersion = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Join-Path $root 'msvc\libwdi.vcxproj'
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
$intermediate = Join-Path $output 'obj'

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
    throw "Visual Studio Installer's vswhere.exe was not found at $vswhere"
}

$install = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -property installationPath
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($install)) {
    throw 'No Visual Studio installation with MSBuild was found.'
}
$msbuild = Join-Path $install.Trim() 'MSBuild\Current\Bin\MSBuild.exe'
if (-not (Test-Path -LiteralPath $msbuild -PathType Leaf)) {
    throw "MSBuild was not found at $msbuild"
}

New-Item -ItemType Directory -Path $output -Force | Out-Null
New-Item -ItemType Directory -Path $intermediate -Force | Out-Null

$outProperty = $output.TrimEnd('\') + '\'
$intProperty = $intermediate.TrimEnd('\') + '\'
$arguments = @(
    $project
    '/nologo'
    '/m:1'
    '/t:Rebuild'
    '/p:Configuration=Release'
    '/p:Platform=x64'
    "/p:PlatformToolset=$PlatformToolset"
    "/p:OutDir=$outProperty"
    "/p:IntDir=$intProperty"
    '/p:PreferredToolArchitecture=x64'
    '/verbosity:minimal'
)
if ($VCToolsVersion) {
    $arguments += "/p:VCToolsVersion=$VCToolsVersion"
}
& $msbuild @arguments
if ($LASTEXITCODE -ne 0) {
    throw "libwdi build failed with exit code $LASTEXITCODE"
}

$dll = Join-Path $output 'libwdi.dll'
if (-not (Test-Path -LiteralPath $dll -PathType Leaf)) {
    throw "MSBuild succeeded but did not produce $dll"
}

$hash = (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash
Write-Host "libwdi.dll SHA256 $hash"

& (Join-Path $root 'verify.ps1') -DllPath $dll
if ($LASTEXITCODE -ne 0) {
    throw "libwdi verification failed with exit code $LASTEXITCODE"
}
