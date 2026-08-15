global using System;
global using System.Collections.Generic;
global using System.IO;
global using System.Linq;

using System.Buffers.Binary;
using System.Collections.Immutable;
using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Ksx.HidMaestroProbe;

internal static class Program
{
    private const string ProfilePrefix = "HIDMaestro.Profiles.";
    private const string FileVersionAttribute = "System.Reflection.AssemblyFileVersionAttribute";
    private const string InformationalVersionAttribute =
        "System.Reflection.AssemblyInformationalVersionAttribute";
    private const string TargetFrameworkAttribute =
        "System.Runtime.Versioning.TargetFrameworkAttribute";
    private const string ModuleInitializerAttribute =
        "System.Runtime.CompilerServices.ModuleInitializerAttribute";

    private static readonly UTF8Encoding StrictUtf8 =
        new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);
    private static readonly IReadOnlyDictionary<ushort, OpCode> OpCodeMap = BuildOpCodeMap();

    private static int Main(string[] args)
    {
        string? outputPath = TryFindOutputPath(args);
        try
        {
            Arguments options = Arguments.Parse(args);
            ArtifactObservation observation = Inspect(options);
            WriteJson(options.OutputPath, observation);
            return observation.Ok ? 0 : 2;
        }
        catch (Exception exception)
        {
            if (outputPath is not null)
            {
                WriteJson(
                    outputPath,
                    new
                    {
                        schemaVersion = 1,
                        ok = false,
                        phase = "static-byte-inspection",
                        errorType = exception.GetType().FullName,
                        error = "inspection failed; see the ephemeral Actions diagnostic stream",
                        candidateBuilt = true,
                        candidateLoaded = false,
                        candidateExecuted = false,
                        driverTouched = false,
                        deviceTouched = false,
                    });
            }

            Console.Error.WriteLine($"artifact inspection failed: {exception.GetType().Name}: {exception.Message}");
            return 1;
        }
    }

    private static ArtifactObservation Inspect(Arguments options)
    {
        using HashedJsonInput contractInput = HashedJsonInput.Open(options.ContractPath);
        using HashedJsonInput apiInput = HashedJsonInput.Open(options.ApiContractPath);
        using HashedJsonInput profileInput = HashedJsonInput.Open(options.ProfileCatalogPath);
        using HashedJsonInput evaluationInput = HashedJsonInput.Open(options.EvaluationPath);
        using HashedJsonInput assetsInput = HashedJsonInput.Open(options.AssetsPath);
        using HashedJsonInput depsInput = HashedJsonInput.Open(options.DepsPath);

        JsonElement contract = contractInput.Document.RootElement;
        JsonElement artifactExpectation = contract.GetProperty("artifactExpectation");
        JsonElement rejectPolicy = contract.GetProperty("staticRejectPolicy");
        var checks = new List<ObservationCheck>();

        using var artifact = new FileStream(
            options.ArtifactPath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            bufferSize: 64 * 1024,
            FileOptions.SequentialScan);
        string dllSha256 = HashOpenStream(artifact);
        long dllLength = artifact.Length;
        artifact.Position = 0;

        using var pe = new PEReader(artifact, PEStreamOptions.LeaveOpen);
        Require(checks, "pe.hasMetadata", pe.HasMetadata, true);
        if (!pe.HasMetadata)
            throw new BadImageFormatException("The candidate is not a managed PE image.");
        PEHeader peHeader = pe.PEHeaders.PEHeader
            ?? throw new BadImageFormatException("The candidate PE header is absent.");
        CorHeader corHeader = pe.PEHeaders.CorHeader
            ?? throw new BadImageFormatException("The candidate COR header is absent.");

        MetadataReader metadata = pe.GetMetadataReader();
        Require(checks, "metadata.isAssembly", metadata.IsAssembly, true);
        if (!metadata.IsAssembly)
            throw new BadImageFormatException("The candidate has no assembly definition.");

        AssemblyDefinition assembly = metadata.GetAssemblyDefinition();
        string assemblyName = metadata.GetString(assembly.Name);
        string assemblyVersion = assembly.Version.ToString();
        string? fileVersion = ReadAssemblyStringAttribute(metadata, FileVersionAttribute);
        string? informationalVersion =
            ReadAssemblyStringAttribute(metadata, InformationalVersionAttribute);
        string? targetFramework = ReadAssemblyStringAttribute(metadata, TargetFrameworkAttribute);

        Require(
            checks,
            "assembly.name",
            assemblyName,
            artifactExpectation.GetProperty("assemblyName").GetString());
        Require(
            checks,
            "assembly.version",
            assemblyVersion,
            artifactExpectation.GetProperty("assemblyVersion").GetString());
        Require(
            checks,
            "assembly.fileVersion",
            fileVersion,
            artifactExpectation.GetProperty("fileVersion").GetString());
        Require(
            checks,
            "assembly.informationalVersion",
            informationalVersion,
            artifactExpectation.GetProperty("informationalVersion").GetString());
        Require(
            checks,
            "assembly.targetFramework",
            targetFramework,
            artifactExpectation.GetProperty("targetFramework").GetString());
        Require(checks, "pe.machine", pe.PEHeaders.CoffHeader.Machine.ToString(), "Amd64");
        Require(checks, "pe.magic", peHeader.Magic.ToString(), "PE32Plus");
        Require(checks, "clr.ilOnly", (corHeader.Flags & CorFlags.ILOnly) != 0, true);
        Require(
            checks,
            "clr.nativeEntryPointFlag",
            (corHeader.Flags & CorFlags.NativeEntryPoint) != 0,
            false);
        Require(
            checks,
            "clr.managedEntryPointTokenOrRva",
            corHeader.EntryPointTokenOrRelativeVirtualAddress,
            0);
        Require(
            checks,
            "clr.strongNameSigned",
            (corHeader.Flags & CorFlags.StrongNameSigned) != 0,
            false);
        Require(
            checks,
            "clr.strongNameDirectoryEmpty",
            IsEmpty(corHeader.StrongNameSignatureDirectory),
            true);
        Require(
            checks,
            "clr.managedNativeHeaderEmpty",
            IsEmpty(corHeader.ManagedNativeHeaderDirectory),
            true);
        Require(checks, "clr.codeManagerTableEmpty", IsEmpty(corHeader.CodeManagerTableDirectory), true);
        Require(checks, "clr.vtableFixupsEmpty", IsEmpty(corHeader.VtableFixupsDirectory), true);
        Require(
            checks,
            "clr.exportAddressTableJumpsEmpty",
            IsEmpty(corHeader.ExportAddressTableJumpsDirectory),
            true);
        Require(
            checks,
            "pe.authenticodeDirectoryEmpty",
            IsEmpty(peHeader.CertificateTableDirectory),
            true);
        Require(
            checks,
            "pe.tlsDirectoryEmpty",
            IsEmpty(peHeader.ThreadLocalStorageTableDirectory),
            true);
        Require(checks, "pe.delayImportDirectoryEmpty", IsEmpty(peHeader.DelayImportTableDirectory), true);
        Require(checks, "pe.exportDirectoryEmpty", IsEmpty(peHeader.ExportTableDirectory), true);
        Require(
            checks,
            "pe.nativeBootstrapAddressPresent",
            peHeader.AddressOfEntryPoint != 0,
            artifactExpectation.GetProperty("nativeAddressOfEntryPointExpectedNonzero").GetBoolean());

        NativeImportInventory nativeImports = ReadNativeImports(pe);
        string[] canonicalImports = nativeImports.Imports
            .SelectMany(import => import.Symbols.Select(symbol => $"{import.Module}!{symbol}"))
            .OrderBy(value => value, StringComparer.OrdinalIgnoreCase)
            .ToArray();
        Require(checks, "nativeImport.count", canonicalImports.Length, 1);
        Require(
            checks,
            "nativeImport.bootstrap",
            canonicalImports.SingleOrDefault(),
            $"{artifactExpectation.GetProperty("allowedNativeBootstrapModule").GetString()}!{artifactExpectation.GetProperty("allowedNativeBootstrapSymbol").GetString()}",
            StringComparer.OrdinalIgnoreCase);

        IReadOnlyDictionary<string, byte[]> resources =
            ManagedPeReader.ReadEmbeddedResources(pe, metadata, _ => true);
        ResourceInventory resourceInventory = InspectResources(
            resources,
            profileInput.Document.RootElement,
            evaluationInput.Document.RootElement,
            checks);

        PublicApiInventory publicApi = InspectPublicApi(
            metadata,
            apiInput.Document.RootElement,
            checks);
        MetadataInventory metadataInventory = InspectMetadata(metadata, pe, rejectPolicy, checks);
        PortablePdbInventory portablePdb = InspectPortablePdb(pe, options.PdbPath, checks);
        BuildInputInventory buildInputs = InspectBuildInputs(
            evaluationInput.Document.RootElement,
            assetsInput.Document.RootElement,
            depsInput.Document.RootElement,
            contract,
            checks);

        Dictionary<string, int> tableCounts = Enum.GetValues<TableIndex>()
            .ToDictionary(index => index.ToString(), metadata.GetTableRowCount, StringComparer.Ordinal);

        var observation = new ArtifactObservation(
            SchemaVersion: 1,
            Ok: checks.All(check => check.Ok),
            Phase: "s1.5e-actions-static-artifact-observation",
            CandidateBuilt: true,
            CandidateLoaded: false,
            CandidateExecuted: false,
            DriverTouched: false,
            DeviceTouched: false,
            NetworkUsedByCandidate: false,
            NativeBootstrapAddressOfEntryPoint: peHeader.AddressOfEntryPoint,
            NativeBootstrap: nativeImports,
            Artifact: new ArtifactIdentity(
                "candidate-dll",
                dllLength,
                dllSha256,
                assemblyName,
                assemblyVersion,
                fileVersion,
                informationalVersion,
                targetFramework,
                metadata.GetGuid(metadata.GetModuleDefinition().Mvid).ToString("D"),
                pe.PEHeaders.CoffHeader.Machine.ToString(),
                peHeader.Magic.ToString(),
                corHeader.Flags.ToString(),
                corHeader.EntryPointTokenOrRelativeVirtualAddress),
            PdbSha256: portablePdb.Sha256,
            DepsJsonSha256: depsInput.Sha256,
            AssetsJsonSha256: assetsInput.Sha256,
            EvaluationJsonSha256: evaluationInput.Sha256,
            PublicApi: publicApi,
            Resources: resourceInventory,
            Metadata: metadataInventory with { TableCounts = tableCounts },
            PortablePdb: portablePdb,
            BuildInputs: buildInputs,
            Checks: checks,
            UnresolvedObservationExpectations:
            [
                "dllSha256",
                "pdbSha256",
                "depsJsonSha256",
                "mvid",
                "portablePdbId",
                "profileRawCatalogSha256",
                "publicApiStructuralContract",
                "assemblyReferenceAllowlist",
                "typeReferenceAllowlist",
                "memberReferenceAllowlist",
                "methodSpecificationAllowlist",
                "ilTokenClosureAllowlist",
                "analyzerAllowlist",
                "referencePackInventory",
                "assetsInventory",
                "evaluatedCompilerInputInventory",
            ],
            GateState: new GateState(false, false, false, false, false, false));

        return observation;
    }

    private static ResourceInventory InspectResources(
        IReadOnlyDictionary<string, byte[]> resources,
        JsonElement profileCatalog,
        JsonElement evaluation,
        List<ObservationCheck> checks)
    {
        var expected = profileCatalog.GetProperty("entries")
            .EnumerateArray()
            .Where(entry => entry.GetProperty("classification").GetString() == "embedded-profile-source")
            .ToDictionary(
                entry => ProfilePrefix + entry.GetProperty("path").GetString()!["profiles/".Length..],
                entry => new ExpectedResource(
                    entry.GetProperty("canonicalByteLength").GetInt32(),
                    entry.GetProperty("canonicalSha256").GetString()!,
                    entry.GetProperty("deployable").GetBoolean()),
                StringComparer.Ordinal);
        IReadOnlyDictionary<string, EvaluatedResourceBinding> evaluatedBindings =
            ReadEvaluatedResourceBindings(evaluation);

        string[] actualNames = resources.Keys.OrderBy(name => name, StringComparer.Ordinal).ToArray();
        string[] expectedNames = expected.Keys.OrderBy(name => name, StringComparer.Ordinal).ToArray();
        Require(checks, "resources.count", actualNames.Length, expectedNames.Length);
        Require(
            checks,
            "resources.logicalNames",
            actualNames.SequenceEqual(expectedNames, StringComparer.Ordinal),
            true);
        Require(checks, "resources.evaluatedBindingCount", evaluatedBindings.Count, expectedNames.Length);
        Require(
            checks,
            "resources.evaluatedLogicalNames",
            evaluatedBindings.Keys.OrderBy(value => value, StringComparer.Ordinal)
                .SequenceEqual(expectedNames, StringComparer.Ordinal),
            true);

        var entries = new List<ResourceEntry>();
        using IncrementalHash rawCatalog = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        using IncrementalHash canonicalCatalog = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (string name in actualNames)
        {
            byte[] payload = resources[name];
            byte[] canonical = CanonicalizeText(payload, name);
            string rawSha256 = Convert.ToHexString(SHA256.HashData(payload));
            string canonicalSha256 = Convert.ToHexString(SHA256.HashData(canonical));
            AppendFramed(rawCatalog, name, payload);
            AppendFramed(canonicalCatalog, name, canonical);

            bool expectedEntry = expected.TryGetValue(name, out ExpectedResource? expectation);
            Require(checks, $"resource.{name}.expected", expectedEntry, true);
            if (expectation is not null)
            {
                Require(
                    checks,
                    $"resource.{name}.canonicalLength",
                    canonical.Length,
                    expectation.CanonicalByteLength);
                Require(
                    checks,
                    $"resource.{name}.canonicalSha256",
                    canonicalSha256,
                    expectation.CanonicalSha256);
            }
            bool hasBinding = evaluatedBindings.TryGetValue(name, out EvaluatedResourceBinding? binding);
            Require(checks, $"resource.{name}.evaluatedBinding", hasBinding, true);
            if (binding is not null)
            {
                Require(checks, $"resource.{name}.rawPayloadSha256", rawSha256, binding.RawSha256);
                Require(
                    checks,
                    $"resource.{name}.evaluatedCanonicalSha256",
                    canonicalSha256,
                    binding.CanonicalSha256);
            }

            entries.Add(new ResourceEntry(
                name,
                payload.Length,
                rawSha256,
                canonical.Length,
                canonicalSha256,
                expectation?.Deployable ?? false));
        }

        int deployableCount = entries.Count(entry => entry.Deployable);
        int expectedDeployable = profileCatalog.GetProperty("counts")
            .GetProperty("deployableEmbeddedProfileSourceCount")
            .GetInt32();
        Require(checks, "resources.deployableCount", deployableCount, expectedDeployable);
        return new ResourceInventory(
            entries.Count,
            deployableCount,
            Convert.ToHexString(rawCatalog.GetHashAndReset()),
            Convert.ToHexString(canonicalCatalog.GetHashAndReset()),
            entries);
    }

    private static IReadOnlyDictionary<string, EvaluatedResourceBinding>
        ReadEvaluatedResourceBindings(JsonElement evaluation)
    {
        var bindings = new Dictionary<string, EvaluatedResourceBinding>(StringComparer.Ordinal);
        foreach (JsonElement element in evaluation.GetProperty("embeddedResources").EnumerateArray())
        {
            string row = element.GetString()
                ?? throw new InvalidDataException("An evaluated resource row is not a string.");
            string[] parts = row.Split('|', StringSplitOptions.None);
            if (parts.Length != 4
                || !parts[0].StartsWith(
                    "candidate/.pinned-upstream-v1.6.1/profiles/",
                    StringComparison.Ordinal)
                || !parts[1].StartsWith("logical=HIDMaestro.Profiles.", StringComparison.Ordinal)
                || !parts[2].StartsWith("rawSha256=", StringComparison.Ordinal)
                || !parts[3].StartsWith("canonicalSha256=", StringComparison.Ordinal))
            {
                throw new InvalidDataException("An evaluated resource row is malformed.");
            }
            string sourceSuffix = parts[0]["candidate/.pinned-upstream-v1.6.1/profiles/".Length..];
            string logicalName = parts[1]["logical=".Length..];
            if (logicalName != ProfilePrefix + sourceSuffix)
                throw new InvalidDataException("Evaluated resource source/logical-name mapping disagrees.");
            string rawSha256 = parts[2]["rawSha256=".Length..];
            string canonicalSha256 = parts[3]["canonicalSha256=".Length..];
            if (!IsUpperSha256(rawSha256) || !IsUpperSha256(canonicalSha256)
                || !bindings.TryAdd(
                    logicalName,
                    new EvaluatedResourceBinding(rawSha256, canonicalSha256)))
            {
                throw new InvalidDataException("Evaluated resource hashes are invalid or duplicated.");
            }
        }
        return bindings;
    }

    private static bool IsUpperSha256(string value) =>
        value.Length == 64 && value.All(character => character is >= '0' and <= '9' or >= 'A' and <= 'F');

    private static PublicApiInventory InspectPublicApi(
        MetadataReader metadata,
        JsonElement apiContract,
        List<ObservationCheck> checks)
    {
        var expectedEntries = new SortedSet<string>(StringComparer.Ordinal);
        var expectedTypes = new SortedSet<string>(StringComparer.Ordinal);
        var expectedTypeKinds = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (JsonElement type in apiContract.GetProperty("types").EnumerateArray())
        {
            string typeName = type.GetProperty("id").GetString()!;
            string kind = type.GetProperty("kind").GetString()!;
            expectedTypes.Add(typeName);
            expectedTypeKinds.Add(typeName, kind);
            if (kind == "enum")
            {
                foreach (JsonElement value in type.GetProperty("values").EnumerateArray())
                {
                    expectedEntries.Add(
                        $"V:{typeName}::{value.GetProperty("name").GetString()}={value.GetProperty("value").GetInt64()}");
                }
            }
            else
            {
                foreach (JsonElement member in type.GetProperty("members").EnumerateArray())
                {
                    expectedEntries.Add(
                        $"M:{typeName}::{member.GetProperty("id").GetString()}");
                }
            }
        }

        var observedEntries = new SortedSet<string>(StringComparer.Ordinal);
        var observedTypes = new SortedSet<string>(StringComparer.Ordinal);
        var details = new List<PublicTypeEntry>();
        foreach (TypeDefinitionHandle typeHandle in metadata.TypeDefinitions)
        {
            TypeDefinition type = metadata.GetTypeDefinition(typeHandle);
            if (!IsPublicType(type))
                continue;
            string typeName = FullTypeDefinitionName(metadata, typeHandle);
            string kind = TypeKind(metadata, type);
            observedTypes.Add(typeName);
            var members = new List<string>();
            string baseType = type.BaseType.IsNil ? "" : DescribeEntity(metadata, type.BaseType);
            string[] interfaces = type.GetInterfaceImplementations()
                .Select(handle => metadata.GetInterfaceImplementation(handle))
                .Select(implementation => DescribeEntity(metadata, implementation.Interface))
                .OrderBy(value => value, StringComparer.Ordinal)
                .ToArray();
            string[] typeAttributes = DescribeAttributeSet(metadata, type.GetCustomAttributes());

            Require(
                checks,
                $"api.type.{typeName}.expected",
                expectedTypeKinds.TryGetValue(typeName, out string? expectedKind),
                true);
            if (expectedKind is not null)
                Require(checks, $"api.type.{typeName}.kind", kind, expectedKind);

            if (kind == "enum")
            {
                foreach (FieldDefinitionHandle fieldHandle in type.GetFields())
                {
                    FieldDefinition field = metadata.GetFieldDefinition(fieldHandle);
                    string fieldName = metadata.GetString(field.Name);
                    string fieldType = NormalizeTypeName(
                        field.DecodeSignature(MetadataTypeNameProvider.Instance, null));
                    members.Add(
                        $"field-shape:{fieldName}:{fieldType}:attributes={field.Attributes}:custom=[{string.Join(";", DescribeAttributeSet(metadata, field.GetCustomAttributes()))}]");
                    if ((field.Attributes & FieldAttributes.FieldAccessMask) != FieldAttributes.Public
                        || (field.Attributes & FieldAttributes.Literal) == 0)
                        continue;
                    long value = ReadIntegerConstant(metadata, field.GetDefaultValue());
                    string id = $"{fieldName}={value}";
                    members.Add($"enum-value:{id}:type={fieldType}:attributes={field.Attributes}");
                    observedEntries.Add($"V:{typeName}::{id}");
                }
            }
            else
            {
                foreach (FieldDefinitionHandle fieldHandle in type.GetFields())
                {
                    FieldDefinition field = metadata.GetFieldDefinition(fieldHandle);
                    if ((field.Attributes & FieldAttributes.FieldAccessMask) != FieldAttributes.Public)
                        continue;
                    string id = metadata.GetString(field.Name);
                    members.Add(
                        $"field:{id}:{NormalizeTypeName(field.DecodeSignature(MetadataTypeNameProvider.Instance, null))}:attributes={field.Attributes}:signatureSha256={HashBlob(metadata, field.Signature)}:custom=[{string.Join(";", DescribeAttributeSet(metadata, field.GetCustomAttributes()))}]");
                    observedEntries.Add($"M:{typeName}::{id}");
                }

                foreach (PropertyDefinitionHandle propertyHandle in type.GetProperties())
                {
                    PropertyDefinition property = metadata.GetPropertyDefinition(propertyHandle);
                    if (!HasPublicAccessor(metadata, property.GetAccessors()))
                        continue;
                    string id = metadata.GetString(property.Name);
                    MethodSignature<string> signature = property.DecodeSignature(
                        MetadataTypeNameProvider.Instance,
                        null);
                    members.Add(
                        $"property:{id}:{FormatMethodSignature(signature)}:attributes={property.Attributes}:accessors={DescribeAccessors(metadata, property.GetAccessors())}:signatureSha256={HashBlob(metadata, property.Signature)}:custom=[{string.Join(";", DescribeAttributeSet(metadata, property.GetCustomAttributes()))}]");
                    observedEntries.Add($"M:{typeName}::{id}");
                }

                foreach (EventDefinitionHandle eventHandle in type.GetEvents())
                {
                    EventDefinition eventDefinition = metadata.GetEventDefinition(eventHandle);
                    if (!HasPublicAccessor(metadata, eventDefinition.GetAccessors()))
                        continue;
                    string id = metadata.GetString(eventDefinition.Name);
                    members.Add(
                        $"event:{id}:{DescribeEntity(metadata, eventDefinition.Type)}:attributes={eventDefinition.Attributes}:accessors={DescribeAccessors(metadata, eventDefinition.GetAccessors())}:custom=[{string.Join(";", DescribeAttributeSet(metadata, eventDefinition.GetCustomAttributes()))}]");
                    observedEntries.Add($"M:{typeName}::{id}");
                }

                foreach (MethodDefinitionHandle methodHandle in type.GetMethods())
                {
                    MethodDefinition method = metadata.GetMethodDefinition(methodHandle);
                    if ((method.Attributes & MethodAttributes.MemberAccessMask) != MethodAttributes.Public)
                        continue;
                    string name = metadata.GetString(method.Name);
                    bool constructor = name == ".ctor";
                    if (!constructor && (method.Attributes & MethodAttributes.SpecialName) != 0)
                        continue;
                    string id = MethodContractId(metadata, method);
                    MethodSignature<string> signature = method.DecodeSignature(
                        MetadataTypeNameProvider.Instance,
                        null);
                    members.Add(
                        $"method:{id}:{FormatMethodSignature(signature)}:attributes={method.Attributes}:impl={method.ImplAttributes}:signatureSha256={HashBlob(metadata, method.Signature)}:parameters=[{DescribeParameters(metadata, method)}]:custom=[{string.Join(";", DescribeAttributeSet(metadata, method.GetCustomAttributes()))}]");
                    observedEntries.Add($"M:{typeName}::{id}");
                }
            }

            members.Sort(StringComparer.Ordinal);
            details.Add(new PublicTypeEntry(
                typeName,
                kind,
                type.Attributes.ToString(),
                baseType,
                interfaces,
                typeAttributes,
                members));
        }

        details.Sort((left, right) => StringComparer.Ordinal.Compare(left.Name, right.Name));
        string[] missing = expectedEntries.Except(observedEntries, StringComparer.Ordinal).ToArray();
        string[] unexpected = observedEntries.Except(expectedEntries, StringComparer.Ordinal).ToArray();
        string[] missingTypes = expectedTypes.Except(observedTypes, StringComparer.Ordinal).ToArray();
        string[] unexpectedTypes = observedTypes.Except(expectedTypes, StringComparer.Ordinal).ToArray();
        int expectedLogicalCount = apiContract.GetProperty("surfaceRules")
            .GetProperty("logicalMemberCount")
            .GetInt32();
        Require(checks, "api.logicalIdentity.expectedCount", expectedEntries.Count, expectedLogicalCount);
        Require(checks, "api.logicalIdentity.observedCount", observedEntries.Count, expectedLogicalCount);
        Require(checks, "api.logicalIdentity.missing", missing.Length, 0);
        Require(checks, "api.logicalIdentity.unexpected", unexpected.Length, 0);
        int expectedTypeCount = apiContract.GetProperty("surfaceRules")
            .GetProperty("declaredTypeCount")
            .GetInt32();
        Require(checks, "api.declaredType.expectedCount", expectedTypes.Count, expectedTypeCount);
        Require(checks, "api.declaredType.observedCount", observedTypes.Count, expectedTypeCount);
        Require(checks, "api.declaredType.missing", missingTypes.Length, 0);
        Require(checks, "api.declaredType.unexpected", unexpectedTypes.Length, 0);
        return new PublicApiInventory(
            observedTypes.Count,
            observedTypes.ToArray(),
            missingTypes,
            unexpectedTypes,
            observedEntries.Count,
            observedEntries.ToArray(),
            missing,
            unexpected,
            details,
            StructuralContractMatched: false,
            StructuralContractState:
                "observation-only: exhaustive raw shapes inventoried; exact signature/nullability/accessor/attribute allowlist is unresolved until the receipt is reviewed");
    }

    private static MetadataInventory InspectMetadata(
        MetadataReader metadata,
        PEReader pe,
        JsonElement rejectPolicy,
        List<ObservationCheck> checks)
    {
        Dictionary<MethodDefinitionHandle, TypeDefinitionHandle> methodOwners = [];
        Dictionary<FieldDefinitionHandle, TypeDefinitionHandle> fieldOwners = [];
        foreach (TypeDefinitionHandle typeHandle in metadata.TypeDefinitions)
        {
            TypeDefinition type = metadata.GetTypeDefinition(typeHandle);
            foreach (MethodDefinitionHandle method in type.GetMethods())
                methodOwners.Add(method, typeHandle);
            foreach (FieldDefinitionHandle field in type.GetFields())
                fieldOwners.Add(field, typeHandle);
        }

        string[] assemblyReferences = metadata.AssemblyReferences
            .Select(handle => DescribeAssemblyReference(metadata, handle))
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        string[] typeReferences = metadata.TypeReferences
            .Select(handle => DescribeTypeReference(metadata, handle))
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        string[] memberReferences = metadata.MemberReferences
            .Select(handle => DescribeMemberReference(metadata, handle, methodOwners, fieldOwners))
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        string[] methodSpecifications = EnumerateRows(
                metadata.GetTableRowCount(TableIndex.MethodSpec),
                MetadataTokens.MethodSpecificationHandle)
            .Select(handle => DescribeMethodSpecification(metadata, handle, methodOwners, fieldOwners))
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        string[] standaloneSignatures = EnumerateRows(
                metadata.GetTableRowCount(TableIndex.StandAloneSig),
                MetadataTokens.StandaloneSignatureHandle)
            .Select(handle => DescribeStandaloneSignature(metadata, handle))
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        string[] typeSpecifications = EnumerateRows(
                metadata.GetTableRowCount(TableIndex.TypeSpec),
                MetadataTokens.TypeSpecificationHandle)
            .Select(handle => DescribeTypeSpecification(metadata, handle))
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        string[] customAttributes = metadata.CustomAttributes
            .Select(handle => DescribeCustomAttribute(metadata, handle, methodOwners, fieldOwners))
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();

        var methods = new List<MethodBodyEntry>();
        var ilTokenClosure = new List<IlTokenEntry>();
        var forbiddenOpcodes = new List<string>();
        int pinvokeCount = 0;
        int invalidImplementationCount = 0;
        int nonIlManagedBodyCount = 0;
        int moduleInitializerCount = 0;
        foreach ((MethodDefinitionHandle methodHandle, TypeDefinitionHandle ownerHandle) in methodOwners)
        {
            MethodDefinition method = metadata.GetMethodDefinition(methodHandle);
            string owner = FullTypeDefinitionName(metadata, ownerHandle);
            string name = metadata.GetString(method.Name);
            string methodId = $"{owner}::{MethodMetadataId(metadata, method)}";
            if ((method.Attributes & MethodAttributes.PinvokeImpl) != 0)
                pinvokeCount++;
            if (owner == "<Module>" && name == ".cctor")
                moduleInitializerCount++;
            foreach (CustomAttributeHandle attributeHandle in method.GetCustomAttributes())
            {
                if (CustomAttributeType(metadata, metadata.GetCustomAttribute(attributeHandle))
                    == ModuleInitializerAttribute)
                {
                    moduleInitializerCount++;
                }
            }

            bool managedIl =
                (method.ImplAttributes & MethodImplAttributes.CodeTypeMask) == MethodImplAttributes.IL
                && (method.ImplAttributes & MethodImplAttributes.ManagedMask) == MethodImplAttributes.Managed;
            bool hasBody = method.RelativeVirtualAddress != 0;
            bool abstractMethod = (method.Attributes & MethodAttributes.Abstract) != 0;
            bool validImplementation = managedIl && (hasBody || abstractMethod);
            if (!validImplementation)
                invalidImplementationCount++;
            if (!hasBody)
            {
                methods.Add(new MethodBodyEntry(
                    MetadataTokens.GetToken(methodHandle),
                    methodId,
                    method.Attributes.ToString(),
                    method.ImplAttributes.ToString(),
                    false,
                    null,
                    null,
                    0,
                    0,
                    0,
                    false,
                    null,
                    [],
                    []));
                continue;
            }

            if (!managedIl)
                nonIlManagedBodyCount++;

            MethodBodyBlock body = pe.GetMethodBody(method.RelativeVirtualAddress);
            byte[] bodyBytes = pe.GetSectionData(method.RelativeVirtualAddress)
                .GetContent(0, body.Size)
                .ToArray();
            string bodySha256 = Convert.ToHexString(SHA256.HashData(bodyBytes));
            byte[] il = body.GetILBytes()
                ?? throw new BadImageFormatException("A method body has no IL byte array.");
            string ilSha256 = Convert.ToHexString(SHA256.HashData(il));
            IReadOnlyList<ParsedInstruction> instructions = ParseInstructions(il);
            var methodTokens = new List<IlTokenEntry>();
            foreach (ParsedInstruction instruction in instructions)
            {
                if (instruction.MetadataToken is int token)
                {
                    var entry = new IlTokenEntry(
                        methodId,
                        instruction.Offset,
                        instruction.OpCode,
                        $"0x{token:X8}",
                        DescribeToken(metadata, token, methodOwners, fieldOwners));
                    methodTokens.Add(entry);
                    ilTokenClosure.Add(entry);
                }

                if (instruction.OpCode is "calli" or "jmp" or "localloc")
                    forbiddenOpcodes.Add($"{methodId}@0x{instruction.Offset:X4}:{instruction.OpCode}");
            }

            var exceptionRegions = new List<ExceptionRegionEntry>();
            foreach (ExceptionRegion region in body.ExceptionRegions)
            {
                string? catchType = null;
                if (!region.CatchType.IsNil)
                {
                    string description = DescribeEntity(metadata, region.CatchType);
                    catchType = $"0x{MetadataTokens.GetToken(region.CatchType):X8}:{description}";
                    ilTokenClosure.Add(new IlTokenEntry(
                        methodId,
                        region.TryOffset,
                        "exception-catch-type",
                        $"0x{MetadataTokens.GetToken(region.CatchType):X8}",
                        description));
                }
                exceptionRegions.Add(new ExceptionRegionEntry(
                    region.Kind.ToString(),
                    region.TryOffset,
                    region.TryLength,
                    region.HandlerOffset,
                    region.HandlerLength,
                    region.FilterOffset,
                    catchType));
            }

            string? localSignature = null;
            if (!body.LocalSignature.IsNil)
            {
                int token = MetadataTokens.GetToken(body.LocalSignature);
                localSignature = $"0x{token:X8}:{DescribeToken(metadata, token, methodOwners, fieldOwners)}";
                ilTokenClosure.Add(new IlTokenEntry(
                    methodId,
                    0,
                    "local-signature",
                    $"0x{token:X8}",
                    DescribeToken(metadata, token, methodOwners, fieldOwners)));
            }

            methods.Add(new MethodBodyEntry(
                MetadataTokens.GetToken(methodHandle),
                methodId,
                method.Attributes.ToString(),
                method.ImplAttributes.ToString(),
                true,
                bodySha256,
                ilSha256,
                body.Size,
                il.Length,
                body.MaxStack,
                body.LocalVariablesInitialized,
                localSignature,
                methodTokens,
                exceptionRegions));
        }

        methods.Sort((left, right) => left.MetadataToken.CompareTo(right.MetadataToken));
        ilTokenClosure.Sort((left, right) =>
        {
            int method = StringComparer.Ordinal.Compare(left.Method, right.Method);
            return method != 0 ? method : left.Offset.CompareTo(right.Offset);
        });
        forbiddenOpcodes.Sort(StringComparer.Ordinal);

        int moduleReferenceCount = metadata.GetTableRowCount(TableIndex.ModuleRef);
        int implementationMapCount = metadata.GetTableRowCount(TableIndex.ImplMap);
        int declarativeSecurityCount = metadata.GetTableRowCount(TableIndex.DeclSecurity);
        Require(
            checks,
            "metadata.pinvokeRows",
            pinvokeCount,
            rejectPolicy.GetProperty("pinvokeRows").GetInt32());
        Require(
            checks,
            "metadata.moduleReferenceRows",
            moduleReferenceCount,
            rejectPolicy.GetProperty("moduleReferenceRows").GetInt32());
        Require(checks, "metadata.implementationMapRows", implementationMapCount, 0);
        Require(
            checks,
            "metadata.declarativeSecurityRows",
            declarativeSecurityCount,
            rejectPolicy.GetProperty("declarativeSecurityRows").GetInt32());
        Require(
            checks,
            "metadata.moduleInitializerCount",
            moduleInitializerCount,
            rejectPolicy.GetProperty("moduleInitializerCount").GetInt32());
        Require(checks, "metadata.nonIlOrUnmanagedBodies", nonIlManagedBodyCount, 0);
        Require(checks, "metadata.invalidMethodImplementations", invalidImplementationCount, 0);
        Require(checks, "metadata.forbiddenIlOpcodes", forbiddenOpcodes.Count, 0);

        string[] forbiddenFragments = rejectPolicy.GetProperty("forbiddenReferenceFragments")
            .EnumerateArray()
            .Select(element => element.GetString()!)
            .ToArray();
        string[] referenceClosure = assemblyReferences
            .Concat(typeReferences)
            .Concat(memberReferences)
            .Concat(methodSpecifications)
            .Concat(ilTokenClosure.Select(entry => entry.Target))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        string[] forbiddenReferences = referenceClosure
            .SelectMany(value => forbiddenFragments
                .Where(fragment => value.Contains(fragment, StringComparison.OrdinalIgnoreCase))
                .Select(fragment => $"{fragment} <= {value}"))
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        Require(checks, "metadata.forbiddenReferences", forbiddenReferences.Length, 0);

        return new MetadataInventory(
            TableCounts: new Dictionary<string, int>(StringComparer.Ordinal),
            AssemblyReferences: assemblyReferences,
            TypeReferences: typeReferences,
            MemberReferences: memberReferences,
            MethodSpecifications: methodSpecifications,
            TypeSpecifications: typeSpecifications,
            StandaloneSignatures: standaloneSignatures,
            CustomAttributes: customAttributes,
            Methods: methods,
            IlTokenClosure: ilTokenClosure,
            ForbiddenOpcodes: forbiddenOpcodes,
            ForbiddenReferences: forbiddenReferences,
            PInvokeCount: pinvokeCount,
            ImplementationMapCount: implementationMapCount,
            ModuleReferenceCount: moduleReferenceCount,
            DeclarativeSecurityCount: declarativeSecurityCount,
            ModuleInitializerCount: moduleInitializerCount,
            NonIlOrUnmanagedBodyCount: nonIlManagedBodyCount);
    }

    private static PortablePdbInventory InspectPortablePdb(
        PEReader pe,
        string pdbPath,
        List<ObservationCheck> checks)
    {
        using var stream = new FileStream(
            pdbPath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            bufferSize: 64 * 1024,
            FileOptions.SequentialScan);
        string sha256 = HashOpenStream(stream);
        stream.Position = 0;
        using MetadataReaderProvider provider = MetadataReaderProvider.FromPortablePdbStream(
            stream,
            MetadataStreamOptions.LeaveOpen);
        MetadataReader pdb = provider.GetMetadataReader();
        DebugMetadataHeader pdbHeader = pdb.DebugMetadataHeader
            ?? throw new BadImageFormatException("The portable PDB debug metadata header is absent.");
        byte[] pdbIdBytes = pdbHeader.Id.ToArray();
        string pdbId = Convert.ToHexString(pdbIdBytes);
        if (pdbIdBytes.Length != 20)
            throw new BadImageFormatException("The portable PDB content ID is not 20 bytes.");
        Guid pdbGuid = new(pdbIdBytes.AsSpan(0, 16));
        uint pdbStamp = BinaryPrimitives.ReadUInt32LittleEndian(pdbIdBytes.AsSpan(16, 4));

        DebugDirectoryEntry[] debugEntries = pe.ReadDebugDirectory().ToArray();
        DebugDirectoryEntry[] codeViewEntries = debugEntries
            .Where(entry => entry.Type == DebugDirectoryEntryType.CodeView)
            .ToArray();
        DebugDirectoryEntry[] checksumEntries = debugEntries
            .Where(entry => entry.Type == DebugDirectoryEntryType.PdbChecksum)
            .ToArray();
        int reproducibleCount = debugEntries.Count(
            entry => entry.Type == DebugDirectoryEntryType.Reproducible);
        string[] unknownDebugEntryTypes = debugEntries
            .Where(entry => entry.Type is not DebugDirectoryEntryType.CodeView
                and not DebugDirectoryEntryType.PdbChecksum
                and not DebugDirectoryEntryType.Reproducible)
            .Select(entry => entry.Type.ToString())
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        Require(checks, "pdb.debugDirectory.codeViewCount", codeViewEntries.Length, 1);
        Require(checks, "pdb.debugDirectory.checksumCount", checksumEntries.Length, 1);
        Require(checks, "pdb.debugDirectory.reproducibleCount", reproducibleCount, 1);
        Require(checks, "pdb.debugDirectory.unknownTypes", unknownDebugEntryTypes.Length, 0);
        if (codeViewEntries.Length != 1 || checksumEntries.Length != 1)
            throw new BadImageFormatException("The PE debug directory is not the exact portable-PDB shape.");
        CodeViewDebugDirectoryData codeView = pe.ReadCodeViewDebugDirectoryData(codeViewEntries[0]);
        PdbChecksumDebugDirectoryData checksum =
            pe.ReadPdbChecksumDebugDirectoryData(checksumEntries[0]);
        Require(checks, "pdb.codeView.guid", codeView.Guid, pdbGuid);
        Require(checks, "pdb.codeView.stamp", codeViewEntries[0].Stamp, pdbStamp);
        Require(checks, "pdb.codeView.age", codeView.Age, 1);
        string normalizedCodeViewPath = codeView.Path.Replace('\\', '/');
        bool safeCodeViewPath = normalizedCodeViewPath == "HIDMaestro.Core.pdb"
            || normalizedCodeViewPath == "/_/output/HIDMaestro.Core.pdb";
        Require(checks, "pdb.codeView.pathRole", safeCodeViewPath, true);
        Require(checks, "pdb.checksum.algorithm", checksum.AlgorithmName, "SHA256");
        Require(
            checks,
            "pdb.checksum.value",
            Convert.ToHexString(checksum.Checksum.ToArray()),
            sha256);
        var documents = new List<PortablePdbDocument>();
        foreach (DocumentHandle handle in pdb.Documents)
        {
            Document document = pdb.GetDocument(handle);
            string name = pdb.GetString(document.Name);
            string algorithm = document.HashAlgorithm.IsNil
                ? ""
                : pdb.GetGuid(document.HashAlgorithm).ToString("D");
            string documentChecksum = document.Hash.IsNil
                ? ""
                : Convert.ToHexString(pdb.GetBlobBytes(document.Hash));
            documents.Add(new PortablePdbDocument(
                MetadataTokens.GetRowNumber(handle),
                name,
                algorithm,
                documentChecksum));
        }

        documents.Sort((left, right) => StringComparer.Ordinal.Compare(left.Name, right.Name));
        string[] unsafeDocuments = documents
            .Where(document =>
                !document.Name.StartsWith("/_/", StringComparison.Ordinal)
                || document.Name.Contains('\\')
                || document.Name.Contains(':'))
            .Select(document => document.Name)
            .ToArray();
        string[] generatedDocuments = documents
            .Where(document =>
                document.Name.EndsWith(".AssemblyAttributes.cs", StringComparison.OrdinalIgnoreCase)
                || document.Name.EndsWith(".AssemblyInfo.cs", StringComparison.OrdinalIgnoreCase)
                || document.Name.Contains("/obj/", StringComparison.OrdinalIgnoreCase))
            .Select(document => document.Name)
            .ToArray();
        Require(checks, "pdb.documentPathMap", unsafeDocuments.Length, 0);
        Require(checks, "pdb.generatedCompilerSources", generatedDocuments.Length, 0);

        var customDebugInformation = new List<string>();
        foreach (CustomDebugInformationHandle handle in pdb.CustomDebugInformation)
        {
            CustomDebugInformation info = pdb.GetCustomDebugInformation(handle);
            customDebugInformation.Add(
                $"parent=0x{MetadataTokens.GetToken(info.Parent):X8};kind={pdb.GetGuid(info.Kind):D};valueSha256={Convert.ToHexString(SHA256.HashData(pdb.GetBlobBytes(info.Value)))}");
        }
        customDebugInformation.Sort(StringComparer.Ordinal);

        return new PortablePdbInventory(
            sha256,
            pdbId,
            new PortablePdbDebugBinding(
                codeView.Guid.ToString("D"),
                codeViewEntries[0].Stamp,
                codeView.Age,
                "candidate-pdb",
                checksum.AlgorithmName,
                Convert.ToHexString(checksum.Checksum.ToArray()),
                reproducibleCount,
                unknownDebugEntryTypes),
            documents,
            unsafeDocuments,
            generatedDocuments,
            customDebugInformation);
    }

    private static BuildInputInventory InspectBuildInputs(
        JsonElement evaluation,
        JsonElement assets,
        JsonElement deps,
        JsonElement contract,
        List<ObservationCheck> checks)
    {
        string[] compileItems = ReadStringArray(evaluation, "compileItems");
        string[] embeddedResources = ReadStringArray(evaluation, "embeddedResources");
        string[] referencePaths = ReadStringArray(evaluation, "referencePaths");
        string[] analyzers = ReadStringArray(evaluation, "analyzers");
        string[] generatedCompilerSources = ReadStringArray(evaluation, "generatedCompilerSources");
        string[] imports = ReadStringArray(evaluation, "imports");
        string[] compilerArguments = ReadStringArray(evaluation, "compilerArguments");
        RequireReceiptSafeEntries(checks, "evaluation.compileItemsSafe", compileItems);
        RequireReceiptSafeEntries(checks, "evaluation.embeddedResourcesSafe", embeddedResources);
        RequireReceiptSafeEntries(checks, "evaluation.referencePathsSafe", referencePaths);
        RequireReceiptSafeEntries(checks, "evaluation.analyzersSafe", analyzers);
        RequireReceiptSafeEntries(checks, "evaluation.generatedSourcesSafe", generatedCompilerSources);
        RequireReceiptSafeEntries(checks, "evaluation.importsSafe", imports);
        RequireReceiptSafeEntries(checks, "evaluation.compilerArgumentsSafe", compilerArguments);

        JsonElement candidate = contract.GetProperty("sourceCandidate");
        JsonElement policy = contract.GetProperty("staticRejectPolicy");
        Require(
            checks,
            "evaluation.compileItems",
            compileItems.Length,
            candidate.GetProperty("compileItemCount").GetInt32());
        Require(
            checks,
            "evaluation.embeddedResources",
            embeddedResources.Length,
            candidate.GetProperty("embeddedResourceCount").GetInt32());
        Require(
            checks,
            "evaluation.analyzerAllowlistUnfrozen",
            policy.GetProperty("analyzerAllowlistFrozen").GetBoolean(),
            false);
        Require(
            checks,
            "evaluation.generatedCompilerSources",
            generatedCompilerSources.Length,
            policy.GetProperty("generatedCompilerSourceCount").GetInt32());
        Require(checks, "evaluation.referencePathsPresent", referencePaths.Length > 0, true);

        string[] assetLibraries = assets.GetProperty("libraries")
            .EnumerateObject()
            .Select(property =>
                $"{property.Name}|type={ReadOptionalString(property.Value, "type")}|sha512={ReadOptionalString(property.Value, "sha512")}")
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        string[] packageAssetLibraries = assets.GetProperty("libraries")
            .EnumerateObject()
            .Where(property => ReadOptionalString(property.Value, "type") == "package")
            .Select(property => property.Name)
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        Require(
            checks,
            "assets.packageLibraries",
            packageAssetLibraries.Length,
            policy.GetProperty("packageReferenceCount").GetInt32());

        string[] depsLibraries = deps.GetProperty("libraries")
            .EnumerateObject()
            .Select(property =>
                $"{property.Name}|type={ReadOptionalString(property.Value, "type")}|serviceable={ReadOptionalBoolean(property.Value, "serviceable")}")
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        string[] packageDepsLibraries = deps.GetProperty("libraries")
            .EnumerateObject()
            .Where(property => ReadOptionalString(property.Value, "type") == "package")
            .Select(property => property.Name)
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        Require(checks, "deps.packageLibraries", packageDepsLibraries.Length, 0);

        string[] assetTargets = assets.GetProperty("targets")
            .EnumerateObject()
            .Select(property => property.Name)
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        string[] depsTargets = deps.GetProperty("targets")
            .EnumerateObject()
            .Select(property => property.Name)
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        return new BuildInputInventory(
            compileItems,
            embeddedResources,
            referencePaths,
            analyzers,
            generatedCompilerSources,
            imports,
            compilerArguments,
            assetLibraries,
            packageAssetLibraries,
            assetTargets,
            depsLibraries,
            packageDepsLibraries,
            depsTargets);
    }

    private static NativeImportInventory ReadNativeImports(PEReader pe)
    {
        PEHeader header = pe.PEHeaders.PEHeader
            ?? throw new BadImageFormatException("The PE optional header is absent.");
        DirectoryEntry directory = header.ImportTableDirectory;
        if (IsEmpty(directory))
            return new NativeImportInventory(header.AddressOfEntryPoint, []);
        if (directory.RelativeVirtualAddress == 0 || directory.Size < 20)
            throw new BadImageFormatException("The PE import directory is malformed.");

        PEMemoryBlock tableBlock = pe.GetSectionData(directory.RelativeVirtualAddress);
        if (tableBlock.Length < directory.Size)
            throw new BadImageFormatException("The PE import directory is truncated.");
        ImmutableArray<byte> tableBytes = tableBlock.GetContent(0, directory.Size);
        var imports = new List<NativeImportModule>();
        bool descriptorTerminated = false;
        for (int offset = 0; offset <= tableBytes.Length - 20; offset += 20)
        {
            ReadOnlySpan<byte> descriptor = tableBytes.AsSpan(offset, 20);
            uint originalFirstThunk = BinaryPrimitives.ReadUInt32LittleEndian(descriptor);
            uint timeDateStamp = BinaryPrimitives.ReadUInt32LittleEndian(descriptor[4..]);
            uint forwarderChain = BinaryPrimitives.ReadUInt32LittleEndian(descriptor[8..]);
            uint nameRva = BinaryPrimitives.ReadUInt32LittleEndian(descriptor[12..]);
            uint firstThunk = BinaryPrimitives.ReadUInt32LittleEndian(descriptor[16..]);
            if (originalFirstThunk == 0
                && timeDateStamp == 0
                && forwarderChain == 0
                && nameRva == 0
                && firstThunk == 0)
            {
                descriptorTerminated = true;
                break;
            }
            if (nameRva == 0 || firstThunk == 0)
                throw new BadImageFormatException("A PE import descriptor is incomplete.");
            string module = ReadAsciiZ(pe, checked((int)nameRva));
            int thunkRva = checked((int)(originalFirstThunk == 0 ? firstThunk : originalFirstThunk));
            string[] symbols = ReadImportThunks64(pe, thunkRva);
            imports.Add(new NativeImportModule(module, symbols));
        }
        if (!descriptorTerminated)
            throw new BadImageFormatException("The PE import descriptor table has no terminator.");

        imports.Sort((left, right) =>
            StringComparer.OrdinalIgnoreCase.Compare(left.Module, right.Module));
        return new NativeImportInventory(header.AddressOfEntryPoint, imports);
    }

    private static string[] ReadImportThunks64(PEReader pe, int thunkRva)
    {
        PEMemoryBlock block = pe.GetSectionData(thunkRva);
        ImmutableArray<byte> bytes = block.GetContent();
        var symbols = new List<string>();
        bool terminated = false;
        for (int offset = 0; offset <= bytes.Length - sizeof(ulong); offset += sizeof(ulong))
        {
            ulong thunk = BinaryPrimitives.ReadUInt64LittleEndian(bytes.AsSpan(offset, sizeof(ulong)));
            if (thunk == 0)
            {
                terminated = true;
                break;
            }
            if ((thunk & 0x8000_0000_0000_0000UL) != 0)
            {
                symbols.Add($"ordinal:{thunk & 0xFFFF}");
                continue;
            }
            if (thunk > int.MaxValue - 2)
                throw new BadImageFormatException("A PE import name RVA is outside the supported range.");
            symbols.Add(ReadAsciiZ(pe, checked((int)thunk + sizeof(ushort))));
        }
        if (symbols.Count == 0)
            throw new BadImageFormatException("A PE import descriptor has no symbols.");
        if (!terminated)
            throw new BadImageFormatException("A PE import thunk table has no terminator.");
        symbols.Sort(StringComparer.Ordinal);
        return symbols.ToArray();
    }

    private static string ReadAsciiZ(PEReader pe, int rva)
    {
        ImmutableArray<byte> bytes = pe.GetSectionData(rva).GetContent();
        int length = 0;
        while (length < bytes.Length && length < 4_096 && bytes[length] != 0)
            length++;
        if (length == 0 || length == bytes.Length || length == 4_096)
            throw new BadImageFormatException("A PE import string is empty, truncated, or oversized.");
        for (int index = 0; index < length; index++)
        {
            if (bytes[index] is < 0x20 or > 0x7E)
                throw new BadImageFormatException("A PE import string is not printable ASCII.");
        }
        return Encoding.ASCII.GetString(bytes.AsSpan(0, length));
    }

    private static IReadOnlyList<ParsedInstruction> ParseInstructions(byte[] il)
    {
        var instructions = new List<ParsedInstruction>();
        int cursor = 0;
        while (cursor < il.Length)
        {
            int offset = cursor;
            ushort rawCode = il[cursor++];
            if (rawCode == 0xFE)
            {
                if (cursor >= il.Length)
                    throw new BadImageFormatException("A method body ends inside a two-byte opcode.");
                rawCode = checked((ushort)(0xFE00 | il[cursor++]));
            }
            if (!OpCodeMap.TryGetValue(rawCode, out OpCode opCode))
                throw new BadImageFormatException($"Unknown IL opcode 0x{rawCode:X4}.");

            int? token = null;
            int operandSize;
            switch (opCode.OperandType)
            {
                case OperandType.InlineNone:
                    operandSize = 0;
                    break;
                case OperandType.ShortInlineBrTarget:
                case OperandType.ShortInlineI:
                case OperandType.ShortInlineVar:
                    operandSize = 1;
                    break;
                case OperandType.InlineVar:
                    operandSize = 2;
                    break;
                case OperandType.InlineBrTarget:
                case OperandType.InlineI:
                case OperandType.ShortInlineR:
                    operandSize = 4;
                    break;
                case OperandType.InlineI8:
                case OperandType.InlineR:
                    operandSize = 8;
                    break;
                case OperandType.InlineField:
                case OperandType.InlineMethod:
                case OperandType.InlineSig:
                case OperandType.InlineString:
                case OperandType.InlineTok:
                case OperandType.InlineType:
                    operandSize = 4;
                    EnsureAvailable(il, cursor, operandSize);
                    token = BinaryPrimitives.ReadInt32LittleEndian(il.AsSpan(cursor, operandSize));
                    break;
                case OperandType.InlineSwitch:
                    EnsureAvailable(il, cursor, sizeof(int));
                    int branchCount = BinaryPrimitives.ReadInt32LittleEndian(
                        il.AsSpan(cursor, sizeof(int)));
                    if (branchCount < 0 || branchCount > (il.Length - cursor - sizeof(int)) / sizeof(int))
                        throw new BadImageFormatException("An IL switch operand is malformed.");
                    operandSize = checked(sizeof(int) + branchCount * sizeof(int));
                    break;
                default:
                    throw new BadImageFormatException(
                        $"Unsupported IL operand kind {opCode.OperandType} for {opCode.Name}.");
            }
            EnsureAvailable(il, cursor, operandSize);
            cursor += operandSize;
            instructions.Add(new ParsedInstruction(offset, opCode.Name ?? $"0x{rawCode:X4}", token));
        }
        return instructions;
    }

    private static void EnsureAvailable(byte[] bytes, int cursor, int count)
    {
        if (count < 0 || cursor < 0 || cursor > bytes.Length - count)
            throw new BadImageFormatException("An IL instruction operand is truncated.");
    }

    private static IReadOnlyDictionary<ushort, OpCode> BuildOpCodeMap()
    {
        var result = new Dictionary<ushort, OpCode>();
        foreach (FieldInfo field in typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static))
        {
            if (field.FieldType != typeof(OpCode) || field.GetValue(null) is not OpCode code)
                continue;
            result[unchecked((ushort)code.Value)] = code;
        }
        return result;
    }

    private static string DescribeAssemblyReference(
        MetadataReader metadata,
        AssemblyReferenceHandle handle)
    {
        AssemblyReference reference = metadata.GetAssemblyReference(handle);
        string culture = reference.Culture.IsNil ? "" : metadata.GetString(reference.Culture);
        string key = reference.PublicKeyOrToken.IsNil
            ? ""
            : Convert.ToHexString(metadata.GetBlobBytes(reference.PublicKeyOrToken));
        string hash = reference.HashValue.IsNil
            ? ""
            : Convert.ToHexString(metadata.GetBlobBytes(reference.HashValue));
        return $"0x{MetadataTokens.GetToken(handle):X8}|{metadata.GetString(reference.Name)}|{reference.Version}|culture={culture}|key={key}|flags={reference.Flags}|hash={hash}";
    }

    private static string DescribeTypeReference(
        MetadataReader metadata,
        TypeReferenceHandle handle)
    {
        TypeReference reference = metadata.GetTypeReference(handle);
        return $"0x{MetadataTokens.GetToken(handle):X8}|{FullTypeReferenceName(metadata, handle)}|scope={DescribeHandle(metadata, reference.ResolutionScope, null, null)}";
    }

    private static string DescribeMemberReference(
        MetadataReader metadata,
        MemberReferenceHandle handle,
        IReadOnlyDictionary<MethodDefinitionHandle, TypeDefinitionHandle>? methodOwners,
        IReadOnlyDictionary<FieldDefinitionHandle, TypeDefinitionHandle>? fieldOwners)
    {
        MemberReference reference = metadata.GetMemberReference(handle);
        string name = metadata.GetString(reference.Name);
        string parent = DescribeHandle(metadata, reference.Parent, methodOwners, fieldOwners);
        string signature = reference.GetKind() switch
        {
            MemberReferenceKind.Method => FormatMethodSignature(
                reference.DecodeMethodSignature(MetadataTypeNameProvider.Instance, null)),
            MemberReferenceKind.Field => NormalizeTypeName(
                reference.DecodeFieldSignature(MetadataTypeNameProvider.Instance, null)),
            _ => $"blob:{Convert.ToHexString(metadata.GetBlobBytes(reference.Signature))}",
        };
        return $"0x{MetadataTokens.GetToken(handle):X8}|{parent}::{name}|{reference.GetKind()}|{signature}|blobSha256={Convert.ToHexString(SHA256.HashData(metadata.GetBlobBytes(reference.Signature)))}";
    }

    private static string DescribeMethodSpecification(
        MetadataReader metadata,
        MethodSpecificationHandle handle,
        IReadOnlyDictionary<MethodDefinitionHandle, TypeDefinitionHandle> methodOwners,
        IReadOnlyDictionary<FieldDefinitionHandle, TypeDefinitionHandle> fieldOwners)
    {
        MethodSpecification specification = metadata.GetMethodSpecification(handle);
        ImmutableArray<string> arguments = specification.DecodeSignature(
            MetadataTypeNameProvider.Instance,
            null);
        return $"0x{MetadataTokens.GetToken(handle):X8}|method={DescribeHandle(metadata, specification.Method, methodOwners, fieldOwners)}|args=<{string.Join(",", arguments.Select(NormalizeTypeName))}>|blobSha256={Convert.ToHexString(SHA256.HashData(metadata.GetBlobBytes(specification.Signature)))}";
    }

    private static string DescribeStandaloneSignature(
        MetadataReader metadata,
        StandaloneSignatureHandle handle)
    {
        StandaloneSignature signature = metadata.GetStandaloneSignature(handle);
        byte[] blob = metadata.GetBlobBytes(signature.Signature);
        return $"0x{MetadataTokens.GetToken(handle):X8}|length={blob.Length}|sha256={Convert.ToHexString(SHA256.HashData(blob))}|hex={Convert.ToHexString(blob)}";
    }

    private static string DescribeTypeSpecification(
        MetadataReader metadata,
        TypeSpecificationHandle handle)
    {
        TypeSpecification specification = metadata.GetTypeSpecification(handle);
        return $"0x{MetadataTokens.GetToken(handle):X8}|{NormalizeTypeName(specification.DecodeSignature(MetadataTypeNameProvider.Instance, null))}|blobSha256={Convert.ToHexString(SHA256.HashData(metadata.GetBlobBytes(specification.Signature)))}";
    }

    private static string DescribeCustomAttribute(
        MetadataReader metadata,
        CustomAttributeHandle handle,
        IReadOnlyDictionary<MethodDefinitionHandle, TypeDefinitionHandle> methodOwners,
        IReadOnlyDictionary<FieldDefinitionHandle, TypeDefinitionHandle> fieldOwners)
    {
        CustomAttribute attribute = metadata.GetCustomAttribute(handle);
        byte[] blob = metadata.GetBlobBytes(attribute.Value);
        return $"row={MetadataTokens.GetRowNumber(handle)}|parent={DescribeHandle(metadata, attribute.Parent, methodOwners, fieldOwners)}|constructor={DescribeHandle(metadata, attribute.Constructor, methodOwners, fieldOwners)}|type={CustomAttributeType(metadata, attribute)}|blobSha256={Convert.ToHexString(SHA256.HashData(blob))}|blobLength={blob.Length}";
    }

    private static string DescribeToken(
        MetadataReader metadata,
        int token,
        IReadOnlyDictionary<MethodDefinitionHandle, TypeDefinitionHandle> methodOwners,
        IReadOnlyDictionary<FieldDefinitionHandle, TypeDefinitionHandle> fieldOwners)
    {
        Handle handle;
        try
        {
            handle = MetadataTokens.Handle(token);
        }
        catch (Exception exception) when (exception is ArgumentException or BadImageFormatException)
        {
            throw new BadImageFormatException($"Invalid IL metadata token 0x{token:X8}.", exception);
        }
        if (handle.IsNil)
            throw new BadImageFormatException("An IL metadata token is nil.");
        if (handle.Kind == HandleKind.UserString)
        {
            string value = metadata.GetUserString((UserStringHandle)handle);
            byte[] bytes = StrictUtf8.GetBytes(value);
            return $"UserString:length={value.Length}:utf8Length={bytes.Length}:sha256={Convert.ToHexString(SHA256.HashData(bytes))}";
        }
        return DescribeHandle(metadata, handle, methodOwners, fieldOwners);
    }

    private static string DescribeHandle(
        MetadataReader metadata,
        Handle handle,
        IReadOnlyDictionary<MethodDefinitionHandle, TypeDefinitionHandle>? methodOwners,
        IReadOnlyDictionary<FieldDefinitionHandle, TypeDefinitionHandle>? fieldOwners)
    {
        if (handle.IsNil)
            return "nil";
        return handle.Kind switch
        {
            HandleKind.AssemblyDefinition =>
                $"Assembly:{metadata.GetString(metadata.GetAssemblyDefinition().Name)}",
            HandleKind.AssemblyReference =>
                $"AssemblyRef:{metadata.GetString(metadata.GetAssemblyReference((AssemblyReferenceHandle)handle).Name)}",
            HandleKind.ModuleDefinition =>
                $"Module:{metadata.GetString(metadata.GetModuleDefinition().Name)}",
            HandleKind.ModuleReference =>
                $"ModuleRef:{metadata.GetString(metadata.GetModuleReference((ModuleReferenceHandle)handle).Name)}",
            HandleKind.TypeDefinition =>
                $"TypeDef:{FullTypeDefinitionName(metadata, (TypeDefinitionHandle)handle)}",
            HandleKind.TypeReference =>
                $"TypeRef:{FullTypeReferenceName(metadata, (TypeReferenceHandle)handle)}",
            HandleKind.TypeSpecification =>
                $"TypeSpec:{NormalizeTypeName(metadata.GetTypeSpecification((TypeSpecificationHandle)handle).DecodeSignature(MetadataTypeNameProvider.Instance, null))}",
            HandleKind.MethodDefinition =>
                DescribeMethodDefinition(metadata, (MethodDefinitionHandle)handle, methodOwners),
            HandleKind.FieldDefinition =>
                DescribeFieldDefinition(metadata, (FieldDefinitionHandle)handle, fieldOwners),
            HandleKind.MemberReference =>
                $"MemberRef:{DescribeMemberReference(metadata, (MemberReferenceHandle)handle, methodOwners, fieldOwners)}",
            HandleKind.MethodSpecification =>
                $"MethodSpec:{DescribeMethodSpecification(metadata, (MethodSpecificationHandle)handle, methodOwners!, fieldOwners!)}",
            HandleKind.StandaloneSignature =>
                $"StandaloneSig:{DescribeStandaloneSignature(metadata, (StandaloneSignatureHandle)handle)}",
            HandleKind.PropertyDefinition =>
                $"Property:{metadata.GetString(metadata.GetPropertyDefinition((PropertyDefinitionHandle)handle).Name)}",
            HandleKind.EventDefinition =>
                $"Event:{metadata.GetString(metadata.GetEventDefinition((EventDefinitionHandle)handle).Name)}",
            HandleKind.Parameter =>
                $"Parameter:{metadata.GetString(metadata.GetParameter((ParameterHandle)handle).Name)}",
            HandleKind.GenericParameter =>
                $"GenericParameter:{metadata.GetString(metadata.GetGenericParameter((GenericParameterHandle)handle).Name)}",
            _ => $"{handle.Kind}:0x{MetadataTokens.GetToken(handle):X8}",
        };
    }

    private static string DescribeMethodDefinition(
        MetadataReader metadata,
        MethodDefinitionHandle handle,
        IReadOnlyDictionary<MethodDefinitionHandle, TypeDefinitionHandle>? owners)
    {
        MethodDefinition method = metadata.GetMethodDefinition(handle);
        string owner = owners is not null && owners.TryGetValue(handle, out TypeDefinitionHandle type)
            ? FullTypeDefinitionName(metadata, type)
            : "<unknown-owner>";
        return $"MethodDef:{owner}::{MethodMetadataId(metadata, method)}";
    }

    private static string DescribeFieldDefinition(
        MetadataReader metadata,
        FieldDefinitionHandle handle,
        IReadOnlyDictionary<FieldDefinitionHandle, TypeDefinitionHandle>? owners)
    {
        FieldDefinition field = metadata.GetFieldDefinition(handle);
        string owner = owners is not null && owners.TryGetValue(handle, out TypeDefinitionHandle type)
            ? FullTypeDefinitionName(metadata, type)
            : "<unknown-owner>";
        return $"FieldDef:{owner}::{metadata.GetString(field.Name)}:{NormalizeTypeName(field.DecodeSignature(MetadataTypeNameProvider.Instance, null))}";
    }

    private static string DescribeEntity(MetadataReader metadata, EntityHandle handle) =>
        DescribeHandle(metadata, handle, null, null);

    private static string MethodMetadataId(MetadataReader metadata, MethodDefinition method)
    {
        MethodSignature<string> signature = method.DecodeSignature(
            MetadataTypeNameProvider.Instance,
            null);
        return $"{metadata.GetString(method.Name)}({string.Join(",", signature.ParameterTypes.Select(NormalizeTypeName))}):{NormalizeTypeName(signature.ReturnType)}";
    }

    private static string MethodContractId(MetadataReader metadata, MethodDefinition method)
    {
        MethodSignature<string> signature = method.DecodeSignature(
            MetadataTypeNameProvider.Instance,
            null);
        Dictionary<int, Parameter> parameters = method.GetParameters()
            .Select(metadata.GetParameter)
            .Where(parameter => parameter.SequenceNumber > 0)
            .ToDictionary(parameter => parameter.SequenceNumber);
        var parameterNames = new List<string>();
        for (int index = 0; index < signature.ParameterTypes.Length; index++)
        {
            string rawType = signature.ParameterTypes[index];
            string typeName = NormalizeTypeName(rawType);
            if (typeName.EndsWith('&'))
            {
                typeName = typeName[..^1];
                if (!parameters.TryGetValue(index + 1, out Parameter parameter))
                    throw new BadImageFormatException("A by-reference parameter has no metadata row.");
                bool output = (parameter.Attributes & ParameterAttributes.Out) != 0;
                bool input = (parameter.Attributes & ParameterAttributes.In) != 0
                    || rawType.Contains(
                        "System.Runtime.CompilerServices.IsReadOnlyAttribute",
                        StringComparison.Ordinal);
                typeName = output
                    ? $"out {typeName}"
                    : input
                        ? $"in {typeName}"
                        : $"ref {typeName}";
            }
            parameterNames.Add(typeName);
        }
        return $"{metadata.GetString(method.Name)}({string.Join(",", parameterNames)})";
    }

    private static string FormatMethodSignature(MethodSignature<string> signature) =>
        $"{NormalizeTypeName(signature.ReturnType)}({string.Join(",", signature.ParameterTypes.Select(NormalizeTypeName))})|instance={signature.Header.IsInstance}|explicitThis={signature.Header.HasExplicitThis}|callingConvention={signature.Header.CallingConvention}|generic={signature.GenericParameterCount}|required={signature.RequiredParameterCount}";

    private static string DescribeAccessors(
        MetadataReader metadata,
        PropertyAccessors accessors) =>
        $"get={DescribeAccessor(metadata, accessors.Getter)};set={DescribeAccessor(metadata, accessors.Setter)};others=[{string.Join(",", accessors.Others.Select(handle => DescribeAccessor(metadata, handle)))}]";

    private static string DescribeAccessors(
        MetadataReader metadata,
        EventAccessors accessors) =>
        $"add={DescribeAccessor(metadata, accessors.Adder)};remove={DescribeAccessor(metadata, accessors.Remover)};raise={DescribeAccessor(metadata, accessors.Raiser)};others=[{string.Join(",", accessors.Others.Select(handle => DescribeAccessor(metadata, handle)))}]";

    private static string DescribeAccessor(
        MetadataReader metadata,
        MethodDefinitionHandle handle)
    {
        if (handle.IsNil)
            return "nil";
        MethodDefinition method = metadata.GetMethodDefinition(handle);
        return $"0x{MetadataTokens.GetToken(handle):X8}:{metadata.GetString(method.Name)}:{method.Attributes}:{FormatMethodSignature(method.DecodeSignature(MetadataTypeNameProvider.Instance, null))}";
    }

    private static string DescribeParameters(
        MetadataReader metadata,
        MethodDefinition method) => string.Join(
            ";",
            method.GetParameters()
                .Select(metadata.GetParameter)
                .OrderBy(parameter => parameter.SequenceNumber)
                .Select(parameter =>
                {
                    string defaultValue = parameter.GetDefaultValue().IsNil
                        ? "nil"
                        : $"row:{MetadataTokens.GetRowNumber(parameter.GetDefaultValue())}";
                    BlobHandle marshal = parameter.GetMarshallingDescriptor();
                    string marshalSha256 = marshal.IsNil ? "" : HashBlob(metadata, marshal);
                    return $"sequence={parameter.SequenceNumber},name={metadata.GetString(parameter.Name)},attributes={parameter.Attributes},default={defaultValue},marshalSha256={marshalSha256},custom=[{string.Join(",", DescribeAttributeSet(metadata, parameter.GetCustomAttributes()))}]";
                }));

    private static string[] DescribeAttributeSet(
        MetadataReader metadata,
        CustomAttributeHandleCollection handles) => handles
            .Select(metadata.GetCustomAttribute)
            .Select(attribute =>
                $"{CustomAttributeType(metadata, attribute)}:{HashBlob(metadata, attribute.Value)}")
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();

    private static string HashBlob(MetadataReader metadata, BlobHandle handle) =>
        Convert.ToHexString(SHA256.HashData(metadata.GetBlobBytes(handle)));

    private static string NormalizeTypeName(string typeName) => Regex.Replace(
        typeName
            .Replace("class ", "", StringComparison.Ordinal)
            .Replace("valuetype ", "", StringComparison.Ordinal)
            .Replace("modreq(System.Runtime.CompilerServices.IsReadOnlyAttribute) ", "", StringComparison.Ordinal)
            .Replace("modreq(System.Runtime.InteropServices.InAttribute) ", "", StringComparison.Ordinal),
        "`[0-9]+",
        "",
        RegexOptions.CultureInvariant);

    private static bool IsPublicType(TypeDefinition type)
    {
        TypeAttributes visibility = type.Attributes & TypeAttributes.VisibilityMask;
        return visibility is TypeAttributes.Public or TypeAttributes.NestedPublic;
    }

    private static string TypeKind(MetadataReader metadata, TypeDefinition type)
    {
        string baseType = type.BaseType.IsNil ? "" : DescribeEntity(metadata, type.BaseType);
        if (baseType.EndsWith("System.Enum", StringComparison.Ordinal))
            return "enum";
        if (baseType.EndsWith("System.ValueType", StringComparison.Ordinal))
            return "struct";
        if ((type.Attributes & TypeAttributes.ClassSemanticsMask) == TypeAttributes.Interface)
            return "interface";
        return "class";
    }

    private static bool HasPublicAccessor(MetadataReader metadata, PropertyAccessors accessors) =>
        IsPublicMethod(metadata, accessors.Getter)
        || IsPublicMethod(metadata, accessors.Setter)
        || accessors.Others.Any(handle => IsPublicMethod(metadata, handle));

    private static bool HasPublicAccessor(MetadataReader metadata, EventAccessors accessors) =>
        IsPublicMethod(metadata, accessors.Adder)
        || IsPublicMethod(metadata, accessors.Remover)
        || IsPublicMethod(metadata, accessors.Raiser)
        || accessors.Others.Any(handle => IsPublicMethod(metadata, handle));

    private static bool IsPublicMethod(MetadataReader metadata, MethodDefinitionHandle handle) =>
        !handle.IsNil
        && (metadata.GetMethodDefinition(handle).Attributes & MethodAttributes.MemberAccessMask)
            == MethodAttributes.Public;

    private static string FullTypeDefinitionName(
        MetadataReader metadata,
        TypeDefinitionHandle handle)
    {
        TypeDefinition type = metadata.GetTypeDefinition(handle);
        string name = metadata.GetString(type.Name);
        TypeDefinitionHandle declaring = type.GetDeclaringType();
        if (!declaring.IsNil)
            return $"{FullTypeDefinitionName(metadata, declaring)}+{name}";
        string ns = metadata.GetString(type.Namespace);
        return string.IsNullOrEmpty(ns) ? name : $"{ns}.{name}";
    }

    private static string FullTypeReferenceName(
        MetadataReader metadata,
        TypeReferenceHandle handle)
    {
        TypeReference type = metadata.GetTypeReference(handle);
        string name = metadata.GetString(type.Name);
        if (type.ResolutionScope.Kind == HandleKind.TypeReference)
            return $"{FullTypeReferenceName(metadata, (TypeReferenceHandle)type.ResolutionScope)}+{name}";
        string ns = metadata.GetString(type.Namespace);
        return string.IsNullOrEmpty(ns) ? name : $"{ns}.{name}";
    }

    private static long ReadIntegerConstant(MetadataReader metadata, ConstantHandle handle)
    {
        if (handle.IsNil)
            throw new BadImageFormatException("A public enum literal has no constant row.");
        Constant constant = metadata.GetConstant(handle);
        BlobReader reader = metadata.GetBlobReader(constant.Value);
        return constant.TypeCode switch
        {
            ConstantTypeCode.SByte => reader.ReadSByte(),
            ConstantTypeCode.Byte => reader.ReadByte(),
            ConstantTypeCode.Int16 => reader.ReadInt16(),
            ConstantTypeCode.UInt16 => reader.ReadUInt16(),
            ConstantTypeCode.Int32 => reader.ReadInt32(),
            ConstantTypeCode.UInt32 => reader.ReadUInt32(),
            ConstantTypeCode.Int64 => reader.ReadInt64(),
            ConstantTypeCode.UInt64 => checked((long)reader.ReadUInt64()),
            _ => throw new BadImageFormatException(
                $"Enum literal has unsupported constant type {constant.TypeCode}."),
        };
    }

    private static string? ReadAssemblyStringAttribute(
        MetadataReader metadata,
        string expectedAttributeType)
    {
        var values = new List<string>();
        foreach (CustomAttributeHandle handle in metadata.GetAssemblyDefinition().GetCustomAttributes())
        {
            CustomAttribute attribute = metadata.GetCustomAttribute(handle);
            if (CustomAttributeType(metadata, attribute) != expectedAttributeType)
                continue;
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

    private static string CustomAttributeType(
        MetadataReader metadata,
        CustomAttribute attribute)
    {
        EntityHandle parent = attribute.Constructor.Kind switch
        {
            HandleKind.MemberReference =>
                metadata.GetMemberReference((MemberReferenceHandle)attribute.Constructor).Parent,
            HandleKind.MethodDefinition =>
                FindMethodOwner(metadata, (MethodDefinitionHandle)attribute.Constructor),
            _ => default,
        };
        return parent.Kind switch
        {
            HandleKind.TypeReference =>
                FullTypeReferenceName(metadata, (TypeReferenceHandle)parent),
            HandleKind.TypeDefinition =>
                FullTypeDefinitionName(metadata, (TypeDefinitionHandle)parent),
            _ => $"<{parent.Kind}>",
        };
    }

    private static TypeDefinitionHandle FindMethodOwner(
        MetadataReader metadata,
        MethodDefinitionHandle method)
    {
        foreach (TypeDefinitionHandle typeHandle in metadata.TypeDefinitions)
        {
            if (metadata.GetTypeDefinition(typeHandle).GetMethods().Contains(method))
                return typeHandle;
        }
        return default;
    }

    private static byte[] CanonicalizeText(byte[] payload, string name)
    {
        string text = StrictUtf8.GetString(payload);
        string normalized = text.Replace("\r\n", "\n", StringComparison.Ordinal);
        if (normalized.IndexOf('\r') >= 0)
            throw new InvalidDataException($"Bare carriage return in resource {name}.");
        return StrictUtf8.GetBytes(normalized);
    }

    private static void AppendFramed(IncrementalHash hash, string name, byte[] payload)
    {
        hash.AppendData(StrictUtf8.GetBytes(name));
        hash.AppendData([0]);
        hash.AppendData(payload);
        hash.AppendData([0]);
    }

    private static bool IsEmpty(DirectoryEntry entry) =>
        entry.RelativeVirtualAddress == 0 && entry.Size == 0;

    private static string HashOpenStream(FileStream stream)
    {
        long original = stream.Position;
        stream.Position = 0;
        string hash = Convert.ToHexString(SHA256.HashData(stream));
        stream.Position = original;
        return hash;
    }

    private static IEnumerable<THandle> EnumerateRows<THandle>(
        int count,
        Func<int, THandle> createHandle)
    {
        for (int row = 1; row <= count; row++)
            yield return createHandle(row);
    }

    private sealed class HashedJsonInput : IDisposable
    {
        private HashedJsonInput(JsonDocument document, string sha256)
        {
            Document = document;
            Sha256 = sha256;
        }

        internal JsonDocument Document { get; }

        internal string Sha256 { get; }

        internal static HashedJsonInput Open(string path)
        {
            using var stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                bufferSize: 64 * 1024,
                FileOptions.SequentialScan);
            string sha256 = HashOpenStream(stream);
            stream.Position = 0;
            JsonDocument document = JsonDocument.Parse(stream, new JsonDocumentOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 128,
            });
            return new HashedJsonInput(document, sha256);
        }

        public void Dispose() => Document.Dispose();
    }

    private static void WriteJson(string outputPath, object value)
    {
        string fullPath = Path.GetFullPath(outputPath);
        string? directory = Path.GetDirectoryName(fullPath);
        if (string.IsNullOrWhiteSpace(directory) || !Directory.Exists(directory))
            throw new DirectoryNotFoundException("The inspector output directory does not exist.");
        string temporary = fullPath + ".partial";
        byte[] json = JsonSerializer.SerializeToUtf8Bytes(value, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = true,
        });
        File.WriteAllBytes(temporary, json);
        File.Move(temporary, fullPath, overwrite: false);
    }

    private static string[] ReadStringArray(JsonElement element, string propertyName) =>
        element.GetProperty(propertyName)
            .EnumerateArray()
            .Select(item => item.GetString()
                ?? throw new InvalidDataException($"{propertyName} contains a non-string value."))
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();

    private static void RequireReceiptSafeEntries(
        List<ObservationCheck> checks,
        string checkName,
        IReadOnlyList<string> entries)
    {
        string[] unsafeEntries = entries
            .Where(value =>
                value.Contains(":\\", StringComparison.Ordinal)
                || value.StartsWith("\\\\", StringComparison.Ordinal)
                || value.Contains("$env:", StringComparison.OrdinalIgnoreCase))
            .ToArray();
        Require(checks, checkName, unsafeEntries.Length, 0);
    }

    private static string? ReadOptionalString(JsonElement element, string propertyName) =>
        element.TryGetProperty(propertyName, out JsonElement value)
            && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;

    private static bool? ReadOptionalBoolean(JsonElement element, string propertyName) =>
        element.TryGetProperty(propertyName, out JsonElement value)
            && value.ValueKind is JsonValueKind.True or JsonValueKind.False
                ? value.GetBoolean()
                : null;

    private static void Require<T>(
        List<ObservationCheck> checks,
        string name,
        T actual,
        T expected) => Require(checks, name, actual, expected, EqualityComparer<T>.Default);

    private static void Require<T>(
        List<ObservationCheck> checks,
        string name,
        T actual,
        T expected,
        IEqualityComparer<T> comparer)
    {
        bool ok = comparer.Equals(actual, expected);
        checks.Add(new ObservationCheck(name, ok, actual, expected));
    }

    private static string? TryFindOutputPath(string[] args)
    {
        for (int index = 0; index < args.Length - 1; index++)
            if (args[index] == "--output")
                return args[index + 1];
        return null;
    }

    private sealed record Arguments(
        string ArtifactPath,
        string PdbPath,
        string DepsPath,
        string AssetsPath,
        string EvaluationPath,
        string ContractPath,
        string ApiContractPath,
        string ProfileCatalogPath,
        string OutputPath)
    {
        internal static Arguments Parse(string[] args)
        {
            if (args.Length != 19 || args[0] != "inspect")
                throw new ArgumentException("The inspector requires the exact 'inspect' argument surface.");
            var values = new Dictionary<string, string>(StringComparer.Ordinal);
            for (int index = 1; index < args.Length; index += 2)
            {
                string key = args[index];
                if (!key.StartsWith("--", StringComparison.Ordinal)
                    || !values.TryAdd(key, args[index + 1]))
                {
                    throw new ArgumentException($"Invalid or duplicate inspector option: {key}");
                }
            }

            string[] exactKeys =
            [
                "--api",
                "--artifact",
                "--assets",
                "--contract",
                "--deps",
                "--evaluation",
                "--output",
                "--pdb",
                "--profiles",
            ];
            if (!values.Keys.OrderBy(value => value, StringComparer.Ordinal)
                .SequenceEqual(exactKeys, StringComparer.Ordinal))
            {
                throw new ArgumentException("The inspector option set is not exact.");
            }

            string Input(string key)
            {
                string path = Path.GetFullPath(values[key]);
                if (!File.Exists(path))
                    throw new FileNotFoundException($"Inspector input is absent: {key}", path);
                if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException($"Inspector input is a reparse point: {key}");
                return path;
            }

            string output = Path.GetFullPath(values["--output"]);
            if (File.Exists(output) || Directory.Exists(output))
                throw new IOException("The inspector output path must not already exist.");
            return new Arguments(
                Input("--artifact"),
                Input("--pdb"),
                Input("--deps"),
                Input("--assets"),
                Input("--evaluation"),
                Input("--contract"),
                Input("--api"),
                Input("--profiles"),
                output);
        }
    }

    private sealed record ExpectedResource(
        int CanonicalByteLength,
        string CanonicalSha256,
        bool Deployable);

    private sealed record EvaluatedResourceBinding(
        string RawSha256,
        string CanonicalSha256);

    private sealed record ParsedInstruction(int Offset, string OpCode, int? MetadataToken);
}

