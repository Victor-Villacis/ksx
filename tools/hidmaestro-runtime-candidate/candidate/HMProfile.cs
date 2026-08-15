using System;

namespace HIDMaestro;

public sealed class HMProfile
{
    internal HMProfile(
        string id,
        string name,
        ushort vendorId,
        ushort productId,
        string connection,
        int inputReportSize,
        bool hasDescriptor)
    {
        Id = id ?? throw new ArgumentNullException(nameof(id));
        Name = name ?? throw new ArgumentNullException(nameof(name));
        VendorId = vendorId;
        ProductId = productId;
        Connection = connection ?? throw new ArgumentNullException(nameof(connection));
        InputReportSize = inputReportSize;
        HasDescriptor = hasDescriptor;
    }

    public string Id { get; }

    public string Name { get; }

    public ushort VendorId { get; }

    public ushort ProductId { get; }

    internal string Connection { get; }

    internal int InputReportSize { get; }

    internal bool HasDescriptor { get; }
}
