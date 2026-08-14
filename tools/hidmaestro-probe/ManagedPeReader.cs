using System.Buffers.Binary;
using System.Collections.Immutable;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using System.Text;

namespace Ksx.HidMaestroProbe;

/// <summary>
/// Byte-only helpers shared by the SDK inventory and distribution audit. A
/// PEReader parses the target as data; none of these methods asks the CLR to
/// resolve, load, initialize, or execute the inspected assembly.
/// </summary>
internal static class ManagedPeReader
{
    private const int MaximumManifestResourceRows = 4_096;
    private const int MaximumSelectedResourceBytes = 4 * 1024 * 1024;
    private const int MaximumSelectedResourceTotalBytes = 64 * 1024 * 1024;

    internal static IReadOnlyDictionary<string, byte[]> ReadEmbeddedResources(
        PEReader pe,
        MetadataReader metadata,
        Func<string, bool> selectPayload)
    {
        DirectoryEntry directory = pe.PEHeaders.CorHeader?.ResourcesDirectory
            ?? throw new BadImageFormatException("The PE has no CLR header.");
        bool directoryAbsent = directory.RelativeVirtualAddress == 0 && directory.Size == 0;
        bool tableEmpty = metadata.ManifestResources.Count == 0;
        if (directoryAbsent && tableEmpty)
            return new Dictionary<string, byte[]>(StringComparer.Ordinal);
        if (directoryAbsent
            || tableEmpty
            || directory.RelativeVirtualAddress == 0
            || directory.Size == 0)
        {
            throw new InvalidDataException(
                "The managed-resource table and CLR resource directory disagree.");
        }
        if (metadata.ManifestResources.Count > MaximumManifestResourceRows)
            throw new InvalidDataException("The managed-resource table exceeds the row limit.");

        PEMemoryBlock block = pe.GetSectionData(directory.RelativeVirtualAddress);
        if (block.Length < directory.Size)
            throw new InvalidDataException("The managed-resource directory is truncated.");

        var resources = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        var ranges = new List<(int Start, int End, string Name)>();
        int selectedTotal = 0;
        foreach (ManifestResourceHandle handle in metadata.ManifestResources)
        {
            ManifestResource resource = metadata.GetManifestResource(handle);
            string name = metadata.GetString(resource.Name);
            if (!resource.Implementation.IsNil)
                throw new InvalidDataException($"Linked manifest resource is forbidden: {name}");
            if (resource.Offset > int.MaxValue)
                throw new InvalidDataException($"Manifest resource offset is too large: {name}");

            int offset = checked((int)resource.Offset);
            if (offset < 0 || offset > directory.Size - sizeof(int))
                throw new InvalidDataException(
                    $"Manifest resource offset is outside the resource directory: {name}");
            ImmutableArray<byte> prefix = block.GetContent(offset, sizeof(int));
            int length = BinaryPrimitives.ReadInt32LittleEndian(prefix.AsSpan());
            if (length < 0 || length > directory.Size - offset - sizeof(int))
                throw new InvalidDataException($"Manifest resource length is invalid: {name}");
            ranges.Add((offset, checked(offset + sizeof(int) + length), name));

            byte[] payload = [];
            if (selectPayload(name))
            {
                if (length > MaximumSelectedResourceBytes)
                    throw new InvalidDataException($"Selected managed resource exceeds the size limit: {name}");
                selectedTotal = checked(selectedTotal + length);
                if (selectedTotal > MaximumSelectedResourceTotalBytes)
                    throw new InvalidDataException("Selected managed resources exceed the total size limit.");
                payload = block.GetContent(offset + sizeof(int), length).ToArray();
            }
            if (!resources.TryAdd(name, payload))
                throw new InvalidDataException($"Duplicate manifest resource name: {name}");
        }

        ranges.Sort((left, right) => left.Start.CompareTo(right.Start));
        for (int index = 1; index < ranges.Count; index++)
        {
            if (ranges[index].Start < ranges[index - 1].End)
            {
                throw new InvalidDataException(
                    $"Managed resources overlap: {ranges[index - 1].Name} and {ranges[index].Name}");
            }
        }
        return resources;
    }