internal sealed record ObservationCheck(string Name, bool Ok, object? Actual, object? Expected);

internal sealed record ArtifactIdentity(
    string Role,
    long ByteLength,
    string Sha256,
    string AssemblyName,
    string AssemblyVersion,
    string? FileVersion,
    string? InformationalVersion,
    string? TargetFramework,
    string Mvid,
    string Machine,
    string PeMagic,
    string CorFlags,
    int ManagedEntryPointTokenOrRva);

internal sealed record NativeImportInventory(
    int AddressOfEntryPoint,
    IReadOnlyList<NativeImportModule> Imports);

internal sealed record NativeImportModule(string Module, IReadOnlyList<string> Symbols);

internal sealed record ResourceInventory(
    int Count,
    int DeployableCount,
    string RawCatalogSha256,
    string CanonicalCatalogSha256,
    IReadOnlyList<ResourceEntry> Entries);

internal sealed record ResourceEntry(
    string LogicalName,
    int RawByteLength,
    string RawSha256,
    int CanonicalByteLength,
    string CanonicalSha256,
    bool Deployable);

internal sealed record PublicApiInventory(
    int DeclaredTypeCount,
    IReadOnlyList<string> DeclaredTypes,
    IReadOnlyList<string> MissingTypes,
    IReadOnlyList<string> UnexpectedTypes,
    int LogicalEntryCount,
    IReadOnlyList<string> LogicalEntries,
    IReadOnlyList<string> MissingEntries,
    IReadOnlyList<string> UnexpectedEntries,
    IReadOnlyList<PublicTypeEntry> Types,
    bool StructuralContractMatched,
    string StructuralContractState);

