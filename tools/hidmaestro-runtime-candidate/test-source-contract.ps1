[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $SourceRoot
)

$ErrorActionPreference = 'Stop'

$toolRoot = Split-Path -Parent $PSCommandPath
$lockPath = Join-Path $toolRoot 'source.lock.json'
$lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
$root = [IO.Path]::GetFullPath($SourceRoot)
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

function Read-PinnedText {
    param([string] $RelativePath)
    $path = Join-Path $root ($RelativePath -replace '/', [IO.Path]::DirectorySeparatorChar)
    return Get-Content -LiteralPath $path -Raw
}

function Test-ContainsOrdinal {
    param(
        [string] $Text,
        [string] $Needle
    )
    return $Text.IndexOf($Needle, [StringComparison]::Ordinal) -ge 0
}

try {
    if (!(Test-Path -LiteralPath $root -PathType Container)) {
        throw "Source root does not exist: $root"
    }

    $actualCommit = (& git -C $root rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -ne 0) {
        throw 'Source root is not a readable Git checkout.'
    }
    $actualCommit = ($actualCommit | Select-Object -First 1).Trim()
    Add-Check 'source.commit' ($actualCommit -ceq $lock.commit) `
        "expected $($lock.commit); got $actualCommit"

    foreach ($file in $lock.files) {
        $path = Join-Path $root ($file.path -replace '/', [IO.Path]::DirectorySeparatorChar)
        $present = Test-Path -LiteralPath $path -PathType Leaf
        Add-Check "source.present.$($file.path)" $present "pinned source file is present"
        if (!$present) { continue }
        $actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
        Add-Check "source.sha256.$($file.path)" ($actualHash -ceq $file.sha256) `
            "expected $($file.sha256); got $actualHash"
    }

    $project = Read-PinnedText 'sdk/HIDMaestro.Core/HIDMaestro.Core.csproj'
    Add-Check 'baseline.projectEmbedsProvisioning' `
        ((Test-ContainsOrdinal $project 'signtool.exe') -and
         (Test-ContainsOrdinal $project 'Inf2Cat.exe') -and
         (Test-ContainsOrdinal $project 'USBip-') -and
         (Test-ContainsOrdinal $project 'HIDMaestro.Resources.')) `
        'the pinned project embeds WDK/provisioning payloads and is not the runtime-only project'

    $context = Read-PinnedText 'sdk/HIDMaestro.Core/HMContext.cs'
    Add-Check 'baseline.contextHasPreMainEffects' `
        ((Test-ContainsOrdinal $context 'Task.Run') -and
         (Test-ContainsOrdinal $context 'DriverBuilder.EnsureExtracted') -and
         (Test-ContainsOrdinal $context 'DeviceOrchestrator.PrewarmGameInputService')) `
        'the pinned constructor starts background provisioning and service work'
    Add-Check 'baseline.contextExposesProvisioning' `
        ((Test-ContainsOrdinal $context 'InstallDriver()') -and
         (Test-ContainsOrdinal $context 'RemoveAllVirtualControllers()') -and
         (Test-ContainsOrdinal $context 'InstallUsbipBackend')) `
        'the pinned public context exposes install and global-cleanup operations'

    $orchestrator = Read-PinnedText 'sdk/HIDMaestro.Core/Internal/DeviceOrchestrator.cs'
    Add-Check 'baseline.createCanProvision' `
        ((Test-ContainsOrdinal $orchestrator 'DriverBuilder.IsDriverInstalled()') -and
         (Test-ContainsOrdinal $orchestrator 'DriverBuilder.FullDeploy()')) `
        'the pinned create path can provision or repair the driver'
    Add-Check 'baseline.createRunsGlobalCleanup' `
        ((Test-ContainsOrdinal $orchestrator 'CleanupGhostDevices();') -and
         (Test-ContainsOrdinal $orchestrator 'DisableGhostXusbInterfaces();')) `
        'the pinned create path performs a once-per-process global cleanup'
    Add-Check 'baseline.teardownRediscoversByIndex' `
        ((Test-ContainsOrdinal $orchestrator 'Backstop: scan and remove HIDMAESTRO devices by ControllerIndex.') -and
         (Test-ContainsOrdinal $orchestrator 'RemoveOrphanHidChildrenBatch')) `
        'the pinned teardown rediscovery is broader than exact owned instance IDs'

    $swd = Read-PinnedText 'sdk/HIDMaestro.Core/Internal/SwdDeviceFactory.cs'
    Add-Check 'baseline.swdExtractsTemporaryHelper' `
        ((Test-ContainsOrdinal $swd 'EnsureHelperExtracted()') -and
         (Test-ContainsOrdinal $swd 'Path.GetTempPath()') -and
         (Test-ContainsOrdinal $swd 'GetManifestResourceStream("HIDMaestro.Resources.hmswd.exe")')) `
        'the pinned SWD path extracts and executes an embedded helper from a temporary location'

    $usbip = Read-PinnedText 'sdk/HIDMaestro.Core/Internal/Usbip/UsbipBackend.cs'
    Add-Check 'baseline.usbipInstallsAndSweeps' `
        ((Test-ContainsOrdinal $usbip 'UsbipDriverInstaller.EnsureInstalled') -and
         (Test-ContainsOrdinal $usbip 'SweepStaleOnce') -and
         (Test-ContainsOrdinal $usbip 'DetachAllOwned')) `
        'the pinned composite path installs on demand and performs broad stale-state cleanup'

    $profile = (Read-PinnedText 'profiles/sony/dualsense.json') | ConvertFrom-Json
    $profileOk = $profile.id -ceq 'dualsense' -and
        $profile.vid -ceq '0x054C' -and
        $profile.pid -ceq '0x0CE6' -and
        $profile.connection -ceq 'usb' -and
        $profile.inputReportSize -eq 64 -and
        $null -eq $profile.backend
    Add-Check 'baseline.dualsensePlainHidProfile' $profileOk `
        'dualsense is the exact plain-HID 054C:0CE6 USB profile with a 64-byte input report'

    $ok = ($checks | Where-Object passed -ne $true).Count -eq 0
    [ordered]@{
        schemaVersion = 1
        command = 'runtime-source-baseline'
        assurance = 'hash-pinned-static-source-facts-only'
        ok = $ok
        sourceRoot = $root
        upstreamCommit = $actualCommit
        checks = $checks
        note = 'Passing proves only that the known v1.6.1 baseline was audited. It does not approve execution or distribution.'
    } | ConvertTo-Json -Depth 8
    if (!$ok) { exit 1 }
}
catch {
    [ordered]@{
        schemaVersion = 1
        command = 'runtime-source-baseline'
        assurance = 'hash-pinned-static-source-facts-only'
        ok = $false
        sourceRoot = $root
        checks = $checks
        error = [ordered]@{
            code = 'source_baseline_failed'
            message = $_.Exception.Message
        }
    } | ConvertTo-Json -Depth 8
    exit 1
}
