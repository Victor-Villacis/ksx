[CmdletBinding()]
param(
    [string] $WorkspaceRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

trap {
    Write-Host ("S1.5e static verifier exception: " + $_.Exception.Message + " " +
        $_.InvocationInfo.PositionMessage)
    $failure = [ordered]@{
        schemaVersion = 1
        ok = $false
        assurance = 'static-source-only-s1.5e-observation-infrastructure'
        errorType = $_.Exception.GetType().FullName
        diagnostic = 'Static source verification failed before the complete receipt; inspect the ephemeral diagnostic stream.'
        observationEstablished = $false
        candidateBuilt = $false
        candidateLoaded = $false
        candidateExecuted = $false
    }
    $failure | ConvertTo-Json -Depth 20
    exit 1
}

$leafRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $leafRoot '..'))
if ([string]::IsNullOrWhiteSpace($WorkspaceRoot)) {
    $WorkspaceRoot = Join-Path $leafRoot '..\..\..'
}
$workspace = [IO.Path]::GetFullPath($WorkspaceRoot)
$lockPath = Join-Path $leafRoot 'contract.lock.json'
$lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
$checks = [Collections.Generic.List[object]]::new()
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)

function Add-Check {
    param([string] $Code, [bool] $Passed, [string] $Detail)
    [void]$checks.Add([ordered]@{ code = $Code; passed = $Passed; detail = $Detail })
}

function Assert-Check {
    param([string] $Code, [bool] $Condition, [string] $Detail)
    Add-Check -Code $Code -Passed $Condition -Detail $Detail
}

function ConvertTo-NormalizedTextBytes {
    param([byte[]] $Bytes)
    if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and
        $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) {
        throw 'BOM is forbidden in workspace-authored text.'
    }
    $text = $utf8.GetString($Bytes).Replace("`r`n", "`n")
    if ($text.IndexOf("`r", [StringComparison]::Ordinal) -ge 0) {
        throw 'Bare carriage return is forbidden in workspace-authored text.'
    }
    return ,$utf8.GetBytes($text)
}

function Get-NormalizedBytes {
    param([string] $Path)
    return ,(ConvertTo-NormalizedTextBytes -Bytes ([IO.File]::ReadAllBytes($Path)))
}

function Get-NormalizedSha256 {
    param([string] $Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return [BitConverter]::ToString($sha.ComputeHash((Get-NormalizedBytes $Path))).Replace('-', '')
    } finally {
        $sha.Dispose()
    }
}

function Has-Literal {
    param([string] $Text, [string] $Literal)
    return $Text.IndexOf($Literal, [StringComparison]::Ordinal) -ge 0
}

function Has-Regex {
    param([string] $Text, [string] $Pattern)
    return [regex]::IsMatch($Text, $Pattern, [Text.RegularExpressions.RegexOptions]::CultureInvariant)
}

function Get-OrdinalSorted {
    param([AllowEmptyCollection()][string[]] $Values)
    $copy = [string[]]@($Values)
    [Array]::Sort($copy, [StringComparer]::Ordinal)
    return ,$copy
}

function Get-LeafRelativePath {
    param([string] $Root, [string] $Path)
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $pathFull = [IO.Path]::GetFullPath($Path)
    $rootUri = [Uri]$rootFull
    $pathUri = [Uri]$pathFull
    return [Uri]::UnescapeDataString($rootUri.MakeRelativeUri($pathUri).ToString())
}

$bareCrRejected = $false
try {
    [void](ConvertTo-NormalizedTextBytes -Bytes $utf8.GetBytes("left`rright"))
} catch {
    $bareCrRejected = $_.Exception.Message -ceq
        'Bare carriage return is forbidden in workspace-authored text.'
}
Assert-Check 'verifier.rejects-bare-cr' $bareCrRejected `
    'Workspace-authored normalized hashing rejects bare carriage returns.'

$expectedLeafFiles = @(
    'README.md',
    'contract.lock.json',
    'inspector/HIDMaestro.ArtifactInspector.csproj',
    'inspector/Program.cs',
    'run-actions-proof.ps1',
    'verify-source-contract.ps1'
)
$actualLeafFiles = Get-OrdinalSorted -Values @(Get-ChildItem -LiteralPath $leafRoot -File -Recurse -Force |
    ForEach-Object {
        (Get-LeafRelativePath -Root $leafRoot -Path $_.FullName).Replace('\', '/')
    })
Assert-Check 'leaf.file-set' `
    ($actualLeafFiles.Count -eq $expectedLeafFiles.Count -and
        [string]::Join("`n", $actualLeafFiles) -ceq
            [string]::Join("`n", (Get-OrdinalSorted -Values $expectedLeafFiles))) `
    'The leaf contains exactly the six planned files.'
$leafReparse = @(@(
    Get-Item -LiteralPath $leafRoot -Force
    Get-ChildItem -LiteralPath $leafRoot -Force -Recurse
) | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
Assert-Check 'leaf.no-reparse' ($leafReparse.Count -eq 0) `
    'Leaf root, directories, and files are not reparse points.'

Assert-Check 'lock.schema' ($lock.schemaVersion -eq 1) 'Schema version is one.'
Assert-Check 'lock.contract-id' `
    ($lock.contractId -ceq 'hidmaestro-s1.5e-actions-static-artifact-observation') `
    'Contract identifier is exact.'
Assert-Check 'lock.status' `
    ($lock.status -ceq 'observation-infrastructure-source-present-actions-not-run') `
    'Status is source-only and pre-observation.'