    internal static byte[] ExtractLengthPrefixedResource(
        ReadOnlySpan<byte> resourceDirectory,
        int offset,
        string resourceName)
    {
        if (offset < 0 || offset > resourceDirectory.Length - sizeof(int))
            throw new InvalidDataException(
                $"Manifest resource offset is outside the resource directory: {resourceName}");
        int length = BinaryPrimitives.ReadInt32LittleEndian(
            resourceDirectory.Slice(offset, sizeof(int)));
        if (length < 0 || length > resourceDirectory.Length - offset - sizeof(int))
            throw new InvalidDataException(
                $"Manifest resource length is invalid: {resourceName}");
        return resourceDirectory.Slice(offset + sizeof(int), length).ToArray();
    }

    internal static string HashCatalog(
        IReadOnlyDictionary<string, byte[]> resources,
        IReadOnlyList<string> resourceNames)
    {
        using IncrementalHash hasher = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (string name in resourceNames)
        {
            hasher.AppendData(Encoding.UTF8.GetBytes(name));
            hasher.AppendData([0]);
            hasher.AppendData(resources[name]);
            hasher.AppendData([0]);
        }
        return Convert.ToHexString(hasher.GetHashAndReset());
    }

    internal static string QualifiedName(MetadataReader metadata, TypeDefinition type)
    {
        string name = metadata.GetString(type.Name);
        string ns = metadata.GetString(type.Namespace);
        return string.IsNullOrEmpty(ns) ? name : $"{ns}.{name}";
    }

    internal static string QualifiedName(MetadataReader metadata, TypeReference type)
    {
        string name = metadata.GetString(type.Name);
        string ns = metadata.GetString(type.Namespace);
        return string.IsNullOrEmpty(ns) ? name : $"{ns}.{name}";
    }

    internal static string ParseSingleStringCustomAttribute(
        ReadOnlySpan<byte> blob,
        string attributeName)
    {
        if (blob.Length < 5 || BinaryPrimitives.ReadUInt16LittleEndian(blob) != 1)
            throw new BadImageFormatException($"{attributeName} has an invalid custom-attribute prolog.");

        int cursor = sizeof(ushort);
        int byteLength = ReadCompressedUnsignedInteger(blob, ref cursor, attributeName);
        if (byteLength < 0)
            throw new BadImageFormatException($"{attributeName} contains a null value.");
        if (byteLength > blob.Length - cursor - sizeof(ushort))
            throw new BadImageFormatException($"{attributeName} contains a truncated string.");

        string text;
        try
        {
            text = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true)
                .GetString(blob.Slice(cursor, byteLength));
        }
        catch (DecoderFallbackException exception)
        {
            throw new BadImageFormatException(
                $"{attributeName} contains invalid UTF-8.",
                exception);
        }
        cursor += byteLength;
        if (BinaryPrimitives.ReadUInt16LittleEndian(blob[cursor..]) != 0
            || cursor + sizeof(ushort) != blob.Length)
            throw new BadImageFormatException($"{attributeName} has an unexpected payload shape.");
        return text;
    }

    private static int ReadCompressedUnsignedInteger(
        ReadOnlySpan<byte> blob,
        ref int cursor,
        string attributeName)
    {
        if (cursor >= blob.Length)
            throw new BadImageFormatException($"{attributeName} has a truncated string length.");
        byte first = blob[cursor++];
        if (first == 0xFF)
            return -1;
        if ((first & 0x80) == 0)
            return first;
        if ((first & 0xC0) == 0x80)
        {
            if (cursor >= blob.Length)
                throw new BadImageFormatException($"{attributeName} has a truncated string length.");
            return ((first & 0x3F) << 8) | blob[cursor++];
        }
        if ((first & 0xE0) == 0xC0)
        {
            if (cursor > blob.Length - 3)
                throw new BadImageFormatException($"{attributeName} has a truncated string length.");
            int length = ((first & 0x1F) << 24)
                | (blob[cursor++] << 16)
                | (blob[cursor++] << 8)
                | blob[cursor++];
            return length;
        }
        throw new BadImageFormatException($"{attributeName} has an invalid string length.");
    }
}

