namespace Ksx.HidMaestroProbe;

internal static class PersonaContract
{
    private static readonly IReadOnlyDictionary<string, PersonaShape> Expected =
        new Dictionary<string, PersonaShape>(StringComparer.Ordinal)
        {
            ["dualsense"] = new(
                "DualSense (PS5)",
                "Sony",
                "0x054C",
                "0x0CE6",
                "DualSense Wireless Controller",
                "gamepad",
                "usb",
                "umdf2",
                null,
                null,
                true,
                64),
            ["switch-pro"] = new(
                "Nintendo Switch Pro Controller",
                "Nintendo",
                "0x057E",
                "0x2009",
                "Pro Controller",
                "gamepad",
                "bluetooth",
                "umdf2",
                null,
                null,
                true,
                362),
            ["xbox-series-xs-bt"] = new(
                "Xbox Series X|S Controller (Bluetooth)",
                "Microsoft",
                "0x045E",
                "0x0B13",
                "HID-compliant game controller",
                "gamepad",
                "bluetooth",
                "umdf2",
                "xinputhid",
                "separate",
                true,
                17),
        };

    internal static ContractReport Verify(IReadOnlyList<CatalogProfile> profiles)
    {
        var byId = profiles.ToDictionary(profile => profile.Id, StringComparer.Ordinal);
        var results = new List<PersonaVerification>(Expected.Count);

        foreach ((string id, PersonaShape expected) in Expected)
        {
            if (!byId.TryGetValue(id, out CatalogProfile? profile))
            {
                results.Add(new PersonaVerification(
                    id,
                    false,
                    false,
                    expected,
                    null,
                    ["profile.missing"]));
                continue;
            }

            PersonaShape actual = ShapeOf(profile);
            IReadOnlyList<string> mismatches = Compare(expected, actual);
            results.Add(new PersonaVerification(
                id,
                true,
                mismatches.Count == 0,
                expected,
                actual,
                mismatches));
        }

        return new ContractReport(results.All(result => result.Passed), results);
    }

    internal static PersonaShape ShapeOf(CatalogProfile profile) => new(
        profile.Name,
        profile.Vendor,
        profile.VendorId,
        profile.ProductId,
        profile.ProductString,
        profile.Type,
        profile.Connection,
        profile.Backend,
        profile.DriverMode,
        profile.TriggerMode,
        profile.IsDeployable,
        profile.InputReportSize);

    internal static IReadOnlyList<string> Compare(PersonaShape expected, PersonaShape actual)
    {
        var mismatches = new List<string>();
        Compare("name", expected.Name, actual.Name, mismatches);
        Compare("vendor", expected.Vendor, actual.Vendor, mismatches);
        Compare("vendorId", expected.VendorId, actual.VendorId, mismatches);
        Compare("productId", expected.ProductId, actual.ProductId, mismatches);
        Compare("productString", expected.ProductString, actual.ProductString, mismatches);
        Compare("type", expected.Type, actual.Type, mismatches);
        Compare("connection", expected.Connection, actual.Connection, mismatches);
        Compare("backend", expected.Backend, actual.Backend, mismatches);
        Compare("driverMode", expected.DriverMode, actual.DriverMode, mismatches);
        Compare("triggerMode", expected.TriggerMode, actual.TriggerMode, mismatches);
        Compare("isDeployable", expected.IsDeployable, actual.IsDeployable, mismatches);
        Compare("inputReportSize", expected.InputReportSize, actual.InputReportSize, mismatches);
        return mismatches;
    }

    private static void Compare<T>(string name, T expected, T actual, List<string> mismatches)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
            mismatches.Add(name);
    }
}