Assert-Check 'lock.observation-not-established' ($lock.observationEstablished -eq $false) `
    'The source lock does not claim Actions evidence.'
Assert-Check 'lock.actions-only-build' `
    ($lock.toolchain.actionsObservationBuildAuthorized -eq $true -and
     $lock.toolchain.localBuildAuthorized -eq $false -and
     $lock.toolchain.candidateLoadAuthorized -eq $false -and
     $lock.toolchain.candidateExecutionAuthorized -eq $false -and
     $lock.toolchain.artifactRetentionAuthorized -eq $false) `
    'Only the bounded Actions observation build is authorized.'
Assert-Check 'lock.sdk' ($lock.toolchain.dotnetSdk -ceq '10.0.400') 'SDK is exact.'
Assert-Check 'lock.inspector-runtime' `
    ($lock.toolchain.inspectorRuntimeFrameworkVersion -ceq '10.0.11' -and
     $lock.toolchain.inspectorRuntimeVersionFileRelativePath -ceq
        'shared/Microsoft.NETCore.App/10.0.11/.version' -and
     $lock.toolchain.inspectorRuntimeVersionFileByteLength -eq 51 -and
     $lock.toolchain.inspectorRuntimeVersionFileSha256 -ceq
        '13B770DFE2DFC0294F8C5A9CD60198F365745A219878910A572FD85784D3B733' -and
     @($lock.toolchain.inspectorRuntimeVersionFileLines).Count -eq 2 -and
     [string]::Join("`n", @($lock.toolchain.inspectorRuntimeVersionFileLines)) -ceq
        "e2f47b0110ed922f21a1522da67279133ce28f32`n10.0.11" -and
     $lock.toolchain.inspectorRuntimeMustBeListedUnderResolvedDotnetRoot -eq $true -and
     $lock.toolchain.inspectorRuntimeTreeBoundBeforeAndAfterLaunch -eq $true -and
     $lock.toolchain.inspectorRuntimePathRedactedFromReceipt -eq $true) `
    'Inspector host framework version, root, tree binding, and receipt redaction are exact.'
Assert-Check 'lock.build-count' ($lock.toolchain.buildCount -eq 2) 'Two builds are required.'
$expectedCoreAnalyzers = Get-OrdinalSorted -Values @(
    'analyzers/dotnet/cs/Microsoft.Interop.ComInterfaceGenerator.dll|6AD171126DF1AE4DB0420EDFA9791C2CE2599AF758C506BEAB1F29CC9219FE2B',
    'analyzers/dotnet/cs/Microsoft.Interop.JavaScript.JSImportGenerator.dll|6C06555039E10929673A5EA53CB5CFF7324D292C989D77F0D10DDD56198D6DE1',
    'analyzers/dotnet/cs/Microsoft.Interop.LibraryImportGenerator.dll|AE1A7C7BEE96FCD69C66FF4FC1CD4D5E2C2474E1644EA9547A11048CF648871C',
    'analyzers/dotnet/cs/Microsoft.Interop.SourceGeneration.dll|5EFC03100F5C544F64ACE8D240BB73661D1BDA8B01BD69BC4D1FB24D605F8BB5',
    'analyzers/dotnet/cs/System.Text.Json.SourceGeneration.dll|82CA672F31AD099C9E823B646C27F3A1DA249E3C5574B1DBC4DC76DEE234BD12',
    'analyzers/dotnet/cs/System.Text.RegularExpressions.Generator.dll|D5B18010ED85ABA3C8807BD3CFA01097BF99E1B6460E99B9A26EB74BFCE12B10'
)
$actualCoreAnalyzers = Get-OrdinalSorted -Values @(
    $lock.targetingPacks.netCoreAppRef.analyzers | ForEach-Object {
        [string]$_.path + '|' + [string]$_.sha256
    })
Assert-Check 'lock.targeting-pack-sdk-composition' `
    ($lock.targetingPacks.compositionAuthority -ceq
        'official .NET 10 releases.json SDK 10.0.400 win-x64 entry, its exact released archive, and the exact installed SDK evidence files and pack tree' -and
     $lock.targetingPacks.releaseMetadataUri -ceq
        'https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json' -and
     $lock.targetingPacks.releasedSdkArchiveUri -ceq
        'https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.400/dotnet-sdk-10.0.400-win-x64.zip' -and
     $lock.targetingPacks.releasedSdkArchiveHashAlgorithm -ceq 'SHA512' -and
     $lock.targetingPacks.releasedSdkArchiveByteLength -eq 300546129 -and
     $lock.targetingPacks.releasedSdkArchiveSha512Hex -ceq
        '9B8B88590E4DA131BFD0DA7AA089D0FC04D5418D5F8607EC13D55DC5A17B4399AFD54D496C12657FA05C6C6546DC5EAB930F26AC6C50F2D3A7712C0FB378C366' -and
     $lock.targetingPacks.releasedSdkReleaseDate -ceq '2026-08-11' -and
     $lock.targetingPacks.releasedSdkRuntimeVersion -ceq '10.0.11' -and
     $lock.targetingPacks.installedSdkVersionRelativePath -ceq
        'sdk/10.0.400/.version' -and
     $lock.targetingPacks.installedSdkVersionByteLength -eq 101 -and
     $lock.targetingPacks.installedSdkVersionSha256 -ceq
        '89D0157FDF8D6ACD8A76EA6FC0E3A110BE7BCA5FF2001D0436ADE70DD0A7ADC7' -and
     [string]::Join("`n", @($lock.targetingPacks.installedSdkVersionLines)) -ceq
        "14fbf8d5271c98133561eb55185fdb05b286f578`n10.0.400`nwin-x64`n10.0.400-servicing.26379.115`n10.0.400" -and
     $lock.targetingPacks.installedSdkToolsetVersionRelativePath -ceq
        'sdk/10.0.400/.toolsetversion' -and
     $lock.targetingPacks.installedSdkToolsetVersionByteLength -eq 61 -and
     $lock.targetingPacks.installedSdkToolsetVersionSha256 -ceq
        '45D078105738431B70271E857D5CE409B8E6F0F891FF9F864CB5FC92546CDDCC' -and
     $lock.targetingPacks.installedBundledVersionsRelativePath -ceq
        'sdk/10.0.400/Microsoft.NETCoreSdk.BundledVersions.props' -and
     $lock.targetingPacks.installedBundledVersionsSha256 -ceq
        '2D6C1879967A87460C1C712B54B9FE378281DE4D4F7301ECBB8AF923B47C40DD') `
    'The released SDK archive and installed composition evidence are exact.'
Assert-Check 'lock.targeting-pack-sdk-source' `
    ($lock.targetingPacks.sdkSourceRepository -ceq 'https://github.com/dotnet/dotnet' -and
     $lock.targetingPacks.sdkSourceCommit -ceq
        '14fbf8d5271c98133561eb55185fdb05b286f578' -and
     $lock.targetingPacks.sdkCoreRefVersionSourcePath -ceq
        'src/sdk/eng/Version.Details.xml' -and
     $lock.targetingPacks.sdkCoreRefVersionSourceSha256 -ceq
        '9EF22725C12631E5277DE822B49AA5E6BCED3D447054F1F4BADD73DD22FCFABA' -and
     $lock.targetingPacks.sdkWindowsRefVersionSourcePath -ceq
        'src/sdk/eng/ManualVersions.props' -and
     $lock.targetingPacks.sdkWindowsRefVersionSourceSha256 -ceq
        '0B52C1AE66EE364980C94A7866C8A3055B54A01D0FE778CC00FC1BEB7745CD32' -and
     $lock.targetingPacks.resolverSemanticsAuthority -ceq
        'the exact shipped VMR commit above; released archive and installed evidence remain binding for binary composition') `
    'The exact shipped VMR source coordinates and source-file identities are exact.'
Assert-Check 'lock.core-targeting-pack' `
    ($lock.targetingPacks.netCoreAppRef.packageId -ceq 'Microsoft.NETCore.App.Ref' -and
     $lock.targetingPacks.netCoreAppRef.version -ceq '10.0.11' -and
     $lock.targetingPacks.netCoreAppRef.originalFileCount -eq 348 -and
     $lock.targetingPacks.netCoreAppRef.originalUncompressedByteLength -eq 43511590 -and
     $lock.targetingPacks.netCoreAppRef.originalRawTreeSha256 -ceq
        '2347D43291D0F7F10F528B5588A1AC0C4F1287FEB0E9F2D4FA5635CE01A48BF2' -and
     $lock.targetingPacks.netCoreAppRef.originalFrameworkListByteLength -eq 36320 -and
     $lock.targetingPacks.netCoreAppRef.originalFrameworkListSha256 -ceq
        '0527031269FF47FCEB1518ECCD9992E75F924881A362754957676C18988263B4' -and
     $lock.targetingPacks.netCoreAppRef.sanitizedFrameworkListByteLength -eq 34752 -and
     $lock.targetingPacks.netCoreAppRef.sanitizedFrameworkListSha256 -ceq
        'C23E017A615E74F8CD94DAA2FCA3B9F5EDDBDC4C6636A47D6CB4FC5A61EF9006' -and
     $lock.targetingPacks.netCoreAppRef.sanitizedFileCount -eq 342 -and
     $lock.targetingPacks.netCoreAppRef.sanitizedRawByteLength -eq 41745862 -and
     $lock.targetingPacks.netCoreAppRef.sanitizedRawTreeSha256 -ceq
        'EF000B960364CC8C39255D3619BA7BF95DA97C0E07B4C029FC9B578E9C1C8276' -and
     $actualCoreAnalyzers.Count -eq 6 -and
     [string]::Join("`n", $actualCoreAnalyzers) -ceq
        [string]::Join("`n", $expectedCoreAnalyzers)) `
    'The core reference-pack version, FrameworkList delta, and six payload hashes are exact.'
Assert-Check 'lock.targeting-pack-overlay' `
    ($lock.targetingPacks.overlayFileCount -eq 438 -and
     $lock.targetingPacks.overlayRawByteLength -eq 108699170 -and
     $lock.targetingPacks.overlayRawTreeSha256 -ceq
        'F9125E4730CF4FCB9AB2566F4AEC2928042ADA7A172B6CD242063A831B5CF775') `
    'The combined analyzer-free targeting-pack overlay identity is exact.'
Assert-Check 'lock.windows-targeting-pack' `
    ($lock.targetingPacks.windowsSdkNetRef.packageId -ceq
        'Microsoft.Windows.SDK.NET.Ref' -and
     $lock.targetingPacks.windowsSdkNetRef.version -ceq '10.0.26100.57' -and
     $lock.targetingPacks.windowsSdkNetRef.targetPlatformVersion -ceq '10.0.26100.0' -and
     $lock.targetingPacks.windowsSdkNetRef.downloadUri -ceq
        'https://api.nuget.org/v3-flatcontainer/microsoft.windows.sdk.net.ref/10.0.26100.57/microsoft.windows.sdk.net.ref.10.0.26100.57.nupkg' -and
     $lock.targetingPacks.windowsSdkNetRef.packageByteLength -eq 13193759 -and
     $lock.targetingPacks.windowsSdkNetRef.packageSha256 -ceq
        'EAA0E3B938319F75BEAC5C046C84EF57212C2743E9263E0DB33B2019AB70B524' -and
     $lock.targetingPacks.windowsSdkNetRef.packageSha512Base64 -ceq
        'BG2X8tqoPJu7Lde8hlg/3bF9QwOW3VsxI7MGPEQM5+i4YG0WgNeesIeia2VTRkVEnoC9SdxpFGJtdGQHHIBwcA==' -and
     $lock.targetingPacks.windowsSdkNetRef.archiveEntryCount -eq 97 -and
     $lock.targetingPacks.windowsSdkNetRef.archiveUncompressedByteLength -eq 67431788 -and
     $lock.targetingPacks.windowsSdkNetRef.expandedRawTreeSha256 -ceq
        '29E5F21F61E66A3E4A850454C575181FA21A42F4A9749B2BEC55869FF4E3787F' -and
     $lock.targetingPacks.windowsSdkNetRef.originalFrameworkListByteLength -eq 942 -and
     $lock.targetingPacks.windowsSdkNetRef.originalFrameworkListSha256 -ceq
        '5F5DC88A217A01FAD154279EF8760C49C4FF9819E33AD0671D0F110D0B641D04' -and
     $lock.targetingPacks.windowsSdkNetRef.analyzerRelativePath -ceq
        'analyzers/dotnet/cs/WinRT.SourceGenerator.dll' -and
     $lock.targetingPacks.windowsSdkNetRef.analyzerByteLength -eq 478240 -and
     $lock.targetingPacks.windowsSdkNetRef.analyzerSha256 -ceq
        'A23601B11FBB36A2DE48960AAD942FBAB26D2F0835F98086CC764F97EA81CBC8' -and
     $lock.targetingPacks.windowsSdkNetRef.sdkReferenceSha256 -ceq
        'C633AB241CD09846C2AA409F0BEE2026962610404A7BF132C75CBD66B0E5A9F4' -and
     $lock.targetingPacks.windowsSdkNetRef.sdkReferenceRelativePath -ceq
        'lib/net8.0/Microsoft.Windows.SDK.NET.dll' -and
     $lock.targetingPacks.windowsSdkNetRef.sanitizedFrameworkListSha256 -ceq
        '78770AD71BD625A18FB1128CF0FF1030C4B1594060931246AB68F94A28921388' -and
     $lock.targetingPacks.windowsSdkNetRef.sanitizedFrameworkListByteLength -eq 702 -and
     $lock.targetingPacks.windowsSdkNetRef.sanitizedFileCount -eq 96 -and
     $lock.targetingPacks.windowsSdkNetRef.sanitizedRawByteLength -eq 66953308 -and
     $lock.targetingPacks.windowsSdkNetRef.sanitizedRawTreeSha256 -ceq
        'E9F9791056DEABD9763FCA005F8604668FF23ACFA875BAB61285CA978BB1D6BA') `
    'The Windows package, exact evidence tree, and analyzer-free derived tree are exact.'
Assert-Check 'lock.compiler-extension-closure' `
    ($lock.targetingPacks.effectiveCompilerAnalyzerItemCount -eq 0 -and
     $lock.targetingPacks.effectiveCompilerAuxiliaryItemCount -eq 0 -and
     $lock.targetingPacks.capturedLogicalCscAnalyzerArgumentCount -eq 0 -and
     $lock.targetingPacks.capturedLogicalCscAnalyzerConfigArgumentCount -eq 0 -and
     $lock.targetingPacks.capturedLogicalCscAdditionalFileArgumentCount -eq 0 -and
     $lock.targetingPacks.capturedLogicalCscResponseFileArgumentCount -eq 0 -and
     $lock.targetingPacks.analyzerClosureCheckedBeforeAndAfterAllThreeBuilds -eq $true -and
     $lock.targetingPacks.sourceGeneratorExecutionAuthorized -eq $false -and
     $lock.targetingPacks.workloadResolverEnabled -eq $false -and
     $lock.targetingPacks.allPackDownloadFallbacksDisabled -eq $true -and
     $lock.targetingPacks.candidatePackageSourcesConfigured -eq 0 -and
     $lock.targetingPacks.candidateNetworkAuthorized -eq $false -and
     $lock.staticRejectPolicy.effectiveCompilerAnalyzerItemCount -eq 0 -and
     $lock.staticRejectPolicy.effectiveCompilerAuxiliaryItemCount -eq 0 -and
     $lock.staticRejectPolicy.capturedLogicalCscAnalyzerArgumentCount -eq 0 -and
     $lock.staticRejectPolicy.capturedLogicalCscAnalyzerConfigArgumentCount -eq 0 -and
     $lock.staticRejectPolicy.capturedLogicalCscAdditionalFileArgumentCount -eq 0 -and
     $lock.staticRejectPolicy.capturedLogicalCscResponseFileArgumentCount -eq 0 -and
     $lock.staticRejectPolicy.sourceGeneratorExecutionAuthorized -eq $false -and
     $lock.staticRejectPolicy.workloadResolverEnabled -eq $false) `
    'All compiler-extension inputs are fail-closed and source-generator execution is unauthorized.'
Assert-Check 'lock.staged-count' ($lock.sourceCandidate.stagedInputFileCount -eq 244) `
    'Fifteen candidate, one retained, and 228 profiles are staged.'
