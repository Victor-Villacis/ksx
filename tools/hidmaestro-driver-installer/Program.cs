using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Loader;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace Ksx.HidMaestroDriverInstaller;

internal static class Program
{
    private const string CoordinatorCommand = "install-v1";
    private const string WorkerCommand = "install-worker-v1";
    private const string SelfTestCommand = "self-test-v1";
    private const string SelfTestSleepWorkerCommand = "self-test-sleep-worker-v1";
    private const string SelfTestSleepChildCommand = "self-test-sleep-child-v1";
    private const string MutexName = "Global\\KSX.HIDMaestro.DriverInstaller.v1";
    private const string WorkerMutexName = "Global\\KSX.HIDMaestro.DriverInstaller.Worker.v1";
    private const string WorkDirectoryPrefix = ".ksx-hidmaestro-install-";
    private const string WorkerTempDirectoryName = "runtime-temp";
    private const string WorkerReadyEventPrefix =
        "Local\\KSX.HIDMaestro.DriverInstaller.WorkerReady.";
    private const int MaxPriorWorkDirectories = 32;
    private const int CleanupAttempts = 40;
    private const int CleanupRetryMilliseconds = 125;
    private const int MaxWorkerTempEntries = 4_096;
    private const long MaxWorkerTempBytes = 512L * 1024 * 1024;
    private static readonly TimeSpan PriorWorkDirectoryMinimumAge = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan WorkerTimeout = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan WorkerStopTimeout = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan WorkerHandshakeTimeout = TimeSpan.FromSeconds(30);
    private const string InstalledManifestSha256 =
        "2f5c0313b3ea6fa79179a501648d9ff1b4330fbc4d1ab23294be14885edb2d8c";
    private const string HidMaestroInfSha256 =
        "187D5B06625CEECC0E1B43C0FA8DDA5F6DAB6A9962F79B037BBAD419F1084704";
    private const string HidMaestroXusbInfSha256 =
        "7E43DC4502074B571CB08444301688B81C4D69AAF6A0607853E4416678C8A55E";
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
            [WorkerCommand, string workDirectory, string readyEventName] =>
                RunWorker(workDirectory, readyEventName),
            // Keep the old private-command shape fail-closed. The workflow uses
            // an invalid path through this branch to prove that a caller cannot
            // invoke the SDK without the coordinator-owned ready handshake.
            [WorkerCommand, string workDirectory] => RunWorker(workDirectory, readyEventName: null),
            [SelfTestCommand] => RunSelfTests(),
            [SelfTestSleepWorkerCommand, string childPidPath, string readyEventName] =>
                RunSelfTestSleepWorker(childPidPath, readyEventName),
            [SelfTestSleepChildCommand, string selfTestRoot] =>
                RunSelfTestSleepChild(selfTestRoot),
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

        WritePhase("preflight");
        // A repair of the exact pinned package must be an offline, side-effect
        // free no-op. In particular, do not construct HMContext: upstream's
        // InstallDriver path sweeps live devices before it reaches its own
        // same-version fast path.
        if (IsExactHidMaestroInstalled())
        {
            WritePhase("already-installed");
            return 0;
        }

        WritePhase("residue-cleanup");
        if (!RemovePriorWorkingDirectories())
            return 10;

        string? workDirectory = null;
        bool stagingComplete = false;
        bool workerStopped = true;
        int result;
        try
        {
            WritePhase("download");
            byte[] archive = DownloadArchiveAsync().GetAwaiter().GetResult();
            WritePhase("staging");
            workDirectory = CreateWorkingDirectory();
            ExtractPinnedAssemblies(archive, workDirectory);
            stagingComplete = true;
            WritePhase("worker");
            result = InvokePinnedInstallerWorker(workDirectory);
            workerStopped = result != 12;
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

        // Exit 12 means the process tree could not be proven stopped. Never
        // delete bytes from underneath a possibly-live elevated worker. The
        // next run will refuse on its worker mutex/recent-residue quarantine;
        // a restart makes the protected residue eligible for exact cleanup.
        if (!workerStopped)
        {
            WritePhase("worker-stop-unconfirmed");
            return 12;
        }

        WritePhase("cleanup");
        bool cleaned = workDirectory is null ||
            DeleteWorkingDirectory(workDirectory, requirePins: stagingComplete);
        if (!cleaned && result == 0)
            return 8;
        WritePhase(result == 0 ? "complete" : $"failed-{result}");
        return result;
    }

