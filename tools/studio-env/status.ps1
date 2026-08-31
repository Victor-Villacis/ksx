<#
.SYNOPSIS
    What is running on every lane, whether it is healthy, and whether it is
    current. Read-only.

.DESCRIPTION
    Lists every manual and default Playwright port with its state, watcher
    state and provenance. Three separate facts, and conflating them is how a
    stale page becomes QA evidence:

      Healthy             the recorded processes, listener, fixture/live
                          identity and daemon endpoints all agree.
      ProvenanceComplete  the managed receipt carries all four exact
                          identities: runtime source graph, Studio authoring
                          graph, Rust zone-producer graph, generated assets.
      Current             stricter -- those four identities must equal the
                          checkout NOW, and the generated files on disk must
                          still hash to their receipt. A healthy previous
                          artifact can therefore stay usable while a new edit
                          builds, without being mislabeled current.

    Safe to run at any time, including in the middle of a build: assets/ is
    deleted and rewritten by every asset build, and this report is written to
    survive that window rather than to report a torn read as a failure.

.PARAMETER Environment
    Report one lane instead of the whole table. The test-* names are
    Playwright-owned; they are listed so a stray process is visible, never so a
    person starts one.

.PARAMETER Json
    Stable automation output. The table is for people; both include watcher
    state.

.PARAMETER RequireHealthy
    Exit nonzero unless every selected lane is healthy.

.PARAMETER RequireCurrent
    Exit nonzero unless every selected lane is current. Independent of
    -RequireHealthy on purpose -- see the three facts above.

.PARAMETER SkipCurrentVerification
    For watch mode only, which already hashes the source graph itself. Keeps its
    health reconciliation cheap while people and deployment gates keep the
    default exact-current audit.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/status.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/status.ps1 -Environment real -RequireHealthy -RequireCurrent

.LINK
    docs/STUDIO-ENVIRONMENTS.md
