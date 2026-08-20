using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using HIDMaestro.Internal;
using Microsoft.Win32;

namespace Ksx.HidMaestroHost;

internal sealed class HidMaestroPackageUnavailableException : Exception
{
    internal HidMaestroPackageUnavailableException(string message) : base(message) { }
}

internal sealed class WindowsDeviceManager : IRuntimeExactDeviceManager
{
    private const string ControllerKey = @"SOFTWARE\HIDMaestro\Controller0";
    private const string OwnershipName = "KSXRuntimeOwner";
    private const string OwnershipValue = "ksx-hidmaestro-host-v1";
    private const string ExpectedInfSha256 = "187D5B06625CEECC0E1B43C0FA8DDA5F6DAB6A9962F79B037BBAD419F1084704";
    // SHA-256 the SDK's installer writes over its five UNSIGNED payload
    // resources (HKLM\SOFTWARE\HIDMaestro\InstalledManifestSha256).
    // Deterministic per SDK version — unlike the installed driver DLL's bytes,
    // which InstallDriver() re-signs with an install-time-generated test
    // certificate (measured 2026-08-20: signing appends ~1.4 KB and the cert's
    // NotBefore is the install second minus a day). An earlier revision pinned
    // the installed DLL bytes and therefore refused every legitimate install.
    private const string ExpectedManifestSha256 = "2f5c0313b3ea6fa79179a501648d9ff1b4330fbc4d1ab23294be14885edb2d8c";
    private const string HardwareId = @"root\VID_054C&PID_0CE6";
    private const uint CrSuccess = 0;
    private const uint CrNoSuchDevnode = 0x0000000D;
    private static readonly Guid HidClass = new("745a17a0-74d3-11d0-b6fe-00a0c90f57da");
    private static readonly byte[] Descriptor = Convert.FromHexString(
        "05010905A1018501093009310932093509330934150026FF007508950681020600FF09209501810205010939150025073500463B016514750495018142650005091901290F150025017501950F81020600FF0921950D81020600FF0922150026FF0075089534810285020923952F9102850509339528B10285080934952FB102850909249513B102850A0925951AB10285200926953FB102852109279504B10285220940953FB10285800928953FB10285810929953FB1028582092A9509B1028583092B953FB1028584092C953FB1028585092D9502B10285A0092E9501B10285E0092F953FB10285F00930953FB10285F10931953FB10285F20932950FB10285F40935953FB10285F509369503B102C0");

    private readonly object _gate = new();
    private string? _ownedParent;
    private readonly HashSet<string> _ownedChildren = new(StringComparer.OrdinalIgnoreCase);

