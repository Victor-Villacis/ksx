using System.IO.Compression;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Security.Cryptography;

namespace Ksx.HidMaestroDriverInstaller;

internal static class Program
{
    private const string ArchiveUrl =
        "https://github.com/hifihedgehog/HIDMaestro/releases/download/v1.6.1/HIDMaestro-v1.6.1.zip";
    private const long ArchiveLength = 118_879_222;
    private const string ArchiveSha256 =
        "00145C23D9838BE6089389CE58B3FD2B6766FA9BC0F1F3C60A3C885361B53C34";

    private static readonly PinnedEntry[] Entries =
    [
        new(
            "HIDMaestro.Core.dll",
            "HIDMaestro.Core.dll",
            40_705_536,
            "ADADD9E2604B7B6B047F386EBDD03879FEEF48009C6290281E4C665E2190F6D5"),
        new(
            @"HIDMaestroTest\Microsoft.Windows.SDK.NET.dll",
            "Microsoft.Windows.SDK.NET.dll",
            26_341_408,
            "C633AB241CD09846C2AA409F0BEE2026962610404A7BF132C75CBD66B0E5A9F4"),
        new(
            @"HIDMaestroTest\WinRT.Runtime.dll",
            "WinRT.Runtime.dll",
            528_944,
            "BCF3A14E8712A90837FC5C0D8C8A24696AF2BD7F74E9767597EC81EDEDFB23DB"),
    ];

    private static int Main(string[] args)
    {
        if (!OperatingSystem.IsWindows() || args is not ["install-v1"])
            return 2;
        if (!IsProtectedInstallation())
            return 9;

        using var singleton = new Mutex(
            initiallyOwned: true,
            "Global\\KSX.HIDMaestro.DriverInstaller.v1",
            out bool acquired);
        if (!acquired)
            return 3;

        string? workDirectory = null;
        int result;
        try
        {
            byte[] archive = DownloadArchiveAsync().GetAwaiter().GetResult();
            workDirectory = CreateWorkingDirectory();
            ExtractPinnedAssemblies(archive, workDirectory);
            InvokePinnedInstaller(workDirectory);
            result = 0;
        }
        catch (DownloadFailureException)
        {
            result = 4;
        }
        catch (PinFailureException)
        {
            result = 5;
        }
        catch (InstallerShapeException)
        {
            result = 6;
        }
        catch (InstallerInvocationException)
        {
            result = 7;
        }
        catch
        {
            result = 7;
        }

        if (workDirectory is not null && !DeleteWorkingDirectory(workDirectory))
            return 8;
        return result;
    }

