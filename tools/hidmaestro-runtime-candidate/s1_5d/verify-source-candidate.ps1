[CmdletBinding()]
param(
    [string] $WorkspaceRoot
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$assurance = 'hash-pinned-static-candidate-source-and-project-xml-closure-only'
$toolRoot = Split-Path -Parent $PSCommandPath
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $toolRoot '..'))
if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
    $WorkspaceRoot = Join-Path $toolRoot '..\..\..'
}
$workspace = [IO.Path]::GetFullPath($WorkspaceRoot)
$candidateRoot = Join-Path $runtimeRoot 'candidate'
$lockPath = Join-Path $toolRoot 'contract.lock.json'
$checks = [Collections.Generic.List[object]]::new()

function Add-Check {
    param(
        [string] $Code,
        [bool] $Passed,
        [string] $Detail
    )
    [void]$checks.Add([ordered]@{
        code = $Code
        passed = $Passed
        detail = $Detail
    })
}

function Get-CanonicalTextRecord {
    param([string] $Path)

    $bytes = [IO.File]::ReadAllBytes($Path)
    $offset = 0
    $hadBom = $bytes.Length -ge 3 -and
        $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    if ($hadBom) { $offset = 3 }
    $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
    $text = $strictUtf8.GetString($bytes, $offset, $bytes.Length - $offset)
    $text = $text.Replace("`r`n", "`n").Replace("`r", "`n")
    $canonicalBytes = [Text.UTF8Encoding]::new($false).GetBytes($text)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = (($sha.ComputeHash($canonicalBytes) |
            ForEach-Object { $_.ToString('X2') }) -join '')
    }
    finally {
        $sha.Dispose()
    }
    return [pscustomobject]@{
        text = $text
        sha256 = $hash
        canonicalByteLength = $canonicalBytes.Length
        hadUtf8Bom = $hadBom
    }
}

