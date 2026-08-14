namespace Ksx.HidMaestroProbe;

internal static class DistributionSelfTests
{
    internal static IReadOnlyList<TestResult> Run() =>
    [
        RunOne("distribution policy accepts a complete unsigned build", AcceptsUnsignedBuild),
        RunOne("distribution-ready requires every release signature", RequiresTrustedReleaseSignatures),
        RunOne("trusted files cannot bypass unconfigured release provenance", TrustedFilesCannotBypassProvenance),
        RunOne("known provisioning resources and symbols are rejected", RejectsKnownProvisioning),
        RunOne("release INF version drift is rejected", RejectsInfVersionDrift),
        RunOne("candidate tree extras and reparse points are rejected", RejectsTreeDrift),
        RunOne("INF parser follows the declared UMDF service section", ParsesUmdfServiceSection),
        RunOne("invalid candidate roots remain distribution audit errors", InvalidRootKeepsCommandShape),
    ];

    private static TestResult RunOne(string name, Action test)
    {
        try
        {
            test();
            return new TestResult(name, true, "passed");
        }
        catch (Exception exception)
        {
            return new TestResult(name, false, exception.Message);
        }
    }

    private static void AcceptsUnsignedBuild()
    {
        DistributionFacts facts = BaselineFacts();
        IReadOnlyList<DistributionCheck> checks = DistributionPolicy.Evaluate(facts);
        Require(checks.All(check => check.Passed), FailedCodes(checks));
        Require(!DistributionPolicy.IsDistributionReady(facts.Manifest, checks),
            "An unsigned build was marked distribution-ready.");
    }

    private static void RequiresTrustedReleaseSignatures()
    {
        DistributionFacts unsigned = BaselineFacts("distribution-ready");
        IReadOnlyList<DistributionCheck> rejected = DistributionPolicy.Evaluate(unsigned);
        Require(!Check(rejected, "distribution.signature.core-sdk").Passed,
            "An unsigned Core SDK was accepted for distribution.");

    }

    private static void TrustedFilesCannotBypassProvenance()
    {
        DistributionFacts candidate = BaselineFacts("distribution-ready");
        var trustedFiles = candidate.Files.ToDictionary(
            pair => pair.Key,
            pair => IsReleaseSignedRole(pair.Key)
                ? pair.Value with { SignatureState = "trusted" }
                : pair.Value,
            StringComparer.Ordinal);
        DistributionFacts trusted = candidate with { Files = trustedFiles };
        IReadOnlyList<DistributionCheck> checks = DistributionPolicy.Evaluate(trusted);
        Require(checks.Where(check => check.Code.StartsWith("distribution.signature.", StringComparison.Ordinal))
                .All(check => check.Passed),
            "The trusted-signature fixture did not reach the provenance guards.");
        Require(!Check(checks, "distribution.signerIdentityPinned").Passed,
            "A caller-controlled trusted signer was treated as KSX provenance.");
        Require(!Check(checks, "distribution.catalogMembershipVerified").Passed,
            "A catalog signature was treated as proof of package membership.");
        Require(!DistributionPolicy.IsDistributionReady(trusted.Manifest, checks),
            "Caller-controlled trusted files bypassed the release-provenance guard.");
    }

    private static void RejectsKnownProvisioning()
    {
        DistributionFacts baseline = BaselineFacts();
        DistributionSdkReport sdk = baseline.Sdk with
        {
            ForbiddenResources =
            [
                "HIDMaestro.Resources.signtool.exe",
                "HIDMaestro.Resources.Inf2Cat.exe",
                "HIDMaestro.Resources.hmswd.exe",
            ],
            ForbiddenLifecycleMembers =
            [
                "HIDMaestro.HMContext.InstallDriver",
                "HIDMaestro.Internal.SwdDeviceFactory.EnsureHelperExtracted",
            ],
        };
        IReadOnlyList<DistributionCheck> checks = DistributionPolicy.Evaluate(
            baseline with { Sdk = sdk });
        Require(!Check(checks, "sdk.onlyAllowedManagedResources").Passed,
            "Known WDK/helper managed resources were accepted.");
        Require(!Check(checks, "sdk.noKnownProvisioningSymbols").Passed,
            "Known provisioning symbols were accepted.");
    }

    private static void RejectsInfVersionDrift()
    {
        DistributionFacts baseline = BaselineFacts();
        var drifted = baseline with
        {
            MainInf = baseline.MainInf with { DriverDate = "08/08/2026", DriverVersion = "1.4.7.2308" },
            XusbInf = baseline.XusbInf with { DriverDate = "08/08/2026", DriverVersion = "1.4.7.2308" },
        };
        IReadOnlyList<DistributionCheck> checks = DistributionPolicy.Evaluate(drifted);
        Require(!Check(checks, "inf.hid.driverVersion").Passed,
            "The stale HID INF version was accepted.");
        Require(!Check(checks, "inf.xusb.driverVersion").Passed,
            "The stale XUSB INF version was accepted.");
        Require(!Check(checks, "inf.hid.driverDate").Passed,
            "The stale HID INF date was accepted.");
    }

