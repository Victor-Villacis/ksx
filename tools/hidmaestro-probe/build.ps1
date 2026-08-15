[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SdkDll,

    [string]$DotNet = 'dotnet',

    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'
$toolRoot = $PSScriptRoot
$lock = Get-Content -LiteralPath (Join-Path $toolRoot 'sdk.lock.json') -Raw | ConvertFrom-Json
$resolvedSdkDll = (Resolve-Path -LiteralPath $SdkDll).Path

if ([IO.Path]::GetFileName($resolvedSdkDll) -cne $lock.coreDll.fileName) {
    throw "Expected a file named '$($lock.coreDll.fileName)', got '$resolvedSdkDll'."
}

$actualHash = (Get-FileHash -LiteralPath $resolvedSdkDll -Algorithm SHA256).Hash
if ($actualHash -cne $lock.coreDll.sha256) {
    throw "HIDMaestro.Core.dll SHA-256 mismatch. Expected $($lock.coreDll.sha256), got $actualHash."
}

& (Join-Path $toolRoot 'test-safety.ps1')

& $DotNet build (Join-Path $toolRoot 'HidMaestroProbe.csproj') `
    --configuration $Configuration `
    "-p:HIDMaestroCorePath=$resolvedSdkDll"
exit $LASTEXITCODE