#>
[CmdletBinding()]
param(
    [ValidateSet(
        "real",
        "seeded",
        "test-macro",
        "test-canvas",
        "test-parity-idle",
        "test-parity-running",
        "test-parity-down",
        "test-canvas-live",
        "test-visual",
        "test-theme-dark",
        "test-theme-light",
        "test-theme-matrix",
        "first-run"
    )]
    [string]$Environment,

    [switch]$Json,

    [switch]$RequireHealthy,

    [switch]$RequireCurrent,

    # Watch mode already hashes the source graph itself. This keeps its health
    # reconciliation cheap while preserving the default exact-current audit
    # for people and deployment gates.
    [switch]$SkipCurrentVerification
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-probe.ps1")
. (Join-Path $PSScriptRoot "build-graph.ps1")
. (Join-Path $PSScriptRoot "source-graph.ps1")

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$RuntimeRoot = Join-Path $RepoRoot "tmp\studio-env"
$Definitions = @(
    @{ Name = "real"; Port = 4460; Id = "live-machine"; Fixture = $false; Record = "real"; ManualAllowed = $true }
    @{ Name = "seeded"; Port = 4476; Id = "fixture-seeded-demo"; Fixture = $true; Record = "seeded" }
    @{ Name = "test-macro"; Port = 4478; Id = "fixture-seeded-demo"; Fixture = $true; TestOwned = $true }
    @{ Name = "test-canvas"; Port = 4479; Id = "fixture-seeded-demo"; Fixture = $true; TestOwned = $true }
    @{ Name = "test-parity-idle"; Port = 4488; Id = "fixture-seeded-demo"; Fixture = $true; TestOwned = $true }
    @{ Name = "test-parity-running"; Port = 4489; Id = "fixture-seeded-demo"; Fixture = $true; TestOwned = $true }
    @{ Name = "test-parity-down"; Port = 4490; Id = "fixture-seeded-demo"; Fixture = $true; TestOwned = $true }
    @{ Name = "test-canvas-live"; Port = 4496; Id = "fixture-seeded-demo"; Fixture = $true; TestOwned = $true }
    @{ Name = "test-visual"; Port = 4500; Id = "fixture-seeded-demo"; Fixture = $true; TestOwned = $true }
    @{ Name = "test-theme-dark"; Port = 4510; Id = "fixture-seeded-demo"; Fixture = $true; TestOwned = $true }
    @{ Name = "test-theme-light"; Port = 4511; Id = "fixture-seeded-demo"; Fixture = $true; TestOwned = $true }
    @{ Name = "test-theme-matrix"; Port = 4512; Id = "fixture-seeded-demo"; Fixture = $true; TestOwned = $true }
    @{ Name = "first-run"; Port = 4520; Id = "fixture-first-run"; Fixture = $true; Record = "first-run" }
)
# The three theme lanes above are hand-kept, but nothing hand-keeps the
# fixtures that occupy them: studio-ui/pwtest/visual-smoke.test.mjs spawns one
# per entry in crates/ksx-studio/assets/themes.json, at KSX_PWTEST_THEME_PORT
# (default 4510) plus that entry's index. Add a fourth theme and a fourth
# fixture appears on 4513 -- a port this table cannot report, and one no other
# roster reserves either. The lane names are also -Environment's ValidateSet
# values, so this table cannot simply be derived from that file; the honest
# alternative is to notice the drift out loud the first time anyone asks for
# status. Warn rather than throw, and only when the file is actually readable:
# assets/ is deleted and rewritten by every build (see build-assets.ps1), and a
# status report must survive being run in the middle of one.
try {
    $ThemesManifest = Join-Path $RepoRoot "crates\ksx-studio\assets\themes.json"
    if (Test-Path -LiteralPath $ThemesManifest -PathType Leaf) {
        $ThemeFirstPort = 4510
        $ManifestThemes = @((Get-Content -LiteralPath $ThemesManifest -Raw | ConvertFrom-Json).themes)
        $ExpectedThemeLanes = @(
            for ($ThemeIndex = 0; $ThemeIndex -lt $ManifestThemes.Count; $ThemeIndex += 1) {
                "test-theme-$([string]$ManifestThemes[$ThemeIndex].id):$($ThemeFirstPort + $ThemeIndex)"
            }
        )
        $ListedThemeLanes = @(
            $Definitions |
                Where-Object { [string]$_.Name -like "test-theme-*" } |
                ForEach-Object { "$([string]$_.Name):$([int]$_.Port)" }
        )
        if (($ExpectedThemeLanes -join ", ") -cne ($ListedThemeLanes -join ", ")) {
            Write-Warning "Theme lane roster is stale: themes.json spawns [$($ExpectedThemeLanes -join ', ')] but this roster reports [$($ListedThemeLanes -join ', ')]. Fixtures on unlisted ports are invisible here. Update the table above, -Environment's ValidateSet, and docs/STUDIO-ENVIRONMENTS.md."
        }
    }
} catch {
    Write-Warning "Theme lane roster could not be checked against themes.json: $($_.Exception.Message)"
}
if (($RequireHealthy -or $RequireCurrent) -and [string]::IsNullOrWhiteSpace($Environment)) {
    throw "-RequireHealthy and -RequireCurrent require one explicit -Environment so stopped, test-owned ports are never treated as an implicit deployment gate."
}
if ($RequireCurrent -and $SkipCurrentVerification) {
    throw "-RequireCurrent cannot be combined with -SkipCurrentVerification."
}
if (-not [string]::IsNullOrWhiteSpace($Environment)) {
    $Definitions = @($Definitions | Where-Object { [string]$_.Name -eq $Environment })
}
$Rows = @()
$script:KsxStatusBuildGraphEvidence = $null

function Get-KsxStatusBuildGraphEvidence {
    if ($null -ne $script:KsxStatusBuildGraphEvidence) {
        return $script:KsxStatusBuildGraphEvidence
    }

    $BuildGraphLock = $null
    try {
        # A build in progress is intentionally not "current" yet. Taking the
        # same nonblocking lock also closes the gap between reading the receipt
        # and hashing the generated files it vouches for.
        $BuildGraphLock = Enter-KsxStudioBuildGraphLock `
            -Operation "proving Studio environment currency"
        $StudioHash = Get-KsxSourceGraphFingerprint -Kind Studio -RepoRoot $RepoRoot
        $ZoneProducerHash = Get-KsxSourceGraphFingerprint -Kind ZoneProducers -RepoRoot $RepoRoot
        $RuntimeHash = Get-KsxSourceGraphFingerprint -Kind Runtime -RepoRoot $RepoRoot
        $AssetState = Assert-KsxStudioAssetGraphReady `
            -RepoRoot $RepoRoot `
            -ExpectedStudioInputSha256 $StudioHash `
            -ExpectedZoneProducerSha256 $ZoneProducerHash
        $StudioAfter = Get-KsxSourceGraphFingerprint -Kind Studio -RepoRoot $RepoRoot
        $ZoneProducerAfter = Get-KsxSourceGraphFingerprint -Kind ZoneProducers -RepoRoot $RepoRoot
        $RuntimeAfter = Get-KsxSourceGraphFingerprint -Kind Runtime -RepoRoot $RepoRoot
        if ($StudioAfter -cne $StudioHash -or $ZoneProducerAfter -cne $ZoneProducerHash -or
            $RuntimeAfter -cne $RuntimeHash) {
            throw "source changed while its current-build evidence was being collected; retry after the edit settles"
        }
        $script:KsxStatusBuildGraphEvidence = [pscustomobject]@{
            Available = $true
            Detail = "current source and generated asset graph verified"
            Studio = $StudioHash
            ZoneProducers = $ZoneProducerHash
            Runtime = $RuntimeHash
            Assets = [string]$AssetState.asset_graph_sha256
        }
    } catch {
        $script:KsxStatusBuildGraphEvidence = [pscustomobject]@{
            Available = $false
            Detail = $_.Exception.Message
            Studio = ""
            ZoneProducers = ""
            Runtime = ""
            Assets = ""
        }
    } finally {
        if ($BuildGraphLock) {
            Exit-KsxStudioBuildGraphLock -Lock $BuildGraphLock
        }
    }
    return $script:KsxStatusBuildGraphEvidence
}

foreach ($Definition in $Definitions) {
    $Name = [string]$Definition.Name
    $Port = [int]$Definition.Port
    $IsTestOwned = $Definition.ContainsKey("TestOwned") -and [bool]$Definition.TestOwned
    $ManualAllowed = $Definition.ContainsKey("ManualAllowed") -and [bool]$Definition.ManualAllowed
    $RecordName = if ($Definition.ContainsKey("Record")) { [string]$Definition.Record } else { "" }
    $RecordPath = if ($RecordName) { Join-Path $RuntimeRoot "$RecordName.json" } else { "" }
    $Record = $null
    $RecordError = ""
    if ($RecordPath -and (Test-Path -LiteralPath $RecordPath -PathType Leaf)) {
        try {
            $RecordJson = Get-Content -LiteralPath $RecordPath -Raw
            $RecordRoot = $RecordJson.TrimStart().TrimStart([char]0xFEFF).TrimStart()
            if (-not $RecordRoot.StartsWith("{", [System.StringComparison]::Ordinal)) {
                throw "managed record must be one JSON object"
            }
            $ParsedRecord = $RecordJson | ConvertFrom-Json
            if (-not ($ParsedRecord -is [pscustomobject])) {
                throw "managed record must be one JSON object"
            }
            $ParsedFields = @($ParsedRecord.PSObject.Properties.Name)
            if ($ParsedFields -notcontains "schema_version" -and
                $ParsedFields -notcontains "processes") {
                foreach ($LegacyField in @("process_id", "executable")) {
                    if ($ParsedFields -notcontains $LegacyField -or
                        [string]::IsNullOrWhiteSpace([string]$ParsedRecord.$LegacyField)) {
                        throw "legacy managed record is missing $LegacyField"
                    }
                }
                if ([int]$ParsedRecord.process_id -le 0) {
                    throw "legacy managed record has an invalid process_id"
                }
            }
            $Record = $ParsedRecord
        } catch {
            $RecordError = $_.Exception.Message
            $Record = $null
        }
    }

    $Listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    $Owners = @($Listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    $RecordedStudioPid = 0
    $RecordedDaemonPid = 0
    $ManagedProcessesValid = $true
    $ManagedRecordShapeValid = $true
    $ManagedProcessDetail = ""
    if ($Record) {
        $HasProcessesProperty = $Record.PSObject.Properties.Name -contains "processes"
        $HasProcessArray = $HasProcessesProperty -and
            @($Record.processes).Count -gt 0
        $HasSchemaVersion = $Record.PSObject.Properties.Name -contains "schema_version"
        if ($HasProcessesProperty -or $HasSchemaVersion) {
            try {
                if (-not $HasSchemaVersion -or [int]$Record.schema_version -ne 2 -or -not $HasProcessArray) {
                    throw "incomplete schema"
                }
                foreach ($RequiredField in @("launch_id", "state", "artifact_sha256", "executable")) {
                    if (-not ($Record.PSObject.Properties.Name -contains $RequiredField) -or
                        [string]::IsNullOrWhiteSpace([string]$Record.$RequiredField)) {
                        throw "missing $RequiredField"
                    }
                }
                if ([string]$Record.artifact_sha256 -notmatch '^[0-9A-Fa-f]{64}$') {
                    throw "invalid artifact hash"
                }
                foreach ($SchemaProcess in @($Record.processes)) {
                    if (-not ($SchemaProcess.PSObject.Properties.Name -contains "creation_time_utc") -or
                        [string]::IsNullOrWhiteSpace([string]$SchemaProcess.creation_time_utc)) {
                        throw "missing process creation time"
                    }
                }
                if ($Name -eq "real") {
                    $SchemaStudios = @($Record.processes | Where-Object { [string]$_.role -eq "studio" })
                    $SchemaDaemons = @($Record.processes | Where-Object { [string]$_.role -eq "daemon" })
                    $SchemaState = [string]$Record.state
                    $ValidStarting = $SchemaState -eq "starting" -and
                        $SchemaDaemons.Count -eq 1 -and $SchemaStudios.Count -le 1 -and
                        @($Record.processes).Count -eq (1 + $SchemaStudios.Count)
                    $ValidReady = $SchemaState -eq "ready" -and
                        $SchemaDaemons.Count -eq 1 -and $SchemaStudios.Count -eq 1 -and
                        @($Record.processes).Count -eq 2
                    if (-not $ValidStarting -and -not $ValidReady) {
                        throw "invalid real roles"
                    }
                } else {
                    $SchemaStudios = @($Record.processes | Where-Object { [string]$_.role -eq "studio" })
                    $SchemaDaemons = @($Record.processes | Where-Object { [string]$_.role -eq "daemon" })
                    if ($SchemaStudios.Count -ne 1 -or $SchemaDaemons.Count -ne 0 -or
                        @($Record.processes).Count -ne 1 -or
                        [string]$Record.state -notin @("starting", "ready")) {
                        throw "invalid fixture roles"
                    }
                }
            } catch {
                $ManagedRecordShapeValid = $false
                $ManagedProcessesValid = $false
                $ManagedProcessDetail = "invalid schema-2 record"
            }
        }
        $RecordedProcesses = if (-not $ManagedRecordShapeValid) {
            @()
        } elseif ($HasProcessArray) {
            @($Record.processes)
        } else {
            @([pscustomobject]@{
                role = "studio"
                process_id = $Record.process_id
                executable = $Record.executable
            })
        }
        if ($ManagedRecordShapeValid) {
            $StudioRecords = @($RecordedProcesses | Where-Object { [string]$_.role -eq "studio" })
            $DaemonRecords = @($RecordedProcesses | Where-Object { [string]$_.role -eq "daemon" })
            if ($StudioRecords.Count -eq 1) { $RecordedStudioPid = [int]$StudioRecords[0].process_id }
            if ($DaemonRecords.Count -eq 1) { $RecordedDaemonPid = [int]$DaemonRecords[0].process_id }
            if ($StudioRecords.Count -ne 1 -or ($Name -eq "real" -and $DaemonRecords.Count -ne 1)) {
                $ManagedProcessesValid = $false
                $ManagedProcessDetail = "record roles"
            }
            if (($Record.PSObject.Properties.Name -contains "artifact_sha256") -and
                -not [string]::IsNullOrWhiteSpace([string]$Record.artifact_sha256)) {
                try {
                    if (-not (Test-Path -LiteralPath ([string]$Record.executable) -PathType Leaf) -or
                        (Get-FileHash -Algorithm SHA256 -LiteralPath ([string]$Record.executable)).Hash -ne [string]$Record.artifact_sha256) {
                        $ManagedProcessesValid = $false
                        $ManagedProcessDetail = "artifact mismatch"
                    }
                } catch {
                    $ManagedProcessesValid = $false
                    $ManagedProcessDetail = "artifact unreadable"
                }
            }
            foreach ($RecordedProcess in $RecordedProcesses) {
                try {
                    $ManagedPid = [int]$RecordedProcess.process_id
                    $ExpectedExe = [System.IO.Path]::GetFullPath([string]$RecordedProcess.executable)
                    if ($HasProcessArray -and
                        -not $ExpectedExe.Equals(
                            [System.IO.Path]::GetFullPath([string]$Record.executable),
                            [System.StringComparison]::OrdinalIgnoreCase
                        )) {
                        $ManagedProcessesValid = $false
                        $ManagedProcessDetail = "mixed artifacts"
                    }
                    $LiveProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $ManagedPid" -ErrorAction SilentlyContinue
                    if (-not $LiveProcess) {
                        $ManagedProcessesValid = $false
                        $ManagedProcessDetail = "$([string]$RecordedProcess.role) stopped"
                        continue
                    }
                    $ActualExe = [System.IO.Path]::GetFullPath([string]$LiveProcess.ExecutablePath)
                    if (-not $ActualExe.Equals($ExpectedExe, [System.StringComparison]::OrdinalIgnoreCase)) {
                        $ManagedProcessesValid = $false
                        $ManagedProcessDetail = "$([string]$RecordedProcess.role) PID reused"
                    }
                    if ($RecordedProcess.PSObject.Properties.Name -contains "creation_time_utc") {
                        $ActualCreation = ([datetime]$LiveProcess.CreationDate).ToUniversalTime()
                        $ExpectedCreation = ([datetime]$RecordedProcess.creation_time_utc).ToUniversalTime()
                        # CIM reports microseconds while the managed record can
                        # retain the underlying 100 ns FILETIME. The same
                        # sub-microsecond tolerance used by teardown cannot
                        # mistake a genuinely recycled Windows PID for this
                        # process generation.
                        if ([Math]::Abs(($ActualCreation - $ExpectedCreation).Ticks) -gt 9) {
                            $ManagedProcessesValid = $false
                            $ManagedProcessDetail = "$([string]$RecordedProcess.role) PID reused"
                        }
                    }
                } catch {
                    $ManagedProcessesValid = $false
                    $ManagedProcessDetail = "invalid process record"
                }
            }
        }
        if (-not $ManagedRecordShapeValid) {
            $RecordError = $ManagedProcessDetail
            $Record = $null
        }
    }
    $ManagedOwner = $false
    if ($Record -and $Owners.Count -gt 0) {
        $ManagedOwner = $RecordedStudioPid -gt 0 -and $Owners -contains $RecordedStudioPid
    }

    $Provenance = "not queried"
    $ProvenanceValid = $false
    $DaemonReachable = $false
    if ($Owners.Count -gt 0) {
        try {
            $Response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 1
            $Payload = $Response.Content | ConvertFrom-Json
            $ActualId = [string]$Payload.environment.id
            $ActualFixture = [bool]$Payload.environment.fixture
            $ActualGeneration = [string]$Payload.environment.generation
            # Keep this terminal report ASCII-stable under Windows PowerShell
            # 5.1, whose Invoke-WebRequest decoder can mojibake the banner's
            # middle dot even though browsers correctly treat JSON as UTF-8.
            $Provenance = if ($ActualGeneration) {
                "$ActualId / $ActualGeneration"
            } else {
                $ActualId
            }
            $ProvenanceValid = $Response.StatusCode -eq 200 -and
                $ActualId -eq [string]$Definition.Id -and
                $ActualFixture -eq [bool]$Definition.Fixture
            if ($ProvenanceValid -and [bool]$Definition.Fixture) {
                $ProvenanceValid = -not [string]::IsNullOrWhiteSpace($ActualGeneration)
            }
            if ($ProvenanceValid -and -not [bool]$Definition.Fixture) {
                $ProvenanceValid = [string]::IsNullOrEmpty($ActualGeneration)
            }
            if ($ProvenanceValid -and $Record -and [bool]$Definition.Fixture) {
                $ExpectedGeneration = if ($Record.PSObject.Properties.Name -contains "generation") {
                    [string]$Record.generation
                } else {
                    "pid-$($Record.process_id)"
                }
                $ProvenanceValid = $ActualGeneration -eq $ExpectedGeneration
            }
            if (-not [bool]$Definition.Fixture) {
                $DaemonReachable = [bool]$Payload.staged.reachable
            }
        } catch {
            $Provenance = "unavailable: $($_.Exception.Message)"
        }
    }

    $DaemonPipesValid = $false
    $ControlServerPid = [uint32]0
    $LiveServerPid = [uint32]0
    $DaemonPipePresenceUnverified = $false
    $ManualPairVerified = $false
    if ($Name -eq "real") {
        try {
            $ControlServerPid = Get-KsxPipeServerProcessId -PipeName "ksx-daemon" -TimeoutMilliseconds 250
            $LiveServerPid = Get-KsxPipeServerProcessId -PipeName "ksx-live" -ReadOnly -TimeoutMilliseconds 250
            # A zero means identity was not obtained; it is not proof of
            # absence. If the named endpoint still exists, report an
            # unverified daemon instead of authorizing a portable transition.
            $DaemonPipePresenceUnverified =
                ([int]$ControlServerPid -eq 0 -and (Test-Path -LiteralPath "\\.\pipe\ksx-daemon")) -or
                ([int]$LiveServerPid -eq 0 -and (Test-Path -LiteralPath "\\.\pipe\ksx-live"))
            $DaemonPipesValid = if ($RecordedDaemonPid -gt 0) {
                [int]$ControlServerPid -eq $RecordedDaemonPid -and
                    [int]$LiveServerPid -eq $RecordedDaemonPid
            } else {
                [int]$ControlServerPid -gt 0 -and [int]$ControlServerPid -eq [int]$LiveServerPid
            }
            $Provenance = "$Provenance / " + $(if ($DaemonPipesValid -and $DaemonReachable) { "daemon-ready" } else { "daemon-down" })
        } catch {
            $DaemonPipePresenceUnverified = $true
            $Provenance = "$Provenance / daemon-unverified"
        }
        if (-not $Record -and $Owners.Count -eq 1 -and $DaemonPipesValid) {
            try {
                $StudioProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$Owners[0])" -ErrorAction Stop
                $DaemonProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$ControlServerPid)" -ErrorAction Stop
                $StudioExe = [System.IO.Path]::GetFullPath([string]$StudioProcess.ExecutablePath)
                $DaemonExe = [System.IO.Path]::GetFullPath([string]$DaemonProcess.ExecutablePath)
                $ManualPairVerified = $StudioExe.Equals($DaemonExe, [System.StringComparison]::OrdinalIgnoreCase) -and
                    (Get-FileHash -Algorithm SHA256 -LiteralPath $StudioExe).Hash -eq
                        (Get-FileHash -Algorithm SHA256 -LiteralPath $DaemonExe).Hash
            } catch {
                $ManualPairVerified = $false
            }
        }
        if ($Record -and ($Record.PSObject.Properties.Name -contains "artifact_sha256")) {
            $ArtifactIdentity = [string]$Record.artifact_sha256
            if ($ArtifactIdentity.Length -gt 12) { $ArtifactIdentity = $ArtifactIdentity.Substring(0, 12) }
            $Provenance = "$Provenance / $ArtifactIdentity"
            if ($Record.PSObject.Properties.Name -contains "source_revision") {
                $Provenance = "$Provenance / $([string]$Record.source_revision)"
            }
        }
    }

    $State = if ($RecordError) {
        "invalid record"
    } elseif ($Name -eq "real" -and $Record -and -not $ManagedRecordShapeValid) {
        "managed / invalid schema-2 record"
    } elseif ($Record -and
        ($Record.PSObject.Properties.Name -contains "state") -and [string]$Record.state -ne "ready") {
        "managed / incomplete start"
    } elseif ($Record -and -not $ManagedProcessesValid) {
        "managed / $ManagedProcessDetail"
    } elseif ($Name -eq "real" -and -not $Record -and $Owners.Count -eq 0 -and
        ([int]$ControlServerPid -gt 0 -or [int]$LiveServerPid -gt 0)) {
        "unmanaged daemon / no Studio"
    } elseif ($Name -eq "real" -and -not $Record -and $Owners.Count -eq 0 -and
        $DaemonPipePresenceUnverified) {
        "unmanaged daemon / unverified"
    } elseif ($Owners.Count -eq 0 -and $Record) {
        "stale record"
    } elseif ($Owners.Count -eq 0) {
        "stopped"
    } elseif ($Name -eq "real" -and $ManagedOwner -and $Owners.Count -eq 1 -and
        $ProvenanceValid -and $DaemonReachable -and $DaemonPipesValid) {
        "managed / running"
    } elseif ($Name -eq "real" -and $ManagedOwner -and $ProvenanceValid) {
        "managed / daemon unavailable"
    } elseif ($ManagedOwner -and $Owners.Count -eq 1 -and $ProvenanceValid) {
        "managed / running"
    } elseif ($ManagedOwner) {
        "managed / provenance mismatch"
    } elseif ($IsTestOwned -and $ProvenanceValid) {
        "test-owned / running"
    } elseif ($ManualAllowed -and -not $Record -and $ProvenanceValid -and
        $DaemonReachable -and $DaemonPipesValid -and $ManualPairVerified) {
        "manual live / running"
    } elseif ($ManualAllowed -and -not $Record -and $ProvenanceValid) {
        "manual live / mixed or unverified pair"
    } else {
        "unmanaged listener"
    }

    $Healthy = $State -in @(
        "managed / running",
        "manual live / running",
        "test-owned / running"
    )
    $ProvenanceComplete = $false
    $Current = $false
    $CurrentDetail = "this process has no managed source/asset identity receipt"
    if ($Record) {
        $IdentityFields = @(
            "source_graph_sha256",
            "studio_input_sha256",
            "zone_producer_sha256",
            "asset_graph_sha256"
        )
        $ProvenanceComplete = @(
            $IdentityFields | Where-Object {
                -not ($Record.PSObject.Properties.Name -contains $_) -or
                [string]$Record.$_ -notmatch '^[0-9A-Fa-f]{64}$'
            }
        ).Count -eq 0

        if (-not $ProvenanceComplete) {
            $CurrentDetail = "managed receipt predates or is missing exact source/asset identities"
        } elseif (-not $Healthy -or $State -ne "managed / running") {
            $CurrentDetail = "the exact managed artifact is not healthy and running"
        } elseif ($SkipCurrentVerification) {
            $CurrentDetail = "exact current-source verification skipped for this lightweight health probe"
        } else {
            $BuildEvidence = Get-KsxStatusBuildGraphEvidence
            if (-not [bool]$BuildEvidence.Available) {
                $CurrentDetail = "current build graph could not be verified: $([string]$BuildEvidence.Detail)"
            } elseif ([string]$Record.studio_input_sha256 -ine [string]$BuildEvidence.Studio) {
                $CurrentDetail = "Studio authoring inputs changed after this artifact was built"
            } elseif ([string]$Record.asset_graph_sha256 -ine [string]$BuildEvidence.Assets) {
                $CurrentDetail = "generated Studio assets changed after this artifact was built"
            } elseif ([string]$Record.zone_producer_sha256 -ine [string]$BuildEvidence.ZoneProducers) {
                $CurrentDetail = "Rust zone-vocabulary producer inputs changed after this artifact was built"
            } elseif ([string]$Record.source_graph_sha256 -ine [string]$BuildEvidence.Runtime) {
                $CurrentDetail = "runtime source changed after this artifact was built"
            } else {
                $Current = $true
                $CurrentDetail = "running artifact matches the verified current source and asset graph"
            }
        }
    }
    $Watch = "not running"
    $WatchPath = Join-Path $RuntimeRoot "watch-$Name.json"
    if (Test-Path -LiteralPath $WatchPath -PathType Leaf) {
        try {
            $WatchRecord = Get-Content -LiteralPath $WatchPath -Raw | ConvertFrom-Json
            $WatchState = [string]$WatchRecord.state
            if ($WatchState -eq "stopped") {
                $Watch = "stopped"
            } else {
                $WatchProcess = Get-CimInstance Win32_Process `
                    -Filter "ProcessId = $([int]$WatchRecord.process_id)" `
                    -ErrorAction SilentlyContinue
                $WatchIdentityMatches = $false
                if ($WatchProcess -and
                    ($WatchRecord.PSObject.Properties.Name -contains "process_creation_time_utc")) {
                    $ActualWatchCreation = ([datetime]$WatchProcess.CreationDate).ToUniversalTime()
                    $ExpectedWatchCreation = ([datetime]$WatchRecord.process_creation_time_utc).ToUniversalTime()
                    $WatchIdentityMatches = [Math]::Abs(
                        ($ActualWatchCreation - $ExpectedWatchCreation).Ticks
                    ) -le 9
                }
                $Watch = if ($WatchIdentityMatches) { $WatchState } else { "stale / $WatchState" }
            }
        } catch {
            $Watch = "invalid record"
        }
    }
    $Rows += [pscustomobject]@{
        Environment = $Name
        Port = $Port
        State = $State
        Healthy = $Healthy
        Current = $Current
        ProvenanceComplete = $ProvenanceComplete
        CurrentDetail = $CurrentDetail
        PID = if ($Name -eq "real" -and $Record) {
            "studio=$RecordedStudioPid daemon=$RecordedDaemonPid"
        } elseif ($Name -eq "real" -and $Owners.Count -gt 0 -and [int]$ControlServerPid -gt 0) {
            "studio=$($Owners -join ',') daemon=$ControlServerPid"
        } elseif ($Name -eq "real" -and [int]$ControlServerPid -gt 0) {
            "daemon=$ControlServerPid"
        } elseif ($Owners.Count -gt 0) { $Owners -join "," } else { "" }
        Provenance = $Provenance
        Watch = $Watch
        URL = "http://127.0.0.1:$Port/redesign"
    }
}

if ($Json) {
    ConvertTo-Json -InputObject ([object[]]$Rows) -Depth 4
} else {
    $Rows |
        Select-Object Environment, Port, State, Current, ProvenanceComplete, Watch, PID, Provenance, URL |
        Format-Table -AutoSize
}

if ($RequireHealthy) {
    $Unhealthy = @($Rows | Where-Object { -not $_.Healthy })
    if ($Unhealthy.Count -gt 0) {
        $FailedNames = @($Unhealthy | ForEach-Object { "$($_.Environment) [$($_.State)]" }) -join ", "
        throw "Studio environment health gate failed: $FailedNames."
    }
}

if ($RequireCurrent) {
    $NotCurrent = @($Rows | Where-Object { -not $_.Current })
    if ($NotCurrent.Count -gt 0) {
        $FailedRows = @(
            $NotCurrent | ForEach-Object {
                "$($_.Environment) [$($_.CurrentDetail)]"
            }
        ) -join ", "
        throw "Studio environment current-artifact gate failed: $FailedRows."
    }
}
