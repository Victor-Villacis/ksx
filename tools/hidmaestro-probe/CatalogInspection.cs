using System.Security.Cryptography;
using System.Text.Json;

namespace Ksx.HidMaestroProbe;

internal static class CatalogInspection
{
    private const string ProfilePrefix = "HIDMaestro.Profiles.";
    internal const int ExpectedResourceCount = 228;
    internal const int ExpectedDeployableCount = 130;
    internal const string ExpectedCatalogSha256 =
        "8F407E6E1C3C241E16CF6BEF387216AD4D1F5DE055A2C4CC041CA16CE7954A6A";

    internal static bool IsProfileResource(string name) =>
        name.StartsWith(ProfilePrefix, StringComparison.Ordinal)
        && name.EndsWith(".json", StringComparison.OrdinalIgnoreCase);

    internal static CatalogReport ReadEmbeddedCatalog(
        IReadOnlyDictionary<string, byte[]> embeddedResources)
    {
        string[] resources = embeddedResources.Keys
            .Where(IsProfileResource)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();

        var profiles = new List<CatalogProfile>(resources.Length);
        foreach (string resourceName in resources)
        {
            byte[] json = embeddedResources[resourceName];
            profiles.Add(ParseProfile(json, resourceName));
        }

        profiles.Sort((left, right) => string.Compare(left.Id, right.Id, StringComparison.Ordinal));
        string[] duplicateIds = profiles
            .GroupBy(profile => profile.Id, StringComparer.OrdinalIgnoreCase)
            .Where(group => group.Count() > 1)
            .Select(group => group.Key)
            .ToArray();
        if (duplicateIds.Length != 0)
            throw new InvalidDataException($"Duplicate embedded profile IDs: {string.Join(", ", duplicateIds)}");

        return new CatalogReport(
            profiles.Count,
            profiles.Count(profile => profile.IsDeployable),
            ManagedPeReader.HashCatalog(embeddedResources, resources),
            profiles);
    }

    internal static bool MatchesPinnedContract(CatalogReport report) =>
        report.ResourceCount == ExpectedResourceCount
        && report.DeployableCount == ExpectedDeployableCount
        && report.CatalogSha256.Equals(ExpectedCatalogSha256, StringComparison.OrdinalIgnoreCase);

    internal static CatalogProfile ParseProfile(byte[] json, string resourceName)
    {
        ReadOnlyMemory<byte> payload = json;
        if (json.Length >= 3 && json[0] == 0xEF && json[1] == 0xBB && json[2] == 0xBF)
            payload = json.AsMemory(3);

        using JsonDocument document = JsonDocument.Parse(payload);
        JsonElement root = document.RootElement;
        string? descriptor = OptionalString(root, "descriptor");
        byte[]? descriptorBytes = null;
        if (descriptor is not null)
        {
            string compactDescriptor = string.Concat(descriptor.Where(character => !char.IsWhiteSpace(character)));
            try
            {
                descriptorBytes = Convert.FromHexString(compactDescriptor);
            }
            catch (FormatException exception)
            {
                throw new InvalidDataException(
                    $"Embedded profile '{resourceName}' has a malformed descriptor.",
                    exception);
            }
        }

        return new CatalogProfile(
            RequiredString(root, "id"),
            RequiredString(root, "name"),
            RequiredString(root, "vendor"),
            HexId(root, "vid"),
            HexId(root, "pid"),
            RequiredString(root, "productString"),
            OptionalString(root, "manufacturerString") ?? OptionalString(root, "vendor") ?? string.Empty,
            RequiredString(root, "type"),
            OptionalString(root, "connection") ?? "usb",
            OptionalString(root, "backend") ?? "umdf2",
            OptionalString(root, "driverMode"),
            OptionalString(root, "triggerMode"),
            descriptorBytes is { Length: > 0 },
            OptionalInt32(root, "inputReportSize") ?? 0,
            descriptorBytes?.Length ?? 0,
            descriptorBytes is null ? null : Convert.ToHexString(SHA256.HashData(descriptorBytes)),
            Convert.ToHexString(SHA256.HashData(json)));
    }

    private static string RequiredString(JsonElement root, string name) =>
        OptionalString(root, name)
        ?? throw new InvalidDataException($"Embedded profile is missing required string '{name}'.");

    private static string? OptionalString(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out JsonElement value) || value.ValueKind == JsonValueKind.Null)
            return null;
        if (value.ValueKind != JsonValueKind.String)
            throw new InvalidDataException($"Embedded profile property '{name}' is not a string.");
        return value.GetString();
    }

    private static int? OptionalInt32(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out JsonElement value) || value.ValueKind == JsonValueKind.Null)
            return null;
        if (!value.TryGetInt32(out int result))
            throw new InvalidDataException($"Embedded profile property '{name}' is not an Int32.");
        return result;
    }

    private static string HexId(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out JsonElement value))
            throw new InvalidDataException($"Embedded profile is missing '{name}'.");

        ushort number = value.ValueKind switch
        {
            JsonValueKind.String => ParseHex(value.GetString(), name),
            JsonValueKind.Number when value.TryGetUInt16(out ushort parsed) => parsed,
            _ => throw new InvalidDataException($"Embedded profile property '{name}' is not a 16-bit ID."),
        };
        return $"0x{number:X4}";
    }

    private static ushort ParseHex(string? text, string name)
    {
        if (text is null)
            throw new InvalidDataException($"Embedded profile property '{name}' is null.");
        string digits = text.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? text[2..] : text;
        if (!ushort.TryParse(digits, System.Globalization.NumberStyles.HexNumber, null, out ushort value))
            throw new InvalidDataException($"Embedded profile property '{name}' is not hexadecimal.");
        return value;
    }
}
