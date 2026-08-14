using System.Diagnostics;
using System.Reflection;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text.Json;

namespace Ksx.HidMaestroProbe;

internal static class SdkInspection
{
    internal static SdkLock LoadLock()
    {
        using Stream stream = Assembly.GetExecutingAssembly()
            .GetManifestResourceStream("Ksx.HidMaestroProbe.sdk.lock.json")
            ?? throw new InvalidOperationException("The embedded SDK lock is missing.");

        return JsonSerializer.Deserialize<SdkLock>(stream, JsonOptions.Input)
            ?? throw new InvalidOperationException("The embedded SDK lock is invalid.");
    }

    internal static (PinReport Report, Assembly? Assembly) LoadPinnedAssembly(SdkLock sdkLock)
    {
        string path = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, sdkLock.CoreDll.FileName));
        var mismatches = new List<string>();

        if (!File.Exists(path))
        {
            mismatches.Add("coreDll.fileMissing");
            return (
                new PinReport(
                    false,
                    path,
                    sdkLock.CoreDll.Sha256,
                    null,
                    sdkLock.CoreDll.FileVersion,
                    null,
                    sdkLock.CoreDll.InformationalVersion,
                    null,
                    mismatches),
                null);
        }

        string actualSha256;
        using (FileStream file = File.OpenRead(path))
            actualSha256 = Convert.ToHexString(SHA256.HashData(file));

        if (!string.Equals(actualSha256, sdkLock.CoreDll.Sha256, StringComparison.OrdinalIgnoreCase))
            mismatches.Add("coreDll.sha256");

        // Never load an unpinned assembly merely to learn more about it.
        if (mismatches.Count != 0)
        {
            return (
                new PinReport(
                    false,
                    path,
                    sdkLock.CoreDll.Sha256,
                    actualSha256,
                    sdkLock.CoreDll.FileVersion,
                    null,
                    sdkLock.CoreDll.InformationalVersion,
                    null,
                    mismatches),
                null);
        }

        Assembly assembly = AssemblyLoadContext.Default.LoadFromAssemblyPath(path);
        string? fileVersion = FileVersionInfo.GetVersionInfo(path).FileVersion;
        string? informationalVersion = assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
            .InformationalVersion;

        if (!string.Equals(fileVersion, sdkLock.CoreDll.FileVersion, StringComparison.Ordinal))
            mismatches.Add("coreDll.fileVersion");
        if (!string.Equals(
                informationalVersion,
                sdkLock.CoreDll.InformationalVersion,
                StringComparison.Ordinal))
            mismatches.Add("coreDll.informationalVersion");

        return (
            new PinReport(
                mismatches.Count == 0,
                path,
                sdkLock.CoreDll.Sha256,
                actualSha256,
                sdkLock.CoreDll.FileVersion,
                fileVersion,
                sdkLock.CoreDll.InformationalVersion,
                informationalVersion,
                mismatches),
            assembly);
    }

    internal static ApiReport InspectReadOnlyApi(Assembly assembly)
    {
        Type? context = assembly.GetType("HIDMaestro.HMContext", throwOnError: false);
        Type? profile = assembly.GetType("HIDMaestro.HMProfile", throwOnError: false);
        var checks = new List<ApiCheck>
        {
            TypeCheck(context, "HIDMaestro.HMContext"),
            TypeCheck(profile, "HIDMaestro.HMProfile"),
            PropertyCheck(context, "AllProfiles", "public instance property"),
            MethodCheck(context, "LoadDefaultProfiles", Type.EmptyTypes, typeof(int), "public int LoadDefaultProfiles()"),
            MethodCheck(context, "GetProfile", [typeof(string)], profile, "public HMProfile? GetProfile(string)"),
        };

        foreach (string property in new[]
                 {
                     "Id", "Name", "Vendor", "VendorId", "ProductId",
                     "ProductString", "ManufacturerString", "Type", "Connection",
                     "DriverMode", "TriggerMode", "Backend", "IsDeployable",
                     "InputReportSize", "ButtonCount", "AxisCount", "HasHat",
                 })
        {
            checks.Add(PropertyCheck(profile, property, "public instance property"));
        }

        return new ApiReport(checks.All(check => check.Present), checks);
    }

    private static ApiCheck TypeCheck(Type? type, string name) =>
        new(name, type is { IsPublic: true }, "public type");

    private static ApiCheck PropertyCheck(Type? type, string name, string shape) =>
        new($"{type?.FullName ?? "<missing>"}.{name}",
            type?.GetProperty(name, BindingFlags.Public | BindingFlags.Instance) is not null,
            shape);

    private static ApiCheck MethodCheck(
        Type? type,
        string name,
        Type[] parameterTypes,
        Type? returnType,
        string shape)
    {
        MethodInfo? method = type?.GetMethod(
            name,
            BindingFlags.Public | BindingFlags.Instance,
            binder: null,
            types: parameterTypes,
            modifiers: null);
        bool present = method is not null && method.ReturnType == returnType;
        return new ApiCheck($"{type?.FullName ?? "<missing>"}.{name}", present, shape);
    }
}

internal static class JsonOptions
{
    internal static readonly JsonSerializerOptions Input = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    internal static readonly JsonSerializerOptions Output = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
    };
}