    private static int RunWorker(string workDirectory, string? readyEventName)
    {
        using var workerLease = new Mutex(initiallyOwned: false, WorkerMutexName);
        if (!TryAcquireMutex(workerLease))
            return 3;

        try
        {
            if (!IsExactWorkingDirectoryPath(workDirectory))
                return 5;
            if (!IsVerifiedWorkingDirectory(
                    workDirectory,
                    requireComplete: true,
                    allowWorkerTemp: true))
                return 5;
            // Opening and waiting are deliberately after the complete pin
            // check but before the first SDK load. The coordinator signals
            // this unguessable event only after Windows reports that this
            // process belongs to its kill-on-close Job Object. A coordinator
            // crash therefore kills this process and every installer child;
            // a direct invocation can validate bytes but can never execute
            // them.
            if (!WaitForCoordinatorReady(readyEventName))
                return 5;
            // Re-prove the staging bytes after the cross-process hand-off.
            if (!IsVerifiedWorkingDirectory(
                    workDirectory,
                    requireComplete: true,
                    allowWorkerTemp: true))
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

    private static bool IsExactHidMaestroInstalled()
    {
        try
        {
            using RegistryKey localMachine = RegistryKey.OpenBaseKey(
                RegistryHive.LocalMachine,
                RegistryView.Registry64);
            using RegistryKey? key = localMachine.OpenSubKey(@"SOFTWARE\HIDMaestro", writable: false);
            string? manifest = key?.GetValue("InstalledManifestSha256") as string;
            string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            if (string.IsNullOrWhiteSpace(windows))
                return false;
            string repository = Path.Combine(
                Path.GetFullPath(windows),
                "System32",
                "DriverStore",
                "FileRepository");
            PackageObservation[] main = ObservePackages(
                    repository,
                    "hidmaestro.inf_amd64_",
                    "hidmaestro.inf",
                    "HIDMaestro.dll",
                    HidMaestroInfSha256);
            PackageObservation[] xusb = ObservePackages(
                    repository,
                    "hidmaestro_xusb.inf_amd64_",
                    "hidmaestro_xusb.inf",
                    "HMXInput.dll",
                    HidMaestroXusbInfSha256);
            return ExactInstallationPolicy(manifest, main, xusb);
        }
        catch
        {
            // A missing/unreadable/ambiguous observation means repair, never
            // "already installed". The downloaded path remains independently
            // pinned before any upstream byte executes.
            return false;
        }
    }

    private static bool WaitForCoordinatorReady(string? readyEventName)
    {
        if (!IsStrictReadyEventName(readyEventName))
            return false;
        try
        {
            using EventWaitHandle ready = EventWaitHandle.OpenExisting(readyEventName!);
            return ready.WaitOne(WorkerHandshakeTimeout);
        }
        catch (Exception ex) when (
            ex is WaitHandleCannotBeOpenedException or UnauthorizedAccessException or IOException)
        {
            return false;
        }
    }

    private static bool IsStrictReadyEventName(string? name)
    {
        if (name is null
            || name.Length != WorkerReadyEventPrefix.Length + 32
            || !name.StartsWith(WorkerReadyEventPrefix, StringComparison.Ordinal))
        {
            return false;
        }
        foreach (char character in name.AsSpan(WorkerReadyEventPrefix.Length))
        {
            if (character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f'))
                return false;
        }
        return true;
    }

    private static int RunSelfTests()
    {
        try
        {
            var valid = new[] { new PackageObservation(true, true, true, true) };
            RequireSelfTest(ExactInstallationPolicy(InstalledManifestSha256, valid, valid));
            RequireSelfTest(!ExactInstallationPolicy("wrong", valid, valid));
            RequireSelfTest(!ExactInstallationPolicy(InstalledManifestSha256, [], valid));
            RequireSelfTest(!ExactInstallationPolicy(
                InstalledManifestSha256,
                [valid[0], valid[0]],
                valid));
            foreach (PackageObservation invalid in new[]
                     {
                         new PackageObservation(false, true, true, true),
                         new PackageObservation(true, false, true, true),
                         new PackageObservation(true, true, false, true),
                         new PackageObservation(true, true, true, false),
                     })
            {
                RequireSelfTest(!ExactInstallationPolicy(
                    InstalledManifestSha256,
                    [invalid],
                    valid));
            }

            var environmentProbe = new ProcessStartInfo();
            const string sentinel = @"C:\Program Files\KSX\protected-worker-temp";
            ConfigureWorkerEnvironment(environmentProbe, sentinel);
            foreach (string variable in new[] { "TEMP", "TMP", "DOTNET_BUNDLE_EXTRACT_BASE_DIR" })
                RequireSelfTest(environmentProbe.Environment[variable] == sentinel);

            string root = Path.Combine(
                GetApplicationDirectory(),
                ".ksx-hidmaestro-selftest-" + Guid.NewGuid().ToString("N"));
            string workerTemp = Path.Combine(root, WorkerTempDirectoryName);
            string pidPath = Path.Combine(workerTemp, "child.pid");
            string gatePath = Path.Combine(workerTemp, "worker.waiting");
            string readyPath = Path.Combine(workerTemp, "child.ready");
            WorkerJob? job = null;
            Process? worker = null;
            Process? child = null;
            try
            {
                CreateProtectedDirectory(root);
                if (!IsSelfTestRoot(root) || !IsOrdinaryDirectory(root) || !HasProtectedAcl(root))
                    throw new SelfTestException();
                CreateProtectedDirectory(workerTemp);
                string executable = Environment.ProcessPath ?? throw new SelfTestException();
                string readyEventName = NewWorkerReadyEventName();
                using EventWaitHandle ready = CreateProtectedReadyEvent(readyEventName);
                job = WorkerJob.Create();
                var startInfo = new ProcessStartInfo
                {
                    FileName = executable,
                    WorkingDirectory = GetApplicationDirectory(),
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                ConfigureWorkerEnvironment(startInfo, workerTemp);
                startInfo.ArgumentList.Add(SelfTestSleepWorkerCommand);
                startInfo.ArgumentList.Add(pidPath);
                startInfo.ArgumentList.Add(readyEventName);
                worker = Process.Start(startInfo) ?? throw new SelfTestException();
                RequireSelfTest(job.Assign(worker));
                RequireSelfTest(WaitForFile(gatePath, TimeSpan.FromSeconds(10)));
                Thread.Sleep(250);
                RequireSelfTest(!File.Exists(pidPath));
                RequireSelfTest(!File.Exists(readyPath));
                RequireSelfTest(!worker.HasExited);
                ready.Set();
                RequireSelfTest(WaitForFile(pidPath, TimeSpan.FromSeconds(10)));
                RequireSelfTest(int.TryParse(File.ReadAllText(pidPath), out int childPid));
                child = Process.GetProcessById(childPid);
                RequireSelfTest(!child.HasExited);
                RequireSelfTest(SuperviseWorker(
                    worker,
                    job,
                    TimeSpan.FromMilliseconds(250),
                    TimeSpan.FromSeconds(10)) == 11);
                RequireSelfTest(worker.HasExited);
                RequireSelfTest(job.WaitForEmpty(TimeSpan.FromSeconds(1)));
                RequireSelfTest(child.WaitForExit(
                    checked((int)TimeSpan.FromSeconds(10).TotalMilliseconds)));
                RequireSelfTest(child.HasExited);
                RequireSelfTest(DeleteWorkerTemp(workerTemp, root));
                RequireSelfTest(!Directory.Exists(workerTemp));
                Directory.Delete(root, recursive: false);
            }
            finally
            {
                bool cleanupConfirmed = true;
                if (job is not null)
                {
                    cleanupConfirmed = job.TerminateAndWait(TimeSpan.FromSeconds(10));
                    job.Dispose();
                }
                cleanupConfirmed &= StopSelfTestProcess(worker, entireTree: true);
                cleanupConfirmed &= StopSelfTestProcess(child, entireTree: false);
                if (Directory.Exists(root))
                {
                    if (!IsSelfTestRoot(root)
                        || !IsOrdinaryDirectory(root)
                        || !HasProtectedAcl(root))
                    {
                        throw new SelfTestException();
                    }
                    if (Directory.Exists(workerTemp))
                        cleanupConfirmed &= DeleteWorkerTemp(workerTemp, root);
                    if (cleanupConfirmed)
                        Directory.Delete(root, recursive: false);
                }
                if (!cleanupConfirmed)
                    throw new SelfTestException();
            }

            ExerciseKillOnCloseSelfTest();

            return 0;
        }
        catch
        {
            return 13;
        }
    }

    private static void ExerciseKillOnCloseSelfTest()
    {
        string root = Path.Combine(
            GetApplicationDirectory(),
            ".ksx-hidmaestro-selftest-" + Guid.NewGuid().ToString("N"));
        string workerTemp = Path.Combine(root, WorkerTempDirectoryName);
        string pidPath = Path.Combine(workerTemp, "child.pid");
        string gatePath = Path.Combine(workerTemp, "worker.waiting");
        string readyPath = Path.Combine(workerTemp, "child.ready");
        WorkerJob? job = null;
        Process? worker = null;
        Process? child = null;
        try
        {
            CreateProtectedDirectory(root);
            RequireSelfTest(IsSelfTestRoot(root));
            CreateProtectedDirectory(workerTemp);
            string readyEventName = NewWorkerReadyEventName();
            using EventWaitHandle ready = CreateProtectedReadyEvent(readyEventName);
            job = WorkerJob.Create();
            var startInfo = new ProcessStartInfo
            {
                FileName = Environment.ProcessPath ?? throw new SelfTestException(),
                WorkingDirectory = GetApplicationDirectory(),
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            ConfigureWorkerEnvironment(startInfo, workerTemp);
            startInfo.ArgumentList.Add(SelfTestSleepWorkerCommand);
            startInfo.ArgumentList.Add(pidPath);
            startInfo.ArgumentList.Add(readyEventName);
            worker = Process.Start(startInfo) ?? throw new SelfTestException();
            RequireSelfTest(job.Assign(worker));
            RequireSelfTest(WaitForFile(gatePath, TimeSpan.FromSeconds(10)));
            Thread.Sleep(250);
            RequireSelfTest(!File.Exists(pidPath));
            RequireSelfTest(!File.Exists(readyPath));
            RequireSelfTest(!worker.HasExited);
            ready.Set();
            RequireSelfTest(WaitForFile(pidPath, TimeSpan.FromSeconds(10)));
            RequireSelfTest(int.TryParse(File.ReadAllText(pidPath), out int childPid));
            child = Process.GetProcessById(childPid);
            RequireSelfTest(!child.HasExited);

            // Closing the last handle is the crash analogue. Do not call
            // TerminateJobObject in this path: the test must fail if
            // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE ever regresses.
            job.Dispose();
            job = null;
            RequireSelfTest(worker.WaitForExit(
                checked((int)TimeSpan.FromSeconds(10).TotalMilliseconds)));
            RequireSelfTest(child.WaitForExit(
                checked((int)TimeSpan.FromSeconds(10).TotalMilliseconds)));
            RequireSelfTest(worker.HasExited && child.HasExited);
            RequireSelfTest(DeleteWorkerTemp(workerTemp, root));
            Directory.Delete(root, recursive: false);
        }
        finally
        {
            bool cleanupConfirmed = true;
            if (job is not null)
            {
                cleanupConfirmed = job.TerminateAndWait(TimeSpan.FromSeconds(10));
                job.Dispose();
            }
            cleanupConfirmed &= StopSelfTestProcess(worker, entireTree: true);
            cleanupConfirmed &= StopSelfTestProcess(child, entireTree: false);
            if (Directory.Exists(root))
            {
                if (!IsSelfTestRoot(root)
                    || !IsOrdinaryDirectory(root)
                    || !HasProtectedAcl(root))
                {
                    throw new SelfTestException();
                }
                if (Directory.Exists(workerTemp))
                    cleanupConfirmed &= DeleteWorkerTemp(workerTemp, root);
                if (cleanupConfirmed)
                    Directory.Delete(root, recursive: false);
            }
            if (!cleanupConfirmed)
                throw new SelfTestException();
        }
    }

    private static bool StopSelfTestProcess(Process? process, bool entireTree)
    {
        if (process is null)
            return true;
        try
        {
            if (!process.HasExited)
                process.Kill(entireProcessTree: entireTree);
            return process.WaitForExit(
                checked((int)TimeSpan.FromSeconds(10).TotalMilliseconds));
        }
        catch
        {
            return false;
        }
        finally
        {
            process.Dispose();
        }
    }

    private static int RunSelfTestSleepWorker(string childPidPath, string readyEventName)
    {
        string? root = Path.GetDirectoryName(Path.GetFullPath(childPidPath));
        if (root is null
            || !IsSelfTestWorkerTemp(root)
            || !IsOrdinaryDirectory(root)
            || !HasProtectedAcl(root))
            return 13;
        File.WriteAllText(Path.Combine(root, "worker.waiting"), "waiting");
        if (!WaitForCoordinatorReady(readyEventName))
            return 13;
        string readyPath = Path.Combine(root, "child.ready");
        var startInfo = new ProcessStartInfo
        {
            FileName = Environment.ProcessPath ?? throw new SelfTestException(),
            WorkingDirectory = GetApplicationDirectory(),
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        startInfo.ArgumentList.Add(SelfTestSleepChildCommand);
        startInfo.ArgumentList.Add(root);
        using Process child = Process.Start(startInfo) ?? throw new SelfTestException();
        try
        {
            if (!WaitForFile(readyPath, TimeSpan.FromSeconds(10)))
                return 13;
            string pendingPidPath = childPidPath + ".pending";
            File.WriteAllText(
                pendingPidPath,
                child.Id.ToString(System.Globalization.CultureInfo.InvariantCulture));
            File.Move(pendingPidPath, childPidPath);
            Thread.Sleep(TimeSpan.FromMinutes(10));
            return 13;
        }
        finally
        {
            if (!child.HasExited)
            {
                try { child.Kill(entireProcessTree: true); } catch { }
            }
        }
    }

    private static int RunSelfTestSleepChild(string root)
    {
        if (!IsSelfTestWorkerTemp(root)
            || !IsOrdinaryDirectory(root)
            || !HasProtectedAcl(root))
            return 13;
        using var held = new FileStream(
            Path.Combine(root, "held.lock"),
            FileMode.CreateNew,
            FileAccess.ReadWrite,
            FileShare.None);
        held.WriteByte(1);
        held.Flush(flushToDisk: true);
        File.WriteAllText(Path.Combine(root, "child.ready"), "ready");
        Thread.Sleep(TimeSpan.FromMinutes(10));
        return 13;
    }

    private static bool IsSelfTestRoot(string path)
    {
        try
        {
            string full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
            string? parent = Path.GetDirectoryName(full);
            string name = Path.GetFileName(full);
            const string prefix = ".ksx-hidmaestro-selftest-";
            return string.Equals(parent, GetApplicationDirectory(), StringComparison.OrdinalIgnoreCase)
                && name.Length == prefix.Length + 32
                && name.StartsWith(prefix, StringComparison.Ordinal)
                && name.AsSpan(prefix.Length).ToString().All(character =>
                    character is (>= '0' and <= '9') or (>= 'a' and <= 'f'));
        }
        catch
        {
            return false;
        }
    }

    private static bool IsSelfTestWorkerTemp(string path)
    {
        try
        {
            string full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
            string? parent = Path.GetDirectoryName(full);
            return parent is not null
                && IsSelfTestRoot(parent)
                && string.Equals(
                    Path.GetFileName(full),
                    WorkerTempDirectoryName,
                    StringComparison.Ordinal);
        }
        catch
        {
            return false;
        }
    }

    private static bool WaitForFile(string path, TimeSpan timeout)
    {
        var deadline = Stopwatch.StartNew();
        while (deadline.Elapsed < timeout)
        {
            if (File.Exists(path))
                return true;
            Thread.Sleep(25);
        }
        return false;
    }

    private static void RequireSelfTest(bool condition)
    {
        if (!condition)
            throw new SelfTestException();
    }

    private static PackageObservation[] ObservePackages(
        string repository,
        string directoryPrefix,
        string infName,
        string driverName,
        string infSha256)
    {
        return Directory
            .EnumerateDirectories(repository, directoryPrefix + "*", SearchOption.TopDirectoryOnly)
            .Take(2)
            .Select(directory =>
            {
                string inf = Path.Combine(directory, infName);
                string driver = Path.Combine(directory, driverName);
                bool ordinaryDirectory = IsOrdinaryDirectory(directory);
                bool ordinaryInf = ordinaryDirectory && File.Exists(inf) && IsOrdinaryFile(inf);
                bool ordinaryDriver = ordinaryDirectory && File.Exists(driver) && IsOrdinaryFile(driver);
                return new PackageObservation(
                    ordinaryDirectory,
                    ordinaryInf,
                    ordinaryDriver,
                    ordinaryInf && FileMatchesSha256(inf, infSha256));
            })
            .ToArray();
    }

    internal static bool ExactInstallationPolicy(
        string? manifest,
        IReadOnlyList<PackageObservation> main,
        IReadOnlyList<PackageObservation> xusb) =>
        string.Equals(manifest, InstalledManifestSha256, StringComparison.OrdinalIgnoreCase)
        && ExactPackagePolicy(main)
        && ExactPackagePolicy(xusb);

    private static bool ExactPackagePolicy(IReadOnlyList<PackageObservation> packages) =>
        packages is [
            {
                OrdinaryDirectory: true,
                OrdinaryInf: true,
                OrdinaryDriver: true,
                InfHashMatches: true,
            },
        ];

    private static bool IsOrdinaryDirectory(string path)
    {
        FileAttributes attributes = File.GetAttributes(path);
        return (attributes & FileAttributes.Directory) != 0
            && (attributes & FileAttributes.ReparsePoint) == 0;
    }

    private static bool IsOrdinaryFile(string path)
    {
        FileAttributes attributes = File.GetAttributes(path);
        return (attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == 0;
    }

    private static void WritePhase(string phase)
    {
        try
        {
            string path = Path.Combine(GetApplicationDirectory(), "ksx-hidmaestro-setup.log");
            File.AppendAllText(
                path,
                $"{DateTimeOffset.UtcNow:O} phase={phase}{Environment.NewLine}");
        }
        catch
        {
            // Diagnostics must not turn a verified install into a failure.
        }
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
        CreateProtectedDirectory(workDirectory);
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
                if (!HasProtectedAcl(root))
                    return false;
                string relative = Path.GetRelativePath(root, executable);
                string current = root;
                foreach (string component in relative.Split(
                             [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar],
                             StringSplitOptions.RemoveEmptyEntries))
                {
                    current = Path.Combine(current, component);
                    if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0
                        || !HasProtectedAcl(current))
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

    private static bool HasProtectedAcl(string path)
    {
        SecurityIdentifier[] authorities = TrustedMutationAuthorities();
        FileSystemSecurity security = Directory.Exists(path)
            ? new DirectoryInfo(path).GetAccessControl(
                AccessControlSections.Owner | AccessControlSections.Access)
            : new FileInfo(path).GetAccessControl(
                AccessControlSections.Owner | AccessControlSections.Access);
        if (security.GetOwner(typeof(SecurityIdentifier)) is not SecurityIdentifier owner
            || !authorities.Contains(owner))
        {
            return false;
        }

        const FileSystemRights mutation = FileSystemRights.Write
            | FileSystemRights.Delete
            | FileSystemRights.DeleteSubdirectoriesAndFiles
            | FileSystemRights.ChangePermissions
            | FileSystemRights.TakeOwnership
            | (FileSystemRights)0x1000_0000 // GENERIC_ALL
            | (FileSystemRights)0x4000_0000; // GENERIC_WRITE
        var creatorOwner = new SecurityIdentifier(WellKnownSidType.CreatorOwnerSid, null);
        foreach (FileSystemAccessRule rule in security.GetAccessRules(
                     includeExplicit: true,
                     includeInherited: true,
                     typeof(SecurityIdentifier)))
        {
            if (rule.AccessControlType != AccessControlType.Allow)
            {
                continue;
            }
            if (rule.IdentityReference is not SecurityIdentifier sid)
                return false;
            // Program Files carries the standard inherit-only CREATOR OWNER
            // template. It grants nothing on the current object, whose owner
            // is checked above; inherited effective ACEs are checked on every
            // component as IsProtectedInstallation walks to the executable.
            if (rule.PropagationFlags.HasFlag(PropagationFlags.InheritOnly)
                && sid.Equals(creatorOwner))
            {
                continue;
            }
            if ((rule.FileSystemRights & mutation) != 0
                && !authorities.Contains(sid))
            {
                return false;
            }
        }
        return true;
    }

    private static void CreateProtectedDirectory(string path)
    {
        if (Directory.Exists(path) || File.Exists(path))
            throw new PinFailureException();

        DirectoryInfo directory = Directory.CreateDirectory(path);
        if (!IsOrdinaryDirectory(path))
            throw new PinFailureException();

        SecurityIdentifier[] authorities = TrustedMutationAuthorities();
        var security = new DirectorySecurity();
        security.SetOwner(authorities[0]);
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        foreach (SecurityIdentifier authority in authorities)
        {
            security.AddAccessRule(new FileSystemAccessRule(
                authority,
                FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None,
                AccessControlType.Allow));
        }
        directory.SetAccessControl(security);

        DirectorySecurity applied = directory.GetAccessControl(
            AccessControlSections.Owner | AccessControlSections.Access);
        if (!applied.AreAccessRulesProtected
            || applied.GetOwner(typeof(SecurityIdentifier)) is not SecurityIdentifier owner
            || !authorities.Contains(owner))
        {
            throw new PinFailureException();
        }
        foreach (FileSystemAccessRule rule in applied.GetAccessRules(
                     includeExplicit: true,
                     includeInherited: true,
                     typeof(SecurityIdentifier)))
        {
            if (rule.IsInherited
                || rule.AccessControlType != AccessControlType.Allow
                || rule.IdentityReference is not SecurityIdentifier sid
                || !authorities.Contains(sid))
            {
                throw new PinFailureException();
            }
        }
        if (!HasProtectedAcl(path))
            throw new PinFailureException();
    }

    private static SecurityIdentifier[] TrustedMutationAuthorities() =>
    [
        new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
        new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
        new SecurityIdentifier(
            "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"),
    ];

    private static EventWaitHandle CreateProtectedReadyEvent(string readyEventName)
    {
        if (!IsStrictReadyEventName(readyEventName))
            throw new InstallerInvocationException();

        SecurityIdentifier[] authorities = TrustedMutationAuthorities();
        var security = new EventWaitHandleSecurity();
        security.SetOwner(authorities[0]);
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        foreach (SecurityIdentifier authority in authorities)
        {
            security.AddAccessRule(new EventWaitHandleAccessRule(
                authority,
                EventWaitHandleRights.FullControl,
                AccessControlType.Allow));
        }

        EventWaitHandle ready = EventWaitHandleAcl.Create(
            initialState: false,
            EventResetMode.ManualReset,
            readyEventName,
            out bool createdNew,
            security);
        if (createdNew)
            return ready;

        ready.Dispose();
        throw new InstallerInvocationException();
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
        string workerTemp = PrepareProtectedWorkerTemp(workDirectory);
        string readyEventName = NewWorkerReadyEventName();
        using EventWaitHandle ready = CreateProtectedReadyEvent(readyEventName);
        using WorkerJob job = WorkerJob.Create();
        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            WorkingDirectory = GetApplicationDirectory(),
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        // The official setup-time SDK extracts bundled executables before it
        // installs the driver. Give it a one-run, Administrators/SYSTEM-only
        // root under our random Program Files staging directory. This also
        // redirects the .NET single-file extractor before worker Main runs;
        // no elevated byte is ever reused from the invoking user's TEMP.
        ConfigureWorkerEnvironment(startInfo, workerTemp);
        startInfo.ArgumentList.Add(WorkerCommand);
        startInfo.ArgumentList.Add(workDirectory);
        startInfo.ArgumentList.Add(readyEventName);

        using Process worker = Process.Start(startInfo) ?? throw new InstallerInvocationException();
        if (!job.Assign(worker))
        {
            // The event remains unsignalled, so this process cannot cross the
            // pre-SDK handshake. Stop the root and retain staging unless that
            // one non-SDK process is proven gone.
            try { worker.Kill(); } catch { }
            try
            {
                return worker.WaitForExit(
                    checked((int)WorkerStopTimeout.TotalMilliseconds)) ? 7 : 12;
            }
            catch
            {
                return 12;
            }
        }
        try
        {
            ready.Set();
            int supervision = SuperviseWorker(worker, job, WorkerTimeout, WorkerStopTimeout);
            if (supervision != 0)
                return supervision;
            return worker.ExitCode switch
            {
                0 or 3 or 5 or 6 or 7 => worker.ExitCode,
                _ => 7,
            };
        }
        catch
        {
            // Once assignment succeeds, every exceptional supervision path
            // must establish the same tree-wide postcondition as a timeout.
            // Disposing a kill-on-close job requests termination but does not
            // prove that it completed, so retain staging unless accounting
            // confirms that no process remains.
            WritePhase("worker-supervision-failed");
            return job.TerminateAndWait(WorkerStopTimeout) ? 7 : 12;
        }
    }

    private static string NewWorkerReadyEventName() =>
        WorkerReadyEventPrefix + Guid.NewGuid().ToString("N");

    internal static void ConfigureWorkerEnvironment(ProcessStartInfo startInfo, string workerTemp)
    {
        startInfo.Environment["TEMP"] = workerTemp;
        startInfo.Environment["TMP"] = workerTemp;
        startInfo.Environment["DOTNET_BUNDLE_EXTRACT_BASE_DIR"] = workerTemp;
    }

    private static int SuperviseWorker(
        Process worker,
        WorkerJob job,
        TimeSpan timeout,
        TimeSpan stopTimeout)
    {
        if (!worker.WaitForExit(checked((int)timeout.TotalMilliseconds)))
        {
            WritePhase("worker-timeout");
            return job.TerminateAndWait(stopTimeout) ? 11 : 12;
        }

        // A successful root exit is not a successful process-tree exit. .NET's
        // Process.HasExited/WaitForExit deliberately say nothing about
        // descendants. Require the Job Object's authoritative active-process
        // count to reach zero. An upstream installer that leaves a helper
        // behind is refused and stopped even when its root returned zero.
        if (!job.WaitForEmpty(TimeSpan.FromMilliseconds(250)))
        {
            WritePhase("worker-left-descendants");
            return job.TerminateAndWait(stopTimeout) ? 7 : 12;
        }
        return 0;
    }

    private static string PrepareProtectedWorkerTemp(string workDirectory)
    {
        if (!IsVerifiedWorkingDirectory(workDirectory, requireComplete: true))
            throw new PinFailureException();

        string workerTemp = Path.Combine(workDirectory, WorkerTempDirectoryName);
        if (!string.Equals(
                Path.GetDirectoryName(Path.GetFullPath(workerTemp)),
                Path.GetFullPath(workDirectory),
                StringComparison.OrdinalIgnoreCase)
            || Directory.Exists(workerTemp)
            || File.Exists(workerTemp))
        {
            throw new PinFailureException();
        }

        CreateProtectedDirectory(workerTemp);
        return workerTemp;
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
                    !IsVerifiedWorkingDirectory(
                        path,
                        requireComplete: false,
                        allowWorkerTemp: true)))
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
                (attributes & FileAttributes.ReparsePoint) == 0 &&
                HasProtectedAcl(canonical);
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

    private static bool IsVerifiedWorkingDirectory(
        string workDirectory,
        bool requireComplete,
        bool allowWorkerTemp = false)
    {
        if (!TryEnumeratePinnedFiles(
                workDirectory,
                allowWorkerTemp,
                out ObservedPinnedFile[] observed))
            return false;
        if (requireComplete && observed.Length != Entries.Length)
            return false;
        return observed.All(file => FileMatchesPin(file.Path, file.Pin));
    }

    private static bool TryEnumeratePinnedFiles(
        string workDirectory,
        bool allowWorkerTemp,
        out ObservedPinnedFile[] observed)
    {
        observed = [];
        try
        {
            if (!IsExactWorkingDirectoryPath(workDirectory))
                return false;
            string[] paths = Directory.EnumerateFileSystemEntries(workDirectory)
                .Take(Entries.Length + (allowWorkerTemp ? 2 : 1))
                .ToArray();
            if (paths.Length > Entries.Length + (allowWorkerTemp ? 1 : 0))
                return false;

            var files = new List<ObservedPinnedFile>(paths.Length);
            var names = new HashSet<string>(StringComparer.Ordinal);
            bool sawWorkerTemp = false;
            foreach (string path in paths)
            {
                FileAttributes attributes = File.GetAttributes(path);
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                    return false;
                string name = Path.GetFileName(path);
                if (!names.Add(name))
                    return false;
                if ((attributes & FileAttributes.Directory) != 0)
                {
                    if (!allowWorkerTemp
                        || sawWorkerTemp
                        || !string.Equals(name, WorkerTempDirectoryName, StringComparison.Ordinal))
                    {
                        return false;
                    }
                    sawWorkerTemp = true;
                    continue;
                }
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

    private static bool FileMatchesSha256(string path, string expected)
    {
        try
        {
            using var source = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                128 * 1024,
                FileOptions.SequentialScan);
            return CryptographicOperations.FixedTimeEquals(
                SHA256.HashData(source),
                Convert.FromHexString(expected));
        }
        catch
        {
            return false;
        }
    }

    private static bool DeleteWorkerTemp(string workerTemp, string workDirectory)
    {
        try
        {
            string expected = Path.GetFullPath(
                Path.Combine(workDirectory, WorkerTempDirectoryName));
            string root = Path.GetFullPath(workerTemp);
            if (!string.Equals(root, expected, StringComparison.OrdinalIgnoreCase)
                || !IsOrdinaryDirectory(root))
            {
                return false;
            }

            string prefix = Path.TrimEndingDirectorySeparator(root)
                + Path.DirectorySeparatorChar;
            var pending = new Stack<string>();
            var directories = new List<string>();
            var files = new List<string>();
            pending.Push(root);
            long totalBytes = 0;
            int entries = 0;
            while (pending.TryPop(out string? directory))
            {
                foreach (string path in Directory.EnumerateFileSystemEntries(
                             directory,
                             "*",
                             SearchOption.TopDirectoryOnly))
                {
                    if (++entries > MaxWorkerTempEntries)
                        return false;
                    string full = Path.GetFullPath(path);
                    if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                        return false;
                    FileAttributes attributes = File.GetAttributes(full);
                    if ((attributes & FileAttributes.ReparsePoint) != 0)
                        return false;
                    if ((attributes & FileAttributes.Directory) != 0)
                    {
                        directories.Add(full);
                        pending.Push(full);
                    }
                    else
                    {
                        totalBytes = checked(totalBytes + new FileInfo(full).Length);
                        if (totalBytes > MaxWorkerTempBytes)
                            return false;
                        files.Add(full);
                    }
                }
            }

            foreach (string file in files)
                File.Delete(file);
            foreach (string directory in directories.OrderByDescending(path => path.Length))
                Directory.Delete(directory, recursive: false);
            Directory.Delete(root, recursive: false);
            return !Directory.Exists(root);
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
                if (!TryEnumeratePinnedFiles(
                        workDirectory,
                        allowWorkerTemp: true,
                        out ObservedPinnedFile[] files))
                    return false;
                if (requirePins && files.Any(file => !FileMatchesPin(file.Path, file.Pin)))
                    return false;
                string workerTemp = Path.Combine(workDirectory, WorkerTempDirectoryName);
                if (Directory.Exists(workerTemp) && !DeleteWorkerTemp(workerTemp, workDirectory))
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

    /// <summary>
    /// Owns the complete installer process tree. KILL_ON_JOB_CLOSE makes a
    /// coordinator crash fail closed, while BasicAccountingInformation gives
    /// supervision a tree-wide completion signal that Process.WaitForExit
    /// explicitly does not provide for descendants.
    /// </summary>
    private sealed class WorkerJob : IDisposable
    {
        private const uint JobObjectLimitKillOnJobClose = 0x0000_2000;
        private readonly SafeFileHandle _handle;

        private WorkerJob(SafeFileHandle handle)
        {
            _handle = handle;
        }

        internal static WorkerJob Create()
        {
            SafeFileHandle handle = CreateJobObjectW(nint.Zero, null);
            if (handle.IsInvalid)
            {
                handle.Dispose();
                throw new InstallerInvocationException();
            }

            var limits = new JobObjectExtendedLimitInformation
            {
                BasicLimitInformation = new JobObjectBasicLimitInformation
                {
                    LimitFlags = JobObjectLimitKillOnJobClose,
                },
            };
            if (!SetInformationJobObject(
                    handle,
                    JobObjectInformationClass.ExtendedLimitInformation,
                    ref limits,
                    checked((uint)Marshal.SizeOf<JobObjectExtendedLimitInformation>())))
            {
                handle.Dispose();
                throw new InstallerInvocationException();
            }
            return new WorkerJob(handle);
        }

        internal bool Assign(Process process)
        {
            try
            {
                return AssignProcessToJobObject(_handle, process.SafeHandle);
            }
            catch
            {
                return false;
            }
        }

        internal bool WaitForEmpty(TimeSpan timeout)
        {
            try
            {
                var elapsed = Stopwatch.StartNew();
                while (true)
                {
                    if (!TryGetActiveProcessCount(out uint active))
                        return false;
                    if (active == 0)
                        return true;
                    if (elapsed.Elapsed >= timeout)
                        return false;
                    Thread.Sleep(25);
                }
            }
            catch
            {
                // This predicate is a cleanup authorization boundary. Any
                // query/timing failure means the job is not proven empty.
                return false;
            }
        }

        internal bool TerminateAndWait(TimeSpan timeout)
        {
            // Termination is asynchronous. Its Boolean return is not the
            // postcondition: a concurrent natural exit can make the call fail
            // even though the job is already empty. The accounting query is
            // the only result used to authorize staging cleanup.
            try { _ = TerminateJobObject(_handle, 1); } catch { }
            return WaitForEmpty(timeout);
        }

        private bool TryGetActiveProcessCount(out uint active)
        {
            active = 0;
            if (!QueryInformationJobObject(
                    _handle,
                    JobObjectInformationClass.BasicAccountingInformation,
                    out JobObjectBasicAccountingInformation accounting,
                    checked((uint)Marshal.SizeOf<JobObjectBasicAccountingInformation>()),
                    out _))
            {
                return false;
            }
            active = accounting.ActiveProcesses;
            return true;
        }

        public void Dispose() => _handle.Dispose();
    }

    private enum JobObjectInformationClass
    {
        BasicAccountingInformation = 1,
        ExtendedLimitInformation = 9,
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicAccountingInformation
    {
        internal long TotalUserTime;
        internal long TotalKernelTime;
        internal long ThisPeriodTotalUserTime;
        internal long ThisPeriodTotalKernelTime;
        internal uint TotalPageFaultCount;
        internal uint TotalProcesses;
        internal uint ActiveProcesses;
        internal uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        internal long PerProcessUserTimeLimit;
        internal long PerJobUserTimeLimit;
        internal uint LimitFlags;
        internal nuint MinimumWorkingSetSize;
        internal nuint MaximumWorkingSetSize;
        internal uint ActiveProcessLimit;
        internal nuint Affinity;
        internal uint PriorityClass;
        internal uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        internal ulong ReadOperationCount;
        internal ulong WriteOperationCount;
        internal ulong OtherOperationCount;
        internal ulong ReadTransferCount;
        internal ulong WriteTransferCount;
        internal ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        internal JobObjectBasicLimitInformation BasicLimitInformation;
        internal IoCounters IoInfo;
        internal nuint ProcessMemoryLimit;
        internal nuint JobMemoryLimit;
        internal nuint PeakProcessMemoryUsed;
        internal nuint PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateJobObjectW", SetLastError = true,
        CharSet = CharSet.Unicode)]
    private static extern SafeFileHandle CreateJobObjectW(nint jobAttributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        SafeFileHandle job,
        JobObjectInformationClass informationClass,
        ref JobObjectExtendedLimitInformation information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(
        SafeFileHandle job,
        SafeProcessHandle process);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(SafeFileHandle job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(
        SafeFileHandle job,
        JobObjectInformationClass informationClass,
        out JobObjectBasicAccountingInformation information,
        uint informationLength,
        out uint returnLength);

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

    internal readonly record struct PackageObservation(
        bool OrdinaryDirectory,
        bool OrdinaryInf,
        bool OrdinaryDriver,
        bool InfHashMatches);

    private sealed class DownloadFailureException : Exception { }
    private sealed class PinFailureException : Exception { }
    private sealed class InstallerShapeException : Exception { }
    private sealed class InstallerInvocationException : Exception { }
    private sealed class SelfTestException : Exception { }
}
