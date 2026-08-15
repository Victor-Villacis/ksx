[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $SourceRoot,

    [string] $ManifestPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrEmpty($ManifestPath)) {
    $ManifestPath = Join-Path $PSScriptRoot 'catalog.lock.json'
}

$Utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$PathComparison = if ([IO.Path]::DirectorySeparatorChar -eq '\') {
    [StringComparison]::OrdinalIgnoreCase
} else {
    [StringComparison]::Ordinal
}

function Assert-Contract {
    param(
        [bool] $Condition,
        [string] $Message
    )

    if (!$Condition) {
        throw $Message
    }
}

function Get-Sha256 {
    param([byte[]] $Bytes)

    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return [BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-', '')
    } finally {
        $sha.Dispose()
    }
}

function Get-CanonicalBytes {
    param([string] $LiteralPath)

    [byte[]] $bytes = [IO.File]::ReadAllBytes($LiteralPath)
    $text = $Utf8Strict.GetString($bytes).Replace("`r`n", "`n")
    Assert-Contract ($text.IndexOf("`r", [StringComparison]::Ordinal) -lt 0) `
        "Bare carriage return in source file: $LiteralPath"
    [byte[]] $canonical = $Utf8NoBom.GetBytes($text)
    return ,$canonical
}

function Convert-DescriptorHex {
    param(
        [string] $Text,
        [string] $ProfilePath
    )

    $compact = [regex]::Replace($Text, '\s', '')
    Assert-Contract ($compact.Length -gt 0) `
        "Empty descriptor after whitespace removal: $ProfilePath"
    Assert-Contract (($compact.Length % 2) -eq 0) `
        "Odd-length descriptor: $ProfilePath"
    Assert-Contract ($compact -cmatch '^[0-9A-Fa-f]+$') `
        "Non-hexadecimal descriptor: $ProfilePath"

    [byte[]] $bytes = @(
        for ($index = 0; $index -lt $compact.Length; $index += 2) {
            [Convert]::ToByte($compact.Substring($index, 2), 16)
        }
    )
    return ,$bytes
}

function Add-CatalogFrame {
    param(
        [IO.Stream] $Stream,
        [string] $Path,
        [byte[]] $Bytes
    )

    [byte[]] $pathBytes = $Utf8NoBom.GetBytes($Path)
    $Stream.Write($pathBytes, 0, $pathBytes.Length)
    $Stream.WriteByte(0)
    $Stream.Write($Bytes, 0, $Bytes.Length)
    $Stream.WriteByte(0)
}

function Sort-Ordinal {
    param([string[]] $Values)

    [string[]] $copy = @($Values)
    [Array]::Sort($copy, [StringComparer]::Ordinal)
    return ,$copy
}

function Assert-StringArraysEqual {
    param(
        [string[]] $Expected,
        [string[]] $Actual,
        [string] $Label
    )

    Assert-Contract ($Expected.Count -eq $Actual.Count) `
        "$Label count mismatch: expected $($Expected.Count), got $($Actual.Count)."
    for ($index = 0; $index -lt $Expected.Count; $index++) {
        Assert-Contract ($Expected[$index] -ceq $Actual[$index]) `
            "$Label mismatch at index ${index}: expected '$($Expected[$index])', got '$($Actual[$index])'."
    }
}