function Get-RuntimeRelativePath {
    param([string] $Path)

    $base = $runtimeRoot.TrimEnd([IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $full = [IO.Path]::GetFullPath($Path)
    if (!$full.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the runtime-candidate root: $full"
    }
    return $full.Substring($base.Length).Replace('\', '/')
}

function Test-SameOrderedStrings {
    param(
        [string[]] $Left,
        [string[]] $Right
    )
    if ($Left.Count -ne $Right.Count) { return $false }
    for ($i = 0; $i -lt $Left.Count; $i++) {
        if ($Left[$i] -cne $Right[$i]) { return $false }
    }
    return $true
}

function Test-SameStringSet {
    param(
        [string[]] $Left,
        [string[]] $Right
    )
    $a = @($Left | Sort-Object)
    $b = @($Right | Sort-Object)
    return Test-SameOrderedStrings $a $b
}

function Normalize-Whitespace {
    param([string] $Text)
    return [regex]::Replace($Text, '\s+', ' ').Trim()
}

function Test-ContainsNormalized {
    param(
        [string] $Text,
        [string] $Needle
    )
    $haystack = Normalize-Whitespace $Text
    $normalizedNeedle = Normalize-Whitespace $Needle
    return $haystack.IndexOf($normalizedNeedle, [StringComparison]::Ordinal) -ge 0
}

function Remove-CSharpComments {
    param([string] $Text)

    $builder = [Text.StringBuilder]::new($Text.Length)
    $state = 'code'
    $verbatim = $false
    for ($i = 0; $i -lt $Text.Length; $i++) {
        $ch = $Text[$i]
        $next = if ($i + 1 -lt $Text.Length) { $Text[$i + 1] } else { [char]0 }
        switch ($state) {
            'code' {
                if ($ch -eq '/' -and $next -eq '/') {
                    [void]$builder.Append('  ')
                    $i++
                    $state = 'line-comment'
                }
                elseif ($ch -eq '/' -and $next -eq '*') {
                    [void]$builder.Append('  ')
                    $i++
                    $state = 'block-comment'
                }
                elseif ($ch -eq '"') {
                    [void]$builder.Append($ch)
                    $verbatim = $i -gt 0 -and $Text[$i - 1] -eq '@'
                    $state = 'string'
                }
                elseif ($ch -eq "'") {
                    [void]$builder.Append($ch)
                    $state = 'char'
                }
                else {
                    [void]$builder.Append($ch)
                }
            }
            'line-comment' {
                if ($ch -eq "`r" -or $ch -eq "`n") {
                    [void]$builder.Append($ch)
                    $state = 'code'
                }
                else {
                    [void]$builder.Append(' ')
                }
            }
            'block-comment' {
                if ($ch -eq '*' -and $next -eq '/') {
                    [void]$builder.Append('  ')
                    $i++
                    $state = 'code'
                }
                elseif ($ch -eq "`r" -or $ch -eq "`n") {
                    [void]$builder.Append($ch)
                }
                else {
                    [void]$builder.Append(' ')
                }
            }
            'string' {
                [void]$builder.Append($ch)
                if ($verbatim) {
                    if ($ch -eq '"' -and $next -eq '"') {
                        [void]$builder.Append($next)
                        $i++
                    }
                    elseif ($ch -eq '"') {
                        $state = 'code'
                    }
                }
                elseif ($ch -eq '\') {
                    if ($i + 1 -lt $Text.Length) {
                        [void]$builder.Append($next)
                        $i++
                    }
                }
                elseif ($ch -eq '"') {
                    $state = 'code'
                }
            }
            'char' {
                [void]$builder.Append($ch)
                if ($ch -eq '\') {
                    if ($i + 1 -lt $Text.Length) {
                        [void]$builder.Append($next)
                        $i++
                    }
                }
                elseif ($ch -eq "'") {
                    $state = 'code'
                }
            }
        }
    }
    if ($state -eq 'block-comment') {
        throw 'Candidate source contains an unterminated block comment.'
    }
    return $builder.ToString()
}

function Test-IdentifierAbsent {
    param(
        [string] $Text,
        [string] $Identifier
    )
    $pattern = '(?<![A-Za-z0-9_])' + [regex]::Escape($Identifier) +
        '(?![A-Za-z0-9_])'
    return ![regex]::IsMatch($Text, $pattern,
        [Text.RegularExpressions.RegexOptions]::CultureInvariant)
}

function Get-ObjectPathValue {
    param(
        [object] $Object,
        [string] $Path
    )
    $value = $Object
    foreach ($segment in $Path.Split('.')) {
        if ($null -eq $value) { throw "Missing JSON value at $Path" }
        $property = $value.PSObject.Properties[$segment]
        if ($null -eq $property) { throw "Missing JSON property $segment in $Path" }
        $value = $property.Value
    }
    return $value
}

function Convert-NumericLiteral {
    param([string] $Literal)
    $value = $Literal.Trim()
    if ($value -match '^0[xX]([0-9A-Fa-f]+)$') {
        return [Convert]::ToUInt64($Matches[1], 16)
    }
    if ($value -match '^(\d+)$') {
        return [Convert]::ToUInt64($Matches[1], 10)
    }
    throw "Unsupported numeric literal: $Literal"
}

function Get-CSharpEnumValues {
    param(
        [string] $Text,
        [string] $EnumName
    )

    $marker = "public enum $EnumName"
    $start = $Text.IndexOf($marker, [StringComparison]::Ordinal)
    if ($start -lt 0) { throw "Enum declaration not found: $EnumName" }
    $open = $Text.IndexOf('{', $start)
    if ($open -lt 0) { throw "Enum body not found: $EnumName" }
    $depth = 0
    $close = -1
    for ($i = $open; $i -lt $Text.Length; $i++) {
        if ($Text[$i] -eq '{') { $depth++ }
        elseif ($Text[$i] -eq '}') {
            $depth--
            if ($depth -eq 0) {
                $close = $i
                break
            }
        }
    }
    if ($close -lt 0) { throw "Unterminated enum body: $EnumName" }

    $body = $Text.Substring($open + 1, $close - $open - 1)
    $known = @{}
    $values = [Collections.Generic.List[object]]::new()
    foreach ($rawItem in $body.Split(',')) {
        $item = $rawItem.Trim()
        if ([string]::IsNullOrWhiteSpace($item)) { continue }
        if ($item -notmatch '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$') {
            throw "Unsupported enum item in ${EnumName}: $item"
        }
        $name = $Matches[1]
        $expression = $Matches[2].Trim()
        [uint64]$value = 0
        if ($expression -match '^0[xX]([0-9A-Fa-f]+)[uUlL]*$') {
            $value = [Convert]::ToUInt64($Matches[1], 16)
        }
        elseif ($expression -match '^(\d+)[uUlL]*$') {
            $value = [Convert]::ToUInt64($Matches[1], 10)
        }
        elseif ($expression -match '^1[uU]\s*<<\s*(\d+)$') {
            $value = [uint64]1 -shl [int]$Matches[1]
        }
        elseif ($expression -match '^([A-Za-z_][A-Za-z0-9_]*)$' -and
            $known.ContainsKey($Matches[1])) {
            $value = [uint64]$known[$Matches[1]]
        }
        else {
            throw "Unsupported enum expression in ${EnumName}.${name}: $expression"
        }
        $known[$name] = $value
        [void]$values.Add([pscustomobject]@{ name = $name; value = $value })
    }
    return $values
}

function Test-EnumMatchesContract {
    param(
        [object] $TypeContract,
        [string] $SourceText
    )
    $shortName = $TypeContract.id.Substring($TypeContract.id.LastIndexOf('.') + 1)
    $observed = @(Get-CSharpEnumValues $SourceText $shortName)
    $expected = @($TypeContract.values)
    if ($observed.Count -ne $expected.Count) { return $false }
    for ($i = 0; $i -lt $expected.Count; $i++) {
        if ($observed[$i].name -cne $expected[$i].name -or
            [uint64]$observed[$i].value -ne [uint64]$expected[$i].value) {
            return $false
        }
    }
    return $true
}

function Read-SafeProjectXml {
    param([string] $Text)

    $settings = [Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $stringReader = [IO.StringReader]::new($Text)
    $reader = [Xml.XmlReader]::Create($stringReader, $settings)
    try {
        $document = [Xml.XmlDocument]::new()
        $document.XmlResolver = $null
        $document.Load($reader)
        return $document
    }
    finally {
        $reader.Dispose()
        $stringReader.Dispose()
    }
}

function Get-CandidateTreeSha256 {
    param(
        [hashtable] $Records,
        [string[]] $Paths
    )

    $utf8 = [Text.UTF8Encoding]::new($false)
    $stream = [IO.MemoryStream]::new()
    try {
        foreach ($path in @($Paths | Sort-Object)) {
            $pathBytes = $utf8.GetBytes($path)
            $contentBytes = $utf8.GetBytes($Records[$path].text)
            $stream.Write($pathBytes, 0, $pathBytes.Length)
            $stream.WriteByte(0)
            $stream.Write($contentBytes, 0, $contentBytes.Length)
            $stream.WriteByte(0)
        }
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            return (($sha.ComputeHash($stream.ToArray()) |
                ForEach-Object { $_.ToString('X2') }) -join '')
        }
        finally {
            $sha.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

function Get-OnlyChildText {
    param(
        [Xml.XmlElement] $Node,
        [string] $ChildName
    )
    $children = @($Node.ChildNodes | Where-Object {
        $_.NodeType -eq [Xml.XmlNodeType]::Element -and $_.LocalName -ceq $ChildName
    })
    if ($children.Count -ne 1) { return $null }
    return $children[0].InnerText
}

function Get-ProjectPropertyNodes {
    param(
        [Xml.XmlDocument] $Document,
        [string] $Name
    )
    return @($Document.SelectNodes(
        "/*[local-name()='Project']/*[local-name()='PropertyGroup']/*[local-name()='$Name']"))
}

try {
    if (!(Test-Path -LiteralPath $lockPath -PathType Leaf)) {
        throw "S1.5d lock is absent: $lockPath"
    }
    if (!(Test-Path -LiteralPath $workspace -PathType Container)) {
        throw "Workspace root is absent: $workspace"
    }
    if (!(Test-Path -LiteralPath $candidateRoot -PathType Container)) {
        throw "Candidate source root is absent: $candidateRoot"
    }

    $lockRecord = Get-CanonicalTextRecord $lockPath
    $lock = $lockRecord.text | ConvertFrom-Json
    Add-Check 'lock.schema' ($lock.schemaVersion -eq 1) 'lock uses schema version 1'
    Add-Check 'lock.contractId' `
        ($lock.contractId -ceq 'hidmaestro-s1.5d-inert-managed-source-candidate') `
        'lock identifies the S1.5d inert managed-source candidate'
    Add-Check 'lock.status' `
        ($lock.status -ceq 'source-frozen-verifier-does-not-build-or-load') `
        'lock status explicitly scopes no-build/no-load truth to the S1.5d verifier'
    Add-Check 'lock.assurance' ($lock.assurance -ceq $assurance) `
        'lock assurance is the source/project XML boundary'
    Add-Check 'lock.noBom' (!$lockRecord.hadUtf8Bom) 'lock is UTF-8 without BOM'

    $expectedInputPaths = [ordered]@{
        'aggregate-contract' = '../candidate-contract.json'
        'api-lock' = '../api/contract.lock.json'
        'public-api-contract' = '../api/public-api.contract.json'
        'source-compilation-contract' = '../api/source-compilation.contract.json'
        'profile-catalog-lock' = '../profiles/catalog.lock.json'
        'feedback-contract' = '../../hidmaestro-feedback-contract/contract.json'
        'feedback-vectors' = '../../hidmaestro-feedback-contract/golden-vectors.tsv'
        'rust-feedback-reducer' = '../../../crates/ksx-hidmaestro/src/dualsense_feedback.rs'
        'input-contract' = '../../hidmaestro-input-contract/contract.json'
        'input-vectors' = '../../hidmaestro-input-contract/golden-vectors.json'
        'input-source-lock' = '../../hidmaestro-input-contract/source-lock.json'
        'input-source-verifier' = '../../hidmaestro-input-contract/verify-source-contract.ps1'
    }
    $loadedInputs = @{}
    foreach ($input in @($lock.sourceInputs)) {
        $expectedInputPath = $expectedInputPaths[$input.id]
        if ($null -eq $expectedInputPath -or $input.path -cne $expectedInputPath) {
            throw "Locked input path is not the fixed in-workspace path for $($input.id): $($input.path)"
        }
        $path = [IO.Path]::GetFullPath((Join-Path $toolRoot $input.path))
        $present = Test-Path -LiteralPath $path -PathType Leaf
        Add-Check "input.present.$($input.id)" $present "locked input is present: $($input.path)"
        if (!$present) { continue }
        $record = Get-CanonicalTextRecord $path
        Add-Check "input.sha256.$($input.id)" ($record.sha256 -ceq $input.sha256) `
            "expected $($input.sha256); got $($record.sha256)"
        Add-Check "input.noBom.$($input.id)" (!$record.hadUtf8Bom) `
            'locked input is UTF-8 without BOM'
        $loadedInputs[$input.id] = [pscustomobject]@{
            path = $path
            text = $record.text
            sha256 = $record.sha256
            json = if ($input.format -ceq 'json') {
                $record.text | ConvertFrom-Json
            }
            else { $null }
        }
    }

    $requiredInputIds = @($expectedInputPaths.Keys)
    Add-Check 'input.idSet' `
        (Test-SameStringSet @($lock.sourceInputs.id) $requiredInputIds) `
        'lock contains exactly the twelve source-contract inputs'
    foreach ($id in $requiredInputIds) {
        if (!$loadedInputs.ContainsKey($id)) {
            throw "Required locked input did not load: $id"
        }
    }

    $aggregate = $loadedInputs['aggregate-contract'].json
    $apiLock = $loadedInputs['api-lock'].json
    $api = $loadedInputs['public-api-contract'].json
    $source = $loadedInputs['source-compilation-contract'].json
    $profiles = $loadedInputs['profile-catalog-lock'].json
    $feedback = $loadedInputs['feedback-contract'].json
    $vectorText = $loadedInputs['feedback-vectors'].text
    $inputContract = $loadedInputs['input-contract'].json
    $inputVectors = $loadedInputs['input-vectors'].json
    $inputSourceLock = $loadedInputs['input-source-lock'].json
    $inputSourceVerifierText = $loadedInputs['input-source-verifier'].text

    Add-Check 'contracts.schema' `
        ($aggregate.schemaVersion -eq 1 -and $apiLock.schemaVersion -eq 1 -and
         $api.schemaVersion -eq 1 -and
         $source.schemaVersion -eq 1 -and $profiles.schemaVersion -eq 1 -and
         $feedback.schemaVersion -eq 1 -and $inputContract.schemaVersion -eq 1 -and
         $inputVectors.schemaVersion -eq 1 -and $inputSourceLock.schemaVersion -eq 1) `
        'all source contracts use schema version 1'
    Add-Check 'contracts.coordinates' `
        ($aggregate.upstreamCommit -ceq $api.upstream.commit -and
         $aggregate.upstreamCommit -ceq $source.upstream.commit -and
         $aggregate.upstreamCommit -ceq $profiles.commit -and
         $aggregate.upstreamCommit -ceq $feedback.upstreamCommit -and
         $aggregate.upstreamCommit -ceq $inputContract.source.commit -and
         $aggregate.upstreamCommit -ceq $inputSourceLock.upstream.commit) `
        'aggregate, API, profile, feedback, and input contracts bind the same upstream commit'

    $expectedInputContractId = 'hidmaestro-v1.6.1-dualsense-usb-submit-state-input'
    Add-Check 'inputContract.contractIds' `
        ($inputContract.contractId -ceq $expectedInputContractId -and
         $inputVectors.contractId -ceq $expectedInputContractId -and
         $inputSourceLock.contractId -ceq $expectedInputContractId) `
        'input contract, vectors, and source lock share the exact frozen contract ID'
    Add-Check 'inputContract.sourceBlobCount' `
        (@($inputSourceLock.files).Count -eq [int]$lock.expectedCounts.inputSourceBlobCount) `
        "expected $($lock.expectedCounts.inputSourceBlobCount) pinned upstream blobs; got $(@($inputSourceLock.files).Count)"
    Add-Check 'inputContract.descriptorGroupCount' `
        (@($inputContract.descriptorInputGroups).Count -eq
            [int]$lock.expectedCounts.inputDescriptorGroupCount) `
        "expected $($lock.expectedCounts.inputDescriptorGroupCount) descriptor groups; got $(@($inputContract.descriptorInputGroups).Count)"
    $inputScenarios = @($inputVectors.vectors)
    $inputFrameCount = 0
    foreach ($scenario in $inputScenarios) {
        $inputFrameCount += @($scenario.frames).Count
    }
    Add-Check 'inputContract.scenarioCount' `
        ($inputScenarios.Count -eq [int]$lock.expectedCounts.inputScenarioCount) `
        "expected $($lock.expectedCounts.inputScenarioCount) input scenarios; got $($inputScenarios.Count)"
    Add-Check 'inputContract.scenarioIdsUnique' `
        (@($inputScenarios.id | Group-Object -CaseSensitive | Where-Object Count -ne 1).Count -eq 0) `
        'input scenario IDs are unique'
    Add-Check 'inputContract.frameCount' `
        ($inputFrameCount -eq [int]$lock.expectedCounts.inputFrameCount) `
        "expected $($lock.expectedCounts.inputFrameCount) input frames; got $inputFrameCount"
    Add-Check 'inputContract.sourceVerifierTopology' `
        ([int]$lock.expectedCounts.inputSourceVerifierCheckCount -eq 538 -and
         $inputSourceVerifierText.IndexOf('checkCount = $script:CheckCount', [StringComparison]::Ordinal) -ge 0) `
        'the hash-pinned standalone source verifier has the frozen 538-check topology identity'
    Add-Check 'inputContract.verdictBoundary' `
        ($inputContract.resolution.sourceContractVerdict -ceq 'GO' -and
         $inputContract.resolution.runtimeVerdict -ceq 'NO-GO' -and
         $inputContract.resolution.aggregateGatesChanged -eq $false -and
         $inputContract.scope.assurance -ceq 'static-source-only') `
        'input source facts are GO while runtime remains NO-GO and aggregate gates do not change'
    Add-Check 'inputContract.sourceLockBoundary' `
        ($inputSourceLock.assurance.sourceContractFrozen -eq $true -and
         $inputSourceLock.assurance.runtimeImplementationBound -eq $false -and
         $inputSourceLock.assurance.artifactBuilt -eq $false -and
         $inputSourceLock.assurance.driverLoaded -eq $false -and
         $inputSourceLock.assurance.deviceExercised -eq $false -and
         $inputSourceLock.assurance.distributionReady -eq $false -and
         $inputSourceLock.verifierAuthority.buildAuthorized -eq $false -and
         $inputSourceLock.verifierAuthority.driverOrDeviceAuthorized -eq $false -and
         $inputSourceLock.verifierAuthority.networkAuthorized -eq $false -and
         $inputSourceLock.verifierAuthority.upstreamCodeExecutionAuthorized -eq $false) `
        'input source lock grants no build, runtime, driver, device, network, or distribution authority'
    $aggregateInput = $aggregate.sourceContracts.rawDualSenseInput
    Add-Check 'inputContract.aggregateSummary' `
        ($aggregateInput.path -ceq '../hidmaestro-input-contract/contract.json' -and
         [int]$aggregateInput.sourceFileCount -eq [int]$lock.expectedCounts.inputSourceBlobCount -and
         [int]$aggregateInput.descriptorGroupCount -eq [int]$lock.expectedCounts.inputDescriptorGroupCount -and
         [int]$aggregateInput.goldenScenarioCount -eq [int]$lock.expectedCounts.inputScenarioCount -and
         [int]$aggregateInput.goldenFrameCount -eq [int]$lock.expectedCounts.inputFrameCount -and
         $aggregateInput.managedRuntimeEncoderPresent -eq $true -and
         [int]$aggregateInput.fullWireReportByteCount -eq [int]$inputContract.report.wireByteLength -and
         [int]$aggregateInput.legacySharedDataByteCount -eq
            [int]$inputContract.coordinates.upstreamLegacySharedInput.byteLength -and
         $aggregateInput.artifactBehaviorVerified -eq $false -and
         $aggregateInput.hardwareVerified -eq $false -and
         $aggregate.gateState.rawInputContractFrozen -eq $true) `
        'aggregate truthfully records the frozen input source facts while artifact behavior and hardware remain unverified'

    $apiLockBindings = [ordered]@{
        '../candidate-contract.json' = 'aggregate-contract'
        '../profiles/catalog.lock.json' = 'profile-catalog-lock'
        'public-api.contract.json' = 'public-api-contract'
        'source-compilation.contract.json' = 'source-compilation-contract'
    }
    Add-Check 'contracts.apiLockFileSet' `
        (Test-SameStringSet @($apiLock.files.path) @($apiLockBindings.Keys)) `
        'the S1.5c API lock still names exactly its four frozen contract inputs'
    foreach ($apiLockFile in @($apiLock.files)) {
        $inputId = $apiLockBindings[$apiLockFile.path]
        Add-Check "contracts.apiLockHash.$inputId" `
            ($null -ne $inputId -and
             $apiLockFile.sha256 -ceq $loadedInputs[$inputId].sha256) `
            'S1.5d input hash agrees with the nested S1.5c API lock'
    }

    $expectedFiles = @($lock.candidateFiles.path | Sort-Object)
    $actualFileObjects = @(Get-ChildItem -LiteralPath $candidateRoot -File -Recurse -Force)
    $actualDirectoryObjects = @(Get-ChildItem -LiteralPath $candidateRoot -Directory -Recurse -Force)
    $actualFiles = @($actualFileObjects | ForEach-Object {
        Get-RuntimeRelativePath $_.FullName
    } | Sort-Object)
    Add-Check 'candidate.fileCount' `
        ($actualFiles.Count -eq [int]$lock.expectedCounts.candidateFileCount) `
        "expected $($lock.expectedCounts.candidateFileCount); got $($actualFiles.Count)"
    Add-Check 'candidate.fileSet' (Test-SameOrderedStrings $actualFiles $expectedFiles) `
        'candidate tree contains exactly the locked file paths'
    Add-Check 'candidate.extensionSet' `
        (@($actualFiles | Where-Object {
            $_ -notmatch '\.(?:cs|csproj)$' -and $_ -cne 'candidate/.gitignore'
        }).Count -eq 0) `
        'candidate tree contains only C# source, the explicit project, and its exact staging ignore'
    $candidateRootObject = Get-Item -LiteralPath $candidateRoot -Force
    Add-Check 'candidate.noReparsePoints' `
        ((($candidateRootObject.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -and
         @($actualFileObjects + $actualDirectoryObjects | Where-Object {
            ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
         }).Count -eq 0) `
        'candidate tree contains no file reparse points'
    $stagingPath = Join-Path $candidateRoot '.pinned-upstream-v1.6.1'
    Add-Check 'candidate.stagingAbsent' `
        (!(Test-Path -LiteralPath $stagingPath)) `
        'fixed staging directory is absent and its bytes are not inspected in S1.5d'

    $candidateRecords = @{}
    foreach ($file in @($lock.candidateFiles)) {
        $path = Join-Path $runtimeRoot ($file.path -replace '/', [IO.Path]::DirectorySeparatorChar)
        $candidatePrefix = $candidateRoot.TrimEnd([IO.Path]::DirectorySeparatorChar,
            [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        $fullCandidatePath = [IO.Path]::GetFullPath($path)
        if (!$fullCandidatePath.StartsWith($candidatePrefix,
            [StringComparison]::OrdinalIgnoreCase)) {
            throw "Locked candidate path escapes candidate/: $($file.path)"
        }
        $present = Test-Path -LiteralPath $path -PathType Leaf
        Add-Check "candidate.present.$($file.path)" $present 'locked candidate file is present'
        if (!$present) { continue }
        $record = Get-CanonicalTextRecord $path
        Add-Check "candidate.sha256.$($file.path)" ($record.sha256 -ceq $file.sha256) `
            "expected $($file.sha256); got $($record.sha256)"
        Add-Check "candidate.noBom.$($file.path)" (!$record.hadUtf8Bom) `
            'candidate source is UTF-8 without BOM'
        $candidateRecords[$file.path] = [pscustomobject]@{
            path = $path
            text = $record.text
            code = if ($file.path.EndsWith('.cs', [StringComparison]::Ordinal)) {
                Remove-CSharpComments $record.text
            }
            else { $record.text }
        }
    }
    if ($candidateRecords.Count -ne $lock.candidateFiles.Count) {
        throw 'One or more candidate files could not be loaded.'
    }
    $candidateTreeSha256 = Get-CandidateTreeSha256 $candidateRecords $expectedFiles
    Add-Check 'candidate.treeSha256' `
        ($candidateTreeSha256 -ceq $lock.candidateTreeSha256) `
        "expected $($lock.candidateTreeSha256); got $candidateTreeSha256"
    $ignoreLines = @($candidateRecords['candidate/.gitignore'].text -split "`n" |
        Where-Object { ![string]::IsNullOrEmpty($_) })
    Add-Check 'candidate.stagingIgnore' `
        ($ignoreLines.Count -eq 1 -and $ignoreLines[0] -ceq $lock.project.stagingIgnoreLine) `
        'candidate .gitignore ignores exactly the fixed staging directory'

    $expectedCandidateSourceUnits = @($source.futureCompileManifest.compileUnits |
        Where-Object { $_.StartsWith('candidate/', [StringComparison]::Ordinal) } |
        Sort-Object)
    $lockedCandidateSourceUnits = @($lock.candidateFiles.path |
        Where-Object { $_.EndsWith('.cs', [StringComparison]::Ordinal) } |
        Sort-Object)
    Add-Check 'source.candidateUnitSet' `
        (Test-SameOrderedStrings $expectedCandidateSourceUnits $lockedCandidateSourceUnits) `
        'candidate C# file set is exactly the planned S1.5c candidate-source set'
    Add-Check 'source.projectPath' `
        ($source.futureCompileManifest.projectUnit -ceq $lock.project.path -and
         @($lock.candidateFiles.path | Where-Object { $_ -ceq $lock.project.path }).Count -eq 1) `
        'project path is the one frozen by the source-compilation contract'
    Add-Check 'source.feedbackAdapterPath' `
        (@($source.requiredNewUnits).Count -eq 1 -and
         $source.requiredNewUnits[0].path -ceq $lock.feedbackAdapter.path) `
        'managed feedback adapter path is the sole required new source unit'
    $replacementPresence = @($source.classification.replacementRequired |
        ForEach-Object { $_.replacementPresent })
    $newUnitPresence = @($source.requiredNewUnits | ForEach-Object { $_.present })
    Add-Check 'source.candidatePresenceTruth' `
        (@($replacementPresence | Where-Object { $_ -ne $true }).Count -eq 0 -and
         @($newUnitPresence | Where-Object { $_ -ne $true }).Count -eq 0 -and
         $aggregate.sourceContracts.compilationDisposition.replacementSourcesPresent -eq $true -and
         $source.futureCompileManifest.allReplacementUnitsPresent -eq $true -and
         $source.futureCompileManifest.artifactCompileAllowlistFrozen -eq $false) `
        'all planned source units are present while the artifact compile gate remains false'
    $managedSource = $aggregate.sourceContracts.managedSourceCandidate
    Add-Check 'source.aggregateManagedCandidate' `
        ($managedSource.path -ceq 's1_5d/contract.lock.json' -and
         $managedSource.candidateRoot -ceq 'candidate' -and
         [int]$managedSource.candidateFileCount -eq [int]$lock.expectedCounts.candidateFileCount -and
         [int]$managedSource.compileItemCount -eq [int]$lock.expectedCounts.compileItemCount -and
         [int]$managedSource.embeddedResourceCount -eq [int]$lock.expectedCounts.embeddedResourceCount -and
         $managedSource.sourceAndProjectXmlFrozen -eq $true -and
         $managedSource.sourceVerifierBuildAuthorized -eq $false -and
         $managedSource.sourceVerifierBuiltArtifact -eq $false -and
         $managedSource.sourceVerifierLoadedArtifact -eq $false -and
         $aggregate.status -ceq 's1.5e-source-frozen-observation-not-established-not-built-or-loaded' -and
         $aggregate.artifact.observation.contractPath -ceq 's1_5e/contract.lock.json' -and
         $aggregate.artifact.observation.contractId -ceq 'hidmaestro-s1.5e-actions-static-artifact-observation' -and
         $aggregate.artifact.observation.contractReferenceState -ceq 'source-frozen-observation-not-established' -and
         $aggregate.artifact.observation.actionsObservationBuildAuthorized -eq $true -and
         $aggregate.artifact.observation.sourceVerifierBuildAuthorized -eq $false -and
         $aggregate.artifact.observation.localBuildAuthorized -eq $false -and
         $aggregate.artifact.observation.productBuildAuthorized -eq $false -and
         $aggregate.artifact.observation.loadAuthorized -eq $false -and
         $aggregate.artifact.observation.executionAuthorized -eq $false -and
         $aggregate.artifact.observation.observationEstablished -eq $false -and
         $aggregate.artifact.observation.actionsObservationArtifactBuilt -eq $false -and
         $aggregate.artifact.observation.metadataMatched -eq $false -and
         $aggregate.artifact.observation.compileClosureMatched -eq $false -and
         $aggregate.artifact.observation.resourceCatalogMatched -eq $false -and
         $aggregate.sourceContracts.publicApi.actionsObservationMetadataMatched -eq $false -and
         $aggregate.sourceContracts.publicApi.artifactMetadataAllowlistAdopted -eq $false -and
         $api.artifact.buildAuthorization.sourceVerifier -eq $false -and
         $api.artifact.buildAuthorization.s1_5eActionsObservation -eq $true -and
         $api.artifact.buildAuthorization.local -eq $false -and
         $api.artifact.buildAuthorization.product -eq $false -and
         $api.artifact.observation.contractPath -ceq '../s1_5e/contract.lock.json' -and
         $api.artifact.observation.contractId -ceq 'hidmaestro-s1.5e-actions-static-artifact-observation' -and
         $api.artifact.observation.contractReferenceState -ceq 'source-frozen-observation-not-established' -and
         $api.artifact.observation.observationEstablished -eq $false -and
         $api.artifact.observation.actionsObservationArtifactBuilt -eq $false -and
         $api.artifact.observation.metadataMatched -eq $false -and
         $api.artifact.loadAuthorized -eq $false -and
         $api.artifact.executionAuthorized -eq $false -and
         $source.futureCompileManifest.state -ceq 'source-candidate-present-hash-frozen-s1.5e-source-frozen-observation-not-established' -and
         $source.futureCompileManifest.observation.actionsObservationBuildAuthorized -eq $true -and
         $source.futureCompileManifest.observation.sourceVerifierBuildAuthorized -eq $false -and
         $source.futureCompileManifest.observation.localBuildAuthorized -eq $false -and
         $source.futureCompileManifest.observation.productBuildAuthorized -eq $false -and
         $source.futureCompileManifest.observation.contractPath -ceq '../s1_5e/contract.lock.json' -and
         $source.futureCompileManifest.observation.contractId -ceq 'hidmaestro-s1.5e-actions-static-artifact-observation' -and
         $source.futureCompileManifest.observation.contractReferenceState -ceq 'source-frozen-observation-not-established' -and
         $source.futureCompileManifest.observation.loadAuthorized -eq $false -and
         $source.futureCompileManifest.observation.executionAuthorized -eq $false -and
         $source.futureCompileManifest.observation.observationEstablished -eq $false -and
         $source.futureCompileManifest.observation.actionsObservationArtifactBuilt -eq $false -and
         $source.futureCompileManifest.observation.metadataMatched -eq $false -and
         $source.futureCompileManifest.observation.compileClosureMatched -eq $false) `
        'S1.5d remains no-build/no-load while the source-frozen S1.5e Actions observation alone is authorized but not established'

    $projectRecord = $candidateRecords[$lock.project.path]
    $projectText = $projectRecord.text
    Add-Check 'project.noDtdOrProcessingInstruction' `
        ($projectText.IndexOf('<!DOCTYPE', [StringComparison]::OrdinalIgnoreCase) -lt 0 -and
         $projectText.IndexOf('<!ENTITY', [StringComparison]::OrdinalIgnoreCase) -lt 0 -and
         $projectText.IndexOf('<?', [StringComparison]::Ordinal) -lt 0) `
        'project contains no DTD, entity declaration, or processing instruction'
    $project = Read-SafeProjectXml $projectText
    Add-Check 'project.root' `
        ($project.DocumentElement.LocalName -ceq 'Project' -and
         [string]::IsNullOrEmpty($project.DocumentElement.NamespaceURI)) `
        'project root is an un-namespaced Project element'
    Add-Check 'project.sdk' `
        ($project.DocumentElement.GetAttribute('Sdk') -ceq $lock.project.sdk) `
        "project SDK is exactly $($lock.project.sdk)"
    Add-Check 'project.rootAttributes' `
        (@($project.DocumentElement.Attributes | ForEach-Object Name).Count -eq 1 -and
         $project.DocumentElement.Attributes[0].Name -ceq 'Sdk') `
        'Sdk is the only Project attribute'

    $conditionAttributes = @($project.SelectNodes('//@Condition'))
    Add-Check 'project.noConditions' ($conditionAttributes.Count -eq 0) `
        'project contains no caller- or environment-selected Condition'
    $propertyReferences = @($project.SelectNodes('//@*') | Where-Object {
        $_.Value.IndexOf('$(', [StringComparison]::Ordinal) -ge 0
    })
    $propertyReferences += @($project.SelectNodes('//*[not(*)]') | Where-Object {
        $_.InnerText.IndexOf('$(', [StringComparison]::Ordinal) -ge 0
    })
    Add-Check 'project.noPropertyExpansion' ($propertyReferences.Count -eq 0) `
        'project item and property values contain no MSBuild property expansion'
    $wildcardAttributes = @($project.SelectNodes('//@Include|//@Update|//@Remove|//@Exclude') |
        Where-Object { $_.Value.IndexOfAny([char[]]'*?') -ge 0 })
    Add-Check 'project.noWildcards' ($wildcardAttributes.Count -eq 0) `
        'project contains no wildcard item expression'

    $directChildren = @($project.DocumentElement.ChildNodes | Where-Object {
        $_.NodeType -eq [Xml.XmlNodeType]::Element
    })
    $unexpectedDirectChildren = @($directChildren | Where-Object {
        $_.LocalName -cnotin @('PropertyGroup', 'ItemGroup')
    })
    Add-Check 'project.directElementClosure' ($unexpectedDirectChildren.Count -eq 0) `
        'project has only property and item groups; no imports, targets, tasks, or SDK overrides'
    Add-Check 'project.groupShape' `
        (@($directChildren | Where-Object { $_.Attributes.Count -ne 0 }).Count -eq 0) `
        'property and item groups carry no labels, conditions, or other metadata'

    foreach ($name in @($lock.project.forbiddenElementNames)) {
        $nodes = @($project.SelectNodes("//*[local-name()='$name']"))
        Add-Check "project.forbiddenElement.$name" ($nodes.Count -eq 0) `
            "project contains no $name element"
    }

    foreach ($property in @($lock.project.requiredProperties)) {
        $nodes = @(Get-ProjectPropertyNodes $project $property.name)
        $actual = if ($nodes.Count -eq 1) { $nodes[0].InnerText } else { '<missing-or-duplicate>' }
        Add-Check "project.property.$($property.name)" `
            ($nodes.Count -eq 1 -and $actual -ceq $property.value) `
            "expected $($property.value); got $actual"
    }

    $artifactProperties = [ordered]@{
        AssemblyName = $api.artifact.assemblyName
        AssemblyVersion = $api.artifact.assemblyVersion
        FileVersion = $api.artifact.fileVersion
        InformationalVersion = $api.artifact.informationalVersion
        TargetFramework = $api.artifact.targetFramework
        RuntimeIdentifier = $api.artifact.runtimeIdentifier
    }
    $propertyElements = @($project.SelectNodes(
        "/*[local-name()='Project']/*[local-name()='PropertyGroup']/*"))
    $expectedPropertyNames = @($lock.project.requiredProperties.name) +
        @($artifactProperties.Keys)
    $observedPropertyNames = @($propertyElements | ForEach-Object LocalName)
    Add-Check 'project.propertyNameSet' `
        (Test-SameStringSet $observedPropertyNames $expectedPropertyNames) `
        'project declares exactly the frozen identity and safety properties, with no restore/import hook'
    Add-Check 'project.propertyShape' `
        (@($propertyElements | Where-Object {
            $_.Attributes.Count -ne 0 -or
            @($_.ChildNodes | Where-Object NodeType -eq ([Xml.XmlNodeType]::Element)).Count -ne 0
        }).Count -eq 0) `
        'every project property is a single literal text value without attributes or nested XML'
    foreach ($name in @($artifactProperties.Keys)) {
        $nodes = @(Get-ProjectPropertyNodes $project $name)
        $actual = if ($nodes.Count -eq 1) { $nodes[0].InnerText } else { '<missing-or-duplicate>' }
        Add-Check "project.artifactIdentity.$name" `
            ($nodes.Count -eq 1 -and $actual -ceq $artifactProperties[$name]) `
            "expected $($artifactProperties[$name]); got $actual"
    }

    $assemblySourcePath = $lock.project.assemblyAttributeSource
    $assemblySourceCode = $candidateRecords[$assemblySourcePath].code
    $allCandidateSourceText = (@($candidateRecords.Keys | Where-Object {
        $_.EndsWith('.cs', [StringComparison]::Ordinal)
    } | Sort-Object | ForEach-Object { $candidateRecords[$_].code })) -join "`n"
    $assemblyAttributes = @([regex]::Matches(
        $allCandidateSourceText,
        '(?m)^\s*\[assembly:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(',
        [Text.RegularExpressions.RegexOptions]::CultureInvariant))
    Add-Check 'project.assemblyAttributeSource' `
        ($assemblySourcePath -ceq 'candidate/HMContext.cs' -and
         $expectedCandidateSourceUnits -ccontains $assemblySourcePath) `
        'assembly identity attributes live in an existing allowlisted source unit'
    Add-Check 'project.assemblyAttributeSet' `
        ($assemblyAttributes.Count -eq 4 -and
         (Test-SameStringSet @($assemblyAttributes | ForEach-Object {
            $_.Groups[1].Value
         }) @('AssemblyVersion', 'AssemblyFileVersion',
              'AssemblyInformationalVersion', 'TargetFramework'))) `
        'candidate source contains exactly the four required assembly identity attributes'
    $assemblyVersionAnchor =
        "[assembly: AssemblyVersion(`"$($api.artifact.assemblyVersion)`")]"
    $assemblyFileVersionAnchor =
        "[assembly: AssemblyFileVersion(`"$($api.artifact.fileVersion)`")]"
    $assemblyInformationalVersionAnchor =
        "[assembly: AssemblyInformationalVersion(`"$($api.artifact.informationalVersion)`")]"
    Add-Check 'project.assemblyAttribute.AssemblyVersion' `
        (Test-ContainsNormalized $assemblySourceCode $assemblyVersionAnchor) `
        'source AssemblyVersion matches the API artifact identity'
    Add-Check 'project.assemblyAttribute.AssemblyFileVersion' `
        (Test-ContainsNormalized $assemblySourceCode $assemblyFileVersionAnchor) `
        'source AssemblyFileVersion matches the API artifact identity'
    Add-Check 'project.assemblyAttribute.AssemblyInformationalVersion' `
        (Test-ContainsNormalized $assemblySourceCode $assemblyInformationalVersionAnchor) `
        'source AssemblyInformationalVersion matches the API artifact identity'
    Add-Check 'project.assemblyAttribute.TargetFramework' `
        (Test-ContainsNormalized $assemblySourceCode $lock.project.targetFrameworkAttribute) `
        'source TargetFramework attribute matches the fixed net10 target identity'

    $itemElements = @($project.SelectNodes(
        "/*[local-name()='Project']/*[local-name()='ItemGroup']/*"))
    $unexpectedItems = @($itemElements | Where-Object {
        $_.LocalName -cnotin @('Compile', 'EmbeddedResource')
    })
    Add-Check 'project.itemTypeClosure' ($unexpectedItems.Count -eq 0) `
        'project item groups contain only Compile and EmbeddedResource items'

    $compileNodes = @($project.SelectNodes(
        "/*[local-name()='Project']/*[local-name()='ItemGroup']/*[local-name()='Compile']"))
    $expectedCompileIncludes = [Collections.Generic.List[string]]::new()
    foreach ($unit in @($source.futureCompileManifest.compileUnits)) {
        if ($unit.StartsWith('candidate/', [StringComparison]::Ordinal)) {
            [void]$expectedCompileIncludes.Add($unit.Substring('candidate/'.Length))
        }
        else {
            [void]$expectedCompileIncludes.Add($lock.project.fixedStagingPrefix + $unit)
        }
    }
    $actualCompileIncludes = @($compileNodes | ForEach-Object { $_.GetAttribute('Include') })
    Add-Check 'project.compileCount' `
        ($compileNodes.Count -eq [int]$lock.expectedCounts.compileItemCount) `
        "expected $($lock.expectedCounts.compileItemCount); got $($compileNodes.Count)"
    Add-Check 'project.compileSet' `
        (Test-SameStringSet $actualCompileIncludes @($expectedCompileIncludes)) `
        'Compile Include values exactly match the source-compilation manifest'
    Add-Check 'project.compileUnique' `
        (@($actualCompileIncludes | Group-Object -CaseSensitive | Where-Object Count -ne 1).Count -eq 0) `
        'Compile Include values are unique'
    $compileShapeOk = $true
    foreach ($node in $compileNodes) {
        $elementChildren = @($node.ChildNodes | Where-Object {
            $_.NodeType -eq [Xml.XmlNodeType]::Element
        })
        $attributeNames = @($node.Attributes | ForEach-Object Name)
        $include = $node.GetAttribute('Include')
        $isRetainedExternal = $include -ceq
            ($lock.project.fixedStagingPrefix + 'sdk/HIDMaestro.Core/HMOutputPacket.cs')
        $expectedAttributes = if ($isRetainedExternal) {
            @('Include', 'Link')
        }
        else { @('Include') }
        if ($elementChildren.Count -ne 0 -or
            !(Test-SameStringSet $attributeNames $expectedAttributes) -or
            ($isRetainedExternal -and $node.GetAttribute('Link') -cne 'HMOutputPacket.cs')) {
            $compileShapeOk = $false
        }
    }
    Add-Check 'project.compileShape' $compileShapeOk `
        'each Compile item has one literal Include; only the retained packet source has its fixed Link metadata'
    Add-Check 'project.fixedStagingPrefix' `
        ($lock.project.fixedStagingPrefix -ceq '.pinned-upstream-v1.6.1/' -and
         @($actualCompileIncludes | Where-Object {
            $_.IndexOf('../', [StringComparison]::Ordinal) -ge 0
         }).Count -eq 0) `
        'external Compile identities use only the fixed literal staging prefix'

    $selectedProfiles = @($profiles.entries | Where-Object {
        $_.classification -ceq 'embedded-profile-source'
    })
    $expectedResourcePairs = [Collections.Generic.List[string]]::new()
    foreach ($entry in $selectedProfiles) {
        if (!$entry.path.StartsWith('profiles/', [StringComparison]::Ordinal)) {
            throw "Embedded profile path is outside profiles/: $($entry.path)"
        }
        $include = $lock.project.fixedStagingPrefix + $entry.path
        $logicalName = 'HIDMaestro.Profiles.' + $entry.path.Substring('profiles/'.Length)
        [void]$expectedResourcePairs.Add("$include|$logicalName")
    }

    $resourceNodes = @($project.SelectNodes(
        "/*[local-name()='Project']/*[local-name()='ItemGroup']/*[local-name()='EmbeddedResource']"))
    $actualResourcePairs = [Collections.Generic.List[string]]::new()
    $actualResourceIncludes = [Collections.Generic.List[string]]::new()
    $actualLogicalNames = [Collections.Generic.List[string]]::new()
    $resourceShapeOk = $true
    foreach ($node in $resourceNodes) {
        $include = $node.GetAttribute('Include')
        $logicalName = $node.GetAttribute('LogicalName')
        [void]$actualResourcePairs.Add("$include|$logicalName")
        [void]$actualResourceIncludes.Add($include)
        [void]$actualLogicalNames.Add($logicalName)
        $elementChildren = @($node.ChildNodes | Where-Object {
            $_.NodeType -eq [Xml.XmlNodeType]::Element
        })
        $attributeNames = @($node.Attributes | ForEach-Object Name)
        if (!(Test-SameStringSet $attributeNames @('Include', 'LogicalName')) -or
            $elementChildren.Count -ne 0) {
            $resourceShapeOk = $false
        }
    }
    Add-Check 'project.resourceManifestHash' `
        ($aggregate.artifact.embeddedResourcePolicy.sourceManifestCanonicalSha256 -ceq
            $loadedInputs['profile-catalog-lock'].sha256 -and
         $source.futureCompileManifest.resourceUnits.manifestCanonicalSha256 -ceq
            $loadedInputs['profile-catalog-lock'].sha256) `
        'aggregate and source contracts point to the locked profile source manifest'
    Add-Check 'project.resourceSelectionCount' `
        ($selectedProfiles.Count -eq [int]$profiles.counts.embeddedProfileSourceCount -and
         $selectedProfiles.Count -eq [int]$lock.expectedCounts.embeddedResourceCount) `
        "expected $($lock.expectedCounts.embeddedResourceCount); got $($selectedProfiles.Count) selected manifest entries"
    Add-Check 'project.resourceCount' `
        ($resourceNodes.Count -eq [int]$lock.expectedCounts.embeddedResourceCount) `
        "expected $($lock.expectedCounts.embeddedResourceCount); got $($resourceNodes.Count)"
    Add-Check 'project.resourcePairSet' `
        (Test-SameStringSet @($actualResourcePairs) @($expectedResourcePairs)) `
        'all EmbeddedResource Include and LogicalName pairs exactly match the profile source manifest'
    Add-Check 'project.resourcePairUnique' `
        (@($actualResourcePairs | Group-Object -CaseSensitive | Where-Object Count -ne 1).Count -eq 0) `
        'resource Include/LogicalName pairs are unique'
    Add-Check 'project.resourceIncludesUnique' `
        (@($actualResourceIncludes | Group-Object -CaseSensitive |
            Where-Object Count -ne 1).Count -eq 0) `
        'resource Include values are unique'
    Add-Check 'project.resourceLogicalNamesUnique' `
        (@($actualLogicalNames | Group-Object -CaseSensitive |
            Where-Object Count -ne 1).Count -eq 0) `
        'resource LogicalName values are unique'
    Add-Check 'project.resourceShape' $resourceShapeOk `
        'each resource has exactly one literal Include and one literal LogicalName attribute'
    Add-Check 'project.deployableProfileCount' `
        (@($selectedProfiles | Where-Object deployable -eq $true).Count -eq
            [int]$lock.expectedCounts.deployableProfileCount -and
         [int]$profiles.counts.deployableEmbeddedProfileSourceCount -eq
            [int]$lock.expectedCounts.deployableProfileCount) `
        "expected $($lock.expectedCounts.deployableProfileCount) deployable source profiles"
    Add-Check 'project.profileManifestCounts' `
        ([int]$profiles.counts.profileTreeFileCount -eq 231 -and
         [int]$profiles.counts.excludedProfileDataCount -eq 3 -and
         [int]$profiles.counts.duplicateProfileIdCount -eq 0) `
        'profile manifest remains exhaustive over 231 files with three exclusions and no duplicate IDs'
    Add-Check 'project.releaseCatalogStillUnbound' `
        ($aggregate.artifact.embeddedResourcePolicy.sourceToReleaseCatalogBinding -ceq 'unresolved' -and
         $profiles.releaseDllComparison.sourceToReleaseCatalogBinding -ceq 'unresolved' -and
         $profiles.releaseDllComparison.verifierInspectsReleaseDll -eq $false) `
        'project-to-manifest closure does not claim release-DLL catalog binding'

    $candidateApiTypeCount = 0
    $candidateApiEntryCount = 0
    $candidatePathByType = @{}
    foreach ($type in @($api.types)) {
        if ($type.sourceDisposition -ceq 'retain-unchanged') { continue }
        $replacement = @($source.classification.replacementRequired | Where-Object {
            @($_.upstreamUnits) -ccontains $type.sourcePath
        })
        Add-Check "api.mapping.$($type.id)" `
            ($replacement.Count -eq 1 -and @($replacement[0].plannedCandidateUnits).Count -eq 1) `
            'public source type maps to one planned replacement file'
        if ($replacement.Count -ne 1 -or @($replacement[0].plannedCandidateUnits).Count -ne 1) {
            continue
        }
        $candidatePath = $replacement[0].plannedCandidateUnits[0]
        $candidatePathByType[$type.id] = $candidatePath
        $candidateCode = $candidateRecords[$candidatePath].code
        Add-Check "api.typeAnchor.$($type.id)" `
            (Test-ContainsNormalized $candidateCode $type.sourceTypeAnchor) `
            "candidate contains source API type anchor: $($type.sourceTypeAnchor)"
        $candidateApiTypeCount++
        $entries = if ($type.kind -ceq 'enum') { @($type.values) } else { @($type.members) }
        $candidateApiEntryCount += $entries.Count
        if ($type.kind -ceq 'enum') {
            Add-Check "api.enumValues.$($type.id)" `
                (Test-EnumMatchesContract $type $candidateCode) `
                'candidate enum order, names, and numeric values exactly match the API contract'
        }
    }
    $expectedMemberAnchorIds = [Collections.Generic.List[string]]::new()
    foreach ($type in @($api.types | Where-Object {
        $_.sourceDisposition -ceq 'replacement-required' -and $_.kind -cne 'enum'
    })) {
        foreach ($member in @($type.members)) {
            [void]$expectedMemberAnchorIds.Add("$($type.id)|$($member.id)")
        }
    }
    $lockedMemberAnchorIds = @($lock.apiMemberAnchors | ForEach-Object {
        "$($_.typeId)|$($_.memberId)"
    })
    Add-Check 'api.memberAnchorSet' `
        (Test-SameStringSet @($expectedMemberAnchorIds) $lockedMemberAnchorIds) `
        'candidate member anchors cover every replacement-backed non-enum API entry exactly once'
    foreach ($anchor in @($lock.apiMemberAnchors)) {
        $type = @($api.types | Where-Object id -ceq $anchor.typeId)
        $member = @(if ($type.Count -eq 1) {
            $type[0].members | Where-Object id -ceq $anchor.memberId
        })
        $candidatePath = $candidatePathByType[$anchor.typeId]
        $candidateCode = if ($null -ne $candidatePath) {
            $candidateRecords[$candidatePath].code
        }
        else { '' }
        Add-Check "api.memberAnchor.$($anchor.typeId).$($anchor.memberId)" `
            ($type.Count -eq 1 -and $member.Count -eq 1 -and
             (Test-ContainsNormalized $candidateCode $anchor.text)) `
            "candidate contains API declaration anchor: $($anchor.text)"
    }
    Add-Check 'api.candidateTypeCount' `
        ($candidateApiTypeCount -eq [int]$lock.expectedCounts.candidateApiTypeCount) `
        "expected $($lock.expectedCounts.candidateApiTypeCount); got $candidateApiTypeCount"
    Add-Check 'api.candidateEntryCount' `
        ($candidateApiEntryCount -eq [int]$lock.expectedCounts.candidateApiEntryCount) `
        "expected $($lock.expectedCounts.candidateApiEntryCount); got $candidateApiEntryCount"
    Add-Check 'api.aggregateCounts' `
        (@($api.types).Count -eq 9 -and [int]$api.surfaceRules.logicalMemberCount -eq 100) `
        'the source API target remains nine types and 100 logical entries'

    $allCandidateCode = (@($candidateRecords.Keys | Where-Object {
        $_.EndsWith('.cs', [StringComparison]::Ordinal)
    } | Sort-Object | ForEach-Object { $candidateRecords[$_].code })) -join "`n"
    foreach ($fullName in @($api.explicitlyAbsentPublicTypes)) {
        $shortName = $fullName.Substring($fullName.LastIndexOf('.') + 1)
        Add-Check "api.explicitlyAbsent.$fullName" `
            (Test-IdentifierAbsent $allCandidateCode $shortName) `
            'explicitly absent public type name does not occur in candidate code'
    }
    foreach ($name in @($aggregate.forbiddenTypeOrMemberNames)) {
        Add-Check "capability.aggregateForbidden.$name" `
            (Test-IdentifierAbsent $allCandidateCode $name) `
            'forbidden type/member identifier does not occur in candidate code'
    }
    foreach ($family in @($lock.forbiddenCapabilityFamilies)) {
        $matches = @([regex]::Matches($allCandidateCode, $family.pattern,
            [Text.RegularExpressions.RegexOptions]::CultureInvariant))
        Add-Check "capability.family.$($family.id)" ($matches.Count -eq 0) `
            "forbidden capability family has no source occurrence: $($family.description)"
    }

    $ownershipUnits = @('HMContext', 'RuntimePlainHidLifecycle', 'HMController')
    $expectedOwnershipRequirementIds = [Collections.Generic.List[string]]::new()
    foreach ($requirementGroup in @($aggregate.implementationSafetySummary.selectedRequirements |
        Where-Object { $ownershipUnits -ccontains $_.unit })) {
        foreach ($requirement in @($requirementGroup.requirements)) {
            [void]$expectedOwnershipRequirementIds.Add("$($requirementGroup.unit)|$requirement")
        }
    }
    $lockedOwnershipRequirementIds = @($lock.ownershipAnchors | ForEach-Object {
        "$($_.unit)|$($_.requirement)"
    })
    Add-Check 'ownership.requirementSet' `
        (Test-SameStringSet @($expectedOwnershipRequirementIds) $lockedOwnershipRequirementIds) `
        'ownership anchors cover every HMContext, lifecycle, and controller safety requirement exactly once'
    foreach ($ownership in @($lock.ownershipAnchors)) {
        $sourceRequirement = @($aggregate.implementationSafetySummary.selectedRequirements |
            Where-Object unit -ceq $ownership.unit)
        Add-Check "ownership.requirement.$($ownership.id)" `
            ($sourceRequirement.Count -eq 1 -and
             @($sourceRequirement[0].requirements) -ccontains $ownership.requirement) `
            'ownership anchor remains tied to an exact aggregate safety requirement'
        Add-Check "ownership.path.$($ownership.id)" `
            ($expectedCandidateSourceUnits -ccontains $ownership.path) `
            'ownership anchor file is inside the exact planned candidate-source set'
        $code = $candidateRecords[$ownership.path].code
        foreach ($anchor in @($ownership.anchors)) {
            Add-Check "ownership.anchor.$($ownership.id).$($anchor.id)" `
                (Test-ContainsNormalized $code $anchor.text) `
            "candidate contains ownership/rollback anchor: $($anchor.text)"
        }
    }
    $lifecycleCode = $candidateRecords['candidate/Internal/RuntimePlainHidLifecycle.cs'].code
    $rollbackMethodStart = $lifecycleCode.IndexOf(
        'internal IReadOnlyList<Exception> Rollback(', [StringComparison]::Ordinal)
    $rollbackStop = if ($rollbackMethodStart -ge 0) {
        $lifecycleCode.IndexOf('statePath.NeutralizeAndStop();', $rollbackMethodStart,
            [StringComparison]::Ordinal)
    }
    else { -1 }
    $rollbackEarlyReturn = if ($rollbackStop -ge 0) {
        $lifecycleCode.IndexOf('return failures;', $rollbackStop,
            [StringComparison]::Ordinal)
    }
    else { -1 }
    $rollbackRemoval = if ($rollbackMethodStart -ge 0) {
        $lifecycleCode.IndexOf(
            'foreach (Exception failure in RemoveExactIdentities(ownedDevice))',
            $rollbackMethodStart,
            [StringComparison]::Ordinal)
    }
    else { -1 }
    Add-Check 'ownership.rollbackFailClosedOrder' `
        ($rollbackMethodStart -ge 0 -and $rollbackStop -gt $rollbackMethodStart -and
         $rollbackEarlyReturn -gt $rollbackStop -and
         $rollbackRemoval -gt $rollbackEarlyReturn) `
        'rollback attempts exact state-path teardown first, returns on failure, and reaches identity removal only afterward'
    $recoveryClassStart = $lifecycleCode.IndexOf(
        'internal sealed class RuntimeExactRecovery', [StringComparison]::Ordinal)
    $recoveryRetryStart = if ($recoveryClassStart -ge 0) {
        $lifecycleCode.IndexOf('internal void Retry()', $recoveryClassStart,
            [StringComparison]::Ordinal)
    }
    else { -1 }
    $recoveryStop = if ($recoveryRetryStart -ge 0) {
        $lifecycleCode.IndexOf('StatePath?.NeutralizeAndStop();', $recoveryRetryStart,
            [StringComparison]::Ordinal)
    }
    else { -1 }
    $recoveryRemove = if ($recoveryRetryStart -ge 0) {
        $lifecycleCode.IndexOf('_lifecycle.RemoveOwned(OwnedDevice);', $recoveryRetryStart,
            [StringComparison]::Ordinal)
    }
    else { -1 }
    $recoveryComplete = if ($recoveryRetryStart -ge 0) {
        $lifecycleCode.IndexOf('_completed = true;', $recoveryRetryStart,
            [StringComparison]::Ordinal)
    }
    else { -1 }
    Add-Check 'ownership.retryRecoveryOrder' `
        ($recoveryClassStart -ge 0 -and $recoveryRetryStart -gt $recoveryClassStart -and
         $recoveryStop -gt $recoveryRetryStart -and $recoveryRemove -gt $recoveryStop -and
         $recoveryComplete -gt $recoveryRemove) `
        'serialized exact recovery retries state-path teardown, then exact removal, and marks complete only after both succeed'

    $vectorLines = @($vectorText -split "`n" | Where-Object {
        ![string]::IsNullOrWhiteSpace($_) -and !$_.StartsWith('#', [StringComparison]::Ordinal)
    })
    $vectors = @((($vectorLines -join "`n") | ConvertFrom-Csv -Delimiter "`t"))
    Add-Check 'feedback.vectorCount' `
        ($vectors.Count -eq [int]$feedback.implementation.goldenVectorCount -and
         $vectors.Count -eq [int]$lock.expectedCounts.goldenVectorCount) `
        "expected $($lock.expectedCounts.goldenVectorCount); got $($vectors.Count)"
    Add-Check 'feedback.vectorNamesUnique' `
        (@($vectors.name | Group-Object -CaseSensitive | Where-Object Count -ne 1).Count -eq 0) `
        'golden-vector names are unique'
    $feedbackContractRoot = Split-Path -Parent $loadedInputs['feedback-contract'].path
    $canonicalRustSource = Join-Path $feedbackContractRoot `
        $feedback.implementation.canonicalRustSource
    Add-Check 'feedback.canonicalRustSource' `
        ([IO.Path]::GetFullPath($canonicalRustSource) -ceq
         $loadedInputs['rust-feedback-reducer'].path) `
        'feedback contract points to the exact locked Rust reducer source'

    $adapterCode = $candidateRecords[$lock.feedbackAdapter.path].code
    $adapterRequirement = @($aggregate.implementationSafetySummary.selectedRequirements |
        Where-Object unit -ceq 'RawDualSenseFeedbackAdapter')
    Add-Check 'feedback.aggregateRequirement' `
        ($adapterRequirement.Count -eq 1 -and
         @($adapterRequirement[0].requirements).Count -eq 4) `
        'aggregate contract retains all four managed feedback-adapter requirements'
    foreach ($numeric in @($lock.feedbackAdapter.numericAnchors)) {
        $match = [regex]::Match($adapterCode, $numeric.pattern,
            [Text.RegularExpressions.RegexOptions]::CultureInvariant)
        [uint64]$actual = 0
        $parsed = $false
        if ($match.Success -and $match.Groups['value'].Success) {
            try {
                $actual = Convert-NumericLiteral $match.Groups['value'].Value
                $parsed = $true
            }
            catch { $parsed = $false }
        }
        [uint64]$expected = Get-ObjectPathValue $feedback $numeric.contractPath
        Add-Check "feedback.numeric.$($numeric.id)" `
            ($match.Success -and $parsed -and $actual -eq $expected) `
            "expected $expected from $($numeric.contractPath); got $(if ($parsed) { $actual } else { '<absent-or-unparsed>' })"
    }
    foreach ($anchor in @($lock.feedbackAdapter.requiredAnchors)) {
        Add-Check "feedback.anchor.$($anchor.id)" `
            (Test-ContainsNormalized $adapterCode $anchor.text) `
            "candidate contains feedback relation anchor: $($anchor.text)"
    }
    $vectorDispositions = @($vectors.expected_disposition | Sort-Object -Unique)
    Add-Check 'feedback.dispositionContractSet' `
        (Test-SameStringSet $vectorDispositions @($lock.feedbackAdapter.dispositions.vectorValue)) `
        'locked managed disposition mapping covers exactly the golden-vector outcomes'
    foreach ($disposition in @($lock.feedbackAdapter.dispositions)) {
        Add-Check "feedback.disposition.$($disposition.vectorValue)" `
            ([regex]::IsMatch($adapterCode,
                '(?<![A-Za-z0-9_])' + [regex]::Escape($disposition.sourceName) +
                '(?![A-Za-z0-9_])')) `
            "adapter contains managed disposition $($disposition.sourceName)"
    }
    Add-Check 'feedback.artifactGateStillFalse' `
        ($aggregate.gateState.rawFeedbackDecoderFrozen -eq $false -and
         $aggregate.sourceContracts.rawDualSenseFeedback.managedRuntimeAdapterPresent -eq $true) `
        'managed adapter source is present while behavior/artifact proof remains false'

    $encoderCode = $candidateRecords[$lock.inputBinding.encoderPath].code
    $sharedMemoryCode = $candidateRecords[$lock.inputBinding.sharedMemoryPath].code
    $controllerCode = $candidateRecords[$lock.inputBinding.controllerPath].code
    Add-Check 'inputBinding.pathSet' `
        ($expectedCandidateSourceUnits -ccontains $lock.inputBinding.encoderPath -and
         $expectedCandidateSourceUnits -ccontains $lock.inputBinding.sharedMemoryPath -and
         $expectedCandidateSourceUnits -ccontains $lock.inputBinding.controllerPath) `
        'input encoder, shared-memory seam, and controller chain are all inside the exact candidate source set'
    $inputRequirement = @($aggregate.implementationSafetySummary.selectedRequirements |
        Where-Object unit -ceq 'RuntimeDualSenseInputEncoder')
    Add-Check 'inputBinding.aggregateRequirement' `
        ($inputRequirement.Count -eq 1 -and
         @($inputRequirement[0].requirements).Count -eq 3) `
        'aggregate contract retains all three managed input-encoder and 64-to-63 seam requirements'
    foreach ($numeric in @($lock.inputBinding.numericAnchors)) {
        $match = [regex]::Match($encoderCode, $numeric.pattern,
            [Text.RegularExpressions.RegexOptions]::CultureInvariant)
        [uint64]$actual = 0
        $parsed = $false
        if ($match.Success -and $match.Groups['value'].Success) {
            try {
                $actual = Convert-NumericLiteral $match.Groups['value'].Value
                $parsed = $true
            }
            catch { $parsed = $false }
        }
        [uint64]$expected = Get-ObjectPathValue $inputContract $numeric.contractPath
        Add-Check "inputBinding.numeric.$($numeric.id)" `
            ($match.Success -and $parsed -and $actual -eq $expected) `
            "expected $expected from $($numeric.contractPath); got $(if ($parsed) { $actual } else { '<absent-or-unparsed>' })"
    }
    foreach ($anchor in @($lock.inputBinding.requiredEncoderAnchors)) {
        Add-Check "inputBinding.encoderAnchor.$($anchor.id)" `
            (Test-ContainsNormalized $encoderCode $anchor.text) `
            "encoder contains source-relation anchor: $($anchor.text)"
    }

    $contractAxisKeys = @($inputContract.axes.entries | ForEach-Object stateKey)
    $lockedAxisKeys = @($lock.inputBinding.axisLocals | ForEach-Object stateKey)
    Add-Check 'inputBinding.axisKeySet' `
        (Test-SameStringSet $contractAxisKeys $lockedAxisKeys) `
        'axis-local bindings cover exactly the six descriptor-derived axis keys'
    foreach ($axis in @($inputContract.axes.entries)) {
        $binding = @($lock.inputBinding.axisLocals | Where-Object stateKey -ceq $axis.stateKey)
        $localName = if ($binding.Count -eq 1) { [string]$binding[0].localName } else { '' }
        $readAnchor = "float $localName = GetNormalizedAxis(axes, HMAxis.$($axis.stateKey));"
        $writeAnchor = "destination[$($axis.wireByte)] = ScaleAxis($localName);"
        Add-Check "inputBinding.axis.$($axis.stateKey)" `
            ($binding.Count -eq 1 -and
             [int]$axis.wireByte -eq ([int]$axis.sharedDataByte + 1) -and
             (Test-ContainsNormalized $encoderCode $readAnchor) -and
             (Test-ContainsNormalized $encoderCode $writeAnchor)) `
            "axis $($axis.stateKey) is read once and written to full-wire byte $($axis.wireByte)"
    }

    Add-Check 'inputBinding.hatContractShape' `
        (@($inputContract.hat.values).Count -eq 9 -and
         [int]$inputContract.hat.wireByte -eq 8 -and
         [int]$inputContract.hat.sharedDataByte -eq 7 -and
         $inputContract.hat.hasNullState -eq $true) `
        'hat contract retains eight octants plus null-state value at full-wire byte 8'
    foreach ($hat in @($inputContract.hat.values)) {
        $hatAnchor = "HMHat.$($hat.name) => (byte)$($hat.wireValue)"
        Add-Check "inputBinding.hat.$($hat.name)" `
            (Test-ContainsNormalized $encoderCode $hatAnchor) `
            "hat $($hat.name) maps to descriptor-derived value $($hat.wireValue)"
    }

    Add-Check 'inputBinding.buttonContractShape' `
        (@($inputContract.buttons.entries).Count -eq 13 -and
         @($inputContract.buttons.aliases).Count -eq 4 -and
         @($inputContract.buttons.dropped).Count -eq 5) `
        'input contract retains thirteen carried, four aliased, and five dropped button names'
    foreach ($button in @($inputContract.buttons.entries)) {
        [uint64]$mask = [uint64]1 -shl [int]$button.wireBit
        $maskLiteral = '0x{0:X2}' -f $mask
        $buttonAnchor = "SetButton(buttons, HMButton.$($button.name), destination, wireByte: $($button.wireByte), mask: $maskLiteral);"
        Add-Check "inputBinding.button.$($button.name)" `
            (Test-ContainsNormalized $encoderCode $buttonAnchor) `
            "button $($button.name) maps to full-wire byte $($button.wireByte), bit $($button.wireBit)"
    }
    $buttonApiTypes = @($api.types | Where-Object id -ceq 'HIDMaestro.HMButton')
    foreach ($alias in @($inputContract.buttons.aliases)) {
        $aliasValue = @(if ($buttonApiTypes.Count -eq 1) {
            $buttonApiTypes[0].values | Where-Object name -ceq $alias.name
        })
        $targetValue = @(if ($buttonApiTypes.Count -eq 1) {
            $buttonApiTypes[0].values | Where-Object name -ceq $alias.sameAs
        })
        Add-Check "inputBinding.buttonAlias.$($alias.name)" `
            ($aliasValue.Count -eq 1 -and $targetValue.Count -eq 1 -and
             [uint64]$aliasValue[0].value -eq [uint64]$targetValue[0].value) `
            "button alias $($alias.name) has the same frozen enum mask as $($alias.sameAs)"
    }
    foreach ($dropped in @($inputContract.buttons.dropped)) {
        Add-Check "inputBinding.buttonDropped.$($dropped.name)" `
            (Test-IdentifierAbsent $encoderCode $dropped.name) `
            "unsupported button $($dropped.name) is not aliased into the encoder"
    }

    foreach ($trigger in @($inputContract.derivedTriggerButtons)) {
        $binding = @($lock.inputBinding.axisLocals | Where-Object stateKey -ceq $trigger.axisStateKey)
        $localName = if ($binding.Count -eq 1) { [string]$binding[0].localName } else { '' }
        [uint64]$mask = [uint64]1 -shl [int]$trigger.wireBit
        $maskLiteral = '0x{0:X2}' -f $mask
        $conditionAnchor = "if ($localName > 0.0f)"
        $writeAnchor = "destination[$($trigger.wireByte)] |= $maskLiteral;"
        Add-Check "inputBinding.trigger.$($trigger.axisStateKey)" `
            ($binding.Count -eq 1 -and
             $trigger.condition -ceq 'clamped normalized value > 0.0' -and
             (Test-ContainsNormalized $encoderCode $conditionAnchor) -and
             (Test-ContainsNormalized $encoderCode $writeAnchor)) `
            "trigger axis $($trigger.axisStateKey) derives its digital bit only when the clamped value is greater than zero"
    }

    $directDestinationIndexes = @([regex]::Matches(
        $encoderCode,
        'destination\[\s*(?<index>\d+)\s*\]',
        [Text.RegularExpressions.RegexOptions]::CultureInvariant) |
        ForEach-Object { $_.Groups['index'].Value } | Sort-Object -Unique)
    $expectedDirectDestinationIndexes = @($lock.inputBinding.expectedDirectDestinationIndexes |
        ForEach-Object { [string]$_ })
    Add-Check 'inputBinding.fixedZeroWriteClosure' `
        (Test-SameStringSet $directDestinationIndexes $expectedDirectDestinationIndexes) `
        'literal-index writes are closed to report ID, six axes, hat, and trigger byte; separately checked button calls are the only dynamic-index writes'
    $destinationIndexExpressions = @([regex]::Matches(
        $encoderCode,
        'destination\[\s*(?<expression>[^\]]+)\s*\]',
        [Text.RegularExpressions.RegexOptions]::CultureInvariant) |
        ForEach-Object { $_.Groups['expression'].Value.Trim() })
    $destinationIndexWrites = @([regex]::Matches(
        $encoderCode,
        'destination\[\s*[^\]]+\s*\]\s*(?:\|=|=)',
        [Text.RegularExpressions.RegexOptions]::CultureInvariant))
    Add-Check 'inputBinding.destinationIndexClosure' `
        ($destinationIndexExpressions.Count -eq $destinationIndexWrites.Count -and
         (Test-SameStringSet `
             -Left @($destinationIndexExpressions | Sort-Object -Unique) `
             -Right @($expectedDirectDestinationIndexes + 'wireByte'))) `
        'every destination index expression is a write and is either a frozen literal index or the checked button helper index'
    $destinationMemberCalls = @([regex]::Matches(
        $encoderCode,
        'destination\s*\.\s*(?<member>[A-Za-z_][A-Za-z0-9_]*)\s*\(',
        [Text.RegularExpressions.RegexOptions]::CultureInvariant) |
        ForEach-Object { $_.Groups['member'].Value })
    Add-Check 'inputBinding.destinationMemberClosure' `
        ($destinationMemberCalls.Count -eq 1 -and
         $destinationMemberCalls[0] -ceq 'Clear') `
        'Clear is the encoder destination span''s only member call; no fill, copy, or range mutation is present'
    Add-Check 'inputBinding.completeFrameSemantics' `
        ($inputContract.report.clearedBeforeEveryEncode -eq $true -and
         $inputContract.report.statefulFields -eq $false -and
         $inputContract.report.rollingSequence -eq $false -and
         $inputContract.report.inputDefaultsOverlay -eq $false -and
         $inputContract.fullStateBehavior.priorFrameCarry -eq $false -and
         @($inputContract.fixedZeroRegions).Count -eq 4 -and
         ![regex]::IsMatch($encoderCode,
             '(?m)^\s*(?:private|internal|protected|public)\s+(?!const\b)(?:static\s+)?(?:readonly\s+)?[^\r\n(){}=]+\s+_[A-Za-z0-9_]+\s*;\s*$')) `
        'encoder is a cleared complete-frame transform with no candidate instance state or rolling sequence'

    foreach ($anchor in @($lock.inputBinding.requiredSharedMemoryAnchors)) {
        Add-Check "inputBinding.sharedMemoryAnchor.$($anchor.id)" `
            (Test-ContainsNormalized $sharedMemoryCode $anchor.text) `
            "shared-memory seam contains fail-closed relation anchor: $($anchor.text)"
    }
    $sliceMatches = @([regex]::Matches(
        $sharedMemoryCode,
        $lock.inputBinding.sharedMemorySlicePattern,
        [Text.RegularExpressions.RegexOptions]::CultureInvariant))
    $sliceOffset = if ($sliceMatches.Count -eq 1) {
        [int]$sliceMatches[0].Groups['offset'].Value
    }
    else { -1 }
    $sliceLength = if ($sliceMatches.Count -eq 1) {
        [int]$sliceMatches[0].Groups['length'].Value
    }
    else { -1 }
    Add-Check 'inputBinding.fullWireToSharedSlice' `
        ($sliceMatches.Count -eq 1 -and
         $sliceOffset -eq [int]$inputContract.coordinates.upstreamLegacySharedInput.dataOffset -and
         $sliceLength -eq [int]$inputContract.coordinates.upstreamLegacySharedInput.dataLen -and
         [int]$inputContract.coordinates.candidateFullWireEncoder.byteLength -eq
            [int]$inputContract.report.wireByteLength -and
         $inputContract.coordinates.candidateFullWireEncoder.includesReportId -eq $true -and
         [int]$inputContract.coordinates.candidateFullWireEncoder.firstByte -eq
            [int]$inputContract.report.reportId -and
         [int]$inputContract.coordinates.upstreamLegacySharedInput.byteLength -eq 63 -and
         $inputContract.coordinates.upstreamLegacySharedInput.includesReportId -eq $false) `
        "candidate strips full-wire byte $sliceOffset and submits exactly $sliceLength descriptor-data bytes"
    foreach ($anchor in @($lock.inputBinding.requiredControllerAnchors)) {
        Add-Check "inputBinding.controllerAnchor.$($anchor.id)" `
            (Test-ContainsNormalized $controllerCode $anchor.text) `
            "HMController contains input submission chain anchor: $($anchor.text)"
    }
    $allInputFramesAreFullWire = $true
    foreach ($scenario in $inputScenarios) {
        foreach ($frame in @($scenario.frames)) {
            $hex = [string]$frame.reportHex
            if ($hex -notmatch '^[0-9A-Fa-f]{128}$' -or
                !$hex.StartsWith('01', [StringComparison]::OrdinalIgnoreCase)) {
                $allInputFramesAreFullWire = $false
            }
        }
    }
    Add-Check 'inputBinding.vectorEnvelope' $allInputFramesAreFullWire `
        'all 37 frozen input frames are 64-byte full-wire reports beginning with report ID 1'
    Add-Check 'inputBinding.artifactGatesStillFalse' `
        ($aggregate.gateState.artifactCompileAllowlistFrozen -eq $false -and
         $aggregate.gateState.driverRuntimeAbiBound -eq $false -and
         $aggregate.gateState.distributionReady -eq $false) `
        'static input source binding does not freeze a compiled artifact, runtime ABI, or distribution'

    $gateNames = @(
        'artifactPublicApiAllowlistFrozen',
        'artifactCompileAllowlistFrozen',
        'profileSourceCatalogBound',
        'rawFeedbackDecoderFrozen',
        'driverRuntimeAbiBound',
        'distributionReady'
    )
    Add-Check 'gates.exactNameSet' `
        (Test-SameStringSet @($lock.gateState.PSObject.Properties.Name) $gateNames) `
        'S1.5d reports exactly the six artifact/driver/distribution gates'
    $sourceGateNames = @(
        'sourcePublicApiContractFrozen',
        'sourceCompilationDispositionFrozen',
        'profileSourceManifestFrozen',
        'rawFeedbackContractFrozen',
        'rawInputContractFrozen'
    )
    Add-Check 'gates.aggregateExactNameSet' `
        (Test-SameStringSet `
            -Left @($aggregate.gateState.PSObject.Properties.Name) `
            -Right @($sourceGateNames + $gateNames)) `
        'aggregate gate state contains exactly five source-contract gates plus six artifact/runtime gates'
    foreach ($sourceGate in $sourceGateNames) {
        $sourceGateValue = $aggregate.gateState.PSObject.Properties[$sourceGate].Value
        Add-Check "gates.sourceTrue.$sourceGate" `
            ($sourceGateValue -is [bool] -and $sourceGateValue -eq $true) `
            'the aggregate source-contract gate is explicitly true'
    }
    foreach ($gate in $gateNames) {
        $lockValue = $lock.gateState.PSObject.Properties[$gate].Value
        $aggregateValue = $aggregate.gateState.PSObject.Properties[$gate].Value
        Add-Check "gates.false.$gate" `
            ($lockValue -is [bool] -and $lockValue -eq $false -and
             $aggregateValue -is [bool] -and $aggregateValue -eq $false) `
            'both S1.5d and the aggregate contract keep this artifact gate false'
    }

    if ($checks.Count -ne [int]$lock.expectedVerifierCheckCount) {
        throw "Verifier check topology drifted: expected $($lock.expectedVerifierCheckCount), got $($checks.Count)."
    }
    $failed = @($checks | Where-Object passed -ne $true)
    $ok = $failed.Count -eq 0
    [ordered]@{
        schemaVersion = 1
        command = 'hidmaestro-s1.5d-source-candidate'
        assurance = $assurance
        ok = $ok
        workspaceRoot = $workspace
        candidateRoot = $candidateRoot
        sourceOnly = [ordered]@{
            verifierBuiltCandidate = $false
            verifierLoadedCandidate = $false
            verifierInspectedStagingBytes = $false
            verifierLoadedSdk = $false
            verifierExecutedInputSourceVerifier = $false
            verifierTouchedDriver = $false
            verifierTouchedHardware = $false
        }
        counts = [ordered]@{
            candidateFiles = $actualFiles.Count
            compileItems = $compileNodes.Count
            embeddedResources = $resourceNodes.Count
            deployableProfileSources = @($selectedProfiles | Where-Object deployable -eq $true).Count
            candidateApiTypes = $candidateApiTypeCount
            candidateApiEntries = $candidateApiEntryCount
            goldenVectors = $vectors.Count
            inputSourceBlobs = @($inputSourceLock.files).Count
            inputDescriptorGroups = @($inputContract.descriptorInputGroups).Count
            inputScenarios = $inputScenarios.Count
            inputFrames = $inputFrameCount
            lockedInputSourceVerifierChecks = [int]$lock.expectedCounts.inputSourceVerifierCheckCount
            checks = $checks.Count
        }
        candidateTreeSha256 = $candidateTreeSha256
        gateState = $lock.gateState
        checks = $checks
        note = 'Passing proves only normalized source identity, static API/ownership/feedback/input anchors, the 64-byte report-ID-1 to 63-byte legacy-data source relation, and literal project-to-profile-manifest XML closure. It does not execute the standalone input verifier, compile or load the candidate, execute the 37 input frames or 16 feedback vectors against candidate code, inspect staged upstream bytes, inspect an assembly or release DLL, bind a signed driver ABI, install anything, access hardware, or authorize distribution/product enablement.'
    } | ConvertTo-Json -Depth 12
    if (!$ok) { exit 1 }
}
catch {
    [ordered]@{
        schemaVersion = 1
        command = 'hidmaestro-s1.5d-source-candidate'
        assurance = $assurance
        ok = $false
        workspaceRoot = $workspace
        candidateRoot = $candidateRoot
        sourceOnly = [ordered]@{
            verifierBuiltCandidate = $false
            verifierLoadedCandidate = $false
            verifierInspectedStagingBytes = $false
            verifierLoadedSdk = $false
            verifierExecutedInputSourceVerifier = $false
            verifierTouchedDriver = $false
            verifierTouchedHardware = $false
        }
        gateState = [ordered]@{
            artifactPublicApiAllowlistFrozen = $false
            artifactCompileAllowlistFrozen = $false
            profileSourceCatalogBound = $false
            rawFeedbackDecoderFrozen = $false
            driverRuntimeAbiBound = $false
            distributionReady = $false
        }
        checks = $checks
        error = [ordered]@{
            code = 'hidmaestro_s1_5d_source_candidate_failed'
            message = $_.Exception.Message
        }
    } | ConvertTo-Json -Depth 12
    exit 1
}
