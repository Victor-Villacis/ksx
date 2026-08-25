[CmdletBinding()]
param(
    [ValidateSet("real", "seeded", "first-run", "blank-encoder")]
    [string]$Environment = "real",

    [ValidateRange(250, 10000)]
    [int]$DebounceMilliseconds = 900,

    [ValidateRange(1, 60)]
    [int]$ReconcileSeconds = 30,

    [switch]$Once,

    [switch]$NoInitialRefresh
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "source-graph.ps1")
. (Join-Path $PSScriptRoot "build-graph.ps1")

if ($Once -and $NoInitialRefresh) {
    throw "-Once and -NoInitialRefresh cannot be combined: that command would verify or refresh nothing."
}

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$RuntimeRoot = Join-Path $RepoRoot "tmp\studio-env"
$StatePath = Join-Path $RuntimeRoot "watch-$Environment.json"
$WatcherImplementationPaths = @(
    (Join-Path $PSScriptRoot "watch.ps1"),
    (Join-Path $PSScriptRoot "source-graph.ps1"),
    (Join-Path $PSScriptRoot "build-graph.ps1")
)
$WatcherMutex = $null
$WatcherLockHeld = $false
$SourceWatcher = $null
$LastAppliedStudio = ""
$LastAppliedZoneProducers = ""
$LastAppliedRuntime = ""
$LastObservedMetadata = ""
$Pending = $false
$PendingBecauseDeferred = $false
$PendingReason = "source-change"
$LastFailedStudio = ""
$LastFailedZoneProducers = ""
$LastFailedRuntime = ""
$LastChangeAt = [datetime]::UtcNow
$LastAttemptAt = [datetime]::MinValue
$LastObservationWarningAt = [datetime]::MinValue
$ExitState = "stopped"
$ExitMessage = "watcher exited; served environment was left running"
$WatcherStartedAt = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString("o")

New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null

function Get-KsxWatcherImplementationFingerprint {
    return (@($WatcherImplementationPaths | Sort-Object | ForEach-Object {
        "$($_)=$((Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash)"
    }) -join "|")
}

$WatcherImplementationFingerprint = Get-KsxWatcherImplementationFingerprint

