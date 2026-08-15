[CmdletBinding()]
param(
    [string]$HidMaestroRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ExpectedContractId = "hidmaestro-v1.6.1-dualsense-usb-submit-state-input"
$ExpectedCommit = "2a0dac0857901a63d365a36dcf99cf50114ca954"
$ExpectedSourcePaths = @(
    "profiles/sony/dualsense.json",
    "sdk/HIDMaestro.Core/HMGamepadState.cs",
    "sdk/HIDMaestro.Core/HMController.cs",
    "sdk/HIDMaestro.Core/Internal/ControllerProfile.cs",
    "sdk/HIDMaestro.Core/Internal/HidReportBuilder.cs",
    "sdk/HIDMaestro.Core/Internal/VendorBlobCodec.cs",
    "sdk/HIDMaestro.Core/Internal/VendorBlobProgram.cs",
    "sdk/HIDMaestro.Core/Internal/SharedMemoryIO.cs",
    "sdk/HIDMaestro.Core/Internal/DeviceOrchestrator.cs",
    "driver/driver.c",
    "driver/driver.h",
    "test/probes/sony_extra_buttons_check/Program.cs"
)
$script:CheckCount = 0
$script:SourceFileCount = 0
$script:SourceGroupCount = 0
$script:GoldenScenarioCount = 0
$script:GoldenFrameCount = 0
$script:GitCommandCount = 0

function Write-VerificationResult {
    param(
        [bool]$Ok,
        [string]$SourceVerdict,
        [string]$RuntimeVerdict,
        [AllowNull()]$ErrorMessage
    )
    if ($null -ne $ErrorMessage) {
        $ErrorMessage = (([string]$ErrorMessage) -replace "[\r\n]+", " ").Trim()
        if ($ErrorMessage.Length -gt 512) {
            $ErrorMessage = $ErrorMessage.Substring(0, 512)
        }
    }
    $result = [ordered]@{
        schemaVersion = 1
        command = "verify-dualsense-input-source-contract"
        ok = $Ok
        commit = $ExpectedCommit
        sourceFileCount = $script:SourceFileCount
        descriptorGroupCount = $script:SourceGroupCount
        goldenScenarioCount = $script:GoldenScenarioCount
        goldenFrameCount = $script:GoldenFrameCount
        gitCommandCount = $script:GitCommandCount
        checkCount = $script:CheckCount
        sourceVerdict = $SourceVerdict
        runtimeVerdict = $RuntimeVerdict
        safety = [ordered]@{
            sourceOnly = $true
            gitCommandsExecuted = ($script:GitCommandCount -gt 0)
            externalProcessStarted = ($script:GitCommandCount -gt 0)
            externalProcessAllowlist = @("git")
            gitNoReplaceObjects = $true
            gitConfiguration = "inherited-not-mutated"
            buildExecuted = $false
            upstreamCodeExecuted = $false
            nonGitHelperProcessStarted = $false
            networkAccessed = $false
            elevationRequested = $false
            driverLoaded = $false
            deviceProvisioned = $false
            deviceAccessed = $false
            temporaryFileCreated = $false
        }
        error = $ErrorMessage
    }
    Write-Output ($result | ConvertTo-Json -Compress -Depth 5)
}

trap {
    Write-VerificationResult $false "NO-GO" "NO-GO" ([string]$_.Exception.Message)
    exit 1
}

function Fail-Contract {
    param([string]$Message)
    throw "HIDMaestro DualSense input contract failure: $Message"
}

function Assert-True {
    param([bool]$Condition, [string]$Label)
    $script:CheckCount++
    if (-not $Condition) {
        Fail-Contract $Label
    }
}

function Assert-Equal {
    param($Actual, $Expected, [string]$Label)
    $script:CheckCount++
    if ([string]$Actual -cne [string]$Expected) {
        Fail-Contract ("{0}: expected '{1}', got '{2}'" -f $Label, $Expected, $Actual)
    }
}

function Assert-Sequence {
    param($Actual, $Expected, [string]$Label)
    $actualItems = @($Actual)
    $expectedItems = @($Expected)
    Assert-Equal $actualItems.Count $expectedItems.Count "$Label count"
    for ($i = 0; $i -lt $expectedItems.Count; $i++) {
        Assert-Equal $actualItems[$i] $expectedItems[$i] "$Label[$i]"
    }
}

function Read-JsonFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Fail-Contract "missing contract file $Path"
    }
    return ([System.IO.File]::ReadAllText($Path) | ConvertFrom-Json)
}

