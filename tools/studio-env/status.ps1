[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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
    $ManagedOwner = $false
    if ($Record -and $Owners.Count -gt 0) {
        $ManagedOwner = $Owners -contains [int]$Record.process_id
    }

    $Provenance = "not queried"
    $ProvenanceValid = $false
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
        } catch {
            $Provenance = "unavailable: $($_.Exception.Message)"
        }
    }

    $State = if ($RecordError) {
        "invalid record"
    } elseif ($Owners.Count -eq 0 -and $Record) {
        "stale record"
    } elseif ($Owners.Count -eq 0) {
        "stopped"
    } elseif ($ManagedOwner -and $Owners.Count -eq 1 -and $ProvenanceValid) {
        "managed / running"
    } elseif ($ManagedOwner) {
        "managed / provenance mismatch"
    } elseif ($IsTestOwned -and $ProvenanceValid) {
        "test-owned / running"
    } elseif ($ManualAllowed -and -not $Record -and $ProvenanceValid) {
        "manual live / running"
    } else {
        "unmanaged listener"
    }

    $Rows += [pscustomobject]@{
        Environment = $Name
        Port = $Port
        State = $State
        PID = if ($Owners.Count -gt 0) { $Owners -join "," } else { "" }
        Provenance = $Provenance
        URL = "http://127.0.0.1:$Port/nocturne"
    }
}

$Rows | Format-Table -AutoSize
