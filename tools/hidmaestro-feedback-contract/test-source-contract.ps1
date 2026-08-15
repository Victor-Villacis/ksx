[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$HidMaestroRoot,

    [Parameter(Mandatory = $true)]
    [string]$LinuxSource,

    [Parameter(Mandatory = $true)]
    [string]$SdlSource
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$lockPath = Join-Path $PSScriptRoot 'source.lock.json'
$lock = Get-Content -Raw -LiteralPath $lockPath | ConvertFrom-Json
$checks = New-Object System.Collections.ArrayList

function Add-Check {
    param([string]$Name, [bool]$Passed, [string]$Fact)
    [void]$checks.Add([pscustomobject]@{
        name = $Name
        passed = $Passed
        fact = $Fact
    })
}

function Test-ContainsOrdinal {
    param([string]$Text, [string]$Value)
    return $Text.IndexOf($Value, [System.StringComparison]::Ordinal) -ge 0
}

function Invoke-GitText {
    param([string[]]$Arguments)
    $result = & git -C $HidMaestroRoot @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "git failed ($LASTEXITCODE): git -C $HidMaestroRoot $($Arguments -join ' ')`n$($result -join "`n")"
    }
    return ($result -join "`n")
}

function Read-PinnedText {
    param([string]$Path)
    return Invoke-GitText @('show', "$($lock.hidMaestro.commit):$Path")
}

$root = (Resolve-Path -LiteralPath $HidMaestroRoot).Path
$linux = (Resolve-Path -LiteralPath $LinuxSource).Path
$sdl = (Resolve-Path -LiteralPath $SdlSource).Path

$headType = Invoke-GitText @('cat-file', '-t', $lock.hidMaestro.commit)
Add-Check 'hidmaestro.commitObject' ($headType -ceq 'commit') 'the pinned HIDMaestro object is a commit'

Add-Check 'hidmaestro.releaseLabel' ($lock.hidMaestro.tag -ceq 'v1.6.1') 'the provenance labels the pinned commit as v1.6.1'

foreach ($file in $lock.hidMaestro.files) {
    $blob = Invoke-GitText @('rev-parse', "$($lock.hidMaestro.commit):$($file.path)")
    Add-Check "hidmaestro.blob.$($file.path)" ($blob -ceq $file.gitBlobSha1) 'canonical Git blob identity matches'
}

$packet = Read-PinnedText 'sdk/HIDMaestro.Core/HMOutputPacket.cs'
Add-Check 'packet.separateFields' `
    ((Test-ContainsOrdinal $packet 'public readonly byte ReportId;') -and
     (Test-ContainsOrdinal $packet 'public readonly ReadOnlyMemory<byte> Data;')) `
    'ReportId and Data are separate HMOutputPacket fields'
Add-Check 'packet.sourceOrdinals' `
    ((Test-ContainsOrdinal $packet 'HidOutput  = 0') -and
     (Test-ContainsOrdinal $packet 'HidFeature = 1') -and
     (Test-ContainsOrdinal $packet 'XInput     = 2') -and
     (Test-ContainsOrdinal $packet 'HidFeatureRead = 3')) `
    'HMOutputSource ordinals are exact'
Add-Check 'packet.dataExcludesReportId' `
    (Test-ContainsOrdinal $packet 'no Report ID byte') `
    'the public contract says HID Data excludes the report-ID byte'

$driver = Read-PinnedText 'driver/driver.c'
Add-Check 'driver.stripsReportId' `
    ((Test-ContainsOrdinal $driver 'const UCHAR *payload = (wrSize > 0) ? p + 1 : p;') -and
     (Test-ContainsOrdinal $driver 'wrSize - 1') -and
     (Test-ContainsOrdinal $driver 'HIDMAESTRO_OUTPUT_SOURCE_HID_OUTPUT')) `
    'IOCTL_HID_WRITE_REPORT publishes the report ID separately from payload'
Add-Check 'driver.setOutputAlsoStripsReportId' `
    ((Test-ContainsOrdinal $driver 'case IOCTL_UMDF_HID_SET_OUTPUT_REPORT:') -and
     (Test-ContainsOrdinal $driver 'const UCHAR *payload = (outBufSize > 0) ? p + 1 : p;') -and
     (Test-ContainsOrdinal $driver 'outBufSize - 1')) `
    'HidD_SetOutputReport uses the same separate-ID payload coordinates'

$header = Read-PinnedText 'driver/driver.h'
Add-Check 'driver.outputSourceValues' `
    ((Test-ContainsOrdinal $header '#define HIDMAESTRO_OUTPUT_SOURCE_HID_OUTPUT       0') -and
     (Test-ContainsOrdinal $header '#define HIDMAESTRO_OUTPUT_SOURCE_HID_FEATURE      1') -and
     (Test-ContainsOrdinal $header '#define HIDMAESTRO_OUTPUT_SOURCE_XINPUT           2')) `
    'driver output-source constants match the managed enum'
Add-Check 'driver.ringShape' `
    ((Test-ContainsOrdinal $header '#define HIDMAESTRO_OUTPUT_RING_SLOTS     64u') -and
     (Test-ContainsOrdinal $header '#define HIDMAESTRO_OUTPUT_SLOT_DATA_CAP  256u') -and
     (Test-ContainsOrdinal $header 'UCHAR           ReportId;') -and
     (Test-ContainsOrdinal $header 'USHORT          DataSize;')) `
    'the output ring is 64 slots with separate ID, size, and 256-byte payload'

$controller = Read-PinnedText 'sdk/HIDMaestro.Core/HMController.cs'
Add-Check 'controller.rawBeforeDecoded' `
    ((Test-ContainsOrdinal $controller 'OutputReceived?.Invoke(this, pkt);') -and
     (Test-ContainsOrdinal $controller 'full[0] = reportId;') -and
     (Test-ContainsOrdinal $controller 'Buffer.BlockCopy(buf, 0, full, 1, dataSize);')) `
    'OutputReceived gets raw split coordinates before OutputDecoded reconstructs the full report'
Add-Check 'controller.reusedBuffer' `
    ((Test-ContainsOrdinal $controller 'byte[] buf = new byte[256];') -and
     (Test-ContainsOrdinal $controller 'new ReadOnlyMemory<byte>(buf, 0, dataSize)')) `
    'successive callbacks borrow the same managed reader buffer'

$shared = Read-PinnedText 'sdk/HIDMaestro.Core/Internal/SharedMemoryIO.cs'
Add-Check 'shared.exactSlotCoordinates' `
    ((Test-ContainsOrdinal $shared 'UCHAR  ReportId               slot+5') -and
     (Test-ContainsOrdinal $shared 'USHORT DataSize               slot+6') -and
     (Test-ContainsOrdinal $shared 'UCHAR  Data[256]              slot+8')) `
    'managed ring coordinates keep report ID outside Data'

$profile = (Read-PinnedText 'profiles/sony/dualsense.json') | ConvertFrom-Json
$extended = $profile.extendedOutputReport
$fieldBySemantic = @{}
foreach ($field in $extended.fields) {
    if ($null -ne $field.semantic) {
        $fieldBySemantic[$field.semantic] = $field
    }
}
Add-Check 'profile.identityAndOutput' `
    ($profile.id -ceq 'dualsense' -and $profile.connection -ceq 'usb' -and
     $profile.vid -ceq '0x054C' -and $profile.pid -ceq '0x0CE6' -and
     $extended.reportId -ceq '0x02' -and [int]$extended.size -eq 48) `
    'the exact plain-USB DualSense profile has a 48-byte full output report 0x02'
Add-Check 'profile.fullReportOffsets' `
    ([int]$fieldBySemantic.validFlag0.byte -eq 1 -and
     [int]$fieldBySemantic.validFlag1.byte -eq 2 -and
     [int]$fieldBySemantic.rightMotor.byte -eq 3 -and
     [int]$fieldBySemantic.leftMotor.byte -eq 4 -and
     [int]$fieldBySemantic.validFlag2.byte -eq 39) `
    'profile offsets include the report ID and therefore shift down by one in raw Data'

$probe = Read-PinnedText 'test/probes/usbip_server_check/Program.cs'
Add-Check 'probe.rawEnvelope' `
    ((Test-ContainsOrdinal $probe 'src == 0 && rid == 0x02 && rsize == 47') -and
     (Test-ContainsOrdinal $probe 'ringBuf.Take(47).SequenceEqual(outReport.Skip(1))')) `
    'the upstream probe asserts source 0, ID 0x02, and the exact 47-byte ID-stripped payload'

$linuxLock = @($lock.layoutReferences)[0]
$linuxHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $linux).Hash
Add-Check 'linux.sha256' ($linuxHash -ceq $linuxLock.sha256) 'the pinned Linux layout reference hash matches'
$linuxText = Get-Content -Raw -LiteralPath $linux
Add-Check 'linux.validityMasks' `
    ((Test-ContainsOrdinal $linuxText 'DS_OUTPUT_VALID_FLAG0_COMPATIBLE_VIBRATION') -and
     (Test-ContainsOrdinal $linuxText 'BIT(0)') -and
     (Test-ContainsOrdinal $linuxText 'DS_OUTPUT_VALID_FLAG0_HAPTICS_SELECT') -and
     (Test-ContainsOrdinal $linuxText 'BIT(1)') -and
     (Test-ContainsOrdinal $linuxText 'DS_OUTPUT_VALID_FLAG2_COMPATIBLE_VIBRATION2') -and
     (Test-ContainsOrdinal $linuxText 'BIT(2)')) `
    'Linux assigns the three DualSense validity masks used by the contract'
