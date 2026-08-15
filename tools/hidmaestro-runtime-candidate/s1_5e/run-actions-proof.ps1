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

function Get-ExactRawTreeState {
    param([Parameter(Mandatory)][string] $Root)
    if (-not [IO.Directory]::Exists($Root)) { throw 'A fixed tree root is absent.' }
    Assert-NoReparsePoints -Root $Root
    $files = @(Get-ChildItem -LiteralPath $Root -File -Force -Recurse)
    $relativePaths = Get-OrdinalSorted -Values @($files | ForEach-Object {
        Get-RelativeUnixPath -Root $Root -Path $_.FullName
    })
    if ($relativePaths.Count -eq 0) { throw 'A fixed tree is unexpectedly empty.' }
    [long]$rawByteLength = 0
    foreach ($file in $files) {
        if ([long]$file.Length -gt ([long]::MaxValue - $rawByteLength)) {
            throw 'A fixed tree byte-length sum overflowed.'
        }
        $rawByteLength += [long]$file.Length
    }
    return [pscustomobject]@{
        RelativePaths = $relativePaths
        FileCount = $relativePaths.Count
        RawByteLength = $rawByteLength
        RawTreeSha256 = Get-FramedTreeSha256 -Root $Root `
            -RelativePaths $relativePaths -ByteMode Raw
    }
}

function Copy-ExactRawTree {
    param(
        [Parameter(Mandatory)][string] $SourceRoot,
        [Parameter(Mandatory)][string] $DestinationRoot
    )
    if (Test-Path -LiteralPath $DestinationRoot) {
        throw 'An exact-tree destination already exists.'
    }
    $source = Get-ExactRawTreeState -Root $SourceRoot
    [void][IO.Directory]::CreateDirectory($DestinationRoot)
    foreach ($relative in $source.RelativePaths) {
        $from = Join-Path $SourceRoot $relative.Replace('/', '\')
        $to = Join-Path $DestinationRoot $relative.Replace('/', '\')
        Copy-ExactFile -Source $from -Destination $to `
            -ExpectedRawSha256 (Get-RawSha256 -Path $from)
    }
    Assert-ExactFileSet -Root $DestinationRoot -Expected $source.RelativePaths
    $destination = Get-ExactRawTreeState -Root $DestinationRoot
    if ($destination.RawTreeSha256 -cne $source.RawTreeSha256 -or
        $destination.FileCount -ne $source.FileCount -or
        $destination.RawByteLength -ne $source.RawByteLength) {
        throw 'An exact targeting-pack tree copy changed bytes or topology.'
    }
    return [pscustomobject]@{
        RelativePaths = $source.RelativePaths
        FileCount = $source.FileCount
        RawByteLength = $source.RawByteLength
        SourceRawTreeSha256 = $source.RawTreeSha256
        DestinationRawTreeSha256 = $destination.RawTreeSha256
    }
}

function Receive-PinnedFrameworkPack {
    param(
        [Parameter(Mandatory)][string] $Uri,
        [Parameter(Mandatory)][string] $Destination,
        [Parameter(Mandatory)][long] $ExpectedLength,
        [Parameter(Mandatory)][string] $ExpectedSha256
    )
    if ([IO.File]::Exists($Destination)) { throw 'Pinned framework-pack download already exists.' }
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Destination))
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.AutomaticDecompression = [Net.DecompressionMethods]::None
    $handler.UseCookies = $false
    $handler.UseProxy = $false
    $client = [Net.Http.HttpClient]::new($handler, $true)
    $client.Timeout = [Threading.Timeout]::InfiniteTimeSpan
    $cancellation = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(60))
    $response = $null
    try {
        $response = $client.GetAsync(
            [Uri]$Uri, [Net.Http.HttpCompletionOption]::ResponseHeadersRead,
            $cancellation.Token).GetAwaiter().GetResult()
        if ($response.StatusCode -ne [Net.HttpStatusCode]::OK -or
            $response.RequestMessage.RequestUri.AbsoluteUri -cne $Uri -or
            $null -ne $response.Headers.Location -or
            @($response.Content.Headers.ContentEncoding).Count -ne 0) {
            throw 'Pinned framework-pack download response is not exact.'
        }
        $contentLength = $response.Content.Headers.ContentLength
        if ($null -eq $contentLength -or [long]$contentLength -ne $ExpectedLength) {
            throw 'Pinned framework-pack response length is not exact.'
        }
        $source = $response.Content.ReadAsStreamAsync(
            $cancellation.Token).GetAwaiter().GetResult()
        $destinationStream = [IO.FileStream]::new(
            $Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write,
            [IO.FileShare]::None, 65536, [IO.FileOptions]::SequentialScan)
        try {
            $buffer = [byte[]]::new(65536)
            [long]$written = 0
            while (($read = $source.ReadAsync(
                    $buffer, 0, $buffer.Length,
                    $cancellation.Token).GetAwaiter().GetResult()) -gt 0) {
                $written += $read
                if ($written -gt $ExpectedLength) {
                    throw 'Pinned framework-pack response exceeded its fixed length.'
                }
                $destinationStream.Write($buffer, 0, $read)
            }
            if ($written -ne $ExpectedLength) {
                throw 'Pinned framework-pack response ended at the wrong length.'
            }
        } finally {
            $destinationStream.Dispose()
            $source.Dispose()
        }
    } finally {
        if ($null -ne $response) { $response.Dispose() }
        $cancellation.Dispose()
        $client.Dispose()
    }
    if ((Get-Item -LiteralPath $Destination -Force).Attributes -band
        [IO.FileAttributes]::ReparsePoint) {
        throw 'Pinned framework-pack download is a reparse point.'
    }
    if ((Get-Item -LiteralPath $Destination).Length -ne $ExpectedLength -or
        (Get-RawSha256 -Path $Destination) -cne $ExpectedSha256) {
        throw 'Pinned framework-pack download bytes are not exact.'
    }
}