Assert-Check 'lock.upstream-bom-canonicalization' `
    ($lock.canonicalization -ceq
        'workspace-authored text is strict UTF-8 without BOM, replaces CRLF with LF, and rejects bare CR; pinned upstream profile text is strict UTF-8, preserves an existing BOM, replaces CRLF with LF, and rejects bare CR; framed trees hash ordinal relative path, NUL, selected bytes, NUL' -and
     @($lock.sourceCandidate.upstreamSelectedUtf8BomPaths).Count -eq 1 -and
     [string]$lock.sourceCandidate.upstreamSelectedUtf8BomPaths[0] -ceq
        'profiles/nintendo/switch-pro.json') `
    'The canonical source contract preserves the one exact upstream profile BOM.'
Assert-Check 'lock.candidate-tree' `
    ($lock.sourceCandidate.normalizedTreeSha256 -ceq
        '975C5855D9F8DBE34FB1B8504B0B213324036CF07D913F93C397A7D35FEB2EFD') `
    'S1.5d candidate tree is exact.'
$artifactExpectationPropertyNames = @(
    $lock.artifactExpectation.PSObject.Properties | ForEach-Object { [string]$_.Name })
Assert-Check 'lock.zero-native-bootstrap' `
    ($lock.artifactExpectation.machine -ceq 'Amd64' -and
     $lock.artifactExpectation.peMagic -ceq 'PE32Plus' -and
     $lock.artifactExpectation.managedEntryPointTokenOrRva -eq 0 -and
     $lock.artifactExpectation.nativeAddressOfEntryPoint -eq 0 -and
     $lock.artifactExpectation.nativeImportModuleCount -eq 0 -and
     $lock.artifactExpectation.nativeImportSymbolCount -eq 0 -and
     $artifactExpectationPropertyNames -cnotcontains 'nativeAddressOfEntryPointExpectedNonzero' -and
     $artifactExpectationPropertyNames -cnotcontains 'allowedNativeBootstrapModule' -and
     $artifactExpectationPropertyNames -cnotcontains 'allowedNativeBootstrapSymbol') `
    'The Amd64 image has no native startup stub, import module, or import symbol.'
Assert-Check 'lock.api-observation-counts' `
    ($lock.artifactExpectation.publicTypeCount -eq 9 -and
     $lock.artifactExpectation.publicLogicalEntryCount -eq 100) `
    'Pass one observes nine public types and 100 logical identities.'

$gateValues = @($lock.gateState.PSObject.Properties | ForEach-Object { $_.Value })
Assert-Check 'lock.all-gates-false' `
    ($gateValues.Count -eq 6 -and @($gateValues | Where-Object { $_ -ne $false }).Count -eq 0) `
    'All six aggregate gates remain false.'
$unresolved = @(
    $lock.artifactExpectation.dllSha256,
    $lock.artifactExpectation.pdbSha256,
    $lock.artifactExpectation.depsJsonSha256,
    $lock.artifactExpectation.mvid,
    $lock.artifactExpectation.portablePdbId,
    $lock.artifactExpectation.assemblyReferenceAllowlist,
    $lock.artifactExpectation.typeReferenceAllowlist,
    $lock.artifactExpectation.memberReferenceAllowlist,
    $lock.artifactExpectation.methodSpecificationAllowlist,
    $lock.artifactExpectation.ilTokenClosureAllowlist,
    $lock.artifactExpectation.analyzerAllowlist
)
Assert-Check 'lock.post-build-facts-unresolved' `
    (@($unresolved | Where-Object { $null -ne $_ }).Count -eq 0) `
    'No post-build identity or metadata allowlist is invented.'

$expectedSourceInputs = @(
    'tools/hidmaestro-runtime-candidate/candidate-contract.json',
    'tools/hidmaestro-runtime-candidate/api/public-api.contract.json',
    'tools/hidmaestro-runtime-candidate/api/source-compilation.contract.json',
    'tools/hidmaestro-runtime-candidate/profiles/catalog.lock.json',
    'tools/hidmaestro-runtime-candidate/source.lock.json',
    'tools/hidmaestro-runtime-candidate/s1_5d/contract.lock.json',
    'tools/hidmaestro-runtime-candidate/s1_5d/verify-source-candidate.ps1',
    'tools/hidmaestro-runtime-candidate/s1_5e/inspector/HIDMaestro.ArtifactInspector.csproj',
    'tools/hidmaestro-runtime-candidate/s1_5e/inspector/Program.cs',
    'tools/hidmaestro-probe/ManagedPeReader.cs'
)
$actualSourceInputs = Get-OrdinalSorted -Values @(
    $lock.sourceInputs | ForEach-Object { [string]$_.path })
