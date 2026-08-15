using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.Loader;
using System.Security.Cryptography;

namespace Ksx.HidMaestroDriverInstaller;

internal static class Program
{
    private const string CoordinatorCommand = "install-v1";
    private const string WorkerCommand = "install-worker-v1";
    private const string MutexName = "Global\\KSX.HIDMaestro.DriverInstaller.v1";
    private const string WorkerMutexName = "Global\\KSX.HIDMaestro.DriverInstaller.Worker.v1";
    private const string WorkDirectoryPrefix = ".ksx-hidmaestro-install-";
    private const int MaxPriorWorkDirectories = 32;
    private const int CleanupAttempts = 40;
    private const int CleanupRetryMilliseconds = 125;
    private static readonly TimeSpan PriorWorkDirectoryMinimumAge = TimeSpan.FromMinutes(2);
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
        if (!OperatingSystem.IsWindows())
            return 2;
        if (!IsProtectedInstallation())
            return 9;

        return args switch
        {
            [CoordinatorCommand] => RunCoordinator(),
            [WorkerCommand, string workDirectory] => RunWorker(workDirectory),
            _ => 2,
        };
    }

    private static int RunCoordinator()
    {
        using var singleton = new Mutex(initiallyOwned: false, MutexName);
        if (!TryAcquireMutex(singleton))
            return 3;

        try
        {
            return RunCoordinatorLocked();
        }
        finally
        {
            singleton.ReleaseMutex();
        }
    }

    private static int RunCoordinatorLocked()
    {
        // A worker can outlive a coordinator that was terminated. Refuse a
        // second install while that process still owns the worker lease. The
        // recent-directory quarantine below closes the short launch/acquire
        // handoff if the coordinator dies immediately after Process.Start.
        if (IsWorkerActive())
            return 3;
        if (!RemovePriorWorkingDirectories())
            return 10;

        string? workDirectory = null;
        bool stagingComplete = false;
        int result;
        try
        {
            byte[] archive = DownloadArchiveAsync().GetAwaiter().GetResult();
            workDirectory = CreateWorkingDirectory();
            ExtractPinnedAssemblies(archive, workDirectory);
            stagingComplete = true;
            result = InvokePinnedInstallerWorker(workDirectory);
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

        bool cleaned = workDirectory is null ||
            DeleteWorkingDirectory(workDirectory, requirePins: stagingComplete);
        if (!cleaned && result == 0)
            return 8;
        return result;
    }

    private static int RunWorker(string workDirectory)
    {
        using var workerLease = new Mutex(initiallyOwned: false, WorkerMutexName);
        if (!TryAcquireMutex(workerLease))
            return 3;

        try
        {
            if (!IsExactWorkingDirectoryPath(workDirectory))
                return 5;
            if (!IsVerifiedWorkingDirectory(workDirectory, requireComplete: true))
                return 5;
            InvokePinnedInstaller(workDirectory);
            return 0;
        }
        catch (InstallerShapeException)
        {
            return 6;
        }
        catch (InstallerInvocationException)
        {
            return 7;
        }
        catch
        {
            return 7;
        }
        finally
        {
            workerLease.ReleaseMutex();
        }
    }

    private static bool TryAcquireMutex(Mutex mutex)
    {
        try
        {
            return mutex.WaitOne(millisecondsTimeout: 0);
        }
        catch (AbandonedMutexException)
        {
            // The caller owns an abandoned mutex when this exception is raised.
            // Staging still has to pass independent age/path/hash checks.
            return true;
        }
    }

    private static bool IsWorkerActive()
    {
        using var workerLease = new Mutex(initiallyOwned: false, WorkerMutexName);
        if (!TryAcquireMutex(workerLease))
            return true;
        workerLease.ReleaseMutex();
        return false;
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
        string applicationDirectory = GetApplicationDirectory();
        string workDirectory = Path.Combine(
            applicationDirectory,
            WorkDirectoryPrefix + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDirectory);
        return workDirectory;
    }

    private static string GetApplicationDirectory()
    {
        string executable = Environment.ProcessPath ?? throw new InstallerShapeException();
        return Path.GetDirectoryName(Path.GetFullPath(executable)) ??
            throw new InstallerShapeException();
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
            if (!IsVerifiedWorkingDirectory(workDirectory, requireComplete: true))
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
        LoadAndInvoke(workDirectory);
    }

    private static void LoadAndInvoke(string workDirectory)
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
    }

    private static int InvokePinnedInstallerWorker(string workDirectory)
    {
        string executable = Environment.ProcessPath ?? throw new InstallerInvocationException();
        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            WorkingDirectory = GetApplicationDirectory(),
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        startInfo.ArgumentList.Add(WorkerCommand);
        startInfo.ArgumentList.Add(workDirectory);

        using Process worker = Process.Start(startInfo) ?? throw new InstallerInvocationException();
        worker.WaitForExit();
        return worker.ExitCode switch
        {
            0 or 3 or 5 or 6 or 7 => worker.ExitCode,
            _ => 7,
        };
    }

    private static bool RemovePriorWorkingDirectories()
    {
        try
        {
            string applicationDirectory = GetApplicationDirectory();
            string[] candidates = Directory
                .EnumerateDirectories(
                    applicationDirectory,
                    WorkDirectoryPrefix + "*",
                    SearchOption.TopDirectoryOnly)
                .Where(path => IsStrictWorkingDirectoryName(Path.GetFileName(path)))
                .Take(MaxPriorWorkDirectories + 1)
                .ToArray();
            if (candidates.Length > MaxPriorWorkDirectories)
                return false;

            // Validate the complete bounded set before deleting any prior residue.
            // A matching reparse point, unknown entry, or changed byte fails closed.
            if (candidates.Any(path =>
                    !IsPriorWorkingDirectoryOldEnough(path) ||
                    !IsVerifiedWorkingDirectory(path, requireComplete: false)))
                return false;
            return candidates.All(path => DeleteWorkingDirectory(path, requirePins: true));
        }
        catch
        {
            return false;
        }
    }

    private static bool IsPriorWorkingDirectoryOldEnough(string path)
    {
        DateTime lastWrite = Directory.GetLastWriteTimeUtc(path);
        DateTime now = DateTime.UtcNow;
        return lastWrite <= now && now - lastWrite >= PriorWorkDirectoryMinimumAge;
    }

    private static bool IsExactWorkingDirectoryPath(string workDirectory)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(workDirectory) || !Path.IsPathFullyQualified(workDirectory))
                return false;
            string canonical = Path.TrimEndingDirectorySeparator(Path.GetFullPath(workDirectory));
            if (!string.Equals(canonical, workDirectory, StringComparison.OrdinalIgnoreCase))
                return false;
            string? parent = Path.GetDirectoryName(canonical);
            if (!string.Equals(parent, GetApplicationDirectory(), StringComparison.OrdinalIgnoreCase))
                return false;
            if (!IsStrictWorkingDirectoryName(Path.GetFileName(canonical)))
                return false;
            FileAttributes attributes = File.GetAttributes(canonical);
            return (attributes & FileAttributes.Directory) != 0 &&
                (attributes & FileAttributes.ReparsePoint) == 0;
        }
        catch
        {
            return false;
        }
    }

    private static bool IsStrictWorkingDirectoryName(string? name)
    {
        if (name is null || name.Length != WorkDirectoryPrefix.Length + 32 ||
            !name.StartsWith(WorkDirectoryPrefix, StringComparison.Ordinal))
        {
            return false;
        }
        foreach (char character in name.AsSpan(WorkDirectoryPrefix.Length))
        {
            if (character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f'))
                return false;
        }
        return true;
    }

    private static bool IsVerifiedWorkingDirectory(string workDirectory, bool requireComplete)
    {
        if (!TryEnumeratePinnedFiles(workDirectory, out ObservedPinnedFile[] observed))
            return false;
        if (requireComplete && observed.Length != Entries.Length)
            return false;
        return observed.All(file => FileMatchesPin(file.Path, file.Pin));
    }

    private static bool TryEnumeratePinnedFiles(
        string workDirectory,
        out ObservedPinnedFile[] observed)
    {
        observed = [];
        try
        {
            if (!IsExactWorkingDirectoryPath(workDirectory))
                return false;
            string[] paths = Directory.EnumerateFileSystemEntries(workDirectory)
                .Take(Entries.Length + 1)
                .ToArray();
            if (paths.Length > Entries.Length)
                return false;

            var files = new List<ObservedPinnedFile>(paths.Length);
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (string path in paths)
            {
                FileAttributes attributes = File.GetAttributes(path);
                if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
                    return false;
                string name = Path.GetFileName(path);
                if (!names.Add(name))
                    return false;
                int pinIndex = Array.FindIndex(
                    Entries,
                    pin => string.Equals(pin.OutputName, name, StringComparison.Ordinal));
                if (pinIndex < 0)
                    return false;
                files.Add(new ObservedPinnedFile(path, Entries[pinIndex]));
            }
            observed = files.ToArray();
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static bool FileMatchesPin(string path, PinnedEntry pin)
    {
        try
        {
            using var source = new FileStream(
                path,
                new FileStreamOptions
                {
                    Mode = FileMode.Open,
                    Access = FileAccess.Read,
                    Share = FileShare.Read,
                    BufferSize = 128 * 1024,
                    Options = FileOptions.SequentialScan,
                });
            if (source.Length != pin.Length)
                return false;
            using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            byte[] buffer = GC.AllocateUninitializedArray<byte>(128 * 1024);
            long remaining = pin.Length;
            while (remaining > 0)
            {
                int read = source.Read(buffer, 0, (int)Math.Min(buffer.Length, remaining));
                if (read == 0)
                    return false;
                hash.AppendData(buffer.AsSpan(0, read));
                remaining -= read;
            }
            if (source.ReadByte() != -1)
                return false;
            return CryptographicOperations.FixedTimeEquals(
                hash.GetHashAndReset(),
                Convert.FromHexString(pin.Sha256));
        }
        catch
        {
            return false;
        }
    }

    private static bool DeleteWorkingDirectory(string workDirectory, bool requirePins)
    {
        for (int attempt = 0; attempt < CleanupAttempts; attempt++)
        {
            try
            {
                if (!Directory.Exists(workDirectory))
                    return true;
                if (!TryEnumeratePinnedFiles(workDirectory, out ObservedPinnedFile[] files))
                    return false;
                if (requirePins && files.Any(file => !FileMatchesPin(file.Path, file.Pin)))
                    return false;
                foreach (ObservedPinnedFile file in files)
                    File.Delete(file.Path);
                Directory.Delete(workDirectory, recursive: false);
                if (!Directory.Exists(workDirectory))
                    return true;
                Thread.Sleep(CleanupRetryMilliseconds);
            }
            catch (IOException)
            {
                Thread.Sleep(CleanupRetryMilliseconds);
            }
            catch (UnauthorizedAccessException)
            {
                Thread.Sleep(CleanupRetryMilliseconds);
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

    private readonly record struct ObservedPinnedFile(string Path, PinnedEntry Pin);

    private sealed class DownloadFailureException : Exception { }
    private sealed class PinFailureException : Exception { }
    private sealed class InstallerShapeException : Exception { }
    private sealed class InstallerInvocationException : Exception { }
}
