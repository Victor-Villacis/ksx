using System.Runtime.InteropServices;

namespace Ksx.HidMaestroProbe;

internal interface IFileSignatureInspector
{
    /// <summary>
    /// Returns one of: trusted, unsigned, invalid, or unsupported. Inspection
    /// reads the file through WinVerifyTrust and never starts or loads it.
    /// </summary>
    string Inspect(string path);
}

internal sealed class WindowsFileSignatureInspector : IFileSignatureInspector
{
    private static readonly Guid GenericVerifyV2 =
        new("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");

    public string Inspect(string path)
    {
        if (!OperatingSystem.IsWindows())
            return "unsupported";

        IntPtr pathPointer = IntPtr.Zero;
        IntPtr filePointer = IntPtr.Zero;
        WinTrustData data = default;
        try
        {
            pathPointer = Marshal.StringToCoTaskMemUni(path);
            var file = new WinTrustFileInfo
            {
                StructSize = (uint)Marshal.SizeOf<WinTrustFileInfo>(),
                FilePath = pathPointer,
            };
            filePointer = Marshal.AllocHGlobal(Marshal.SizeOf<WinTrustFileInfo>());
            Marshal.StructureToPtr(file, filePointer, fDeleteOld: false);
            data = new WinTrustData
            {
                StructSize = (uint)Marshal.SizeOf<WinTrustData>(),
                UiChoice = 2, // WTD_UI_NONE
                RevocationChecks = 0, // WTD_REVOKE_NONE
                UnionChoice = 1, // WTD_CHOICE_FILE
                FileInfo = filePointer,
                StateAction = 1, // WTD_STATEACTION_VERIFY
                ProviderFlags = 0x00001000, // WTD_CACHE_ONLY_URL_RETRIEVAL
            };

            int status = WinVerifyTrust(new IntPtr(-1), GenericVerifyV2, ref data);
            return status switch
            {
                0 => "trusted",
                unchecked((int)0x800B0100) => "unsigned", // TRUST_E_NOSIGNATURE
                _ => "invalid",
            };
        }
        catch
        {
            return "invalid";
        }
        finally
        {
            if (data.StructSize != 0)
            {
                data.StateAction = 2; // WTD_STATEACTION_CLOSE
                try
                {
                    _ = WinVerifyTrust(new IntPtr(-1), GenericVerifyV2, ref data);
                }
                catch
                {
                    // Preserve the inspection result when provider cleanup is
                    // unavailable; no candidate code has been loaded.
                }
            }
            if (filePointer != IntPtr.Zero)
                Marshal.FreeHGlobal(filePointer);
            if (pathPointer != IntPtr.Zero)
                Marshal.FreeCoTaskMem(pathPointer);
        }
    }

    [DllImport("wintrust.dll", ExactSpelling = true, PreserveSig = true)]
    private static extern int WinVerifyTrust(
        IntPtr window,
        [MarshalAs(UnmanagedType.LPStruct)] Guid action,
        ref WinTrustData trustData);

    [StructLayout(LayoutKind.Sequential)]
    private struct WinTrustFileInfo
    {
        internal uint StructSize;
        internal IntPtr FilePath;
        internal IntPtr FileHandle;
        internal IntPtr KnownSubject;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WinTrustData
    {
        internal uint StructSize;
        internal IntPtr PolicyCallbackData;
        internal IntPtr SipClientData;
        internal uint UiChoice;
        internal uint RevocationChecks;
        internal uint UnionChoice;
        internal IntPtr FileInfo;
        internal uint StateAction;
        internal IntPtr StateData;
        internal IntPtr UrlReference;
        internal uint ProviderFlags;
        internal uint UiContext;
    }
}