Assert-Check 'lock.source-input-set' `
    ($actualSourceInputs.Count -eq $expectedSourceInputs.Count -and
     [string]::Join("`n", $actualSourceInputs) -ceq
        [string]::Join("`n", (Get-OrdinalSorted -Values $expectedSourceInputs))) `
    'Global contracts and the two-source inspector are exactly pinned.'
foreach ($entry in @($lock.sourceInputs)) {
    $path = Join-Path $workspace ([string]$entry.path).Replace('/', '\')
    $exists = [IO.File]::Exists($path)
    Assert-Check ('source.exists.' + [string]$entry.path) $exists 'Pinned source input exists.'
    if ($exists) {
        Assert-Check ('source.no-reparse.' + [string]$entry.path) `
            (-not ((Get-Item -LiteralPath $path -Force).Attributes -band
                [IO.FileAttributes]::ReparsePoint)) `
            'Pinned source input is not a reparse point.'
        Assert-Check ('source.hash.' + [string]$entry.path) `
            ((Get-NormalizedSha256 $path) -ceq [string]$entry.sha256) `
            'Pinned source input normalized hash matches.'
    }
}

$expectedLockedLeaf = @(
    'README.md',
    'inspector/HIDMaestro.ArtifactInspector.csproj',
    'inspector/Program.cs',
    'run-actions-proof.ps1',
    'verify-source-contract.ps1'
)
$actualLockedLeaf = Get-OrdinalSorted -Values @(
    $lock.leafFiles | ForEach-Object { [string]$_.path })
Assert-Check 'lock.leaf-hash-set' `
    ($actualLockedLeaf.Count -eq $expectedLockedLeaf.Count -and
     [string]::Join("`n", $actualLockedLeaf) -ceq
        [string]::Join("`n", (Get-OrdinalSorted -Values $expectedLockedLeaf))) `
    'All non-self leaf files are hash-pinned.'
foreach ($entry in @($lock.leafFiles)) {
    $path = Join-Path $leafRoot ([string]$entry.path).Replace('/', '\')
    Assert-Check ('leaf.hash.' + [string]$entry.path) `
        ([IO.File]::Exists($path) -and
         (Get-NormalizedSha256 $path) -ceq [string]$entry.sha256) `
        'Leaf normalized hash matches.'
}

$projectPath = Join-Path $leafRoot 'inspector\HIDMaestro.ArtifactInspector.csproj'
$xmlSettings = New-Object Xml.XmlReaderSettings
$xmlSettings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
$xmlSettings.XmlResolver = $null
$xmlReader = [Xml.XmlReader]::Create($projectPath, $xmlSettings)
$project = New-Object Xml.XmlDocument
$project.XmlResolver = $null
try { $project.Load($xmlReader) } finally { $xmlReader.Dispose() }
$compileIncludes = Get-OrdinalSorted -Values @($project.Project.ItemGroup.Compile | ForEach-Object {
    ([string]$_.Include).Replace('\', '/')
})
Assert-Check 'inspector.compile-items' `
    ($compileIncludes.Count -eq 2 -and
     $compileIncludes[0] -ceq '../../../hidmaestro-probe/ManagedPeReader.cs' -and
     $compileIncludes[1] -ceq 'Program.cs') `
    'Inspector compiles only Program and the linked hash-pinned reader.'
$forbiddenElements = @(
    'PackageReference','ProjectReference','Reference','Import','Target','UsingTask','Exec',
    'DownloadFile','MSBuild','CallTarget','Copy','Analyzer','EmbeddedResource'
)
foreach ($name in $forbiddenElements) {
    Assert-Check ('inspector.xml.forbid.' + $name) `
        ($project.SelectNodes("//*[local-name()='$name']").Count -eq 0) `
        'Inspector project has no extensibility/download/package element.'
}
$properties = $project.Project.PropertyGroup
foreach ($pair in @(
    @('EnableDefaultItems','false'), @('EnableDefaultCompileItems','false'),
    @('EnableDefaultEmbeddedResourceItems','false'), @('EnableDefaultNoneItems','false'),
    @('GenerateAssemblyInfo','false'), @('GenerateTargetFrameworkAttribute','false'),
    @('AllowUnsafeBlocks','false'), @('SelfContained','false'),
    @('TreatWarningsAsErrors','true'), @('EnableNETAnalyzers','false'),
    @('RunAnalyzers','false'), @('RunAnalyzersDuringBuild','false'),
    @('RunAnalyzersDuringLiveAnalysis','false'), @('UseAppHost','false'),
    @('RuntimeFrameworkVersion','10.0.11')
)) {
    $node = @($properties | ForEach-Object { $_.($pair[0]) } | Where-Object { $null -ne $_ })
    Assert-Check ('inspector.property.' + $pair[0]) `
        ($node.Count -eq 1 -and [string]$node[0] -ceq $pair[1]) `
        'Inspector property is exact.'
}

$program = Get-Content -LiteralPath (Join-Path $leafRoot 'inspector\Program.cs') -Raw
$programAnchorIndex = 0
foreach ($literal in @(
    'new FileStream(', 'FileShare.Read', 'new PEReader(', 'GetMetadataReader()',
    'EntryPointTokenOrRelativeVirtualAddress', 'CorFlags.NativeEntryPoint',
    '"pe.nativeAddressOfEntryPoint"', 'GetProperty("nativeAddressOfEntryPoint").GetInt32()',
    'IsEmpty(peHeader.ImportTableDirectory)',
    'IsEmpty(peHeader.ImportAddressTableDirectory)',
    'IsEmpty(peHeader.BaseRelocationTableDirectory)',
    '"nativeImport.moduleCount"', '"nativeImport.symbolCount"',
    'GetProperty("nativeImportModuleCount").GetInt32()',
    'GetProperty("nativeImportSymbolCount").GetInt32()',
    'CodeManagerTableDirectory', 'VtableFixupsDirectory',
    'ExportAddressTableJumpsDirectory', 'DelayImportTableDirectory',
    'ThreadLocalStorageTableDirectory', 'ReadDebugDirectory()',
    'ReadCodeViewDebugDirectoryData', 'ReadPdbChecksumDebugDirectoryData',
    'MethodSpecificationHandle', 'StandaloneSignatureHandle', 'TypeSpecificationHandle',
    'ParseInstructions(il)', 'MethodBodySha256', 'ExceptionRegionEntry',
    'ImplementationMapCount', 'ModuleInitializerAttribute',
    'Bare carriage return in resource',
    'StructuralContractMatched: false', 'candidateLoaded = false',
    'UserString:length=', 'RawCatalogSha256', 'CanonicalCatalogSha256'
)) {
    Assert-Check ('program.anchor.' + $programAnchorIndex) `
        (Has-Literal $program $literal) 'Required byte-only observation anchor is present.'
    $programAnchorIndex++
}
$programForbidIndex = 0
foreach ($literal in @(
    'Assembly.Load(', 'AssemblyName.GetAssemblyName(', 'MetadataLoadContext',
    'Activator.CreateInstance(', 'RuntimeHelpers.RunClassConstructor(',
    'MethodInfo.Invoke(', 'Delegate.DynamicInvoke(', '[DllImport', '[LibraryImport',
    'NativeLibrary.Load(', 'Marshal.GetDelegateForFunctionPointer(', 'Process.Start('
)) {
    Assert-Check ('program.forbid.' + $programForbidIndex) `
        (-not (Has-Literal $program $literal)) 'Target loading, invocation, or native binding is absent.'
    $programForbidIndex++
}
Assert-Check 'program.no-legacy-native-bootstrap' `
    (-not (Has-Literal $program 'nativeAddressOfEntryPointExpectedNonzero') -and
     -not (Has-Literal $program 'allowedNativeBootstrapModule') -and
     -not (Has-Literal $program 'allowedNativeBootstrapSymbol') -and
     -not (Has-Literal $program 'NativeBootstrap')) `
    'The inspector has no x86-era native bootstrap expectation.'
Assert-Check 'program.no-absolute-artifact-path-in-report' `
    (Has-Literal $program '"candidate-dll"') `
    'The receipt uses an artifact role rather than the absolute input path.'
Assert-Check 'program.net10-metadata-api-shape' `
    ((Has-Literal $program 'PEHeader peHeader = pe.PEHeaders.PEHeader') -and
     (Has-Literal $program 'The candidate PE header is absent.') -and
     (Has-Literal $program 'CorHeader corHeader = pe.PEHeaders.CorHeader') -and
     (Has-Literal $program 'The candidate COR header is absent.') -and
     (Has-Literal $program 'string documentChecksum = document.Hash.IsNil') -and
     (Has-Literal $program 'Dictionary<int, Parameter> parameters = method.GetParameters()') -and
     (Has-Literal $program 'out Parameter parameter') -and
     (Has-Literal $program 'A by-reference parameter has no metadata row.') -and
     (Has-Literal $program 'signature.Header.HasExplicitThis') -and
     -not (Has-Literal $program 'string checksum = document.Hash.IsNil') -and
     -not (Has-Literal $program 'ParameterDefinition') -and
     -not (Has-Literal $program 'signature.Header.IsExplicitThis')) `
    'The inspector uses the released .NET 10 System.Reflection.Metadata API and unambiguous local names.'
Assert-Check 'program.target-framework-attribute-shape' `
    ($lock.artifactExpectation.targetFramework -ceq '.NETCoreApp,Version=v10.0' -and
     $lock.artifactExpectation.targetFrameworkDisplayName -ceq '.NET 10.0' -and
     (Has-Literal $program 'ReadAssemblyTargetFrameworkAttribute(metadata)') -and
     (Has-Literal $program 'TargetFrameworkAttributeValue ParseTargetFrameworkAttribute(') -and
     (Has-Literal $program 'EnsureFrameworkSingleStringAttributeConstructor(') -and
     (Has-Literal $program 'reference.Parent.Kind != HandleKind.TypeReference') -and
     (Has-Literal $program 'type.ResolutionScope.Kind != HandleKind.AssemblyReference') -and
     (Has-Literal $program 'metadata.GetString(scope.Name) != "System.Runtime"') -and
     (Has-Literal $program 'new byte[] { 0xB0, 0x3F, 0x5F, 0x7F, 0x11, 0xD5, 0x0A, 0x3A }') -and
     (Has-Literal $program 'signature.Header.HasExplicitThis') -and
     (Has-Literal $program 'signature.RequiredParameterCount != 1') -and
     (Has-Literal $program 'signature.ParameterTypes[0] != "System.String"') -and
     (Has-Literal $program 'reader.ReadUInt16() != 1') -and
     (Has-Literal $program 'reader.ReadByte() != 0x54') -and
     (Has-Literal $program 'reader.ReadByte() != 0x0E') -and
     (Has-Literal $program 'propertyName != "FrameworkDisplayName"') -and
     (Has-Literal $program 'reader.RemainingBytes != 0') -and
     (Has-Literal $program '"assembly.targetFrameworkDisplayName"') -and
     -not (Has-Literal $program 'ReadAssemblyStringAttribute(metadata, TargetFrameworkAttribute)')) `
    'The target-framework attribute decoder requires the exact one-property ECMA payload.'
Assert-Check 'program.portable-pdb-content-binding' `
    ($lock.artifactExpectation.portablePdbCodeViewPath -ceq '/_/object/HIDMaestro.Core.pdb' -and
     (Has-Literal $program 'string expectedCodeViewPath,') -and
     (Has-Literal $program '"pdb.codeView.pathRole",') -and
     (Has-Literal $program 'normalizedCodeViewPath,') -and
     (Has-Literal $program 'expectedCodeViewPath);') -and
     (Has-Literal $program 'ComputePortablePdbContentSha256(') -and
     (Has-Literal $program 'pdbHeader.IdStartOffset') -and
     (Has-Literal $program 'pdbStreamOffset != expectedPdbIdOffset') -and
     (Has-Literal $program 'BlobContentId checksumContentId = BlobContentId.FromHash(checksum.Checksum);') -and
     (Has-Literal $program '"pdb.checksum.contentIdGuid"') -and
     (Has-Literal $program '"pdb.checksum.contentIdStamp"') -and
     (Has-Literal $program 'BinaryPrimitives.ReadUInt32LittleEndian(bytes) != 0x424A5342') -and
     (Has-Literal $program 'if (name == "#Pdb")') -and
     (Has-Literal $program 'Array.Clear(zeroed, pdbStreamOffset, expectedPdbId.Length);') -and
     (Has-Literal $program 'SHA256.HashData(zeroed)') -and
     -not (Has-Literal $program 'normalizedCodeViewPath == "HIDMaestro.Core.pdb"') -and
     -not (Has-Literal $program 'normalizedCodeViewPath == "/_/output/HIDMaestro.Core.pdb"')) `
    'CodeView uses the exact object role and checksum validation hashes the PDB with its ID zeroed.'

$runner = Get-Content -LiteralPath (Join-Path $leafRoot 'run-actions-proof.ps1') -Raw
$absoluteDrivePattern = '(?i)(?<![a-z])[a-z]:[\\/]'
$fileUriPattern = '(?i)(?<![a-z0-9+.-])file:[\\/]{2,}'
$forwardUncPattern = '(?i)(?<![-a-z0-9+./:\\])[\\/]{2,}(?=[^\\/\s])'
Assert-Check 'runner.absolute-windows-path-boundary' `
    ((Has-Literal $runner 'function Test-ContainsAbsoluteWindowsPath') -and
     (Has-Literal $runner "'(?i)(?<![a-z])[a-z]:[\\/]'" ) -and
     (Has-Literal $runner "'(?i)(?<![a-z0-9+.-])file:[\\/]{2,}'" ) -and
     (Has-Literal $runner "'(?i)(?<![-a-z0-9+./:\\])[\\/]{2,}(?=[^\\/\s])'" ) -and
     (Has-Literal $runner 'if (Test-ContainsAbsoluteWindowsPath -Text $text)') -and
     -not (Has-Literal $runner "'(?i)[a-z]:[\\/]'" ) -and
     -not [regex]::IsMatch(
        'http://schemas.microsoft.com/developer/msbuild/2003',
        $absoluteDrivePattern, [Text.RegularExpressions.RegexOptions]::CultureInvariant) -and
     -not [regex]::IsMatch(
        'http://schemas.microsoft.com/developer/msbuild/2003',
        $forwardUncPattern, [Text.RegularExpressions.RegexOptions]::CultureInvariant) -and
     -not [regex]::IsMatch(
        'https://example.invalid/a//b',
        $forwardUncPattern, [Text.RegularExpressions.RegexOptions]::CultureInvariant) -and
     -not [regex]::IsMatch(
        'profile://example.invalid/value',
        $fileUriPattern, [Text.RegularExpressions.RegexOptions]::CultureInvariant) -and
     [regex]::IsMatch(
        'D:\proof\input.xml', $absoluteDrivePattern,
        [Text.RegularExpressions.RegexOptions]::CultureInvariant) -and
     [regex]::IsMatch(
        'D:/proof/input.xml', $absoluteDrivePattern,
        [Text.RegularExpressions.RegexOptions]::CultureInvariant) -and
     [regex]::IsMatch(
        'file:///D:/proof/input.xml', $absoluteDrivePattern,
        [Text.RegularExpressions.RegexOptions]::CultureInvariant) -and
     [regex]::IsMatch(
        '//server/share/input.props', $forwardUncPattern,
        [Text.RegularExpressions.RegexOptions]::CultureInvariant) -and
     [regex]::IsMatch(
        '///server/share/input.props', $forwardUncPattern,
        [Text.RegularExpressions.RegexOptions]::CultureInvariant) -and
     [regex]::IsMatch(
        '/\server/share/input.props', $forwardUncPattern,
        [Text.RegularExpressions.RegexOptions]::CultureInvariant) -and
     [regex]::IsMatch(
        '\/server/share/input.props', $forwardUncPattern,
        [Text.RegularExpressions.RegexOptions]::CultureInvariant) -and
     [regex]::IsMatch(
        'file://server/share/input.props', $fileUriPattern,
        [Text.RegularExpressions.RegexOptions]::CultureInvariant) -and
     [regex]::IsMatch(
        'file:/\server/share/input.props', $fileUriPattern,
        [Text.RegularExpressions.RegexOptions]::CultureInvariant) -and
     [regex]::IsMatch(
        'file:\/server/share/input.props', $fileUriPattern,
        [Text.RegularExpressions.RegexOptions]::CultureInvariant) -and
     '\\server\share'.IndexOf('\\', [StringComparison]::Ordinal) -ge 0) `
    'Canonical MSBuild namespace URLs pass while drive-root and UNC paths fail closed.'
$runnerAnchorIndex = 0
foreach ($literal in @(
    '$env:GITHUB_ACTIONS', '$env:RUNNER_OS', '$env:RUNNER_TEMP', '$env:GITHUB_WORKSPACE',
    '[AllowEmptyString()][string] $Text',
    'Set-HardenedProcessEnvironment', 'CORECLR_', 'DOTNET_', 'MSBUILD', 'NUGET_',
    "DOTNET_ROLL_FORWARD = 'Disable'",
    'Set-IsolatedChildTempRoot', 'PSModulePath', 'POWERSHELL_UPDATECHECK',
    "@('--list-runtimes')", 'Get-PinnedRuntimeEvidence', 'runtimePreLaunchState',
    'runtimePostLaunchState', 'ExpectedVersionFileSha256',
    'versionFileSha256 = $runtimeEvidence.VersionFileSha256', 'pathRedacted = $true',
    "'GIT_'", 'GIT_TEMPLATE_DIR', '--no-replace-objects', 'protocol.allow=never',
    "@('100644', '100755')", '.NETCoreApp,Version=v10.0/win-x64',
    'System.Reflection.Metadata.MetadataUpdater.IsSupported',
    '-noAutoResponse', '--depth=1', '--no-tags', 'Assert-NoReparsePoints',
    'Stage-ExactCandidate', '$expectedPaths.Count -ne 244', 'Get-FramedTreeSha256',
    '$actualUtf8BomPaths',
    "-ByteMode Raw", "-ByteMode Normalized", 'Invoke-CandidateBuild',
    "-Name 'ksx-hm-s15e-build-a'", "-Name 'ksx-hm-s15e-build-b'",
    'EnableNETAnalyzers=false', 'RunAnalyzersDuringBuild=false',
    'EmitCompilerGeneratedFiles=true', 'ProvideCommandLineArgs=true',
    'DiscoverEditorConfigFiles=false', 'DiscoverGlobalAnalyzerConfigFiles=false',
    'MSBuildEnableWorkloadResolver',
    'ConvertTo-AnalyzerFreeTargetingPack', 'ExpectedAnalyzers',
    'ExpectedBundledVersionsSha256', 'ExpectedSdkVersionFileLines',
    'ExpectedCorePackRawByteLength', 'ExpectedSanitizedRawByteLength',
    'Assert-EmptyEvaluatedAnalyzerClosure', '-getItem:CscCommandLineArgs',
    'CapturedLogicalAnalyzerArgumentCount',
    'CapturedLogicalAnalyzerConfigArgumentCount',
    'CapturedLogicalAdditionalFileArgumentCount',
    'sdkVersionFileSha256', 'sdkToolsetVersionFileSha256',
    'netCoreAppRefOriginalRawByteLength', 'netCoreAppRefOriginalFrameworkListByteLength',
    'netCoreAppRefOriginalFrameworkListSha256',
    'netCoreAppRefSanitizedRawByteLength', 'netCoreAppRefSanitizedRawTreeSha256',
    'windowsEvidenceRawByteLength', 'windowsOriginalFrameworkListByteLength',
    'windowsOriginalFrameworkListSha256',
    'windowsSanitizedRawByteLength', 'windowsSanitizedRawTreeSha256',
    'overlayFileCount', 'overlayRawByteLength', 'overlayPostRawTreeSha256',
    'effectiveCompilerAuxiliaryItemCount',
    'sourceGeneratorExecutionAuthorized',
    'Analyzer', 'ReferencePath', 'AdditionalFiles', 'AnalyzerConfigFiles',
    'EditorConfigFiles', 'PotentialEditorConfigFiles', 'MSBuildImportedProject',
    'MSBuildProvideImportedProjects=true',
    'Get-NoPackageAssetsSemantic', 'project.assets.json dependency group is not empty',
    '@($fallbackFolders).Count -ne 0',
    'inspectorGeneratedRoot', 'inspectorNoPackageAssetsSemanticSha256',
    'Assert-OutputClosure', 'Deterministic A/B mismatch',
    'same-handle inspector identities',
    'source-cleanup-before-inspection', 'byte-only-artifact-inspection',
    'Remove-FixedTree', 'cleanupCompleted', 'candidateLoaded = $false',
    'candidateBuilt = $candidateBuilt', 'artifactsRetained = ($retainedArtifactRoles.Count -ne 0)',
    'artifactPublicApiAllowlistFrozen = $false', 'distributionReady = $false'
)) {
    Assert-Check ('runner.anchor.' + $runnerAnchorIndex) `
        (Has-Literal $runner $literal) 'Required Actions proof anchor is present.'
    $runnerAnchorIndex++
}
Assert-Check 'runner.conditional-array-assignments-preserve-empty' `
    ([regex]::Matches(
        $runner, [regex]::Escape('$analyzers = @(if'),
        [Text.RegularExpressions.RegexOptions]::CultureInvariant).Count -eq 2 -and
     [regex]::Matches(
        $runner, [regex]::Escape('$references = @(if'),
        [Text.RegularExpressions.RegexOptions]::CultureInvariant).Count -eq 1 -and
     [regex]::Matches(
        $runner, [regex]::Escape('$compilerArguments = @(if'),
        [Text.RegularExpressions.RegexOptions]::CultureInvariant).Count -eq 1 -and
     [regex]::Matches(
        $runner, [regex]::Escape('$fallbackFolders = @(if'),
        [Text.RegularExpressions.RegexOptions]::CultureInvariant).Count -eq 1) `
    'Conditional array assignments preserve a real empty array under StrictMode.'
