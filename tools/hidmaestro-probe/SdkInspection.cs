using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using System.Text.Json;

namespace Ksx.HidMaestroProbe;

internal sealed record StaticSdkImage(
    ApiReport Api,
    CatalogReport Catalog);

internal static class SdkInspection
{
    private const string FileVersionAttribute = "System.Reflection.AssemblyFileVersionAttribute";
    private const string InformationalVersionAttribute =
        "System.Reflection.AssemblyInformationalVersionAttribute";

    // Transcribed from HMContext.cs and HMProfile.cs at sdk.lock.json's exact
    // commit. Both types are top-level public sealed classes; every listed
    // property is getter-only. These are CLR signatures, not source-name-only
    // reflection checks.
    private static readonly IReadOnlyList<ApiExpectation> ExpectedApi =
    [
        ApiExpectation.Type("HIDMaestro.HMContext"),
        ApiExpectation.Type("HIDMaestro.HMProfile"),
        ApiExpectation.Property(
            "HIDMaestro.HMContext",
            "AllProfiles",
            "class System.Collections.Generic.IReadOnlyList`1<class HIDMaestro.HMProfile>"),
        ApiExpectation.Method(
            "HIDMaestro.HMContext",
            "LoadDefaultProfiles",
            "System.Int32"),
        ApiExpectation.Method(
            "HIDMaestro.HMContext",
            "GetProfile",
            "class HIDMaestro.HMProfile",
            "System.String"),
        ApiExpectation.Property("HIDMaestro.HMProfile", "Id", "System.String"),
        ApiExpectation.Property("HIDMaestro.HMProfile", "Name", "System.String"),
        ApiExpectation.Property("HIDMaestro.HMProfile", "Vendor", "System.String"),
        ApiExpectation.Property("HIDMaestro.HMProfile", "VendorId", "System.UInt16"),
        ApiExpectation.Property("HIDMaestro.HMProfile", "ProductId", "System.UInt16"),
        ApiExpectation.Property("HIDMaestro.HMProfile", "ProductString", "System.String"),
        ApiExpectation.Property("HIDMaestro.HMProfile", "ManufacturerString", "System.String"),
        ApiExpectation.Property("HIDMaestro.HMProfile", "Type", "System.String"),
        ApiExpectation.Property("HIDMaestro.HMProfile", "Connection", "System.String"),
        ApiExpectation.Property("HIDMaestro.HMProfile", "DriverMode", "System.String"),
        ApiExpectation.Property("HIDMaestro.HMProfile", "TriggerMode", "System.String"),
        ApiExpectation.Property("HIDMaestro.HMProfile", "Backend", "System.String"),
        ApiExpectation.Property("HIDMaestro.HMProfile", "IsDeployable", "System.Boolean"),
        ApiExpectation.Property("HIDMaestro.HMProfile", "InputReportSize", "System.Int32"),
        ApiExpectation.Property("HIDMaestro.HMProfile", "ButtonCount", "System.Int32"),
        ApiExpectation.Property("HIDMaestro.HMProfile", "AxisCount", "System.Int32"),
        ApiExpectation.Property("HIDMaestro.HMProfile", "HasHat", "System.Boolean"),
    ];

    internal static SdkLock LoadLock()
    {
        using Stream stream = typeof(SdkInspection).Assembly
            .GetManifestResourceStream("Ksx.HidMaestroProbe.sdk.lock.json")
            ?? throw new InvalidOperationException("The embedded SDK lock is missing.");

        return JsonSerializer.Deserialize<SdkLock>(stream, JsonOptions.Input)
            ?? throw new InvalidOperationException("The embedded SDK lock is invalid.");
    }