$report = $null
try {
    $sourceRootFull = [IO.Path]::GetFullPath($SourceRoot).TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar)
    Assert-Contract ([IO.Directory]::Exists($sourceRootFull)) `
        "Source root does not exist: $sourceRootFull"
    $sourceRootItem = Get-Item -LiteralPath $sourceRootFull -Force
    Assert-Contract (($sourceRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) `
        'Source root must not be a reparse point.'
    $sourcePrefix = $sourceRootFull + [IO.Path]::DirectorySeparatorChar

    $manifestFull = [IO.Path]::GetFullPath($ManifestPath)
    Assert-Contract ([IO.File]::Exists($manifestFull)) `
        "Manifest does not exist: $manifestFull"
    [byte[]] $manifestBytes = [IO.File]::ReadAllBytes($manifestFull)
    $manifestText = $Utf8Strict.GetString($manifestBytes).Replace("`r`n", "`n")
    Assert-Contract ($manifestText.IndexOf("`r", [StringComparison]::Ordinal) -lt 0) `
        'Manifest contains a bare carriage return.'
    [byte[]] $manifestCanonicalBytes = $Utf8NoBom.GetBytes($manifestText)
    if ($manifestText.Length -gt 0 -and $manifestText[0] -eq [char]0xFEFF) {
        $manifestText = $manifestText.Substring(1)
    }
    $manifest = $manifestText | ConvertFrom-Json

    Assert-Contract ($manifest.schemaVersion -eq 1) 'Unexpected manifest schema version.'
    Assert-Contract ($manifest.repository -ceq 'https://github.com/hifihedgehog/HIDMaestro') `
        'Unexpected upstream repository.'
    Assert-Contract ($manifest.tag -ceq 'v1.6.1') 'Unexpected upstream tag.'
    Assert-Contract ($manifest.commit -ceq '2a0dac0857901a63d365a36dcf99cf50114ca954') `
        'Unexpected upstream commit.'
    Assert-Contract ($manifest.selection.include -ceq 'profiles/**/*.json') `
        'Unexpected profile include rule.'
    Assert-Contract ($manifest.selection.logicalNameTemplateLiteral -ceq `
        'HIDMaestro.Profiles.%(RecursiveDir)%(Filename)%(Extension)') `
        'Unexpected profile logical-name template.'
    Assert-Contract ($manifest.canonicalization.hashAlgorithm -ceq 'SHA-256') `
        'Unexpected source hash algorithm.'
    Assert-Contract ($manifest.canonicalization.content -ceq `
        'strict UTF-8; preserve an existing UTF-8 BOM; replace CRLF with LF; reject bare CR') `
        'Unexpected source-byte canonicalization.'

    [string[]] $expectedExclusions = @(
        'profiles/linux-kernel-fixed-descriptors.json',
        'profiles/schema.json',
        'profiles/scraped_descriptors.json'
    )
    [string[]] $manifestExclusions = Sort-Ordinal @($manifest.selection.exclude | ForEach-Object { [string] $_ })
    Assert-StringArraysEqual $expectedExclusions $manifestExclusions 'Exclusion list'

    Assert-Contract ($manifest.counts.profileTreeFileCount -eq 231) `
        'Manifest profile-tree count must remain 231.'
    Assert-Contract ($manifest.counts.vendorDirectoryCount -eq 32) `
        'Manifest vendor-directory count must remain 32.'
    Assert-Contract ($manifest.counts.embeddedProfileSourceCount -eq 228) `
        'Manifest embedded-profile count must remain 228.'
    Assert-Contract ($manifest.counts.excludedProfileDataCount -eq 3) `
        'Manifest excluded-data count must remain 3.'
    Assert-Contract ($manifest.counts.deployableEmbeddedProfileSourceCount -eq 130) `
        'Manifest deployable-profile count must remain 130.'
    Assert-Contract ($manifest.counts.duplicateProfileIdCount -eq 0) `
        'Manifest duplicate-ID count must remain zero.'
    Assert-Contract ($manifest.sourceCatalogs.allProfileTree.entryCount -eq 231) `
        'All-source catalog entry count must remain 231.'
    Assert-Contract ($manifest.sourceCatalogs.embeddedProfileSources.entryCount -eq 228) `
        'Embedded-source catalog entry count must remain 228.'
    Assert-Contract ($manifest.sourceCatalogs.embeddedProfileSources.deployableCount -eq 130) `
        'Embedded-source deployable count must remain 130.'

    Assert-Contract ($manifest.releaseDllComparison.resourceCount -eq 228) `
        'Release comparison resource count drifted.'
    Assert-Contract ($manifest.releaseDllComparison.deployableCount -eq 130) `
        'Release comparison deployable count drifted.'
    Assert-Contract ($manifest.releaseDllComparison.catalogSha256 -ceq `
        '8F407E6E1C3C241E16CF6BEF387216AD4D1F5DE055A2C4CC041CA16CE7954A6A') `
        'Release comparison catalog digest drifted.'
    Assert-Contract ($manifest.releaseDllComparison.sourceToReleaseCatalogBinding -ceq 'unresolved') `
        'This source-only slice must not claim a release catalog binding.'
    Assert-Contract ($manifest.releaseDllComparison.catalogSha256ReproducedFromSource -eq $false) `
        'This source-only slice must not claim it reproduced the release digest.'
    Assert-Contract ($manifest.releaseDllComparison.verifierInspectsReleaseDll -eq $false) `
        'The source verifier must not claim to inspect a release DLL.'

    $evidenceByPath = @{}
    $sourceEvidence = @($manifest.sourceEvidence)
    Assert-Contract ($sourceEvidence.Count -eq 2) `
        "Source-evidence list must contain two entries; found $($sourceEvidence.Count)."
    foreach ($evidence in $sourceEvidence) {
        $evidenceByPath[[string] $evidence.path] = $evidence
    }
    [string[]] $expectedEvidence = @(
        'sdk/HIDMaestro.Core/HIDMaestro.Core.csproj',
        'sdk/HIDMaestro.Core/Internal/ControllerProfile.cs'
    )
    [string[]] $evidencePaths = Sort-Ordinal @($evidenceByPath.Keys | ForEach-Object { [string] $_ })
    Assert-StringArraysEqual $expectedEvidence $evidencePaths 'Source-evidence path list'

    $evidenceTexts = @{}
    foreach ($evidencePath in $expectedEvidence) {
        $nativeEvidencePath = $evidencePath.Replace('/', [IO.Path]::DirectorySeparatorChar)
        $evidenceFull = [IO.Path]::GetFullPath((Join-Path $sourceRootFull $nativeEvidencePath))
        Assert-Contract ($evidenceFull.StartsWith($sourcePrefix, $PathComparison)) `
            "Evidence path escaped source root: $evidencePath"
        Assert-Contract ([IO.File]::Exists($evidenceFull)) `
            "Missing source-evidence file: $evidencePath"
        $evidenceItem = Get-Item -LiteralPath $evidenceFull -Force
        Assert-Contract (($evidenceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) `
            "Source-evidence file is a reparse point: $evidencePath"
        [byte[]] $canonicalEvidence = Get-CanonicalBytes $evidenceFull
        $evidence = $evidenceByPath[$evidencePath]
        Assert-Contract ($canonicalEvidence.Length -eq [int] $evidence.canonicalByteLength) `
            "Source-evidence byte length drifted: $evidencePath"
        Assert-Contract ((Get-Sha256 $canonicalEvidence) -ceq [string] $evidence.canonicalSha256) `
            "Source-evidence SHA-256 drifted: $evidencePath"
        $evidenceTexts[$evidencePath] = $Utf8Strict.GetString($canonicalEvidence)
    }

    $projectText = [string] $evidenceTexts['sdk/HIDMaestro.Core/HIDMaestro.Core.csproj']
    Assert-Contract ($projectText.IndexOf(
        '<EmbeddedResource Include="..\..\profiles\**\*.json"',
        [StringComparison]::Ordinal) -ge 0) 'Pinned project no longer contains the profile include.'
    Assert-Contract ($projectText.IndexOf(
        'Exclude="..\..\profiles\schema.json;..\..\profiles\scraped_descriptors.json;..\..\profiles\linux-kernel-fixed-descriptors.json">',
        [StringComparison]::Ordinal) -ge 0) 'Pinned project no longer contains the exact exclusions.'
    Assert-Contract ($projectText.IndexOf(
        '<LogicalName>HIDMaestro.Profiles.%(RecursiveDir)%(Filename)%(Extension)</LogicalName>',
        [StringComparison]::Ordinal) -ge 0) 'Pinned project no longer contains the logical-name template.'

    $controllerText = [string] $evidenceTexts['sdk/HIDMaestro.Core/Internal/ControllerProfile.cs']
    Assert-Contract ($controllerText.IndexOf(
        'public bool HasDescriptor => !string.IsNullOrEmpty(Descriptor);',
        [StringComparison]::Ordinal) -ge 0) 'Pinned source no longer contains the HasDescriptor rule.'

    $profilesRoot = Join-Path $sourceRootFull 'profiles'
    Assert-Contract ([IO.Directory]::Exists($profilesRoot)) 'Pinned source has no profiles directory.'
    $profilesRootItem = Get-Item -LiteralPath $profilesRoot -Force
    Assert-Contract (($profilesRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) `
        'Profiles directory must not be a reparse point.'

    $treeItems = @(Get-ChildItem -LiteralPath $profilesRoot -Recurse -Force)
    foreach ($treeItem in $treeItems) {
        Assert-Contract (($treeItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) `
            "Profile tree contains a reparse point: $($treeItem.FullName)"
    }
    $actualFiles = @($treeItems | Where-Object { !$_.PSIsContainer })
    [string[]] $actualPaths = @($actualFiles | ForEach-Object {
        Assert-Contract ($_.FullName.StartsWith($sourcePrefix, $PathComparison)) `
            "Profile path escaped source root: $($_.FullName)"
        $_.FullName.Substring($sourcePrefix.Length).Replace('\', '/')
    })
    $actualPaths = Sort-Ordinal $actualPaths

    $entries = @($manifest.entries)
    Assert-Contract ($entries.Count -eq 231) `
        "Manifest must contain 231 entries; found $($entries.Count)."
    [string[]] $manifestPaths = @($entries | ForEach-Object { [string] $_.path })
    $sortedManifestPaths = Sort-Ordinal $manifestPaths
    Assert-StringArraysEqual $sortedManifestPaths $manifestPaths 'Manifest ordinal ordering'
    Assert-StringArraysEqual $manifestPaths $actualPaths 'Complete profile-tree inventory'

    [Collections.Generic.HashSet[string]] $excludedSet = `
        New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    $expectedExclusionReasons = @{
        'profiles/linux-kernel-fixed-descriptors.json' = 'linux-kernel-descriptor-reference'
        'profiles/schema.json' = 'json-schema'
        'profiles/scraped_descriptors.json' = 'scraped-descriptor-reference'
    }
    foreach ($excludedPath in $expectedExclusions) {
        [void] $excludedSet.Add($excludedPath)
    }
    [Collections.Generic.HashSet[string]] $profileIds = `
        New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)

    $allCatalog = New-Object IO.MemoryStream
    $embeddedCatalog = New-Object IO.MemoryStream
    $embeddedCount = 0
    $deployableCount = 0
    try {
        foreach ($entry in $entries) {
            $entryPath = [string] $entry.path
            Assert-Contract ($entryPath -cmatch '^profiles/[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*\.json$') `
                "Non-canonical manifest path: $entryPath"
            $nativeEntryPath = $entryPath.Replace('/', [IO.Path]::DirectorySeparatorChar)
            $entryFull = [IO.Path]::GetFullPath((Join-Path $sourceRootFull $nativeEntryPath))
            Assert-Contract ($entryFull.StartsWith($sourcePrefix, $PathComparison)) `
                "Manifest entry escaped source root: $entryPath"
            Assert-Contract ([IO.File]::Exists($entryFull)) "Missing profile source: $entryPath"

            [byte[]] $canonical = Get-CanonicalBytes $entryFull
            Assert-Contract ($canonical.Length -eq [int] $entry.canonicalByteLength) `
                "Canonical byte length drifted: $entryPath"
            Assert-Contract ((Get-Sha256 $canonical) -ceq [string] $entry.canonicalSha256) `
                "Canonical SHA-256 drifted: $entryPath"
            Add-CatalogFrame $allCatalog $entryPath $canonical

            $sourceText = $Utf8Strict.GetString($canonical)
            if ($sourceText.Length -gt 0 -and $sourceText[0] -eq [char]0xFEFF) {
                $sourceText = $sourceText.Substring(1)
            }
            $profileJson = $sourceText | ConvertFrom-Json
            $isExcluded = $excludedSet.Contains($entryPath)
            if ($isExcluded) {
                Assert-Contract ($entry.classification -ceq 'excluded-profile-data') `
                    "Excluded entry classification drifted: $entryPath"
                Assert-Contract ($entry.exclusionReason -ceq $expectedExclusionReasons[$entryPath]) `
                    "Excluded entry reason drifted: $entryPath"
                Assert-Contract ($null -eq $entry.profileId) `
                    "Excluded entry unexpectedly has a profile ID: $entryPath"
                Assert-Contract ($entry.deployable -eq $false) `
                    "Excluded entry unexpectedly marked deployable: $entryPath"
                Assert-Contract ($null -eq $entry.descriptorByteLength -and $null -eq $entry.descriptorSha256) `
                    "Excluded entry unexpectedly pins a descriptor: $entryPath"
                continue
            }

            $embeddedCount++
            Add-CatalogFrame $embeddedCatalog $entryPath $canonical
            Assert-Contract ($entry.classification -ceq 'embedded-profile-source') `
                "Embedded entry classification drifted: $entryPath"
            $idProperty = $profileJson.PSObject.Properties['id']
            Assert-Contract ($null -ne $idProperty -and -not [string]::IsNullOrEmpty([string] $profileJson.id)) `
                "Embedded profile has no ID: $entryPath"
            $profileId = [string] $profileJson.id
            Assert-Contract ($profileIds.Add($profileId)) "Duplicate profile ID: $profileId"
            Assert-Contract ($entry.profileId -ceq $profileId) "Profile ID drifted: $entryPath"

            $descriptorProperty = $profileJson.PSObject.Properties['descriptor']
            $hasDescriptor = $null -ne $descriptorProperty -and `
                $null -ne $profileJson.descriptor -and `
                -not [string]::IsNullOrEmpty([string] $profileJson.descriptor)
            Assert-Contract ($entry.deployable -eq $hasDescriptor) `
                "Deployability drifted: $entryPath"
            if ($hasDescriptor) {
                [byte[]] $descriptor = Convert-DescriptorHex ([string] $profileJson.descriptor) $entryPath
                $deployableCount++
                Assert-Contract ($descriptor.Length -eq [int] $entry.descriptorByteLength) `
                    "Descriptor byte length drifted: $entryPath"
                Assert-Contract ((Get-Sha256 $descriptor) -ceq [string] $entry.descriptorSha256) `
                    "Descriptor SHA-256 drifted: $entryPath"
            } else {
                Assert-Contract ($null -eq $entry.descriptorByteLength -and $null -eq $entry.descriptorSha256) `
                    "Undeployable entry unexpectedly pins a descriptor: $entryPath"
            }
        }

        Assert-Contract ($embeddedCount -eq 228) `
            "Embedded source count mismatch: expected 228, got $embeddedCount."
        Assert-Contract ($deployableCount -eq 130) `
            "Deployable source count mismatch: expected 130, got $deployableCount."
        Assert-Contract ($profileIds.Count -eq 228) `
            "Unique profile ID count mismatch: expected 228, got $($profileIds.Count)."

        $vendorDirectories = @(Get-ChildItem -LiteralPath $profilesRoot -Directory -Force)
        [string[]] $actualVendorNames = Sort-Ordinal @($vendorDirectories | ForEach-Object { $_.Name })
        [string[]] $expectedVendorNames = Sort-Ordinal @($manifest.vendorDirectories | ForEach-Object { [string] $_ })
        Assert-StringArraysEqual $expectedVendorNames $actualVendorNames 'Vendor directory inventory'
        Assert-Contract ($actualVendorNames.Count -eq 32) `
            "Vendor-directory count mismatch: expected 32, got $($actualVendorNames.Count)."

        $allDigest = Get-Sha256 $allCatalog.ToArray()
        $embeddedDigest = Get-Sha256 $embeddedCatalog.ToArray()
        Assert-Contract ($allDigest -ceq [string] $manifest.sourceCatalogs.allProfileTree.pathFramedCanonicalSha256) `
            'All-source path-framed digest drifted.'
        Assert-Contract ($embeddedDigest -ceq [string] $manifest.sourceCatalogs.embeddedProfileSources.pathFramedCanonicalSha256) `
            'Embedded-source path-framed digest drifted.'

        $report = [ordered] @{
            schemaVersion = 1
            command = 'verify-profile-source-catalog'
            ok = $true
            upstreamCommit = [string] $manifest.commit
            manifestCanonicalByteLength = $manifestCanonicalBytes.Length
            manifestCanonicalSha256 = Get-Sha256 $manifestCanonicalBytes
            counts = [ordered] @{
                profileTreeFiles = $actualFiles.Count
                vendorDirectories = $actualVendorNames.Count
                embeddedProfileSources = $embeddedCount
                excludedProfileData = $excludedSet.Count
                deployableEmbeddedProfileSources = $deployableCount
                duplicateProfileIds = 0
            }
            sourceCatalogs = [ordered] @{
                allProfileTreeSha256 = $allDigest
                embeddedProfileSourcesSha256 = $embeddedDigest
            }
            releaseDllComparison = [ordered] @{
                countMappingMatches = $true
                sourceToReleaseCatalogBinding = 'unresolved'
                catalogSha256ReproducedFromSource = $false
                verifierInspectedReleaseDll = $false
            }
            safety = [ordered] @{
                readAndHashOnly = $true
                invokesExternalCommands = $false
                buildsOrLoadsUpstreamCode = $false
                writesSourceTree = $false
            }
        }
    } finally {
        $allCatalog.Dispose()
        $embeddedCatalog.Dispose()
    }
} catch {
    $report = [ordered] @{
        schemaVersion = 1
        command = 'verify-profile-source-catalog'
        ok = $false
        error = $_.Exception.Message
        releaseDllComparison = [ordered] @{
            sourceToReleaseCatalogBinding = 'unresolved'
            catalogSha256ReproducedFromSource = $false
            verifierInspectedReleaseDll = $false
        }
        safety = [ordered] @{
            readAndHashOnly = $true
            invokesExternalCommands = $false
            buildsOrLoadsUpstreamCode = $false
            writesSourceTree = $false
        }
    }
}

[Console]::Out.WriteLine(($report | ConvertTo-Json -Depth 10 -Compress))
if (!$report.ok) {
    exit 1
}