Assert-Check 'runner.project-item-xpath-enumeration' `
    ((Has-Literal $runner "SelectNodes('/Project/ItemGroup/Compile')") -and
     (Has-Literal $runner "SelectNodes('/Project/ItemGroup/EmbeddedResource')") -and
     (Has-Literal $runner '$settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit') -and
     (Has-Literal $runner '$xml.XmlResolver = $null') -and
     (Has-Literal $runner "GetAttribute('LogicalName')") -and
     (Has-Literal $runner "HasAttribute('LogicalName')") -and
     (Has-Literal $runner "SelectNodes('./LogicalName').Count -ne 0") -and
     (Has-Literal $runner '[IO.Path]::IsPathRooted($include)') -and
     (Has-Literal $runner "`$include.Contains(':')") -and
     (Has-Literal $runner '-not $compilePaths.Add($normalized)') -and
     (Has-Literal $runner '-not $resourcePaths.Add($normalized)') -and
     (Has-Literal $runner '-not $logicalNames.Add($logicalName)') -and
     (Has-Literal $runner '-not $logicalNamesIgnoreCase.Add($logicalName)') -and
     -not (Has-Literal $runner '$xml.Project.ItemGroup.Compile') -and
     -not (Has-Literal $runner '$xml.Project.ItemGroup.EmbeddedResource')) `
    'Expected project items use safe explicit XPath enumeration across ItemGroups.'
Assert-Check 'runner.fixed-upstream' `
    ((Has-Literal $runner '[string]$contract.upstream.repository') -and
     (Has-Literal $runner '[string]$contract.upstream.commit')) `
    'Runner uses only lock-fixed upstream identity.'
Assert-Check 'runner.sdk-selected-before-first-dotnet' `
    ((Has-Literal $runner "New-ExactGlobalJson -Path (Join-Path `$environmentRoot 'global.json')") -and
     $runner.IndexOf(
        "New-ExactGlobalJson -Path (Join-Path `$environmentRoot 'global.json')",
        [StringComparison]::Ordinal) -lt
     $runner.IndexOf(
        "Invoke-Captured -File `$dotnet -Arguments @('--version')",
        [StringComparison]::Ordinal)) `
    'An exact environment-root global.json selects the SDK before the first dotnet invocation.'
Assert-Check 'runner.tool-discovery-before-environment-seal' `
    ((Has-Literal $runner "`$dotnet = Resolve-FirstApplicationPath -Name 'dotnet'") -and
     (Has-Literal $runner "`$git = Resolve-FirstApplicationPath -Name 'git'") -and
     (Has-Literal $runner "`$pwsh = Resolve-FirstApplicationPath -Name 'pwsh'") -and
     $runner.IndexOf(
        "`$dotnet = Resolve-FirstApplicationPath -Name 'dotnet'",
        [StringComparison]::Ordinal) -lt
     $runner.IndexOf(
        'Set-HardenedProcessEnvironment -DotnetHome',
        [StringComparison]::Ordinal) -and
     $runner.IndexOf(
        "`$git = Resolve-FirstApplicationPath -Name 'git'",
        [StringComparison]::Ordinal) -lt
     $runner.IndexOf(
        'Set-HardenedProcessEnvironment -DotnetHome',
        [StringComparison]::Ordinal) -and
     $runner.IndexOf(
        "`$pwsh = Resolve-FirstApplicationPath -Name 'pwsh'",
        [StringComparison]::Ordinal) -lt
     $runner.IndexOf(
        'Set-HardenedProcessEnvironment -DotnetHome',
        [StringComparison]::Ordinal)) `
    'The first validated application paths are scalar before the child environment is sealed.'
Assert-Check 'runner.candidate-source-contract-root' `
    ((Has-Literal $runner '$source = Join-Path $SourceContractRoot') -and
     (Has-Literal $runner 'Stage-ExactCandidate -SourceContractRoot $toolRoot') -and
     -not (Has-Literal $runner '$source = Join-Path $Workspace ([string]$entry.path)')) `
    'S1.5d candidate paths resolve against the runtime-candidate contract root.'
Assert-Check 'runner.pathmap-msbuild-switch-escaping' `
    ((Has-Literal $runner "`$pathMapSwitchValue = `$pathMap.Replace(',', '%2C')") -and
     (Has-Literal $runner '"-p:PathMap=$pathMapSwitchValue"') -and
     (Has-Literal $runner "PathMap = (`$CandidateRoot + '=/_/candidate,'")) `
    'The MSBuild switch escapes comma separators while evaluated PathMap remains a comma list.'
Assert-Check 'runner.generated-files-root-has-no-trailing-separator' `
    ((Has-Literal $runner "`$compilerGeneratedFilesRoot = Join-Path `$ObjectRoot 'generated'") -and
     (Has-Literal $runner '"-p:CompilerGeneratedFilesOutputPath=$compilerGeneratedFilesRoot"') -and
     (Has-Literal $runner "CompilerGeneratedFilesOutputPath = (Get-FullPath (Join-Path `$ObjectRoot 'generated'))") -and
     (Has-Literal $runner "elseif (`$_.Key -eq 'CompilerGeneratedFilesOutputPath')") -and
     (Has-Literal $runner "'object/generated'") -and
     -not (Has-Literal $runner '"-p:CompilerGeneratedFilesOutputPath=$($ObjectRoot.TrimEnd(''\''))\generated\"')) `
    'The generated-source root is passed without the Roslyn-invalid trailing separator and remains evaluated and redacted.'