function Get-PropertyValue {
    param($Object, [string]$Name, $Default = $null)
    if ($null -eq $Object) {
        return $Default
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $Default
    }
    return $property.Value
}

function Invoke-PinnedGit {
    param([string[]]$Arguments)
    $allArguments = @("--no-replace-objects", "-C", $script:HidMaestroResolved) + $Arguments
    $script:GitCommandCount++
    $output = & git @allArguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        $detail = (@($output | ForEach-Object { [string]$_ }) -join "`n")
        Fail-Contract ("git {0} failed: {1}" -f ($Arguments -join " "), $detail)
    }
    return (@($output | ForEach-Object { [string]$_ }) -join "`n")
}

function Convert-HexToBytes {
    param([string]$Hex)
    Assert-True (($Hex.Length % 2) -eq 0) "hex text must contain complete bytes"
    Assert-True ($Hex -match "\A[0-9A-Fa-f]*\z") "hex text contains a non-hex character"
    $bytes = New-Object byte[] ($Hex.Length / 2)
    for ($i = 0; $i -lt $bytes.Length; $i++) {
        $bytes[$i] = [Convert]::ToByte($Hex.Substring($i * 2, 2), 16)
    }
    return ,$bytes
}

function Get-Sha256Hex {
    param([byte[]]$Bytes)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return (($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString("x2") }) -join "")
    }
    finally {
        $sha.Dispose()
    }
}

function Parse-HidInputDescriptor {
    param([byte[]]$Descriptor)

    $usagePage = 0
    $logicalMinimum = 0
    $logicalMaximum = 0
    $reportSize = 0
    $reportCount = 0
    $reportId = 0
    $usageMinimum = 0
    $usageMaximum = 0
    $usages = New-Object System.Collections.Generic.List[int]
    $offsetByReport = @{}
    $groups = New-Object System.Collections.Generic.List[object]

    for ($offset = 0; $offset -lt $Descriptor.Length;) {
        $prefix = [int]$Descriptor[$offset]
        if ($prefix -eq 0xFE) {
            Assert-True (($offset + 2) -lt $Descriptor.Length) "truncated HID long item"
            $longLength = [int]$Descriptor[$offset + 1]
            $offset += 3 + $longLength
            continue
        }

        $itemSize = $prefix -band 0x03
        if ($itemSize -eq 3) {
            $itemSize = 4
        }
        Assert-True (($offset + $itemSize) -lt $Descriptor.Length) "truncated HID short item"
        $itemType = ($prefix -shr 2) -band 0x03
        $itemTag = ($prefix -shr 4) -band 0x0F

        $value = 0
        for ($j = 0; $j -lt $itemSize; $j++) {
            $value = $value -bor ([int]$Descriptor[$offset + 1 + $j] -shl (8 * $j))
        }
        $signedValue = $value
        if ($itemSize -gt 0 -and $itemSize -lt 4) {
            $signBit = 1 -shl ($itemSize * 8 - 1)
            if (($value -band $signBit) -ne 0) {
                $signedValue = $value -bor (-1 -shl ($itemSize * 8))
            }
        }

        if ($itemType -eq 0) {
            if ($itemTag -eq 8) {
                $reportKey = [string]$reportId
                if (-not $offsetByReport.ContainsKey($reportKey)) {
                    $offsetByReport[$reportKey] = 0
                }
                $dataBitOffset = [int]$offsetByReport[$reportKey]
                [void]$groups.Add([pscustomobject]@{
                    reportId = $reportId
                    usagePageHex = ("{0:X4}" -f $usagePage)
                    usagesHex = @($usages | ForEach-Object { "{0:X4}" -f $_ })
                    usageMinimum = $usageMinimum
                    usageMaximum = $usageMaximum
                    logicalMinimum = $logicalMinimum
                    logicalMaximum = $logicalMaximum
                    reportSizeBits = $reportSize
                    reportCount = $reportCount
                    descriptorDataBitOffset = $dataBitOffset
                    descriptorDataBitLength = $reportSize * $reportCount
                    inputFlagsHex = ("{0:X2}" -f $value)
                })
                $offsetByReport[$reportKey] = $dataBitOffset + $reportSize * $reportCount
                $usages.Clear()
                $usageMinimum = 0
                $usageMaximum = 0
            }
            elseif ($itemTag -eq 9 -or $itemTag -eq 10 -or $itemTag -eq 11) {
                $usages.Clear()
                $usageMinimum = 0
                $usageMaximum = 0
            }
        }
        elseif ($itemType -eq 1) {
            switch ($itemTag) {
                0 { $usagePage = $value }
                1 { $logicalMinimum = $signedValue }
                2 {
                    if ($logicalMinimum -ge 0 -and $signedValue -lt 0) {
                        $logicalMaximum = $value
                    }
                    else {
                        $logicalMaximum = $signedValue
                    }
                }
                7 { $reportSize = $value }
                8 { $reportId = $value }
                9 { $reportCount = $value }
            }
        }
        elseif ($itemType -eq 2) {
            switch ($itemTag) {
                0 {
                    if ($itemSize -eq 4) {
                        $usagePage = ($value -shr 16) -band 0xFFFF
                        [void]$usages.Add($value -band 0xFFFF)
                    }
                    else {
                        [void]$usages.Add($value)
                    }
                }
                1 { $usageMinimum = $value }
                2 { $usageMaximum = $value }
            }
        }

        $offset += 1 + $itemSize
    }

    return [pscustomobject]@{
        groups = $groups.ToArray()
        bitsByReport = $offsetByReport
    }
}