internal sealed class MetadataTypeNameProvider : ISignatureTypeProvider<string, object?>
{
    internal static readonly MetadataTypeNameProvider Instance = new();

    public string GetArrayType(string elementType, ArrayShape shape) =>
        $"{elementType}[{new string(',', shape.Rank - 1)}]";

    public string GetByReferenceType(string elementType) => $"{elementType}&";

    public string GetFunctionPointerType(MethodSignature<string> signature) =>
        $"method {signature.ReturnType}({string.Join(",", signature.ParameterTypes)})*";

    public string GetGenericInstantiation(string genericType, ImmutableArray<string> typeArguments) =>
        $"{genericType}<{string.Join(",", typeArguments)}>";

    public string GetGenericMethodParameter(object? genericContext, int index) => $"!!{index}";

    public string GetGenericTypeParameter(object? genericContext, int index) => $"!{index}";

    public string GetModifiedType(string modifier, string unmodifiedType, bool isRequired) =>
        $"{(isRequired ? "modreq" : "modopt")}({modifier}) {unmodifiedType}";

    public string GetPinnedType(string elementType) => $"pinned {elementType}";

    public string GetPointerType(string elementType) => $"{elementType}*";

    public string GetPrimitiveType(PrimitiveTypeCode typeCode) => typeCode switch
    {
        PrimitiveTypeCode.Boolean => "System.Boolean",
        PrimitiveTypeCode.Byte => "System.Byte",
        PrimitiveTypeCode.Char => "System.Char",
        PrimitiveTypeCode.Double => "System.Double",
        PrimitiveTypeCode.Int16 => "System.Int16",
        PrimitiveTypeCode.Int32 => "System.Int32",
        PrimitiveTypeCode.Int64 => "System.Int64",
        PrimitiveTypeCode.IntPtr => "System.IntPtr",
        PrimitiveTypeCode.Object => "System.Object",
        PrimitiveTypeCode.SByte => "System.SByte",
        PrimitiveTypeCode.Single => "System.Single",
        PrimitiveTypeCode.String => "System.String",
        PrimitiveTypeCode.TypedReference => "System.TypedReference",
        PrimitiveTypeCode.UInt16 => "System.UInt16",
        PrimitiveTypeCode.UInt32 => "System.UInt32",
        PrimitiveTypeCode.UInt64 => "System.UInt64",
        PrimitiveTypeCode.UIntPtr => "System.UIntPtr",
        PrimitiveTypeCode.Void => "System.Void",
        _ => $"<{typeCode}>",
    };

    public string GetSZArrayType(string elementType) => $"{elementType}[]";

    public string GetTypeFromDefinition(
        MetadataReader reader,
        TypeDefinitionHandle handle,
        byte rawTypeKind) => WithKind(
            ManagedPeReader.QualifiedName(reader, reader.GetTypeDefinition(handle)),
            rawTypeKind);

    public string GetTypeFromReference(
        MetadataReader reader,
        TypeReferenceHandle handle,
        byte rawTypeKind) => WithKind(
            ManagedPeReader.QualifiedName(reader, reader.GetTypeReference(handle)),
            rawTypeKind);

    public string GetTypeFromSpecification(
        MetadataReader reader,
        object? genericContext,
        TypeSpecificationHandle handle,
        byte rawTypeKind) => reader.GetTypeSpecification(handle).DecodeSignature(this, genericContext);

    private static string WithKind(string name, byte rawTypeKind) => rawTypeKind switch
    {
        0x11 => $"valuetype {name}",
        0x12 => $"class {name}",
        _ => $"kind-0x{rawTypeKind:X2} {name}",
    };
}
