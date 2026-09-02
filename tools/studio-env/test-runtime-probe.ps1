<#
.SYNOPSIS
    Exercises exact-process identity and PID-reuse safety without product lanes.

.DESCRIPTION
    Uses only this PowerShell host plus one disposable sleeping child. It never
    reads, writes, starts, or stops a Studio environment receipt, port, or pipe.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime-probe.ps1")

function Assert-True {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if (-not $Condition) { throw $Message }
}

$Current = Get-Process -Id $PID -ErrorAction Stop
$CurrentExecutable = [System.IO.Path]::GetFullPath([string]$Current.Path)
$CurrentCreation = $Current.StartTime.ToUniversalTime()

$ExactCurrent = Open-KsxExactProcess `
    -ProcessId $PID `
    -ExpectedExecutable $CurrentExecutable `
    -ExpectedCreationTimeUtc $CurrentCreation
try {
    Assert-True ($null -ne $ExactCurrent) "The exact current process identity was not retained."
    Assert-True (-not $ExactCurrent.HasExited) "The exact current process handle unexpectedly reports exit."
} finally {
    if ($ExactCurrent) { $ExactCurrent.Dispose() }
}

# A stale receipt whose PID now belongs to an unrelated executable is ordinary
# recoverable debris. Most importantly, identity inspection must not request
# termination rights or touch that unrelated process.
$UnrelatedExecutable = Join-Path ([System.IO.Path]::GetTempPath()) "ksx-recorded-generation-that-exited.exe"
$StaleByImage = Open-KsxExactProcess `
    -ProcessId $PID `
    -ExpectedExecutable $UnrelatedExecutable `
    -ExpectedCreationTimeUtc $CurrentCreation `
    -StaleIdentityAsMissing
Assert-True ($null -eq $StaleByImage) "An unrelated PID owner was trusted as the recorded generation."
Assert-True (-not $Current.HasExited) "The unrelated PID owner was terminated during stale-image inspection."

# Creation time is the generation discriminator even when a replacement uses
# the same executable path.
$StaleByCreation = Open-KsxExactProcess `
    -ProcessId $PID `
    -ExpectedExecutable $CurrentExecutable `
    -ExpectedCreationTimeUtc $CurrentCreation.AddSeconds(-1) `
    -StaleIdentityAsMissing
Assert-True ($null -eq $StaleByCreation) "A reused same-image PID was trusted as the recorded generation."
Assert-True (-not $Current.HasExited) "The current process was terminated during stale-generation inspection."

$StrictMismatchRejected = $false
try {
    $null = Open-KsxExactProcess `
        -ProcessId $PID `
        -ExpectedExecutable $UnrelatedExecutable `
        -ExpectedCreationTimeUtc $CurrentCreation
} catch {
    $StrictMismatchRejected = $_.Exception.Message -like "*no longer owns the expected executable*"
}
Assert-True $StrictMismatchRejected "Strict exact-process callers no longer reject mismatched identity."

# PID 4 is the protected Windows System process. Some hosts deny the limited
# handle; others grant it but deny the image query; still others expose the
# image. The system process snapshot safely exposes its non-path name in every
# supported case. This covers the crash-recovery case where a dead receipt's
# PID has become a protected unrelated process without assuming which native
# inspection call that host permits.
$ProtectedProcess = Get-Process -Id 4 -ErrorAction SilentlyContinue
if ($ProtectedProcess) {
    $StaleProtected = Open-KsxExactProcess `
        -ProcessId 4 `
        -ExpectedExecutable $UnrelatedExecutable `
        -ExpectedCreationTimeUtc $CurrentCreation `
        -StaleIdentityAsMissing
    Assert-True ($null -eq $StaleProtected) "A protected unrelated PID owner blocked stale receipt recovery."
    $ProtectedStillLive = Get-Process -Id 4 -ErrorAction Stop
    Assert-True ($ProtectedStillLive.ProcessName -eq $ProtectedProcess.ProcessName) "Protected-process inspection changed the unrelated PID owner."
}

# Termination authority remains lazy and exact. Exercise it only against a
# child created solely for this contract.
$Child = $null
$ExactChild = $null
try {
    # Exercise the same host that is running the contract: Windows PowerShell
    # uses powershell.exe and PowerShell 7 uses pwsh.exe.
    $ChildExecutable = $CurrentExecutable
    $Child = Start-Process `
        -FilePath $ChildExecutable `
        -ArgumentList @("-NoProfile", "-Command", "Start-Sleep -Seconds 120") `
        -WindowStyle Hidden `
        -PassThru
    $null = $Child.Handle
    $Child.Refresh()
    $ExactChild = Open-KsxExactProcess `
        -ProcessId $Child.Id `
        -ExpectedExecutable ([System.IO.Path]::GetFullPath($ChildExecutable)) `
        -ExpectedCreationTimeUtc $Child.StartTime.ToUniversalTime()
    Assert-True ($null -ne $ExactChild) "The disposable exact child identity was not retained."
    $ExactChild.Terminate(1)
    Assert-True ($ExactChild.Wait(5000)) "The exact disposable child did not exit after termination."
} finally {
    if ($ExactChild) { $ExactChild.Dispose() }
    if ($Child) {
        $Child.Refresh()
        if (-not $Child.HasExited) {
            $Child.Kill()
            $null = $Child.WaitForExit(5000)
        }
        $Child.Dispose()
    }
}

Write-Host "Exact-process identity, stale PID reuse, and lazy termination contracts passed."