    private static void RejectsTreeDrift()
    {
        DistributionFacts baseline = BaselineFacts();
        IReadOnlyList<DistributionCheck> checks = DistributionPolicy.Evaluate(
            baseline with
            {
                UnexpectedFiles = ["host/debug.pdb"],
                ReparsePoints = ["sdk"],
            });
        Require(!Check(checks, "tree.noUnexpectedFiles").Passed,
            "An unpinned package file was accepted.");
        Require(!Check(checks, "tree.noReparsePoints").Passed,
            "A reparse point was accepted.");
    }

    private static void ParsesUmdfServiceSection()
    {
        InfPackageFacts facts = InfInspection.Parse(
            """
            [Version]
            Signature="$WINDOWS NT$"
            Provider=%ProviderName%
            CatalogFile=hidmaestro.cat
            DriverVer=01/01/2000,1.6.1.0
            PnpLockdown=1

            [WUDFRD_Service]
            ServiceBinary=%10%\System32\Drivers\WUDFRd.sys

            [Device.NT.Wdf]
            UmdfService=HIDMaestro,HIDMaestro_UmdfService

            [HIDMaestro_UmdfService]
            ServiceBinary=%13%\HIDMaestro.dll
            """);
        Require(facts.ServiceBinary == "HIDMaestro.dll",
            $"Parsed the wrong ServiceBinary: {facts.ServiceBinary}");
    }

    private static void InvalidRootKeepsCommandShape()
    {
        var safety = new SafetyReport(true, false, false, "deferred", "pure test");
        DistributionCandidateDocument document = DistributionAudit.Run("\0", safety);
        Require(!document.Ok, "An invalid root was accepted.");
        Require(document.Command == "distribution-candidate",
            $"The error escaped into the wrong command shape: {document.Command}");
        Require(document.Assurance == "structural-only-quiescent-tree",
            $"The command overstated its assurance: {document.Assurance}");
        Require(document.Error?.Code == "distribution_audit_failed",
            $"Unexpected error code: {document.Error?.Code ?? "<none>"}");
    }

    private static DistributionFacts BaselineFacts(string state = "unsigned-build")
    {
        const string hash = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        var pins = DistributionPolicy.ExpectedFiles
            .Select(pair => new DistributionFilePin(pair.Key, pair.Value, hash))
            .ToArray();
        var manifest = new DistributionManifest(
            1,
            state,
            DistributionPolicy.ExpectedTag,
            DistributionPolicy.ExpectedCommit,
            "01/01/2000",
            "1.6.1.0",
            pins);
        var files = DistributionPolicy.ExpectedFiles.ToDictionary(
            pair => pair.Key,
            pair => new DistributionFileReport(
                pair.Key,
                pair.Value,
                true,
                hash,
                hash,
                IsInspectedSignatureRole(pair.Key) ? "unsigned" : "not-applicable"),
            StringComparer.Ordinal);
        var sdk = new DistributionSdkReport(
            true,
            "1.6.1.0",
            DistributionPolicy.ExpectedProfileCount,
            DistributionPolicy.ExpectedProfileCatalogSha256,
            [],
            [],
            [],
            []);
        var hidInf = new InfPackageFacts(
            manifest.DriverDate,
            manifest.DriverVersion,
            "hidmaestro.cat",
            "%ProviderName%",
            "HIDMaestro.dll",
            true);
        var xusbInf = new InfPackageFacts(
            manifest.DriverDate,
            manifest.DriverVersion,
            "hidmaestro_xusb.cat",
            "%ProviderName%",
            "HMXInput.dll",
            true);
        return new DistributionFacts(
            manifest,
            files,
            sdk,
            [],
            [],
            hidInf,
            xusbInf,
            true);
    }

    private static bool IsInspectedSignatureRole(string role) =>
        role is "core-sdk" or "play-host" or "swd-helper" or "hid-driver"
            or "hid-catalog" or "xusb-driver" or "xusb-catalog";

    private static bool IsReleaseSignedRole(string role) =>
        role is "core-sdk" or "play-host" or "swd-helper" or "hid-catalog" or "xusb-catalog";

    private static DistributionCheck Check(
        IReadOnlyList<DistributionCheck> checks,
        string code) => checks.Single(check => check.Code == code);

    private static string FailedCodes(IReadOnlyList<DistributionCheck> checks) =>
        $"Unexpected failures: {string.Join(", ", checks.Where(check => !check.Passed).Select(check => check.Code))}";

    private static void Require(bool condition, string message)
    {
        if (!condition)
            throw new InvalidOperationException(message);
    }
}
