#Requires -Version 7.4
[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string] $WorkspaceRoot = (Get-Location).Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:Utf8NoBom = [System.Text.UTF8Encoding]::new($false, $true)
$script:Phase = 'initialization'
$script:CleanupRoots = [System.Collections.Generic.List[string]]::new()
$script:ChildEnvironment = $null

function Get-FullPath {
    param([Parameter(Mandatory)][string] $Path)
    return [System.IO.Path]::GetFullPath($Path)
}

function Get-OrdinalSorted {
    param([AllowEmptyCollection()][string[]] $Values)
    $copy = [string[]]@($Values)
    [Array]::Sort($copy, [StringComparer]::Ordinal)
    return ,$copy
}

function Resolve-FirstApplicationPath {
    param(
        [Parameter(Mandatory)][string] $Name,
        [Parameter(Mandatory)][string] $ExpectedFileName
    )
    $applications = @(Get-Command $Name -CommandType Application -All -ErrorAction Stop)
    if ($applications.Count -eq 0) { throw 'A required application was not resolved.' }
    $source = [string]$applications[0].Source
    if ([string]::IsNullOrWhiteSpace($source)) {
        throw 'The first resolved application has no source path.'
    }
    $full = Get-FullPath $source
    if (-not [IO.File]::Exists($full) -or
        [IO.Path]::GetFileName($full) -ine $ExpectedFileName) {
        throw 'The first resolved application path is not the expected executable.'
    }
    if ((Get-Item -LiteralPath $full -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'A resolved application executable is a reparse point.'
    }
    return $full
}

function Assert-ChildPath {
    param(
        [Parameter(Mandatory)][string] $Parent,
        [Parameter(Mandatory)][string] $Child
    )
    $parentFull = (Get-FullPath $Parent).TrimEnd('\') + '\'
    $childFull = Get-FullPath $Child
    if (-not $childFull.StartsWith($parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Path escapes its fixed parent role."
    }
}

function New-FixedDirectory {
    param(
        [Parameter(Mandatory)][string] $RunnerTemp,
        [Parameter(Mandatory)][string] $Name
    )
    if ($Name -notmatch '^[a-z0-9-]+$') { throw 'Temporary role name is invalid.' }
    $path = Get-FullPath (Join-Path $RunnerTemp $Name)
    Assert-ChildPath -Parent $RunnerTemp -Child $path
    if (Test-Path -LiteralPath $path) { throw "Temporary role already exists: $Name" }
    [void][System.IO.Directory]::CreateDirectory($path)
    $script:CleanupRoots.Add($path)
    return $path
}

function Remove-FixedTree {
    param(
        [Parameter(Mandatory)][string] $RunnerTemp,
        [Parameter(Mandatory)][string] $Path
    )
    Assert-ChildPath -Parent $RunnerTemp -Child $Path
    if (-not (Test-Path -LiteralPath $Path)) { return }
    Assert-NoReparsePoints -Root $Path
    Get-ChildItem -LiteralPath $Path -Force -Recurse -ErrorAction SilentlyContinue |
        ForEach-Object {
            if (-not $_.PSIsContainer -and ($_.Attributes -band [IO.FileAttributes]::ReadOnly)) {
                $_.Attributes = $_.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly)
            }
        }
    Remove-Item -LiteralPath $Path -Recurse -Force
}

function Get-RawSha256 {
    param([Parameter(Mandatory)][string] $Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Get-CanonicalTextBytes {
    param([Parameter(Mandatory)][string] $Path)
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $text = $script:Utf8NoBom.GetString($bytes)
    $text = $text.Replace("`r`n", "`n")
    if ($text.IndexOf("`r", [StringComparison]::Ordinal) -ge 0) {
        throw 'Bare carriage return is forbidden in canonical text.'
    }
    return ,$script:Utf8NoBom.GetBytes($text)
}

function Get-NormalizedSha256 {
    param([Parameter(Mandatory)][string] $Path)
    $bytes = Get-CanonicalTextBytes -Path $Path
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))
}

function Get-RelativeUnixPath {
    param(
        [Parameter(Mandatory)][string] $Root,
        [Parameter(Mandatory)][string] $Path
    )
    $relative = [IO.Path]::GetRelativePath((Get-FullPath $Root), (Get-FullPath $Path))
    if ($relative -eq '..' -or $relative.StartsWith('..\', [StringComparison]::Ordinal)) {
        throw 'A path is outside its declared root.'
    }
    return $relative.Replace('\', '/')
}

function Get-FramedTreeSha256 {
    param(
        [Parameter(Mandatory)][string] $Root,
        [Parameter(Mandatory)][string[]] $RelativePaths,
        [Parameter(Mandatory)][ValidateSet('Raw', 'Normalized')] [string] $ByteMode
    )
    $hash = [Security.Cryptography.IncrementalHash]::CreateHash(
        [Security.Cryptography.HashAlgorithmName]::SHA256)
    try {
        foreach ($relative in (Get-OrdinalSorted -Values $RelativePaths)) {
            if ($relative.Contains('\')) { throw 'Framed paths must use forward slashes.' }
            $path = Join-Path $Root ($relative.Replace('/', '\'))
            if (-not [IO.File]::Exists($path)) { throw "Framed input is absent: $relative" }
            $hash.AppendData($script:Utf8NoBom.GetBytes($relative))
            $hash.AppendData([byte[]]@(0))
            $bytes = if ($ByteMode -eq 'Raw') {
                [IO.File]::ReadAllBytes($path)
            } else {
                Get-CanonicalTextBytes -Path $path
            }
            $hash.AppendData($bytes)
            $hash.AppendData([byte[]]@(0))
        }
        return [Convert]::ToHexString($hash.GetHashAndReset())
    } finally {
        $hash.Dispose()
    }
}

function Assert-NoReparsePoints {
    param([Parameter(Mandatory)][string] $Root)
    $rootItem = Get-Item -LiteralPath $Root -Force
    if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'A proof root is a reparse point.'
    }
    $hit = Get-ChildItem -LiteralPath $Root -Force -Recurse |
        Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } |
        Select-Object -First 1
    if ($null -ne $hit) { throw 'A proof tree contains a reparse point.' }
}

function Assert-ExactFileSet {
    param(
        [Parameter(Mandatory)][string] $Root,
        [Parameter(Mandatory)][string[]] $Expected
    )
    Assert-NoReparsePoints -Root $Root
    $actual = Get-OrdinalSorted -Values @(Get-ChildItem -LiteralPath $Root -File -Force -Recurse |
        ForEach-Object { Get-RelativeUnixPath -Root $Root -Path $_.FullName })
    $wanted = Get-OrdinalSorted -Values $Expected
    if ($actual.Count -ne $wanted.Count -or
        [string]::Join("`n", $actual) -cne [string]::Join("`n", $wanted)) {
        throw 'A proof tree has missing or extra files.'
    }
}

function Copy-ExactFile {
    param(
        [Parameter(Mandatory)][string] $Source,
        [Parameter(Mandatory)][string] $Destination,
        [string] $ExpectedRawSha256,
        [string] $ExpectedNormalizedSha256,
        [switch] $WriteCanonicalText
    )
    if ((Get-Item -LiteralPath $Source -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'A staged source is a reparse point.'
    }
    $raw = Get-RawSha256 -Path $Source
    if ($ExpectedRawSha256 -and $raw -cne $ExpectedRawSha256) {
        throw 'A staged source raw hash does not match.'
    }
    if ($ExpectedNormalizedSha256) {
        $normalized = Get-NormalizedSha256 -Path $Source
        if ($normalized -cne $ExpectedNormalizedSha256) {
            throw 'A staged source normalized hash does not match.'
        }
    }
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Destination))
    if ($WriteCanonicalText) {
        [IO.File]::WriteAllBytes($Destination, (Get-CanonicalTextBytes -Path $Source))
    } else {
        [IO.File]::Copy($Source, $Destination, $false)
    }
    $expectedDestinationRaw = if ($WriteCanonicalText) { $ExpectedNormalizedSha256 } else { $raw }
    if ((Get-RawSha256 -Path $Destination) -cne $expectedDestinationRaw) {
        throw 'A staged copy changed raw bytes.'
    }
}

function Invoke-Logged {
    param(
        [Parameter(Mandatory)][string] $File,
        [Parameter(Mandatory)][string[]] $Arguments,
        [Parameter(Mandatory)][string] $WorkingDirectory
    )
    $result = Invoke-IsolatedProcess -File $File -Arguments $Arguments `
        -WorkingDirectory $WorkingDirectory
    foreach ($line in @($result.StandardOutput, $result.StandardError)) {
        if (-not [string]::IsNullOrWhiteSpace($line)) { Write-Host $line.TrimEnd() }
    }
    if ($result.ExitCode -ne 0) {
        throw "External proof step failed with exit code $($result.ExitCode)."
    }
}

function Invoke-Captured {
    param(
        [Parameter(Mandatory)][string] $File,
        [Parameter(Mandatory)][string[]] $Arguments,
        [Parameter(Mandatory)][string] $WorkingDirectory
    )
    $result = Invoke-IsolatedProcess -File $File -Arguments $Arguments `
        -WorkingDirectory $WorkingDirectory
    if ($result.ExitCode -ne 0) {
        foreach ($line in @($result.StandardOutput, $result.StandardError)) {
            if (-not [string]::IsNullOrWhiteSpace($line)) { Write-Host $line.TrimEnd() }
        }
        throw "Captured proof step failed with exit code $($result.ExitCode)."
    }
    if (-not [string]::IsNullOrWhiteSpace($result.StandardError)) {
        Write-Host $result.StandardError.TrimEnd()
    }
    return $result.StandardOutput
}

function Invoke-IsolatedProcess {
    param(
        [Parameter(Mandatory)][string] $File,
        [Parameter(Mandatory)][string[]] $Arguments,
        [Parameter(Mandatory)][string] $WorkingDirectory
    )
    if ($null -eq $script:ChildEnvironment) {
        throw 'The child-process environment was not initialized.'
    }
    $fileFull = Get-FullPath $File
    if (-not [IO.File]::Exists($fileFull)) { throw 'External tool path is absent.' }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $fileFull
    $start.WorkingDirectory = Get-FullPath $WorkingDirectory
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.Environment.Clear()
    foreach ($entry in $script:ChildEnvironment.GetEnumerator()) {
        $start.Environment.Add([string]$entry.Key, [string]$entry.Value)
    }
    foreach ($argument in $Arguments) { $start.ArgumentList.Add([string]$argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'External process did not start.' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            StandardOutput = $stdoutTask.GetAwaiter().GetResult()
            StandardError = $stderrTask.GetAwaiter().GetResult()
        }
    } finally {
        $process.Dispose()
    }
}

function Set-HardenedProcessEnvironment {
    param(
        [Parameter(Mandatory)][string] $DotnetHome,
        [Parameter(Mandatory)][string] $PackagesRoot,
        [Parameter(Mandatory)][string] $NugetCacheRoot,
        [Parameter(Mandatory)][string] $GitGlobalConfig,
        [Parameter(Mandatory)][string] $GitTemplateRoot
    )
    $clearPrefixes = @('COR_', 'CORECLR_', 'DOTNET_', 'MSBUILD', 'NUGET_', 'GIT_')
    foreach ($entry in [Environment]::GetEnvironmentVariables().Keys) {
        $name = [string]$entry
        if ($clearPrefixes | Where-Object { $name.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }) {
            [Environment]::SetEnvironmentVariable($name, $null, 'Process')
        }
    }
    foreach ($name in @(
        'RoslynTargetsPath', 'CSharpCoreTargetsPath', 'CustomBeforeMicrosoftCommonProps',
        'CustomBeforeMicrosoftCommonTargets', 'CustomAfterMicrosoftCommonTargets',
        'CustomBeforeMicrosoftCSharpTargets', 'CustomAfterMicrosoftCSharpTargets',
        'CscToolPath', 'CscToolExe', 'CompilerResponseFile'
    )) {
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
    $values = [ordered]@{
        DOTNET_CLI_HOME = $DotnetHome
        DOTNET_CLI_TELEMETRY_OPTOUT = '1'
        DOTNET_NOLOGO = '1'
        DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
        DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE = '1'
        DOTNET_MULTILEVEL_LOOKUP = '0'
        DOTNET_ROLL_FORWARD = 'Disable'
        NUGET_PACKAGES = $PackagesRoot
        NUGET_HTTP_CACHE_PATH = $NugetCacheRoot
        NUGET_PLUGINS_CACHE_PATH = (Join-Path $NugetCacheRoot 'plugins')
        GIT_CONFIG_NOSYSTEM = '1'
        GIT_CONFIG_GLOBAL = $GitGlobalConfig
        GIT_TERMINAL_PROMPT = '0'
        GIT_ASKPASS = ''
        GIT_TEMPLATE_DIR = $GitTemplateRoot
        GIT_ATTR_NOSYSTEM = '1'
        GIT_PROTOCOL_FROM_USER = '0'
        GIT_OPTIONAL_LOCKS = '0'
    }
    foreach ($property in $values.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($property.Key, [string]$property.Value, 'Process')
    }
}

function Initialize-IsolatedChildEnvironment {
    param(
        [Parameter(Mandatory)][string] $EnvironmentRoot,
        [Parameter(Mandatory)][string] $DotnetPath,
        [Parameter(Mandatory)][string] $GitPath,
        [Parameter(Mandatory)][string] $PwshPath
    )
    $userRoot = Join-Path $EnvironmentRoot 'user-profile'
    $tempRoot = Join-Path $EnvironmentRoot 'child-temp-bootstrap'
    $appData = Join-Path $userRoot 'AppData\Roaming'
    $localAppData = Join-Path $userRoot 'AppData\Local'
    foreach ($path in @($userRoot, $tempRoot, $appData, $localAppData)) {
        [void][IO.Directory]::CreateDirectory($path)
    }
    $systemRoot = [Environment]::GetEnvironmentVariable('SystemRoot', 'Process')
    if ([string]::IsNullOrWhiteSpace($systemRoot)) { throw 'SystemRoot is absent.' }
    $systemDrive = [IO.Path]::GetPathRoot($systemRoot).TrimEnd('\')
    $pwshModules = Join-Path ([IO.Path]::GetDirectoryName($PwshPath)) 'Modules'
    if (-not [IO.Directory]::Exists($pwshModules)) { throw 'Pinned pwsh module root is absent.' }
    $toolDirectories = Get-OrdinalSorted -Values @(
        [IO.Path]::GetDirectoryName($DotnetPath),
        [IO.Path]::GetDirectoryName($GitPath),
        [IO.Path]::GetDirectoryName($PwshPath),
        (Join-Path $systemRoot 'System32')
    )
    $environment = [ordered]@{
        SystemRoot = $systemRoot
        WINDIR = $systemRoot
        SystemDrive = $systemDrive
        ComSpec = (Join-Path $systemRoot 'System32\cmd.exe')
        OS = 'Windows_NT'
        PROCESSOR_ARCHITECTURE = [Environment]::GetEnvironmentVariable(
            'PROCESSOR_ARCHITECTURE', 'Process')
        NUMBER_OF_PROCESSORS = '1'
        PATH = [string]::Join(';', $toolDirectories)
        PATHEXT = '.COM;.EXE;.BAT;.CMD'
        TEMP = $tempRoot
        TMP = $tempRoot
        USERPROFILE = $userRoot
        APPDATA = $appData
        LOCALAPPDATA = $localAppData
        ProgramData = [Environment]::GetEnvironmentVariable('ProgramData', 'Process')
        ProgramFiles = [Environment]::GetEnvironmentVariable('ProgramFiles', 'Process')
        'ProgramFiles(x86)' = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)', 'Process')
        DOTNET_ROOT = [IO.Path]::GetDirectoryName($DotnetPath)
        DOTNET_CLI_HOME = [Environment]::GetEnvironmentVariable('DOTNET_CLI_HOME', 'Process')
        DOTNET_CLI_TELEMETRY_OPTOUT = '1'
        DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE = '1'
        DOTNET_NOLOGO = '1'
        DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
        DOTNET_MULTILEVEL_LOOKUP = '0'
        DOTNET_ROLL_FORWARD = 'Disable'
        NUGET_PACKAGES = [Environment]::GetEnvironmentVariable('NUGET_PACKAGES', 'Process')
        NUGET_HTTP_CACHE_PATH = [Environment]::GetEnvironmentVariable('NUGET_HTTP_CACHE_PATH', 'Process')
        NUGET_PLUGINS_CACHE_PATH = [Environment]::GetEnvironmentVariable('NUGET_PLUGINS_CACHE_PATH', 'Process')
        GIT_CONFIG_NOSYSTEM = '1'
        GIT_CONFIG_GLOBAL = [Environment]::GetEnvironmentVariable('GIT_CONFIG_GLOBAL', 'Process')
        GIT_TERMINAL_PROMPT = '0'
        GIT_ASKPASS = ''
        GIT_TEMPLATE_DIR = [Environment]::GetEnvironmentVariable('GIT_TEMPLATE_DIR', 'Process')
        GIT_ATTR_NOSYSTEM = '1'
        GIT_PROTOCOL_FROM_USER = '0'
        GIT_OPTIONAL_LOCKS = '0'
        POWERSHELL_TELEMETRY_OPTOUT = '1'
        POWERSHELL_UPDATECHECK = 'Off'
        PSModulePath = $pwshModules
    }
    foreach ($entry in $environment.GetEnumerator()) {
        if ($null -eq $entry.Value) { throw "Required child environment value is absent: $($entry.Key)" }
    }
    $script:ChildEnvironment = $environment
}

function Set-IsolatedChildTempRoot {
    param([Parameter(Mandatory)][string] $Path)
    if ($null -eq $script:ChildEnvironment) {
        throw 'The child-process environment was not initialized.'
    }
    $full = Get-FullPath $Path
    if (-not [IO.Directory]::Exists($full)) { throw 'A child TEMP role is absent.' }
    Assert-NoReparsePoints -Root $full
    $script:ChildEnvironment['TEMP'] = $full
    $script:ChildEnvironment['TMP'] = $full
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][AllowEmptyString()][string] $Text
    )
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path))
    [IO.File]::WriteAllText($Path, $Text, $script:Utf8NoBom)
}

function New-NoPackageConfig {
    param([Parameter(Mandatory)][string] $Path)
    Write-Utf8NoBom -Path $Path -Text @'
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
  </packageSources>
  <disabledPackageSources>
    <clear />
  </disabledPackageSources>
</configuration>
'@
}

function New-ExactGlobalJson {
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][string] $SdkVersion
    )
    Write-Utf8NoBom -Path $Path -Text (@{
        sdk = [ordered]@{
            version = $SdkVersion
            rollForward = 'disable'
            allowPrerelease = $false
        }
    } | ConvertTo-Json -Depth 5)
}