Assert-Check 'runner.strict-evaluation-diff-diagnostics' `
    ((Has-Literal $runner 'if ($evaluationA.Sha256 -cne $evaluationB.Sha256)') -and
     (Has-Literal $runner 'function Get-EvaluationManifestFieldDifferences') -and
     (Has-Literal $runner 'function Get-SafeImportDiagnostic') -and
     (Has-Literal $runner "'^(object|dotnet)/([^|]+)\|importer=(candidate|dotnet)/[^|]+\|sdk=(none|microsoft-net-sdk)\|semanticSha256=([A-F0-9]{64})$'") -and
     (Has-Literal $runner "'HIDMaestro.Core.csproj.nuget.g.props' { 'nuget-g-props' }") -and
     (Has-Literal $runner "'HIDMaestro.Core.csproj.nuget.g.targets' { 'nuget-g-targets' }") -and
     (Has-Literal $runner "'role=' + `$role + '|kind=' + `$kind") -and
     (Has-Literal $runner "'|importerRole=' + `$match.Groups[3].Value") -and
     (Has-Literal $runner "'|sdkKind=' + `$match.Groups[4].Value") -and
     (Has-Literal $runner "'|semanticSha256=' + `$match.Groups[5].Value") -and
     (Has-Literal $runner 'An evaluated import cannot be reduced to its safe role and semantic hash.') -and
     (Has-Literal $runner "`$importedProjectProperty = `$evaluation.Items.PSObject.Properties['MSBuildImportedProject']") -and
     (Has-Literal $runner "MSBuildProvideImportedProjects = 'true'") -and
     (Has-Literal $runner "`$fullPathProperty = `$importItem.PSObject.Properties['FullPath']") -and
     (Has-Literal $runner "`$importerProperty = `$importItem.PSObject.Properties['ImportingProjectPath']") -and
     (Has-Literal $runner "`$full.Equals(`$metadataFull, [StringComparison]::OrdinalIgnoreCase)") -and
     (Has-Literal $runner "`$sdkProperty = `$importItem.PSObject.Properties['Sdk']") -and
     (Has-Literal $runner "`$edgePrefix = `$rolePath + '|importer=' + `$importerRolePath + '|sdk=' + `$sdkKind") -and
     (Has-Literal $runner 'An imported-project edge lacks exact absolute identities.') -and
     (Has-Literal $runner 'An imported-project edge is missing or duplicates an identity.') -and
     (Has-Literal $runner 'An imported-project edge escaped the exact candidate/dotnet roles.') -and
     (Has-Literal $runner "`$importerRolePath -cne 'candidate/HIDMaestro.Core.csproj'") -and
     (Has-Literal $runner "`$sdkName -cne 'Microsoft.NET.Sdk'") -and
     (Has-Literal $runner 'A nested imported-project edge has unexpected SDK metadata.') -and
     (Has-Literal $runner "'object/HIDMaestro.Core.csproj.nuget.g.props'") -and
     (Has-Literal $runner "'object/HIDMaestro.Core.csproj.nuget.g.targets'") -and
     (Has-Literal $runner 'The evaluated generated NuGet import closure is not exact.') -and
     (Has-Literal $runner "'dotnet/sdk/10.0.400/Sdks/Microsoft.NET.Sdk/Sdk/Sdk.props'") -and
     (Has-Literal $runner "'dotnet/sdk/10.0.400/Sdks/Microsoft.NET.Sdk/Sdk/Sdk.targets'") -and
     (Has-Literal $runner 'The root Microsoft.NET.Sdk import closure is not exact.') -and
     -not (Has-Literal $runner 'MSBuildAllProjects') -and
     (Has-Literal $runner 'function Get-RoleNormalizedTextState') -and
     (Has-Literal $runner "`$placeholder = '/_/' + [string]`$entry.Key") -and
     (Has-Literal $runner 'function Get-SafeGeneratedImportDiagnostics') -and
     (Has-Literal $runner "[ValidateSet('nuget-g-props', 'nuget-g-targets')]") -and
     (Has-Literal $runner "SelectNodes('//*')") -and
     (Has-Literal $runner 'lineSha256=$lineDigest') -and
     (Has-Literal $runner 'childElementCount=$childElementCount') -and
     (Has-Literal $runner "notmatch '^[A-Za-z_][A-Za-z0-9_.-]*$'") -and
     (Has-Literal $runner 'valueSha256=$valueDigest') -and
     (Has-Literal $runner 'attributesSha256=$attributeDigest') -and
     (Has-Literal $runner 'SafeObjectImportDiagnostics = Get-OrdinalSorted') -and
     (Has-Literal $runner '$manifestFields = @(') -and
     (Has-Literal $runner '-not $Left.Manifest.Contains($field)') -and
     (Has-Literal $runner '@($Left.Manifest[$field])') -and
     (Has-Literal $runner "@(`$Left.Manifest['imports'])") -and
     (Has-Literal $runner "`$differentFields -ccontains 'imports'") -and
     (Has-Literal $runner 'Compare-Object') -and
     (Has-Literal $runner '$safe = Get-SafeImportDiagnostic -Entry ([string]$difference.InputObject)') -and
     (Has-Literal $runner 'EVALUATION-IMPORT-DIFF {0} {1} {2}') -and
     (Has-Literal $runner '$Label, [string]$difference.SideIndicator, $safe') -and
     (Has-Literal $runner 'EVALUATION-OBJECT-IMPORT-SHAPE-DIFF {0} {1} {2}') -and
     (Has-Literal $runner "Write-EvaluationManifestDifference -Label 'pre-a-vs-pre-b'") -and
     (Has-Literal $runner "Write-EvaluationManifestDifference -Label 'post-a-vs-pre-a'") -and
     (Has-Literal $runner "Write-EvaluationManifestDifference -Label 'post-b-vs-pre-b'") -and
     (Has-Literal $runner "Write-EvaluationManifestDifference -Label 'post-a-vs-post-b'") -and
     (Has-Literal $runner 'The normalized evaluated compiler-input inventories differ in fields:')) `
    'Pre/post A/B equality remains strict while import diagnostics expose only fixed kinds and structural hashes.'
Assert-Check 'runner.inspector-deps-subgates' `
    ((Has-Literal $runner '[string[]]$libraryShape = Get-OrdinalSorted -Values @(') -and
     -not (Has-Literal $runner '$libraryShape = @(if ($libraries.Count -eq 1)') -and
     (Has-Literal $runner 'The inspector dependency manifest library count is not one.') -and
     (Has-Literal $runner 'The inspector dependency manifest project identity is not exact.') -and
     (Has-Literal $runner 'The inspector dependency manifest project library shape is not exact.') -and
     (Has-Literal $runner 'The inspector dependency manifest project library type is not exact.') -and
     (Has-Literal $runner 'The inspector dependency manifest project library is serviceable.') -and
     (Has-Literal $runner 'The inspector dependency manifest project library SHA-512 is not empty.') -and
     (Has-Literal $runner "'.NETCoreApp,Version=v10.0'") -and
     (Has-Literal $runner "'.NETCoreApp,Version=v10.0/win-x64'") -and
     (Has-Literal $runner 'The inspector dependency target-name set is not exact.') -and
     (Has-Literal $runner 'The inspector dependency target identities are not unique.') -and
     (Has-Literal $runner 'The inspector dependency portable compile target is not empty.') -and
     (Has-Literal $runner "`$targets.Count -ne 2") -and
     (Has-Literal $runner "`$entries = @(`$ridTarget[0].Value.PSObject.Properties)") -and
     -not (Has-Literal $runner 'The inspector dependency manifest is not the sole project identity.') -and
     -not (Has-Literal $runner 'The inspector dependency target set is not exact.')) `
    'Inspector dependency identity failures use fixed non-value subgate diagnostics.'
Assert-Check 'runner.targeting-pack-sanitization' `
    ((Has-Literal $runner 'function ConvertTo-AnalyzerFreeTargetingPack') -and
     (Has-Literal $runner "GetAttribute('Type').Equals('Analyzer'") -and
     (Has-Literal $runner 'A targeting-pack analyzer payload hash is not exact.') -and
     (Has-Literal $runner 'A non-analyzer targeting-pack file changed') -and
     (Has-Literal $runner '$windowsPackEvidencePreState = Expand-PinnedWindowsTargetingPack') -and
     (Has-Literal $runner '$windowsPackSanitized = ConvertTo-AnalyzerFreeTargetingPack') -and
     (Has-Literal $runner '$corePackSanitized = ConvertTo-AnalyzerFreeTargetingPack')) `
    'Original pack evidence is retained while exact analyzer rows/payloads alone are removed from the derived overlay.'
Assert-Check 'runner.targeting-pack-fallbacks-disabled' `
    ((Has-Literal $runner 'NetCoreTargetingPackRoot=') -and
     (Has-Literal $runner 'EnableTargetingPackDownload=false') -and
     (Has-Literal $runner 'EnableRuntimePackDownload=false') -and
     (Has-Literal $runner 'EnableAppHostPackDownload=false') -and
     (Has-Literal $runner 'DisableTransitiveFrameworkReferenceDownloads=true') -and
     (Has-Literal $runner 'DisableImplicitLibraryPacksFolder=true') -and
     (Has-Literal $runner 'DisableImplicitNuGetFallbackFolder=true') -and
     (Has-Literal $runner 'MSBuildEnableWorkloadResolver = ''false''') -and
     (Has-Literal $runner 'MSBuildEnableWorkloadResolver=false')) `
    'Targeting-pack and implicit NuGet fallback downloads are disabled.'
$preCandidateIndex = $runner.IndexOf(
    '$evaluationA = Get-EvaluatedManifest', [StringComparison]::Ordinal)
$candidateCompileIndex = $runner.IndexOf(
    '$compilerA = Invoke-CandidateBuild', [StringComparison]::Ordinal)
$postCandidateIndex = $runner.IndexOf(
    '$evaluationPostA = Get-EvaluatedManifest', [StringComparison]::Ordinal)
Assert-Check 'runner.candidate-analyzer-order' `
    ($preCandidateIndex -ge 0 -and $candidateCompileIndex -gt $preCandidateIndex -and
     $postCandidateIndex -gt $candidateCompileIndex -and
     (Has-Literal $runner 'The effective compiler Analyzer item closure is not empty.') -and
     (Has-Literal $runner "'-getItem:CscCommandLineArgs'") -and
     (Has-Literal $runner 'analyzerconfig:') -and
     (Has-Literal $runner 'additionalfile:') -and
     (Has-Literal $runner '(?:a|analyzer):')) `
    'Candidate compiler extensions are empty before compile and rechecked after captured logical Csc arguments.'
$inspectorPreIndex = $runner.IndexOf(
    'Assert-EmptyEvaluatedAnalyzerClosure -Dotnet $dotnet -Project $inspectorProject',
    [StringComparison]::Ordinal)
$inspectorCompileIndex = $runner.IndexOf(
    '$inspectorCompiler = Invoke-CandidateBuild', [StringComparison]::Ordinal)
$inspectorPostIndex = $runner.IndexOf(
    'Assert-EmptyEvaluatedAnalyzerClosure -Dotnet $dotnet -Project $inspectorProject',
    $inspectorPreIndex + 1, [StringComparison]::Ordinal)
Assert-Check 'runner.inspector-analyzer-order' `
    ($inspectorPreIndex -ge 0 -and $inspectorCompileIndex -gt $inspectorPreIndex -and
     $inspectorPostIndex -gt $inspectorCompileIndex -and
     (Has-Literal $runner '-NugetConfig $nugetInspector -TargetingPackRoot $targetingPackRoot')) `
    'The inspector uses the same analyzer-free pack and checks extensions before and after compile.'
$runtimeInventoryIndex = $runner.IndexOf(
    '$runtimeEvidence = Get-PinnedRuntimeEvidence', [StringComparison]::Ordinal)
$runtimePreLaunchIndex = $runner.IndexOf(
    '$runtimePreLaunchState = Get-ExactRawTreeState', [StringComparison]::Ordinal)
$inspectorLaunchIndex = $runner.IndexOf(
    "`$inspectorDll, 'inspect'", [StringComparison]::Ordinal)