function Write-KsxWatchState {
    param(
        [Parameter(Mandatory = $true)][string]$State,
        [string]$Message = "",
        [string]$StudioFingerprint = $LastAppliedStudio,
        [string]$RuntimeFingerprint = $LastAppliedRuntime
    )

    $Record = [ordered]@{
        schema_version = 1
        environment = $Environment
        process_id = $PID
        process_creation_time_utc = $WatcherStartedAt
        state = $State
        message = $Message
        studio_input_sha256 = $StudioFingerprint
        source_graph_sha256 = $RuntimeFingerprint
        updated_at = (Get-Date).ToUniversalTime().ToString("o")
    }
    $Temporary = "$StatePath.$PID.tmp"
    try {
        $Record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $Temporary -Encoding utf8
        Move-Item -LiteralPath $Temporary -Destination $StatePath -Force
    } finally {
        Remove-Item -LiteralPath $Temporary -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-KsxEnvironmentRefresh {
    param(
        [Parameter(Mandatory = $true)][bool]$StudioChanged,
        [Parameter(Mandatory = $true)][string]$Reason,
        [Parameter(Mandatory = $true)][string]$StudioFingerprint,
        [Parameter(Mandatory = $true)][string]$RuntimeFingerprint
    )

    if ($StudioChanged) {
        Write-KsxWatchState `
            -State "building-assets" `
            -Message $Reason `
            -StudioFingerprint $StudioFingerprint `
            -RuntimeFingerprint $RuntimeFingerprint
        & (Join-Path $PSScriptRoot "build-assets.ps1")
    }

    Write-KsxWatchState `
        -State "building-runtime" `
        -Message $Reason `
        -StudioFingerprint $StudioFingerprint `
        -RuntimeFingerprint $RuntimeFingerprint

    if ($Environment -eq "real") {
        & (Join-Path $PSScriptRoot "start-real.ps1") -LaunchReason "watch:$Reason"
    } else {
        & (Join-Path $PSScriptRoot "seed.ps1") -Environment $Environment
    }

    & (Join-Path $PSScriptRoot "status.ps1") `
        -Environment $Environment `
        -RequireHealthy `
        -RequireCurrent | Out-Host
}

function Get-KsxAppliedFingerprints {
    $AssetStatePath = Join-Path $RuntimeRoot "assets-state.json"
    $RuntimeStatePath = Join-Path $RuntimeRoot "$Environment.json"
    if (-not (Test-Path -LiteralPath $AssetStatePath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $RuntimeStatePath -PathType Leaf)) {
        throw "A healthy refresh did not leave both asset and runtime identity receipts."
    }
    $AssetState = Get-Content -LiteralPath $AssetStatePath -Raw | ConvertFrom-Json
    $RuntimeState = Get-Content -LiteralPath $RuntimeStatePath -Raw | ConvertFrom-Json
    $StudioHash = [string]$RuntimeState.studio_input_sha256
    $ZoneProducerHash = [string]$RuntimeState.zone_producer_sha256
    $RuntimeHash = [string]$RuntimeState.source_graph_sha256
    $AssetHash = [string]$RuntimeState.asset_graph_sha256
    if ($StudioHash -notmatch '^[0-9A-Fa-f]{64}$' -or
        $ZoneProducerHash -notmatch '^[0-9A-Fa-f]{64}$' -or
        $RuntimeHash -notmatch '^[0-9A-Fa-f]{64}$' -or
        $AssetHash -notmatch '^[0-9A-Fa-f]{64}$' -or
        [string]$AssetState.studio_input_sha256 -ine $StudioHash -or
        [string]$AssetState.zone_producer_sha256 -ine $ZoneProducerHash -or
        [string]$AssetState.asset_graph_sha256 -ine $AssetHash) {
        throw "A healthy refresh left an incomplete source/asset identity receipt."
    }
    [pscustomobject]@{
        Studio = $StudioHash
        ZoneProducers = $ZoneProducerHash
        Runtime = $RuntimeHash
        Assets = $AssetHash
    }
}

function Get-KsxSourceObservation {
    param([switch]$MetadataOnly)

    $LastError = $null
    for ($Attempt = 0; $Attempt -lt 5; $Attempt += 1) {
        try {
            if ($MetadataOnly) {
                return [pscustomobject]@{
                    Metadata = Get-KsxSourceGraphFingerprint `
                        -Kind All `
                        -RepoRoot $RepoRoot `
                        -MetadataOnly
                }
            }
            return [pscustomobject]@{
                Metadata = Get-KsxSourceGraphFingerprint `
                    -Kind All `
                    -RepoRoot $RepoRoot `
                    -MetadataOnly
                Studio = Get-KsxSourceGraphFingerprint -Kind Studio -RepoRoot $RepoRoot
                ZoneProducers = Get-KsxSourceGraphFingerprint -Kind ZoneProducers -RepoRoot $RepoRoot
                Runtime = Get-KsxSourceGraphFingerprint -Kind Runtime -RepoRoot $RepoRoot
            }
        } catch {
            $LastError = $_
            Start-Sleep -Milliseconds 125
        }
    }
    throw "source observation remained unavailable after five attempts: $($LastError.Exception.Message)"
}

function Get-KsxEnvironmentStatusRow {
    param([switch]$Lightweight)

    $StatusParameters = @{
        Environment = $Environment
        Json = $true
    }
    if ($Lightweight) {
        $StatusParameters.SkipCurrentVerification = $true
    }
    $Rows = @(
        & (Join-Path $PSScriptRoot "status.ps1") @StatusParameters |
            ConvertFrom-Json
    )
    if ($Rows.Count -ne 1) {
        throw "status returned $($Rows.Count) rows for '$Environment' instead of one"
    }
    return $Rows[0]
}

function Test-KsxPotentialSourceEvent {
    param([Parameter(Mandatory = $true)]$Change)

    if ([bool]$Change.TimedOut) { return $false }
    $Relative = ([string]$Change.Name -replace '\\', '/').TrimStart('/').ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($Relative)) { return $true }
    foreach ($IgnoredPrefix in @('.git/', 'target/', 'tmp/', 'studio-ui/node_modules/')) {
        if ($Relative.StartsWith($IgnoredPrefix, [System.StringComparison]::Ordinal)) {
            return $false
        }
    }
    return $true
}

function Test-KsxWatcherRestartRequired {
    $CurrentFingerprint = Get-KsxWatcherImplementationFingerprint
    if ($CurrentFingerprint -ceq $WatcherImplementationFingerprint) {
        return $false
    }
    $script:ExitState = "restart-required"
    $script:ExitMessage = "watch/source-graph/build-graph changed; restart the watcher so one implementation owns the next build"
    Write-Warning "$ExitMessage. The last healthy environment remains running."
    if ($Once) {
        throw "$ExitMessage. Run the one-shot command again."
    }
    return $true
}

function Sync-KsxObservedMetadata {
    try {
        $Observation = Get-KsxSourceObservation
        $script:LastObservedMetadata = [string]$Observation.Metadata
    } catch {
        # Full reconciliation remains the authoritative fallback if an editor
        # is still replacing a file while this best-effort baseline is read.
    }
}

function Test-KsxCurrentAssetGraph {
    param(
        [Parameter(Mandatory = $true)][string]$StudioFingerprint,
        [Parameter(Mandatory = $true)][string]$ZoneProducerFingerprint
    )

    try {
        $null = Assert-KsxStudioAssetGraphReady `
            -RepoRoot $RepoRoot `
            -ExpectedStudioInputSha256 $StudioFingerprint `
            -ExpectedZoneProducerSha256 $ZoneProducerFingerprint
        return $true
    } catch {
        return $false
    }
}

