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

function Get-NormalizedBytes {
    param([string] $Path)
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        throw "BOM is forbidden: $Path"
    }
    $text = $utf8.GetString($bytes).Replace("`r`n", "`n").Replace("`r", "`n")
    return ,$utf8.GetBytes($text)
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
    ($lock.toolchain.inspectorRuntimeFrameworkVersion -ceq '10.0.11') `
    'Inspector host framework version is exact.'
Assert-Check 'lock.build-count' ($lock.toolchain.buildCount -eq 2) 'Two builds are required.'
Assert-Check 'lock.staged-count' ($lock.sourceCandidate.stagedInputFileCount -eq 241) `
    'Twelve candidate, one retained, and 228 profiles are staged.'
Assert-Check 'lock.candidate-tree' `
    ($lock.sourceCandidate.normalizedTreeSha256 -ceq
        '4AC8E4AAD314BC44BE9EC629AD85CCAD3739DA85406857520E6E6B9FCFC88393') `
    'S1.5d candidate tree is exact.'
Assert-Check 'lock.native-bootstrap' `
    ($lock.artifactExpectation.managedEntryPointTokenOrRva -eq 0 -and
     $lock.artifactExpectation.nativeAddressOfEntryPointExpectedNonzero -eq $true -and
     $lock.artifactExpectation.allowedNativeBootstrapModule -ceq 'mscoree.dll' -and
     $lock.artifactExpectation.allowedNativeBootstrapSymbol -ceq '_CorDllMain') `
    'CLI managed entry point and native bootstrap are not conflated.'
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
    'AddressOfEntryPoint != 0', 'allowedNativeBootstrapModule', 'allowedNativeBootstrapSymbol',
    'CodeManagerTableDirectory', 'VtableFixupsDirectory',
    'ExportAddressTableJumpsDirectory', 'DelayImportTableDirectory',
    'ThreadLocalStorageTableDirectory', 'ReadDebugDirectory()',
    'ReadCodeViewDebugDirectoryData', 'ReadPdbChecksumDebugDirectoryData',
    'MethodSpecificationHandle', 'StandaloneSignatureHandle', 'TypeSpecificationHandle',
    'ParseInstructions(il)', 'MethodBodySha256', 'ExceptionRegionEntry',
    'ImplementationMapCount', 'ModuleInitializerAttribute',
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
Assert-Check 'program.no-native-entrypoint-zero-confusion' `
    (-not (Has-Regex $program 'AddressOfEntryPoint\s*==\s*0')) `
    'Native AddressOfEntryPoint is not required to be zero.'
Assert-Check 'program.no-absolute-artifact-path-in-report' `
    (Has-Literal $program '"candidate-dll"') `
    'The receipt uses an artifact role rather than the absolute input path.'

$runner = Get-Content -LiteralPath (Join-Path $leafRoot 'run-actions-proof.ps1') -Raw
$runnerAnchorIndex = 0
foreach ($literal in @(
    '$env:GITHUB_ACTIONS', '$env:RUNNER_OS', '$env:RUNNER_TEMP', '$env:GITHUB_WORKSPACE',
    '[AllowEmptyString()][string] $Text',
    'Set-HardenedProcessEnvironment', 'CORECLR_', 'DOTNET_', 'MSBUILD', 'NUGET_',
    "DOTNET_ROLL_FORWARD = 'Disable'",
    'Set-IsolatedChildTempRoot', 'PSModulePath', 'POWERSHELL_UPDATECHECK',
    "'GIT_'", 'GIT_TEMPLATE_DIR', '--no-replace-objects', 'protocol.allow=never',
    "@('100644', '100755')", '.NETCoreApp,Version=v10.0/win-x64',
    'System.Reflection.Metadata.MetadataUpdater.IsSupported',
    '-noAutoResponse', '--depth=1', '--no-tags', 'Assert-NoReparsePoints',
    'Stage-ExactCandidate', '$expectedPaths.Count -ne 241', 'Get-FramedTreeSha256',
    "-ByteMode Raw", "-ByteMode Normalized", 'Invoke-CandidateBuild',
    "-Name 'ksx-hm-s15e-build-a'", "-Name 'ksx-hm-s15e-build-b'",
    'EnableNETAnalyzers=false', 'RunAnalyzersDuringBuild=false',
    'EmitCompilerGeneratedFiles=true', 'Analyzer', 'ReferencePath',
    'AdditionalFiles', 'AnalyzerConfigFiles', 'MSBuildAllProjects',
    'Get-NoPackageAssetsSemantic', 'project.assets.json dependency group is not empty',
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
Assert-Check 'runner.no-source-parameter' `
    (-not (Has-Regex $runner '(?m)^\s*\[string\]\s+\$(SourceRoot|Repository|Commit)\b')) `
    'Runner exposes no caller-selected source/repository/commit parameter.'

$readme = Get-Content -LiteralPath (Join-Path $leafRoot 'README.md') -Raw
$readmeAnchorIndex = 0
foreach ($literal in @(
    'observation infrastructure only', 'All six aggregate',
    'environment-root `global.json`', 'runtime `10.0.11`',
    'AddressOfEntryPoint', 'EntryPointTokenOrRelativeVirtualAddress == 0',
    'does not interpret the entry-point machine-code trampoline',
    'do not upload the DLL or PDB', '241 input files', 'quiescent and hash-bound'
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