    public RuntimePreinstalledPackageProof ProvePreinstalledDualSensePackage()
    {
        string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            @"System32\DriverStore\FileRepository");
        // Directories only: the Driver Store keeps a "<package>.ini" sidecar
        // FILE beside every package directory whose name matches the same
        // prefix; EnumerateFileSystemEntries counted it and made "exactly one
        // package" see two on every staged machine (measured 2026-08-20).
        string[] packages = Directory.EnumerateDirectories(
            root,
            "hidmaestro.inf_amd64_*",
            SearchOption.TopDirectoryOnly).ToArray();
        if (packages.Length != 1)
            throw new HidMaestroPackageUnavailableException(
                "Exactly one pinned HIDMaestro v1.6.1 Driver Store package is required.");
        var info = new DirectoryInfo(packages[0]);
        if ((info.Attributes & FileAttributes.Directory) == 0
            || (info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new HidMaestroPackageUnavailableException(
                "The HIDMaestro Driver Store package path is not an ordinary directory.");
        string inf = Path.Combine(packages[0], "hidmaestro.inf");
        string dll = Path.Combine(packages[0], "HIDMaestro.dll");
        if (!File.Exists(inf) || !File.Exists(dll))
            throw new HidMaestroPackageUnavailableException(
                "The HIDMaestro Driver Store package is incomplete.");
        string infHash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(inf)));
        if (!infHash.Equals(ExpectedInfSha256, StringComparison.Ordinal))
            throw new HidMaestroPackageUnavailableException(
                "The HIDMaestro Driver Store package INF does not match pinned v1.6.1 bytes.");
        // The DLL's presence was proven above; its bytes are not compared —
        // they are re-signed per install. Version identity comes from the
        // SDK's own installed-payload manifest instead.
        using RegistryKey? manifestKey = Registry.LocalMachine.OpenSubKey(
            @"SOFTWARE\HIDMaestro", writable: false);
        string? manifest = manifestKey?.GetValue("InstalledManifestSha256") as string;
        if (manifest is null
            || !manifest.Equals(ExpectedManifestSha256, StringComparison.OrdinalIgnoreCase))
            throw new HidMaestroPackageUnavailableException(
                "The installed HIDMaestro payload manifest does not match pinned v1.6.1.");
        // The HIDMaestro service key is deliberately NOT required here: the
        // UMDF service materialises when the FIRST root\HIDMaestro devnode
        // binds the INF, so requiring it would refuse the very install whose
        // first controller creation is about to create it.
        return new RuntimePreinstalledPackageProof(ExpectedInfSha256);
    }

    /// <summary>
    /// Re-derives the pinned Driver Store package's INF path for the
    /// registration-time bind, re-proving byte identity fail-closed. The
    /// package proof deliberately stays an identity (not a path): re-walking
    /// here means a package swapped between proof and registration is refused
    /// rather than silently bound.
    /// </summary>
    private static string PinnedPackageInfPath()
    {
        string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            @"System32\DriverStore\FileRepository");
        string[] packages = Directory.EnumerateDirectories(
            root,
            "hidmaestro.inf_amd64_*",
            SearchOption.TopDirectoryOnly).ToArray();
        if (packages.Length != 1)
            throw new InvalidOperationException(
                "Exactly one pinned HIDMaestro v1.6.1 Driver Store package is required for binding.");
        string inf = Path.Combine(packages[0], "hidmaestro.inf");
        string infHash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(inf)));
        if (!infHash.Equals(ExpectedInfSha256, StringComparison.Ordinal))
            throw new InvalidOperationException(
                "The HIDMaestro Driver Store package INF changed between proof and binding.");
        return inf;
    }

    public RuntimeDeviceRegistration RegisterPlainHidDualSense(RuntimePreinstalledPackageProof proof)
    {
        ArgumentNullException.ThrowIfNull(proof);
        if (!proof.PackageIdentity.Equals(ExpectedInfSha256, StringComparison.Ordinal))
            throw new InvalidOperationException("The HIDMaestro package proof is not the pinned package.");
        lock (_gate)
        {
            if (_ownedParent is not null) throw new InvalidOperationException("This host already owns a controller.");
            RecoverOwnedResidue();
            using (RegistryKey? existing = Registry.LocalMachine.OpenSubKey(ControllerKey, writable: false))
            {
                if (existing is not null) throw new InvalidOperationException("HIDMaestro controller slot zero is already configured.");
            }
            CreateConfiguration();
            string? parent = null;
            try
            {
                parent = RegisterRootDevice();
                using RegistryKey parameters = Registry.LocalMachine.CreateSubKey(
                    $@"SYSTEM\CurrentControlSet\Enum\{parent}\Device Parameters", writable: true)
                    ?? throw new InvalidOperationException("The exact device parameter key could not be opened.");
                parameters.SetValue("ControllerIndex", 0, RegistryValueKind.DWord);
                using RegistryKey config = Registry.LocalMachine.OpenSubKey(ControllerKey, writable: true)
                    ?? throw new InvalidOperationException("The exact controller configuration disappeared.");
                config.SetValue("DeviceInstanceId", parent, RegistryValueKind.String);
                // Bind the pinned package to the fresh root devnode.
                // DIF_REGISTERDEVICE only CREATES the node — nothing installs
                // a driver on it, and a driverless root devnode never
                // enumerates the HID child (measured 2026-08-20: zero PnP
                // sections in setupapi.dev.log across three attempts while
                // ProveExactParentBound burned its full wait each time).
                // Upstream v1.6.1 makes this exact call after registration
                // (DeviceNodeCreator.cs), warning in its own words that a
                // failure here means "downstream waits will time out".
                if (!UpdateDriverForPlugAndPlayDevicesW(0, HardwareId, PinnedPackageInfPath(), 0, out _))
                    throw Last("The pinned HIDMaestro package could not be bound to the exact DualSense root.");
                _ownedParent = parent;
                return new RuntimeDeviceRegistration(parent);
            }
            catch
            {
                if (parent is not null) TryUninstall(parent);
                DeleteOwnedConfiguration();
                throw;
            }
        }
    }

    public void ProveExactParentBound(RuntimeDeviceRegistration registration)
    {
        ValidateParent(registration);
        // 12 s, deliberately INSIDE the Rust client's CREATE_TIMEOUT (15 s):
        // the host must answer with a definite Created/Fault before the
        // client's transport deadline, or a slow first bind reads as a torn
        // lane instead of a named refusal (measured 2026-08-20: the previous
        // 15 s wait raced CREATE_TIMEOUT to a photo finish — 15.2 s walls —
        // and the client always left ~0.1 s before the host's fault arrived).
        DateTime deadline = DateTime.UtcNow.AddSeconds(12);
        while (true)
        {
            IReadOnlyList<string> children = DirectChildren(registration.ParentInstanceId);
            bool proven = false;
            bool pending = children.Count == 0;
            foreach (string child in children)
            {
                switch (ChildIdentity(child))
                {
                    case ChildKind.ExactDualSense:
                        proven = true;
                        break;
                    case ChildKind.Foreign:
                        throw new InvalidOperationException(
                            $"The exact root acquired an unexpected child device: {child}.");
                    case ChildKind.NotYetIdentifiable:
                        pending = true;
                        break;
                }
            }
            if (proven && !pending) return;
            if (DateTime.UtcNow >= deadline)
                throw new TimeoutException("The preinstalled HIDMaestro package did not bind the exact DualSense root.");
            Thread.Sleep(50);
        }
    }

    private enum ChildKind
    {
        ExactDualSense,
        Foreign,
        NotYetIdentifiable,
    }

    private static bool ChildIsExactDualSense(string childInstanceId) =>
        ChildIdentity(childInstanceId) == ChildKind.ExactDualSense;

    /// <summary>
    /// A child under the owned root is the exact DualSense iff its HARDWARE ID
    /// list carries the driver-reported identity. Measured 2026-08-20 on a
    /// live pad: the child's INSTANCE path spells <c>HID\HIDCLASS\…</c> (it is
    /// derived from the root-enumerated parent, never from VID/PID), while its
    /// <c>HardwareID</c> multi-sz leads with <c>HID\VID_xxxx&amp;PID_yyyy</c> —
    /// the earlier instance-prefix check refused every legitimate child. A
    /// child can also surface in the devnode tree before PnP finishes writing
    /// its Enum mirror; an unreadable identity means "still materialising",
    /// never "foreign", so the bound-wait keeps waiting instead of refusing a
    /// pad that is mid-birth.
    /// </summary>
    /// <summary>
    /// The retained root is ours iff its `HardwareID` multi-sz carries the
    /// exact identity this host writes at registration (measured live:
    /// `root\VID_054C&amp;PID_0CE6 ; root\HIDMaestro`).
    /// </summary>
    private static bool ParentIsExactRoot(string parentInstanceId)
    {
        using RegistryKey? key = Registry.LocalMachine.OpenSubKey(
            $@"SYSTEM\CurrentControlSet\Enum\{parentInstanceId}", writable: false);
        if (key?.GetValue("HardwareID") is not string[] ids) return false;
        foreach (string id in ids)
        {
            if (id.Equals(HardwareId, StringComparison.OrdinalIgnoreCase))
                return true;
        }
        return false;
    }

    private static ChildKind ChildIdentity(string childInstanceId)
    {
        using RegistryKey? key = Registry.LocalMachine.OpenSubKey(
            $@"SYSTEM\CurrentControlSet\Enum\{childInstanceId}", writable: false);
        if (key?.GetValue("HardwareID") is not string[] ids || ids.Length == 0)
            return ChildKind.NotYetIdentifiable;
        foreach (string id in ids)
        {
            if (id.StartsWith(@"HID\VID_054C&PID_0CE6", StringComparison.OrdinalIgnoreCase))
                return ChildKind.ExactDualSense;
        }
        return ChildKind.Foreign;
    }

    public IReadOnlyList<string> ReadExactChildInstanceIds(RuntimeDeviceRegistration registration)
    {
        ValidateParent(registration);
        IReadOnlyList<string> children = DirectChildren(registration.ParentInstanceId);
        if (children.Count == 0) throw new InvalidOperationException("The exact HIDMaestro root has no HID child.");
        lock (_gate)
        {
            _ownedChildren.Clear();
            foreach (string child in children)
            {
                // Hardware-id identity, not instance-path spelling — the
                // measured child instance is `HID\HIDCLASS\…` (see
                // ChildIsExactDualSense).
                if (!ChildIsExactDualSense(child) || !_ownedChildren.Add(child))
                    throw new InvalidOperationException("The exact HIDMaestro child set is not valid.");
            }
        }
        return children;
    }

    public void RemoveExactInstance(string exactInstanceId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(exactInstanceId);
        lock (_gate)
        {
            bool parent = _ownedParent is not null && exactInstanceId.Equals(_ownedParent, StringComparison.OrdinalIgnoreCase);
            if (!parent && !_ownedChildren.Contains(exactInstanceId))
                throw new InvalidOperationException("Refusing to remove a device not owned by this host session.");
            TryUninstall(exactInstanceId);
            if (parent)
            {
                DeleteOwnedConfiguration();
            }

            // Retain the exact identities for the lifetime of this one-use
            // host. RuntimePlainHidLifecycle retries the complete captured
            // set after a partial teardown failure, so a previously removed
            // child or parent must remain an authorized idempotent no-op.
        }
    }

    private static void CreateConfiguration()
    {
        using RegistryKey key = Registry.LocalMachine.CreateSubKey(ControllerKey, writable: true)
            ?? throw new InvalidOperationException("The HIDMaestro controller configuration could not be created.");
        key.SetValue(OwnershipName, OwnershipValue, RegistryValueKind.String);
        key.SetValue("FunctionMode", 0, RegistryValueKind.DWord);
        key.SetValue("ReportDescriptor", Descriptor, RegistryValueKind.Binary);
        key.SetValue("VendorId", 0x054C, RegistryValueKind.DWord);
        key.SetValue("ProductId", 0x0CE6, RegistryValueKind.DWord);
        key.SetValue("VersionNumber", 0x0100, RegistryValueKind.DWord);
        key.SetValue("ProductString", "DualSense Wireless Controller", RegistryValueKind.String);
        key.SetValue("DeviceDescription", "DualSense Wireless Controller", RegistryValueKind.String);
        key.SetValue("InputReportByteLength", 64, RegistryValueKind.DWord);
    }

    private static void DeleteOwnedConfiguration()
    {
        bool owned;
        using (RegistryKey? key = Registry.LocalMachine.OpenSubKey(ControllerKey, writable: false))
        {
            owned = key?.GetValue(OwnershipName) is string owner &&
                owner.Equals(OwnershipValue, StringComparison.Ordinal);
        }
        if (!owned) return;
        Registry.LocalMachine.DeleteSubKeyTree(ControllerKey, throwOnMissingSubKey: false);
    }

    private static void RecoverOwnedResidue()
    {
        string? parent;
        using (RegistryKey? key = Registry.LocalMachine.OpenSubKey(ControllerKey, writable: false))
        {
            if (key is null) return;
            if (key.GetValue(OwnershipName) is not string owner ||
                !owner.Equals(OwnershipValue, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("HIDMaestro controller slot zero is owned by another consumer.");
            }
            parent = key.GetValue("DeviceInstanceId") as string;
        }

        if (!string.IsNullOrWhiteSpace(parent))
        {
            // Hardware-id identity, not instance-path spelling: PnP names the
            // root devnode `ROOT\HIDCLASS\NNNN` (measured 2026-08-20, three
            // times), so a `root\VID_…`-prefix check on the INSTANCE id
            // refused every legitimate residue and DEADLOCKED recovery — the
            // same defect as the child checks, in its third home. A devnode
            // that no longer exists needs no identity proof to forget.
            if (CM_Locate_DevNodeW(out _, parent, 0) == CrSuccess
                && !ParentIsExactRoot(parent))
            {
                throw new InvalidOperationException("The retained KSX HIDMaestro device identity is not exact.");
            }
            TryUninstall(parent);
        }
        DeleteOwnedConfiguration();
    }

    private static string RegisterRootDevice()
    {
        Guid classGuid = HidClass;
        nint set = SetupDiCreateDeviceInfoList(ref classGuid, 0);
        if (set == new nint(-1)) throw Last("The HID device information set could not be created.");
        try
        {
            var info = new SpDevinfoData { Size = (uint)Marshal.SizeOf<SpDevinfoData>() };
            if (!SetupDiCreateDeviceInfoW(set, "HIDClass", ref classGuid,
                    "DualSense Wireless Controller", 0, 1, ref info))
                throw Last("The exact DualSense root could not be prepared.");
            byte[] ids = Encoding.Unicode.GetBytes(HardwareId + "\0root\\HIDMaestro\0\0");
            if (!SetupDiSetDeviceRegistryPropertyW(set, ref info, 1, ids, (uint)ids.Length))
                throw Last("The exact DualSense hardware identity could not be assigned.");
            if (!SetupDiCallClassInstaller(0x19, set, ref info))
                throw Last("The exact DualSense root could not be registered.");
            var buffer = new char[512];
            if (!SetupDiGetDeviceInstanceIdW(set, ref info, buffer, (uint)buffer.Length, out uint required)
                || required is 0 or > 512)
                throw Last("The exact DualSense root identity could not be captured.");
            return new string(buffer, 0, checked((int)required - 1));
        }
        finally { _ = SetupDiDestroyDeviceInfoList(set); }
    }

    private void ValidateParent(RuntimeDeviceRegistration registration)
    {
        ArgumentNullException.ThrowIfNull(registration);
        lock (_gate)
        {
            if (_ownedParent is null || !registration.ParentInstanceId.Equals(_ownedParent, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("The registration is not owned by this host session.");
        }
    }

    private static IReadOnlyList<string> DirectChildren(string parentId)
    {
        uint result = CM_Locate_DevNodeW(out uint parent, parentId, 0);
        if (result != CrSuccess) throw new InvalidOperationException("The exact HIDMaestro parent no longer exists.");
        result = CM_Get_Child(out uint child, parent, 0);
        if (result == CrNoSuchDevnode) return Array.Empty<string>();
        if (result != CrSuccess) throw new InvalidOperationException("The exact HIDMaestro child set could not be read.");
        var output = new List<string>();
        while (true)
        {
            output.Add(DeviceId(child));
            result = CM_Get_Sibling(out uint sibling, child, 0);
            if (result == CrNoSuchDevnode) break;
            if (result != CrSuccess) throw new InvalidOperationException("The exact HIDMaestro sibling set could not be read.");
            child = sibling;
        }
        output.Sort(StringComparer.OrdinalIgnoreCase);
        return output;
    }

    private static string DeviceId(uint node)
    {
        var buffer = new char[512];
        uint result = CM_Get_Device_IDW(node, buffer, (uint)buffer.Length, 0);
        if (result != CrSuccess) throw new InvalidOperationException("An exact device identity could not be read.");
        int end = Array.IndexOf(buffer, '\0');
        return new string(buffer, 0, end < 0 ? buffer.Length : end);
    }

    private static void TryUninstall(string instanceId)
    {
        uint result = CM_Locate_DevNodeW(out uint node, instanceId, 0);
        if (result == CrNoSuchDevnode) return;
        if (result != CrSuccess) throw new InvalidOperationException("The exact owned device could not be located for removal.");
        result = CM_Uninstall_DevNode(node, 0);
        if (result is not (CrSuccess or CrNoSuchDevnode))
            throw new InvalidOperationException("The exact owned device could not be removed.");
    }

    private static Win32Exception Last(string message) => new(Marshal.GetLastWin32Error(), message);

    [StructLayout(LayoutKind.Sequential)]
    private struct SpDevinfoData { internal uint Size; internal Guid ClassGuid; internal uint DevInst; internal nuint Reserved; }
    [DllImport("setupapi.dll", SetLastError = true)] private static extern nint SetupDiCreateDeviceInfoList(ref Guid guid, nint parent);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetupDiCreateDeviceInfoW(nint set, string name, ref Guid guid, string description, nint parent, uint flags, ref SpDevinfoData info);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetupDiSetDeviceRegistryPropertyW(nint set, ref SpDevinfoData info, uint property, byte[] data, uint size);
    [DllImport("setupapi.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetupDiCallClassInstaller(uint function, nint set, ref SpDevinfoData info);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetupDiGetDeviceInstanceIdW(nint set, ref SpDevinfoData info, [Out] char[] id, uint size, out uint required);
    [DllImport("setupapi.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetupDiDestroyDeviceInfoList(nint set);
    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] private static extern uint CM_Locate_DevNodeW(out uint node, string id, uint flags);
    [DllImport("cfgmgr32.dll")] private static extern uint CM_Get_Child(out uint child, uint parent, uint flags);
    [DllImport("cfgmgr32.dll")] private static extern uint CM_Get_Sibling(out uint sibling, uint node, uint flags);
    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)] private static extern uint CM_Get_Device_IDW(uint node, [Out] char[] id, uint length, uint flags);
    [DllImport("cfgmgr32.dll")] private static extern uint CM_Uninstall_DevNode(uint node, uint flags);
    [DllImport("newdev.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool UpdateDriverForPlugAndPlayDevicesW(nint parent, string hardwareId, string infPath, uint flags, [MarshalAs(UnmanagedType.Bool)] out bool rebootRequired);
}