function Assert-DescriptorGroup {
    param($Actual, $Expected, [int]$Index)
    $label = "descriptorInputGroups[$Index]"
    Assert-Equal $Actual.reportId $Expected.reportId "$label.reportId"
    Assert-Equal $Actual.usagePageHex $Expected.usagePageHex "$label.usagePageHex"
    Assert-Sequence $Actual.usagesHex $Expected.usagesHex "$label.usagesHex"
    Assert-Equal $Actual.usageMinimum $Expected.usageMinimum "$label.usageMinimum"
    Assert-Equal $Actual.usageMaximum $Expected.usageMaximum "$label.usageMaximum"
    Assert-Equal $Actual.logicalMinimum $Expected.logicalMinimum "$label.logicalMinimum"
    Assert-Equal $Actual.logicalMaximum $Expected.logicalMaximum "$label.logicalMaximum"
    Assert-Equal $Actual.reportSizeBits $Expected.reportSizeBits "$label.reportSizeBits"
    Assert-Equal $Actual.reportCount $Expected.reportCount "$label.reportCount"
    Assert-Equal $Actual.descriptorDataBitOffset $Expected.descriptorDataBitOffset "$label.descriptorDataBitOffset"
    Assert-Equal $Actual.descriptorDataBitLength $Expected.descriptorDataBitLength "$label.descriptorDataBitLength"
    Assert-Equal $Actual.inputFlagsHex $Expected.inputFlagsHex "$label.inputFlagsHex"
}

function Get-NormalizedAxis {
    param($State, [string]$Name)
    $axes = Get-PropertyValue $State "axes" $null
    if ($null -eq $axes) {
        return [single]0.0
    }
    $axisProperty = $axes.PSObject.Properties[$Name]
    if ($null -eq $axisProperty) {
        return [single]0.0
    }
    $value = [single]$axisProperty.Value
    if ([single]::IsNaN($value) -or [single]::IsInfinity($value)) {
        Fail-Contract "golden vector axis $Name is not finite"
    }
    if ($value -lt [single]0.0) {
        return [single]0.0
    }
    if ($value -gt [single]1.0) {
        return [single]1.0
    }
    return $value
}

function Get-WireAxisByte {
    param([single]$Value)
    return [byte][int][Math]::Truncate(([double]$Value) * 255.0)
}