    internal static (PinReport Report, StaticSdkImage? Image) InspectPinnedFile(SdkLock sdkLock)
    {
        string path = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, sdkLock.CoreDll.FileName));
        var mismatches = new List<string>();

        if (!File.Exists(path))
        {
            mismatches.Add("coreDll.fileMissing");
            return (PinFailure(path, sdkLock, null, null, null, mismatches), null);
        }

        // One non-write/non-delete-shared handle binds hashing and all parsing
        // to the same file object. No target byte reaches the CLR loader.
        using var file = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            bufferSize: 64 * 1024,
            FileOptions.SequentialScan);
        string actualSha256 = Convert.ToHexString(SHA256.HashData(file));
        if (!actualSha256.Equals(sdkLock.CoreDll.Sha256, StringComparison.OrdinalIgnoreCase))
        {
            mismatches.Add("coreDll.sha256");
            return (PinFailure(path, sdkLock, actualSha256, null, null, mismatches), null);
        }

        file.Position = 0;
        using var pe = new PEReader(file, PEStreamOptions.LeaveOpen);
        if (!pe.HasMetadata || pe.PEHeaders.CorHeader is null)
            throw new BadImageFormatException("The hash-pinned SDK is not a managed PE.");
        MetadataReader metadata = pe.GetMetadataReader();
        if (!metadata.IsAssembly)
            throw new BadImageFormatException("The hash-pinned SDK has no assembly definition.");

        string assemblyVersion = metadata.GetAssemblyDefinition().Version.ToString();
        string? fileVersion = ReadAssemblyStringAttribute(metadata, FileVersionAttribute);
        string? informationalVersion = ReadAssemblyStringAttribute(
            metadata,
            InformationalVersionAttribute);
        if (!assemblyVersion.Equals(sdkLock.CoreDll.FileVersion, StringComparison.Ordinal))
            mismatches.Add("coreDll.assemblyVersion");
        if (!string.Equals(fileVersion, sdkLock.CoreDll.FileVersion, StringComparison.Ordinal))
            mismatches.Add("coreDll.fileVersion");
        if (!string.Equals(
                informationalVersion,
                sdkLock.CoreDll.InformationalVersion,
                StringComparison.Ordinal))
            mismatches.Add("coreDll.informationalVersion");

        var report = new PinReport(
            mismatches.Count == 0,
            path,
            sdkLock.CoreDll.Sha256,
            actualSha256,
            sdkLock.CoreDll.FileVersion,
            fileVersion,
            sdkLock.CoreDll.InformationalVersion,
            informationalVersion,
            mismatches);
        if (!report.Ok)
            return (report, null);

        IReadOnlyDictionary<string, byte[]> resources =
            ManagedPeReader.ReadEmbeddedResources(
                pe,
                metadata,
                CatalogInspection.IsProfileResource);
        return (
            report,
            new StaticSdkImage(
                InspectApi(metadata),
                CatalogInspection.ReadEmbeddedCatalog(resources)));
    }

    internal static ApiReport InspectApi(MetadataReader metadata)
    {
        HashSet<string> requiredNames = ExpectedApi
            .Select(expectation => expectation.TypeName)
            .ToHashSet(StringComparer.Ordinal);
        var types = requiredNames.ToDictionary(
            name => name,
            _ => new List<TypeDefinition>(),
            StringComparer.Ordinal);
        foreach (TypeDefinitionHandle handle in metadata.TypeDefinitions)
        {
            TypeDefinition type = metadata.GetTypeDefinition(handle);
            if (!type.GetDeclaringType().IsNil)
                continue;
            string name = ManagedPeReader.QualifiedName(metadata, type);
            if (types.TryGetValue(name, out List<TypeDefinition>? matches))
                matches.Add(type);
        }
        ApiCheck[] checks = ExpectedApi
            .Select(expectation => expectation.Check(metadata, types))
            .ToArray();
        return new ApiReport(checks.All(check => check.Present), checks);
    }

    private static PinReport PinFailure(
        string path,
        SdkLock sdkLock,
        string? actualSha256,
        string? fileVersion,
        string? informationalVersion,
        IReadOnlyList<string> mismatches) =>
        new(
            false,
            path,
            sdkLock.CoreDll.Sha256,
            actualSha256,
            sdkLock.CoreDll.FileVersion,
            fileVersion,
            sdkLock.CoreDll.InformationalVersion,
            informationalVersion,
            mismatches);

    private static string? ReadAssemblyStringAttribute(
        MetadataReader metadata,
        string expectedAttributeType)
    {
        var values = new List<string>();
        foreach (CustomAttributeHandle handle in metadata.GetAssemblyDefinition().GetCustomAttributes())
        {
            CustomAttribute attribute = metadata.GetCustomAttribute(handle);
            if (!IsFrameworkAttribute(metadata, attribute, expectedAttributeType))
                continue;
            EnsureSingleStringAttributeConstructor(metadata, attribute, expectedAttributeType);
            values.Add(ManagedPeReader.ParseSingleStringCustomAttribute(
                metadata.GetBlobBytes(attribute.Value),
                expectedAttributeType));
        }
        return values.Count switch
        {
            0 => null,
            1 => values[0],
            _ => throw new BadImageFormatException(
                $"The assembly has duplicate {expectedAttributeType} attributes."),
        };
    }

    private static bool IsFrameworkAttribute(
        MetadataReader metadata,
        CustomAttribute attribute,
        string expectedAttributeType)
    {
        if (attribute.Constructor.Kind != HandleKind.MemberReference)
            return false;
        MemberReference constructor = metadata.GetMemberReference(
            (MemberReferenceHandle)attribute.Constructor);
        if (constructor.Parent.Kind != HandleKind.TypeReference)
            return false;
        TypeReference type = metadata.GetTypeReference((TypeReferenceHandle)constructor.Parent);
        if (!ManagedPeReader.QualifiedName(metadata, type).Equals(
                expectedAttributeType,
                StringComparison.Ordinal)
            || type.ResolutionScope.Kind != HandleKind.AssemblyReference)
            return false;

        AssemblyReference scope = metadata.GetAssemblyReference(
            (AssemblyReferenceHandle)type.ResolutionScope);
        return metadata.GetString(scope.Name) == "System.Runtime"
            && metadata.GetBlobBytes(scope.PublicKeyOrToken).SequenceEqual(
                new byte[] { 0xB0, 0x3F, 0x5F, 0x7F, 0x11, 0xD5, 0x0A, 0x3A });
    }

    private static void EnsureSingleStringAttributeConstructor(
        MetadataReader metadata,
        CustomAttribute attribute,
        string attributeType)
    {
        if (attribute.Constructor.Kind != HandleKind.MemberReference)
            throw new BadImageFormatException($"{attributeType} has an invalid constructor handle.");
        MemberReference reference = metadata.GetMemberReference(
            (MemberReferenceHandle)attribute.Constructor);
        string name = metadata.GetString(reference.Name);
        MethodSignature<string> signature = reference.DecodeMethodSignature(
            MetadataTypeNameProvider.Instance,
            genericContext: null);

        if (name != ".ctor"
            || !signature.Header.IsInstance
            || signature.Header.Kind != SignatureKind.Method
            || signature.Header.CallingConvention != SignatureCallingConvention.Default
            || signature.GenericParameterCount != 0
            || signature.RequiredParameterCount != 1
            || signature.ReturnType != "System.Void"
            || signature.ParameterTypes.Length != 1
            || signature.ParameterTypes[0] != "System.String")
        {
            throw new BadImageFormatException(
                $"{attributeType} does not use the expected .ctor(string) signature.");
        }
    }

    private enum ApiExpectationKind
    {
        Type,
        Property,
        Method,
    }

    private sealed record ApiExpectation(
        ApiExpectationKind Kind,
        string TypeName,
        string? MemberName,
        string? ReturnType,
        IReadOnlyList<string> ParameterTypes,
        string Shape)
    {
        internal static ApiExpectation Type(string typeName) =>
            new(ApiExpectationKind.Type, typeName, null, null, [], "public sealed type");

        internal static ApiExpectation Property(
            string typeName,
            string memberName,
            string returnType) =>
            new(
                ApiExpectationKind.Property,
                typeName,
                memberName,
                returnType,
                [],
                $"public instance {returnType} {{ get; }}");

        internal static ApiExpectation Method(
            string typeName,
            string memberName,
            string returnType,
            params string[] parameterTypes) =>
            new(
                ApiExpectationKind.Method,
                typeName,
                memberName,
                returnType,
                parameterTypes,
                $"public instance {returnType} {memberName}({string.Join(", ", parameterTypes)})");

        internal ApiCheck Check(
            MetadataReader metadata,
            IReadOnlyDictionary<string, List<TypeDefinition>> types)
        {
            string member = MemberName is null ? TypeName : $"{TypeName}.{MemberName}";
            if (!types.TryGetValue(TypeName, out List<TypeDefinition>? matches)
                || matches.Count != 1)
                return new ApiCheck(member, false, Shape);
            TypeDefinition type = matches[0];

            bool present = Kind switch
            {
                ApiExpectationKind.Type => IsExactPublicType(type),
                ApiExpectationKind.Property => HasExactProperty(metadata, type),
                ApiExpectationKind.Method => HasExactMethod(metadata, type),
                _ => false,
            };
            return new ApiCheck(member, present, Shape);
        }

        private static bool IsExactPublicType(TypeDefinition type) =>
            (type.Attributes & TypeAttributes.VisibilityMask) == TypeAttributes.Public
            && (type.Attributes & TypeAttributes.ClassSemanticsMask) == TypeAttributes.Class
            && (type.Attributes & TypeAttributes.Sealed) != 0
            && (type.Attributes & TypeAttributes.Abstract) == 0;

        private bool HasExactProperty(MetadataReader metadata, TypeDefinition type)
        {
            PropertyDefinition[] candidates = type.GetProperties()
                .Select(metadata.GetPropertyDefinition)
                .Where(property => metadata.GetString(property.Name) == MemberName)
                .ToArray();
            if (candidates.Length != 1)
                return false;

            PropertyDefinition property = candidates[0];
            PropertyAccessors accessors = property.GetAccessors();
            if (accessors.Getter.IsNil
                || !accessors.Setter.IsNil
                || accessors.Others.Length != 0)
                return false;
            MethodDefinition getter = metadata.GetMethodDefinition(accessors.Getter);
            MethodSignature<string> getterSignature = getter.DecodeSignature(
                MetadataTypeNameProvider.Instance,
                genericContext: null);
            MethodSignature<string> propertySignature = property.DecodeSignature(
                MetadataTypeNameProvider.Instance,
                genericContext: null);
            return IsPublicInstance(getter)
                && (getter.Attributes & MethodAttributes.SpecialName) != 0
                && metadata.GetString(getter.Name) == $"get_{MemberName}"
                && getter.GetGenericParameters().Count == 0
                && getterSignature.Header.IsInstance
                && getterSignature.Header.Kind == SignatureKind.Method
                && getterSignature.Header.CallingConvention == SignatureCallingConvention.Default
                && getterSignature.GenericParameterCount == 0
                && getterSignature.ReturnType == ReturnType
                && getterSignature.ParameterTypes.Length == 0
                && getterSignature.RequiredParameterCount == 0
                && propertySignature.Header.IsInstance
                && propertySignature.Header.Kind == SignatureKind.Property
                && propertySignature.GenericParameterCount == 0
                && propertySignature.ReturnType == ReturnType
                && propertySignature.ParameterTypes.Length == 0
                && propertySignature.RequiredParameterCount == 0;
        }

        private bool HasExactMethod(MetadataReader metadata, TypeDefinition type)
        {
            int exactMatches = 0;
            foreach (MethodDefinitionHandle handle in type.GetMethods())
            {
                MethodDefinition method = metadata.GetMethodDefinition(handle);
                if (metadata.GetString(method.Name) != MemberName || !IsPublicInstance(method))
                    continue;
                MethodSignature<string> signature = method.DecodeSignature(
                    MetadataTypeNameProvider.Instance,
                    genericContext: null);
                if (method.GetGenericParameters().Count == 0
                    && signature.Header.IsInstance
                    && signature.Header.Kind == SignatureKind.Method
                    && signature.Header.CallingConvention == SignatureCallingConvention.Default
                    && signature.GenericParameterCount == 0
                    && signature.RequiredParameterCount == ParameterTypes.Count
                    && signature.ReturnType == ReturnType
                    && signature.ParameterTypes.SequenceEqual(ParameterTypes, StringComparer.Ordinal))
                    exactMatches++;
            }
            return exactMatches == 1;
        }

        private static bool IsPublicInstance(MethodDefinition method) =>
            (method.Attributes & MethodAttributes.MemberAccessMask) == MethodAttributes.Public
            && (method.Attributes & MethodAttributes.Static) == 0;
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
