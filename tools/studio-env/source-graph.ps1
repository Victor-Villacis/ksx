Set-StrictMode -Version Latest

function Get-KsxSourceGraphFiles {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("Studio", "Runtime", "ZoneProducers", "All")]
        [string]$Kind,

        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    $Root = [System.IO.Path]::GetFullPath($RepoRoot).TrimEnd('\', '/')
    $RootPrefix = $Root + [System.IO.Path]::DirectorySeparatorChar
    $Files = [System.Collections.Generic.Dictionary[string, string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )

    function Add-KsxSourceFile {
        param([string]$Path)
        if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            return
        }
        $Full = [System.IO.Path]::GetFullPath($Path)
        if (-not [string]::Equals($Full, $Root, [System.StringComparison]::OrdinalIgnoreCase) -and
            -not $Full.StartsWith($RootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Source-graph input escaped the repository: $Full"
        }
        $Files[$Full] = $Full
    }

    function Add-KsxSourceTree {
        param(
            [string]$Path,
            [string[]]$Extensions,
            [string[]]$ExcludedRelativePrefixes = @()
        )
        if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
            return
        }
        foreach ($Item in Get-ChildItem -LiteralPath $Path -File -Recurse -Force) {
            $Relative = $Item.FullName.Substring($Root.Length).TrimStart('\', '/') -replace '\\', '/'
            $Excluded = $false
            foreach ($Prefix in $ExcludedRelativePrefixes) {
                if ($Relative.StartsWith($Prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $Excluded = $true
                    break
                }
            }
            if ($Excluded) { continue }
            if ($Extensions.Count -gt 0 -and $Extensions -notcontains $Item.Extension.ToLowerInvariant()) {
                continue
            }
            Add-KsxSourceFile $Item.FullName
        }
    }

    if ($Kind -eq "Studio" -or $Kind -eq "All") {
        foreach ($Relative in @(
            ".node-version",
            "tools\studio-env\build-assets.ps1",
            "tools\studio-env\build-graph.ps1",
            "tools\studio-env\source-graph.ps1",
            "studio-ui\build.mjs",
            "studio-ui\tokens\build-tokens.mjs",
            "studio-ui\package.json",
            "studio-ui\package-lock.json",
            "crates\ksx-studio\src\render_map.rs",
            "crates\ksx-core\src\preset.rs",
            "crates\ksx-config\src\function.rs"
        )) {
            Add-KsxSourceFile (Join-Path $Root $Relative)
        }
        Add-KsxSourceTree `
            -Path (Join-Path $Root "studio-ui\src") `
            -Extensions @(".ts", ".css", ".svg", ".json") `
            -ExcludedRelativePrefixes @(
                "studio-ui/src/tokens.gen.css",
                "studio-ui/src/zones.gen.ts"
            )
        Add-KsxSourceTree `
            -Path (Join-Path $Root "studio-ui\tokens") `
            -Extensions @(".json", ".css", ".mjs") `
            -ExcludedRelativePrefixes @("studio-ui/tokens/zones.json")
        Add-KsxSourceTree -Path (Join-Path $Root "studio-ui\art") -Extensions @(".svg", ".json", ".md")
    }

    # The ignored Rust test which emits tokens/zones.json is a compiler in its
    # own right. Keep its semantic producer graph separate so build-assets can
    # prove that it did not compile one revision and receipt another. Its own
    # generated theme_tokens.rs output is intentionally excluded from inputs.
    if ($Kind -eq "ZoneProducers" -or $Kind -eq "All") {
        foreach ($Relative in @(
            "Cargo.toml",
            "Cargo.lock",
            "rust-toolchain.toml"
        )) {
            Add-KsxSourceFile (Join-Path $Root $Relative)
        }
        Add-KsxSourceTree `
            -Path (Join-Path $Root "crates") `
            -Extensions @(".rs", ".toml") `
            -ExcludedRelativePrefixes @(
                "crates/ksx-studio/src/theme_tokens.rs"
            )
    }

    if ($Kind -eq "Runtime" -or $Kind -eq "All") {
        foreach ($Relative in @(
            "Cargo.toml",
            "Cargo.lock",
            "rust-toolchain.toml",
            "rustfmt.toml"
        )) {
            Add-KsxSourceFile (Join-Path $Root $Relative)
        }
        # Cargo embeds more than Rust source: Studio's hashed .ir payloads and
        # their .br/.gz siblings, templates, snapshots, icons, and provider
        # inputs all become part of the executable or its verification graph.
        Add-KsxSourceTree -Path (Join-Path $Root "crates") -Extensions @() -ExcludedRelativePrefixes @()
        Add-KsxSourceTree -Path (Join-Path $Root "assets\brand") -Extensions @() -ExcludedRelativePrefixes @()
        Add-KsxSourceTree -Path (Join-Path $Root "third_party\libwdi") -Extensions @() -ExcludedRelativePrefixes @()
        Add-KsxSourceTree `
            -Path (Join-Path $Root "tools\studio-env") `
            -Extensions @(".ps1") `
            -ExcludedRelativePrefixes @()
    }

    # Sort-Object is culture-sensitive and has changed details between Windows
    # PowerShell 5.1 and PowerShell 7. Receipts are a byte-level contract, so
    # their traversal order must be explicitly ordinal on every host.
    $Sorted = [string[]]@($Files.Values)
    [System.Array]::Sort($Sorted, [System.StringComparer]::Ordinal)
    return @($Sorted)
}

function Get-KsxSourceGraphFingerprint {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("Studio", "Runtime", "ZoneProducers", "All")]
        [string]$Kind,

        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,

        [switch]$MetadataOnly
    )

    $Root = [System.IO.Path]::GetFullPath($RepoRoot).TrimEnd('\', '/')
    $Lines = New-Object System.Collections.Generic.List[string]
    foreach ($Path in @(Get-KsxSourceGraphFiles -Kind $Kind -RepoRoot $Root)) {
        $Item = Get-Item -LiteralPath $Path
        $Relative = $Path.Substring($Root.Length).TrimStart('\', '/') -replace '\\', '/'
        if ($MetadataOnly) {
            $Lines.Add("$Relative|$($Item.Length)|$($Item.LastWriteTimeUtc.Ticks)")
        } else {
            $Hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
            $Lines.Add("$Relative|$($Item.Length)|$Hash")
        }
    }

    $Payload = [System.Text.Encoding]::UTF8.GetBytes(($Lines -join "`n"))
    $Hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        $Digest = $Hasher.ComputeHash($Payload)
        -join @($Digest | ForEach-Object { $_.ToString("x2") })
    } finally {
        $Hasher.Dispose()
    }
}
