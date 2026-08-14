using System.Buffers.Binary;
using System.Collections.Immutable;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Ksx.HidMaestroProbe;

internal static class DistributionAudit
{
    private static readonly JsonSerializerOptions ManifestJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    internal static DistributionCandidateDocument Run(string candidateRoot, SafetyReport safety)
    {
        string root = candidateRoot;
        string manifestPath = DistributionPolicy.ManifestFileName;
        try
        {
            root = Path.GetFullPath(candidateRoot);
            manifestPath = Path.Combine(root, DistributionPolicy.ManifestFileName);
            EnsurePlainDirectory(root);
            EnsurePlainFileIfPresent(manifestPath);
            DistributionManifest manifest = ReadManifest(manifestPath);
            DistributionFacts facts = Inspect(root, manifestPath, manifest);
            IReadOnlyList<DistributionCheck> checks = DistributionPolicy.Evaluate(facts);
            bool ok = checks.All(check => check.Passed);
            bool ready = DistributionPolicy.IsDistributionReady(manifest, checks);
            return new DistributionCandidateDocument(
                1,
                "distribution-candidate",
                "structural-only-quiescent-tree",
                ok,
                ready,
                root,
                manifestPath,
                manifest.CandidateState,
                facts.Files.Values.OrderBy(file => file.Role, StringComparer.Ordinal).ToArray(),
                facts.Sdk,
                checks,
                safety,
                ok ? null : new ErrorInfo(
                    "distribution_policy_failed",
                    "The candidate failed one or more fail-closed distribution checks."));
        }
        catch (Exception exception)
        {
            return new DistributionCandidateDocument(
                1,
                "distribution-candidate",
                "structural-only-quiescent-tree",
                false,
                false,
                root,
                manifestPath,
                null,
                [],
                null,
                [],
                safety,
                new ErrorInfo("distribution_audit_failed", exception.Message, exception.GetType().FullName));
        }
    }

    internal static DistributionFacts Inspect(
        string root,
        string manifestPath,
        DistributionManifest manifest,
        IFileSignatureInspector? signatureInspector = null)
    {
        signatureInspector ??= new WindowsFileSignatureInspector();
        (List<string> unexpected, List<string> reparses) = InventoryTree(root);
        var expectedTree = new HashSet<string>(
            DistributionPolicy.ExpectedFiles.Values.Append(DistributionPolicy.ManifestFileName),
            StringComparer.OrdinalIgnoreCase);
        unexpected.RemoveAll(expectedTree.Contains);

        var pinsByRole = manifest.Files
            .GroupBy(pin => pin.Role, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.Ordinal);
        var reports = new Dictionary<string, DistributionFileReport>(StringComparer.Ordinal);
        foreach ((string role, string fixedRelativePath) in DistributionPolicy.ExpectedFiles)
        {
            string fullPath = ResolveFixedPath(root, fixedRelativePath);
            pinsByRole.TryGetValue(role, out DistributionFilePin? pin);
            bool present = !IsAtOrBelowReparsePoint(fixedRelativePath, reparses)
                && File.Exists(fullPath);
            string? actualHash = present ? HashFile(fullPath) : null;
            string signature = present && IsSignedRole(role)
                ? signatureInspector.Inspect(fullPath)
                : "not-applicable";
            reports[role] = new DistributionFileReport(
                role,
                fixedRelativePath,
                present,
                pin?.Sha256,
                actualHash,
                signature);
        }

        string sdkPath = ResolveFixedPath(root, DistributionPolicy.ExpectedFiles["core-sdk"]);
        DistributionSdkReport sdk = reports["core-sdk"].Present
            ? ManagedPeInspection.Inspect(sdkPath)
            : EmptySdkReport();
        string mainInfPath = ResolveFixedPath(root, DistributionPolicy.ExpectedFiles["hid-inf"]);
        string xusbInfPath = ResolveFixedPath(root, DistributionPolicy.ExpectedFiles["xusb-inf"]);
        InfPackageFacts mainInf = reports["hid-inf"].Present
            ? InfInspection.Read(mainInfPath)
            : EmptyInf();
        InfPackageFacts xusbInf = reports["xusb-inf"].Present
            ? InfInspection.Read(xusbInfPath)
            : EmptyInf();
        string licensePath = ResolveFixedPath(root, DistributionPolicy.ExpectedFiles["upstream-license"]);
        bool licenseMatches = reports.TryGetValue("upstream-license", out DistributionFileReport? license)
            && license.Present
            && DistributionPolicy.ExpectedLicenseSha256.Equals(
                HashNormalizedText(licensePath),
                StringComparison.OrdinalIgnoreCase);

        _ = manifestPath;
        return new DistributionFacts(
            manifest,
            reports,
            sdk,
            unexpected,
            reparses,
            mainInf,
            xusbInf,
            licenseMatches);
    }

