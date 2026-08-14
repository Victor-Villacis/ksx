using System.Text;

namespace Ksx.HidMaestroProbe;

internal static class PureSelfTests
{
    internal static SelfTestDocument Run()
    {
        var tests = new List<TestResult>
        {
            Run("catalog parser normalizes IDs and defaults", ParserNormalizesAndDefaults),
            Run("contract accepts the pinned three-persona shape", ContractAcceptsPinnedShape),
            Run("contract rejects a property drift", ContractRejectsDrift),
            Run("contract rejects a missing persona", ContractRejectsMissingPersona),
            Run("managed resource extraction is length bounded", ManagedResourceExtractionIsBounded),
            Run("custom-attribute string parsing is strict", CustomAttributeStringParsingIsStrict),
            Run("catalog contract pins all aggregate facts", CatalogContractPinsAggregateFacts),
        };
        tests.AddRange(ProtocolSelfTests.Run());
        tests.AddRange(DistributionSelfTests.Run());

        return new SelfTestDocument(1, "self-test", tests.All(test => test.Passed), tests);
    }

    private static TestResult Run(string name, Action test)
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

    private static void ParserNormalizesAndDefaults()
    {
        byte[] json = Encoding.UTF8.GetBytes(
            """
            {"id":"sample","name":"Sample","vendor":"Vendor","vid":"54c","pid":"0x0ce6","productString":"Pad","type":"gamepad","descriptor":"0501","inputReportSize":2}
            """);
        CatalogProfile profile = CatalogInspection.ParseProfile(json, "test.sample.json");
        Require(profile.VendorId == "0x054C", "VID was not normalized.");
        Require(profile.ProductId == "0x0CE6", "PID was not normalized.");
        Require(profile.Connection == "usb", "Connection default drifted.");
        Require(profile.Backend == "umdf2", "Backend default drifted.");
        Require(profile.IsDeployable, "Descriptor-backed profile was not deployable.");
        Require(profile.DescriptorByteLength == 2, "Descriptor length was wrong.");
    }

    private static void ContractAcceptsPinnedShape()
    {
        ContractReport report = PersonaContract.Verify(PinnedProfiles());
        Require(report.Ok, "Pinned persona shapes were rejected.");
    }

    private static void ContractRejectsDrift()
    {
        List<CatalogProfile> profiles = PinnedProfiles();
        int index = profiles.FindIndex(profile => profile.Id == "xbox-series-xs-bt");
        profiles[index] = profiles[index] with { DriverMode = null };
        ContractReport report = PersonaContract.Verify(profiles);
        PersonaVerification xbox = report.Personas.Single(persona => persona.Id == "xbox-series-xs-bt");
        Require(!report.Ok && xbox.Mismatches.Contains("driverMode"), "Driver-mode drift was accepted.");
    }

    private static void ContractRejectsMissingPersona()
    {
        List<CatalogProfile> profiles = PinnedProfiles();
        profiles.RemoveAll(profile => profile.Id == "switch-pro");
        ContractReport report = PersonaContract.Verify(profiles);
        PersonaVerification missing = report.Personas.Single(persona => persona.Id == "switch-pro");
        Require(!report.Ok && missing.Mismatches.Contains("profile.missing"), "Missing persona was accepted.");
    }

    private static void ManagedResourceExtractionIsBounded()
    {
        // Catches the broken reader that trusted a resource-row offset/length
        // and sliced beyond the CLR resource directory.
        byte[] directory = [2, 0, 0, 0, 0xAA, 0x55];
        byte[] payload = ManagedPeReader.ExtractLengthPrefixedResource(directory, 0, "fixture");
        Require(payload.SequenceEqual(new byte[] { 0xAA, 0x55 }), "Valid resource bytes changed.");

        byte[] truncated = [3, 0, 0, 0, 0xAA, 0x55];
        ExpectThrows<InvalidDataException>(
            () => ManagedPeReader.ExtractLengthPrefixedResource(truncated, 0, "fixture"),
            "An out-of-bounds managed resource was accepted.");
        ExpectThrows<InvalidDataException>(
            () => ManagedPeReader.ExtractLengthPrefixedResource(directory, -1, "fixture"),
            "A negative managed-resource offset was accepted.");
    }

    private static void CustomAttributeStringParsingIsStrict()
    {
        // Catches the broken version reader that accepted a prefix and ignored
        // trailing named arguments or malformed serialized-string data.
        byte[] valid = [1, 0, 5, (byte)'1', (byte)'.', (byte)'6', (byte)'.', (byte)'1', 0, 0];
        string parsed = ManagedPeReader.ParseSingleStringCustomAttribute(valid, "fixture");
        Require(parsed == "1.6.1", $"Version attribute parsed as '{parsed}'.");

        byte[] trailing = [.. valid, 0];
        ExpectThrows<BadImageFormatException>(
            () => ManagedPeReader.ParseSingleStringCustomAttribute(trailing, "fixture"),
            "A custom attribute with trailing bytes was accepted.");
        byte[] invalidUtf8 = [1, 0, 1, 0xFF, 0, 0];
        ExpectThrows<BadImageFormatException>(
            () => ManagedPeReader.ParseSingleStringCustomAttribute(invalidUtf8, "fixture"),
            "A custom attribute with invalid UTF-8 was accepted.");
    }

    private static void CatalogContractPinsAggregateFacts()
    {
        // Catches the broken inventory that reported individual personas but
        // never gated total-resource, deployable-resource, or catalog-hash drift.
        var pinned = new CatalogReport(
            CatalogInspection.ExpectedResourceCount,
            CatalogInspection.ExpectedDeployableCount,
            CatalogInspection.ExpectedCatalogSha256,
            []);
        Require(CatalogInspection.MatchesPinnedContract(pinned), "Pinned aggregate facts were rejected.");
        Require(!CatalogInspection.MatchesPinnedContract(
                pinned with { DeployableCount = pinned.DeployableCount - 1 }),
            "Deployable-count drift was accepted.");
        Require(!CatalogInspection.MatchesPinnedContract(
                pinned with { CatalogSha256 = new string('0', 64) }),
            "Catalog-hash drift was accepted.");
    }

    private static List<CatalogProfile> PinnedProfiles() =>
    [
        Profile("dualsense", "DualSense (PS5)", "Sony", "0x054C", "0x0CE6", "DualSense Wireless Controller", "usb", null, null, 64),
        Profile("switch-pro", "Nintendo Switch Pro Controller", "Nintendo", "0x057E", "0x2009", "Pro Controller", "bluetooth", null, null, 362),
        Profile("xbox-series-xs-bt", "Xbox Series X|S Controller (Bluetooth)", "Microsoft", "0x045E", "0x0B13", "HID-compliant game controller", "bluetooth", "xinputhid", "separate", 17),
    ];

    private static CatalogProfile Profile(
        string id,
        string name,
        string vendor,
        string vid,
        string pid,
        string product,
        string connection,
        string? driverMode,
        string? triggerMode,
        int reportSize) =>
        new(
            id,
            name,
            vendor,
            vid,
            pid,
            product,
            vendor,
            "gamepad",
            connection,
            "umdf2",
            driverMode,
            triggerMode,
            true,
            reportSize,
            1,
            "descriptor",
            "resource");

    private static void Require(bool condition, string message)
    {
        if (!condition)
            throw new InvalidOperationException(message);
    }

    private static void ExpectThrows<TException>(Action action, string message)
        where TException : Exception
    {
        try
        {
            action();
        }
        catch (TException)
        {
            return;
        }
        throw new InvalidOperationException(message);
    }
}