Add-Check 'linux.commonLayout' `
    ((Test-ContainsOrdinal $linuxText 'u8 valid_flag0;') -and
     (Test-ContainsOrdinal $linuxText 'u8 valid_flag1;') -and
     (Test-ContainsOrdinal $linuxText 'u8 motor_right;') -and
     (Test-ContainsOrdinal $linuxText 'u8 motor_left;') -and
     (Test-ContainsOrdinal $linuxText 'sizeof(struct dualsense_output_report_common) == 47')) `
    'the shared output body is 47 bytes and begins with flags then right/left motors'
Add-Check 'linux.producerCombination' `
    ((Test-ContainsOrdinal $linuxText 'common->valid_flag0 |= DS_OUTPUT_VALID_FLAG0_HAPTICS_SELECT;') -and
     (Test-ContainsOrdinal $linuxText 'common->valid_flag2 |= DS_OUTPUT_VALID_FLAG2_COMPATIBLE_VIBRATION2;') -and
     (Test-ContainsOrdinal $linuxText 'common->valid_flag0 |= DS_OUTPUT_VALID_FLAG0_COMPATIBLE_VIBRATION;') -and
     (Test-ContainsOrdinal $linuxText 'common->motor_left = ds->motor_left;') -and
     (Test-ContainsOrdinal $linuxText 'common->motor_right = ds->motor_right;')) `
    'Linux emits selector plus exactly one motor-validity variant and both motor bytes'