function Test-KsxDeferredFailure {
    param([Parameter(Mandatory = $true)][string]$Message)

    return $Message -like "*KSX_WATCH_DEFERRED:*" -or
        $Message -like "*already using the Studio build graph*" -or
        $Message -like "*already building or swapping*" -or
        $Message -like "*transition lock is owned by another Windows identity*" -or
        $Message -like "*build-graph lock is owned by another Windows identity*"
}

function Test-KsxSourceChangedFailure {
    param([Parameter(Mandatory = $true)][string]$Message)

    return $Message -like "*changed while*" -or
        $Message -like "*sources changed while*" -or
        $Message -like "*changed while assets were being compiled*" -or
        $Message -like "*changed while dependencies were being prepared*" -or
        $Message -like "*retry after the source graph settles*" -or
        $Message -like "*against one stable source revision*"
}

function Get-KsxPostFailureObservation {
    param(
        [Parameter(Mandatory = $true)][string]$AttemptedStudio,
        [Parameter(Mandatory = $true)][string]$AttemptedZoneProducers,
        [Parameter(Mandatory = $true)][string]$AttemptedRuntime
    )

    try {
        $AfterFailure = Get-KsxSourceObservation
        $script:LastObservedMetadata = [string]$AfterFailure.Metadata
        return [pscustomobject]@{
            Available = $true
            Changed = [string]$AfterFailure.Studio -cne $AttemptedStudio -or
                [string]$AfterFailure.ZoneProducers -cne $AttemptedZoneProducers -or
                [string]$AfterFailure.Runtime -cne $AttemptedRuntime
            Detail = ""
        }
    } catch {
        return [pscustomobject]@{
            Available = $false
            Changed = $true
            Detail = $_.Exception.Message
        }
    }
}

function Set-KsxFailedGraph {
    param(
        [Parameter(Mandatory = $true)][string]$Studio,
        [Parameter(Mandatory = $true)][string]$ZoneProducers,
        [Parameter(Mandatory = $true)][string]$Runtime
    )

    # Call only after a post-failure observation proves the attempted graph is
    # still current. A graph which arrived during the failed build has never
    # been tested and therefore must never be cached as failed.
    $script:LastFailedStudio = $Studio
    $script:LastFailedZoneProducers = $ZoneProducers
    $script:LastFailedRuntime = $Runtime
}