function Add-ButtonToReport {
    param([byte[]]$Buffer, [string]$Name)
    switch ($Name) {
        "None" { return }
        "Cross" { $Name = "A" }
        "Circle" { $Name = "B" }
        "Square" { $Name = "X" }
        "Triangle" { $Name = "Y" }
    }
    switch ($Name) {
        "A" { $Buffer[8] = $Buffer[8] -bor 0x20 }
        "B" { $Buffer[8] = $Buffer[8] -bor 0x40 }
        "X" { $Buffer[8] = $Buffer[8] -bor 0x10 }
        "Y" { $Buffer[8] = $Buffer[8] -bor 0x80 }
        "LeftBumper" { $Buffer[9] = $Buffer[9] -bor 0x01 }
        "RightBumper" { $Buffer[9] = $Buffer[9] -bor 0x02 }
        "Back" { $Buffer[9] = $Buffer[9] -bor 0x10 }
        "Start" { $Buffer[9] = $Buffer[9] -bor 0x20 }
        "LeftStick" { $Buffer[9] = $Buffer[9] -bor 0x40 }
        "RightStick" { $Buffer[9] = $Buffer[9] -bor 0x80 }
        "Guide" { $Buffer[10] = $Buffer[10] -bor 0x01 }
        "Touchpad" { $Buffer[10] = $Buffer[10] -bor 0x02 }
        "Misc1" { $Buffer[10] = $Buffer[10] -bor 0x04 }
        "Share" { return }
        "RightPaddle" { return }
        "LeftPaddle" { return }
        "RightPaddle2" { return }
        "LeftPaddle2" { return }
        default { Fail-Contract "golden vector contains unknown button '$Name'" }
    }
}

function Get-HatWireValue {
    param([string]$Name)
    switch ($Name) {
        "None" { return 8 }
        "North" { return 0 }
        "NorthEast" { return 1 }
        "East" { return 2 }
        "SouthEast" { return 3 }
        "South" { return 4 }
        "SouthWest" { return 5 }
        "West" { return 6 }
        "NorthWest" { return 7 }
        default { Fail-Contract "golden vector contains unknown hat '$Name'" }
    }
}

function Encode-GoldenState {
    param($State, [byte[]]$Buffer)
    Assert-Equal $Buffer.Length 64 "golden encoder destination length"
    [Array]::Clear($Buffer, 0, $Buffer.Length)
    $Buffer[0] = 1

    $x = Get-NormalizedAxis $State "X"
    $y = Get-NormalizedAxis $State "Y"
    $z = Get-NormalizedAxis $State "Z"
    $rz = Get-NormalizedAxis $State "Rz"
    $rx = Get-NormalizedAxis $State "Rx"
    $ry = Get-NormalizedAxis $State "Ry"
    $Buffer[1] = Get-WireAxisByte $x
    $Buffer[2] = Get-WireAxisByte $y
    $Buffer[3] = Get-WireAxisByte $z
    $Buffer[4] = Get-WireAxisByte $rz
    $Buffer[5] = Get-WireAxisByte $rx
    $Buffer[6] = Get-WireAxisByte $ry

    $hatName = [string](Get-PropertyValue $State "hat" "None")
    $Buffer[8] = [byte](Get-HatWireValue $hatName)

    $buttons = Get-PropertyValue $State "buttons" @()
    foreach ($button in @($buttons)) {
        Add-ButtonToReport $Buffer ([string]$button)
    }
    if ($rx -gt [single]0.0) {
        $Buffer[9] = $Buffer[9] -bor 0x04
    }
    if ($ry -gt [single]0.0) {
        $Buffer[9] = $Buffer[9] -bor 0x08
    }
}

function Convert-BytesToHex {
    param([byte[]]$Bytes)
    return [BitConverter]::ToString($Bytes).Replace("-", "")
}