$runtimePostLaunchIndex = $runner.IndexOf(
    '$runtimePostLaunchState = Get-ExactRawTreeState', [StringComparison]::Ordinal)
Assert-Check 'runner.inspector-runtime-order' `
    ($runtimeInventoryIndex -ge 0 -and $runtimePreLaunchIndex -gt $runtimeInventoryIndex -and
     $inspectorLaunchIndex -gt $runtimePreLaunchIndex -and
     $runtimePostLaunchIndex -gt $inspectorLaunchIndex -and
     (Has-Literal $runner "'^Microsoft\.NETCore\.App ([0-9]+\.[0-9]+\.[0-9]+) \[(.+)\]$'") -and
     (Has-Literal $runner "Join-Path `$DotnetRoot 'shared\Microsoft.NETCore.App'")) `
    'The exact path-redacted inspector runtime tree is bound before and after launch.'
$inspectorFailureDiagnosticIndex = $runner.IndexOf(
    'Write-Host ("INSPECTOR-CHECK-FAILED {0}" -f $name)', [StringComparison]::Ordinal)
$inspectorExitValidationIndex = $runner.IndexOf(
    'if ($inspectionProcess.ExitCode -notin @(0, 2)) {', [StringComparison]::Ordinal)
$inspectorRuntimePostFailureIndex = $runner.IndexOf(
    'if ($inspectionReportedFailure) {', $inspectorFailureDiagnosticIndex + 1,
    [StringComparison]::Ordinal)