function Expand-PinnedWindowsTargetingPack {
    param(
        [Parameter(Mandatory)][string] $PackagePath,
        [Parameter(Mandatory)][string] $DestinationRoot,
        [Parameter(Mandatory)][string] $ExpectedSha256,
        [Parameter(Mandatory)][string] $ExpectedSha512Base64,
        [Parameter(Mandatory)][int] $ExpectedEntryCount,
        [Parameter(Mandatory)][long] $ExpectedUncompressedLength,
        [Parameter(Mandatory)][string] $ExpectedRawTreeSha256
    )
    if (Test-Path -LiteralPath $DestinationRoot) {
        throw 'Windows targeting-pack destination already exists.'
    }
    $package = [IO.FileStream]::new(
        $PackagePath, [IO.FileMode]::Open, [IO.FileAccess]::Read,
        [IO.FileShare]::Read, 65536, [IO.FileOptions]::SequentialScan)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    $sha512 = [Security.Cryptography.SHA512]::Create()
    $archive = $null
    try {
        $actualSha256 = [Convert]::ToHexString($sha256.ComputeHash($package))
        $package.Position = 0
        $actualSha512 = [Convert]::ToBase64String($sha512.ComputeHash($package))
        if ($actualSha256 -cne $ExpectedSha256 -or
            $actualSha512 -cne $ExpectedSha512Base64) {
            throw 'Windows targeting-pack package hashes are not exact.'
        }
        $package.Position = 0
        $archive = [IO.Compression.ZipArchive]::new(
            $package, [IO.Compression.ZipArchiveMode]::Read, $true)
        $entries = @($archive.Entries)
        if ($entries.Count -ne $ExpectedEntryCount) {
            throw 'Windows targeting-pack archive entry count is not exact.'
        }
        $ordinalNames = [Collections.Generic.HashSet[string]]::new(
            [StringComparer]::Ordinal)
        $caseInsensitiveNames = [Collections.Generic.HashSet[string]]::new(
            [StringComparer]::OrdinalIgnoreCase)
        [long]$uncompressedLength = 0
        foreach ($entry in $entries) {
            $name = [string]$entry.FullName
            $segments = @($name.Split('/'))
            if ([string]::IsNullOrEmpty($name) -or $name.Contains('\') -or
                $name.StartsWith('/', [StringComparison]::Ordinal) -or
                $name.EndsWith('/', [StringComparison]::Ordinal) -or
                $name.Contains(':') -or [IO.Path]::IsPathRooted($name) -or
                @($segments | Where-Object {
                    $_.Length -eq 0 -or $_ -ceq '.' -or $_ -ceq '..'
                }).Count -ne 0 -or $entry.ExternalAttributes -ne 0 -or
                -not $ordinalNames.Add($name) -or
                -not $caseInsensitiveNames.Add($name)) {
                throw 'Windows targeting-pack archive path or attributes are unsafe.'
            }
            $uncompressedLength += [long]$entry.Length
            if ($uncompressedLength -gt $ExpectedUncompressedLength) {
                throw 'Windows targeting-pack archive exceeded its fixed expanded length.'
            }
        }
        if ($uncompressedLength -ne $ExpectedUncompressedLength) {
            throw 'Windows targeting-pack archive expanded length is not exact.'
        }

        [void][IO.Directory]::CreateDirectory($DestinationRoot)
        $orderedNames = Get-OrdinalSorted -Values @($entries | ForEach-Object FullName)
        foreach ($name in $orderedNames) {
            $entry = $archive.GetEntry($name)
            if ($null -eq $entry) { throw 'Windows targeting-pack archive lookup failed.' }
            $destination = Get-FullPath (Join-Path $DestinationRoot $name.Replace('/', '\'))
            Assert-ChildPath -Parent $DestinationRoot -Child $destination
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))
            $input = $entry.Open()
            $output = [IO.FileStream]::new(
                $destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write,
                [IO.FileShare]::None, 65536, [IO.FileOptions]::SequentialScan)
            try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
            if ((Get-Item -LiteralPath $destination).Length -ne [long]$entry.Length) {
                throw 'Windows targeting-pack extracted file length changed.'
            }
        }
        Assert-ExactFileSet -Root $DestinationRoot -Expected $orderedNames
        $state = Get-ExactRawTreeState -Root $DestinationRoot
        if ($state.RawTreeSha256 -cne $ExpectedRawTreeSha256) {
            throw 'Windows targeting-pack extracted tree hash is not exact.'
        }
        return $state
    } finally {
        if ($null -ne $archive) { $archive.Dispose() }
        $sha512.Dispose()
        $sha256.Dispose()
        $package.Dispose()
    }
}

function ConvertTo-AnalyzerFreeTargetingPack {
    param(
        [Parameter(Mandatory)][string] $PackRoot,
        [int] $ExpectedOriginalFileCount = -1,
        [long] $ExpectedOriginalRawByteLength = -1,
        [string] $ExpectedOriginalRawTreeSha256,
        [long] $ExpectedOriginalFrameworkListByteLength = -1,
        [string] $ExpectedOriginalFrameworkListSha256,
        [Parameter(Mandatory)][object[]] $ExpectedAnalyzers,
        [long] $ExpectedSanitizedFrameworkListByteLength = -1,
        [string] $ExpectedSanitizedFrameworkListSha256,
        [int] $ExpectedSanitizedFileCount = -1,
        [long] $ExpectedSanitizedRawByteLength = -1,
        [string] $ExpectedSanitizedRawTreeSha256
    )
    $before = Get-ExactRawTreeState -Root $PackRoot
    if (($ExpectedOriginalFileCount -ge 0 -and
            $before.FileCount -ne $ExpectedOriginalFileCount) -or
        ($ExpectedOriginalRawByteLength -ge 0 -and
            $before.RawByteLength -ne $ExpectedOriginalRawByteLength) -or
        ($ExpectedOriginalRawTreeSha256 -and
            $before.RawTreeSha256 -cne $ExpectedOriginalRawTreeSha256)) {
        throw 'The original targeting-pack tree identity is not exact.'
    }
    $beforeFileHashes = [Collections.Generic.Dictionary[string,string]]::new(
        [StringComparer]::Ordinal)
    foreach ($relative in $before.RelativePaths) {
        $beforeFileHashes.Add(
            $relative,
            (Get-RawSha256 -Path (Join-Path $PackRoot $relative.Replace('/', '\'))))
    }
    $frameworkListPath = Get-FullPath (Join-Path $PackRoot 'data\FrameworkList.xml')
    Assert-ChildPath -Parent $PackRoot -Child $frameworkListPath
    if (-not [IO.File]::Exists($frameworkListPath) -or
        ((Get-Item -LiteralPath $frameworkListPath -Force).Attributes -band
            [IO.FileAttributes]::ReparsePoint)) {
        throw 'A targeting-pack FrameworkList.xml is absent or indirect.'
    }
    $originalFrameworkListSha256 = Get-RawSha256 -Path $frameworkListPath
    if ($ExpectedOriginalFrameworkListByteLength -ge 0 -and
        (Get-Item -LiteralPath $frameworkListPath -Force).Length -ne
            $ExpectedOriginalFrameworkListByteLength) {
        throw 'The original targeting-pack FrameworkList.xml length is not exact.'
    }
    if ($ExpectedOriginalFrameworkListSha256 -and
        $originalFrameworkListSha256 -cne $ExpectedOriginalFrameworkListSha256) {
        throw 'The original targeting-pack FrameworkList.xml hash is not exact.'
    }

    $frameworkBytes = [IO.File]::ReadAllBytes($frameworkListPath)
    if ($frameworkBytes.Length -ge 3 -and $frameworkBytes[0] -eq 0xEF -and
        $frameworkBytes[1] -eq 0xBB -and $frameworkBytes[2] -eq 0xBF) {
        throw 'A targeting-pack FrameworkList.xml unexpectedly has a UTF-8 BOM.'
    }
    $frameworkText = $script:Utf8NoBom.GetString($frameworkBytes)
    $withoutCrLf = $frameworkText.Replace("`r`n", "`n")
    if ($withoutCrLf.IndexOf("`r", [StringComparison]::Ordinal) -ge 0) {
        throw 'A targeting-pack FrameworkList.xml contains a bare carriage return.'
    }

    $settings = [Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $stringReader = [IO.StringReader]::new($frameworkText)
    $xmlReader = [Xml.XmlReader]::Create($stringReader, $settings)
    $document = [Xml.XmlDocument]::new()
    $document.XmlResolver = $null
    try { $document.Load($xmlReader) } finally { $xmlReader.Dispose(); $stringReader.Dispose() }
    if ($document.DocumentElement.LocalName -cne 'FileList') {
        throw 'A targeting-pack FrameworkList.xml has an unexpected root.'
    }

    $analyzerNodes = @($document.SelectNodes("//*[local-name()='File']") | Where-Object {
        $_.GetAttribute('Type').Equals('Analyzer', [StringComparison]::OrdinalIgnoreCase)
    })
    $analyzerPaths = [Collections.Generic.List[string]]::new()
    $analyzerOuterXml = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $analyzerEvidence = [Collections.Generic.List[object]]::new()
    foreach ($node in $analyzerNodes) {
        if ($node.GetAttribute('Type') -cne 'Analyzer') {
            throw 'A targeting-pack analyzer Type spelling is not canonical.'
        }
        $relative = [string]$node.GetAttribute('Path')
        $segments = @($relative.Split('/'))
        if ([string]::IsNullOrWhiteSpace($relative) -or $relative.Contains('\') -or
            $relative.StartsWith('/', [StringComparison]::Ordinal) -or
            $relative.Contains(':') -or [IO.Path]::IsPathRooted($relative) -or
            @($segments | Where-Object {
                $_.Length -eq 0 -or $_ -ceq '.' -or $_ -ceq '..'
            }).Count -ne 0 -or -not $analyzerOuterXml.Add([string]$node.OuterXml)) {
            throw 'A targeting-pack analyzer manifest entry is unsafe or duplicated.'
        }
        $analyzerPaths.Add($relative)
    }
    $actualAnalyzerPaths = Get-OrdinalSorted -Values $analyzerPaths.ToArray()
    $expectedAnalyzerPaths = Get-OrdinalSorted -Values @($ExpectedAnalyzers | ForEach-Object {
        [string]$_.path
    })
    if ($actualAnalyzerPaths.Count -ne $expectedAnalyzerPaths.Count -or
         [string]::Join("`n", $actualAnalyzerPaths) -cne
            [string]::Join("`n", $expectedAnalyzerPaths)) {
        throw 'The targeting-pack analyzer manifest path set is not exact.'
    }

    $keptLines = [Collections.Generic.List[string]]::new()
    $removedLines = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($match in [regex]::Matches(
            $frameworkText, '[^\n]*(?:\n|\z)',
            [Text.RegularExpressions.RegexOptions]::CultureInvariant)) {
        $line = [string]$match.Value
        if ($line.Length -eq 0) { continue }
        $body = $line.TrimEnd("`r", "`n").Trim()
        if ($analyzerOuterXml.Contains($body)) {
            if (-not $removedLines.Add($body)) {
                throw 'A targeting-pack analyzer manifest line is duplicated.'
            }
        } else {
            if ($body.Contains('Type="Analyzer"', [StringComparison]::OrdinalIgnoreCase)) {
                throw 'A targeting-pack analyzer manifest line was not exactly understood.'
            }
            $keptLines.Add($line)
        }
    }
    if ($removedLines.Count -ne $analyzerNodes.Count) {
        throw 'The targeting-pack analyzer XML nodes and exact source lines disagree.'
    }

    $sanitizedText = [string]::Join('', $keptLines)
    $sanitizedBytes = $script:Utf8NoBom.GetBytes($sanitizedText)
    [IO.File]::WriteAllBytes($frameworkListPath, $sanitizedBytes)
    $sanitizedFrameworkListSha256 = Get-RawSha256 -Path $frameworkListPath
    if ($ExpectedSanitizedFrameworkListByteLength -ge 0 -and
        (Get-Item -LiteralPath $frameworkListPath -Force).Length -ne
            $ExpectedSanitizedFrameworkListByteLength) {
        throw 'The sanitized targeting-pack FrameworkList.xml length is not exact.'
    }
    if ($ExpectedSanitizedFrameworkListSha256 -and
        $sanitizedFrameworkListSha256 -cne $ExpectedSanitizedFrameworkListSha256) {
        throw 'The sanitized targeting-pack FrameworkList.xml hash is not exact.'
    }

    foreach ($relative in $actualAnalyzerPaths) {
        $payload = Get-FullPath (Join-Path $PackRoot $relative.Replace('/', '\'))
        Assert-ChildPath -Parent $PackRoot -Child $payload
        if (-not [IO.File]::Exists($payload) -or
            ((Get-Item -LiteralPath $payload -Force).Attributes -band
                [IO.FileAttributes]::ReparsePoint)) {
            throw 'A targeting-pack analyzer payload is absent or indirect.'
        }
        $expected = @($ExpectedAnalyzers | Where-Object {
            [string]$_.path -ceq $relative
        })
        if ($expected.Count -ne 1 -or
            (Get-RawSha256 -Path $payload) -cne [string]$expected[0].sha256) {
            throw 'A targeting-pack analyzer payload hash is not exact.'
        }
        $analyzerEvidence.Add([ordered]@{
            relativePath = $relative
            byteLength = (Get-Item -LiteralPath $payload -Force).Length
            sha256 = Get-RawSha256 -Path $payload
        })
        [IO.File]::Delete($payload)
        if ([IO.File]::Exists($payload)) {
            throw 'A targeting-pack analyzer payload remained in the derived overlay.'
        }
    }

    $expectedAfterPaths = @($before.RelativePaths | Where-Object {
        $actualAnalyzerPaths -cnotcontains $_
    })
    Assert-ExactFileSet -Root $PackRoot -Expected $expectedAfterPaths
    foreach ($relative in $expectedAfterPaths) {
        if ($relative -cne 'data/FrameworkList.xml' -and
            (Get-RawSha256 -Path (Join-Path $PackRoot $relative.Replace('/', '\'))) -cne
                $beforeFileHashes[$relative]) {
            throw 'A non-analyzer targeting-pack file changed in the derived overlay.'
        }
    }
    $after = Get-ExactRawTreeState -Root $PackRoot
    if ($after.FileCount -ne ($before.FileCount - $actualAnalyzerPaths.Count)) {
        throw 'The derived targeting-pack topology changed beyond analyzer payload removal.'
    }
    if ($ExpectedSanitizedFileCount -ge 0 -and
        $after.FileCount -ne $ExpectedSanitizedFileCount) {
        throw 'The sanitized targeting-pack file count is not exact.'
    }
    if ($ExpectedSanitizedRawByteLength -ge 0 -and
        $after.RawByteLength -ne $ExpectedSanitizedRawByteLength) {
        throw 'The sanitized targeting-pack byte length is not exact.'
    }
    if ($ExpectedSanitizedRawTreeSha256 -and
        $after.RawTreeSha256 -cne $ExpectedSanitizedRawTreeSha256) {
        throw 'The sanitized targeting-pack raw tree hash is not exact.'
    }

    $sanitizedReader = [Xml.XmlReader]::Create($frameworkListPath, $settings)
    $sanitizedDocument = [Xml.XmlDocument]::new()
    $sanitizedDocument.XmlResolver = $null
    try { $sanitizedDocument.Load($sanitizedReader) } finally { $sanitizedReader.Dispose() }
    if (@($sanitizedDocument.SelectNodes("//*[local-name()='File']") | Where-Object {
            $_.GetAttribute('Type').Equals('Analyzer', [StringComparison]::OrdinalIgnoreCase)
        }).Count -ne 0) {
        throw 'The derived targeting-pack FrameworkList.xml still exposes an analyzer.'
    }
    return [pscustomobject]@{
        OriginalFileCount = $before.FileCount
        OriginalRawByteLength = $before.RawByteLength
        OriginalRawTreeSha256 = $before.RawTreeSha256
        OriginalFrameworkListByteLength = [long]$frameworkBytes.Length
        OriginalFrameworkListSha256 = $originalFrameworkListSha256
        RemovedAnalyzers = $analyzerEvidence.ToArray()
        SanitizedFileCount = $after.FileCount
        SanitizedRawByteLength = $after.RawByteLength
        SanitizedRawTreeSha256 = $after.RawTreeSha256
        SanitizedFrameworkListByteLength = [long]$sanitizedBytes.Length
        SanitizedFrameworkListSha256 = $sanitizedFrameworkListSha256
        SanitizedRelativePaths = $after.RelativePaths
    }
}

function Get-SdkTargetingPackEvidence {
    param(
        [Parameter(Mandatory)][string] $DotnetRoot,
        [Parameter(Mandatory)][string] $SdkVersion,
        [Parameter(Mandatory)][string] $ExpectedCorePackVersion,
        [Parameter(Mandatory)][string] $ExpectedWindowsPackVersion,
        [Parameter(Mandatory)][string] $ExpectedBundledVersionsSha256,
        [Parameter(Mandatory)][long] $ExpectedSdkVersionFileByteLength,
        [Parameter(Mandatory)][string] $ExpectedSdkVersionFileSha256,
        [Parameter(Mandatory)][string[]] $ExpectedSdkVersionFileLines,
        [Parameter(Mandatory)][long] $ExpectedSdkToolsetVersionFileByteLength,
        [Parameter(Mandatory)][string] $ExpectedSdkToolsetVersionFileSha256,
        [Parameter(Mandatory)][int] $ExpectedCorePackFileCount,
        [Parameter(Mandatory)][long] $ExpectedCorePackRawByteLength,
        [Parameter(Mandatory)][string] $ExpectedCorePackRawTreeSha256
    )
    $sdkRoot = Get-FullPath (Join-Path $DotnetRoot ('sdk\' + $SdkVersion))
    $sdkVersionFile = Join-Path $sdkRoot '.version'
    $sdkToolsetVersionFile = Join-Path $sdkRoot '.toolsetversion'
    $bundledVersions = Join-Path $sdkRoot 'Microsoft.NETCoreSdk.BundledVersions.props'
    foreach ($path in @($sdkVersionFile, $sdkToolsetVersionFile, $bundledVersions)) {
        if (-not [IO.File]::Exists($path) -or
            ((Get-Item -LiteralPath $path -Force).Attributes -band
                [IO.FileAttributes]::ReparsePoint)) {
            throw 'An exact SDK composition-evidence file is absent or indirect.'
        }
    }
    if ((Get-Item -LiteralPath $sdkVersionFile -Force).Length -ne
            $ExpectedSdkVersionFileByteLength -or
        (Get-RawSha256 -Path $sdkVersionFile) -cne $ExpectedSdkVersionFileSha256) {
        throw 'The exact SDK .version identity is not pinned.'
    }
    $expectedSdkVersionText = [string]::Join("`r`n", $ExpectedSdkVersionFileLines) + "`r`n"
    if ($script:Utf8NoBom.GetString([IO.File]::ReadAllBytes($sdkVersionFile)) -cne
        $expectedSdkVersionText) {
        throw 'The exact SDK .version content is not pinned.'
    }
    if ((Get-Item -LiteralPath $sdkToolsetVersionFile -Force).Length -ne
            $ExpectedSdkToolsetVersionFileByteLength -or
        (Get-RawSha256 -Path $sdkToolsetVersionFile) -cne
            $ExpectedSdkToolsetVersionFileSha256) {
        throw 'The exact SDK .toolsetversion identity is not pinned.'
    }
    $bundledVersionsSha256 = Get-RawSha256 -Path $bundledVersions
    if ($bundledVersionsSha256 -cne $ExpectedBundledVersionsSha256) {
        throw 'The exact SDK bundled-version evidence hash is not pinned.'
    }
    $settings = [Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $reader = [Xml.XmlReader]::Create($bundledVersions, $settings)
    $document = [Xml.XmlDocument]::new()
    $document.XmlResolver = $null
    try { $document.Load($reader) } finally { $reader.Dispose() }

    $coreNodes = @($document.SelectNodes(
        "//*[local-name()='KnownFrameworkReference']") | Where-Object {
            $_.GetAttribute('Include') -ceq 'Microsoft.NETCore.App' -and
            $_.GetAttribute('TargetFramework') -ceq 'net10.0' -and
            $_.GetAttribute('TargetingPackName') -ceq 'Microsoft.NETCore.App.Ref'
        })
    if ($coreNodes.Count -ne 1 -or
        $coreNodes[0].GetAttribute('TargetingPackVersion') -cne $ExpectedCorePackVersion) {
        throw 'SDK bundled versions do not prove the exact core targeting-pack version.'
    }
    $windowsNodes = @($document.SelectNodes(
        "//*[local-name()='WindowsSdkSupportedTargetPlatformVersion']") | Where-Object {
            $_.GetAttribute('Include') -ceq '10.0.26100.0' -and
            $_.GetAttribute('MinimumNETVersion') -ceq '8.0' -and
            $_.GetAttribute('WindowsSdkPackageVersion') -ceq $ExpectedWindowsPackVersion
        })
    if ($windowsNodes.Count -ne 1) {
        throw 'SDK bundled versions do not prove the exact Windows targeting-pack version.'
    }
    $coreSourceRoot = Get-FullPath (Join-Path $DotnetRoot (
        'packs\Microsoft.NETCore.App.Ref\' + $ExpectedCorePackVersion))
    $coreSource = Get-ExactRawTreeState -Root $coreSourceRoot
    if ($coreSource.FileCount -ne $ExpectedCorePackFileCount -or
        $coreSource.RawByteLength -ne $ExpectedCorePackRawByteLength -or
        $coreSource.RawTreeSha256 -cne $ExpectedCorePackRawTreeSha256) {
        throw 'The installed core targeting-pack tree identity is not exact.'
    }
    return [pscustomobject]@{
        SdkVersionFilePath = $sdkVersionFile
        SdkVersionFileSha256 = Get-RawSha256 -Path $sdkVersionFile
        SdkToolsetVersionFilePath = $sdkToolsetVersionFile
        SdkToolsetVersionFileSha256 = Get-RawSha256 -Path $sdkToolsetVersionFile
        BundledVersionsPath = $bundledVersions
        BundledVersionsSha256 = $bundledVersionsSha256
        CoreSourceRoot = $coreSourceRoot
        CoreSourceRelativePaths = $coreSource.RelativePaths
        CoreSourceFileCount = $coreSource.FileCount
        CoreSourceRawByteLength = $coreSource.RawByteLength
        CoreSourceRawTreeSha256 = $coreSource.RawTreeSha256
    }
}

function Get-PinnedRuntimeEvidence {
    param(
        [Parameter(Mandatory)][string] $Dotnet,
        [Parameter(Mandatory)][string] $DotnetRoot,
        [Parameter(Mandatory)][string] $WorkingDirectory,
        [Parameter(Mandatory)][string] $ExpectedVersion,
        [Parameter(Mandatory)][long] $ExpectedVersionFileByteLength,
        [Parameter(Mandatory)][string] $ExpectedVersionFileSha256,
        [Parameter(Mandatory)][string[]] $ExpectedVersionFileLines
    )
    $text = Invoke-Captured -File $Dotnet -Arguments @('--list-runtimes') `
        -WorkingDirectory $WorkingDirectory
    $matches = [Collections.Generic.List[object]]::new()
    foreach ($line in @($text -split "`r?`n" | Where-Object {
            -not [string]::IsNullOrWhiteSpace($_)
        })) {
        $parsed = [regex]::Match(
            $line.Trim(),
            '^Microsoft\.NETCore\.App ([0-9]+\.[0-9]+\.[0-9]+) \[(.+)\]$',
            [Text.RegularExpressions.RegexOptions]::CultureInvariant)
        if ($parsed.Success -and $parsed.Groups[1].Value -ceq $ExpectedVersion) {
            $matches.Add([pscustomobject]@{
                Version = $parsed.Groups[1].Value
                BasePath = Get-FullPath $parsed.Groups[2].Value
            })
        }
    }
    if ($matches.Count -ne 1) {
        throw 'The exact inspector runtime is not listed exactly once.'
    }
    $expectedBase = Get-FullPath (Join-Path $DotnetRoot 'shared\Microsoft.NETCore.App')
    if (-not $matches[0].BasePath.Equals(
            $expectedBase, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The exact inspector runtime is outside the resolved dotnet root.'
    }
    $runtimeRoot = Get-FullPath (Join-Path $expectedBase $ExpectedVersion)
    $runtimeVersionFile = Join-Path $runtimeRoot '.version'
    if (-not [IO.File]::Exists($runtimeVersionFile) -or
        ((Get-Item -LiteralPath $runtimeVersionFile -Force).Attributes -band
            [IO.FileAttributes]::ReparsePoint) -or
        (Get-Item -LiteralPath $runtimeVersionFile -Force).Length -ne
            $ExpectedVersionFileByteLength -or
        (Get-RawSha256 -Path $runtimeVersionFile) -cne $ExpectedVersionFileSha256) {
        throw 'The exact inspector-runtime .version identity is not pinned.'
    }
    $expectedRuntimeVersionText = [string]::Join("`r`n", $ExpectedVersionFileLines) + "`r`n"
    if ($script:Utf8NoBom.GetString([IO.File]::ReadAllBytes($runtimeVersionFile)) -cne
        $expectedRuntimeVersionText) {
        throw 'The exact inspector-runtime .version content is not pinned.'
    }
    $state = Get-ExactRawTreeState -Root $runtimeRoot
    return [pscustomobject]@{
        Version = $ExpectedVersion
        Root = $runtimeRoot
        RelativePaths = $state.RelativePaths
        FileCount = $state.FileCount
        RawByteLength = $state.RawByteLength
        VersionFileSha256 = Get-RawSha256 -Path $runtimeVersionFile
        PreRawTreeSha256 = $state.RawTreeSha256
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
        MSBuildEnableWorkloadResolver = 'false'
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
        MSBuildEnableWorkloadResolver = 'false'
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
        [Parameter(Mandatory)][string] $SourceContractRoot,
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
        $source = Join-Path $SourceContractRoot ([string]$entry.path).Replace('/', '\')
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
        [Parameter(Mandatory)][string] $DotnetRoot,
        [Parameter(Mandatory)][string] $TargetingPackRoot
    )
    $full = Get-FullPath $Path
    foreach ($role in @(
        [pscustomobject]@{ Name = 'candidate'; Root = $CandidateRoot },
        [pscustomobject]@{ Name = 'build'; Root = $BuildRoot },
        [pscustomobject]@{ Name = 'object'; Root = $ObjectRoot },
        [pscustomobject]@{ Name = 'targeting-pack'; Root = $TargetingPackRoot },
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
        [Parameter(Mandatory)][string] $NugetConfig,
        [string] $TargetingPackRoot
    )
    $pathMap = $CandidateRoot + '=/_/candidate,' +
        $ObjectRoot + '=/_/object,' + $OutputRoot + '=/_/output,' +
        $TempRoot + '=/_/temp'
    $pathMapSwitchValue = $pathMap.Replace(',', '%2C')
    $compilerGeneratedFilesRoot = Join-Path $ObjectRoot 'generated'
    $properties = @(
        '-p:Configuration=Release',
        '-p:RuntimeIdentifier=win-x64',
        '-p:PlatformTarget=x64',
        '-p:SelfContained=false',
        '-p:UseAppHost=false',
        '-p:NoConfig=true',
        '-p:Deterministic=true',
        '-p:ContinuousIntegrationBuild=true',
        '-p:DeterministicSourcePaths=true',
        "-p:PathMap=$pathMapSwitchValue",
        '-p:DebugType=portable',
        '-p:DebugSymbols=true',
        '-p:EmbedAllSources=false',
        '-p:EmbedUntrackedSources=false',
        '-p:UseSharedCompilation=false',
        '-p:EnableNETAnalyzers=false',
        '-p:RunAnalyzers=false',
        '-p:RunAnalyzersDuringBuild=false',
        '-p:RunAnalyzersDuringLiveAnalysis=false',
        '-p:_SkipAnalyzers=true',
        '-p:GenerateMSBuildEditorConfigFile=false',
        '-p:DiscoverEditorConfigFiles=false',
        '-p:DiscoverGlobalAnalyzerConfigFiles=false',
        '-p:TreatWarningsAsErrors=true',
        '-p:GenerateDependencyFile=true',
        '-p:AppendTargetFrameworkToOutputPath=false',
        '-p:AppendRuntimeIdentifierToOutputPath=false',
        '-p:EmitCompilerGeneratedFiles=true',
        '-p:ProvideCommandLineArgs=true',
        "-p:CompilerGeneratedFilesOutputPath=$compilerGeneratedFilesRoot",
        '-p:ImportDirectoryBuildProps=false',
        '-p:ImportDirectoryBuildTargets=false',
        '-p:MSBuildProvideImportedProjects=true',
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
        '-p:RestoreAdditionalProjectSources=',
        '-p:RestoreFallbackFolders=',
        '-p:RestoreAdditionalProjectFallbackFolders=',
        '-p:RestoreIgnoreFailedSources=false',
        '-p:RestoreNoCache=true',
        '-p:NuGetAudit=false'
    )
    if (-not [string]::IsNullOrWhiteSpace($TargetingPackRoot)) {
        $properties += @(
            "-p:NetCoreTargetingPackRoot=$($TargetingPackRoot.TrimEnd('\'))\",
            '-p:EnableTargetingPackDownload=false',
            '-p:EnableRuntimePackDownload=false',
            '-p:EnableAppHostPackDownload=false',
            '-p:DisableTransitiveFrameworkReferenceDownloads=true',
            '-p:DisableImplicitLibraryPacksFolder=true',
            '-p:DisableImplicitNuGetFallbackFolder=true',
            '-p:MSBuildEnableWorkloadResolver=false'
        )
    }
    return $properties
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
    $settings = [Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $reader = [Xml.XmlReader]::Create($ProjectPath, $settings)
    $xml = [Xml.XmlDocument]::new()
    $xml.XmlResolver = $null
    try { $xml.Load($reader) } finally { $reader.Dispose() }
    if ($xml.DocumentElement.LocalName -cne 'Project' -or
        $xml.DocumentElement.NamespaceURI.Length -ne 0) {
        throw 'The candidate project XML root or namespace is not exact.'
    }

    $compileNodes = @($xml.SelectNodes('/Project/ItemGroup/Compile'))
    $resourceNodes = @($xml.SelectNodes('/Project/ItemGroup/EmbeddedResource'))
    if ($compileNodes.Count -ne 11 -or $resourceNodes.Count -ne 228) {
        throw 'The candidate project XML item topology is not exact.'
    }
    $compileValues = [Collections.Generic.List[string]]::new()
    $compilePaths = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase)
    foreach ($node in $compileNodes) {
        $include = [string]$node.GetAttribute('Include')
        $normalized = $include.Replace('\', '/')
        $segments = @($normalized.Split('/'))
        if ([string]::IsNullOrWhiteSpace($include) -or $include.Contains('*') -or
            $include.Contains('?') -or $include.Contains(':') -or
            [IO.Path]::IsPathRooted($include) -or
            @($segments | Where-Object {
                $_.Length -eq 0 -or $_ -ceq '.' -or $_ -ceq '..'
            }).Count -ne 0 -or $node.HasAttribute('Condition') -or
            $node.ParentNode.HasAttribute('Condition') -or
            -not $compilePaths.Add($normalized)) {
            throw 'A candidate Compile item is conditional, wildcarded, or lacks Include.'
        }
        $compileValues.Add($normalized)
    }
    $resourceValues = [Collections.Generic.List[string]]::new()
    $resourcePaths = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase)
    $logicalNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $logicalNamesIgnoreCase = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase)
    foreach ($node in $resourceNodes) {
        $include = [string]$node.GetAttribute('Include')
        $normalized = $include.Replace('\', '/')
        $segments = @($normalized.Split('/'))
        $logicalName = [string]$node.GetAttribute('LogicalName')
        $logicalSegments = @($logicalName.Split('/'))
        if ([string]::IsNullOrWhiteSpace($include) -or $include.Contains('*') -or
            $include.Contains('?') -or $include.Contains(':') -or
            [IO.Path]::IsPathRooted($include) -or
            @($segments | Where-Object {
                $_.Length -eq 0 -or $_ -ceq '.' -or $_ -ceq '..'
            }).Count -ne 0 -or $node.HasAttribute('Condition') -or
            $node.ParentNode.HasAttribute('Condition') -or
            -not $resourcePaths.Add($normalized) -or
            -not $node.HasAttribute('LogicalName') -or
            $node.SelectNodes('./LogicalName').Count -ne 0 -or
            [string]::IsNullOrWhiteSpace($logicalName) -or
            $logicalName.Contains('\') -or $logicalName.Contains(':') -or
            [IO.Path]::IsPathRooted($logicalName) -or
            @($logicalSegments | Where-Object {
                $_.Length -eq 0 -or $_ -ceq '.' -or $_ -ceq '..'
            }).Count -ne 0 -or -not $logicalNames.Add($logicalName) -or
            -not $logicalNamesIgnoreCase.Add($logicalName)) {
            throw 'An EmbeddedResource item is conditional, wildcarded, or lacks exact metadata.'
        }
        $resourceValues.Add($normalized + '|logical=' + $logicalName)
    }
    $compile = Get-OrdinalSorted -Values $compileValues.ToArray()
    $resources = Get-OrdinalSorted -Values $resourceValues.ToArray()
    return [pscustomobject]@{ Compile = $compile; Resources = $resources }
}

function Test-ContainsAbsoluteWindowsPath {
    param([Parameter(Mandatory)][AllowEmptyString()][string] $Text)
    $options = [Text.RegularExpressions.RegexOptions]::CultureInvariant
    return [regex]::IsMatch($Text, '(?i)(?<![a-z])[a-z]:[\\/]', $options) -or
        [regex]::IsMatch(
            $Text, '(?i)(?<![a-z0-9+.-])file:[\\/]{2,}', $options) -or
        [regex]::IsMatch(
            $Text, '(?i)(?<![-a-z0-9+./:\\])[\\/]{2,}(?=[^\\/\s])', $options) -or
        $Text.IndexOf('\\', [StringComparison]::Ordinal) -ge 0
}

function Get-RoleNormalizedTextState {
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)] $Replacements
    )
    $bytes = [IO.File]::ReadAllBytes($Path)
    $text = $script:Utf8NoBom.GetString($bytes).Replace("`r`n", "`n").Replace("`r", "`n")
    foreach ($entry in $Replacements.GetEnumerator()) {
        $root = (Get-FullPath ([string]$entry.Value)).TrimEnd('\')
        $placeholder = '/_/' + [string]$entry.Key
        $text = $text.Replace($root, $placeholder,
            [StringComparison]::OrdinalIgnoreCase)
        $text = $text.Replace($root.Replace('\', '/'), $placeholder,
            [StringComparison]::OrdinalIgnoreCase)
    }
    if (Test-ContainsAbsoluteWindowsPath -Text $text) {
        throw 'A role-normalized generated import retains an absolute filesystem path.'
    }
    $normalized = $script:Utf8NoBom.GetBytes($text)
    return [pscustomobject]@{
        Bytes = $normalized
        Sha256 = [Convert]::ToHexString(
            [Security.Cryptography.SHA256]::HashData($normalized))
    }
}

function Get-SafeGeneratedImportDiagnostics {
    param(
        [Parameter(Mandatory)][byte[]] $NormalizedBytes,
        [Parameter(Mandatory)][ValidateSet('nuget-g-props', 'nuget-g-targets')]
        [string] $Kind,
        [Parameter(Mandatory)][string] $SemanticSha256
    )
    $settings = [Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $stream = [IO.MemoryStream]::new($NormalizedBytes, $false)
    $reader = [Xml.XmlReader]::Create($stream, $settings)
    $document = [Xml.XmlDocument]::new()
    $document.XmlResolver = $null
    try { $document.Load($reader) } finally { $reader.Dispose(); $stream.Dispose() }
    $nodes = @($document.SelectNodes('//*'))
    $lines = @($script:Utf8NoBom.GetString($NormalizedBytes).Split("`n"))
    $diagnostics = [Collections.Generic.List[string]]::new()
    $diagnostics.Add(
        "kind=$Kind|normalizedLength=$($NormalizedBytes.Length)|nodeCount=$($nodes.Count)|lineCount=$($lines.Count)|semanticSha256=$SemanticSha256")
    for ($lineIndex = 0; $lineIndex -lt $lines.Count; $lineIndex++) {
        $lineBytes = $script:Utf8NoBom.GetBytes([string]$lines[$lineIndex])
        $lineDigest = [Convert]::ToHexString(
            [Security.Cryptography.SHA256]::HashData($lineBytes))
        $diagnostics.Add(
            "kind=$Kind|lineIndex=$lineIndex|lineLength=$($lineBytes.Length)|lineSha256=$lineDigest")
    }
    for ($index = 0; $index -lt $nodes.Count; $index++) {
        $node = $nodes[$index]
        if ([string]$node.LocalName -notmatch '^[A-Za-z_][A-Za-z0-9_.-]*$') {
            throw 'A generated NuGet import has an unsafe XML node name.'
        }
        $attributeRecords = [Collections.Generic.List[string]]::new()
        foreach ($attribute in @($node.Attributes)) {
            if ([string]$attribute.Name -notmatch '^[A-Za-z_][A-Za-z0-9_.-]*$') {
                throw 'A generated NuGet import has an unsafe XML attribute name.'
            }
            $attributeBytes = $script:Utf8NoBom.GetBytes([string]$attribute.Value)
            $attributeRecords.Add(
                ([string]$attribute.Name + ':length=' + $attributeBytes.Length + ':sha256=' +
                    [Convert]::ToHexString(
                        [Security.Cryptography.SHA256]::HashData($attributeBytes))))
        }
        $attributeText = [string]::Join(';',
            (Get-OrdinalSorted -Values $attributeRecords.ToArray()))
        $attributeDigest = [Convert]::ToHexString(
            [Security.Cryptography.SHA256]::HashData(
                $script:Utf8NoBom.GetBytes($attributeText)))
        $valueBytes = $script:Utf8NoBom.GetBytes([string]$node.InnerText)
        $valueDigest = [Convert]::ToHexString(
            [Security.Cryptography.SHA256]::HashData($valueBytes))
        $childElementCount = @($node.ChildNodes | Where-Object NodeType -eq Element).Count
        $diagnostics.Add(
            "kind=$Kind|nodeIndex=$index|name=$($node.LocalName)|childElementCount=$childElementCount|valueLength=$($valueBytes.Length)|valueSha256=$valueDigest|attributeCount=$($node.Attributes.Count)|attributesSha256=$attributeDigest")
    }
    return $diagnostics.ToArray()
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
        [Parameter(Mandatory)][string] $TargetingPackRoot,
        [Parameter(Mandatory)][string] $CorePackVersion,
        [Parameter(Mandatory)][string] $WindowsPackVersion,
        [Parameter(Mandatory)][string] $WindowsSdkReferenceSha256,
        [Parameter(Mandatory)][string] $PackagesRoot,
        [Parameter(Mandatory)][string[]] $Properties,
        [Parameter(Mandatory)][string] $ManifestPath
    )
    $arguments = @(
        'msbuild', $ProjectPath,
        '-noAutoResponse', '-nologo', '-verbosity:quiet', '-nodeReuse:false', '-maxcpucount:1',
        '-target:ResolveReferences',
        '-getItem:Compile,EmbeddedResource,ReferencePath,Analyzer,AdditionalFiles,AnalyzerConfigFiles,EditorConfigFiles,PotentialEditorConfigFiles,GlobalAnalyzerConfigFiles,CompilerResponseFile,MSBuildImportedProject',
        '-getProperty:MSBuildProvideImportedProjects,TargetFramework,RuntimeIdentifier,PlatformTarget,SelfContained,UseAppHost,NoConfig,Deterministic,ContinuousIntegrationBuild,PathMap,UseSharedCompilation,EnableNETAnalyzers,RunAnalyzers,RunAnalyzersDuringBuild,RunAnalyzersDuringLiveAnalysis,_SkipAnalyzers,GenerateMSBuildEditorConfigFile,DiscoverEditorConfigFiles,DiscoverGlobalAnalyzerConfigFiles,GenerateAssemblyInfo,GenerateTargetFrameworkAttribute,AllowUnsafeBlocks,AppendTargetFrameworkToOutputPath,AppendRuntimeIdentifierToOutputPath,EmitCompilerGeneratedFiles,ProvideCommandLineArgs,CompilerGeneratedFilesOutputPath,ImportDirectoryBuildProps,ImportDirectoryBuildTargets,CustomBeforeMicrosoftCommonProps,CustomBeforeMicrosoftCommonTargets,CustomAfterMicrosoftCommonTargets,CustomBeforeMicrosoftCSharpTargets,CustomAfterMicrosoftCSharpTargets,PreBuildEvent,PostBuildEvent,RunPostBuildEvent,CscToolPath,CscToolExe,RoslynTargetsPath,CSharpCoreTargetsPath,NetCoreTargetingPackRoot,EnableTargetingPackDownload,EnableRuntimePackDownload,EnableAppHostPackDownload,DisableTransitiveFrameworkReferenceDownloads,DisableImplicitLibraryPacksFolder,DisableImplicitNuGetFallbackFolder,MSBuildEnableWorkloadResolver,OutDir,TargetDir,TargetPath,TargetName,TargetExt'
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
        _SkipAnalyzers = 'true'
        GenerateMSBuildEditorConfigFile = 'false'
        DiscoverEditorConfigFiles = 'false'
        DiscoverGlobalAnalyzerConfigFiles = 'false'
        GenerateAssemblyInfo = 'false'
        GenerateTargetFrameworkAttribute = 'false'
        AllowUnsafeBlocks = 'false'
        AppendTargetFrameworkToOutputPath = 'false'
        AppendRuntimeIdentifierToOutputPath = 'false'
        EmitCompilerGeneratedFiles = 'true'
        ProvideCommandLineArgs = 'true'
        CompilerGeneratedFilesOutputPath = (Get-FullPath (Join-Path $ObjectRoot 'generated'))
        ImportDirectoryBuildProps = 'false'
        ImportDirectoryBuildTargets = 'false'
        MSBuildProvideImportedProjects = 'true'
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
        NetCoreTargetingPackRoot = (Get-FullPath $TargetingPackRoot).TrimEnd('\') + '\'
        EnableTargetingPackDownload = 'false'
        EnableRuntimePackDownload = 'false'
        EnableAppHostPackDownload = 'false'
        DisableTransitiveFrameworkReferenceDownloads = 'true'
        DisableImplicitLibraryPacksFolder = 'true'
        DisableImplicitNuGetFallbackFolder = 'true'
        MSBuildEnableWorkloadResolver = 'false'
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
            -BuildRoot $BuildRoot -ObjectRoot $ObjectRoot -DotnetRoot $DotnetRoot `
            -TargetingPackRoot $TargetingPackRoot
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

    $analyzerProperty = $evaluation.Items.PSObject.Properties['Analyzer']
    $analyzers = @(if ($null -eq $analyzerProperty) {
        @()
    } else {
        @($analyzerProperty.Value)
    })
    if ($analyzers.Count -ne 0) {
        throw 'The effective compiler Analyzer item closure is not empty.'
    }
    $analyzers = [string[]]@()
    foreach ($itemName in @(
        'AdditionalFiles', 'AnalyzerConfigFiles', 'EditorConfigFiles',
        'PotentialEditorConfigFiles', 'GlobalAnalyzerConfigFiles', 'CompilerResponseFile'
    )) {
        $itemProperty = $evaluation.Items.PSObject.Properties[$itemName]
        if ($null -ne $itemProperty -and @($itemProperty.Value).Count -ne 0) {
            throw "Unexpected Csc auxiliary input item: $itemName"
        }
    }

    $references = Get-OrdinalSorted -Values @($evaluation.Items.ReferencePath | ForEach-Object {
        $full = Get-FullPath ([string]$_.FullPath)
        $rolePath = Get-RolePath -Path $full -CandidateRoot $CandidateRoot -BuildRoot $BuildRoot `
            -ObjectRoot $ObjectRoot -DotnetRoot $DotnetRoot `
            -TargetingPackRoot $TargetingPackRoot
        $coreReferencePrefix = 'targeting-pack/Microsoft.NETCore.App.Ref/' +
            $CorePackVersion + '/'
        $windowsReferencePrefix = 'targeting-pack/Microsoft.Windows.SDK.NET.Ref/' +
            $WindowsPackVersion + '/'
        if (-not $rolePath.StartsWith($coreReferencePrefix, [StringComparison]::Ordinal) -and
            -not $rolePath.StartsWith($windowsReferencePrefix, [StringComparison]::Ordinal)) {
            throw 'ReferencePath contains an input outside the derived targeting-pack root.'
        }
        $rolePath + '|sha256=' + (Get-RawSha256 -Path $full)
    })
    if (@($references | Select-Object -Unique).Count -ne $references.Count) {
        throw 'Duplicate ReferencePath identities are forbidden.'
    }
    if ($references.Count -eq 0) { throw 'The evaluated reference-pack closure is empty.' }
    $expectedWindowsReference = 'targeting-pack/Microsoft.Windows.SDK.NET.Ref/' +
        $WindowsPackVersion + '/lib/net8.0/Microsoft.Windows.SDK.NET.dll|sha256=' +
        $WindowsSdkReferenceSha256
    if (@($references | Where-Object { $_ -ceq $expectedWindowsReference }).Count -ne 1) {
        throw 'The exact Windows SDK reference assembly was not resolved once.'
    }

    $importsList = [Collections.Generic.List[string]]::new()
    $rawImportsList = [Collections.Generic.List[string]]::new()
    $safeObjectImportDiagnostics = [Collections.Generic.List[string]]::new()
    $importedProjectProperty = $evaluation.Items.PSObject.Properties['MSBuildImportedProject']
    if ($null -eq $importedProjectProperty) {
        throw 'MSBuild did not expose its imported-project closure.'
    }
    $importedProjects = @($importedProjectProperty.Value)
    if ($importedProjects.Count -eq 0) {
        throw 'The evaluated imported-project closure is empty.'
    }
    $importedIdentitySet = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase)
    $objectImportSet = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase)
    $candidateSdkEdgeSet = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase)
    foreach ($importItem in $importedProjects) {
        $identityProperty = $importItem.PSObject.Properties['Identity']
        $fullPathProperty = $importItem.PSObject.Properties['FullPath']
        $importerProperty = $importItem.PSObject.Properties['ImportingProjectPath']
        if ($null -eq $identityProperty -or $null -eq $fullPathProperty -or
            $null -eq $importerProperty -or
            [string]::IsNullOrWhiteSpace([string]$identityProperty.Value) -or
            [string]::IsNullOrWhiteSpace([string]$fullPathProperty.Value) -or
            [string]::IsNullOrWhiteSpace([string]$importerProperty.Value) -or
            -not [IO.Path]::IsPathFullyQualified([string]$identityProperty.Value) -or
            -not [IO.Path]::IsPathFullyQualified([string]$fullPathProperty.Value) -or
            -not [IO.Path]::IsPathFullyQualified([string]$importerProperty.Value)) {
            throw 'An imported-project edge lacks exact absolute identities.'
        }
        $full = Get-FullPath ([string]$identityProperty.Value)
        $metadataFull = Get-FullPath ([string]$fullPathProperty.Value)
        $importerFull = Get-FullPath ([string]$importerProperty.Value)
        if (-not $full.Equals($metadataFull, [StringComparison]::OrdinalIgnoreCase) -or
            -not [IO.File]::Exists($full) -or -not [IO.File]::Exists($importerFull) -or
            -not $importedIdentitySet.Add($full)) {
            throw 'An imported-project edge is missing or duplicates an identity.'
        }
        $rolePath = Get-RolePath -Path $full -CandidateRoot $CandidateRoot -BuildRoot $BuildRoot `
            -ObjectRoot $ObjectRoot -DotnetRoot $DotnetRoot `
            -TargetingPackRoot $TargetingPackRoot
        $importerRolePath = Get-RolePath -Path $importerFull `
            -CandidateRoot $CandidateRoot -BuildRoot $BuildRoot `
            -ObjectRoot $ObjectRoot -DotnetRoot $DotnetRoot `
            -TargetingPackRoot $TargetingPackRoot
        if ((-not $rolePath.StartsWith('object/', [StringComparison]::Ordinal) -and
                -not $rolePath.StartsWith('dotnet/', [StringComparison]::Ordinal)) -or
            (-not $importerRolePath.StartsWith('candidate/', [StringComparison]::Ordinal) -and
                -not $importerRolePath.StartsWith('dotnet/', [StringComparison]::Ordinal))) {
            throw 'An imported-project edge escaped the exact candidate/dotnet roles.'
        }
        $sdkProperty = $importItem.PSObject.Properties['Sdk']
        $sdkName = if ($null -eq $sdkProperty) { '' } else { [string]$sdkProperty.Value }
        if ($importerRolePath.StartsWith('candidate/', [StringComparison]::Ordinal)) {
            if ($importerRolePath -cne 'candidate/HIDMaestro.Core.csproj' -or
                $sdkName -cne 'Microsoft.NET.Sdk' -or
                -not $candidateSdkEdgeSet.Add($rolePath)) {
                throw 'A root SDK import edge is not exact.'
            }
            $sdkKind = 'microsoft-net-sdk'
        } else {
            if ($sdkName.Length -ne 0) {
                throw 'A nested imported-project edge has unexpected SDK metadata.'
            }
            $sdkKind = 'none'
        }
        $edgePrefix = $rolePath + '|importer=' + $importerRolePath + '|sdk=' + $sdkKind
        $rawImportsList.Add($edgePrefix + '|rawSha256=' + (Get-RawSha256 -Path $full))
        if ($rolePath.StartsWith('object/', [StringComparison]::Ordinal)) {
            if (-not $objectImportSet.Add($rolePath)) {
                throw 'A generated NuGet import appears more than once.'
            }
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
            $normalizedState = Get-RoleNormalizedTextState -Path $full -Replacements ([ordered]@{
                object = $ObjectRoot
                packages = $PackagesRoot
            })
            $hash = $normalizedState.Sha256
            $kind = switch -CaseSensitive ($basename) {
                'HIDMaestro.Core.csproj.nuget.g.props' { 'nuget-g-props' }
                'HIDMaestro.Core.csproj.nuget.g.targets' { 'nuget-g-targets' }
                default { throw 'An object-role import basename escaped its exact allowlist.' }
            }
            foreach ($diagnostic in @(Get-SafeGeneratedImportDiagnostics `
                -NormalizedBytes $normalizedState.Bytes -Kind $kind `
                -SemanticSha256 $normalizedState.Sha256)) {
                $safeObjectImportDiagnostics.Add([string]$diagnostic)
            }
        } else {
            $hash = Get-RawSha256 -Path $full
        }
        $importsList.Add($edgePrefix + '|semanticSha256=' + $hash)
    }
    $expectedObjectImports = Get-OrdinalSorted -Values @(
        'object/HIDMaestro.Core.csproj.nuget.g.props',
        'object/HIDMaestro.Core.csproj.nuget.g.targets')
    $actualObjectImports = Get-OrdinalSorted -Values @($objectImportSet)
    if ($actualObjectImports.Count -ne 2 -or
        [string]::Join("`n", $actualObjectImports) -cne
            [string]::Join("`n", $expectedObjectImports)) {
        throw 'The evaluated generated NuGet import closure is not exact.'
    }
    $expectedCandidateSdkEdges = Get-OrdinalSorted -Values @(
        'dotnet/sdk/10.0.400/Sdks/Microsoft.NET.Sdk/Sdk/Sdk.props',
        'dotnet/sdk/10.0.400/Sdks/Microsoft.NET.Sdk/Sdk/Sdk.targets')
    $actualCandidateSdkEdges = Get-OrdinalSorted -Values @($candidateSdkEdgeSet)
    if ($actualCandidateSdkEdges.Count -ne 2 -or
        [string]::Join("`n", $actualCandidateSdkEdges) -cne
            [string]::Join("`n", $expectedCandidateSdkEdges)) {
        throw 'The root Microsoft.NET.Sdk import closure is not exact.'
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
            -ObjectRoot $ObjectRoot -DotnetRoot $DotnetRoot `
            -TargetingPackRoot $TargetingPackRoot
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
        } elseif ($_.Key -eq 'NetCoreTargetingPackRoot') {
            'targeting-pack/'
        } elseif ($_.Key -eq 'CompilerGeneratedFilesOutputPath') {
            'object/generated'
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
        SafeObjectImportDiagnostics = Get-OrdinalSorted -Values `
            $safeObjectImportDiagnostics.ToArray()
    }
}

function Get-EvaluationManifestFieldDifferences {
    param(
        [Parameter(Mandatory)] $Left,
        [Parameter(Mandatory)] $Right
    )
    $manifestFields = @(
        'compileItems', 'embeddedResources', 'referencePaths', 'analyzers',
        'generatedCompilerSources', 'imports', 'compilerArguments'
    )
    $differences = [Collections.Generic.List[string]]::new()
    foreach ($field in $manifestFields) {
        if (-not $Left.Manifest.Contains($field) -or
            -not $Right.Manifest.Contains($field)) {
            throw 'An evaluated manifest is missing a fixed field.'
        }
        $leftText = [string]::Join("`n", [string[]]@($Left.Manifest[$field]))
        $rightText = [string]::Join("`n", [string[]]@($Right.Manifest[$field]))
        if ($leftText -cne $rightText) { $differences.Add($field) }
    }
    return $differences.ToArray()
}

function Get-SafeImportDiagnostic {
    param([Parameter(Mandatory)][string] $Entry)
    $match = [regex]::Match(
        $Entry,
        '^(object|dotnet)/([^|]+)\|importer=(candidate|dotnet)/[^|]+\|sdk=(none|microsoft-net-sdk)\|semanticSha256=([A-F0-9]{64})$',
        [Text.RegularExpressions.RegexOptions]::CultureInvariant)
    if (-not $match.Success) {
        throw 'An evaluated import cannot be reduced to its safe role and semantic hash.'
    }
    $role = $match.Groups[1].Value
    $kind = 'other'
    if ($role -ceq 'object') {
        $kind = switch -CaseSensitive ($match.Groups[2].Value) {
            'HIDMaestro.Core.csproj.nuget.g.props' { 'nuget-g-props' }
            'HIDMaestro.Core.csproj.nuget.g.targets' { 'nuget-g-targets' }
            default { throw 'An object import diagnostic escaped its exact kind allowlist.' }
        }
    }
    return 'role=' + $role + '|kind=' + $kind +
        '|importerRole=' + $match.Groups[3].Value +
        '|sdkKind=' + $match.Groups[4].Value +
        '|semanticSha256=' + $match.Groups[5].Value
}

function Write-EvaluationManifestDifference {
    param(
        [Parameter(Mandatory)][string] $Label,
        [Parameter(Mandatory)] $Left,
        [Parameter(Mandatory)] $Right
    )
    $differentFields = @(Get-EvaluationManifestFieldDifferences -Left $Left -Right $Right)
    if ($differentFields.Count -eq 0) {
        throw 'The normalized evaluated manifest hashes differ without a field difference.'
    }
    Write-Host ('EVALUATION-DIFF {0} fields={1}' -f
        $Label, [string]::Join(',', $differentFields))
    if ($differentFields -ccontains 'imports') {
        foreach ($difference in @(Compare-Object `
            @($Left.Manifest['imports']) @($Right.Manifest['imports']) `
            -CaseSensitive)) {
            $safe = Get-SafeImportDiagnostic -Entry ([string]$difference.InputObject)
            Write-Host ('EVALUATION-IMPORT-DIFF {0} {1} {2}' -f
                $Label, [string]$difference.SideIndicator, $safe)
        }
        foreach ($difference in @(Compare-Object `
            @($Left.SafeObjectImportDiagnostics) @($Right.SafeObjectImportDiagnostics) `
            -CaseSensitive)) {
            Write-Host ('EVALUATION-OBJECT-IMPORT-SHAPE-DIFF {0} {1} {2}' -f
                $Label, [string]$difference.SideIndicator,
                [string]$difference.InputObject)
        }
    }
}

function Assert-EmptyEvaluatedAnalyzerClosure {
    param(
        [Parameter(Mandatory)][string] $Dotnet,
        [Parameter(Mandatory)][string] $Project,
        [Parameter(Mandatory)][string] $BuildRoot,
        [Parameter(Mandatory)][string] $TargetingPackRoot,
        [Parameter(Mandatory)][string[]] $Properties
    )
    $arguments = @(
        'msbuild', $Project, '-noAutoResponse', '-nologo', '-verbosity:quiet',
        '-nodeReuse:false', '-maxcpucount:1', '-target:ResolveReferences',
        '-getItem:ReferencePath,Analyzer,AdditionalFiles,AnalyzerConfigFiles,EditorConfigFiles,PotentialEditorConfigFiles,GlobalAnalyzerConfigFiles,CompilerResponseFile'
    ) + $Properties
    $text = Invoke-Captured -File $Dotnet -Arguments $arguments -WorkingDirectory $BuildRoot
    $evaluation = ConvertFrom-MsbuildJson -Text $text
    $analyzerProperty = $evaluation.Items.PSObject.Properties['Analyzer']
    $analyzers = @(if ($null -eq $analyzerProperty) {
        @()
    } else {
        @($analyzerProperty.Value)
    })
    if ($analyzers.Count -ne 0) {
        throw 'The effective Analyzer closure must be empty before or after compilation.'
    }
    $referenceProperty = $evaluation.Items.PSObject.Properties['ReferencePath']
    $references = @(if ($null -eq $referenceProperty) {
        @()
    } else {
        @($referenceProperty.Value)
    })
    if ($references.Count -eq 0) { throw 'The effective ReferencePath closure is empty.' }
    $referenceIdentities = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase)
    foreach ($reference in $references) {
        $full = Get-FullPath ([string]$reference.FullPath)
        $rootPrefix = (Get-FullPath $TargetingPackRoot).TrimEnd('\') + '\'
        if (-not $full.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -or
            -not [IO.File]::Exists($full) -or
            ((Get-Item -LiteralPath $full -Force).Attributes -band
                [IO.FileAttributes]::ReparsePoint) -or
            -not $referenceIdentities.Add($full)) {
            throw 'The effective ReferencePath closure escaped or duplicated the derived pack.'
        }
    }
    foreach ($itemName in @(
        'AdditionalFiles', 'AnalyzerConfigFiles', 'EditorConfigFiles',
        'PotentialEditorConfigFiles', 'GlobalAnalyzerConfigFiles', 'CompilerResponseFile'
    )) {
        $itemProperty = $evaluation.Items.PSObject.Properties[$itemName]
        if ($null -ne $itemProperty -and @($itemProperty.Value).Count -ne 0) {
            throw "The effective compiler auxiliary item closure is not empty: $itemName"
        }
    }
}

function Invoke-CandidateRestore {
    param(
        [Parameter(Mandatory)][string] $Dotnet,
        [Parameter(Mandatory)][string] $BuildRoot,
        [Parameter(Mandatory)][string] $CandidateRoot,
        [Parameter(Mandatory)][string] $ObjectRoot,
        [Parameter(Mandatory)][string] $OutputRoot,
        [Parameter(Mandatory)][string] $TempRoot,
        [Parameter(Mandatory)][string] $TargetingPackRoot,
        [Parameter(Mandatory)][string] $PackagesRoot,
        [Parameter(Mandatory)][string] $NugetConfig
    )
    $project = Join-Path $CandidateRoot 'HIDMaestro.Core.csproj'
    $properties = Get-MsbuildProperties -CandidateRoot $CandidateRoot `
        -ObjectRoot $ObjectRoot -OutputRoot $OutputRoot -TempRoot $TempRoot `
        -PackagesRoot $PackagesRoot `
        -NugetConfig $NugetConfig -TargetingPackRoot $TargetingPackRoot
    $restore = @(
        'msbuild', $project, '-noAutoResponse', '-nologo', '-verbosity:minimal',
        '-nodeReuse:false', '-maxcpucount:1', '-target:Restore'
    ) + $properties
    Invoke-Logged -File $Dotnet -Arguments $restore -WorkingDirectory $BuildRoot
    $assets = Join-Path $ObjectRoot 'project.assets.json'
    if (-not [IO.File]::Exists($assets)) { throw 'No project.assets.json was produced.' }
    return [pscustomobject]@{
        Project = $project
        Properties = $properties
        Assets = $assets
    }
}

function Invoke-CandidateBuild {
    param(
        [Parameter(Mandatory)][string] $Dotnet,
        [Parameter(Mandatory)][string] $BuildRoot,
        [Parameter(Mandatory)][string] $Project,
        [Parameter(Mandatory)][string[]] $Properties
    )
    $build = @(
        'msbuild', $Project, '-noAutoResponse', '-nologo', '-verbosity:quiet',
        '-nodeReuse:false', '-maxcpucount:1', '-target:Build', '-p:Restore=false',
        '-getItem:CscCommandLineArgs'
    ) + $Properties
    $text = Invoke-Captured -File $Dotnet -Arguments $build -WorkingDirectory $BuildRoot
    $evaluation = ConvertFrom-MsbuildJson -Text $text
    $argumentsProperty = $evaluation.Items.PSObject.Properties['CscCommandLineArgs']
    $compilerArguments = @(if ($null -eq $argumentsProperty) {
        @()
    } else {
        @($argumentsProperty.Value | ForEach-Object { [string]$_.Identity })
    })
    if ($compilerArguments.Count -eq 0) {
        throw 'The captured logical Csc argument inventory is empty.'
    }
    $analyzerArguments = @($compilerArguments | Where-Object {
        $_ -match '^\s*"?(?i:[/-](?:a|analyzer):)'
    })
    $responseFileArguments = @($compilerArguments | Where-Object {
        $_ -match '^\s*"?@'
    })
    $analyzerConfigArguments = @($compilerArguments | Where-Object {
        $_ -match '^\s*"?(?i:[/-]analyzerconfig:)'
    })
    $additionalFileArguments = @($compilerArguments | Where-Object {
        $_ -match '^\s*"?(?i:[/-]additionalfile:)'
    })
    if ($analyzerArguments.Count -ne 0 -or $responseFileArguments.Count -ne 0 -or
        $analyzerConfigArguments.Count -ne 0 -or $additionalFileArguments.Count -ne 0) {
        throw 'The captured logical Csc arguments contain an analyzer/config/additional-file or explicit response file.'
    }
    return [pscustomobject]@{
        ArgumentCount = $compilerArguments.Count
        CapturedLogicalAnalyzerArgumentCount = 0
        CapturedLogicalAnalyzerConfigArgumentCount = 0
        CapturedLogicalAdditionalFileArgumentCount = 0
        CapturedLogicalResponseFileArgumentCount = 0
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
    $fallbackFolders = @(if (
        $null -ne $assets.project.restore.PSObject.Properties['fallbackFolders']) {
        @($assets.project.restore.fallbackFolders)
    } else { @() })
    if (@($fallbackFolders).Count -ne 0) {
        throw 'Restore fallback-folder closure is not empty.'
    }
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
    if ($libraries.Count -ne 1) {
        throw 'The inspector dependency manifest library count is not one.'
    }
    [string[]]$libraryShape = Get-OrdinalSorted -Values @(
        $libraries[0].Value.PSObject.Properties | ForEach-Object Name)
    if ($libraries[0].Name -cne 'KSX.HIDMaestro.ArtifactInspector/1.0.0') {
        throw 'The inspector dependency manifest project identity is not exact.'
    }
    if ([string]::Join("`n", $libraryShape) -cne
        [string]::Join("`n", (Get-OrdinalSorted -Values @('serviceable', 'sha512', 'type')))) {
        throw 'The inspector dependency manifest project library shape is not exact.'
    }
    if ([string]$libraries[0].Value.type -cne 'project') {
        throw 'The inspector dependency manifest project library type is not exact.'
    }
    if ($libraries[0].Value.serviceable -ne $false) {
        throw 'The inspector dependency manifest project library is serviceable.'
    }
    if ([string]$libraries[0].Value.sha512 -cne '') {
        throw 'The inspector dependency manifest project library SHA-512 is not empty.'
    }
    $targets = @($deps.targets.PSObject.Properties)
    $targetNames = Get-OrdinalSorted -Values @($targets | ForEach-Object Name)
    $expectedTargetNames = Get-OrdinalSorted -Values @(
        '.NETCoreApp,Version=v10.0',
        '.NETCoreApp,Version=v10.0/win-x64')
    if ($targets.Count -ne 2 -or
        [string]::Join("`n", $targetNames) -cne
            [string]::Join("`n", $expectedTargetNames)) {
        throw 'The inspector dependency target-name set is not exact.'
    }
    $portableTarget = @($targets | Where-Object {
        $_.Name -ceq '.NETCoreApp,Version=v10.0'
    })
    $ridTarget = @($targets | Where-Object {
        $_.Name -ceq '.NETCoreApp,Version=v10.0/win-x64'
    })
    if ($portableTarget.Count -ne 1 -or $ridTarget.Count -ne 1) {
        throw 'The inspector dependency target identities are not unique.'
    }
    if (@($portableTarget[0].Value.PSObject.Properties).Count -ne 0) {
        throw 'The inspector dependency portable compile target is not empty.'
    }
    $entries = @($ridTarget[0].Value.PSObject.Properties)
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
    $frameworkDownloadRoot = New-FixedDirectory -RunnerTemp $runnerTemp `
        -Name 'ksx-hm-s15e-framework-download'
    $windowsPackEvidenceRoot = New-FixedDirectory -RunnerTemp $runnerTemp `
        -Name 'ksx-hm-s15e-windows-pack-evidence'
    $targetingPackRoot = New-FixedDirectory -RunnerTemp $runnerTemp `
        -Name 'ksx-hm-s15e-targeting-packs'

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
    $runtimeEvidence = Get-PinnedRuntimeEvidence -Dotnet $dotnet -DotnetRoot $dotnetRoot `
        -WorkingDirectory $environmentRoot `
        -ExpectedVersion ([string]$contract.toolchain.inspectorRuntimeFrameworkVersion) `
        -ExpectedVersionFileByteLength `
            ([long]$contract.toolchain.inspectorRuntimeVersionFileByteLength) `
        -ExpectedVersionFileSha256 `
            ([string]$contract.toolchain.inspectorRuntimeVersionFileSha256) `
        -ExpectedVersionFileLines @($contract.toolchain.inspectorRuntimeVersionFileLines)

    $script:Phase = 'pinned-targeting-pack-overlay'
    $packContract = $contract.targetingPacks
    $corePackContract = $packContract.netCoreAppRef
    $windowsPackContract = $packContract.windowsSdkNetRef
    $sdkPackEvidence = Get-SdkTargetingPackEvidence -DotnetRoot $dotnetRoot `
        -SdkVersion $sdkVersion `
        -ExpectedCorePackVersion ([string]$corePackContract.version) `
        -ExpectedWindowsPackVersion ([string]$windowsPackContract.version) `
        -ExpectedBundledVersionsSha256 `
            ([string]$packContract.installedBundledVersionsSha256) `
        -ExpectedSdkVersionFileByteLength `
            ([long]$packContract.installedSdkVersionByteLength) `
        -ExpectedSdkVersionFileSha256 ([string]$packContract.installedSdkVersionSha256) `
        -ExpectedSdkVersionFileLines @($packContract.installedSdkVersionLines) `
        -ExpectedSdkToolsetVersionFileByteLength `
            ([long]$packContract.installedSdkToolsetVersionByteLength) `
        -ExpectedSdkToolsetVersionFileSha256 `
            ([string]$packContract.installedSdkToolsetVersionSha256) `
        -ExpectedCorePackFileCount ([int]$corePackContract.originalFileCount) `
        -ExpectedCorePackRawByteLength `
            ([long]$corePackContract.originalUncompressedByteLength) `
        -ExpectedCorePackRawTreeSha256 ([string]$corePackContract.originalRawTreeSha256)
    $corePackDestination = Join-Path $targetingPackRoot (
        [string]$corePackContract.packageId + '\' + [string]$corePackContract.version)
    $corePackCopy = Copy-ExactRawTree -SourceRoot $sdkPackEvidence.CoreSourceRoot `
        -DestinationRoot $corePackDestination
    if ($corePackCopy.SourceRawTreeSha256 -cne
            $sdkPackEvidence.CoreSourceRawTreeSha256 -or
        $corePackCopy.FileCount -ne $sdkPackEvidence.CoreSourceFileCount -or
        $corePackCopy.RawByteLength -ne $sdkPackEvidence.CoreSourceRawByteLength) {
        throw 'The isolated core targeting-pack copy is not bound to SDK evidence.'
    }
    $corePackSanitized = ConvertTo-AnalyzerFreeTargetingPack `
        -PackRoot $corePackDestination `
        -ExpectedOriginalFileCount ([int]$corePackContract.originalFileCount) `
        -ExpectedOriginalRawByteLength `
            ([long]$corePackContract.originalUncompressedByteLength) `
        -ExpectedOriginalRawTreeSha256 ([string]$corePackContract.originalRawTreeSha256) `
        -ExpectedOriginalFrameworkListByteLength `
            ([long]$corePackContract.originalFrameworkListByteLength) `
        -ExpectedOriginalFrameworkListSha256 `
            ([string]$corePackContract.originalFrameworkListSha256) `
        -ExpectedAnalyzers @($corePackContract.analyzers) `
        -ExpectedSanitizedFrameworkListByteLength `
            ([long]$corePackContract.sanitizedFrameworkListByteLength) `
        -ExpectedSanitizedFrameworkListSha256 `
            ([string]$corePackContract.sanitizedFrameworkListSha256) `
        -ExpectedSanitizedFileCount ([int]$corePackContract.sanitizedFileCount) `
        -ExpectedSanitizedRawByteLength `
            ([long]$corePackContract.sanitizedRawByteLength) `
        -ExpectedSanitizedRawTreeSha256 `
            ([string]$corePackContract.sanitizedRawTreeSha256)

    $windowsPackagePath = Join-Path $frameworkDownloadRoot `
        'microsoft.windows.sdk.net.ref.10.0.26100.57.nupkg'
    Receive-PinnedFrameworkPack -Uri ([string]$windowsPackContract.downloadUri) `
        -Destination $windowsPackagePath `
        -ExpectedLength ([long]$windowsPackContract.packageByteLength) `
        -ExpectedSha256 ([string]$windowsPackContract.packageSha256)
    $windowsPackagePreSha256 = Get-RawSha256 -Path $windowsPackagePath
    $windowsPackEvidenceDestination = Join-Path $windowsPackEvidenceRoot (
        [string]$windowsPackContract.packageId + '\' + [string]$windowsPackContract.version)
    $windowsPackEvidencePreState = Expand-PinnedWindowsTargetingPack `
        -PackagePath $windowsPackagePath -DestinationRoot $windowsPackEvidenceDestination `
        -ExpectedSha256 ([string]$windowsPackContract.packageSha256) `
        -ExpectedSha512Base64 ([string]$windowsPackContract.packageSha512Base64) `
        -ExpectedEntryCount ([int]$windowsPackContract.archiveEntryCount) `
        -ExpectedUncompressedLength ([long]$windowsPackContract.archiveUncompressedByteLength) `
        -ExpectedRawTreeSha256 ([string]$windowsPackContract.expandedRawTreeSha256)
    $windowsAnalyzerEvidencePath = Join-Path $windowsPackEvidenceDestination (
        ([string]$windowsPackContract.analyzerRelativePath).Replace('/', '\'))
    $windowsReferenceEvidencePath = Join-Path $windowsPackEvidenceDestination (
        ([string]$windowsPackContract.sdkReferenceRelativePath).Replace('/', '\'))
    if ((Get-Item -LiteralPath $windowsAnalyzerEvidencePath -Force).Length -ne
            [long]$windowsPackContract.analyzerByteLength -or
        (Get-RawSha256 -Path $windowsAnalyzerEvidencePath) -cne
            [string]$windowsPackContract.analyzerSha256 -or
        (Get-RawSha256 -Path $windowsReferenceEvidencePath) -cne
            [string]$windowsPackContract.sdkReferenceSha256) {
        throw 'Pinned Windows targeting-pack evidence inputs are not exact.'
    }
    $windowsPackDestination = Join-Path $targetingPackRoot (
        [string]$windowsPackContract.packageId + '\' + [string]$windowsPackContract.version)
    $windowsPackCopy = Copy-ExactRawTree -SourceRoot $windowsPackEvidenceDestination `
        -DestinationRoot $windowsPackDestination
    $windowsExpectedAnalyzers = @([pscustomobject]@{
        path = [string]$windowsPackContract.analyzerRelativePath
        sha256 = [string]$windowsPackContract.analyzerSha256
    })
    $windowsPackSanitized = ConvertTo-AnalyzerFreeTargetingPack `
        -PackRoot $windowsPackDestination `
        -ExpectedOriginalFileCount ([int]$windowsPackContract.archiveEntryCount) `
        -ExpectedOriginalRawByteLength `
            ([long]$windowsPackContract.archiveUncompressedByteLength) `
        -ExpectedOriginalRawTreeSha256 `
            ([string]$windowsPackContract.expandedRawTreeSha256) `
        -ExpectedOriginalFrameworkListByteLength `
            ([long]$windowsPackContract.originalFrameworkListByteLength) `
        -ExpectedOriginalFrameworkListSha256 `
            ([string]$windowsPackContract.originalFrameworkListSha256) `
        -ExpectedAnalyzers $windowsExpectedAnalyzers `
        -ExpectedSanitizedFrameworkListByteLength `
            ([long]$windowsPackContract.sanitizedFrameworkListByteLength) `
        -ExpectedSanitizedFrameworkListSha256 `
            ([string]$windowsPackContract.sanitizedFrameworkListSha256) `
        -ExpectedSanitizedFileCount ([int]$windowsPackContract.sanitizedFileCount) `
        -ExpectedSanitizedRawByteLength `
            ([long]$windowsPackContract.sanitizedRawByteLength) `
        -ExpectedSanitizedRawTreeSha256 `
            ([string]$windowsPackContract.sanitizedRawTreeSha256)
    $windowsReferencePath = Join-Path $windowsPackDestination (
        ([string]$windowsPackContract.sdkReferenceRelativePath).Replace('/', '\'))
    if ((Get-RawSha256 -Path $windowsReferencePath) -cne
        [string]$windowsPackContract.sdkReferenceSha256) {
        throw 'The derived Windows targeting pack changed its reference assembly.'
    }
    $targetingPackPreState = Get-ExactRawTreeState -Root $targetingPackRoot
    if ($targetingPackPreState.FileCount -ne [int]$packContract.overlayFileCount -or
        $targetingPackPreState.RawByteLength -ne [long]$packContract.overlayRawByteLength -or
        $targetingPackPreState.RawTreeSha256 -cne
            [string]$packContract.overlayRawTreeSha256 -or
        $targetingPackPreState.FileCount -ne
            ($corePackSanitized.SanitizedFileCount +
             $windowsPackSanitized.SanitizedFileCount)) {
        throw 'The isolated targeting-pack overlay identity is not exact.'
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
    $stageA = Stage-ExactCandidate -SourceContractRoot $toolRoot -UpstreamRoot $sourceRoot `
        -BuildRoot $buildA -S1dLock $s1d -ProfileLock $profiles `
        -RetainedRawSha256 ([string]$contract.sourceCandidate.retainedSourceRawSha256)
    $stageB = Stage-ExactCandidate -SourceContractRoot $toolRoot -UpstreamRoot $sourceRoot `
        -BuildRoot $buildB -S1dLock $s1d -ProfileLock $profiles `
        -RetainedRawSha256 ([string]$contract.sourceCandidate.retainedSourceRawSha256)
    if ($stageA.RawTreeSha256 -cne $stageB.RawTreeSha256 -or
        $stageA.NormalizedTreeSha256 -cne $stageB.NormalizedTreeSha256) {
        throw 'The two isolated staged trees are not byte-identical.'
    }

    $script:Phase = 'isolated-restore-a'
    Set-IsolatedChildTempRoot -Path $tempA
    $builtA = Invoke-CandidateRestore -Dotnet $dotnet -BuildRoot $buildA `
        -CandidateRoot $stageA.Root -ObjectRoot $objA -OutputRoot $outA `
        -TempRoot $tempA -TargetingPackRoot $targetingPackRoot `
        -PackagesRoot $packagesA -NugetConfig $nugetA
    $script:Phase = 'isolated-restore-b'
    Set-IsolatedChildTempRoot -Path $tempB
    $builtB = Invoke-CandidateRestore -Dotnet $dotnet -BuildRoot $buildB `
        -CandidateRoot $stageB.Root -ObjectRoot $objB -OutputRoot $outB `
        -TempRoot $tempB -TargetingPackRoot $targetingPackRoot `
        -PackagesRoot $packagesB -NugetConfig $nugetB

    $assetsSemanticA = Get-NoPackageAssetsSemantic -AssetsPath $builtA.Assets `
        -PackagesRoot $packagesA -ObjectRoot $objA -NugetConfig $nugetA `
        -OutputPath (Join-Path $reportRoot 'assets-semantic-a.json')
    $assetsSemanticB = Get-NoPackageAssetsSemantic -AssetsPath $builtB.Assets `
        -PackagesRoot $packagesB -ObjectRoot $objB -NugetConfig $nugetB `
        -OutputPath (Join-Path $reportRoot 'assets-semantic-b.json')
    if ($assetsSemanticA.Sha256 -cne $assetsSemanticB.Sha256) {
        throw 'The sanitized no-package assets semantics differ between builds.'
    }

    $evalAPath = Join-Path $reportRoot 'evaluation-pre-a.json'
    $evalBPath = Join-Path $reportRoot 'evaluation-pre-b.json'
    $script:Phase = 'precompile-input-check-a'
    Set-IsolatedChildTempRoot -Path $tempA
    $evaluationA = Get-EvaluatedManifest -Dotnet $dotnet -ProjectPath $builtA.Project `
        -CandidateRoot $stageA.Root -BuildRoot $buildA -DotnetRoot $dotnetRoot `
        -ObjectRoot $objA -OutputRoot $outA -TempRoot $tempA `
        -TargetingPackRoot $targetingPackRoot `
        -CorePackVersion ([string]$corePackContract.version) `
        -WindowsPackVersion ([string]$windowsPackContract.version) `
        -WindowsSdkReferenceSha256 ([string]$windowsPackContract.sdkReferenceSha256) `
        -PackagesRoot $packagesA `
        -Properties $builtA.Properties -ManifestPath $evalAPath
    $script:Phase = 'precompile-input-check-b'
    Set-IsolatedChildTempRoot -Path $tempB
    $evaluationB = Get-EvaluatedManifest -Dotnet $dotnet -ProjectPath $builtB.Project `
        -CandidateRoot $stageB.Root -BuildRoot $buildB -DotnetRoot $dotnetRoot `
        -ObjectRoot $objB -OutputRoot $outB -TempRoot $tempB `
        -TargetingPackRoot $targetingPackRoot `
        -CorePackVersion ([string]$corePackContract.version) `
        -WindowsPackVersion ([string]$windowsPackContract.version) `
        -WindowsSdkReferenceSha256 ([string]$windowsPackContract.sdkReferenceSha256) `
        -PackagesRoot $packagesB `
        -Properties $builtB.Properties -ManifestPath $evalBPath
    if ($evaluationA.Sha256 -cne $evaluationB.Sha256) {
        Write-EvaluationManifestDifference -Label 'pre-a-vs-pre-b' `
            -Left $evaluationA -Right $evaluationB
        throw ('The normalized evaluated compiler-input inventories differ in fields: ' +
            [string]::Join(',', @(
                Get-EvaluationManifestFieldDifferences -Left $evaluationA -Right $evaluationB)))
    }

    $script:Phase = 'isolated-build-a'
    Set-IsolatedChildTempRoot -Path $tempA
    $compilerA = Invoke-CandidateBuild -Dotnet $dotnet -BuildRoot $buildA `
        -Project $builtA.Project -Properties $builtA.Properties
    $candidateBuilt = $true
    $script:Phase = 'isolated-build-b'
    Set-IsolatedChildTempRoot -Path $tempB
    $compilerB = Invoke-CandidateBuild -Dotnet $dotnet -BuildRoot $buildB `
        -Project $builtB.Project -Properties $builtB.Properties
    if ($compilerA.CapturedLogicalAnalyzerArgumentCount -ne 0 -or
        $compilerB.CapturedLogicalAnalyzerArgumentCount -ne 0 -or
        $compilerA.CapturedLogicalAnalyzerConfigArgumentCount -ne 0 -or
        $compilerB.CapturedLogicalAnalyzerConfigArgumentCount -ne 0 -or
        $compilerA.CapturedLogicalAdditionalFileArgumentCount -ne 0 -or
        $compilerB.CapturedLogicalAdditionalFileArgumentCount -ne 0 -or
        $compilerA.CapturedLogicalResponseFileArgumentCount -ne 0 -or
        $compilerB.CapturedLogicalResponseFileArgumentCount -ne 0) {
        throw 'A compiler invocation escaped the analyzer/response-file closure.'
    }

    $script:Phase = 'postcompile-input-check-a'
    Set-IsolatedChildTempRoot -Path $tempA
    $evaluationPostA = Get-EvaluatedManifest -Dotnet $dotnet -ProjectPath $builtA.Project `
        -CandidateRoot $stageA.Root -BuildRoot $buildA -DotnetRoot $dotnetRoot `
        -ObjectRoot $objA -OutputRoot $outA -TempRoot $tempA `
        -TargetingPackRoot $targetingPackRoot `
        -CorePackVersion ([string]$corePackContract.version) `
        -WindowsPackVersion ([string]$windowsPackContract.version) `
        -WindowsSdkReferenceSha256 ([string]$windowsPackContract.sdkReferenceSha256) `
        -PackagesRoot $packagesA -Properties $builtA.Properties `
        -ManifestPath (Join-Path $reportRoot 'evaluation-post-a.json')
    $script:Phase = 'postcompile-input-check-b'
    Set-IsolatedChildTempRoot -Path $tempB
    $evaluationPostB = Get-EvaluatedManifest -Dotnet $dotnet -ProjectPath $builtB.Project `
        -CandidateRoot $stageB.Root -BuildRoot $buildB -DotnetRoot $dotnetRoot `
        -ObjectRoot $objB -OutputRoot $outB -TempRoot $tempB `
        -TargetingPackRoot $targetingPackRoot `
        -CorePackVersion ([string]$corePackContract.version) `
        -WindowsPackVersion ([string]$windowsPackContract.version) `
        -WindowsSdkReferenceSha256 ([string]$windowsPackContract.sdkReferenceSha256) `
        -PackagesRoot $packagesB -Properties $builtB.Properties `
        -ManifestPath (Join-Path $reportRoot 'evaluation-post-b.json')
    if ($evaluationPostA.Sha256 -cne $evaluationA.Sha256 -or
        $evaluationPostB.Sha256 -cne $evaluationB.Sha256 -or
        $evaluationPostA.Sha256 -cne $evaluationPostB.Sha256) {
        if ($evaluationPostA.Sha256 -cne $evaluationA.Sha256) {
            Write-EvaluationManifestDifference -Label 'post-a-vs-pre-a' `
                -Left $evaluationPostA -Right $evaluationA
        }
        if ($evaluationPostB.Sha256 -cne $evaluationB.Sha256) {
            Write-EvaluationManifestDifference -Label 'post-b-vs-pre-b' `
                -Left $evaluationPostB -Right $evaluationB
        }
        if ($evaluationPostA.Sha256 -cne $evaluationPostB.Sha256) {
            Write-EvaluationManifestDifference -Label 'post-a-vs-post-b' `
                -Left $evaluationPostA -Right $evaluationPostB
        }
        throw 'The analyzer-free compiler-input closure changed across compilation.'
    }

    $expectedOutputs = @($contract.expectedOutputBasenames | ForEach-Object { [string]$_ })
    Assert-OutputClosure -OutputRoot $outA -ExpectedBasenames $expectedOutputs
    Assert-OutputClosure -OutputRoot $outB -ExpectedBasenames $expectedOutputs

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
    Assert-ExactFileSet -Root $sdkPackEvidence.CoreSourceRoot `
        -Expected $sdkPackEvidence.CoreSourceRelativePaths
    $coreSourcePostState = Get-ExactRawTreeState -Root $sdkPackEvidence.CoreSourceRoot
    Assert-ExactFileSet -Root $windowsPackEvidenceDestination `
        -Expected $windowsPackEvidencePreState.RelativePaths
    $windowsPackEvidencePostState = Get-ExactRawTreeState -Root $windowsPackEvidenceDestination
    Assert-ExactFileSet -Root $targetingPackRoot `
        -Expected $targetingPackPreState.RelativePaths
    $targetingPackPostState = Get-ExactRawTreeState -Root $targetingPackRoot
    if ($coreSourcePostState.FileCount -ne [int]$corePackContract.originalFileCount -or
        $coreSourcePostState.RawByteLength -ne
            [long]$corePackContract.originalUncompressedByteLength -or
        $coreSourcePostState.RawTreeSha256 -cne
            [string]$corePackContract.originalRawTreeSha256 -or
        $windowsPackEvidencePostState.FileCount -ne
            [int]$windowsPackContract.archiveEntryCount -or
        $windowsPackEvidencePostState.RawByteLength -ne
            [long]$windowsPackContract.archiveUncompressedByteLength -or
        $windowsPackEvidencePostState.RawTreeSha256 -cne
            [string]$windowsPackContract.expandedRawTreeSha256 -or
        $targetingPackPostState.FileCount -ne [int]$packContract.overlayFileCount -or
        $targetingPackPostState.RawByteLength -ne [long]$packContract.overlayRawByteLength -or
        $targetingPackPostState.RawTreeSha256 -cne
            [string]$packContract.overlayRawTreeSha256 -or
        (Get-RawSha256 -Path $sdkPackEvidence.SdkVersionFilePath) -cne
            $sdkPackEvidence.SdkVersionFileSha256 -or
        (Get-RawSha256 -Path $sdkPackEvidence.SdkToolsetVersionFilePath) -cne
            $sdkPackEvidence.SdkToolsetVersionFileSha256 -or
        (Get-RawSha256 -Path $sdkPackEvidence.BundledVersionsPath) -cne
            $sdkPackEvidence.BundledVersionsSha256 -or
        (Get-RawSha256 -Path $windowsPackagePath) -cne $windowsPackagePreSha256) {
        throw 'A source/evidence/derived targeting-pack tree changed during candidate builds.'
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
        -NugetConfig $nugetInspector -TargetingPackRoot $targetingPackRoot
    Invoke-Logged -File $dotnet -Arguments (@(
        'msbuild', $inspectorProject, '-noAutoResponse', '-nologo', '-verbosity:minimal',
        '-nodeReuse:false', '-maxcpucount:1', '-target:Restore'
    ) + $inspectorProps) -WorkingDirectory $inspectorRoot
    Assert-EmptyEvaluatedAnalyzerClosure -Dotnet $dotnet -Project $inspectorProject `
        -BuildRoot $inspectorRoot -TargetingPackRoot $targetingPackRoot `
        -Properties $inspectorProps
    $inspectorCompiler = Invoke-CandidateBuild -Dotnet $dotnet -BuildRoot $inspectorRoot `
        -Project $inspectorProject -Properties $inspectorProps
    if ($inspectorCompiler.CapturedLogicalAnalyzerArgumentCount -ne 0 -or
        $inspectorCompiler.CapturedLogicalAnalyzerConfigArgumentCount -ne 0 -or
        $inspectorCompiler.CapturedLogicalAdditionalFileArgumentCount -ne 0 -or
        $inspectorCompiler.CapturedLogicalResponseFileArgumentCount -ne 0) {
        throw 'The inspector compiler escaped the analyzer/response-file closure.'
    }
    Assert-EmptyEvaluatedAnalyzerClosure -Dotnet $dotnet -Project $inspectorProject `
        -BuildRoot $inspectorRoot -TargetingPackRoot $targetingPackRoot `
        -Properties $inspectorProps
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
    Assert-ExactFileSet -Root $runtimeEvidence.Root -Expected $runtimeEvidence.RelativePaths
    $runtimePreLaunchState = Get-ExactRawTreeState -Root $runtimeEvidence.Root
    if ($runtimePreLaunchState.RawTreeSha256 -cne $runtimeEvidence.PreRawTreeSha256 -or
        $runtimePreLaunchState.RawByteLength -ne $runtimeEvidence.RawByteLength) {
        throw 'The exact inspector runtime changed before launch.'
    }

    Assert-ExactFileSet -Root $sdkPackEvidence.CoreSourceRoot `
        -Expected $sdkPackEvidence.CoreSourceRelativePaths
    $coreSourcePostState = Get-ExactRawTreeState -Root $sdkPackEvidence.CoreSourceRoot
    Assert-ExactFileSet -Root $windowsPackEvidenceDestination `
        -Expected $windowsPackEvidencePreState.RelativePaths
    $windowsPackEvidencePostState = Get-ExactRawTreeState -Root $windowsPackEvidenceDestination
    Assert-ExactFileSet -Root $targetingPackRoot `
        -Expected $targetingPackPreState.RelativePaths
    $targetingPackPostState = Get-ExactRawTreeState -Root $targetingPackRoot
    if ($coreSourcePostState.FileCount -ne [int]$corePackContract.originalFileCount -or
        $coreSourcePostState.RawByteLength -ne
            [long]$corePackContract.originalUncompressedByteLength -or
        $coreSourcePostState.RawTreeSha256 -cne
            [string]$corePackContract.originalRawTreeSha256 -or
        $windowsPackEvidencePostState.FileCount -ne
            [int]$windowsPackContract.archiveEntryCount -or
        $windowsPackEvidencePostState.RawByteLength -ne
            [long]$windowsPackContract.archiveUncompressedByteLength -or
        $windowsPackEvidencePostState.RawTreeSha256 -cne
            [string]$windowsPackContract.expandedRawTreeSha256 -or
        $targetingPackPostState.FileCount -ne [int]$packContract.overlayFileCount -or
        $targetingPackPostState.RawByteLength -ne [long]$packContract.overlayRawByteLength -or
        $targetingPackPostState.RawTreeSha256 -cne
            [string]$packContract.overlayRawTreeSha256 -or
        (Get-RawSha256 -Path $sdkPackEvidence.SdkVersionFilePath) -cne
            $sdkPackEvidence.SdkVersionFileSha256 -or
        (Get-RawSha256 -Path $sdkPackEvidence.SdkToolsetVersionFilePath) -cne
            $sdkPackEvidence.SdkToolsetVersionFileSha256 -or
        (Get-RawSha256 -Path $sdkPackEvidence.BundledVersionsPath) -cne
            $sdkPackEvidence.BundledVersionsSha256 -or
        (Get-RawSha256 -Path $windowsPackagePath) -cne $windowsPackagePreSha256) {
        throw 'A source/evidence/derived targeting-pack tree changed during observation.'
    }
    foreach ($path in @(
        $frameworkDownloadRoot, $windowsPackEvidenceRoot, $targetingPackRoot
    )) {
        Remove-FixedTree -RunnerTemp $runnerTemp -Path $path
    }

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
    Assert-ExactFileSet -Root $runtimeEvidence.Root -Expected $runtimeEvidence.RelativePaths
    $runtimePostLaunchState = Get-ExactRawTreeState -Root $runtimeEvidence.Root
    if ($runtimePostLaunchState.RawTreeSha256 -cne $runtimeEvidence.PreRawTreeSha256 -or
        $runtimePostLaunchState.RawByteLength -ne $runtimeEvidence.RawByteLength) {
        throw 'The exact inspector runtime changed during byte-only inspection.'
    }
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
        targetingPacks = [ordered]@{
            sdkVersionFileSha256 = $sdkPackEvidence.SdkVersionFileSha256
            sdkToolsetVersionFileSha256 = $sdkPackEvidence.SdkToolsetVersionFileSha256
            sdkBundledVersionsSha256 = $sdkPackEvidence.BundledVersionsSha256
            netCoreAppRefVersion = [string]$corePackContract.version
            netCoreAppRefOriginalFileCount = $corePackCopy.FileCount
            netCoreAppRefOriginalRawByteLength = $corePackCopy.RawByteLength
            netCoreAppRefSourcePreRawTreeSha256 = $sdkPackEvidence.CoreSourceRawTreeSha256
            netCoreAppRefSourcePostRawByteLength = $coreSourcePostState.RawByteLength
            netCoreAppRefSourcePostRawTreeSha256 = $coreSourcePostState.RawTreeSha256
            netCoreAppRefOriginalFrameworkListByteLength =
                $corePackSanitized.OriginalFrameworkListByteLength
            netCoreAppRefOriginalFrameworkListSha256 =
                $corePackSanitized.OriginalFrameworkListSha256
            netCoreAppRefSanitizedFileCount = $corePackSanitized.SanitizedFileCount
            netCoreAppRefSanitizedRawByteLength = $corePackSanitized.SanitizedRawByteLength
            netCoreAppRefSanitizedFrameworkListByteLength =
                $corePackSanitized.SanitizedFrameworkListByteLength
            netCoreAppRefSanitizedFrameworkListSha256 =
                $corePackSanitized.SanitizedFrameworkListSha256
            netCoreAppRefSanitizedRawTreeSha256 = $corePackSanitized.SanitizedRawTreeSha256
            netCoreAppRefRemovedAnalyzers = $corePackSanitized.RemovedAnalyzers
            windowsSdkNetRefVersion = [string]$windowsPackContract.version
            windowsPackageSha256 = $windowsPackagePreSha256
            windowsEvidenceFileCount = $windowsPackEvidencePreState.FileCount
            windowsEvidenceRawByteLength = $windowsPackEvidencePreState.RawByteLength
            windowsEvidencePreRawTreeSha256 = $windowsPackEvidencePreState.RawTreeSha256
            windowsEvidencePostRawByteLength = $windowsPackEvidencePostState.RawByteLength
            windowsEvidencePostRawTreeSha256 = $windowsPackEvidencePostState.RawTreeSha256
            windowsOriginalFrameworkListByteLength =
                $windowsPackSanitized.OriginalFrameworkListByteLength
            windowsOriginalFrameworkListSha256 =
                $windowsPackSanitized.OriginalFrameworkListSha256
            windowsSanitizedFileCount = $windowsPackSanitized.SanitizedFileCount
            windowsSanitizedRawByteLength = $windowsPackSanitized.SanitizedRawByteLength
            windowsSanitizedFrameworkListByteLength =
                $windowsPackSanitized.SanitizedFrameworkListByteLength
            windowsSanitizedFrameworkListSha256 =
                $windowsPackSanitized.SanitizedFrameworkListSha256
            windowsSanitizedRawTreeSha256 = $windowsPackSanitized.SanitizedRawTreeSha256
            windowsRemovedAnalyzers = $windowsPackSanitized.RemovedAnalyzers
            overlayFileCount = $targetingPackPreState.FileCount
            overlayRawByteLength = $targetingPackPreState.RawByteLength
            overlayPreRawTreeSha256 = $targetingPackPreState.RawTreeSha256
            overlayPostFileCount = $targetingPackPostState.FileCount
            overlayPostRawByteLength = $targetingPackPostState.RawByteLength
            overlayPostRawTreeSha256 = $targetingPackPostState.RawTreeSha256
            effectiveCompilerAnalyzerItemCount = 0
            capturedLogicalCscAnalyzerArgumentCount = 0
            capturedLogicalCscAnalyzerConfigArgumentCount = 0
            capturedLogicalCscAdditionalFileArgumentCount = 0
            capturedLogicalCscResponseFileArgumentCount = 0
            effectiveCompilerAuxiliaryItemCount = 0
            sourceGeneratorExecutionAuthorized = $false
            analyzerClosureCheckedPreAndPostForCandidateAndInspector = $true
            candidatePackageDownloadFallbacksDisabled = $true
            candidatePackageSourcesConfigured = 0
            workloadResolverEnabled = $false
            candidateNetworkAuthorized = $false
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
            evaluatedCompilerInputsStableAfterBuild =
                ($evaluationPostA.Sha256 -ceq $evaluationA.Sha256 -and
                 $evaluationPostB.Sha256 -ceq $evaluationB.Sha256)
            candidateCscArgumentCounts = @($compilerA.ArgumentCount, $compilerB.ArgumentCount)
            inspectorCscArgumentCount = $inspectorCompiler.ArgumentCount
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
        inspectorRuntime = [ordered]@{
            version = $runtimeEvidence.Version
            fileCount = $runtimeEvidence.FileCount
            rawByteLength = $runtimeEvidence.RawByteLength
            versionFileSha256 = $runtimeEvidence.VersionFileSha256
            preRawTreeSha256 = $runtimeEvidence.PreRawTreeSha256
            preLaunchRawTreeSha256 = $runtimePreLaunchState.RawTreeSha256
            postLaunchRawTreeSha256 = $runtimePostLaunchState.RawTreeSha256
            pathRedacted = $true
        }
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