    private static DistributionManifest ReadManifest(string path)
    {
        if (!File.Exists(path))
            throw new FileNotFoundException(
                $"Candidate manifest '{DistributionPolicy.ManifestFileName}' is missing.", path);
        if (new FileInfo(path).Length > 64 * 1024)
            throw new InvalidDataException("Candidate manifest exceeds the 64 KiB limit.");
        using FileStream stream = new(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        return JsonSerializer.Deserialize<DistributionManifest>(stream, ManifestJson)
            ?? throw new InvalidDataException("Candidate manifest is empty.");
    }

    private static (List<string> Files, List<string> ReparsePoints) InventoryTree(string root)
    {
        if (!Directory.Exists(root))
            throw new DirectoryNotFoundException($"Candidate directory does not exist: {root}");
        var files = new List<string>();
        var reparses = new List<string>();
        var pending = new Stack<DirectoryInfo>();
        pending.Push(new DirectoryInfo(root));
        while (pending.TryPop(out DirectoryInfo? directory))
        {
            foreach (FileSystemInfo entry in directory.EnumerateFileSystemInfos())
            {
                string relative = DistributionPolicy.Normalize(Path.GetRelativePath(root, entry.FullName));
                if ((entry.Attributes & FileAttributes.ReparsePoint) != 0)
                {
                    reparses.Add(relative);
                    continue;
                }
                if ((entry.Attributes & FileAttributes.Directory) != 0)
                    pending.Push((DirectoryInfo)entry);
                else
                    files.Add(relative);
            }
        }
        files.Sort(StringComparer.OrdinalIgnoreCase);
        reparses.Sort(StringComparer.OrdinalIgnoreCase);
        return (files, reparses);
    }

    private static void EnsurePlainDirectory(string path)
    {
        if (!Directory.Exists(path))
            throw new DirectoryNotFoundException($"Candidate directory does not exist: {path}");
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("Candidate root must not be a reparse point.");
    }

    private static void EnsurePlainFileIfPresent(string path)
    {
        if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("Candidate manifest must not be a reparse point.");
    }

    private static bool IsAtOrBelowReparsePoint(
        string fixedRelativePath,
        IReadOnlyList<string> reparsePoints)
    {
        string path = DistributionPolicy.Normalize(fixedRelativePath);
        return reparsePoints.Any(reparse =>
            path.Equals(reparse, StringComparison.OrdinalIgnoreCase)
            || path.StartsWith(reparse.TrimEnd('/') + "/", StringComparison.OrdinalIgnoreCase));
    }

    private static string ResolveFixedPath(string root, string fixedRelativePath)
    {
        string full = Path.GetFullPath(Path.Combine(root, fixedRelativePath.Replace('/', Path.DirectorySeparatorChar)));
        string rootWithSeparator = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(rootWithSeparator, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"Fixed candidate path escaped its root: {fixedRelativePath}");
        return full;
    }

    private static string HashFile(string path)
    {
        using FileStream stream = new(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        return Convert.ToHexString(SHA256.HashData(stream));
    }

    private static string HashNormalizedText(string path)
    {
        string text = File.ReadAllText(path)
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .TrimEnd() + "\n";
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
    }

    private static bool IsSignedRole(string role) =>
        role is "core-sdk" or "play-host" or "swd-helper" or "hid-driver"
            or "hid-catalog" or "xusb-driver" or "xusb-catalog";

    private static DistributionSdkReport EmptySdkReport() =>
        new(false, null, 0, null, [], [], [], ["HIDMaestro.Core.dll"]);

    private static InfPackageFacts EmptyInf() => new("", "", "", "", "", false);
}

internal static class ManagedPeInspection
{
    private const string ProfilePrefix = "HIDMaestro.Profiles.";
    private static readonly HashSet<string> RequiredTypes = new(StringComparer.Ordinal)
    {
        "HIDMaestro.HMContext",
        "HIDMaestro.HMController",
        "HIDMaestro.HMProfile",
    };
    private static readonly IReadOnlyDictionary<string, string[]> RequiredMethods =
        new Dictionary<string, string[]>(StringComparer.Ordinal)
        {
            ["HIDMaestro.HMContext"] = ["LoadDefaultProfiles", "GetProfile", "CreateController"],
            ["HIDMaestro.HMController"] = ["SubmitState", "Dispose"],
        };
    private static readonly HashSet<string> ForbiddenTypes = new(StringComparer.Ordinal)
    {
        "HIDMaestro.Internal.DriverBuilder",
        "HIDMaestro.Internal.PnputilHelper",
        "HIDMaestro.Internal.Usbip.UsbipDriverInstaller",
        "HIDMaestro.Internal.VrDriverBuilder",
    };
    private static readonly HashSet<string> ForbiddenMethods = new(StringComparer.Ordinal)
    {
        "InstallDriver",
        "RemoveAllVirtualControllers",
        "InstallUsbipBackend",
        "EnsureTestCertificate",
        "SignDrivers",
        "GenerateCatalogs",
        "FullDeploy",
        "RemoveOldDriverPackages",
        "EnsureHelperExtracted",
        "EnsureDriverRegistered",
    };

    internal static DistributionSdkReport Inspect(string path)
    {
        try
        {
            using FileStream file = new(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            using var pe = new PEReader(file, PEStreamOptions.LeaveOpen);
            if (!pe.HasMetadata || pe.PEHeaders.CorHeader is null)
                return new DistributionSdkReport(false, null, 0, null, [], [], [], ["managed metadata"]);
            MetadataReader metadata = pe.GetMetadataReader();
            string? assemblyVersion = metadata.IsAssembly
                ? metadata.GetAssemblyDefinition().Version.ToString()
                : null;
            IReadOnlyDictionary<string, byte[]> resources = ReadEmbeddedResources(pe, metadata);
            string[] profiles = resources.Keys
                .Where(name => name.StartsWith(ProfilePrefix, StringComparison.Ordinal)
                    && name.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToArray();
            string catalogHash = HashCatalog(resources, profiles);
            string[] forbiddenResources = resources.Keys
                .Where(name => name.StartsWith("HIDMaestro.Resources.", StringComparison.Ordinal)
                    || name.StartsWith("HIDMaestro.VR.", StringComparison.Ordinal))
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToArray();
            string[] unknownResources = resources.Keys
                .Except(profiles, StringComparer.Ordinal)
                .Except(forbiddenResources, StringComparer.Ordinal)
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToArray();

            var methodsByType = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
            var forbiddenMembers = new List<string>();
            foreach (TypeDefinitionHandle handle in metadata.TypeDefinitions)
            {
                TypeDefinition type = metadata.GetTypeDefinition(handle);
                string typeName = QualifiedName(metadata, type);
                if (ForbiddenTypes.Contains(typeName))
                    forbiddenMembers.Add(typeName);
                var methods = new HashSet<string>(StringComparer.Ordinal);
                foreach (MethodDefinitionHandle methodHandle in type.GetMethods())
                {
                    string methodName = metadata.GetString(metadata.GetMethodDefinition(methodHandle).Name);
                    methods.Add(methodName);
                    if (ForbiddenMethods.Contains(methodName))
                        forbiddenMembers.Add($"{typeName}.{methodName}");
                }
                methodsByType[typeName] = methods;
            }

            var missing = new List<string>();
            foreach (string requiredType in RequiredTypes)
                if (!methodsByType.ContainsKey(requiredType))
                    missing.Add(requiredType);
            foreach ((string typeName, string[] methods) in RequiredMethods)
            {
                if (!methodsByType.TryGetValue(typeName, out HashSet<string>? present))
                    continue;
                foreach (string method in methods)
                    if (!present.Contains(method))
                        missing.Add($"{typeName}.{method}");
            }

            forbiddenMembers.Sort(StringComparer.Ordinal);
            missing.Sort(StringComparer.Ordinal);
            return new DistributionSdkReport(
                true,
                assemblyVersion,
                profiles.Length,
                catalogHash,
                forbiddenResources,
                unknownResources,
                forbiddenMembers.Distinct(StringComparer.Ordinal).ToArray(),
                missing);
        }
        catch (Exception exception)
        {
            return new DistributionSdkReport(
                false,
                null,
                0,
                null,
                [],
                [$"inspection failed: {exception.GetType().Name}: {exception.Message}"],
                [],
                ["managed metadata"]);
        }
    }

    private static IReadOnlyDictionary<string, byte[]> ReadEmbeddedResources(
        PEReader pe,
        MetadataReader metadata)
    {
        DirectoryEntry directory = pe.PEHeaders.CorHeader!.ResourcesDirectory;
        if (directory.RelativeVirtualAddress == 0 || directory.Size == 0)
            return new Dictionary<string, byte[]>(StringComparer.Ordinal);
        ImmutableArray<byte> content = pe
            .GetSectionData(directory.RelativeVirtualAddress)
            .GetContent(0, directory.Size);
        ReadOnlySpan<byte> bytes = content.AsSpan();
        var resources = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        foreach (ManifestResourceHandle handle in metadata.ManifestResources)
        {
            ManifestResource resource = metadata.GetManifestResource(handle);
            string name = metadata.GetString(resource.Name);
            if (!resource.Implementation.IsNil)
                throw new InvalidDataException($"Linked manifest resource is forbidden: {name}");
            if (resource.Offset > int.MaxValue)
                throw new InvalidDataException($"Manifest resource offset is too large: {name}");
            int offset = checked((int)resource.Offset);
            if (offset < 0 || offset > bytes.Length - sizeof(int))
                throw new InvalidDataException($"Manifest resource offset is outside the resource directory: {name}");
            int length = BinaryPrimitives.ReadInt32LittleEndian(bytes.Slice(offset, sizeof(int)));
            if (length < 0 || length > bytes.Length - offset - sizeof(int))
                throw new InvalidDataException($"Manifest resource length is invalid: {name}");
            if (!resources.TryAdd(name, bytes.Slice(offset + sizeof(int), length).ToArray()))
                throw new InvalidDataException($"Duplicate manifest resource name: {name}");
        }
        return resources;
    }

    private static string HashCatalog(IReadOnlyDictionary<string, byte[]> resources, string[] profiles)
    {
        using IncrementalHash hasher = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (string name in profiles)
        {
            hasher.AppendData(Encoding.UTF8.GetBytes(name));
            hasher.AppendData([0]);
            hasher.AppendData(resources[name]);
            hasher.AppendData([0]);
        }
        return Convert.ToHexString(hasher.GetHashAndReset());
    }

    private static string QualifiedName(MetadataReader metadata, TypeDefinition type)
    {
        string name = metadata.GetString(type.Name);
        string ns = metadata.GetString(type.Namespace);
        return string.IsNullOrEmpty(ns) ? name : $"{ns}.{name}";
    }
}

internal static class InfInspection
{
    internal static InfPackageFacts Read(string path) => Parse(File.ReadAllText(path));

    internal static InfPackageFacts Parse(string text)
    {
        var sections = new Dictionary<string, List<KeyValuePair<string, string>>>(
            StringComparer.OrdinalIgnoreCase);
        string section = "";
        foreach (string originalLine in text.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n'))
        {
            string line = originalLine;
            int comment = line.IndexOf(';');
            if (comment >= 0)
                line = line[..comment];
            line = line.Trim();
            if (line.StartsWith("[", StringComparison.Ordinal)
                && line.EndsWith("]", StringComparison.Ordinal)
                && line.Length > 2)
            {
                section = line[1..^1].Trim();
                sections.TryAdd(section, []);
                continue;
            }
            int equals = line.IndexOf('=');
            if (equals <= 0)
                continue;
            string key = line[..equals].Trim();
            string value = line[(equals + 1)..].Trim();
            if (!sections.TryGetValue(section, out List<KeyValuePair<string, string>>? values))
            {
                values = [];
                sections[section] = values;
            }
            values.Add(KeyValuePair.Create(key, value));
        }

        string driverVer = UniqueValue("Version", "DriverVer");
        string[] driverParts = driverVer.Split(',', 2, StringSplitOptions.TrimEntries);
        KeyValuePair<string, string>[] umdfMappings = sections.Values
            .SelectMany(values => values)
            .Where(pair => pair.Key.Equals("UmdfService", StringComparison.OrdinalIgnoreCase))
            .ToArray();
        string serviceSection = umdfMappings.Length == 1
            ? umdfMappings[0].Value.Split(',', 2, StringSplitOptions.TrimEntries).ElementAtOrDefault(1) ?? ""
            : "";
        string serviceBinary = UniqueValue(serviceSection, "ServiceBinary");
        const string driverDirectory = "%13%\\";
        if (serviceBinary.StartsWith(driverDirectory, StringComparison.OrdinalIgnoreCase))
            serviceBinary = serviceBinary[driverDirectory.Length..];

        return new InfPackageFacts(
            driverParts.ElementAtOrDefault(0) ?? "",
            driverParts.ElementAtOrDefault(1) ?? "",
            UniqueValue("Version", "CatalogFile"),
            UniqueValue("Version", "Provider"),
            serviceBinary,
            UniqueValue("Version", "PnpLockdown") == "1");

        string UniqueValue(string sectionName, string key)
        {
            if (!sections.TryGetValue(sectionName, out List<KeyValuePair<string, string>>? values))
                return "";
            string[] matches = values
                .Where(pair => pair.Key.Equals(key, StringComparison.OrdinalIgnoreCase))
                .Select(pair => pair.Value)
                .ToArray();
            return matches.Length == 1 ? matches[0] : "";
        }
    }
}
