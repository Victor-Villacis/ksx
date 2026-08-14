[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# Fragments are split where necessary so this scanner does not become its own
# match. This is a fail-closed tripwire; review and SDK-free CI remain required.
$forbiddenPatterns = @(
    ('\busing\s+HID' + 'Maestro\b'),
    ('\bHM' + '(?:Context|Controller|Profile)\b'),
    ('HID' + 'Maestro\.Core(?:\.dll)?'),
    ('Install' + 'Driver\s*\('),
    ('Create' + 'Controller(?:At)?\s*\('),
    ('RemoveAll' + 'VirtualControllers\s*\('),
    ('Assembly' + 'LoadContext'),
    ('Metadata' + 'LoadContext'),
    ('\bAssembly\s*\.\s*(?:Load|LoadFile|LoadFrom|UnsafeLoadFrom)\s*\('),
    ('\bAppDomain\b[^\r\n]*\.\s*Load\s*\('),
    ('\bNative' + 'Library\s*\.\s*Load\s*\('),
    ('\bLoad' + 'Library(?:Ex)?\s*\('),
    ('\bActivator\s*\.\s*CreateInstance\s*\('),
    ('\bResource' + '(?:Manager|Reader)\b'),
    ('\.GetCustomAttribute\s*<?'),
    ('\bProcess\s*\.\s*Start\s*\('),
    ('\bShell' + 'Execute'),
    ('["'']run' + 'as["'']'),
    ('\bImpersonate' + 'NamedPipeClient\b'),
    ('TokenImpersonationLevel\s*\.\s*(?:Identification|Impersonation|Delegation)'),
    ('\bNamed' + 'PipeServerStream\b'),
    ('\bEnvironment\s*\.\s*GetEnvironmentVariable\s*\('),
    ('\bFile\s*\.\s*(?:Open|Read|Write|Create|Copy|Move|Delete)\w*\s*\('),
    ('\bDirectory\s*\.\s*\w+\s*\(')
)

$sourceFiles = Get-ChildItem -LiteralPath $PSScriptRoot -Recurse -File -Filter '*.cs' |
    Where-Object { $_.FullName -notmatch '[\\/](?:bin|obj)[\\/]' }
$violations = foreach ($sourceFile in $sourceFiles) {
    foreach ($pattern in $forbiddenPatterns) {
        Select-String -LiteralPath $sourceFile.FullName -Pattern $pattern |
            ForEach-Object {
                '{0}:{1}: {2}' -f $_.Path, $_.LineNumber, $_.Line.Trim()
            }
    }
}

$pipeClientPath = Join-Path $PSScriptRoot 'PipeClient.cs'
$pipeClient = Get-Content -LiteralPath $pipeClientPath -Raw
foreach ($required in @(
    'TokenImpersonationLevel.Anonymous',
    'HandleInheritability.None',
    'GetNamedPipeServerProcessId',
    'ProcessIdToSessionId',
    'WaitForSingleObject'
)) {
    if ($pipeClient.IndexOf($required, [StringComparison]::Ordinal) -lt 0) {
        $violations += "PipeClient.cs: missing required peer/SQOS token '$required'"
    }
}

$nativeLibraries = foreach ($sourceFile in $sourceFiles) {
    [regex]::Matches(
        (Get-Content -LiteralPath $sourceFile.FullName -Raw),
        'DllImport\(\s*["''](?<library>[^"'']+)["'']') |
        ForEach-Object { $_.Groups['library'].Value }
}
$unexpectedLibraries = $nativeLibraries |
    Where-Object { $_ -notin @('kernel32.dll', 'advapi32.dll') }
if ($unexpectedLibraries) {
    $violations += "Unexpected native libraries: $($unexpectedLibraries -join ', ')"
}

$projectFiles = Get-ChildItem -LiteralPath $PSScriptRoot -Recurse -File -Filter '*.csproj'
foreach ($projectFile in $projectFiles) {
    $projectText = Get-Content -LiteralPath $projectFile.FullName -Raw
    foreach ($element in @('PackageReference', 'ProjectReference', 'Reference', 'Content', 'EmbeddedResource', 'None')) {
        if ($projectText -match ('<' + $element + '\b')) {
            $violations += "$($projectFile.FullName): forbidden project item <$element>"
        }
    }
    if ($projectText -match ('HID' + 'MaestroCorePath|HID' + 'MAESTRO_CORE_PATH|HID' + 'Maestro\.Core')) {
        $violations += "$($projectFile.FullName): SDK path/content text is forbidden"
    }
}

$hostProjectPath = Join-Path $PSScriptRoot 'HidMaestroFakeHost.csproj'
$hostProject = Get-Content -LiteralPath $hostProjectPath -Raw
$linkedCodec = [regex]::Matches(
    $hostProject,
    '<Compile\s+Include="\.\./hidmaestro-probe/HostProtocolCodec\.cs"')
if ($linkedCodec.Count -ne 1) {
    $violations += 'HidMaestroFakeHost.csproj: expected exactly one linked HostProtocolCodec.cs source'
}
foreach ($requiredProjectText in @(
    '<TargetFramework>net10.0-windows10.0.26100.0</TargetFramework>',
    '<RuntimeIdentifier>win-x64</RuntimeIdentifier>',
    '<SelfContained>false</SelfContained>',
    '<UseAppHost>true</UseAppHost>',
    '<Compile Remove="tests/**/*.cs" />'
)) {
    if ($hostProject.IndexOf($requiredProjectText, [StringComparison]::Ordinal) -lt 0) {
        $violations += "HidMaestroFakeHost.csproj: missing '$requiredProjectText'"
    }
}

if ($violations) {
    throw "SDK-free HIDMaestro fake-host guard failed:`n$($violations -join [Environment]::NewLine)"
}

Write-Output 'SDK-free HIDMaestro fake-host guard passed.'
