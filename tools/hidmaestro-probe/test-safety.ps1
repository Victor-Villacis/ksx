[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# The fragments are split so this guard does not match itself when it scans
# executable C# sources. This is a defense-in-depth tripwire, not a substitute
# for review of changes to the probe.
$forbiddenPatterns = @(
    ('new\s+' + 'HMContext\s*\('),
    ('Install' + 'Driver\s*\('),
    ('Create' + 'Controller(?:At)?\s*\('),
    ('RemoveAll' + 'VirtualControllers\s*\('),
    ('Install' + 'UsbipBackend\s*\('),
    ('Assembly' + 'LoadContext'),
    ('Metadata' + 'LoadContext'),
    ('\bAssembly\s*\.\s*(?:Load|LoadFile|LoadFrom|UnsafeLoadFrom)\s*\('),
    ('\bAppDomain\b[^\r\n]*\.\s*Load\s*\('),
    ('\bNative' + 'Library\s*\.\s*Load\s*\('),
    ('\bLoad' + 'Library(?:Ex)?\s*\('),
    ('\bActivator\s*\.\s*CreateInstance\s*\('),
    ('\bDelegate\s*\.\s*CreateDelegate\s*\('),
    ('\bRuntimeHelpers\s*\.\s*RunClassConstructor\s*\('),
    ('\bType\s*\.\s*GetType\s*\('),
    ('\.GetCustomAttribute\s*<'),
    ('\bResource' + 'Manager\b'),
    ('\bResource' + 'Reader\b'),
    ('\bMethod' + 'Info\b'),
    ('\bConstructor' + 'Info\b')
)

$sourceFiles = Get-ChildItem -LiteralPath $PSScriptRoot -Recurse -File -Filter '*.cs'
$violations = foreach ($sourceFile in $sourceFiles) {
    foreach ($pattern in $forbiddenPatterns) {
        Select-String -LiteralPath $sourceFile.FullName -Pattern $pattern -CaseSensitive |
            ForEach-Object { '{0}:{1}: {2}' -f $sourceFile.Name, $_.LineNumber, $_.Line.Trim() }
    }
}

if ($violations) {
    throw "Read-only HIDMaestro probe guard failed:`n$($violations -join [Environment]::NewLine)"
}

$projectPath = Join-Path $PSScriptRoot 'HidMaestroProbe.csproj'
$managedReference = Select-String -LiteralPath $projectPath `
    -Pattern ('<Reference\s+Include\s*=\s*["'']HID' + 'Maestro(?:\.|["''])') `
    -CaseSensitive
if ($managedReference) {
    throw 'Read-only HIDMaestro probe guard failed: the target DLL must be inert content, not a CLR assembly reference.'
}