if ($PSVersionTable.PSVersion.Major -lt 5) {
    Fail-Contract "PowerShell 5.1 or newer is required"
}
if ($null -eq (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail-Contract "git is required"
}
if ([string]::IsNullOrWhiteSpace($HidMaestroRoot)) {
    Fail-Contract "HidMaestroRoot is required"
}
if (-not (Test-Path -LiteralPath $HidMaestroRoot -PathType Container)) {
    Fail-Contract "HidMaestroRoot does not exist: $HidMaestroRoot"
}
$script:HidMaestroResolved = (Resolve-Path -LiteralPath $HidMaestroRoot).Path

$lock = Read-JsonFile (Join-Path $PSScriptRoot "source-lock.json")
$contract = Read-JsonFile (Join-Path $PSScriptRoot "contract.json")
$golden = Read-JsonFile (Join-Path $PSScriptRoot "golden-vectors.json")
$script:SourceFileCount = @($lock.files).Count
$script:GoldenScenarioCount = @($golden.vectors).Count

Assert-Equal $lock.contractId $ExpectedContractId "source lock contractId"
Assert-Equal $contract.contractId $ExpectedContractId "contract contractId"
Assert-Equal $golden.contractId $ExpectedContractId "golden contractId"
Assert-Equal $lock.upstream.commit $ExpectedCommit "source lock commit"
Assert-Equal $lock.upstream.tagTarget $ExpectedCommit "source lock tag target"
Assert-Equal $contract.source.commit $ExpectedCommit "contract commit"
Assert-Equal $lock.upstream.tag "v1.6.1" "source lock tag"
Assert-Equal $contract.source.tag "v1.6.1" "contract tag"
Assert-True ([bool]$lock.assurance.sourceContractFrozen) "sourceContractFrozen must be true"
Assert-True (-not [bool]$lock.assurance.runtimeImplementationBound) "runtimeImplementationBound must remain false"
Assert-True (-not [bool]$lock.assurance.artifactBuilt) "artifactBuilt must remain false"
Assert-True (-not [bool]$lock.assurance.driverLoaded) "driverLoaded must remain false"
Assert-True (-not [bool]$lock.assurance.deviceExercised) "deviceExercised must remain false"
Assert-True (-not [bool]$lock.assurance.distributionReady) "distributionReady must remain false"
Assert-Equal $lock.verifierAuthority.externalExecutable "git resolved from the caller's PATH" "verifier Git executable authority"
Assert-Equal $lock.verifierAuthority.gitConfiguration "inherited from the caller; the verifier does not mutate system, global, or repository Git configuration" "verifier Git configuration authority"
Assert-Sequence $lock.verifierAuthority.globalGitOptions @("--no-replace-objects", "-C", "<caller-supplied-HidMaestroRoot>") "verifier global Git options"
Assert-Sequence $lock.verifierAuthority.commandAllowlist @(
    "cat-file -e <exact-commit>^{commit}",
    "rev-parse <exact-commit>:<locked-path>",
    "show <exact-commit>:profiles/sony/dualsense.json"
) "verifier Git command allowlist"
Assert-True (-not [bool]$lock.verifierAuthority.hooksInvoked) "verifier must not invoke Git hooks"
Assert-True (-not [bool]$lock.verifierAuthority.networkAuthorized) "verifier must not authorize network"
Assert-True (-not [bool]$lock.verifierAuthority.upstreamCodeExecutionAuthorized) "verifier must not authorize upstream execution"
Assert-True (-not [bool]$lock.verifierAuthority.buildAuthorized) "verifier must not authorize builds"
Assert-True (-not [bool]$lock.verifierAuthority.driverOrDeviceAuthorized) "verifier must not authorize driver/device actions"

Assert-Sequence @($lock.files | ForEach-Object { $_.path }) $ExpectedSourcePaths "source lock paths"
[void](Invoke-PinnedGit @("cat-file", "-e", ("{0}^{{commit}}" -f $ExpectedCommit)))
foreach ($sourceFile in @($lock.files)) {
    Assert-True ([string]$sourceFile.gitBlobSha1 -match "\A[0-9a-f]{40}\z") "invalid blob hash for $($sourceFile.path)"
    $objectSpec = "{0}:{1}" -f $ExpectedCommit, [string]$sourceFile.path
    $actualBlob = (Invoke-PinnedGit @("rev-parse", $objectSpec)).Trim().ToLowerInvariant()
    Assert-Equal $actualBlob ([string]$sourceFile.gitBlobSha1).ToLowerInvariant() "blob $($sourceFile.path)"
}

$profileText = Invoke-PinnedGit @("show", ("{0}:profiles/sony/dualsense.json" -f $ExpectedCommit))
$profile = $profileText | ConvertFrom-Json
Assert-Equal $profile.id "dualsense" "profile id"
Assert-Equal $profile.connection "usb" "profile connection"
Assert-Equal ([string]$profile.vid).ToUpperInvariant() "0X054C" "profile VID"
Assert-Equal ([string]$profile.pid).ToUpperInvariant() "0X0CE6" "profile PID"
Assert-Equal $profile.inputReportSize 64 "profile inputReportSize"
Assert-Sequence $profile.buttonMap @(1, 2, 0, 3, 4, 5, 8, 9, 10, 11, 12, 13, -1, -1, -1, 14) "profile buttonMap"
Assert-Sequence $profile.triggerButtons @(6, 7) "profile triggerButtons"
Assert-Equal (Get-PropertyValue $profile.axisMap "0x32") "rightStickX" "profile axisMap 0x32"
Assert-Equal (Get-PropertyValue $profile.axisMap "0x35") "rightStickY" "profile axisMap 0x35"
Assert-Equal (Get-PropertyValue $profile.axisMap "0x33") "leftTrigger" "profile axisMap 0x33"
Assert-Equal (Get-PropertyValue $profile.axisMap "0x34") "rightTrigger" "profile axisMap 0x34"
Assert-True ($null -eq (Get-PropertyValue $profile "inputDefaults" $null)) "dualsense inputDefaults must remain absent"

$extended = Get-PropertyValue $profile "extendedReport" $null
Assert-True ($null -ne $extended) "dualsense extendedReport metadata must remain present"
Assert-Equal $extended.reportId "0x01" "extendedReport metadata reportId"
Assert-Equal $extended.size 64 "extendedReport metadata size"
$armOn = Get-PropertyValue $extended "armOn" $null
Assert-True ($null -eq $armOn -or @($armOn).Count -eq 0) "USB dualsense extendedReport must not declare armOn"
$alwaysArmed = Get-PropertyValue $extended "alwaysArmed" $false
Assert-True (-not [bool]$alwaysArmed) "USB dualsense extendedReport must not be alwaysArmed"
Assert-True (-not [bool]$contract.activePath.profileExtendedReportActive) "contract must keep the extendedReport path inactive"

$descriptor = Convert-HexToBytes ([string]$profile.descriptor)
Assert-Equal $descriptor.Length 273 "descriptor byte length"
Assert-Equal (Get-Sha256Hex $descriptor) $contract.source.descriptorSha256 "descriptor SHA-256"
$parsed = Parse-HidInputDescriptor $descriptor
$actualGroups = @($parsed.groups | Where-Object { $_.reportId -eq 1 })
$script:SourceGroupCount = $actualGroups.Count
$expectedGroups = @($contract.descriptorInputGroups)
Assert-Equal $actualGroups.Count $expectedGroups.Count "descriptor input group count"
for ($groupIndex = 0; $groupIndex -lt $expectedGroups.Count; $groupIndex++) {
    Assert-DescriptorGroup $actualGroups[$groupIndex] $expectedGroups[$groupIndex] $groupIndex
}
Assert-Equal $parsed.bitsByReport["1"] 504 "report 1 descriptor data bits"
Assert-Equal $contract.report.descriptorDataBitLength 504 "contract descriptor data bits"
Assert-Equal $contract.report.wireByteLength 64 "contract wire byte length"
Assert-Equal $contract.report.reportId 1 "contract report ID"
Assert-True ([bool]$contract.report.clearedBeforeEveryEncode) "contract must clear before every encode"
Assert-True (-not [bool]$contract.report.statefulFields) "contract must remain stateless"
Assert-True (-not [bool]$contract.report.rollingSequence) "contract must not invent a rolling sequence"

Assert-Sequence @($contract.axes.entries | ForEach-Object { $_.stateKey }) @("X", "Y", "Z", "Rz", "Rx", "Ry") "contract axis keys"
Assert-Sequence @($contract.axes.entries | ForEach-Object { $_.wireByte }) @(1, 2, 3, 4, 5, 6) "contract axis wire bytes"
Assert-Sequence @($contract.axes.entries | ForEach-Object { $_.sharedDataByte }) @(0, 1, 2, 3, 4, 5) "contract axis shared bytes"
Assert-True (([double]$contract.axes.missingAxisValue) -eq 0.0) "contract missing axis value must be 0.0"
Assert-Sequence $contract.buttons.profileButtonMap $profile.buttonMap "contract profileButtonMap"
Assert-Sequence @($contract.derivedTriggerButtons | ForEach-Object { $_.wireBit }) @(2, 3) "derived trigger button bits"
Assert-Equal $contract.coordinates.candidateFullWireEncoder.byteLength 64 "candidate full-wire length"
Assert-True ([bool]$contract.coordinates.candidateFullWireEncoder.includesReportId) "candidate full-wire report must include ID"
Assert-Equal $contract.coordinates.upstreamLegacySharedInput.byteLength 63 "legacy shared payload length"
Assert-True (-not [bool]$contract.coordinates.upstreamLegacySharedInput.includesReportId) "legacy shared payload must exclude ID"
Assert-Equal $contract.resolution.sourceContractVerdict "GO" "source contract verdict"
Assert-Equal $contract.resolution.runtimeVerdict "NO-GO" "runtime verdict"
Assert-True (-not [bool]$contract.resolution.aggregateGatesChanged) "aggregate gates must remain unchanged"
Assert-Equal @($contract.resolution.unresolvedFields).Count 0 "unresolved field count"

$requiredVectorIds = @(
    "neutral_explicit",
    "clamp_scale_and_trigger_derivation",
    "face_button_bits",
    "playstation_alias_button_bits",
    "shoulder_system_button_bits",
    "hat_octants",
    "unsupported_button_bits_drop",
    "sub_lsb_trigger_is_digitally_pressed",
    "full_state_clears_reused_buffer"
)
Assert-Sequence @($golden.vectors | ForEach-Object { $_.id }) $requiredVectorIds "golden vector IDs"
$seenAxes = @{}
$seenHats = @{}
$seenButtons = @{}
foreach ($vector in @($golden.vectors)) {
    $buffer = New-Object byte[] 64
    $frameIndex = 0
    foreach ($frame in @($vector.frames)) {
        $script:GoldenFrameCount++
        $expectedHex = ([string]$frame.reportHex).ToUpperInvariant()
        Assert-True ($expectedHex -match "\A[0-9A-F]{128}\z") "vector $($vector.id) frame $frameIndex must contain exactly 64 bytes"
        Encode-GoldenState $frame.state $buffer
        $actualHex = Convert-BytesToHex $buffer
        Assert-Equal $actualHex $expectedHex "vector $($vector.id) frame $frameIndex"

        $axes = Get-PropertyValue $frame.state "axes" $null
        if ($null -ne $axes) {
            foreach ($property in @($axes.PSObject.Properties)) {
                $seenAxes[[string]$property.Name] = $true
            }
        }
        $hat = [string](Get-PropertyValue $frame.state "hat" "None")
        $seenHats[$hat] = $true
        foreach ($button in @((Get-PropertyValue $frame.state "buttons" @()))) {
            $seenButtons[[string]$button] = $true
        }
        $frameIndex++
    }
}

foreach ($axis in @($golden.requiredCoverage.axes)) {
    Assert-True $seenAxes.ContainsKey([string]$axis) "golden coverage missing axis $axis"
}
foreach ($hat in @($golden.requiredCoverage.hats)) {
    Assert-True $seenHats.ContainsKey([string]$hat) "golden coverage missing hat $hat"
}
foreach ($button in @($golden.requiredCoverage.buttons)) {
    Assert-True $seenButtons.ContainsKey([string]$button) "golden coverage missing button $button"
}
foreach ($button in @($golden.requiredCoverage.droppedButtons)) {
    Assert-True $seenButtons.ContainsKey([string]$button) "golden coverage missing dropped button $button"
}

Write-VerificationResult $true "GO" "NO-GO" $null
