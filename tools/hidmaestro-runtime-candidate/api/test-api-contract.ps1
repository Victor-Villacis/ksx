[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $SourceRoot,

    [string] $WorkspaceRoot
)

$ErrorActionPreference = 'Stop'

$toolRoot = Split-Path -Parent $PSCommandPath
if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
    $WorkspaceRoot = Join-Path $toolRoot '..\..\..'
}
$workspace = [IO.Path]::GetFullPath($WorkspaceRoot)
$root = [IO.Path]::GetFullPath($SourceRoot)
$apiPath = Join-Path $toolRoot 'public-api.contract.json'
$sourcePath = Join-Path $toolRoot 'source-compilation.contract.json'
$candidatePath = Join-Path $toolRoot '..\candidate-contract.json'
$profileManifestPath = Join-Path $toolRoot '..\profiles\catalog.lock.json'
$lockPath = Join-Path $toolRoot 'contract.lock.json'
$checks = [Collections.Generic.List[object]]::new()

function Add-Check {
    param(
        [string] $Code,
        [bool] $Passed,
        [string] $Detail
    )
    $checks.Add([ordered]@{
        code = $Code
        passed = $Passed
        detail = $Detail
    })
}

function Get-CanonicalTextSha256 {
    param([string] $Path)
    $text = Get-Content -LiteralPath $Path -Raw
    $text = $text.Replace("`r`n", "`n").Replace("`r", "`n")
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($text)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('X2') }) -join '')
    }
    finally {
        $sha.Dispose()
    }
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

function Get-PinnedSourceText {
    param([string] $RelativePath)
    $path = Join-Path $root ($RelativePath -replace '/', [IO.Path]::DirectorySeparatorChar)
    return Get-Content -LiteralPath $path -Raw
}

function Get-SourceEnumValues {
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
    $body = [regex]::Replace($body, '//[^\r\n]*', '')
    $body = [regex]::Replace($body, '/\*[\s\S]*?\*/', '')
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
        [uint64] $value = 0
        if ($expression -match '^0x([0-9A-Fa-f]+)[uUlL]*$') {
            $value = [Convert]::ToUInt64($Matches[1], 16)
        }
        elseif ($expression -match '^(\d+)[uUlL]*$') {
            $value = [uint64]$Matches[1]
        }
        elseif ($expression -match '^1[uU]\s*<<\s*(\d+)$') {
            $value = [uint64]1 -shl [int]$Matches[1]
        }
        elseif ($expression -match '^([A-Za-z_][A-Za-z0-9_]*)$' -and $known.ContainsKey($Matches[1])) {
            $value = [uint64]$known[$Matches[1]]
        }
        else {
            throw "Unsupported enum expression in ${EnumName}.${name}: $expression"
        }
        $known[$name] = $value
        $values.Add([ordered]@{ name = $name; value = $value })
    }
    return $values
}

function Test-EnumContract {
    param(
        [object] $TypeContract,
        [string] $SourceText
    )
    $shortName = $TypeContract.id.Substring($TypeContract.id.LastIndexOf('.') + 1)
    $observed = @(Get-SourceEnumValues $SourceText $shortName)
    $expected = @($TypeContract.values)
    if ($observed.Count -ne $expected.Count) { return $false }
    for ($i = 0; $i -lt $expected.Count; $i++) {
        if ($observed[$i].name -cne $expected[$i].name) { return $false }
        if ([uint64]$observed[$i].value -ne [uint64]$expected[$i].value) { return $false }
    }
    return $true
}

