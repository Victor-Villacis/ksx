[CmdletBinding(DefaultParameterSetName = "One")]
param(
    [Parameter(Mandatory = $true, ParameterSetName = "One")]
    [ValidateSet("seeded", "first-run", "blank-encoder", "real")]
    [string]$Environment,

    [Parameter(Mandatory = $true, ParameterSetName = "All")]
    [switch]$All,

    [switch]$AllowMissing
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$RuntimeRoot = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot "tmp\studio-env"))
$Targets = if ($All) { @("seeded", "first-run", "blank-encoder", "real") } else { @($Environment) }

foreach ($Target in $Targets) {
    $TransitionMutex = $null
    $TransitionLockHeld = $false
    try {
        # Windows mutex ownership is recursive for the owning thread. A seed
        # or real-start transition can therefore call teardown while holding
        # this same mutex, while every direct caller remains unable to bypass
        # the lock.
        $TransitionMutex = [System.Threading.Mutex]::new(
            $false,
            "Local\KSXStudioEnvironment-$Target-transition"
        )
        try {
            $TransitionLockHeld = $TransitionMutex.WaitOne(0)
        } catch [System.Threading.AbandonedMutexException] {
            $TransitionLockHeld = $true
        }
        if (-not $TransitionLockHeld) {
            throw "Another process is building or swapping the '$Target' Studio environment. Teardown refused to race it."
        }

        $RecordPath = Join-Path $RuntimeRoot "$Target.json"
        if (-not (Test-Path -LiteralPath $RecordPath -PathType Leaf)) {
            if (-not $AllowMissing) { Write-Host "${Target}: no managed process record." }
            continue
        }

        $Record = Get-Content -LiteralPath $RecordPath -Raw | ConvertFrom-Json
        $ProcessId = [int]$Record.process_id
        $ExpectedExe = [System.IO.Path]::GetFullPath([string]$Record.executable)
        $ManagedPrefix = $RuntimeRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
        if (-not $ExpectedExe.StartsWith($ManagedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to stop ${Target}: recorded executable is outside $RuntimeRoot"
        }

        $Process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
        if ($Process) {
            $ActualExe = [System.IO.Path]::GetFullPath([string]$Process.ExecutablePath)
            if (-not $ActualExe.Equals($ExpectedExe, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Refusing to stop PID ${ProcessId}: it no longer owns the recorded executable."
            }
            Stop-Process -Id $ProcessId
            Wait-Process -Id $ProcessId -Timeout 10 -ErrorAction SilentlyContinue
            $Survivor = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
            if ($Survivor) {
                $SurvivorExe = [System.IO.Path]::GetFullPath([string]$Survivor.ExecutablePath)
                if ($SurvivorExe.Equals($ExpectedExe, [System.StringComparison]::OrdinalIgnoreCase)) {
                    throw "Refusing to forget ${Target}: PID $ProcessId did not exit within 10 seconds. Its managed record was retained."
                }
                throw "Refusing to forget ${Target}: PID $ProcessId was reused before exit could be verified. Its managed record was retained."
            }
            Write-Host "Stopped $Target (PID $ProcessId)."
        } elseif (-not $AllowMissing) {
            Write-Host "${Target}: recorded process is already stopped."
        }

        Remove-Item -LiteralPath $RecordPath -Force
        if (Test-Path -LiteralPath $ExpectedExe -PathType Leaf) {
            $RemovedExecutable = $false
            for ($Attempt = 0; $Attempt -lt 20; $Attempt += 1) {
                try {
                    Remove-Item -LiteralPath $ExpectedExe -Force -ErrorAction Stop
                    $RemovedExecutable = -not (Test-Path -LiteralPath $ExpectedExe)
                    if ($RemovedExecutable) { break }
                } catch {
                    if ($Attempt -lt 19) {
                        Start-Sleep -Milliseconds 100
                    }
                }
            }
            if (-not $RemovedExecutable) {
                Write-Warning "Stopped $Target, but Windows still has the disposable managed copy open. It remains under ignored tmp/studio-env and may be removed after the lock clears: $ExpectedExe"
            }
        }
    } finally {
        if ($TransitionLockHeld) {
            $TransitionMutex.ReleaseMutex()
        }
        if ($TransitionMutex) {
            $TransitionMutex.Dispose()
        }
    }
}