$safeInspectorCheckNamePattern = '\A[A-Za-z0-9_./-]{1,256}\z'
Assert-Check 'runner.inspector-failed-check-diagnostic' `
    ((Has-Literal $runner '$inspectionProcess.ExitCode -notin @(0, 2)') -and
     (Has-Literal $runner '$inspectionReportedFailure = $inspectionProcess.ExitCode -eq 2') -and
     (Has-Literal $runner "`$name -cnotmatch '\A[A-Za-z0-9_./-]{1,256}\z'") -and
     (Has-Literal $runner "`$name.IndexOf('//', [StringComparison]::Ordinal) -ge 0") -and
     (Has-Literal $runner "`$name.IndexOf('../', [StringComparison]::Ordinal) -ge 0") -and
     (Has-Literal $runner "`$name.StartsWith('/', [StringComparison]::Ordinal)") -and
     [regex]::IsMatch(
        'pdb.codeView.pathRole', $safeInspectorCheckNamePattern,
        [Text.RegularExpressions.RegexOptions]::CultureInvariant) -and
     -not [regex]::IsMatch(
        "pdb.codeView.pathRole`n", $safeInspectorCheckNamePattern,
        [Text.RegularExpressions.RegexOptions]::CultureInvariant) -and
     -not [regex]::IsMatch(
        'resource.C:/private', $safeInspectorCheckNamePattern,
        [Text.RegularExpressions.RegexOptions]::CultureInvariant) -and
     'resource.//server/share'.IndexOf('//', [StringComparison]::Ordinal) -ge 0 -and
     $inspectorFailureDiagnosticIndex -ge 0 -and
     $inspectorExitValidationIndex -gt $runtimePostLaunchIndex -and
     $inspectorRuntimePostFailureIndex -gt $runtimePostLaunchIndex -and
     $inspectorRuntimePostFailureIndex -gt $inspectorFailureDiagnosticIndex -and
     -not (Has-Literal $runner '$inspectionProcess.StandardOutput') -and
     -not (Has-Literal $runner '$inspectionProcess.StandardError') -and
     -not (Has-Literal $runner 'INSPECTOR-CHECK-FAILED $check.actual') -and
     -not (Has-Literal $runner 'INSPECTOR-CHECK-FAILED $check.expected')) `
    'Exit two reports only bounded failed-check names and still verifies the runtime post-launch.'
Assert-Check 'runner.no-source-parameter' `
    (-not (Has-Regex $runner '(?m)^\s*\[string\]\s+\$(SourceRoot|Repository|Commit)\b')) `
    'Runner exposes no caller-selected source/repository/commit parameter.'

$readme = Get-Content -LiteralPath (Join-Path $leafRoot 'README.md') -Raw
$readmeAnchorIndex = 0
foreach ($literal in @(
    'observation infrastructure only', 'All six aggregate',
    'profiles/nintendo/switch-pro.json',
    'environment-root `global.json`', 'runtime `10.0.11`', '`dotnet --list-runtimes`',
    'receipt redacts the filesystem path',
    'official .NET 10', '`dotnet/dotnet` VMR commit',
    '`Microsoft.NETCore.App.Ref` pack to `10.0.11`',
    '`Microsoft.Windows.SDK.NET.Ref` `10.0.26100.57`',
    '348-file, 43,511,590-byte', '438 files', '108,699,170 bytes',
    'preserves that original tree as evidence', '`Type="Analyzer"` row',
    'effective `@(Analyzer)` item set', 'logical command-line capture',
    'Editor/global-config discovery is disabled', 'MSBuild workload resolver is disabled',
    'instrument operating-system sockets',
    'AddressOfEntryPoint == 0', 'EntryPointTokenOrRelativeVirtualAddress == 0',
    'zero native import modules and symbols',
    'do not upload the DLL or PDB', '241 input files', 'quiescent, hash-bound'
)) {
    Assert-Check ('readme.anchor.' + $readmeAnchorIndex) `
        (Has-Literal $readme $literal) 'README preserves the observation-only truth boundary.'
    $readmeAnchorIndex++
}

$actualCheckCount = $checks.Count + 1
Assert-Check 'verifier.check-count' `
    ($lock.expectedSourceVerifierCheckCount -eq $actualCheckCount) `
    "Expected verifier check count is $actualCheckCount."
$failed = @($checks | Where-Object { -not $_.passed })
$receipt = [ordered]@{
    schemaVersion = 1
    ok = ($failed.Count -eq 0)
    assurance = 'static-source-only-s1.5e-observation-infrastructure'
    checkCount = $checks.Count
    passedCount = $checks.Count - $failed.Count
    failedCount = $failed.Count
    observationEstablished = $false
    candidateBuilt = $false
    candidateLoaded = $false
    candidateExecuted = $false
    gateState = $lock.gateState
    checks = $checks
}
$receipt | ConvertTo-Json -Depth 100
if ($failed.Count -ne 0) { exit 1 }