internal sealed record PublicTypeEntry(
    string Name,
    string Kind,
    string Attributes,
    string BaseType,
    IReadOnlyList<string> Interfaces,
    IReadOnlyList<string> CustomAttributes,
    IReadOnlyList<string> Members);

internal sealed record MetadataInventory(
    IReadOnlyDictionary<string, int> TableCounts,
    IReadOnlyList<string> AssemblyReferences,
    IReadOnlyList<string> TypeReferences,
    IReadOnlyList<string> MemberReferences,
    IReadOnlyList<string> MethodSpecifications,
    IReadOnlyList<string> TypeSpecifications,
    IReadOnlyList<string> StandaloneSignatures,
    IReadOnlyList<string> CustomAttributes,
    IReadOnlyList<MethodBodyEntry> Methods,
    IReadOnlyList<IlTokenEntry> IlTokenClosure,
    IReadOnlyList<string> ForbiddenOpcodes,
    IReadOnlyList<string> ForbiddenReferences,
    int PInvokeCount,
    int ImplementationMapCount,
    int ModuleReferenceCount,
    int DeclarativeSecurityCount,
    int ModuleInitializerCount,
    int NonIlOrUnmanagedBodyCount);

internal sealed record MethodBodyEntry(
    int MetadataToken,
    string Method,
    string Attributes,
    string ImplementationAttributes,
    bool HasBody,
    string? MethodBodySha256,
    string? IlSha256,
    int MethodBodyByteLength,
    int IlByteLength,
    int MaxStack,
    bool LocalVariablesInitialized,
    string? LocalSignature,
    IReadOnlyList<IlTokenEntry> MetadataTokenOperands,
    IReadOnlyList<ExceptionRegionEntry> ExceptionRegions);