try {
    try {
        $WatcherMutex = [System.Threading.Mutex]::new(
            $false,
            "Global\KSXStudioEnvironment-$Environment-watch-v1"
        )
    } catch [System.UnauthorizedAccessException] {
        throw "The machine-wide '$Environment' watch lock belongs to another Windows identity."
    }
    try {
        $WatcherLockHeld = $WatcherMutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
        $WatcherLockHeld = $true
    }
    if (-not $WatcherLockHeld) {
        throw "Another watcher already owns '$Environment'. Use status.ps1 before starting a second development loop."
    }

    # An event-driven wait keeps an idle watcher asleep. The periodic full
    # reconciliation remains the correctness backstop for buffer overflow,
    # atomic-save rename patterns, process crashes, and manual asset changes.
    $SourceWatcher = [System.IO.FileSystemWatcher]::new($RepoRoot)
    $SourceWatcher.IncludeSubdirectories = $true
    $SourceWatcher.Filter = "*"
    $SourceWatcher.NotifyFilter = [System.IO.NotifyFilters]::FileName -bor
        [System.IO.NotifyFilters]::DirectoryName -bor
        [System.IO.NotifyFilters]::LastWrite -bor
        [System.IO.NotifyFilters]::Size
    $SourceWatcher.EnableRaisingEvents = $true

    $InitialObservation = Get-KsxSourceObservation
    $CurrentStudio = [string]$InitialObservation.Studio
    $CurrentZoneProducers = [string]$InitialObservation.ZoneProducers
    $CurrentRuntime = [string]$InitialObservation.Runtime
    $LastObservedMetadata = [string]$InitialObservation.Metadata
    try {
        $ExistingApplied = Get-KsxAppliedFingerprints
        $LastAppliedStudio = [string]$ExistingApplied.Studio
        $LastAppliedZoneProducers = [string]$ExistingApplied.ZoneProducers
        $LastAppliedRuntime = [string]$ExistingApplied.Runtime
    } catch {
        # A stopped or pre-provenance environment has no applied graph. Empty
        # identities make the first reconcile repair it rather than silently
        # blessing the source bytes merely because they exist on disk.
        $LastAppliedStudio = ""
        $LastAppliedZoneProducers = ""
        $LastAppliedRuntime = ""
    }

    Write-Host "Watching '$Environment' from $RepoRoot"
    Write-Host "Quiet debounce: $DebounceMilliseconds ms; full reconciliation: $ReconcileSeconds s."
    Write-Host "Ctrl+C stops the watcher and leaves the last healthy process running."

    if (-not $NoInitialRefresh) {
        try {
            Invoke-KsxEnvironmentRefresh `
                -StudioChanged $true `
                -Reason "initial" `
                -StudioFingerprint $CurrentStudio `
                -RuntimeFingerprint $CurrentRuntime
            $Applied = Get-KsxAppliedFingerprints
            $LastAppliedStudio = $Applied.Studio
            $LastAppliedZoneProducers = $Applied.ZoneProducers
            $LastAppliedRuntime = $Applied.Runtime
            $AfterInitial = Get-KsxSourceObservation
            $LastObservedMetadata = [string]$AfterInitial.Metadata
            $Pending = [string]$AfterInitial.Studio -ne $LastAppliedStudio -or
                [string]$AfterInitial.ZoneProducers -ne $LastAppliedZoneProducers -or
                [string]$AfterInitial.Runtime -ne $LastAppliedRuntime
            $LastFailedStudio = ""
            $LastFailedZoneProducers = ""
            $LastFailedRuntime = ""
            if ($Pending) {
                $LastChangeAt = [datetime]::UtcNow
                $PendingReason = "source-change"
                Write-KsxWatchState -State "debouncing" -Message "an edit arrived during the initial refresh"
            } else {
                Write-KsxWatchState -State "idle" -Message "initial refresh healthy"
            }
        } catch {
            $Message = $_.Exception.Message
            $PostFailure = Get-KsxPostFailureObservation `
                -AttemptedStudio $CurrentStudio `
                -AttemptedZoneProducers $CurrentZoneProducers `
                -AttemptedRuntime $CurrentRuntime
            if (-not [bool]$PostFailure.Available -or [bool]$PostFailure.Changed -or
                (Test-KsxSourceChangedFailure -Message $Message)) {
                $Pending = $true
                $PendingBecauseDeferred = $false
                $PendingReason = "source-change"
                $LastChangeAt = [datetime]::UtcNow
                Write-KsxWatchState -State "debouncing" -Message $Message
            } elseif (Test-KsxDeferredFailure -Message $Message) {
                Sync-KsxObservedMetadata
                Write-KsxWatchState -State "deferred" -Message $Message
                $Pending = $true
                $PendingBecauseDeferred = $true
                $PendingReason = "deferred-retry"
            } else {
                Set-KsxFailedGraph `
                    -Studio $CurrentStudio `
                    -ZoneProducers $CurrentZoneProducers `
                    -Runtime $CurrentRuntime
                Write-KsxWatchState -State "failed" -Message $Message
                if ($Once) {
                    $ExitState = "failed"
                    $ExitMessage = $Message
                    throw
                }
                Write-Warning "Initial refresh failed; the previous healthy environment was preserved where possible. $Message"
            }
        }
    } else {
        $AttachedStatus = Get-KsxEnvironmentStatusRow
        if ([bool]$AttachedStatus.Current) {
            Write-KsxWatchState -State "idle" -Message "attached to a healthy current artifact without replacing it"
        } else {
            $Pending = $true
            $PendingReason = if ([bool]$AttachedStatus.Healthy) {
                "current-recovery"
            } else {
                "health-recovery"
            }
            $LastChangeAt = [datetime]::UtcNow.AddMilliseconds(-$DebounceMilliseconds)
            Write-KsxWatchState `
                -State "debouncing" `
                -Message "the attached environment needs $PendingReason"
        }
    }

    if (Test-KsxWatcherRestartRequired) {
        return
    }

    if ($Once) {
        if ($PendingBecauseDeferred) {
            $ExitState = "deferred"
            $ExitMessage = "the one-shot refresh was deferred because the real-hardware runtime is busy"
            throw "The one-shot refresh was deferred because the real-hardware runtime is busy."
        }
        if ($Pending) {
            $ExitState = "failed"
            $ExitMessage = "source changed during the one-shot refresh"
            throw "Source changed during the one-shot refresh. Run it again so the served artifact includes the final graph."
        }
        return
    }

    $LastReconcileAt = [datetime]::UtcNow
    while ($true) {
        $Change = $SourceWatcher.WaitForChanged(
            [System.IO.WatcherChangeTypes]::All,
            1000
        )
        if (Test-KsxWatcherRestartRequired) {
            return
        }
        $Now = [datetime]::UtcNow
        if (Test-KsxPotentialSourceEvent -Change $Change) {
            try {
                $MetadataObservation = Get-KsxSourceObservation -MetadataOnly
                $Metadata = [string]$MetadataObservation.Metadata
            } catch {
                $ObservationMessage = $_.Exception.Message
                Write-KsxWatchState -State "observation-retry" -Message $ObservationMessage
                if (($Now - $LastObservationWarningAt).TotalSeconds -ge $ReconcileSeconds) {
                    Write-Warning "Source observation is temporarily unavailable; the running environment was left untouched. $ObservationMessage"
                    $LastObservationWarningAt = $Now
                }
                continue
            }
            if ($Metadata -cne $LastObservedMetadata) {
                $LastObservedMetadata = $Metadata
                $LastChangeAt = $Now
                $Pending = $true
                $PendingBecauseDeferred = $false
                $PendingReason = "source-change"
                Write-KsxWatchState -State "debouncing" -Message "source change observed"
            }
        }

        $ReconcileDue = ($Now - $LastReconcileAt).TotalSeconds -ge $ReconcileSeconds
        if ($ReconcileDue) {
            $LastReconcileAt = $Now
            try {
                $Reconciled = Get-KsxSourceObservation
                $StudioNow = [string]$Reconciled.Studio
                $ZoneProducerNow = [string]$Reconciled.ZoneProducers
                $RuntimeNow = [string]$Reconciled.Runtime
                $EnvironmentStatus = Get-KsxEnvironmentStatusRow -Lightweight
            } catch {
                $ObservationMessage = $_.Exception.Message
                Write-KsxWatchState -State "observation-retry" -Message $ObservationMessage
                if (($Now - $LastObservationWarningAt).TotalSeconds -ge $ReconcileSeconds) {
                    Write-Warning "Reconciliation is temporarily unavailable; the running environment was left untouched. $ObservationMessage"
                    $LastObservationWarningAt = $Now
                }
                continue
            }

            $SourceDiffers = $StudioNow -cne $LastAppliedStudio -or
                $ZoneProducerNow -cne $LastAppliedZoneProducers -or
                $RuntimeNow -cne $LastAppliedRuntime
            $CurrentByObservation = -not $SourceDiffers -and
                (Test-KsxCurrentAssetGraph `
                    -StudioFingerprint $StudioNow `
                    -ZoneProducerFingerprint $ZoneProducerNow)
            $FailedGraphMatches = $StudioNow -ceq $LastFailedStudio -and
                $ZoneProducerNow -ceq $LastFailedZoneProducers -and
                $RuntimeNow -ceq $LastFailedRuntime -and
                -not [string]::IsNullOrWhiteSpace($LastFailedStudio)
            if ($SourceDiffers -and -not $FailedGraphMatches) {
                if (-not $Pending) {
                    $LastChangeAt = $Now
                }
                $Pending = $true
                if (-not $PendingBecauseDeferred) {
                    $PendingReason = "source-change"
                }
            } elseif (-not [bool]$EnvironmentStatus.Healthy -or -not $CurrentByObservation) {
                if (-not $FailedGraphMatches -and -not $PendingBecauseDeferred) {
                    $Pending = $true
                    $PendingReason = if (-not [bool]$EnvironmentStatus.Healthy) {
                        "health-recovery"
                    } else {
                        "current-recovery"
                    }
                    $LastChangeAt = $Now.AddMilliseconds(-$DebounceMilliseconds)
                    Write-KsxWatchState `
                        -State "recovery-pending" `
                        -Message "$PendingReason is required"
                }
            } elseif ($Pending -and -not $PendingBecauseDeferred -and -not $SourceDiffers) {
                # Timestamp-only saves do not warrant a Cargo rebuild.
                $Pending = $false
                Write-KsxWatchState -State "idle" -Message "metadata changed, but source bytes stayed current"
            }
        }

        if (-not $Pending) { continue }
        if (-not $PendingBecauseDeferred -and
            ($Now - $LastChangeAt).TotalMilliseconds -lt $DebounceMilliseconds) {
            continue
        }
        if ($PendingBecauseDeferred -and
            ($Now - $LastAttemptAt).TotalSeconds -lt $ReconcileSeconds) {
            continue
        }

        try {
            $AttemptObservation = Get-KsxSourceObservation
            $StudioFingerprint = [string]$AttemptObservation.Studio
            $ZoneProducerFingerprint = [string]$AttemptObservation.ZoneProducers
            $RuntimeFingerprint = [string]$AttemptObservation.Runtime
        } catch {
            $ObservationMessage = $_.Exception.Message
            Write-KsxWatchState -State "observation-retry" -Message $ObservationMessage
            if (($Now - $LastObservationWarningAt).TotalSeconds -ge $ReconcileSeconds) {
                Write-Warning "Build input observation is temporarily unavailable; retrying without touching the running environment. $ObservationMessage"
                $LastObservationWarningAt = $Now
            }
            continue
        }

        $FailedGraphMatches = $StudioFingerprint -ceq $LastFailedStudio -and
            $ZoneProducerFingerprint -ceq $LastFailedZoneProducers -and
            $RuntimeFingerprint -ceq $LastFailedRuntime -and
            -not [string]::IsNullOrWhiteSpace($LastFailedStudio)
        if ($FailedGraphMatches -and -not $PendingBecauseDeferred) {
            $Pending = $false
            Write-KsxWatchState `
                -State "failed" `
                -Message "this exact source graph already failed; waiting for a source change"
            continue
        }

        $StudioChanged = -not (Test-KsxCurrentAssetGraph `
            -StudioFingerprint $StudioFingerprint `
            -ZoneProducerFingerprint $ZoneProducerFingerprint)
        $Reason = if ($PendingBecauseDeferred) { "deferred-retry" } else { $PendingReason }
        $LastAttemptAt = [datetime]::UtcNow
        try {
            Invoke-KsxEnvironmentRefresh `
                -StudioChanged $StudioChanged `
                -Reason $Reason `
                -StudioFingerprint $StudioFingerprint `
                -RuntimeFingerprint $RuntimeFingerprint
            # Re-read after the build. Generated outputs and edits that arrived
            # during compilation become the next authoritative baseline only
            # when they were actually embedded by the completed cycle.
            $Applied = Get-KsxAppliedFingerprints
            $LastAppliedStudio = $Applied.Studio
            $LastAppliedZoneProducers = $Applied.ZoneProducers
            $LastAppliedRuntime = $Applied.Runtime
            $AfterRefresh = Get-KsxSourceObservation
            $AfterStudio = [string]$AfterRefresh.Studio
            $AfterZoneProducers = [string]$AfterRefresh.ZoneProducers
            $AfterRuntime = [string]$AfterRefresh.Runtime
            $LastObservedMetadata = [string]$AfterRefresh.Metadata
            $Pending = $AfterStudio -cne $LastAppliedStudio -or
                $AfterZoneProducers -cne $LastAppliedZoneProducers -or
                $AfterRuntime -cne $LastAppliedRuntime
            $PendingBecauseDeferred = $false
            $LastFailedStudio = ""
            $LastFailedZoneProducers = ""
            $LastFailedRuntime = ""
            if ($Pending) {
                $LastChangeAt = [datetime]::UtcNow
                $PendingReason = "source-change"
                Write-KsxWatchState -State "debouncing" -Message "another edit arrived during the build"
            } else {
                Write-KsxWatchState -State "idle" -Message "healthy replacement is running"
                Write-Host "[$(Get-Date -Format T)] $Environment is healthy. Refresh the browser to load the replacement."
            }
        } catch {
            $Message = $_.Exception.Message
            $PostFailure = Get-KsxPostFailureObservation `
                -AttemptedStudio $StudioFingerprint `
                -AttemptedZoneProducers $ZoneProducerFingerprint `
                -AttemptedRuntime $RuntimeFingerprint
            if (-not [bool]$PostFailure.Available -or [bool]$PostFailure.Changed -or
                (Test-KsxSourceChangedFailure -Message $Message)) {
                $Pending = $true
                $PendingBecauseDeferred = $false
                $PendingReason = "source-change"
                $LastChangeAt = [datetime]::UtcNow
                Write-KsxWatchState -State "debouncing" -Message $Message
                Write-Warning "Source changed during refresh; retrying after it settles. $Message"
            } elseif (Test-KsxDeferredFailure -Message $Message) {
                # A deterministic asset build may have completed before the
                # real-hardware preflight deferred the runtime swap. Adopt its
                # timestamp baseline and let the receipt suppress rebuilding
                # those same bytes on every retry.
                Sync-KsxObservedMetadata
                $Pending = $true
                $PendingBecauseDeferred = $true
                $PendingReason = "deferred-retry"
                Write-KsxWatchState -State "deferred" -Message $Message
                Write-Warning $Message
            } else {
                # A broken source graph is attempted once. A subsequent edit,
                # not a hot retry loop, authorizes another build.
                Set-KsxFailedGraph `
                    -Studio $StudioFingerprint `
                    -ZoneProducers $ZoneProducerFingerprint `
                    -Runtime $RuntimeFingerprint
                $Pending = $false
                $PendingBecauseDeferred = $false
                Write-KsxWatchState -State "failed" -Message $Message
                Write-Warning "Refresh failed; waiting for another source change. $Message"
            }
        }
    }
} catch {
    if ($ExitState -eq "stopped") {
        $ExitState = "failed"
        $ExitMessage = $_.Exception.Message
    }
    throw
} finally {
    if ($WatcherLockHeld) {
        Write-KsxWatchState -State $ExitState -Message $ExitMessage
        $WatcherMutex.ReleaseMutex()
    }
    if ($WatcherMutex) {
        $WatcherMutex.Dispose()
    }
    if ($SourceWatcher) {
        $SourceWatcher.Dispose()
    }
}