$sdlLock = @($lock.layoutReferences)[1]
$sdlHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sdl).Hash
Add-Check 'sdl.sha256' ($sdlHash -ceq $sdlLock.sha256) 'the pinned SDL producer reference hash matches'
$sdlText = Get-Content -Raw -LiteralPath $sdl
Add-Check 'sdl.selectorOnlyStart' `
    ((Test-ContainsOrdinal $sdlText 'k_EDS5EffectRumbleStart') -and
     (Test-ContainsOrdinal $sdlText 'effects.ucEnableBits1 |= 0x02; // Disable audio haptics')) `
    'SDL has a selector-only rumble-start packet'
Add-Check 'sdl.allZeroRestore' `
    ((Test-ContainsOrdinal $sdlText 'SDL_zero(effects);') -and
     (Test-ContainsOrdinal $sdlText 'Leaving emulated rumble bits off will restore audio haptics')) `
    'SDL documents its zeroed restore-audio-haptics output state'

$failed = @($checks | Where-Object { -not $_.passed })
[pscustomobject]@{
    schemaVersion = 1
    contract = 's1.5c-dualsense-usb-raw-feedback-source'
    hidMaestroRoot = $root
    total = $checks.Count
    passed = $checks.Count - $failed.Count
    failed = $failed.Count
    checks = @($checks)
} | ConvertTo-Json -Depth 6 -Compress

if ($failed.Count -ne 0) {
    exit 1
}
