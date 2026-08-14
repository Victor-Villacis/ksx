using System.Globalization;
using System.Text.RegularExpressions;

namespace Ksx.HidMaestroProbe;

internal static partial class DistributionPolicy
{
    internal const string ManifestFileName = "ksx-hidmaestro-distribution.json";
    internal const string ExpectedTag = "v1.6.1";
    internal const string ExpectedCommit = "2a0dac0857901a63d365a36dcf99cf50114ca954";
    internal const int ExpectedProfileCount = 228;
    internal const string ExpectedProfileCatalogSha256 =
        "8F407E6E1C3C241E16CF6BEF387216AD4D1F5DE055A2C4CC041CA16CE7954A6A";
    internal const string ExpectedLicenseSha256 =
        "EDB0AE8061250BDE3FFBDA1B62AC63757FBEBE452C861C47FA11FADDFA506F56";

    // Deliberately false until KSX has a source-pinned release signer identity
    // and verifies that each supplied INF/DLL is a member of its signed catalog.
    // WinVerifyTrust on a catalog alone proves neither fact.
    internal const bool ReleaseSignerIdentityConfigured = false;
    internal const bool CatalogMembershipVerificationImplemented = false;

    internal static readonly IReadOnlyDictionary<string, string> ExpectedFiles =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["core-sdk"] = "sdk/HIDMaestro.Core.dll",
            ["play-host"] = "host/ksx-hidmaestro-host.exe",
            ["swd-helper"] = "host/hmswd.exe",
            ["hid-inf"] = "drivers/hidmaestro/hidmaestro.inf",
            ["hid-driver"] = "drivers/hidmaestro/HIDMaestro.dll",
            ["hid-catalog"] = "drivers/hidmaestro/hidmaestro.cat",
            ["xusb-inf"] = "drivers/hidmaestro-xusb/hidmaestro_xusb.inf",
            ["xusb-driver"] = "drivers/hidmaestro-xusb/HMXInput.dll",
            ["xusb-catalog"] = "drivers/hidmaestro-xusb/hidmaestro_xusb.cat",
            ["upstream-license"] = "licenses/HIDMaestro-MIT.txt",
        };

    private static readonly string[] DistributionSignedRoles =
    [
        "core-sdk",
        "play-host",
        "swd-helper",
        "hid-catalog",
        "xusb-catalog",
    ];

    internal static IReadOnlyList<DistributionCheck> Evaluate(DistributionFacts facts)
    {
        var checks = new List<DistributionCheck>();
        void Check(string code, bool passed, string detail) =>
            checks.Add(new DistributionCheck(code, passed, detail));

        DistributionManifest manifest = facts.Manifest;
        Check("manifest.schema", manifest.SchemaVersion == 1,
            $"expected schema 1; got {manifest.SchemaVersion}");
        bool stateKnown = manifest.CandidateState is "unsigned-build" or "distribution-ready";
        Check("manifest.candidateState", stateKnown,
            "candidateState must be unsigned-build or distribution-ready");
        Check("manifest.upstreamTag", manifest.UpstreamTag == ExpectedTag,
            $"expected {ExpectedTag}; got {manifest.UpstreamTag}");
        Check("manifest.upstreamCommit",
            manifest.UpstreamCommit.Equals(ExpectedCommit, StringComparison.OrdinalIgnoreCase),
            $"expected {ExpectedCommit}; got {manifest.UpstreamCommit}");

        bool versionValid = Version.TryParse(manifest.DriverVersion, out Version? version)
            && version.Major == 1 && version.Minor == 6 && version.Build == 1
            && version.Revision >= 0 && version.Revision <= ushort.MaxValue
            && DriverVersionPattern().IsMatch(manifest.DriverVersion);
        Check("manifest.driverVersion", versionValid,
            "driverVersion must be manifest-pinned 1.6.1.<0-65535>");
        bool dateValid = DateTime.TryParseExact(manifest.DriverDate, "MM/dd/yyyy",
            CultureInfo.InvariantCulture, DateTimeStyles.None, out DateTime driverDate)
            && driverDate.Date <= DateTime.UtcNow.Date;
        Check("manifest.driverDate", dateValid,
            "driverDate must be a non-future MM/dd/yyyy build input");

        string[] roles = manifest.Files.Select(file => file.Role).ToArray();
        string[] paths = manifest.Files.Select(file => Normalize(file.Path)).ToArray();
        Check("manifest.fileCount", manifest.Files.Count == ExpectedFiles.Count,
            $"expected exactly {ExpectedFiles.Count} pinned files; got {manifest.Files.Count}");
        Check("manifest.rolesUnique", roles.Distinct(StringComparer.Ordinal).Count() == roles.Length,
            "every file role must occur exactly once");
        Check("manifest.pathsUnique", paths.Distinct(StringComparer.OrdinalIgnoreCase).Count() == paths.Length,
            "every file path must occur exactly once");
        foreach ((string role, string path) in ExpectedFiles)
        {
            DistributionFilePin? pin = manifest.Files.SingleOrDefault(file => file.Role == role);
            Check($"manifest.role.{role}", pin is not null && Normalize(pin.Path) == path,
                $"{role} must pin the fixed path {path}");
            Check($"manifest.sha256.{role}", pin is not null && Sha256Pattern().IsMatch(pin.Sha256),
                $"{role} must carry one 64-digit SHA-256");
        }

        Check("tree.noUnexpectedFiles", facts.UnexpectedFiles.Count == 0,
            facts.UnexpectedFiles.Count == 0
                ? "candidate tree contains only the fixed manifest and ten pinned files"
                : $"unexpected files: {string.Join(", ", facts.UnexpectedFiles)}");
        Check("tree.noReparsePoints", facts.ReparsePoints.Count == 0,
            facts.ReparsePoints.Count == 0
                ? "candidate tree contains no reparse points"
                : $"reparse points: {string.Join(", ", facts.ReparsePoints)}");

        foreach ((string role, string _) in ExpectedFiles)
        {
            bool present = facts.Files.TryGetValue(role, out DistributionFileReport? report)
                && report.Present;
            Check($"file.present.{role}", present, $"required file {role} is present");
            bool hashMatches = present
                && report!.ExpectedSha256 is not null
                && report.ActualSha256 is not null
                && report.ExpectedSha256.Equals(report.ActualSha256, StringComparison.OrdinalIgnoreCase);
            Check($"file.sha256.{role}", hashMatches, $"required file {role} matches its manifest hash");
            bool signatureNotInvalid = !present || report!.SignatureState is not "invalid";
            Check($"file.signatureNotInvalid.{role}", signatureNotInvalid,
                $"{role} must not carry an invalid signature");
        }

        Check("sdk.managedPe", facts.Sdk.ManagedPe, "core SDK must be a managed PE inspected without loading it");
        Check("sdk.assemblyVersion", facts.Sdk.AssemblyVersion == "1.6.1.0",
            $"expected managed assembly version 1.6.1.0; got {facts.Sdk.AssemblyVersion ?? "<none>"}");
        Check("sdk.profileCount", facts.Sdk.ProfileResourceCount == ExpectedProfileCount,
            $"expected {ExpectedProfileCount} profile resources; got {facts.Sdk.ProfileResourceCount}");
        Check("sdk.profileCatalogHash",
            ExpectedProfileCatalogSha256.Equals(facts.Sdk.ProfileCatalogSha256, StringComparison.OrdinalIgnoreCase),
            $"expected profile catalog {ExpectedProfileCatalogSha256}; got {facts.Sdk.ProfileCatalogSha256 ?? "<none>"}");
        Check("sdk.onlyAllowedManagedResources", facts.Sdk.ForbiddenResources.Count == 0,
            facts.Sdk.ForbiddenResources.Count == 0
                ? "managed manifest resources contain none of the known driver, helper, WDK, USB/IP, or VR names"
                : $"forbidden managed resources: {string.Join(", ", facts.Sdk.ForbiddenResources)}");
        Check("sdk.noUnknownResources", facts.Sdk.UnknownResources.Count == 0,
            facts.Sdk.UnknownResources.Count == 0
                ? "SDK embeds only the pinned profile catalog"
                : $"unknown resources: {string.Join(", ", facts.Sdk.UnknownResources)}");
        Check("sdk.noKnownProvisioningSymbols", facts.Sdk.ForbiddenLifecycleMembers.Count == 0,
            facts.Sdk.ForbiddenLifecycleMembers.Count == 0
                ? "managed metadata contains none of the denylisted provisioning type or method names"
                : $"forbidden managed symbols: {string.Join(", ", facts.Sdk.ForbiddenLifecycleMembers)}");
        Check("sdk.knownRuntimeSymbols", facts.Sdk.MissingRuntimeMembers.Count == 0,
            facts.Sdk.MissingRuntimeMembers.Count == 0
                ? "managed metadata retains the expected context/controller/profile type and method names"
                : $"missing expected managed symbols: {string.Join(", ", facts.Sdk.MissingRuntimeMembers)}");

        Check("license.normalizedText", facts.LicenseMatches,
            "HIDMaestro MIT license matches the pinned v1.6.1 normalized text");
        AddInfChecks(checks, "hid", facts.MainInf, manifest, "hidmaestro.cat", "HIDMaestro.dll");
        AddInfChecks(checks, "xusb", facts.XusbInf, manifest, "hidmaestro_xusb.cat", "HMXInput.dll");

        if (manifest.CandidateState == "distribution-ready")
        {
            foreach (string role in DistributionSignedRoles)
            {
                bool trusted = facts.Files.TryGetValue(role, out DistributionFileReport? file)
                    && file.SignatureState == "trusted";
                Check($"distribution.signature.{role}", trusted,
                    $"distribution-ready requires an offline-trusted signature on {role}");
            }
            Check("distribution.signerIdentityPinned", ReleaseSignerIdentityConfigured,
                "distribution-ready is blocked until the KSX release signer identity is pinned in source");
            Check("distribution.catalogMembershipVerified", CatalogMembershipVerificationImplemented,
                "distribution-ready is blocked until each INF/DLL is verified as a member of its signed catalog");
        }
        else
        {
            Check("distribution.state", manifest.CandidateState == "unsigned-build",
                "an unsigned build can prove structure but is not distributable");
        }

        return checks;
    }

    internal static bool IsDistributionReady(
        DistributionManifest manifest,
        IReadOnlyList<DistributionCheck> checks) =>
        ReleaseSignerIdentityConfigured
        && CatalogMembershipVerificationImplemented
        && manifest.CandidateState == "distribution-ready"
        && checks.All(check => check.Passed);

    internal static string Normalize(string path) => path.Replace('\\', '/');

    private static void AddInfChecks(
        ICollection<DistributionCheck> checks,
        string prefix,
        InfPackageFacts inf,
        DistributionManifest manifest,
        string catalog,
        string binary)
    {
        void Check(string suffix, bool passed, string detail) =>
            checks.Add(new DistributionCheck($"inf.{prefix}.{suffix}", passed, detail));
        Check("driverDate", inf.DriverDate == manifest.DriverDate,
            $"DriverVer date must equal manifest {manifest.DriverDate}; got {inf.DriverDate}");
        Check("driverVersion", inf.DriverVersion == manifest.DriverVersion,
            $"DriverVer version must equal manifest {manifest.DriverVersion}; got {inf.DriverVersion}");
        Check("catalog", inf.CatalogFile.Equals(catalog, StringComparison.OrdinalIgnoreCase),
            $"CatalogFile must be {catalog}; got {inf.CatalogFile}");
        Check("provider", inf.Provider == "%ProviderName%",
            $"Provider must remain %ProviderName%; got {inf.Provider}");
        Check("serviceBinary", inf.ServiceBinary.Equals(binary, StringComparison.OrdinalIgnoreCase),
            $"UMDF ServiceBinary must be {binary}; got {inf.ServiceBinary}");
        Check("pnpLockdown", inf.PnpLockdown, "PnpLockdown must remain 1");
    }

    [GeneratedRegex(@"^1\.6\.1\.(?:0|[1-9][0-9]{0,4})$", RegexOptions.CultureInvariant)]
    private static partial Regex DriverVersionPattern();

    [GeneratedRegex(@"^[0-9A-Fa-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex Sha256Pattern();
}