    private static async Task<byte[]> DownloadArchiveAsync()
    {
        try
        {
            using var handler = new HttpClientHandler
            {
                AutomaticDecompression = System.Net.DecompressionMethods.None,
            };
            using var client = new HttpClient(handler)
            {
                Timeout = TimeSpan.FromMinutes(10),
            };
            using var request = new HttpRequestMessage(HttpMethod.Get, ArchiveUrl);
            request.Headers.UserAgent.ParseAdd("KSX-HIDMaestro-Installer/1");
            using HttpResponseMessage response = await client.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false);
            response.EnsureSuccessStatusCode();

            if (response.Content.Headers.ContentLength is long advertisedLength &&
                advertisedLength != ArchiveLength)
            {
                throw new PinFailureException();
            }

            await using Stream source = await response.Content.ReadAsStreamAsync().ConfigureAwait(false);
            using var destination = new MemoryStream(checked((int)ArchiveLength));
            byte[] buffer = GC.AllocateUninitializedArray<byte>(128 * 1024);
            long total = 0;
            while (true)
            {
                int read = await source.ReadAsync(buffer).ConfigureAwait(false);
                if (read == 0)
                    break;
                total = checked(total + read);
                if (total > ArchiveLength)
                    throw new PinFailureException();
                destination.Write(buffer.AsSpan(0, read));
            }

            if (total != ArchiveLength)
                throw new PinFailureException();
            byte[] archive = destination.ToArray();
            RequireSha256(archive, ArchiveSha256);
            return archive;
        }
        catch (PinFailureException)
        {
            throw;
        }
        catch (Exception ex) when (
            ex is HttpRequestException or TaskCanceledException or IOException)
        {
            throw new DownloadFailureException();
        }
    }

    private static string CreateWorkingDirectory()
    {
        string executable = Environment.ProcessPath ?? throw new InstallerShapeException();
        string applicationDirectory = Path.GetDirectoryName(executable) ??
            throw new InstallerShapeException();
        string workDirectory = Path.Combine(
            applicationDirectory,
            ".ksx-hidmaestro-install-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDirectory);
        return workDirectory;
    }

    private static bool IsProtectedInstallation()
    {
        try
        {
            string? processPath = Environment.ProcessPath;
            if (string.IsNullOrWhiteSpace(processPath))
                return false;
            string executable = Path.GetFullPath(processPath);
            string[] roots =
            [
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            ];
            foreach (string candidate in roots.Where(root => !string.IsNullOrWhiteSpace(root)))
            {
                string root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(candidate));
                if (!executable.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                    continue;
                string relative = Path.GetRelativePath(root, executable);
                string current = root;
                foreach (string component in relative.Split(
                             [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar],
                             StringSplitOptions.RemoveEmptyEntries))
                {
                    current = Path.Combine(current, component);
                    if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                        return false;
                }
                return true;
            }
            return false;
        }
        catch
        {
            return false;
        }
    }

    private static void ExtractPinnedAssemblies(byte[] archiveBytes, string workDirectory)
    {
        try
        {
            using var archiveStream = new MemoryStream(archiveBytes, writable: false);
            using var archive = new ZipArchive(archiveStream, ZipArchiveMode.Read, leaveOpen: false);
            foreach (PinnedEntry pin in Entries)
            {
                ZipArchiveEntry[] matches = archive.Entries
                    .Where(entry => string.Equals(entry.FullName, pin.ArchivePath, StringComparison.Ordinal))
                    .ToArray();
                if (matches is not [ZipArchiveEntry entry] || entry.Length != pin.Length)
                    throw new PinFailureException();

                string destinationPath = Path.Combine(workDirectory, pin.OutputName);
                using Stream source = entry.Open();
                using var destination = new FileStream(
                    destinationPath,
                    new FileStreamOptions
                    {
                        Mode = FileMode.CreateNew,
                        Access = FileAccess.Write,
                        Share = FileShare.None,
                        BufferSize = 128 * 1024,
                        Options = FileOptions.SequentialScan | FileOptions.WriteThrough,
                    });
                using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                byte[] buffer = GC.AllocateUninitializedArray<byte>(128 * 1024);
                long total = 0;
                while (true)
                {
                    int read = source.Read(buffer, 0, buffer.Length);
                    if (read == 0)
                        break;
                    total = checked(total + read);
                    if (total > pin.Length)
                        throw new PinFailureException();
                    hash.AppendData(buffer.AsSpan(0, read));
                    destination.Write(buffer.AsSpan(0, read));
                }

                destination.Flush(flushToDisk: true);
                if (total != pin.Length ||
                    !CryptographicOperations.FixedTimeEquals(
                        hash.GetHashAndReset(),
                        Convert.FromHexString(pin.Sha256)))
                {
                    throw new PinFailureException();
                }
            }

            string[] extracted = Directory.GetFiles(workDirectory)
                .Select(path => Path.GetFileName(path) ?? throw new PinFailureException())
                .Order(StringComparer.Ordinal)
                .ToArray()!;
            string[] expected = Entries
                .Select(entry => entry.OutputName)
                .Order(StringComparer.Ordinal)
                .ToArray();
            if (!extracted.SequenceEqual(expected, StringComparer.Ordinal))
                throw new PinFailureException();
        }
        catch (PinFailureException)
        {
            throw;
        }
        catch (Exception ex) when (ex is InvalidDataException or IOException or OverflowException)
        {
            throw new PinFailureException();
        }
    }

    private static void InvokePinnedInstaller(string workDirectory)
    {
        WeakReference unload = LoadAndInvoke(workDirectory);
        for (int attempt = 0; unload.IsAlive && attempt < 8; attempt++)
        {
            GC.Collect();
            GC.WaitForPendingFinalizers();
        }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static WeakReference LoadAndInvoke(string workDirectory)
    {
        var loadContext = new PinnedLoadContext(workDirectory);
        try
        {
            Assembly assembly = loadContext.LoadFromAssemblyPath(
                Path.Combine(workDirectory, "HIDMaestro.Core.dll"));
            Type contextType = assembly.GetType("HIDMaestro.HMContext", throwOnError: false) ??
                throw new InstallerShapeException();
            ConstructorInfo constructor = contextType.GetConstructor(Type.EmptyTypes) ??
                throw new InstallerShapeException();
            MethodInfo install = contextType.GetMethod(
                "InstallDriver",
                BindingFlags.Public | BindingFlags.Instance,
                binder: null,
                types: Type.EmptyTypes,
                modifiers: null) ?? throw new InstallerShapeException();
            if (install.ReturnType != typeof(void) || install.IsGenericMethod)
                throw new InstallerShapeException();

            object instance = constructor.Invoke(null);
            if (instance is not IDisposable disposable)
                throw new InstallerShapeException();
            using (disposable)
            {
                try
                {
                    install.Invoke(instance, null);
                }
                catch (TargetInvocationException)
                {
                    throw new InstallerInvocationException();
                }
            }
        }
        finally
        {
            loadContext.Unload();
        }
        return new WeakReference(loadContext, trackResurrection: false);
    }

    private static bool DeleteWorkingDirectory(string workDirectory)
    {
        for (int attempt = 0; attempt < 8; attempt++)
        {
            try
            {
                if (Directory.Exists(workDirectory))
                    Directory.Delete(workDirectory, recursive: true);
                return !Directory.Exists(workDirectory);
            }
            catch (IOException)
            {
                Thread.Sleep(125);
            }
            catch (UnauthorizedAccessException)
            {
                Thread.Sleep(125);
            }
        }
        return false;
    }

    private static void RequireSha256(ReadOnlySpan<byte> bytes, string expected)
    {
        if (!CryptographicOperations.FixedTimeEquals(
                SHA256.HashData(bytes),
                Convert.FromHexString(expected)))
        {
            throw new PinFailureException();
        }
    }

    private sealed class PinnedLoadContext(string root) : AssemblyLoadContext(isCollectible: true)
    {
        private static readonly HashSet<string> AllowedDependencies = new(StringComparer.Ordinal)
        {
            "Microsoft.Windows.SDK.NET",
            "WinRT.Runtime",
        };

        protected override Assembly? Load(AssemblyName assemblyName)
        {
            string? name = assemblyName.Name;
            if (name is null || !AllowedDependencies.Contains(name))
                return null;
            return LoadFromAssemblyPath(Path.Combine(root, name + ".dll"));
        }
    }

    private readonly record struct PinnedEntry(
        string ArchivePath,
        string OutputName,
        long Length,
        string Sha256);

    private sealed class DownloadFailureException : Exception { }
    private sealed class PinFailureException : Exception { }
    private sealed class InstallerShapeException : Exception { }
    private sealed class InstallerInvocationException : Exception { }
}
