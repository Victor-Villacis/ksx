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
    ('Install' + 'UsbipBackend\s*\(')
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
