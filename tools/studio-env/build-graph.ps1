Set-StrictMode -Version Latest

# The Studio executable embeds crates/ksx-studio/assets at compile time. An
# asset writer and an executable builder therefore operate on one build graph,
# even though Node and Cargo are separate processes. Keep the mutex name in one
# checked-in helper so future seed/start/watch callers cannot accidentally use
# look-alike locks that do not exclude each other.
$script:KsxStudioBuildGraphMutexName = "Global\KSXStudioBuildGraph-v1"

function Enter-KsxStudioBuildGraphLock {
    [CmdletBinding()]
    param(
        [string]$Operation = "using the Studio build graph"
    )

    $Mutex = $null
    try {
        $Mutex = [System.Threading.Mutex]::new(
            $false,
            $script:KsxStudioBuildGraphMutexName
        )
    } catch [System.UnauthorizedAccessException] {
        throw "The machine-wide Studio build-graph lock is owned by another Windows identity. Refusing to race while $Operation."
    }

    $Held = $false
    try {
        try {
            $Held = $Mutex.WaitOne(0)
        } catch [System.Threading.AbandonedMutexException] {
            $Held = $true
        }
        if (-not $Held) {
            throw "Another process is already using the Studio build graph. Wait for it to finish, then retry $Operation."
        }

        return [pscustomobject]@{
            Mutex = $Mutex
            Held = $true
            Name = $script:KsxStudioBuildGraphMutexName
        }
    } catch {
        if ($Mutex) {
            $Mutex.Dispose()
        }
        throw
    }
}

function Exit-KsxStudioBuildGraphLock {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [psobject]$Lock
    )

    if ($Lock.Held) {
        $Lock.Mutex.ReleaseMutex()
        $Lock.Held = $false
    }
    $Lock.Mutex.Dispose()
}

function Get-KsxStudioAssetsDirtyMarkerPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    return Join-Path $RepoRoot "tmp\studio-env\assets.dirty"
}

function Get-KsxStudioAssetStatePath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    return Join-Path $RepoRoot "tmp\studio-env\assets-state.json"
}

function Get-KsxStudioTextSha256 {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Text
    )

    $Bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    $Hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        return -join @($Hasher.ComputeHash($Bytes) | ForEach-Object { $_.ToString("x2") })
    } finally {
        $Hasher.Dispose()
    }
}

function Get-KsxStudioGeneratedOutputSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    $Root = [System.IO.Path]::GetFullPath($RepoRoot).TrimEnd('\', '/')
    $RootPrefix = $Root + [System.IO.Path]::DirectorySeparatorChar
    $AssetsRoot = Join-Path $Root "crates\ksx-studio\assets"
    if (-not (Test-Path -LiteralPath $AssetsRoot -PathType Container)) {
        throw "Studio asset output is missing at $AssetsRoot."
    }

    $Files = [System.Collections.Generic.Dictionary[string, string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )

    function Add-KsxStudioGeneratedFile {
        param(
            [Parameter(Mandatory = $true)][string]$Path,
            [switch]$Required
        )

        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            if ($Required) {
                throw "Studio build did not emit required generated file $Path."
            }
            return
        }
        $Full = [System.IO.Path]::GetFullPath($Path)
        if (-not $Full.StartsWith($RootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Generated Studio output escaped the repository: $Full"
        }
        $Relative = $Full.Substring($Root.Length).TrimStart('\', '/').Replace('\', '/')
        $Files[$Relative] = $Full
    }

    foreach ($Item in Get-ChildItem -LiteralPath $AssetsRoot -File -Recurse -Force) {
        Add-KsxStudioGeneratedFile -Path $Item.FullName
    }
    foreach ($Relative in @(
        "studio-ui\src\tokens.gen.css",
        "studio-ui\src\zones.gen.ts",
        "studio-ui\tokens\zones.json",
        "crates\ksx-studio\src\theme_tokens.rs"
    )) {
        Add-KsxStudioGeneratedFile -Path (Join-Path $Root $Relative) -Required
    }

    if ($Files.Count -eq 0) {
        throw "Studio build emitted no generated files."
    }

    $RelativeNames = [string[]]@($Files.Keys)
    [System.Array]::Sort($RelativeNames, [System.StringComparer]::Ordinal)
    $Snapshot = New-Object System.Collections.Generic.List[object]
    foreach ($RelativeName in $RelativeNames) {
        $File = Get-Item -LiteralPath $Files[$RelativeName]
        $Snapshot.Add([pscustomobject][ordered]@{
            Path = $RelativeName
            Length = [long]$File.Length
            Sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $File.FullName).Hash.ToLowerInvariant()
        })
    }
    return $Snapshot.ToArray()
}

function Get-KsxStudioGeneratedOutputGraphHash {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$Snapshot
    )

    $Entries = [System.Collections.Generic.Dictionary[string, string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    foreach ($Entry in @($Snapshot)) {
        if ($null -eq $Entry -or
            -not ($Entry.PSObject.Properties.Name -contains "Path") -or
            -not ($Entry.PSObject.Properties.Name -contains "Length") -or
            -not ($Entry.PSObject.Properties.Name -contains "Sha256")) {
            throw "Generated-output snapshot contains an incomplete entry."
        }
        $Path = [string]$Entry.Path
        $Sha256 = [string]$Entry.Sha256
        $Length = [long]$Entry.Length
        if ([string]::IsNullOrWhiteSpace($Path) -or
            [System.IO.Path]::IsPathRooted($Path) -or
            $Path.Contains("\") -or
            $Path -match '(^|/)\.\.(/|$)' -or
            $Sha256 -notmatch '^[0-9a-f]{64}$' -or
            $Length -lt 0) {
            throw "Generated-output snapshot contains an invalid entry for '$Path'."
        }
        if ($Entries.ContainsKey($Path)) {
            throw "Generated-output snapshot contains duplicate path '$Path'."
        }
        $Entries.Add($Path, "$Path|$Length|$Sha256")
    }

    $Paths = [string[]]@($Entries.Keys)
    [System.Array]::Sort($Paths, [System.StringComparer]::Ordinal)
    $Lines = New-Object System.Collections.Generic.List[string]
    foreach ($Path in $Paths) {
        $Lines.Add($Entries[$Path])
    }
    return Get-KsxStudioTextSha256 -Text ($Lines -join "`n")
}

function Get-KsxStudioGeneratedOutputChanges {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object[]]$Before,
        [Parameter(Mandatory = $true)][object[]]$After
    )

    $BeforeByPath = [System.Collections.Generic.Dictionary[string, object]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    foreach ($Entry in @($Before)) { $BeforeByPath[[string]$Entry.Path] = $Entry }
    $AfterByPath = [System.Collections.Generic.Dictionary[string, object]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    foreach ($Entry in @($After)) { $AfterByPath[[string]$Entry.Path] = $Entry }

    $PathSet = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    foreach ($Path in $BeforeByPath.Keys) { [void]$PathSet.Add($Path) }
    foreach ($Path in $AfterByPath.Keys) { [void]$PathSet.Add($Path) }
    $Paths = [string[]]@($PathSet)
    [System.Array]::Sort($Paths, [System.StringComparer]::Ordinal)

    $Changed = New-Object System.Collections.Generic.List[string]
    foreach ($Path in $Paths) {
        if (-not $BeforeByPath.ContainsKey($Path) -or
            -not $AfterByPath.ContainsKey($Path) -or
            [long]$BeforeByPath[$Path].Length -ne [long]$AfterByPath[$Path].Length -or
            -not [string]::Equals(
                [string]$BeforeByPath[$Path].Sha256,
                [string]$AfterByPath[$Path].Sha256,
                [System.StringComparison]::Ordinal
            )) {
            $Changed.Add($Path)
        }
    }
    return $Changed.ToArray()
}

function Assert-KsxStudioAssetGraphReady {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedStudioInputSha256,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedZoneProducerSha256
    )

    $DirtyMarker = Get-KsxStudioAssetsDirtyMarkerPath -RepoRoot $RepoRoot
    if (Test-Path -LiteralPath $DirtyMarker -PathType Leaf) {
        throw "Studio assets are marked partial or unverified at $DirtyMarker. Run tools/studio-env/build-assets.ps1 successfully before compiling a served environment."
    }

    $StatePath = Get-KsxStudioAssetStatePath -RepoRoot $RepoRoot
    if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) {
        throw "Studio has no validated asset-state receipt. Run tools/studio-env/build-assets.ps1 before compiling a served environment."
    }
    try {
        $State = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    } catch {
        throw "Studio asset-state receipt is unreadable. Run tools/studio-env/build-assets.ps1 again. $($_.Exception.Message)"
    }
    $RequiredProperties = @(
        "schema_version",
        "studio_input_sha256",
        "zone_producer_sha256",
        "asset_graph_sha256",
        "generated_file_count",
        "generated_files"
    )
    if (@($RequiredProperties | Where-Object { -not ($State.PSObject.Properties.Name -contains $_) }).Count -gt 0 -or
        [int]$State.schema_version -ne 2 -or
        [string]$State.studio_input_sha256 -notmatch '^[0-9a-f]{64}$' -or
        [string]$State.zone_producer_sha256 -notmatch '^[0-9a-f]{64}$' -or
        [string]$State.asset_graph_sha256 -notmatch '^[0-9a-f]{64}$' -or
        [int]$State.generated_file_count -lt 1) {
        throw "Studio asset-state receipt has an unsupported or incomplete shape. Run tools/studio-env/build-assets.ps1 again."
    }
    if ([string]$State.studio_input_sha256 -cne $ExpectedStudioInputSha256) {
        throw "Studio authoring inputs changed after the validated asset build. Run tools/studio-env/build-assets.ps1 before compiling a served environment."
    }
    if ([string]$State.zone_producer_sha256 -cne $ExpectedZoneProducerSha256) {
        throw "Rust zone-vocabulary producer inputs changed after the validated asset build. Run tools/studio-env/build-assets.ps1 before compiling a served environment."
    }

    # A receipt is evidence only if it still describes the generated files on
    # disk. Re-enumerate and hash every output here so an edit, deletion, stale
    # compression sibling, or unreceipted extra asset cannot reach Cargo.
    try {
        $ReceiptedSnapshot = @($State.generated_files)
        $ReceiptedGraphHash = Get-KsxStudioGeneratedOutputGraphHash -Snapshot $ReceiptedSnapshot
        $ActualSnapshot = @(Get-KsxStudioGeneratedOutputSnapshot -RepoRoot $RepoRoot)
        $ActualGraphHash = Get-KsxStudioGeneratedOutputGraphHash -Snapshot $ActualSnapshot
    } catch {
        throw "Studio generated outputs cannot be validated against their receipt. Run tools/studio-env/build-assets.ps1 again. $($_.Exception.Message)"
    }
    if ($ReceiptedSnapshot.Count -ne [int]$State.generated_file_count -or
        $ActualSnapshot.Count -ne [int]$State.generated_file_count -or
        -not [string]::Equals($ReceiptedGraphHash, [string]$State.asset_graph_sha256, [System.StringComparison]::Ordinal) -or
        -not [string]::Equals($ActualGraphHash, [string]$State.asset_graph_sha256, [System.StringComparison]::Ordinal)) {
        $Changed = @(Get-KsxStudioGeneratedOutputChanges -Before $ReceiptedSnapshot -After $ActualSnapshot)
        $Detail = if ($Changed.Count -gt 0) { " Changed outputs: $($Changed -join ', ')." } else { "" }
        throw "Studio generated outputs differ from their validated asset-state receipt.$Detail Run tools/studio-env/build-assets.ps1 again before compiling a served environment."
    }
    return $State
}