internal sealed record ExceptionRegionEntry(
    string Kind,
    int TryOffset,
    int TryLength,
    int HandlerOffset,
    int HandlerLength,
    int FilterOffset,
    string? CatchType);

internal sealed record IlTokenEntry(
    string Method,
    int Offset,
    string OpCode,
    string Token,
    string Target);

internal sealed record PortablePdbInventory(
    string Sha256,
    string Id,
    PortablePdbDebugBinding DebugBinding,
    IReadOnlyList<PortablePdbDocument> Documents,
    IReadOnlyList<string> UnsafeDocumentPaths,
    IReadOnlyList<string> GeneratedCompilerSources,
    IReadOnlyList<string> CustomDebugInformation);

internal sealed record PortablePdbDebugBinding(
    string CodeViewGuid,
    uint CodeViewStamp,
    int CodeViewAge,
    string CodeViewPath,
    string ChecksumAlgorithm,
    string Checksum,
    int ReproducibleEntryCount,
    IReadOnlyList<string> UnknownEntryTypes);

internal sealed record PortablePdbDocument(
    int Row,
    string Name,
    string HashAlgorithm,
    string Checksum);

internal sealed record BuildInputInventory(
    IReadOnlyList<string> CompileItems,
    IReadOnlyList<string> EmbeddedResources,
    IReadOnlyList<string> ReferencePaths,
    IReadOnlyList<string> Analyzers,
    IReadOnlyList<string> GeneratedCompilerSources,
    IReadOnlyList<string> Imports,
    IReadOnlyList<string> CompilerArguments,
    IReadOnlyList<string> AssetLibraries,
    IReadOnlyList<string> PackageAssetLibraries,
    IReadOnlyList<string> AssetTargets,
    IReadOnlyList<string> DepsLibraries,
    IReadOnlyList<string> PackageDepsLibraries,
    IReadOnlyList<string> DepsTargets);

internal sealed record GateState(
    bool ArtifactPublicApiAllowlistFrozen,
    bool ArtifactCompileAllowlistFrozen,
    bool ProfileSourceCatalogBound,
    bool RawFeedbackDecoderFrozen,
    bool DriverRuntimeAbiBound,
    bool DistributionReady);

internal sealed record ArtifactObservation(
    int SchemaVersion,
    bool Ok,
    string Phase,
    bool CandidateBuilt,
    bool CandidateLoaded,
    bool CandidateExecuted,
    bool DriverTouched,
    bool DeviceTouched,
    bool NetworkUsedByCandidate,
    int NativeBootstrapAddressOfEntryPoint,
    NativeImportInventory NativeBootstrap,
    ArtifactIdentity Artifact,
    string PdbSha256,
    string DepsJsonSha256,
    string AssetsJsonSha256,
    string EvaluationJsonSha256,
    PublicApiInventory PublicApi,
    ResourceInventory Resources,
    MetadataInventory Metadata,
    PortablePdbInventory PortablePdb,
    BuildInputInventory BuildInputs,
    IReadOnlyList<ObservationCheck> Checks,
    IReadOnlyList<string> UnresolvedObservationExpectations,
    GateState GateState);
