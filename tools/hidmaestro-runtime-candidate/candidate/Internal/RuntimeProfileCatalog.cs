using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text.Json;

namespace HIDMaestro.Internal;

internal sealed class RuntimeProfileCatalog
{
    private const string ResourcePrefix = "HIDMaestro.Profiles.";
    private const int ExpectedProfileCount = 228;
    private const int ExpectedDeployableCount = 130;

    private readonly object _gate = new();
    private Dictionary<string, HMProfile>? _profiles;

    internal int LoadDefaultProfiles()
    {
        lock (_gate)
        {
            if (_profiles is not null)
            {
                return _profiles.Count;
            }

            Assembly assembly = typeof(RuntimeProfileCatalog).Assembly;
            string[] names = assembly.GetManifestResourceNames();
            Array.Sort(names, StringComparer.Ordinal);

            var profiles = new Dictionary<string, HMProfile>(StringComparer.Ordinal);
            int selectedCount = 0;
            int deployableCount = 0;
            foreach (string resourceName in names)
            {
                if (!resourceName.StartsWith(ResourcePrefix, StringComparison.Ordinal))
                {
                    continue;
                }

                selectedCount++;
                using Stream stream = assembly.GetManifestResourceStream(resourceName)
                    ?? throw new InvalidDataException($"Embedded profile resource is unreadable: {resourceName}");
                using JsonDocument document = JsonDocument.Parse(stream);
                HMProfile profile = ParseProfile(document.RootElement, resourceName);
                if (!profiles.TryAdd(profile.Id, profile))
                {
                    throw new InvalidDataException($"Duplicate embedded profile id: {profile.Id}");
                }

                if (profile.HasDescriptor)
                {
                    deployableCount++;
                }
            }

            if (selectedCount != ExpectedProfileCount || profiles.Count != ExpectedProfileCount)
            {
                throw new InvalidDataException(
                    $"Expected {ExpectedProfileCount} embedded profiles; found {selectedCount} resources and {profiles.Count} unique ids.");
            }

            if (deployableCount != ExpectedDeployableCount)
            {
                throw new InvalidDataException(
                    $"Expected {ExpectedDeployableCount} deployable embedded profiles; found {deployableCount}.");
            }

            if (!profiles.TryGetValue("dualsense", out HMProfile? dualSense) ||
                dualSense is null ||
                dualSense.VendorId != 0x054C ||
                dualSense.ProductId != 0x0CE6 ||
                !string.Equals(dualSense.Connection, "usb", StringComparison.Ordinal) ||
                dualSense.InputReportSize != 64 ||
                !dualSense.HasDescriptor)
            {
                throw new InvalidDataException("The embedded DualSense conformance profile does not match the frozen identity.");
            }

            _profiles = profiles;
            return profiles.Count;
        }
    }

    internal HMProfile? GetProfile(string id)
    {
        ArgumentNullException.ThrowIfNull(id);
        lock (_gate)
        {
            return _profiles is not null && _profiles.TryGetValue(id, out HMProfile? profile)
                ? profile
                : null;
        }
    }

    private static HMProfile ParseProfile(JsonElement root, string resourceName)
    {
        string id = ReadRequiredString(root, "id", resourceName);
        string name = ReadOptionalString(root, "name") ?? id;
        ushort vendorId = ReadOptionalHexU16(root, "vid");
        ushort productId = ReadOptionalHexU16(root, "pid");
        string connection = ReadOptionalString(root, "connection") ?? "usb";
        int inputReportSize = root.TryGetProperty("inputReportSize", out JsonElement inputSize) &&
            inputSize.ValueKind == JsonValueKind.Number &&
            inputSize.TryGetInt32(out int parsedInputSize)
                ? parsedInputSize
                : 0;
        bool hasDescriptor = root.TryGetProperty("descriptor", out JsonElement descriptor) &&
            descriptor.ValueKind == JsonValueKind.String &&
            !string.IsNullOrWhiteSpace(descriptor.GetString());

        return new HMProfile(
            id,
            name,
            vendorId,
            productId,
            connection,
            inputReportSize,
            hasDescriptor);
    }

    private static string ReadRequiredString(JsonElement root, string propertyName, string resourceName)
    {
        string? value = ReadOptionalString(root, propertyName);
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new InvalidDataException($"Embedded profile {resourceName} has no {propertyName} string.");
        }

        return value!;
    }

    private static string? ReadOptionalString(JsonElement root, string propertyName)
    {
        return root.TryGetProperty(propertyName, out JsonElement property) &&
            property.ValueKind == JsonValueKind.String
                ? property.GetString()
                : null;
    }

    private static ushort ReadOptionalHexU16(JsonElement root, string propertyName)
    {
        string? value = ReadOptionalString(root, propertyName);
        if (value is null || !value.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
        {
            return 0;
        }

        return ushort.TryParse(
            value.AsSpan(2),
            NumberStyles.AllowHexSpecifier,
            CultureInfo.InvariantCulture,
            out ushort parsed)
                ? parsed
                : (ushort)0;
    }
}