function Test-CanonicalProfile {
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][int] $ExpectedLength,
        [Parameter(Mandatory)][string] $ExpectedSha256
    )
    $bytes = Get-CanonicalTextBytes -Path $Path
    if ($bytes.Length -ne $ExpectedLength) { throw 'Profile canonical length mismatch.' }
    $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))
    if ($hash -cne $ExpectedSha256) { throw 'Profile canonical hash mismatch.' }
}

function Stage-ExactCandidate {
    param(
        [Parameter(Mandatory)][string] $Workspace,
        [Parameter(Mandatory)][string] $UpstreamRoot,
        [Parameter(Mandatory)][string] $BuildRoot,
        [Parameter(Mandatory)] $S1dLock,
        [Parameter(Mandatory)] $ProfileLock,
        [Parameter(Mandatory)][string] $RetainedRawSha256
    )
    $candidateRoot = Join-Path $BuildRoot 'candidate'
    [void][IO.Directory]::CreateDirectory($candidateRoot)
    $expectedPaths = [System.Collections.Generic.List[string]]::new()
    foreach ($entry in $S1dLock.candidateFiles) {
        $relative = ([string]$entry.path).Substring('candidate/'.Length)
        $source = Join-Path $Workspace ([string]$entry.path).Replace('/', '\')
        $destination = Join-Path $candidateRoot $relative.Replace('/', '\')
        Copy-ExactFile -Source $source -Destination $destination `
            -ExpectedNormalizedSha256 ([string]$entry.sha256) -WriteCanonicalText
        $expectedPaths.Add($relative)
    }

    $retainedRelative = '.pinned-upstream-v1.6.1/sdk/HIDMaestro.Core/HMOutputPacket.cs'
    $retainedSource = Join-Path $UpstreamRoot 'sdk\HIDMaestro.Core\HMOutputPacket.cs'
    Copy-ExactFile -Source $retainedSource `
        -Destination (Join-Path $candidateRoot $retainedRelative.Replace('/', '\')) `
        -ExpectedRawSha256 $RetainedRawSha256
    $expectedPaths.Add($retainedRelative)

    foreach ($entry in @($ProfileLock.entries | Where-Object classification -eq 'embedded-profile-source')) {
        $sourceRelative = [string]$entry.path
        $source = Join-Path $UpstreamRoot $sourceRelative.Replace('/', '\')
        Test-CanonicalProfile -Path $source `
            -ExpectedLength ([int]$entry.canonicalByteLength) `
            -ExpectedSha256 ([string]$entry.canonicalSha256)
        $stageRelative = '.pinned-upstream-v1.6.1/' + $sourceRelative
        $destination = Join-Path $candidateRoot $stageRelative.Replace('/', '\')
        $raw = Get-RawSha256 -Path $source
        Copy-ExactFile -Source $source -Destination $destination -ExpectedRawSha256 $raw
        $expectedPaths.Add($stageRelative)
    }

    Assert-ExactFileSet -Root $candidateRoot -Expected $expectedPaths.ToArray()
    if ($expectedPaths.Count -ne 241) { throw 'The staged candidate does not contain 241 files.' }
    return [pscustomobject]@{
        Root = $candidateRoot
        RelativePaths = $expectedPaths.ToArray()
        RawTreeSha256 = Get-FramedTreeSha256 -Root $candidateRoot `
            -RelativePaths $expectedPaths.ToArray() -ByteMode Raw
        NormalizedTreeSha256 = Get-FramedTreeSha256 -Root $candidateRoot `
            -RelativePaths $expectedPaths.ToArray() -ByteMode Normalized
    }
}

function Get-RolePath {
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][string] $CandidateRoot,
        [Parameter(Mandatory)][string] $BuildRoot,
        [Parameter(Mandatory)][string] $ObjectRoot,
        [Parameter(Mandatory)][string] $DotnetRoot
    )
    $full = Get-FullPath $Path
    foreach ($role in @(
        [pscustomobject]@{ Name = 'candidate'; Root = $CandidateRoot },
        [pscustomobject]@{ Name = 'build'; Root = $BuildRoot },
        [pscustomobject]@{ Name = 'object'; Root = $ObjectRoot },
        [pscustomobject]@{ Name = 'dotnet'; Root = $DotnetRoot }
    )) {
        $prefix = (Get-FullPath $role.Root).TrimEnd('\') + '\'
        if ($full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            return $role.Name + '/' + (Get-RelativeUnixPath -Root $role.Root -Path $full)
        }
    }
    throw 'An evaluated compiler input is outside its fixed role roots.'
}

function Get-MsbuildProperties {
    param(
        [Parameter(Mandatory)][string] $CandidateRoot,
        [Parameter(Mandatory)][string] $ObjectRoot,
        [Parameter(Mandatory)][string] $OutputRoot,
        [Parameter(Mandatory)][string] $TempRoot,
        [Parameter(Mandatory)][string] $PackagesRoot,
        [Parameter(Mandatory)][string] $NugetConfig
    )
    $pathMap = $CandidateRoot + '=/_/candidate,' +
        $ObjectRoot + '=/_/object,' + $OutputRoot + '=/_/output,' +
        $TempRoot + '=/_/temp'
    return @(
        '-p:Configuration=Release',
        '-p:RuntimeIdentifier=win-x64',
        '-p:PlatformTarget=x64',
        '-p:SelfContained=false',
        '-p:UseAppHost=false',
        '-p:NoConfig=true',
        '-p:Deterministic=true',
        '-p:ContinuousIntegrationBuild=true',
        '-p:DeterministicSourcePaths=true',
        "-p:PathMap=$pathMap",
        '-p:DebugType=portable',
        '-p:DebugSymbols=true',
        '-p:EmbedAllSources=false',
        '-p:EmbedUntrackedSources=false',
        '-p:UseSharedCompilation=false',
        '-p:EnableNETAnalyzers=false',
        '-p:RunAnalyzers=false',
        '-p:RunAnalyzersDuringBuild=false',
        '-p:RunAnalyzersDuringLiveAnalysis=false',
        '-p:GenerateMSBuildEditorConfigFile=false',
        '-p:TreatWarningsAsErrors=true',
        '-p:GenerateDependencyFile=true',
        '-p:AppendTargetFrameworkToOutputPath=false',
        '-p:AppendRuntimeIdentifierToOutputPath=false',
        '-p:EmitCompilerGeneratedFiles=true',
        "-p:CompilerGeneratedFilesOutputPath=$($ObjectRoot.TrimEnd('\'))\generated\",
        '-p:ImportDirectoryBuildProps=false',
        '-p:ImportDirectoryBuildTargets=false',
        '-p:ImportDirectoryPackagesProps=false',
        '-p:ImportDirectoryPackagesTargets=false',
        '-p:CustomBeforeMicrosoftCommonTargets=',
        '-p:CustomAfterMicrosoftCommonTargets=',
        '-p:CustomBeforeMicrosoftCommonProps=',
        '-p:CustomBeforeMicrosoftCSharpTargets=',
        '-p:CustomAfterMicrosoftCSharpTargets=',
        '-p:PreBuildEvent=',
        '-p:PostBuildEvent=',
        '-p:RunPostBuildEvent=Never',
        '-p:DirectoryBuildPropsPath=',
        '-p:DirectoryBuildTargetsPath=',
        '-p:DirectoryPackagesPropsPath=',
        '-p:DirectoryPackagesTargetsPath=',
        '-p:CscToolPath=',
        '-p:CscToolExe=',
        "-p:MSBuildUserExtensionsPath=$($ObjectRoot.TrimEnd('\'))\user-extensions\",
        "-p:BaseIntermediateOutputPath=$($ObjectRoot.TrimEnd('\'))\",
        "-p:IntermediateOutputPath=$($ObjectRoot.TrimEnd('\'))\",
        "-p:MSBuildProjectExtensionsPath=$($ObjectRoot.TrimEnd('\'))\",
        "-p:BaseOutputPath=$($OutputRoot.TrimEnd('\'))\",
        "-p:OutputPath=$($OutputRoot.TrimEnd('\'))\",
        "-p:OutDir=$($OutputRoot.TrimEnd('\'))\",
        "-p:RestorePackagesPath=$PackagesRoot",
        "-p:RestoreConfigFile=$NugetConfig",
        '-p:RestoreSources=',
        '-p:RestoreIgnoreFailedSources=false',
        '-p:RestoreNoCache=true'
        '-p:NuGetAudit=false'
    )
}

function ConvertFrom-MsbuildJson {
    param([Parameter(Mandatory)][string] $Text)
    $start = $Text.IndexOf('{')
    $end = $Text.LastIndexOf('}')
    if ($start -lt 0 -or $end -le $start) { throw 'MSBuild did not emit a JSON evaluation.' }
    $prefix = $Text.Substring(0, $start).Trim()
    $suffix = $Text.Substring($end + 1).Trim()
    if ($prefix.Length -ne 0 -or $suffix.Length -ne 0) {
        throw 'MSBuild evaluation emitted unexpected non-JSON success output.'
    }
    return $Text.Substring($start, $end - $start + 1) | ConvertFrom-Json -Depth 100
}

function Get-XmlExpectedItems {
    param([Parameter(Mandatory)][string] $ProjectPath)
    [xml]$xml = Get-Content -LiteralPath $ProjectPath -Raw
    $compile = Get-OrdinalSorted -Values @($xml.Project.ItemGroup.Compile | ForEach-Object {
        ([string]$_.Include).Replace('\', '/')
    })
    $resources = Get-OrdinalSorted -Values @($xml.Project.ItemGroup.EmbeddedResource | ForEach-Object {
        ([string]$_.Include).Replace('\', '/') + '|logical=' + [string]$_.LogicalName
    })
    return [pscustomobject]@{ Compile = $compile; Resources = $resources }
}

function Get-RoleNormalizedTextSha256 {
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)] $Replacements
    )
    $bytes = [IO.File]::ReadAllBytes($Path)
    $text = $script:Utf8NoBom.GetString($bytes).Replace("`r`n", "`n").Replace("`r", "`n")
    foreach ($entry in $Replacements.GetEnumerator()) {
        $root = (Get-FullPath ([string]$entry.Value)).TrimEnd('\')
        $text = $text.Replace($root, '<' + [string]$entry.Key + '>',
            [StringComparison]::OrdinalIgnoreCase)
        $text = $text.Replace($root.Replace('\', '/'), '<' + [string]$entry.Key + '>',
            [StringComparison]::OrdinalIgnoreCase)
    }
    if ($text -match '(?i)[a-z]:[\\/]' -or $text.Contains('\\')) {
        throw 'A role-normalized generated import retains an absolute filesystem path.'
    }
    $normalized = $script:Utf8NoBom.GetBytes($text)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($normalized))
}

function Get-EvaluatedManifest {
    param(
        [Parameter(Mandatory)][string] $Dotnet,
        [Parameter(Mandatory)][string] $ProjectPath,
        [Parameter(Mandatory)][string] $CandidateRoot,
        [Parameter(Mandatory)][string] $BuildRoot,
        [Parameter(Mandatory)][string] $DotnetRoot,
        [Parameter(Mandatory)][string] $ObjectRoot,
        [Parameter(Mandatory)][string] $OutputRoot,
        [Parameter(Mandatory)][string] $TempRoot,
        [Parameter(Mandatory)][string] $PackagesRoot,
        [Parameter(Mandatory)][string[]] $Properties,
        [Parameter(Mandatory)][string] $ManifestPath
    )
    $arguments = @(
        'msbuild', $ProjectPath,
        '-noAutoResponse', '-nologo', '-verbosity:quiet', '-nodeReuse:false', '-maxcpucount:1',
        '-target:ResolveReferences',
        '-getItem:Compile,EmbeddedResource,ReferencePath,Analyzer,AdditionalFiles,AnalyzerConfigFiles,GlobalAnalyzerConfigFiles,CompilerResponseFile',
        '-getProperty:MSBuildAllProjects,TargetFramework,RuntimeIdentifier,PlatformTarget,SelfContained,UseAppHost,NoConfig,Deterministic,ContinuousIntegrationBuild,PathMap,UseSharedCompilation,EnableNETAnalyzers,RunAnalyzers,RunAnalyzersDuringBuild,RunAnalyzersDuringLiveAnalysis,GenerateAssemblyInfo,GenerateTargetFrameworkAttribute,AllowUnsafeBlocks,AppendTargetFrameworkToOutputPath,AppendRuntimeIdentifierToOutputPath,EmitCompilerGeneratedFiles,CompilerGeneratedFilesOutputPath,ImportDirectoryBuildProps,ImportDirectoryBuildTargets,CustomBeforeMicrosoftCommonProps,CustomBeforeMicrosoftCommonTargets,CustomAfterMicrosoftCommonTargets,CustomBeforeMicrosoftCSharpTargets,CustomAfterMicrosoftCSharpTargets,PreBuildEvent,PostBuildEvent,RunPostBuildEvent,CscToolPath,CscToolExe,RoslynTargetsPath,CSharpCoreTargetsPath,OutDir,TargetDir,TargetPath,TargetName,TargetExt'
    ) + $Properties
    $evaluationText = Invoke-Captured -File $Dotnet -Arguments $arguments `
        -WorkingDirectory $BuildRoot
    $evaluation = ConvertFrom-MsbuildJson -Text $evaluationText
    $expected = Get-XmlExpectedItems -ProjectPath $ProjectPath
    $expectedProperties = [ordered]@{
        TargetFramework = 'net10.0-windows10.0.26100.0'
        RuntimeIdentifier = 'win-x64'
        PlatformTarget = 'x64'
        SelfContained = 'false'
        UseAppHost = 'false'
        NoConfig = 'true'
        Deterministic = 'true'
        ContinuousIntegrationBuild = 'true'
        PathMap = ($CandidateRoot + '=/_/candidate,' +
            $ObjectRoot + '=/_/object,' + $OutputRoot + '=/_/output,' +
            $TempRoot + '=/_/temp')
        UseSharedCompilation = 'false'
        EnableNETAnalyzers = 'false'
        RunAnalyzers = 'false'
        RunAnalyzersDuringBuild = 'false'
        RunAnalyzersDuringLiveAnalysis = 'false'
        GenerateAssemblyInfo = 'false'
        GenerateTargetFrameworkAttribute = 'false'
        AllowUnsafeBlocks = 'false'
        AppendTargetFrameworkToOutputPath = 'false'
        AppendRuntimeIdentifierToOutputPath = 'false'
        EmitCompilerGeneratedFiles = 'true'
        ImportDirectoryBuildProps = 'false'
        ImportDirectoryBuildTargets = 'false'
        CustomBeforeMicrosoftCommonTargets = ''
        CustomAfterMicrosoftCommonTargets = ''
        CustomBeforeMicrosoftCommonProps = ''
        CustomBeforeMicrosoftCSharpTargets = ''
        CustomAfterMicrosoftCSharpTargets = ''
        PreBuildEvent = ''
        PostBuildEvent = ''
        RunPostBuildEvent = 'Never'
        CscToolPath = ''
        CscToolExe = ''
    }
    foreach ($property in $expectedProperties.GetEnumerator()) {
        $actual = [string]$evaluation.Properties.($property.Key)
        if ($actual -cne [string]$property.Value) {
            throw "Evaluated compiler property is not exact: $($property.Key)"
        }
    }
    foreach ($propertyName in @('RoslynTargetsPath', 'CSharpCoreTargetsPath')) {
        $trustedPath = Get-FullPath ([string]$evaluation.Properties.($propertyName))
        $trustedRole = Get-RolePath -Path $trustedPath -CandidateRoot $CandidateRoot `
            -BuildRoot $BuildRoot -ObjectRoot $ObjectRoot -DotnetRoot $DotnetRoot
        if (-not $trustedRole.StartsWith('dotnet/', [StringComparison]::Ordinal)) {
            throw "Compiler target property is outside the pinned dotnet root: $propertyName"
        }
    }
    $expectedTargetPath = Get-FullPath (Join-Path $OutputRoot 'HIDMaestro.Core.dll')
    if (-not (Get-FullPath ([string]$evaluation.Properties.OutDir)).Equals(
            (Get-FullPath $OutputRoot).TrimEnd('\') + '\',
            [StringComparison]::OrdinalIgnoreCase) -or
        -not (Get-FullPath ([string]$evaluation.Properties.TargetDir)).Equals(
            (Get-FullPath $OutputRoot).TrimEnd('\') + '\',
            [StringComparison]::OrdinalIgnoreCase) -or
        -not (Get-FullPath ([string]$evaluation.Properties.TargetPath)).Equals(
            $expectedTargetPath, [StringComparison]::OrdinalIgnoreCase) -or
        [string]$evaluation.Properties.TargetName -cne 'HIDMaestro.Core' -or
        [string]$evaluation.Properties.TargetExt -cne '.dll') {
        throw 'Evaluated target output identity is not exact.'
    }

    $compileItems = Get-OrdinalSorted -Values @($evaluation.Items.Compile | ForEach-Object {
        ([string]$_.Identity).Replace('\', '/')
    })
    if ($compileItems.Count -ne 11 -or
        [string]::Join("`n", $compileItems) -cne [string]::Join("`n", $expected.Compile)) {
        throw 'Evaluated Compile identities are not the exact project list.'
    }

    $resourceItems = Get-OrdinalSorted -Values @($evaluation.Items.EmbeddedResource | ForEach-Object {
        ([string]$_.Identity).Replace('\', '/') + '|logical=' + [string]$_.LogicalName
    })
    if ($resourceItems.Count -ne 228 -or
        [string]::Join("`n", $resourceItems) -cne [string]::Join("`n", $expected.Resources)) {
        throw 'Evaluated EmbeddedResource identities/logical names are not exact.'
    }

    $analyzers = Get-OrdinalSorted -Values @($evaluation.Items.Analyzer | ForEach-Object {
        $full = Get-FullPath ([string]$_.FullPath)
        $rolePath = Get-RolePath -Path $full -CandidateRoot $CandidateRoot -BuildRoot $BuildRoot `
            -ObjectRoot $ObjectRoot -DotnetRoot $DotnetRoot
        if (-not $rolePath.StartsWith('dotnet/', [StringComparison]::Ordinal)) {
            throw 'An Analyzer item is outside the pinned dotnet SDK/reference-pack root.'
        }
        $rolePath + '|sha256=' + (Get-RawSha256 -Path $full)
    })
    if (@($analyzers | Select-Object -Unique).Count -ne $analyzers.Count) {
        throw 'Duplicate Analyzer identities are forbidden.'
    }
    foreach ($itemName in @(
        'AdditionalFiles', 'AnalyzerConfigFiles', 'GlobalAnalyzerConfigFiles',
        'CompilerResponseFile'
    )) {
        if (@($evaluation.Items.($itemName)).Count -ne 0) {
            throw "Unexpected Csc auxiliary input item: $itemName"
        }
    }

    $references = Get-OrdinalSorted -Values @($evaluation.Items.ReferencePath | ForEach-Object {
        $full = Get-FullPath ([string]$_.FullPath)
        $rolePath = Get-RolePath -Path $full -CandidateRoot $CandidateRoot -BuildRoot $BuildRoot `
            -ObjectRoot $ObjectRoot -DotnetRoot $DotnetRoot
        if (-not $rolePath.StartsWith('dotnet/', [StringComparison]::Ordinal)) {
            throw 'ReferencePath contains a non-reference-pack input.'
        }
        $rolePath + '|sha256=' + (Get-RawSha256 -Path $full)
    })
    if (@($references | Select-Object -Unique).Count -ne $references.Count) {
        throw 'Duplicate ReferencePath identities are forbidden.'
    }
    if ($references.Count -eq 0) { throw 'The evaluated reference-pack closure is empty.' }

    $importsList = [Collections.Generic.List[string]]::new()
    $rawImportsList = [Collections.Generic.List[string]]::new()
    foreach ($importPath in ([string]$evaluation.Properties.MSBuildAllProjects).Split(
        ';', [StringSplitOptions]::RemoveEmptyEntries)) {
        $full = Get-FullPath $importPath
        $rolePath = Get-RolePath -Path $full -CandidateRoot $CandidateRoot -BuildRoot $BuildRoot `
            -ObjectRoot $ObjectRoot -DotnetRoot $DotnetRoot
        $rawImportsList.Add($rolePath + '|rawSha256=' + (Get-RawSha256 -Path $full))
        if ($rolePath.StartsWith('object/', [StringComparison]::Ordinal)) {
            $basename = [IO.Path]::GetFileName($full)
            if ($basename -notmatch '^HIDMaestro\.Core\.csproj\.nuget\.g\.(props|targets)$') {
                throw 'An object-role MSBuild import is not an exact generated NuGet props/targets file.'
            }
            $xmlSettings = [Xml.XmlReaderSettings]::new()
            $xmlSettings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
            $xmlSettings.XmlResolver = $null
            $reader = [Xml.XmlReader]::Create($full, $xmlSettings)
            $document = [Xml.XmlDocument]::new()
            $document.XmlResolver = $null
            try { $document.Load($reader) } finally { $reader.Dispose() }
            if ($document.DocumentElement.LocalName -cne 'Project') {
                throw 'A generated NuGet import has an unexpected XML root.'
            }
            $hash = Get-RoleNormalizedTextSha256 -Path $full -Replacements ([ordered]@{
                object = $ObjectRoot
                packages = $PackagesRoot
            })
        } elseif ($rolePath.StartsWith('build/', [StringComparison]::Ordinal)) {
            throw 'An unexpected build-role MSBuild import was evaluated.'
        } else {
            $hash = Get-RawSha256 -Path $full
        }
        $importsList.Add($rolePath + '|semanticSha256=' + $hash)
    }
    $imports = Get-OrdinalSorted -Values $importsList.ToArray()
    $rawImports = Get-OrdinalSorted -Values $rawImportsList.ToArray()

    $generatorRoot = Join-Path $ObjectRoot 'generated'
    $generatorFiles = @()
    if (Test-Path -LiteralPath $generatorRoot) {
        Assert-NoReparsePoints -Root $generatorRoot
        $generatorFiles = @(Get-ChildItem -LiteralPath $generatorRoot -Recurse -File -Force)
    }
    if ($generatorFiles.Count -ne 0) {
        throw 'The fixed compiler-generator output root is not empty.'
    }
    $generated = Get-OrdinalSorted -Values @($generatorFiles | ForEach-Object {
        Get-RolePath -Path $_.FullName -CandidateRoot $CandidateRoot -BuildRoot $BuildRoot `
            -ObjectRoot $ObjectRoot -DotnetRoot $DotnetRoot
    })

    $compileInventory = @($compileItems | ForEach-Object {
        $full = Join-Path $CandidateRoot $_.Replace('/', '\')
        'candidate/' + $_ + '|sha256=' + (Get-RawSha256 -Path $full)
    })
    $resourceInventory = @($resourceItems | ForEach-Object {
        $parts = $_.Split('|', 2)
        $full = Join-Path $CandidateRoot $parts[0].Replace('/', '\')
        'candidate/' + $_ + '|rawSha256=' + (Get-RawSha256 -Path $full) +
            '|canonicalSha256=' + (Get-NormalizedSha256 -Path $full)
    })
    $compilerArguments = Get-OrdinalSorted -Values @($expectedProperties.GetEnumerator() | ForEach-Object {
        $value = if ($_.Key -eq 'PathMap') {
            'candidate=>/_/candidate,object=>/_/object,output=>/_/output,temp=>/_/temp'
        } else { [string]$_.Value }
        ([string]$_.Key) + '=' + $value
    })

    $manifest = [ordered]@{
        compileItems = $compileInventory
        embeddedResources = $resourceInventory
        referencePaths = $references
        analyzers = $analyzers
        generatedCompilerSources = $generated
        imports = $imports
        compilerArguments = $compilerArguments
    }
    Write-Utf8NoBom -Path $ManifestPath -Text ($manifest | ConvertTo-Json -Depth 20)
    return [pscustomobject]@{
        Path = $ManifestPath
        Sha256 = Get-RawSha256 -Path $ManifestPath
        Manifest = $manifest
        RawImports = $rawImports
    }
}

function Invoke-CandidateBuild {
    param(
        [Parameter(Mandatory)][string] $Dotnet,
        [Parameter(Mandatory)][string] $BuildRoot,
        [Parameter(Mandatory)][string] $CandidateRoot,
        [Parameter(Mandatory)][string] $ObjectRoot,
        [Parameter(Mandatory)][string] $OutputRoot,
        [Parameter(Mandatory)][string] $TempRoot,
        [Parameter(Mandatory)][string] $PackagesRoot,
        [Parameter(Mandatory)][string] $NugetConfig
    )
    $project = Join-Path $CandidateRoot 'HIDMaestro.Core.csproj'
    $properties = Get-MsbuildProperties -CandidateRoot $CandidateRoot `
        -ObjectRoot $ObjectRoot -OutputRoot $OutputRoot -TempRoot $TempRoot `
        -PackagesRoot $PackagesRoot `
        -NugetConfig $NugetConfig
    $restore = @(
        'msbuild', $project, '-noAutoResponse', '-nologo', '-verbosity:minimal',
        '-nodeReuse:false', '-maxcpucount:1', '-target:Restore'
    ) + $properties
    Invoke-Logged -File $Dotnet -Arguments $restore -WorkingDirectory $BuildRoot
    $assets = Join-Path $ObjectRoot 'project.assets.json'
    if (-not [IO.File]::Exists($assets)) { throw 'No project.assets.json was produced.' }

    $build = @(
        'msbuild', $project, '-noAutoResponse', '-nologo', '-verbosity:minimal',
        '-nodeReuse:false', '-maxcpucount:1', '-target:Build', '-p:Restore=false'
    ) + $properties
    Invoke-Logged -File $Dotnet -Arguments $build -WorkingDirectory $BuildRoot
    return [pscustomobject]@{
        Project = $project
        Properties = $properties
        Assets = $assets
    }
}

function Assert-OutputClosure {
    param(
        [Parameter(Mandatory)][string] $OutputRoot,
        [Parameter(Mandatory)][string[]] $ExpectedBasenames
    )
    Assert-NoReparsePoints -Root $OutputRoot
    $actual = Get-OrdinalSorted -Values @(Get-ChildItem -LiteralPath $OutputRoot -File -Force -Recurse |
        ForEach-Object { Get-RelativeUnixPath -Root $OutputRoot -Path $_.FullName })
    $expected = Get-OrdinalSorted -Values $ExpectedBasenames
    if ($actual.Count -ne $expected.Count -or
        [string]::Join("`n", $actual) -cne [string]::Join("`n", $expected)) {
        throw 'Candidate build output is not the exact three-file closure.'
    }
}

function Get-NoPackageAssetsSemantic {
    param(
        [Parameter(Mandatory)][string] $AssetsPath,
        [Parameter(Mandatory)][string] $PackagesRoot,
        [Parameter(Mandatory)][string] $ObjectRoot,
        [Parameter(Mandatory)][string] $NugetConfig,
        [Parameter(Mandatory)][string] $OutputPath
    )
    $assets = Get-Content -LiteralPath $AssetsPath -Raw | ConvertFrom-Json -Depth 100
    if (@($assets.libraries.PSObject.Properties).Count -ne 0) {
        throw 'project.assets.json contains a library entry.'
    }
    $targetNames = Get-OrdinalSorted -Values @($assets.targets.PSObject.Properties | ForEach-Object {
        if (@($_.Value.PSObject.Properties).Count -ne 0) {
            throw 'project.assets.json target contains a dependency body.'
        }
        [string]$_.Name
    })
    $dependencyGroups = Get-OrdinalSorted -Values @($assets.projectFileDependencyGroups.PSObject.Properties |
        ForEach-Object {
            if (@($_.Value).Count -ne 0) {
                throw 'project.assets.json dependency group is not empty.'
            }
            [string]$_.Name
        })
    $packageFolders = @($assets.packageFolders.PSObject.Properties | ForEach-Object {
        (Get-FullPath ([string]$_.Name)).TrimEnd([char[]]@('\', '/'))
    })
    if ($packageFolders.Count -ne 1 -or
        -not $packageFolders[0].Equals(
            (Get-FullPath $PackagesRoot).TrimEnd([char[]]@('\', '/')),
            [StringComparison]::OrdinalIgnoreCase)) {
        throw 'project.assets.json package folder is not the exact isolated role.'
    }
    $restoreSources = @()
    if ($null -ne $assets.project.restore.PSObject.Properties['sources']) {
        $restoreSources = @($assets.project.restore.sources.PSObject.Properties)
    }
    if ($restoreSources.Count -ne 0) { throw 'Restore source closure is not empty.' }
    $fallbackFolders = if ($null -ne $assets.project.restore.PSObject.Properties['fallbackFolders']) {
        @($assets.project.restore.fallbackFolders)
    } else { @() }
    if ($fallbackFolders.Count -ne 0) { throw 'Restore fallback-folder closure is not empty.' }
    $restore = $assets.project.restore
    if ([string]$restore.projectStyle -cne 'PackageReference') {
        throw 'Restore projectStyle is not PackageReference.'
    }
    if (-not (Get-FullPath ([string]$restore.outputPath)).TrimEnd([char[]]@('\', '/')).Equals(
        (Get-FullPath $ObjectRoot).TrimEnd([char[]]@('\', '/')),
        [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Restore outputPath is not the exact object role.'
    }
    if (-not (Get-FullPath ([string]$restore.packagesPath)).TrimEnd([char[]]@('\', '/')).Equals(
        (Get-FullPath $PackagesRoot).TrimEnd([char[]]@('\', '/')),
        [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Restore packagesPath is not the exact package role.'
    }
    $configPaths = @($restore.configFilePaths | ForEach-Object { Get-FullPath ([string]$_) })
    if ($configPaths.Count -ne 1 -or
        -not $configPaths[0].Equals((Get-FullPath $NugetConfig), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Restore configFilePaths is not the sole fixed NuGet.Config role.'
    }
    foreach ($restoreFramework in $restore.frameworks.PSObject.Properties) {
        if ($null -ne $restoreFramework.Value.PSObject.Properties['projectReferences'] -and
            @($restoreFramework.Value.projectReferences.PSObject.Properties).Count -ne 0) {
            throw 'Restore contains a project reference.'
        }
    }
    if ($null -ne $assets.PSObject.Properties['logs'] -and @($assets.logs).Count -ne 0) {
        throw 'Restore assets contain log errors/warnings.'
    }
    $auditDisabled = $true
    if ($null -ne $restore.PSObject.Properties['restoreAuditProperties'] -and
        $null -ne $restore.restoreAuditProperties.PSObject.Properties['enableAudit']) {
        $auditDisabled = ([string]$restore.restoreAuditProperties.enableAudit -ceq 'false')
    }
    if (-not $auditDisabled) { throw 'NuGet audit was not disabled.' }
    $frameworks = @()
    $frameworkNames = Get-OrdinalSorted -Values @(
        $assets.project.frameworks.PSObject.Properties | ForEach-Object Name)
    foreach ($frameworkName in $frameworkNames) {
        $frameworkValue = $assets.project.frameworks.PSObject.Properties[$frameworkName].Value
        $dependencies = @()
        if ($null -ne $frameworkValue.PSObject.Properties['dependencies']) {
            $dependencies = @($frameworkValue.dependencies.PSObject.Properties | ForEach-Object Name)
        }
        if ($dependencies.Count -ne 0) { throw 'Framework dependency closure is not empty.' }
        $frameworkReferences = @()
        if ($null -ne $frameworkValue.PSObject.Properties['frameworkReferences']) {
            $frameworkReferences = Get-OrdinalSorted -Values @(
                $frameworkValue.frameworkReferences.PSObject.Properties | ForEach-Object Name)
        }
        $frameworks += [ordered]@{
            name = $frameworkName
            frameworkReferences = $frameworkReferences
        }
    }
    if (@(Get-ChildItem -LiteralPath $PackagesRoot -Force -Recurse).Count -ne 0) {
        throw 'The isolated package root is not empty.'
    }
    $semantic = [ordered]@{
        version = [int]$assets.version
        targetNames = $targetNames
        dependencyGroups = $dependencyGroups
        libraries = @()
        packageFolderRole = 'isolated-empty-packages'
        restoreOutputRole = 'isolated-object'
        restoreConfigRole = 'fixed-empty-nuget-config'
        projectStyle = 'PackageReference'
        auditDisabled = $auditDisabled
        restoreSources = @()
        fallbackFolders = @()
        frameworks = $frameworks
    }
    Write-Utf8NoBom -Path $OutputPath -Text ($semantic | ConvertTo-Json -Depth 20)
    return [pscustomobject]@{
        Path = $OutputPath
        Sha256 = Get-RawSha256 -Path $OutputPath
    }
}

function Assert-InspectorHostClosure {
    param(
        [Parameter(Mandatory)][string] $OutputRoot,
        [Parameter(Mandatory)][string] $ExpectedFrameworkVersion
    )
    Assert-OutputClosure -OutputRoot $OutputRoot -ExpectedBasenames @(
        'KSX.HIDMaestro.ArtifactInspector.deps.json',
        'KSX.HIDMaestro.ArtifactInspector.dll',
        'KSX.HIDMaestro.ArtifactInspector.pdb',
        'KSX.HIDMaestro.ArtifactInspector.runtimeconfig.json'
    )
    $depsPath = Join-Path $OutputRoot 'KSX.HIDMaestro.ArtifactInspector.deps.json'
    $runtimePath = Join-Path $OutputRoot 'KSX.HIDMaestro.ArtifactInspector.runtimeconfig.json'
    $depsText = Get-Content -LiteralPath $depsPath -Raw
    if ($depsText.Contains('HIDMaestro.Core', [StringComparison]::Ordinal)) {
        throw 'The inspector dependency manifest references the candidate assembly.'
    }
    $deps = $depsText | ConvertFrom-Json -Depth 100
    $depsTopLevel = Get-OrdinalSorted -Values @($deps.PSObject.Properties | ForEach-Object Name)
    if ([string]::Join("`n", $depsTopLevel) -cne
        [string]::Join("`n", (Get-OrdinalSorted -Values @(
            'compilationOptions', 'libraries', 'runtimeTarget', 'targets')))) {
        throw 'The inspector dependency manifest top-level shape is not exact.'
    }
    if (@($deps.compilationOptions.PSObject.Properties).Count -ne 0) {
        throw 'The inspector dependency compilation options are not empty.'
    }
    $runtimeTargetShape = Get-OrdinalSorted -Values @(
        $deps.runtimeTarget.PSObject.Properties | ForEach-Object Name)
    if ([string]::Join("`n", $runtimeTargetShape) -cne
        [string]::Join("`n", (Get-OrdinalSorted -Values @('name', 'signature')))) {
        throw 'The inspector dependency runtimeTarget shape is not exact.'
    }
    if ([string]$deps.runtimeTarget.name -cne '.NETCoreApp,Version=v10.0/win-x64' -or
        [string]$deps.runtimeTarget.signature -cne '') {
        throw 'The inspector dependency runtime target is not exact.'
    }
    $libraries = @($deps.libraries.PSObject.Properties)
    $libraryShape = if ($libraries.Count -eq 1) {
        Get-OrdinalSorted -Values @($libraries[0].Value.PSObject.Properties | ForEach-Object Name)
    } else { @() }
    if ($libraries.Count -ne 1 -or
        $libraries[0].Name -cne 'KSX.HIDMaestro.ArtifactInspector/1.0.0' -or
        [string]::Join("`n", $libraryShape) -cne
            [string]::Join("`n", (Get-OrdinalSorted -Values @('serviceable', 'sha512', 'type'))) -or
        [string]$libraries[0].Value.type -cne 'project' -or
        $libraries[0].Value.serviceable -ne $false -or
        [string]$libraries[0].Value.sha512 -cne '') {
        throw 'The inspector dependency manifest is not the sole project identity.'
    }
    $targets = @($deps.targets.PSObject.Properties)
    if ($targets.Count -ne 1 -or
        $targets[0].Name -cne '.NETCoreApp,Version=v10.0/win-x64') {
        throw 'The inspector dependency target set is not exact.'
    }
    $entries = @($targets[0].Value.PSObject.Properties)
    if ($entries.Count -ne 1 -or $entries[0].Name -cne $libraries[0].Name) {
        throw 'The inspector target dependency closure is not exact.'
    }
    $targetBodyNames = Get-OrdinalSorted -Values @(
        $entries[0].Value.PSObject.Properties | ForEach-Object Name)
    if ($targetBodyNames.Count -ne 1 -or $targetBodyNames[0] -cne 'runtime') {
        throw 'The inspector target has dependencies, native/resources/runtimeTargets/compile, or another unsafe key.'
    }
    $runtimeAssets = @($entries[0].Value.runtime.PSObject.Properties)
    if ($runtimeAssets.Count -ne 1 -or
        $runtimeAssets[0].Name -cne 'KSX.HIDMaestro.ArtifactInspector.dll' -or
        [IO.Path]::IsPathRooted($runtimeAssets[0].Name) -or
        $runtimeAssets[0].Name.Contains('/') -or
        $runtimeAssets[0].Name.Contains('\') -or
        $runtimeAssets[0].Name.Contains('..') -or
        @($runtimeAssets[0].Value.PSObject.Properties).Count -ne 0) {
        throw 'The inspector dependency runtime asset is not the sole exact DLL with empty metadata.'
    }
    $runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json -Depth 50
    $runtimeTopLevel = Get-OrdinalSorted -Values @($runtime.PSObject.Properties | ForEach-Object Name)
    $runtimeOptionNames = Get-OrdinalSorted -Values @(
        $runtime.runtimeOptions.PSObject.Properties | ForEach-Object Name)
    $allowedRuntimeOptionNames = @('framework', 'tfm')
    if ($null -ne $runtime.runtimeOptions.PSObject.Properties['configProperties']) {
        $allowedRuntimeOptionNames += 'configProperties'
    }
    if ($runtimeTopLevel.Count -ne 1 -or $runtimeTopLevel[0] -cne 'runtimeOptions' -or
        [string]::Join("`n", $runtimeOptionNames) -cne
            [string]::Join("`n", (Get-OrdinalSorted -Values $allowedRuntimeOptionNames))) {
        throw 'The inspector runtimeconfig top-level/options shape is not exact.'
    }
    $frameworkShape = Get-OrdinalSorted -Values @(
        $runtime.runtimeOptions.framework.PSObject.Properties | ForEach-Object Name)
    if ([string]::Join("`n", $frameworkShape) -cne
        [string]::Join("`n", (Get-OrdinalSorted -Values @('name', 'version')))) {
        throw 'The inspector runtime framework shape is not exact.'
    }
    if ([string]$runtime.runtimeOptions.tfm -cne 'net10.0' -or
        [string]$runtime.runtimeOptions.framework.name -cne 'Microsoft.NETCore.App' -or
        [string]$runtime.runtimeOptions.framework.version -cne $ExpectedFrameworkVersion) {
        throw 'The inspector runtime framework closure is not exact.'
    }
    foreach ($name in @(
        'additionalProbingPaths', 'includedFrameworks', 'frameworks', 'rollForward',
        'applyPatches', 'rollForwardOnNoCandidateFx', 'additionalProbingPath')) {
        if ($null -ne $runtime.runtimeOptions.PSObject.Properties[$name]) {
            throw "Inspector runtimeconfig contains forbidden host probing: $name"
        }
    }
    if (Test-Path -LiteralPath (Join-Path $OutputRoot 'KSX.HIDMaestro.ArtifactInspector.runtimeconfig.dev.json')) {
        throw 'The inspector emitted a runtimeconfig.dev probing file.'
    }
    $configInventory = [ordered]@{}
    if ($null -ne $runtime.runtimeOptions.PSObject.Properties['configProperties']) {
        $safeConfigProperties = [Collections.Generic.Dictionary[string, string]]::new(
            [StringComparer]::OrdinalIgnoreCase)
        $safeConfigProperties.Add(
            'System.Reflection.Metadata.MetadataUpdater.IsSupported',
            'System.Reflection.Metadata.MetadataUpdater.IsSupported')
        $safeConfigProperties.Add(
            'System.Runtime.Serialization.EnableUnsafeBinaryFormatterSerialization',
            'System.Runtime.Serialization.EnableUnsafeBinaryFormatterSerialization')
        $seenConfigProperties = [Collections.Generic.HashSet[string]]::new(
            [StringComparer]::OrdinalIgnoreCase)
        $configNames = Get-OrdinalSorted -Values @(
            $runtime.runtimeOptions.configProperties.PSObject.Properties | ForEach-Object Name)
        foreach ($name in $configNames) {
            $property = $runtime.runtimeOptions.configProperties.PSObject.Properties[$name]
            $canonicalName = $null
            if (-not $safeConfigProperties.TryGetValue([string]$name, [ref]$canonicalName) -or
                -not $seenConfigProperties.Add([string]$name) -or
                [string]$name -cne $canonicalName -or $property.Value -ne $false) {
                throw 'The inspector runtimeconfig contains an unsafe or non-false config property.'
            }
            $configInventory[[string]$property.Name] = $property.Value
        }
    }
    return [pscustomobject]@{
        runtimeTarget = '.NETCoreApp,Version=v10.0/win-x64'
        frameworkName = 'Microsoft.NETCore.App'
        frameworkVersion = $ExpectedFrameworkVersion
        configProperties = $configInventory
    }
}

$resultData = $null
$failure = $null
$cleanupFailures = [System.Collections.Generic.List[string]]::new()
$runnerTemp = $null
$candidateBuilt = $false
try {
    $script:Phase = 'ci-boundary'
    if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows') {
        throw 'This observation is authorized only inside GitHub Actions on Windows.'
    }
    if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP) -or
        [string]::IsNullOrWhiteSpace($env:GITHUB_WORKSPACE)) {
        throw 'GitHub Actions did not provide fixed workspace/temp roots.'
    }
    $runnerTemp = Get-FullPath $env:RUNNER_TEMP
    $workspace = Get-FullPath $WorkspaceRoot
    if ($workspace -cne (Get-FullPath $env:GITHUB_WORKSPACE)) {
        throw 'WorkspaceRoot must be the exact GITHUB_WORKSPACE.'
    }
    $toolRoot = Join-Path $workspace 'tools\hidmaestro-runtime-candidate'
    $leafRoot = Join-Path $toolRoot 's1_5e'
    $contractPath = Join-Path $leafRoot 'contract.lock.json'
    $s1dPath = Join-Path $toolRoot 's1_5d\contract.lock.json'
    $profilePath = Join-Path $toolRoot 'profiles\catalog.lock.json'
    $apiPath = Join-Path $toolRoot 'api\public-api.contract.json'
    foreach ($path in @($contractPath, $s1dPath, $profilePath, $apiPath)) {
        if (-not [IO.File]::Exists($path)) { throw 'A fixed observation contract is absent.' }
    }
    $contract = Get-Content -LiteralPath $contractPath -Raw | ConvertFrom-Json -Depth 100
    $s1d = Get-Content -LiteralPath $s1dPath -Raw | ConvertFrom-Json -Depth 100
    $profiles = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json -Depth 100
    if ($contract.observationEstablished -ne $false) {
        throw 'The pass-1 source contract must not claim an established observation.'
    }
    foreach ($gate in $contract.gateState.PSObject.Properties) {
        if ($gate.Value -ne $false) { throw 'An aggregate gate is true before observation.' }
    }

    $sourceRoot = New-FixedDirectory -RunnerTemp $runnerTemp -Name 'ksx-hm-s15e-source'
    $buildA = New-FixedDirectory -RunnerTemp $runnerTemp -Name 'ksx-hm-s15e-build-a'
    $buildB = New-FixedDirectory -RunnerTemp $runnerTemp -Name 'ksx-hm-s15e-build-b'
    $objA = New-FixedDirectory -RunnerTemp $runnerTemp -Name 'ksx-hm-s15e-obj-a'
    $objB = New-FixedDirectory -RunnerTemp $runnerTemp -Name 'ksx-hm-s15e-obj-b'
    $outA = New-FixedDirectory -RunnerTemp $runnerTemp -Name 'ksx-hm-s15e-out-a'
    $outB = New-FixedDirectory -RunnerTemp $runnerTemp -Name 'ksx-hm-s15e-out-b'
    $packagesA = New-FixedDirectory -RunnerTemp $runnerTemp -Name 'ksx-hm-s15e-packages-a'
    $packagesB = New-FixedDirectory -RunnerTemp $runnerTemp -Name 'ksx-hm-s15e-packages-b'
    $environmentRoot = New-FixedDirectory -RunnerTemp $runnerTemp -Name 'ksx-hm-s15e-environment'
    $reportRoot = New-FixedDirectory -RunnerTemp $runnerTemp -Name 'ksx-hm-s15e-report'
    $inspectorRoot = New-FixedDirectory -RunnerTemp $runnerTemp -Name 'ksx-hm-s15e-inspector'
    $inspectorObj = New-FixedDirectory -RunnerTemp $runnerTemp -Name 'ksx-hm-s15e-inspector-obj'
    $inspectorOut = New-FixedDirectory -RunnerTemp $runnerTemp -Name 'ksx-hm-s15e-inspector-out'
    $inspectorPackages = New-FixedDirectory -RunnerTemp $runnerTemp -Name 'ksx-hm-s15e-inspector-packages'
    $sourceTemp = New-FixedDirectory -RunnerTemp $runnerTemp -Name 'ksx-hm-s15e-temp-source'
    $tempA = New-FixedDirectory -RunnerTemp $runnerTemp -Name 'ksx-hm-s15e-temp-a'
    $tempB = New-FixedDirectory -RunnerTemp $runnerTemp -Name 'ksx-hm-s15e-temp-b'
    $inspectorTemp = New-FixedDirectory -RunnerTemp $runnerTemp -Name 'ksx-hm-s15e-temp-inspector'

    $gitGlobal = Join-Path $environmentRoot 'git-global.config'
    Write-Utf8NoBom -Path $gitGlobal -Text ''
    $emptyTemplate = Join-Path $environmentRoot 'empty-template'
    $emptyHooks = Join-Path $environmentRoot 'empty-hooks'
    [void][IO.Directory]::CreateDirectory($emptyTemplate)
    [void][IO.Directory]::CreateDirectory($emptyHooks)
    New-ExactGlobalJson -Path (Join-Path $environmentRoot 'global.json') `
        -SdkVersion ([string]$contract.toolchain.dotnetSdk)
    $dotnet = Resolve-FirstApplicationPath -Name 'dotnet' -ExpectedFileName 'dotnet.exe'
    $git = Resolve-FirstApplicationPath -Name 'git' -ExpectedFileName 'git.exe'
    $pwsh = Resolve-FirstApplicationPath -Name 'pwsh' -ExpectedFileName 'pwsh.exe'
    Set-HardenedProcessEnvironment -DotnetHome (Join-Path $environmentRoot 'dotnet-home') `
        -PackagesRoot $inspectorPackages -NugetCacheRoot (Join-Path $environmentRoot 'nuget-cache') `
        -GitGlobalConfig $gitGlobal -GitTemplateRoot $emptyTemplate
    [void][IO.Directory]::CreateDirectory($env:DOTNET_CLI_HOME)
    $dotnetRoot = [IO.Path]::GetDirectoryName($dotnet)
    Initialize-IsolatedChildEnvironment -EnvironmentRoot $environmentRoot `
        -DotnetPath $dotnet -GitPath $git -PwshPath $pwsh
    Set-IsolatedChildTempRoot -Path $sourceTemp
    $sdkVersion = (Invoke-Captured -File $dotnet -Arguments @('--version') `
        -WorkingDirectory $environmentRoot).Trim()
    if ($sdkVersion -cne [string]$contract.toolchain.dotnetSdk) {
        throw 'The installed .NET SDK is not the exact pinned version.'
    }

    $nugetA = Join-Path $environmentRoot 'NuGet.A.Config'
    $nugetB = Join-Path $environmentRoot 'NuGet.B.Config'
    $nugetInspector = Join-Path $environmentRoot 'NuGet.Inspector.Config'
    New-NoPackageConfig -Path $nugetA
    New-NoPackageConfig -Path $nugetB
    New-NoPackageConfig -Path $nugetInspector
    New-ExactGlobalJson -Path (Join-Path $buildA 'global.json') -SdkVersion $sdkVersion
    New-ExactGlobalJson -Path (Join-Path $buildB 'global.json') -SdkVersion $sdkVersion
    New-ExactGlobalJson -Path (Join-Path $inspectorRoot 'global.json') -SdkVersion $sdkVersion

    $script:Phase = 'pinned-upstream-checkout'
    Invoke-Logged -File $git -Arguments @('-c', "init.templateDir=$emptyTemplate", 'init', '--quiet', $sourceRoot) `
        -WorkingDirectory $environmentRoot
    Invoke-Logged -File $git -Arguments @('--no-replace-objects', '-C', $sourceRoot, 'config', 'core.autocrlf', 'true') `
        -WorkingDirectory $environmentRoot
    Invoke-Logged -File $git -Arguments @('--no-replace-objects', '-C', $sourceRoot, 'config', 'core.eol', 'crlf') `
        -WorkingDirectory $environmentRoot
    Invoke-Logged -File $git -Arguments @('--no-replace-objects', '-C', $sourceRoot, 'config', 'core.symlinks', 'false') `
        -WorkingDirectory $environmentRoot
    Invoke-Logged -File $git -Arguments @('--no-replace-objects', '-C', $sourceRoot, 'config', 'core.hooksPath', $emptyHooks) `
        -WorkingDirectory $environmentRoot
    Invoke-Logged -File $git -Arguments @('--no-replace-objects', '-C', $sourceRoot, 'remote', 'add', 'origin', [string]$contract.upstream.repository) `
        -WorkingDirectory $environmentRoot
    Invoke-Logged -File $git -Arguments @(
        '--no-replace-objects', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
        '-C', $sourceRoot, 'fetch', '--quiet', '--no-tags', '--depth=1', 'origin',
        [string]$contract.upstream.commit
    ) -WorkingDirectory $environmentRoot
    Invoke-Logged -File $git -Arguments @('--no-replace-objects', '-C', $sourceRoot, 'checkout', '--quiet', '--detach', 'FETCH_HEAD') `
        -WorkingDirectory $environmentRoot
    $checkoutCommit = (Invoke-Captured -File $git -Arguments @('--no-replace-objects', '-C', $sourceRoot, 'rev-parse', 'HEAD') `
        -WorkingDirectory $environmentRoot).Trim()
    if ($checkoutCommit -cne [string]$contract.upstream.commit) {
        throw 'The upstream checkout commit is not exact.'
    }
    if (Test-Path -LiteralPath (Join-Path $sourceRoot '.gitmodules')) {
        throw 'The pinned checkout unexpectedly contains .gitmodules.'
    }
    $remoteUrl = (Invoke-Captured -File $git -Arguments @('--no-replace-objects', '-C', $sourceRoot, 'remote', 'get-url', 'origin') `
        -WorkingDirectory $environmentRoot).Trim()
    if ($remoteUrl -cne [string]$contract.upstream.repository) { throw 'Git remote URL is not exact.' }
    $stagedIndex = Invoke-Captured -File $git -Arguments @('--no-replace-objects', '-C', $sourceRoot, 'ls-files', '--stage') `
        -WorkingDirectory $environmentRoot
    foreach ($line in @($stagedIndex -split "`r?`n" | Where-Object { $_.Length -ne 0 })) {
        $match = [regex]::Match($line, '^(?<mode>[0-9]{6}) [0-9a-f]{40,64} [0-9]+\t.+$',
            [Text.RegularExpressions.RegexOptions]::CultureInvariant)
        if (-not $match.Success -or @('100644', '100755') -cnotcontains $match.Groups['mode'].Value) {
            throw 'The pinned checkout index contains an unsafe or malformed file mode.'
        }
    }
    $status = Invoke-Captured -File $git -Arguments @('--no-replace-objects', '-C', $sourceRoot, 'status', '--porcelain=v1', '--untracked-files=all') `
        -WorkingDirectory $environmentRoot
    if (-not [string]::IsNullOrWhiteSpace($status)) { throw 'The pinned checkout index/worktree is not clean.' }
    Invoke-Logged -File $git -Arguments @('--no-replace-objects', '-C', $sourceRoot, 'diff', '--no-ext-diff', '--quiet') `
        -WorkingDirectory $environmentRoot
    Invoke-Logged -File $git -Arguments @('--no-replace-objects', '-C', $sourceRoot, 'diff', '--cached', '--no-ext-diff', '--quiet') `
        -WorkingDirectory $environmentRoot
    Assert-NoReparsePoints -Root $sourceRoot

    $script:Phase = 'source-contracts'
    Invoke-Logged -File $pwsh -Arguments @(
        '-NoProfile', '-File', (Join-Path $toolRoot 'test-source-contract.ps1'),
        '-SourceRoot', $sourceRoot
    ) -WorkingDirectory $workspace
    Invoke-Logged -File $pwsh -Arguments @(
        '-NoProfile', '-File', (Join-Path $toolRoot 'api\test-api-contract.ps1'),
        '-SourceRoot', $sourceRoot, '-WorkspaceRoot', $workspace
    ) -WorkingDirectory $workspace
    Invoke-Logged -File $pwsh -Arguments @(
        '-NoProfile', '-File', (Join-Path $toolRoot 'profiles\verify-profile-catalog.ps1'),
        '-SourceRoot', $sourceRoot
    ) -WorkingDirectory $workspace
    Invoke-Logged -File $pwsh -Arguments @(
        '-NoProfile', '-File', (Join-Path $toolRoot 's1_5d\verify-source-candidate.ps1'),
        '-WorkspaceRoot', $workspace
    ) -WorkingDirectory $workspace

    $upstreamSelectedPaths = Get-OrdinalSorted -Values @(
        [string]$contract.sourceCandidate.retainedSourcePath
        @($profiles.entries | Where-Object classification -eq 'embedded-profile-source' |
            ForEach-Object { [string]$_.path })
    )
    if ($upstreamSelectedPaths.Count -ne 229 -or
        @($upstreamSelectedPaths | Select-Object -Unique).Count -ne 229) {
        throw 'The selected upstream input closure is not exactly 229 files.'
    }
    $actualUtf8BomPaths = Get-OrdinalSorted -Values @($upstreamSelectedPaths | Where-Object {
        $bytes = [IO.File]::ReadAllBytes((Join-Path $sourceRoot $_.Replace('/', '\')))
        $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and
            $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    })
    $expectedUtf8BomPaths = Get-OrdinalSorted -Values @(
        $contract.sourceCandidate.upstreamSelectedUtf8BomPaths | ForEach-Object { [string]$_ })
    if ([string]::Join("`n", $actualUtf8BomPaths) -cne
        [string]::Join("`n", $expectedUtf8BomPaths)) {
        throw 'The selected upstream UTF-8 BOM path set is not exact.'
    }
    foreach ($relative in $upstreamSelectedPaths) {
        if (-not [IO.File]::Exists((Join-Path $sourceRoot $relative.Replace('/', '\')))) {
            throw 'A selected upstream file is absent.'
        }
    }
    Assert-NoReparsePoints -Root $sourceRoot
    $upstreamPreRaw = Get-FramedTreeSha256 -Root $sourceRoot `
        -RelativePaths $upstreamSelectedPaths -ByteMode Raw
    $upstreamPreNormalized = Get-FramedTreeSha256 -Root $sourceRoot `
        -RelativePaths $upstreamSelectedPaths -ByteMode Normalized

    $script:Phase = 'exact-staging'
    $stageA = Stage-ExactCandidate -Workspace $workspace -UpstreamRoot $sourceRoot `
        -BuildRoot $buildA -S1dLock $s1d -ProfileLock $profiles `
        -RetainedRawSha256 ([string]$contract.sourceCandidate.retainedSourceRawSha256)
    $stageB = Stage-ExactCandidate -Workspace $workspace -UpstreamRoot $sourceRoot `
        -BuildRoot $buildB -S1dLock $s1d -ProfileLock $profiles `
        -RetainedRawSha256 ([string]$contract.sourceCandidate.retainedSourceRawSha256)
    if ($stageA.RawTreeSha256 -cne $stageB.RawTreeSha256 -or
        $stageA.NormalizedTreeSha256 -cne $stageB.NormalizedTreeSha256) {
        throw 'The two isolated staged trees are not byte-identical.'
    }

    $script:Phase = 'isolated-build-a'
    Set-IsolatedChildTempRoot -Path $tempA
    $builtA = Invoke-CandidateBuild -Dotnet $dotnet -BuildRoot $buildA `
        -CandidateRoot $stageA.Root -ObjectRoot $objA -OutputRoot $outA `
        -TempRoot $tempA -PackagesRoot $packagesA -NugetConfig $nugetA
    $candidateBuilt = $true
    $script:Phase = 'isolated-build-b'
    Set-IsolatedChildTempRoot -Path $tempB
    $builtB = Invoke-CandidateBuild -Dotnet $dotnet -BuildRoot $buildB `
        -CandidateRoot $stageB.Root -ObjectRoot $objB -OutputRoot $outB `
        -TempRoot $tempB -PackagesRoot $packagesB -NugetConfig $nugetB

    $expectedOutputs = @($contract.expectedOutputBasenames | ForEach-Object { [string]$_ })
    Assert-OutputClosure -OutputRoot $outA -ExpectedBasenames $expectedOutputs
    Assert-OutputClosure -OutputRoot $outB -ExpectedBasenames $expectedOutputs

    $assetsSemanticA = Get-NoPackageAssetsSemantic -AssetsPath $builtA.Assets `
        -PackagesRoot $packagesA -ObjectRoot $objA -NugetConfig $nugetA `
        -OutputPath (Join-Path $reportRoot 'assets-semantic-a.json')
    $assetsSemanticB = Get-NoPackageAssetsSemantic -AssetsPath $builtB.Assets `
        -PackagesRoot $packagesB -ObjectRoot $objB -NugetConfig $nugetB `
        -OutputPath (Join-Path $reportRoot 'assets-semantic-b.json')
    if ($assetsSemanticA.Sha256 -cne $assetsSemanticB.Sha256) {
        throw 'The sanitized no-package assets semantics differ between builds.'
    }

    $evalAPath = Join-Path $reportRoot 'evaluation-a.json'
    $evalBPath = Join-Path $reportRoot 'evaluation-b.json'
    Set-IsolatedChildTempRoot -Path $tempA
    $evaluationA = Get-EvaluatedManifest -Dotnet $dotnet -ProjectPath $builtA.Project `
        -CandidateRoot $stageA.Root -BuildRoot $buildA -DotnetRoot $dotnetRoot `
        -ObjectRoot $objA -OutputRoot $outA -TempRoot $tempA -PackagesRoot $packagesA `
        -Properties $builtA.Properties -ManifestPath $evalAPath
    Set-IsolatedChildTempRoot -Path $tempB
    $evaluationB = Get-EvaluatedManifest -Dotnet $dotnet -ProjectPath $builtB.Project `
        -CandidateRoot $stageB.Root -BuildRoot $buildB -DotnetRoot $dotnetRoot `
        -ObjectRoot $objB -OutputRoot $outB -TempRoot $tempB -PackagesRoot $packagesB `
        -Properties $builtB.Properties -ManifestPath $evalBPath
    if ($evaluationA.Sha256 -cne $evaluationB.Sha256) {
        throw 'The normalized evaluated compiler-input inventories differ.'
    }

    $postRawA = Get-FramedTreeSha256 -Root $stageA.Root `
        -RelativePaths $stageA.RelativePaths -ByteMode Raw
    $postRawB = Get-FramedTreeSha256 -Root $stageB.Root `
        -RelativePaths $stageB.RelativePaths -ByteMode Raw
    $postNormalizedA = Get-FramedTreeSha256 -Root $stageA.Root `
        -RelativePaths $stageA.RelativePaths -ByteMode Normalized
    $postNormalizedB = Get-FramedTreeSha256 -Root $stageB.Root `
        -RelativePaths $stageB.RelativePaths -ByteMode Normalized
    Assert-ExactFileSet -Root $stageA.Root -Expected $stageA.RelativePaths
    Assert-ExactFileSet -Root $stageB.Root -Expected $stageB.RelativePaths
    if ($postRawA -cne $stageA.RawTreeSha256 -or $postRawB -cne $stageB.RawTreeSha256 -or
        $postNormalizedA -cne $stageA.NormalizedTreeSha256 -or
        $postNormalizedB -cne $stageB.NormalizedTreeSha256) {
        throw 'A quiescent staged input tree changed during build/evaluation.'
    }

    $artifactHashes = [ordered]@{}
    foreach ($name in $expectedOutputs) {
        $hashA = Get-RawSha256 -Path (Join-Path $outA $name)
        $hashB = Get-RawSha256 -Path (Join-Path $outB $name)
        if ($hashA -cne $hashB) { throw "Deterministic A/B mismatch: $name" }
        $lengthA = (Get-Item -LiteralPath (Join-Path $outA $name)).Length
        $lengthB = (Get-Item -LiteralPath (Join-Path $outB $name)).Length
        if ($lengthA -ne $lengthB) { throw "Deterministic A/B length mismatch: $name" }
        $artifactHashes[$name] = [ordered]@{ sha256 = $hashA; byteLength = $lengthA }
    }

    $assetsCopy = Join-Path $reportRoot 'project.assets.a.json'
    $assetsRaw = Get-RawSha256 -Path $builtA.Assets
    Copy-ExactFile -Source $builtA.Assets -Destination $assetsCopy -ExpectedRawSha256 $assetsRaw

    Assert-NoReparsePoints -Root $sourceRoot
    $upstreamPostRaw = Get-FramedTreeSha256 -Root $sourceRoot `
        -RelativePaths $upstreamSelectedPaths -ByteMode Raw
    $upstreamPostNormalized = Get-FramedTreeSha256 -Root $sourceRoot `
        -RelativePaths $upstreamSelectedPaths -ByteMode Normalized
    if ($upstreamPreRaw -cne $upstreamPostRaw -or
        $upstreamPreNormalized -cne $upstreamPostNormalized) {
        throw 'A selected upstream source changed during the observation.'
    }

    $script:Phase = 'source-cleanup-before-inspection'
    foreach ($path in @(
        $sourceRoot, $sourceTemp, $buildA, $buildB, $objA, $objB,
        $packagesA, $packagesB, $tempA, $tempB
    )) {
        Remove-FixedTree -RunnerTemp $runnerTemp -Path $path
    }

    $script:Phase = 'isolated-inspector-build'
    Set-IsolatedChildTempRoot -Path $inspectorTemp
    $inspectorProjectRoot = Join-Path $inspectorRoot 'tools\hidmaestro-runtime-candidate\s1_5e\inspector'
    $managedReaderDestination = Join-Path $inspectorRoot 'tools\hidmaestro-probe\ManagedPeReader.cs'
    foreach ($relative in @(
        'tools/hidmaestro-runtime-candidate/s1_5e/inspector/HIDMaestro.ArtifactInspector.csproj',
        'tools/hidmaestro-runtime-candidate/s1_5e/inspector/Program.cs',
        'tools/hidmaestro-probe/ManagedPeReader.cs'
    )) {
        $source = Join-Path $workspace $relative.Replace('/', '\')
        $locked = @($contract.sourceInputs | Where-Object path -eq $relative)
        if ($locked.Count -ne 1) { throw 'An inspector source input is not uniquely hash-pinned.' }
        $destination = if ($relative -eq 'tools/hidmaestro-probe/ManagedPeReader.cs') {
            $managedReaderDestination
        } else {
            Join-Path $inspectorRoot $relative.Replace('/', '\')
        }
        Copy-ExactFile -Source $source -Destination $destination `
            -ExpectedNormalizedSha256 ([string]$locked[0].sha256) -WriteCanonicalText
    }
    $inspectorProject = Join-Path $inspectorProjectRoot 'HIDMaestro.ArtifactInspector.csproj'
    $inspectorProps = Get-MsbuildProperties -CandidateRoot $inspectorProjectRoot `
        -ObjectRoot $inspectorObj -OutputRoot $inspectorOut -TempRoot $inspectorTemp `
        -PackagesRoot $inspectorPackages `
        -NugetConfig $nugetInspector
    Invoke-Logged -File $dotnet -Arguments (@(
        'msbuild', $inspectorProject, '-noAutoResponse', '-nologo', '-verbosity:minimal',
        '-nodeReuse:false', '-maxcpucount:1', '-target:Restore'
    ) + $inspectorProps) -WorkingDirectory $inspectorRoot
    Invoke-Logged -File $dotnet -Arguments (@(
        'msbuild', $inspectorProject, '-noAutoResponse', '-nologo', '-verbosity:minimal',
        '-nodeReuse:false', '-maxcpucount:1', '-target:Build', '-p:Restore=false'
    ) + $inspectorProps) -WorkingDirectory $inspectorRoot
    $inspectorGeneratedRoot = Join-Path $inspectorObj 'generated'
    if (Test-Path -LiteralPath $inspectorGeneratedRoot) {
        Assert-NoReparsePoints -Root $inspectorGeneratedRoot
        if (@(Get-ChildItem -LiteralPath $inspectorGeneratedRoot -Force -Recurse).Count -ne 0) {
            throw 'The inspector build emitted a compiler-generated file.'
        }
    }
    $inspectorAssetsSemantic = Get-NoPackageAssetsSemantic `
        -AssetsPath (Join-Path $inspectorObj 'project.assets.json') `
        -PackagesRoot $inspectorPackages -ObjectRoot $inspectorObj `
        -NugetConfig $nugetInspector `
        -OutputPath (Join-Path $reportRoot 'inspector-assets-semantic.json')
    $inspectorHost = Assert-InspectorHostClosure -OutputRoot $inspectorOut `
        -ExpectedFrameworkVersion ([string]$contract.toolchain.inspectorRuntimeFrameworkVersion)
    $inspectorDll = Join-Path $inspectorOut 'KSX.HIDMaestro.ArtifactInspector.dll'
    if (-not [IO.File]::Exists($inspectorDll)) { throw 'The dedicated inspector DLL is absent.' }

    $script:Phase = 'byte-only-artifact-inspection'
    foreach ($name in @('DOTNET_STARTUP_HOOKS', 'DOTNET_ADDITIONAL_DEPS', 'DOTNET_SHARED_STORE')) {
        if (-not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($name, 'Process'))) {
            throw 'A CLR host-probing environment variable became populated.'
        }
    }
    Assert-OutputClosure -OutputRoot $outA -ExpectedBasenames $expectedOutputs
    $inspectionPath = Join-Path $reportRoot 'artifact-observation.json'
    Invoke-Logged -File $dotnet -Arguments @(
        $inspectorDll, 'inspect',
        '--artifact', (Join-Path $outA 'HIDMaestro.Core.dll'),
        '--pdb', (Join-Path $outA 'HIDMaestro.Core.pdb'),
        '--deps', (Join-Path $outA 'HIDMaestro.Core.deps.json'),
        '--assets', $assetsCopy,
        '--evaluation', $evalAPath,
        '--contract', $contractPath,
        '--api', $apiPath,
        '--profiles', $profilePath,
        '--output', $inspectionPath
    ) -WorkingDirectory $reportRoot
    $inspection = Get-Content -LiteralPath $inspectionPath -Raw | ConvertFrom-Json -Depth 100
    if ($inspection.ok -ne $true -or $inspection.candidateLoaded -ne $false -or
        $inspection.candidateExecuted -ne $false) {
        throw 'The byte-only artifact observation did not pass.'
    }
    if ([string]$inspection.artifact.sha256 -cne
            [string]$artifactHashes['HIDMaestro.Core.dll'].sha256 -or
        [long]$inspection.artifact.byteLength -ne
            [long]$artifactHashes['HIDMaestro.Core.dll'].byteLength -or
        [string]$inspection.pdbSha256 -cne
            [string]$artifactHashes['HIDMaestro.Core.pdb'].sha256 -or
        [string]$inspection.depsJsonSha256 -cne
            [string]$artifactHashes['HIDMaestro.Core.deps.json'].sha256 -or
        [string]$inspection.assetsJsonSha256 -cne $assetsRaw -or
        [string]$inspection.evaluationJsonSha256 -cne $evaluationA.Sha256) {
        throw 'The same-handle inspector identities are not bound to the selected A build inputs.'
    }
    foreach ($gate in $inspection.gateState.PSObject.Properties) {
        if ($gate.Value -ne $false) { throw 'The observation improperly advanced an aggregate gate.' }
    }

    $resultData = [ordered]@{
        schemaVersion = 1
        ok = $true
        phase = 's1.5e-actions-static-artifact-observation'
        observationEstablished = $true
        actionsRunner = [ordered]@{
            os = 'Windows'
            dotnetSdk = $sdkVersion
            upstreamCommit = $checkoutCommit
            infrastructureNetworkUsedForPinnedFetch = $true
        }
        stage = [ordered]@{
            fileCountPerBuild = 241
            preRawTreeSha256 = $stageA.RawTreeSha256
            postRawTreeSha256 = $postRawA
            preNormalizedTreeSha256 = $stageA.NormalizedTreeSha256
            postNormalizedTreeSha256 = $postNormalizedA
            rootsWereQuiescentAndHashBound = $true
            rootsClaimedImmutable = $false
            upstreamSelectedFileCount = 229
            upstreamPreRawTreeSha256 = $upstreamPreRaw
            upstreamPostRawTreeSha256 = $upstreamPostRaw
            upstreamPreNormalizedTreeSha256 = $upstreamPreNormalized
            upstreamPostNormalizedTreeSha256 = $upstreamPostNormalized
        }
        determinism = [ordered]@{
            buildCount = 2
            evaluatedCompilerInputsSha256 = $evaluationA.Sha256
            noPackageAssetsSemanticSha256 = $assetsSemanticA.Sha256
            exactArtifactByteEquality = $true
            rawImportObservations = [ordered]@{
                buildA = $evaluationA.RawImports
                buildB = $evaluationB.RawImports
            }
            outputs = $artifactHashes
        }
        observation = $inspection
        inspectorHost = $inspectorHost
        inspectorNoPackageAssetsSemanticSha256 = $inspectorAssetsSemantic.Sha256
        candidateBuilt = $true
        candidateLoaded = $false
        candidateExecuted = $false
        driverTouched = $false
        deviceTouched = $false
        artifactsRetained = $false
        gateState = [ordered]@{
            artifactPublicApiAllowlistFrozen = $false
            artifactCompileAllowlistFrozen = $false
            profileSourceCatalogBound = $false
            rawFeedbackDecoderFrozen = $false
            driverRuntimeAbiBound = $false
            distributionReady = $false
        }
    }
} catch {
    $failure = $_
    Write-Host "S1.5e observation failed in phase '$script:Phase': $($_.Exception.GetType().Name): $($_.Exception.Message)"
}

if ($null -ne $runnerTemp) {
    foreach ($path in @($script:CleanupRoots | Sort-Object Length -Descending)) {
        try {
            Remove-FixedTree -RunnerTemp $runnerTemp -Path $path
        } catch {
            $cleanupFailures.Add((Split-Path -Leaf $path))
            Write-Host "S1.5e cleanup failed for a fixed role: $($_.Exception.GetType().Name)"
        }
    }
}

if ($null -ne $failure -or $cleanupFailures.Count -ne 0) {
    $retainedArtifactRoles = @($cleanupFailures | Where-Object {
        @(
            'ksx-hm-s15e-out-a', 'ksx-hm-s15e-out-b',
            'ksx-hm-s15e-obj-a', 'ksx-hm-s15e-obj-b',
            'ksx-hm-s15e-inspector-out', 'ksx-hm-s15e-inspector-obj'
        ) -ccontains $_
    })
    $receipt = [ordered]@{
        schemaVersion = 1
        ok = $false
        phase = $script:Phase
        errorType = if ($null -eq $failure) { 'CleanupFailure' } else { $failure.Exception.GetType().FullName }
        diagnostic = 'Actions observation failed; inspect ephemeral job logs'
        cleanupCompleted = ($cleanupFailures.Count -eq 0)
        cleanupFailedRoles = $cleanupFailures.ToArray()
        observationEstablished = $false
        candidateBuilt = $candidateBuilt
        candidateLoaded = $false
        candidateExecuted = $false
        driverTouched = $false
        deviceTouched = $false
        artifactsRetained = ($retainedArtifactRoles.Count -ne 0)
    }
    $receipt | ConvertTo-Json -Depth 100
    exit 1
}

$resultData.cleanupCompleted = $true
$resultData | ConvertTo-Json -Depth 100