try {
    foreach ($required in @($apiPath, $sourcePath, $candidatePath, $profileManifestPath, $lockPath)) {
        if (!(Test-Path -LiteralPath $required -PathType Leaf)) {
            throw "Required contract file is absent: $required"
        }
    }
    if (!(Test-Path -LiteralPath $root -PathType Container)) {
        throw "Source root does not exist: $root"
    }
    if (!(Test-Path -LiteralPath $workspace -PathType Container)) {
        throw "Workspace root does not exist: $workspace"
    }

    $api = Get-Content -LiteralPath $apiPath -Raw | ConvertFrom-Json
    $source = Get-Content -LiteralPath $sourcePath -Raw | ConvertFrom-Json
    $candidate = Get-Content -LiteralPath $candidatePath -Raw | ConvertFrom-Json
    $profileManifest = Get-Content -LiteralPath $profileManifestPath -Raw | ConvertFrom-Json
    $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json

    Add-Check 'contract.schema' `
        ($api.schemaVersion -eq 1 -and $source.schemaVersion -eq 1 -and
         $candidate.schemaVersion -eq 1 -and $profileManifest.schemaVersion -eq 1 -and
         $lock.schemaVersion -eq 1) `
        'all five contract files use schema version 1'

    foreach ($file in @($lock.files)) {
        $path = Join-Path $toolRoot $file.path
        $present = Test-Path -LiteralPath $path -PathType Leaf
        Add-Check "contract.present.$($file.path)" $present 'locked contract file is present'
        if (!$present) { continue }
        $actual = Get-CanonicalTextSha256 $path
        Add-Check "contract.sha256.$($file.path)" ($actual -ceq $file.sha256) `
            "expected $($file.sha256); got $actual"
    }

    Add-Check 'aggregate.contractPaths' `
        ($candidate.sourceContracts.publicApi.path -ceq 'api/public-api.contract.json' -and
         $candidate.sourceContracts.compilationDisposition.path -ceq 'api/source-compilation.contract.json' -and
         $candidate.sourceContracts.profileCatalog.path -ceq 'profiles/catalog.lock.json') `
        'aggregate source-contract paths resolve to the locked API, disposition, and profile manifests'
    Add-Check 'aggregate.sourceCoordinatesAgree' `
        ($candidate.upstreamCommit -ceq $api.upstream.commit -and
         $candidate.upstreamCommit -ceq $source.upstream.commit -and
         $candidate.upstreamCommit -ceq $profileManifest.commit -and
         $api.upstream.repository -ceq $profileManifest.repository -and
         $api.upstream.tag -ceq $profileManifest.tag) `
        'all contracts bind the same upstream repository, tag, and commit'
    Add-Check 'aggregate.artifactIdentityAgrees' `
        ($candidate.candidate -ceq 's1.5c-dualsense-conformance' -and
         $candidate.artifact.assemblyName -ceq $api.artifact.assemblyName -and
         $candidate.artifact.versionContract.assemblyVersion -ceq $api.artifact.assemblyVersion -and
         $candidate.artifact.versionContract.fileVersion -ceq $api.artifact.fileVersion -and
         $candidate.artifact.versionContract.informationalVersion -ceq $api.artifact.informationalVersion -and
         $candidate.artifact.targetFramework -ceq $api.artifact.targetFramework -and
         $candidate.artifact.runtimeIdentifier -ceq $api.artifact.runtimeIdentifier -and
         $api.artifact.informationalVersion -ceq
            '1.6.1-ksx-s1.5c+upstream.2a0dac0857901a63d365a36dcf99cf50114ca954') `
        'aggregate and API contracts identify the same S1.5c artifact'
    Add-Check 'aggregate.apiSummaryAgrees' `
        ($candidate.sourceContracts.publicApi.publicTypeCount -eq $api.surfaceRules.declaredTypeCount -and
         $candidate.sourceContracts.publicApi.logicalMemberCount -eq $api.surfaceRules.logicalMemberCount -and
         $candidate.sourceContracts.publicApi.actionsObservationMetadataMatched -eq $false -and
         $candidate.sourceContracts.publicApi.artifactMetadataAllowlistAdopted -eq $false) `
        'aggregate API counts derive from the source-frozen target while observation and adoption remain false'

    $manifestCanonicalSha256 = Get-CanonicalTextSha256 $profileManifestPath
    $manifestEntries = @($profileManifest.entries)
    $embeddedManifestEntries = @($manifestEntries | Where-Object classification -ceq 'embedded-profile-source')
    $deployableManifestEntries = @($embeddedManifestEntries | Where-Object deployable -eq $true)
    $duplicateManifestIds = @($embeddedManifestEntries.profileId |
        ForEach-Object { ([string]$_).ToUpperInvariant() } |
        Group-Object | Where-Object Count -ne 1)
    Add-Check 'aggregate.profileManifestIdentity' `
        ($manifestCanonicalSha256 -ceq
            'CBCEC6094D314ED4637BFA1C295E27236C39F784D9FF1D016791CC375FF25B80' -and
         $candidate.sourceContracts.profileCatalog.manifestCanonicalSha256 -ceq $manifestCanonicalSha256 -and
         $candidate.artifact.embeddedResourcePolicy.sourceManifestCanonicalSha256 -ceq $manifestCanonicalSha256 -and
         $candidate.artifact.embeddedResourcePolicy.sourceManifestPath -ceq
            $candidate.sourceContracts.profileCatalog.path) `
        'aggregate profile authorities resolve to the exact locked source manifest'
    Add-Check 'aggregate.profileCountsAgree' `
        ($manifestEntries.Count -eq 231 -and $embeddedManifestEntries.Count -eq 228 -and
         $deployableManifestEntries.Count -eq 130 -and $duplicateManifestIds.Count -eq 0 -and
         $candidate.sourceContracts.profileCatalog.profileTreeFileCount -eq $manifestEntries.Count -and
         $candidate.sourceContracts.profileCatalog.embeddedProfileSourceCount -eq $embeddedManifestEntries.Count -and
         $candidate.sourceContracts.profileCatalog.deployableProfileSourceCount -eq $deployableManifestEntries.Count -and
         $candidate.sourceContracts.profileCatalog.duplicateProfileIdCount -eq $duplicateManifestIds.Count) `
        'aggregate 231/228/130/0 counts derive from the locked profile entries'
    Add-Check 'aggregate.fullResourcePolicyAgrees' `
        ($candidate.artifact.embeddedResourcePolicy.allowedPrefix -ceq 'HIDMaestro.Profiles.' -and
         $candidate.artifact.embeddedResourcePolicy.resourceCount -eq $embeddedManifestEntries.Count -and
         $candidate.artifact.embeddedResourcePolicy.deployableProfileCount -eq $deployableManifestEntries.Count -and
         $candidate.artifact.embeddedResourcePolicy.sourceManifestSelection -ceq
            'all entries whose classification is embedded-profile-source') `
        'future artifact resource policy includes all 228 manifest-selected profile sources'
    Add-Check 'aggregate.releaseCatalogRemainsUnbound' `
        ($candidate.artifact.embeddedResourcePolicy.catalogSha256 -ceq
            $profileManifest.releaseDllComparison.catalogSha256 -and
         $candidate.artifact.embeddedResourcePolicy.sourceToReleaseCatalogBinding -ceq 'unresolved' -and
         $candidate.sourceContracts.profileCatalog.releaseDllCatalogBinding -ceq 'unresolved' -and
         $profileManifest.releaseDllComparison.sourceToReleaseCatalogBinding -ceq 'unresolved' -and
         $profileManifest.releaseDllComparison.catalogSha256ReproducedFromSource -eq $false -and
         $candidate.gateState.profileSourceCatalogBound -eq $false) `
        'the official release digest remains comparison evidence, not a claimed source binding'

    $futureResources = $source.futureCompileManifest.resourceUnits
    Add-Check 'source.futureResourceManifestAgrees' `
        ($futureResources.manifestPathRelativeToRuntimeCandidateRoot -ceq
            $candidate.sourceContracts.profileCatalog.path -and
         $futureResources.manifestCanonicalSha256 -ceq $manifestCanonicalSha256 -and
         $futureResources.selection -ceq
            $candidate.artifact.embeddedResourcePolicy.sourceManifestSelection -and
         $futureResources.count -eq $embeddedManifestEntries.Count -and
         $futureResources.deployableProfileCount -eq $deployableManifestEntries.Count -and
         $futureResources.releaseDllCatalogBinding -ceq 'unresolved') `
        'future compile manifest takes its complete resource set from the locked full-catalog authority'
    $catalogReplacement = @($source.classification.replacementRequired |
        Where-Object { @($_.upstreamUnits) -ccontains 'sdk/HIDMaestro.Core/Internal/ControllerProfile.cs' })
    Add-Check 'source.fullCatalogReplacement' `
        ($catalogReplacement.Count -eq 1 -and
         (Test-SameOrderedStrings @($catalogReplacement[0].plannedCandidateUnits) `
            @('candidate/Internal/RuntimeProfileCatalog.cs')) -and
         @($source.futureCompileManifest.compileUnits) -ccontains
            'candidate/Internal/RuntimeProfileCatalog.cs' -and
         @($source.futureCompileManifest.compileUnits) -cnotcontains
            'candidate/Internal/RuntimeDualSenseProfile.cs') `
        'the planned catalog unit is full-catalog while S2 controller creation remains separately constrained'
    Add-Check 'aggregate.summariesAreNonAuthoritative' `
        ($candidate.implementationSafetySummary.nonAuthoritative -eq $true -and
         $candidate.implementationSafetySummary.authoritativeSourceDisposition -ceq
            'api/source-compilation.contract.json' -and
         $candidate.excludedSourceHazardSummary.nonAuthoritative -eq $true -and
         $candidate.excludedSourceHazardSummary.authoritativeSourceDisposition -ceq
            'api/source-compilation.contract.json') `
        'legacy safety and hazard lists explicitly defer to the exhaustive source-disposition contract'
    Add-Check 'aggregate.gatesRemainInert' `
        ($candidate.status -ceq 's1.5e-source-frozen-observation-not-established-not-built-or-loaded' -and
         $api.status -ceq 'exact-candidate-source-allowlist-s1.5e-source-frozen-observation-not-established' -and
         $candidate.gateState.sourcePublicApiContractFrozen -eq $true -and
         $candidate.gateState.sourceCompilationDispositionFrozen -eq $true -and
         $candidate.gateState.profileSourceManifestFrozen -eq $true -and
         $candidate.gateState.rawFeedbackContractFrozen -eq $true -and
         $candidate.gateState.rawInputContractFrozen -eq $true -and
         $candidate.sourceContracts.rawDualSenseFeedback.goldenVectorCount -eq 16 -and
         $candidate.sourceContracts.rawDualSenseFeedback.managedRuntimeAdapterPresent -eq $true -and
         $candidate.sourceContracts.rawDualSenseFeedback.hardwareVerified -eq $false -and
         $candidate.sourceContracts.rawDualSenseInput.sourceFileCount -eq 12 -and
         $candidate.sourceContracts.rawDualSenseInput.descriptorGroupCount -eq 6 -and
         $candidate.sourceContracts.rawDualSenseInput.goldenScenarioCount -eq 9 -and
         $candidate.sourceContracts.rawDualSenseInput.goldenFrameCount -eq 37 -and
         $candidate.sourceContracts.rawDualSenseInput.managedRuntimeEncoderPresent -eq $true -and
         $candidate.sourceContracts.rawDualSenseInput.artifactBehaviorVerified -eq $false -and
         $candidate.gateState.artifactPublicApiAllowlistFrozen -eq $false -and
         $candidate.gateState.artifactCompileAllowlistFrozen -eq $false -and
         $candidate.gateState.profileSourceCatalogBound -eq $false -and
         $candidate.gateState.rawFeedbackDecoderFrozen -eq $false -and
         $candidate.gateState.driverRuntimeAbiBound -eq $false -and
         $candidate.gateState.distributionReady -eq $false -and
         $candidate.artifact.observation.contractPath -ceq 's1_5e/contract.lock.json' -and
         $candidate.artifact.observation.contractId -ceq 'hidmaestro-s1.5e-actions-static-artifact-observation' -and
         $candidate.artifact.observation.contractReferenceState -ceq 'source-frozen-observation-not-established' -and
         $candidate.artifact.observation.actionsObservationBuildAuthorized -eq $true -and
         $candidate.artifact.observation.sourceVerifierBuildAuthorized -eq $false -and
         $candidate.artifact.observation.localBuildAuthorized -eq $false -and
         $candidate.artifact.observation.productBuildAuthorized -eq $false -and
         $candidate.artifact.observation.loadAuthorized -eq $false -and
         $candidate.artifact.observation.executionAuthorized -eq $false -and
         $candidate.artifact.observation.observationEstablished -eq $false -and
         $candidate.artifact.observation.actionsObservationArtifactBuilt -eq $false -and
         $candidate.artifact.observation.metadataMatched -eq $false -and
         $candidate.artifact.observation.compileClosureMatched -eq $false -and
         $candidate.artifact.observation.resourceCatalogMatched -eq $false -and
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
         $api.artifact.observation.artifactAllowlistAdopted -eq $false -and
         $api.artifact.loadAuthorized -eq $false -and
         $api.artifact.executionAuthorized -eq $false) `
        'the S1.5e source leaf is frozen and only its exact Actions observation build is authorized; observation evidence, adoption, load, execution, driver, and distribution remain false'

    $commitOutput = @(& git -C $root rev-parse HEAD 2>$null)
    $commitExitCode = $LASTEXITCODE
    $actualCommit = $commitOutput | Select-Object -First 1
    if ($commitExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($actualCommit)) {
        throw 'Source root is not a readable Git checkout.'
    }
    $actualCommit = $actualCommit.Trim()
    Add-Check 'source.commit' `
        ($actualCommit -ceq $api.upstream.commit -and $actualCommit -ceq $source.upstream.commit) `
        "expected $($api.upstream.commit); got $actualCommit"
    Add-Check 'source.coordinatesAgree' `
        ($api.upstream.repository -ceq $source.upstream.repository -and
         $api.upstream.tag -ceq $source.upstream.tag -and
         $api.upstream.checkoutBytes -ceq $source.upstream.checkoutBytes) `
        'API and source manifests bind the same repository, tag and checkout-byte policy'

    $hashProperties = @($source.unitSha256.PSObject.Properties)
    Add-Check 'source.unitHashCount' `
        ($hashProperties.Count -eq $source.coverage.expectedUpstreamUnitCount -and $hashProperties.Count -eq 51) `
        "expected 51; got $($hashProperties.Count)"

    foreach ($property in $hashProperties) {
        $relative = $property.Name
        $path = Join-Path $root ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)
        $present = Test-Path -LiteralPath $path -PathType Leaf
        Add-Check "source.present.$relative" $present 'classified upstream unit is present'
        if (!$present) { continue }
        $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
        Add-Check "source.sha256.$relative" ($actual -ceq [string]$property.Value) `
            "expected $($property.Value); got $actual"
    }

    foreach ($input in @($source.nonCompilationInputs)) {
        $path = Join-Path $root ($input.path -replace '/', [IO.Path]::DirectorySeparatorChar)
        $present = Test-Path -LiteralPath $path -PathType Leaf
        Add-Check "input.present.$($input.path)" $present 'non-compilation input is present'
        if (!$present) { continue }
        $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
        Add-Check "input.sha256.$($input.path)" ($actual -ceq $input.sha256) `
            "expected $($input.sha256); got $actual"
    }

    $treeOutput = @(& git -C $root ls-tree -r --name-only HEAD -- $source.coverage.root 2>$null)
    $treeExitCode = $LASTEXITCODE
    $treeUnits = @($treeOutput |
        Where-Object { $_ -like '*.cs' -or $_ -like '*.csproj' } |
        Sort-Object)
    if ($treeExitCode -ne 0) { throw 'Unable to enumerate pinned source tree.' }
    $hashedUnits = @($hashProperties.Name | Sort-Object)
    Add-Check 'source.treeExactlyCovered' (Test-SameOrderedStrings $treeUnits $hashedUnits) `
        "tree units=$($treeUnits.Count); manifest units=$($hashedUnits.Count)"

    $retained = @($source.classification.retainUnchanged)
    $replacement = @($source.classification.replacementRequired | ForEach-Object { @($_.upstreamUnits) })
    $excluded = @($source.classification.excluded)
    $classified = @($retained + $replacement + $excluded)
    $duplicateClassifications = @($classified | Group-Object | Where-Object Count -ne 1)
    Add-Check 'source.classifiedOnce' `
        ($duplicateClassifications.Count -eq 0 -and $classified.Count -eq 51) `
        "classified=$($classified.Count); duplicate groups=$($duplicateClassifications.Count)"
    Add-Check 'source.classificationCoversHashes' (Test-SameStringSet $classified $hashedUnits) `
        'classification paths exactly equal the pinned unit-hash paths'
    Add-Check 'aggregate.compilationSummaryAgrees' `
        ($candidate.sourceContracts.compilationDisposition.upstreamUnitCount -eq $hashedUnits.Count -and
         $candidate.sourceContracts.compilationDisposition.retainedUnchangedCount -eq $retained.Count -and
         $candidate.sourceContracts.compilationDisposition.replacementRequiredCount -eq $replacement.Count -and
         $candidate.sourceContracts.compilationDisposition.excludedCount -eq $excluded.Count -and
         $candidate.sourceContracts.compilationDisposition.replacementSourcesPresent -eq $true) `
        'aggregate 51/1/13/37 source-disposition counts derive from the exhaustive manifest'
    Add-Check 'source.onlyPacketRetained' `
        ($retained.Count -eq 1 -and $retained[0] -ceq 'sdk/HIDMaestro.Core/HMOutputPacket.cs') `
        'only HMOutputPacket.cs is copied byte-for-byte into the planned candidate'

    $replacementFlags = @($source.classification.replacementRequired | ForEach-Object { [bool]$_.replacementPresent })
    $allReplacementFlagsTrue = @($replacementFlags | Where-Object { $_ -ne $true }).Count -eq 0
    $newUnitFlags = @($source.requiredNewUnits | ForEach-Object { [bool]$_.present })
    $allNewUnitFlagsTrue = @($newUnitFlags | Where-Object { $_ -ne $true }).Count -eq 0
    Add-Check 'source.replacementsTruthfullyPresent' `
        ($allReplacementFlagsTrue -and $allNewUnitFlagsTrue -and
         $source.futureCompileManifest.allReplacementUnitsPresent -eq $true) `
        'every planned replacement and required new source unit is explicitly present'
    Add-Check 'source.observationAuthority' `
        ($source.status -ceq 'exhaustive-upstream-classification-s1.5e-source-frozen-observation-not-established' -and
         $source.futureCompileManifest.state -ceq 'source-candidate-present-hash-frozen-s1.5e-source-frozen-observation-not-established' -and
         $source.futureCompileManifest.artifactCompileAllowlistFrozen -eq $false -and
         $source.futureCompileManifest.observation.contractPath -ceq '../s1_5e/contract.lock.json' -and
         $source.futureCompileManifest.observation.contractId -ceq 'hidmaestro-s1.5e-actions-static-artifact-observation' -and
         $source.futureCompileManifest.observation.contractReferenceState -ceq 'source-frozen-observation-not-established' -and
         $source.futureCompileManifest.observation.actionsObservationBuildAuthorized -eq $true -and
         $source.futureCompileManifest.observation.sourceVerifierBuildAuthorized -eq $false -and
         $source.futureCompileManifest.observation.localBuildAuthorized -eq $false -and
         $source.futureCompileManifest.observation.productBuildAuthorized -eq $false -and
         $source.futureCompileManifest.observation.loadAuthorized -eq $false -and
         $source.futureCompileManifest.observation.executionAuthorized -eq $false -and
         $source.futureCompileManifest.observation.observationEstablished -eq $false -and
         $source.futureCompileManifest.observation.actionsObservationArtifactBuilt -eq $false -and
         $source.futureCompileManifest.observation.metadataMatched -eq $false -and
         $source.futureCompileManifest.observation.compileClosureMatched -eq $false -and
         $api.artifact.buildAuthorization.sourceVerifier -eq $false -and
         $api.artifact.buildAuthorization.s1_5eActionsObservation -eq $true -and
         $api.artifact.buildAuthorization.local -eq $false -and
         $api.artifact.buildAuthorization.product -eq $false -and
         $api.artifact.loadAuthorized -eq $false -and
         $api.artifact.executionAuthorized -eq $false) `
        'the S1.5e source leaf is frozen and only its exact Actions observation build is authorized; all other build, load, and execution scopes remain false'

    Add-Check 'api.artifactIdentity' `
        ($api.artifact.assemblyName -ceq 'HIDMaestro.Core' -and
         $api.artifact.assemblyVersion -ceq '1.6.1.0' -and
         $api.artifact.fileVersion -ceq '1.6.1.0' -and
         $api.artifact.informationalVersion -ceq '1.6.1-ksx-s1.5c+upstream.2a0dac0857901a63d365a36dcf99cf50114ca954' -and
         $api.artifact.targetFramework -ceq 'net10.0-windows10.0.26100.0' -and
         $api.artifact.runtimeIdentifier -ceq 'win-x64') `
        'candidate identity and source-derived version are exact'

    $typeContracts = @($api.types)
    $typeIds = @($typeContracts.id)
    $duplicateTypes = @($typeIds | Group-Object | Where-Object Count -ne 1)
    Add-Check 'api.typeCount' `
        ($typeContracts.Count -eq $api.surfaceRules.declaredTypeCount -and $typeContracts.Count -eq 9) `
        "expected 9; got $($typeContracts.Count)"
    Add-Check 'api.uniqueTypes' ($duplicateTypes.Count -eq 0) `
        "duplicate type groups=$($duplicateTypes.Count)"
    Add-Check 'api.closedTypeSet' (Test-SameStringSet $typeIds @($api.hidmaestroTypeClosure)) `
        'declared type IDs exactly equal the HIDMaestro type closure'
    $externalTypes = @($api.externalTypeDependencies)
    $duplicateExternalTypes = @($externalTypes | Group-Object | Where-Object Count -ne 1)
    Add-Check 'api.externalTypeDependencyCount' `
        ($externalTypes.Count -eq $api.surfaceRules.externalTypeDependencyCount -and
         $externalTypes.Count -eq 16 -and $duplicateExternalTypes.Count -eq 0) `
        "expected 16 unique external type dependencies; got $($externalTypes.Count)"

    $logicalMemberCount = 0
    foreach ($type in $typeContracts) {
        $entries = if ($type.kind -ceq 'enum') { @($type.values) } else { @($type.members) }
        $logicalMemberCount += $entries.Count
        $duplicateMembers = @($entries.id | Where-Object { $null -ne $_ } | Group-Object | Where-Object Count -ne 1)
        $duplicateValues = @($entries.name | Where-Object { $null -ne $_ } | Group-Object | Where-Object Count -ne 1)
        Add-Check "api.uniqueEntries.$($type.id)" `
            ($duplicateMembers.Count -eq 0 -and $duplicateValues.Count -eq 0) `
            'member IDs or enum names are unique within the type'

        $sourceText = Get-PinnedSourceText $type.sourcePath
        $actualHash = (Get-FileHash -LiteralPath (Join-Path $root ($type.sourcePath -replace '/', [IO.Path]::DirectorySeparatorChar)) -Algorithm SHA256).Hash
        Add-Check "api.sourceHash.$($type.id)" ($actualHash -ceq $type.sourceSha256) `
            "expected $($type.sourceSha256); got $actualHash"
        Add-Check "api.typeAnchor.$($type.id)" (Test-ContainsNormalized $sourceText $type.sourceTypeAnchor) `
            "pinned source contains type declaration anchor: $($type.sourceTypeAnchor)"

        foreach ($entry in $entries) {
            $anchorPresent = Test-ContainsNormalized $sourceText $entry.sourceAnchor
            $entryName = if ($null -ne $entry.id) { $entry.id } else { $entry.name }
            Add-Check "api.anchor.$($type.id).$entryName" $anchorPresent `
                "pinned source contains declaration anchor: $($entry.sourceAnchor)"
            foreach ($reference in @($entry.hidmaestroTypeRefs | Where-Object { $null -ne $_ })) {
                Add-Check "api.closure.$($type.id).$entryName.$reference" ($typeIds -ccontains $reference) `
                    'every HIDMaestro signature reference resolves inside the declared type closure'
            }
            $signatureText = [string]$entry.signature
            foreach ($accessor in @($entry.metadataAccessors | Where-Object { $null -ne $_ })) {
                $signatureText += " $accessor"
            }
            foreach ($parameter in @($entry.parameterMetadata | Where-Object { $null -ne $_ })) {
                $signatureText += " $($parameter.type)"
            }
            $signatureRefs = @([regex]::Matches($signatureText, 'HIDMaestro\.[A-Za-z_][A-Za-z0-9_]*') |
                ForEach-Object Value | Sort-Object -Unique)
            foreach ($reference in $signatureRefs) {
                Add-Check "api.signatureClosure.$($type.id).$entryName.$reference" ($typeIds -ccontains $reference) `
                    'every HIDMaestro type named by the canonical signature resolves inside the declared closure'
            }
        }

        if ($type.kind -ceq 'enum') {
            Add-Check "api.enumValues.$($type.id)" (Test-EnumContract $type $sourceText) `
                'enum order, names and numeric values exactly match the pinned source declaration'
        }

        $expectedDisposition = if ($retained -ccontains $type.sourcePath) {
            'retain-unchanged'
        }
        elseif ($replacement -ccontains $type.sourcePath) {
            'replacement-required'
        }
        else {
            'invalid'
        }
        Add-Check "api.disposition.$($type.id)" ($type.sourceDisposition -ceq $expectedDisposition) `
            "expected $expectedDisposition; got $($type.sourceDisposition)"
    }
    Add-Check 'api.logicalMemberCount' `
        ($logicalMemberCount -eq $api.surfaceRules.logicalMemberCount -and $logicalMemberCount -eq 100) `
        "expected 100; got $logicalMemberCount"

    $retainedTypes = @($typeContracts | Where-Object sourceDisposition -ceq 'retain-unchanged' | ForEach-Object id | Sort-Object)
    Add-Check 'api.onlyPacketTypesRetained' `
        (Test-SameOrderedStrings $retainedTypes @('HIDMaestro.HMOutputPacket', 'HIDMaestro.HMOutputSource')) `
        'the sole retained source file contributes exactly packet and source types'

    $statePath = Join-Path $workspace 'crates\ksx-hidmaestro\src\state.rs'
    $axisPath = Join-Path $workspace 'crates\ksx-hidmaestro\src\axis.rs'
    if (!(Test-Path -LiteralPath $statePath -PathType Leaf) -or !(Test-Path -LiteralPath $axisPath -PathType Leaf)) {
        throw 'KSX Rust state/axis source is absent; source-to-consumer enum cross-check cannot run.'
    }
    $stateRust = Get-Content -LiteralPath $statePath -Raw
    $axisRust = Get-Content -LiteralPath $axisPath -Raw

    $buttonType = $typeContracts | Where-Object id -ceq 'HIDMaestro.HMButton'
    $buttonNames = [ordered]@{
        A='A'; B='B'; X='X'; Y='Y'; LeftBumper='LEFT_SHOULDER'; RightBumper='RIGHT_SHOULDER';
        Back='BACK'; Start='START'; LeftStick='LEFT_THUMB'; RightStick='RIGHT_THUMB'; Guide='GUIDE';
        Touchpad='TOUCHPAD'; Share='SHARE'; RightPaddle='RIGHT_PADDLE'; LeftPaddle='LEFT_PADDLE';
        Misc1='MISC1'; RightPaddle2='RIGHT_PADDLE2'; LeftPaddle2='LEFT_PADDLE2';
        Cross='CROSS'; Circle='CIRCLE'; Square='SQUARE'; Triangle='TRIANGLE'
    }
    foreach ($value in @($buttonType.values | Where-Object name -cne 'None')) {
        $rustName = $buttonNames[$value.name]
        if ($null -ne $value.aliasOf) {
            $aliasTarget = $buttonNames[$value.aliasOf]
            $anchor = "pub const ${rustName}: u32 = ${aliasTarget};"
        }
        else {
            $bit = 0
            [uint64] $probe = [uint64]$value.value
            while ($probe -gt 1) { $probe = $probe -shr 1; $bit++ }
            $anchor = "pub const ${rustName}: u32 = 1 << ${bit};"
        }
        Add-Check "rust.button.$($value.name)" (Test-ContainsNormalized $stateRust $anchor) `
            "Rust mapping matches $($value.name)=$($value.value)"
    }
    Add-Check 'rust.noInventedTriggerButtons' `
        (-not (Test-ContainsNormalized $stateRust 'pub const LEFT_TRIGGER:') -and
         -not (Test-ContainsNormalized $stateRust 'pub const RIGHT_TRIGGER:')) `
        'Rust does not invent HMButton trigger bits absent from the pinned enum'

    $hatType = $typeContracts | Where-Object id -ceq 'HIDMaestro.HMHat'
    foreach ($value in @($hatType.values)) {
        $rustName = if ($value.name -ceq 'None') { 'Centered' } else { $value.name }
        $anchor = "${rustName} = $($value.value),"
        Add-Check "rust.hat.$($value.name)" (Test-ContainsNormalized $stateRust $anchor) `
            "Rust mapping matches HMHat.$($value.name)=$($value.value)"
    }

    $axisType = $typeContracts | Where-Object id -ceq 'HIDMaestro.HMAxis'
    $rustAxisNames = [ordered]@{ X='X'; Y='Y'; Z='Z'; Rx='RX'; Ry='RY'; Rz='RZ'; Slider='SLIDER'; Dial='DIAL' }
    foreach ($name in @($rustAxisNames.Keys)) {
        $value = $axisType.values | Where-Object name -ceq $name
        $hex = '0x{0:X4}' -f [int]$value.value
        $anchor = "pub const $($rustAxisNames[$name]): Self = Self(${hex});"
        Add-Check "rust.axis.$name" (Test-ContainsNormalized $axisRust $anchor) `
            "Rust mapping matches HMAxis.$name=$hex"
    }

    if ($checks.Count -ne [int]$lock.expectedVerifierCheckCount) {
        throw "Verifier check topology drifted: expected $($lock.expectedVerifierCheckCount), got $($checks.Count)."
    }
    $failed = @($checks | Where-Object passed -ne $true)
    $ok = $failed.Count -eq 0
    [ordered]@{
        schemaVersion = 1
        command = 'hidmaestro-runtime-api-source-contract'
        assurance = 'hash-pinned-static-source-and-source-text-consumer-anchors-only'
        ok = $ok
        sourceRoot = $root
        workspaceRoot = $workspace
        upstreamCommit = $actualCommit
        publicTypeCount = $typeContracts.Count
        logicalMemberCount = $logicalMemberCount
        upstreamUnitCount = $treeUnits.Count
        checks = $checks
        note = 'Passing proves pinned upstream provenance, exact API contract closure, exhaustive source disposition, and Rust enum-value agreement only. This verifier builds, loads, and executes no candidate or SDK assembly. It records the source-frozen S1.5e Actions observation as authorized but not established, with no artifact evidence or product authority established.'
    } | ConvertTo-Json -Depth 10
    if (!$ok) { exit 1 }
}
catch {
    [ordered]@{
        schemaVersion = 1
        command = 'hidmaestro-runtime-api-source-contract'
        assurance = 'hash-pinned-static-source-and-source-text-consumer-anchors-only'
        ok = $false
        sourceRoot = $root
        workspaceRoot = $workspace
        checks = $checks
        error = [ordered]@{
            code = 'runtime_api_source_contract_failed'
            message = $_.Exception.Message
        }
    } | ConvertTo-Json -Depth 10
    exit 1
}
