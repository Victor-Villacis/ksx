[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-probe.ps1")

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
    @{ Name = "blank-encoder"; Port = 4521; Id = "fixture-blank-encoder"; Fixture = $true; Record = "blank-encoder" }
)
$Rows = @()

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
            $Record = Get-Content -LiteralPath $RecordPath -Raw | ConvertFrom-Json
        } catch {
            $RecordError = $_.Exception.Message
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
        $HasProcessArray = ($Record.PSObject.Properties.Name -contains "processes") -and
            @($Record.processes).Count -gt 0
        $HasSchemaVersion = $Record.PSObject.Properties.Name -contains "schema_version"
        if ($HasProcessArray -or $HasSchemaVersion) {
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
                    if ($Name -eq "real" -and $HasProcessArray -and
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
            $Response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/nocturne" -TimeoutSec 1
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
    } elseif ($Name -eq "real" -and $Record -and
        ($Record.PSObject.Properties.Name -contains "state") -and [string]$Record.state -ne "ready") {
        "managed / incomplete start"
    } elseif ($Name -eq "real" -and $Record -and -not $ManagedProcessesValid) {
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

    $Rows += [pscustomobject]@{
        Environment = $Name
        Port = $Port
        State = $State
        PID = if ($Name -eq "real" -and $Record) {
            "studio=$RecordedStudioPid daemon=$RecordedDaemonPid"
        } elseif ($Name -eq "real" -and $Owners.Count -gt 0 -and [int]$ControlServerPid -gt 0) {
            "studio=$($Owners -join ',') daemon=$ControlServerPid"
        } elseif ($Name -eq "real" -and [int]$ControlServerPid -gt 0) {
            "daemon=$ControlServerPid"
        } elseif ($Owners.Count -gt 0) { $Owners -join "," } else { "" }
        Provenance = $Provenance
        URL = "http://127.0.0.1:$Port/nocturne"
    }
}

$Rows | Format-Table -AutoSize
