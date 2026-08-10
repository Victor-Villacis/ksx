[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $DllPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'The disposable provider smoke must run in an already-elevated CI process.'
}

$dll = [IO.Path]::GetFullPath($DllPath)
if (-not (Test-Path -LiteralPath $dll -PathType Leaf)) {
    throw "libwdi DLL was not found at $dll"
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

[StructLayout(LayoutKind.Sequential)]
public struct KsxWdiDeviceInfo {
    public IntPtr next;
    public ushort vid;
    public ushort pid;
    public int is_composite;
    public byte mi;
    public IntPtr desc;
    public IntPtr driver;
    public IntPtr device_id;
    public IntPtr hardware_id;
    public IntPtr compatible_id;
    public IntPtr upper_filter;
    public ulong driver_version;
}

[StructLayout(LayoutKind.Sequential)]
public struct KsxWdiPrepareOptions {
    public int driver_type;
    public IntPtr vendor_name;
    public IntPtr device_guid;
    public int disable_cat;
    public int disable_signing;
    public IntPtr cert_subject;
    public int use_wcid_driver;
    public int external_inf;
}

public sealed class KsxLibwdiHandle : IDisposable {
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    public delegate int IsSupportedDelegate(int driverType, IntPtr driverInfo);

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    public delegate int PrepareDelegate(ref KsxWdiDeviceInfo device, IntPtr path,
        IntPtr inf, ref KsxWdiPrepareOptions options);

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    public delegate IntPtr StrErrorDelegate(int error);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibraryExW(string fileName, IntPtr file, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
    private static extern IntPtr GetProcAddress(IntPtr module, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeLibrary(IntPtr module);

    private IntPtr module;
    public IsSupportedDelegate IsSupported;
    public PrepareDelegate Prepare;
    public StrErrorDelegate StrError;

    private static T Export<T>(IntPtr module, string name) where T : class {
        IntPtr address = GetProcAddress(module, name);
        if (address == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Missing export " + name);
        return (T)(object)Marshal.GetDelegateForFunctionPointer(address, typeof(T));
    }

    public static KsxLibwdiHandle Load(string absolutePath) {
        const uint LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR = 0x00000100;
        const uint LOAD_LIBRARY_SEARCH_SYSTEM32 = 0x00000800;
        IntPtr module = LoadLibraryExW(absolutePath, IntPtr.Zero,
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
        if (module == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "LoadLibraryExW failed");
        KsxLibwdiHandle result = new KsxLibwdiHandle();
        result.module = module;
        try {
            result.IsSupported = Export<IsSupportedDelegate>(module, "wdi_is_driver_supported");
            result.Prepare = Export<PrepareDelegate>(module, "wdi_prepare_driver");
            result.StrError = Export<StrErrorDelegate>(module, "wdi_strerror");
            return result;
        } catch {
            result.Dispose();
            throw;
        }
    }

    public void Dispose() {
        if (module != IntPtr.Zero) {
            FreeLibrary(module);
            module = IntPtr.Zero;
        }
    }
}

public static class KsxProviderSecurityProbe {
    private const string Provider = "Microsoft Enhanced RSA and AES Cryptographic Provider";
    private const uint ProvRsaAes = 24;
    private const uint CryptMachineKeyset = 0x20;
    private const uint CryptSilent = 0x40;
    private const uint CryptVerifyContext = 0xF0000000;
    private const uint CryptDeleteKeyset = 0x10;
    private const uint PpEnumContainers = 2;
    private const uint CryptFirst = 1;
    private const int ErrorNoMoreItems = 259;

    [DllImport("crypt32.dll", SetLastError = true)]
    private static extern bool CertGetCertificateContextProperty(
        IntPtr certContext, uint propertyId, IntPtr data, ref uint size);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CryptAcquireContextW(ref IntPtr provider, string container,
        string providerName, uint providerType, uint flags);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CryptGetProvParam(IntPtr provider, uint parameter,
        byte[] data, ref uint dataLength, uint flags);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CryptReleaseContext(IntPtr provider, uint flags);

    public static int ProbeCertificateProperty(IntPtr certContext, uint propertyId) {
        uint size = 0;
        Marshal.GetLastWin32Error();
        if (CertGetCertificateContextProperty(certContext, propertyId, IntPtr.Zero, ref size))
            return 1;
        uint error = unchecked((uint)Marshal.GetLastWin32Error());
        return error == 0x80092004U ? 0 : -1; // CRYPT_E_NOT_FOUND
    }

    public static string[] OwnedContainers() {
        IntPtr provider = IntPtr.Zero;
        if (!CryptAcquireContextW(ref provider, null, Provider, ProvRsaAes,
            CryptVerifyContext | CryptMachineKeyset | CryptSilent))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not enumerate CAPI containers");
        try {
            List<string> owned = new List<string>();
            byte[] data = new byte[512];
            uint flags = CryptFirst;
            while (true) {
                uint size = (uint)data.Length;
                if (!CryptGetProvParam(provider, PpEnumContainers, data, ref size, flags)) {
                    int error = Marshal.GetLastWin32Error();
                    if (error == ErrorNoMoreItems)
                        break;
                    throw new Win32Exception(error, "Could not enumerate CAPI containers");
                }
                flags = 0;
                int count = (int)size;
                if (count > 0 && data[count - 1] == 0)
                    count--;
                string name = Encoding.ASCII.GetString(data, 0, count);
                if (name.StartsWith("KSX-libwdi-", StringComparison.Ordinal))
                    owned.Add(name);
            }
            return owned.ToArray();
        } finally {
            CryptReleaseContext(provider, 0);
        }
    }

    public static void DeleteOwnedContainer(string name) {
        if (name == null || !name.StartsWith("KSX-libwdi-", StringComparison.Ordinal))
            throw new ArgumentException("Refusing non-KSX container cleanup");
        IntPtr ignored = IntPtr.Zero;
        if (!CryptAcquireContextW(ref ignored, name, Provider, ProvRsaAes,
            CryptMachineKeyset | CryptSilent | CryptDeleteKeyset))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not clean exact KSX CAPI container");
    }
}
'@

if ([Runtime.InteropServices.Marshal]::SizeOf([type][KsxWdiDeviceInfo]) -ne 80) {
    throw 'wdi_device_info x64 layout drifted from 80 bytes'
}
if ([Runtime.InteropServices.Marshal]::SizeOf([type][KsxWdiPrepareOptions]) -ne 48) {
    throw 'wdi_options_prepare_driver x64 layout drifted from 48 bytes'
}

$transaction = [Guid]::NewGuid().ToString('N')
$subject = "CN=KSX WinUSB $transaction"
$output = Join-Path $env:ProgramFiles "ksx-libwdi-smoke-$transaction"
$infName = 'ksx-winusb-provider-smoke.inf'
$infPath = Join-Path $output $infName
$catPath = [IO.Path]::ChangeExtension($infPath, '.cat')
$template = Join-Path $PSScriptRoot 'src\winusb.inf.in'
$machineKeys = Join-Path $env:ProgramData 'Microsoft\Crypto\RSA\MachineKeys'
$pnputil = Join-Path $env:SystemRoot 'System32\pnputil.exe'
# Deliberately NOT under $output: that directory is asserted to hold the INF and
# the CAT and nothing else, which is a check worth keeping.
$pnputilLogs = Join-Path ([IO.Path]::GetTempPath()) "ksx-pnputil-$transaction"
$allocated = [Collections.Generic.List[IntPtr]]::new()
$cleanupErrors = [Collections.Generic.List[string]]::new()
$provider = $null
$createdOutput = $false
$ownedBefore = @()
$keysBefore = @()
$publishedBefore = @()
$publishedName = $null
$addAttempted = $false
$publishedNamesToDelete = [Collections.Generic.List[string]]::new()

function New-AnsiPointer([string] $Value) {
    $pointer = [Runtime.InteropServices.Marshal]::StringToHGlobalAnsi($Value)
    $allocated.Add($pointer)
    return $pointer
}

function Get-TransactionCertificates([string] $StoreName) {
    $store = [Security.Cryptography.X509Certificates.X509Store]::new(
        $StoreName,
        [Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine)
    $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
    try {
        return @($store.Certificates | Where-Object { $_.Subject -ceq $subject })
    }
    finally {
        $store.Close()
    }
}

function Remove-TransactionCertificates([string] $StoreName) {
    $store = [Security.Cryptography.X509Certificates.X509Store]::new(
        $StoreName,
        [Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine)
    $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    try {
        foreach ($certificate in @($store.Certificates | Where-Object { $_.Subject -ceq $subject })) {
            $store.Remove($certificate)
        }
    }
    finally {
        $store.Close()
    }
}

function Get-ExactPublishedPackages([string] $Enumeration) {
    $result = [Collections.Generic.List[string]]::new()
    foreach ($block in @($Enumeration -split '(?im)(?=^Published Name\s*:)')) {
        $published = [regex]::Match($block, '(?im)^Published Name\s*:\s*(oem\d+\.inf)\s*$')
        $original = [regex]::Match($block, '(?im)^Original Name\s*:\s*' +
            [regex]::Escape($infName) + '\s*$')
        $vendor = [regex]::Match($block, '(?im)^Provider Name\s*:\s*KSX\s*$')
        if ($published.Success -and $original.Success -and $vendor.Success) {
            $name = $published.Groups[1].Value.ToLowerInvariant()
            if ($name -notin $publishedBefore -and -not $result.Contains($name)) {
                $result.Add($name)
            }
        }
    }
    return @($result)
}

# Where a hang happened, stated by the only party that can still speak. The
# provider writes its own log to stdout, but the CRT buffers that when stdout is
# a pipe, so a call that never returns takes its explanation with it. These are
# flushed per line from PowerShell, so the last one printed is load-bearing.
function Write-Phase([string] $Phase) {
    Write-Host "smoke phase: $Phase"
    [Console]::Out.Flush()
}

# certutil prints a member tag as the hex of its UTF-16 bytes, so "77EB..."
# appears as "37003700450042...". Searching only the plain form once answered
# "the hash is absent" about a catalogue that contained it -- the same class of
# mistake as the message being diagnosed. Check both spellings.
function Test-DumpCarriesHash([string] $Dump, [string] $HexHash) {
    if ([string]::IsNullOrWhiteSpace($Dump) -or [string]::IsNullOrWhiteSpace($HexHash)) {
        return $false
    }
    $utf16 = ($HexHash.ToCharArray() | ForEach-Object { '{0:X2}00' -f [int]$_ }) -join ''
    return ($Dump -match [regex]::Escape($HexHash)) -or ($Dump -match [regex]::Escape($utf16))
}

# Every MUTATING pnputil verb, run so that its output cannot deadlock us.
#
# `@(& $pnputil /add-driver $infPath 2>&1)` blocked for fifteen minutes on a
# runner where pnputil itself had long since exited. The mutating verbs hand
# their work to the device-install stack, DrvInst.exe inherits the redirected
# pipe, and PowerShell keeps reading a pipe that nobody left alive intends to
# close. `/enum-drivers` spawns nothing, which is exactly why the snapshot calls
# never hung and these three did.
#
# Files instead of pipes: a handle a grandchild may inherit and hold for as long
# as it likes, because nothing here is waiting on it. Read the output back after
# the process we DID start has exited.
function Invoke-Pnputil([string] $Label, [string[]] $PnputilArguments) {
    if (-not (Test-Path -LiteralPath $pnputilLogs)) {
        New-Item -ItemType Directory -Path $pnputilLogs -Force | Out-Null
    }
    $stdoutPath = Join-Path $pnputilLogs "$Label.out"
    $stderrPath = Join-Path $pnputilLogs "$Label.err"
    # -ArgumentList joins an array with spaces and quotes nothing, unlike the
    # call operator. The INF lives under "C:\Program Files\...", deliberately,
    # so an unquoted path reaches pnputil as two arguments and it answers with
    # its usage screen and exit code 1 -- which reads exactly like Windows
    # rejecting the package, and is not that at all.
    $quoted = @(foreach ($argument in $PnputilArguments) {
        if ($argument -match '\s') { '"' + $argument + '"' } else { $argument }
    })
    $process = Start-Process -FilePath $pnputil -ArgumentList $quoted `
        -NoNewWindow -PassThru `
        -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    # Bounded here rather than only by the workflow step: a step timeout kills
    # this process outright, so `finally` never runs and the runner keeps our
    # certificates, key containers and staged package. Failing on our own terms
    # keeps the cleanup guarantee that the whole smoke exists to demonstrate.
    $timedOut = -not $process.WaitForExit(240000)
    if ($timedOut) {
        try { $process.Kill() } catch { }
        try { [void]$process.WaitForExit(5000) } catch { }
    }
    $lines = @()
    foreach ($path in @($stdoutPath, $stderrPath)) {
        if (Test-Path -LiteralPath $path) {
            $lines += @(Get-Content -LiteralPath $path)
        }
    }
    $exit = if ($timedOut) { -1 } else { $process.ExitCode }
    return [pscustomobject]@{ ExitCode = $exit; TimedOut = $timedOut; Lines = $lines }
}

try {
    Write-Phase 'snapshotting runner state'
    $ownedBefore = @([KsxProviderSecurityProbe]::OwnedContainers())
    if ($ownedBefore.Count -ne 0) {
        throw "Disposable runner began with unexpected KSX key containers: $($ownedBefore -join ', ')"
    }
    $keysBefore = @(Get-ChildItem -LiteralPath $machineKeys -Force | ForEach-Object Name)
    $enumBeforeLines = @(& $pnputil /enum-drivers 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw 'pnputil could not snapshot the disposable runner Driver Store.'
    }
    $enumBefore = $enumBeforeLines -join "`n"
    $publishedBefore = @(
        [regex]::Matches($enumBefore, '(?im)^Published Name\s*:\s*(oem\d+\.inf)\s*$') |
        ForEach-Object { $_.Groups[1].Value.ToLowerInvariant() }
    )
    # `@()` around the call, not just inside the function: PowerShell unrolls a
    # returned empty array to $null, and `Set-StrictMode -Version Latest` makes
    # $null.Count a terminating error. Without this the check explodes on
    # exactly the state it is asserting -- a runner with no such certificate.
    if (@(Get-TransactionCertificates 'Root').Count -ne 0 -or
        @(Get-TransactionCertificates 'TrustedPublisher').Count -ne 0) {
        throw 'The unique smoke certificate subject unexpectedly existed before preparation.'
    }

    if (Test-Path -LiteralPath $output) {
        throw "Refusing to reuse smoke directory $output"
    }
    New-Item -ItemType Directory -Path $output | Out-Null
    $createdOutput = $true
    Copy-Item -LiteralPath $template -Destination $infPath

    Write-Phase "loading provider $dll"
    $provider = [KsxLibwdiHandle]::Load($dll)
    Write-Phase 'checking WinUSB-only support contract'
    if ($provider.IsSupported.Invoke(0, [IntPtr]::Zero) -eq 0 -or
        $provider.IsSupported.Invoke(1, [IntPtr]::Zero) -ne 0) {
        throw 'Provider support contract is not WinUSB-only.'
    }

    $device = [KsxWdiDeviceInfo]::new()
    $device.vid = 0x1209
    $device.pid = 0x4B53
    $device.is_composite = 1
    $device.mi = 1
    $device.desc = New-AnsiPointer 'KSX WinUSB Keyboard Interface'

    $options = [KsxWdiPrepareOptions]::new()
    $options.driver_type = 0
    $options.vendor_name = New-AnsiPointer 'KSX'
    $options.device_guid = New-AnsiPointer '{B8B2D1F8-6E0E-4C7F-9E5A-3A9C1D6F2E10}'
    $options.cert_subject = New-AnsiPointer $subject
    $options.external_inf = 1

    $outputPointer = New-AnsiPointer $output
    $infPointer = New-AnsiPointer $infPath
    # The one call that signs: it builds the catalogue, generates a machine
    # key, self-signs, and adds the certificate to LocalMachine Root and
    # TrustedPublisher. Every local probe of this provider ran with
    # disable_signing, so this line is the first place that path has ever been
    # exercised anywhere.
    Write-Phase 'invoking wdi_prepare_driver (catalogue + self-signing)'
    $result = $provider.Prepare.Invoke([ref] $device, $outputPointer, $infPointer, [ref] $options)
    Write-Phase "wdi_prepare_driver returned $result"
    if ($result -ne 0) {
        $message = [Runtime.InteropServices.Marshal]::PtrToStringAnsi(
            $provider.StrError.Invoke($result))
        throw "wdi_prepare_driver failed with $result ($message)"
    }

    if (-not (Test-Path -LiteralPath $infPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $catPath -PathType Leaf)) {
        throw 'Provider success did not produce the exact INF and CAT.'
    }

    # Windows staging reports ERROR_FILE_HASH_NOT_IN_CATALOG (0xE000024B): the
    # catalogue is validly signed but carries no hash matching the INF. There
    # are exactly two ways to arrive there, and they need opposite fixes, so
    # measure rather than reason about it.
    #
    #   the catalogue does NOT hold the INF's current hash -> the INF was
    #     written, hashed, and then written again; the hash is of bytes that no
    #     longer exist on disk.
    #   the catalogue DOES hold it -> the bytes agree and it is the member
    #     metadata Windows will not accept.
    Write-Phase 'comparing the INF hash against the catalogue members'
    # Both, because the catalogue's member digest and the catalogue's declared
    # algorithm have to agree and either one can be the wrong one.
    $infSha1 = (Get-FileHash -LiteralPath $infPath -Algorithm SHA1).Hash
    $infSha256 = (Get-FileHash -LiteralPath $infPath -Algorithm SHA256).Hash
    $infInfo = Get-Item -LiteralPath $infPath
    $catInfo = Get-Item -LiteralPath $catPath
    Write-Host "DIAG: INF SHA-1        = $infSha1"
    Write-Host "DIAG: INF SHA-256      = $infSha256"
    Write-Host "DIAG: INF bytes/written= $($infInfo.Length) / $($infInfo.LastWriteTime.ToString('HH:mm:ss.fff'))"
    Write-Host "DIAG: CAT bytes/written= $($catInfo.Length) / $($catInfo.LastWriteTime.ToString('HH:mm:ss.fff'))"
    $catalogueDump = ''
    try {
        $certutil = Join-Path $env:SystemRoot 'System32\certutil.exe'
        # certutil reads a file and spawns no device-install stack, so the pipe
        # form is safe here in a way the mutating pnputil verbs are not.
        $catalogueDump = (@(& $certutil -dump $catPath 2>&1) -join "`n")
        Write-Host '--- certutil -dump of the catalogue, first 60 lines ---'
        @($catalogueDump -split "`n") | Select-Object -First 60 | ForEach-Object { Write-Host $_ }
        Write-Host '--- end catalogue dump ---'
    } catch {
        Write-Host "DIAG: catalogue could not be dumped: $($_.Exception.Message)"
    }
    $carriesSha1 = Test-DumpCarriesHash $catalogueDump $infSha1
    $carriesSha256 = Test-DumpCarriesHash $catalogueDump $infSha256
    # ...12.1.2 declares SHA-1 members, ...12.1.3 declares SHA-256. Windows
    # hashes the INF with whichever the catalogue claims, so a claim that does
    # not match the tags means it looks up a digest nothing carries.
    $declared =
        if ($catalogueDump -match '1\.3\.6\.1\.4\.1\.311\.12\.1\.3') { 'SHA-256' }
        elseif ($catalogueDump -match '1\.3\.6\.1\.4\.1\.311\.12\.1\.2') { 'SHA-1' }
        else { 'unknown' }
    $tagged =
        if ($carriesSha1 -and -not $carriesSha256) { 'SHA-1' }
        elseif ($carriesSha256 -and -not $carriesSha1) { 'SHA-256' }
        elseif ($carriesSha1 -and $carriesSha256) { 'both' }
        else { 'neither' }
    Write-Host "DIAG VERDICT: catalogue declares $declared members and carries the INF's $tagged hash."
    if ($declared -eq 'unknown' -and $tagged -eq 'neither') {
        # Abstain rather than pass or fail: certutil told us nothing, and
        # /add-driver below is the authority anyway, now that it is bounded.
        Write-Host 'DIAG VERDICT: the catalogue could not be read, so this check abstains.'
    } elseif ($tagged -eq 'neither' -or $declared -ne $tagged) {
        # A THROW, not a warning. This exact disagreement -- SHA-256 tags inside
        # a catalogue that declared SHA-1 -- cost thirteen CI runs, because its
        # only symptom was `pnputil /add-driver` never returning. Windows hashes
        # the INF with whatever the catalogue claims, matches nothing, treats
        # the package as unsigned, and raises a signing prompt no unattended
        # machine can answer. A hang is not a diagnosis, so fail here, by name,
        # before the thing that hangs.
        throw (
            "Catalogue algorithm disagreement: it declares $declared members and carries " +
            "the INF's $tagged hash. Windows will hash the INF with $declared and match " +
            'nothing, which reads as unsigned and prompts. See third_party/libwdi/README-KSX.md.'
        )
    } else {
        Write-Host 'DIAG VERDICT: declaration and tags agree, so any refusal is about something else.'
    }
    [Console]::Out.Flush()
    $unexpected = @(Get-ChildItem -LiteralPath $output -File | Where-Object {
        $_.Name -notin @($infName, [IO.Path]::GetFileName($catPath))
    })
    if ($unexpected.Count -ne 0) {
        throw "Provider emitted unexpected payloads: $($unexpected.Name -join ', ')"
    }

    $root = @(Get-TransactionCertificates 'Root')
    $publisher = @(Get-TransactionCertificates 'TrustedPublisher')
    if ($root.Count -ne 1 -or $publisher.Count -ne 1) {
        throw "Expected one exact certificate in each store; Root=$($root.Count), TrustedPublisher=$($publisher.Count)"
    }
    $rootDer = [Convert]::ToBase64String($root[0].RawData)
    $publisherDer = [Convert]::ToBase64String($publisher[0].RawData)
    if ($rootDer -cne $publisherDer) {
        throw 'Root and TrustedPublisher do not contain identical certificate DER.'
    }
    $sha1 = [Security.Cryptography.SHA1]::Create()
    try {
        $thumbprint = [BitConverter]::ToString($sha1.ComputeHash($root[0].RawData)).Replace('-', '')
    }
    finally {
        $sha1.Dispose()
    }
    if ($root[0].Thumbprint -cne $thumbprint -or $publisher[0].Thumbprint -cne $thumbprint) {
        throw 'Certificate SHA-1 thumbprint did not match the exact DER.'
    }
    foreach ($certificate in @($root[0], $publisher[0])) {
        if ($certificate.HasPrivateKey) {
            throw 'A trusted provider certificate still has a private key.'
        }
        foreach ($property in @(1, 2, 5, 78)) {
            if ([KsxProviderSecurityProbe]::ProbeCertificateProperty($certificate.Handle, $property) -ne 0) {
                throw "Trusted certificate property $property was present or could not be proved absent."
            }
        }
    }
    $now = [DateTime]::Now
    if ($root[0].NotBefore -lt $now.AddMinutes(-15) -or
        $root[0].NotBefore -gt $now.AddMinutes(5) -or
        $root[0].NotAfter -lt $now.AddDays(3650) -or
        $root[0].NotAfter -gt $now.AddDays(3670)) {
        throw 'Certificate validity is not relative to this transaction.'
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $catPath
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
        $null -eq $signature.SignerCertificate -or
        [Convert]::ToBase64String($signature.SignerCertificate.RawData) -cne $rootDer) {
        throw "Catalog Authenticode verification failed: $($signature.Status)"
    }

    # Driver Store acceptance is the authoritative package proof. There is no
    # `/install`: this synthetic HWID cannot bind a device on the runner.
    $addAttempted = $true
    Write-Phase 'pnputil /add-driver (Driver Store acceptance)'
    $add = Invoke-Pnputil 'add-driver' @('/add-driver', $infPath)
    $addLines = $add.Lines
    $addExit = $add.ExitCode
    Write-Phase "pnputil /add-driver exited $addExit"
    $addOutput = $addLines -join "`n"
    $reported = [regex]::Match($addOutput, '(?im)^Published Name\s*:\s*(oem\d+\.inf)\s*$')
    if ($reported.Success) {
        $reportedName = $reported.Groups[1].Value.ToLowerInvariant()
        if ($reportedName -notin $publishedBefore) {
            $publishedNamesToDelete.Add($reportedName)
        }
    }
    $enumAfterLines = @(& $pnputil /enum-drivers 2>&1)
    $enumAfterExit = $LASTEXITCODE
    $enumAfter = $enumAfterLines -join "`n"
    $exactPackages = @(Get-ExactPublishedPackages $enumAfter)
    foreach ($package in $exactPackages) {
        if (-not $publishedNamesToDelete.Contains($package)) {
            $publishedNamesToDelete.Add($package)
        }
    }
    if ($add.TimedOut) {
        # Ask Windows what it was doing rather than guess. setupapi.dev.log is
        # SetupAPI's own account of staging, and the last lines of it are
        # written by whatever we are stuck behind.
        Write-Phase 'blocked; dumping SetupAPI''s own account'
        $setupapi = Join-Path $env:SystemRoot 'INF\setupapi.dev.log'
        try {
            if (Test-Path -LiteralPath $setupapi) {
                Write-Host '--- setupapi.dev.log, last 150 lines ---'
                Get-Content -LiteralPath $setupapi -Tail 150 -ErrorAction Stop |
                    ForEach-Object { Write-Host $_ }
                Write-Host '--- end setupapi.dev.log ---'
            } else {
                Write-Host "setupapi.dev.log is not at $setupapi"
            }
        } catch {
            Write-Host "setupapi.dev.log could not be read: $($_.Exception.Message)"
        }
        [Console]::Out.Flush()
        # Deliberately not "Windows rejected the package". It did not reject it;
        # it never answered. Nothing about the provider is proven or disproven
        # by a Driver Store that will not respond.
        throw 'pnputil /add-driver did not return within the smoke budget. The Driver Store neither accepted nor rejected the package.'
    }
    if ($addExit -ne 0) {
        # Also not "rejected": a malformed command line lands here too, and once
        # did, wearing that far more alarming sentence.
        throw "pnputil /add-driver exited $addExit without staging the package:`n$addOutput"
    }
    if ($enumAfterExit -ne 0) {
        throw 'pnputil could not enumerate the accepted package.'
    }
    if ($exactPackages.Count -ne 1) {
        throw "Expected one new exact Driver Store package for $infName; found $($exactPackages.Count)."
    }
    $publishedName = $exactPackages[0]
    if ($reported.Success -and $reportedName -cne $publishedName) {
        throw "pnputil reported $reportedName but exact enumeration found $publishedName."
    }
    $ownedAfter = @([KsxProviderSecurityProbe]::OwnedContainers())
    if ($ownedAfter.Count -ne 0) {
        throw "Provider returned with owned private-key containers: $($ownedAfter -join ', ')"
    }
}
finally {
    if ($addAttempted) {
        try {
            $cleanupEnumLines = @(& $pnputil /enum-drivers 2>&1)
            if ($LASTEXITCODE -eq 0) {
                foreach ($package in @(Get-ExactPublishedPackages ($cleanupEnumLines -join "`n"))) {
                    if (-not $publishedNamesToDelete.Contains($package)) {
                        $publishedNamesToDelete.Add($package)
                    }
                }
            }
        } catch { $cleanupErrors.Add("Driver Store cleanup discovery failed: $($_.Exception.Message)") }
    }
    foreach ($package in @($publishedNamesToDelete | Select-Object -Unique)) {
        $delete = Invoke-Pnputil "delete-$package" @('/delete-driver', $package, '/uninstall', '/force')
        $deleteLines = $delete.Lines
        if ($delete.ExitCode -ne 0) {
            $cleanupErrors.Add("pnputil could not delete exact package $package`: $($deleteLines -join ' ')")
        }
        $scan = Invoke-Pnputil "scan-$package" @('/scan-devices')
        $scanLines = $scan.Lines
        if ($scan.ExitCode -ne 0) {
            $cleanupErrors.Add("pnputil rescan failed: $($scanLines -join ' ')")
        }
        $finalEnumLines = @(& $pnputil /enum-drivers 2>&1)
        $finalEnum = $finalEnumLines -join "`n"
        if ($LASTEXITCODE -ne 0 -or
            $finalEnum -match ('(?im)^Published Name\s*:\s*' + [regex]::Escape($package) + '\s*$')) {
            $cleanupErrors.Add("Driver Store package $package survived exact cleanup.")
        }
    }
    try {
        if ($null -ne $provider) {
            $provider.Dispose()
        }
    } catch { $cleanupErrors.Add("DLL unload failed: $($_.Exception.Message)") }
    foreach ($pointer in $allocated) {
        try { [Runtime.InteropServices.Marshal]::FreeHGlobal($pointer) }
        catch { $cleanupErrors.Add("FFI allocation cleanup failed: $($_.Exception.Message)") }
    }
    try { Remove-TransactionCertificates 'TrustedPublisher' }
    catch { $cleanupErrors.Add("TrustedPublisher cleanup failed: $($_.Exception.Message)") }
    try { Remove-TransactionCertificates 'Root' }
    catch { $cleanupErrors.Add("Root cleanup failed: $($_.Exception.Message)") }

    try {
        $ownedNow = @([KsxProviderSecurityProbe]::OwnedContainers())
        foreach ($container in $ownedNow) {
            if ($container -notin $ownedBefore) {
                [KsxProviderSecurityProbe]::DeleteOwnedContainer($container)
            }
        }
        if (@([KsxProviderSecurityProbe]::OwnedContainers()).Count -ne $ownedBefore.Count) {
            $cleanupErrors.Add('Exact CAPI container cleanup did not restore the initial state.')
        }
    } catch { $cleanupErrors.Add("CAPI container cleanup failed: $($_.Exception.Message)") }
    try {
        # Same unrolling trap as the pre-flight check above, and worse here:
        # zero certificates IS success, so the unguarded form reported a
        # cleanup failure precisely when cleanup had worked.
        if (@(Get-TransactionCertificates 'Root').Count -ne 0 -or
            @(Get-TransactionCertificates 'TrustedPublisher').Count -ne 0) {
            $cleanupErrors.Add('Exact certificate cleanup did not restore the initial state.')
        }
    } catch { $cleanupErrors.Add("Certificate cleanup verification failed: $($_.Exception.Message)") }
    try {
        $keysAfter = @(Get-ChildItem -LiteralPath $machineKeys -Force | ForEach-Object Name)
        $newKeyFiles = @($keysAfter | Where-Object { $_ -notin $keysBefore })
        if ($newKeyFiles.Count -ne 0) {
            $cleanupErrors.Add("Machine key files survived the transaction: $($newKeyFiles -join ', ')")
        }
    } catch { $cleanupErrors.Add("Machine-key file verification failed: $($_.Exception.Message)") }
    if ($createdOutput) {
        try { Remove-Item -LiteralPath $output -Recurse -Force }
        catch { $cleanupErrors.Add("Smoke work-directory cleanup failed: $($_.Exception.Message)") }
    }
    if (Test-Path -LiteralPath $pnputilLogs) {
        try { Remove-Item -LiteralPath $pnputilLogs -Recurse -Force }
        catch { $cleanupErrors.Add("pnputil log cleanup failed: $($_.Exception.Message)") }
    }
    if ($cleanupErrors.Count -ne 0) {
        throw ($cleanupErrors -join "`n")
    }
}

Write-Host 'libwdi disposable provider smoke passed; Driver Store, certificates, keys, and files restored runner state.'
