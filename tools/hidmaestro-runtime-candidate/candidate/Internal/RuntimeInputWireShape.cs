using System;

namespace HIDMaestro.Internal;

/// <summary>
/// One frozen persona: the exact catalog profile identity it may be created
/// from, and the shape of the full-wire input report it produces — how long it
/// is, whether it carries a leading report ID, and which slice of it the
/// shared-memory endpoint is given.
/// </summary>
/// <remarks>
/// <para>
/// Before this type existed the whole input path was one profile wide. The
/// encoder, the controller's report buffer, the device lifecycle's identity
/// guard and the shared-memory seam each spelled DualSense's own numbers
/// directly — 64 bytes, a leading <c>0x01</c>, USB, and a <c>Slice(1, 63)</c>
/// handed to the endpoint. That is correct for DualSense and wrong for every
/// profile whose descriptor declares no report ID, because there is then no
/// byte to strip and the data slice is the whole report.
/// </para>
/// <para>
/// So the numbers move here, as a closed set of frozen shapes. A shape is not
/// constructible from outside this file, and the lifecycle admits a profile
/// only when one of these shapes matches its identity field for field — which
/// keeps every guarantee the hard-coded checks gave, while letting a second
/// persona carry its own coordinates. DualSense's values are read from
/// <see cref="RuntimeDualSenseInputEncoder"/>'s own constants rather than
/// restated, so the frozen conformance profile keeps a single source of truth.
/// </para>
/// <para>
/// <see cref="DeclaredInputReportSize"/> is the profile's own
/// <c>inputReportSize</c> and is deliberately separate from
/// <see cref="FullWireLength"/>. DualSense and Xbox Series happen to agree,
/// but Switch Pro does not — it declares 362, the length of its largest
/// declared report (0x31/0x32/0x33 carry 361 data bytes plus a report ID),
/// while the report this candidate encodes is far smaller. They are
/// different facts: one is what the
/// catalog profile declares, the other is the length this candidate
/// actually encodes. A
/// persona whose descriptor carries several report IDs of different sizes
/// would have them differ, and conflating them would silently encode the wrong
/// report.
/// </para>
/// </remarks>
internal readonly struct RuntimeInputWireShape
{
    internal const string DualSenseProfileId = "dualsense";
    internal const string XboxSeriesProfileId = "xbox-series-xs-bt";
    internal const string SwitchProProfileId = "switch-pro";

    private RuntimeInputWireShape(
        string profileId,
        ushort vendorId,
        ushort productId,
        string connection,
        int declaredInputReportSize,
        int fullWireLength,
        bool includesReportId,
        byte reportId,
        int sharedDataOffset,
        int sharedDataLength,
        bool requiresSoftwareDeviceCompanion = false)
    {
        RequiresSoftwareDeviceCompanion = requiresSoftwareDeviceCompanion;
        ProfileId = profileId;
        VendorId = vendorId;
        ProductId = productId;
        Connection = connection;
        DeclaredInputReportSize = declaredInputReportSize;
        FullWireLength = fullWireLength;
        IncludesReportId = includesReportId;
        ReportId = reportId;
        SharedDataOffset = sharedDataOffset;
        SharedDataLength = sharedDataLength;
    }

    internal string ProfileId { get; }

    internal ushort VendorId { get; }

    internal ushort ProductId { get; }

    internal string Connection { get; }

    /// <summary>The profile's own declared <c>inputReportSize</c>.</summary>
    internal int DeclaredInputReportSize { get; }

    /// <summary>Length of the report this candidate's encoder produces.</summary>
    internal int FullWireLength { get; }

    /// <summary>
    /// Whether the descriptor declares a Report ID, and therefore whether the
    /// first wire byte is that ID rather than payload.
    /// </summary>
    internal bool IncludesReportId { get; }

    /// <summary>Meaningful only when <see cref="IncludesReportId"/>.</summary>
    internal byte ReportId { get; }

    /// <summary>First byte of the slice handed to the endpoint.</summary>
    internal int SharedDataOffset { get; }

    /// <summary>Length of the slice handed to the endpoint.</summary>
    internal int SharedDataLength { get; }

    /// <summary>
    /// Whether this persona presents as something the plain-HID lane cannot
    /// create on its own.
    /// </summary>
    /// <remarks>
    /// Encoding a report and creating the device that carries it are two
    /// different problems. A profile whose <c>driverMode</c> is
    /// <c>xinputhid</c> is created as a single software-device companion, which
    /// Windows' own INBOX <c>xinputhid</c> driver then binds — there is no main
    /// HID node and no XUSB companion on that path. Creating it needs the
    /// <c>hmswd.exe</c> helper, which this candidate does not carry, so it
    /// refuses that lane explicitly rather than attempting a plain-HID creation
    /// that would either fail obscurely or produce a device no game reads as a
    /// controller.
    /// </remarks>
    internal bool RequiresSoftwareDeviceCompanion { get; }

    /// <summary>
    /// Plain USB, 64 bytes led by report ID 0x01; the driver prepends the ID on
    /// the exact device, so the endpoint receives the 63 descriptor-data bytes
    /// only.
    /// </summary>
    internal static RuntimeInputWireShape DualSense { get; } =
        new(
            DualSenseProfileId, 0x054C, 0x0CE6, "usb",
            declaredInputReportSize: RuntimeDualSenseInputEncoder.EncodedReportSize,
            fullWireLength: RuntimeDualSenseInputEncoder.EncodedReportSize,
            includesReportId: true,
            reportId: RuntimeDualSenseInputEncoder.ReportId,
            sharedDataOffset: 1,
            sharedDataLength: RuntimeDualSenseInputEncoder.EncodedReportSize - 1);

    /// <summary>
    /// Bluetooth, 17 bytes with no report ID at all: the descriptor declares
    /// none, so no byte is stripped and the data slice is the entire report.
    /// </summary>
    internal static RuntimeInputWireShape XboxSeries { get; } =
        new(
            XboxSeriesProfileId, 0x045E, 0x0B13, "bluetooth",
            declaredInputReportSize: RuntimeXboxSeriesInputEncoder.EncodedReportSize,
            fullWireLength: RuntimeXboxSeriesInputEncoder.EncodedReportSize,
            includesReportId: false,
            reportId: 0x00,
            sharedDataOffset: 0,
            sharedDataLength: RuntimeXboxSeriesInputEncoder.EncodedReportSize,
            requiresSoftwareDeviceCompanion: true);

    /// <summary>
    /// Bluetooth, the 48-byte report-0x30 BODY with no report-ID byte: the
    /// driver frames and streams it as report 0x30 itself (0x3F pre-handshake)
    /// and overlays the counter, battery and vibrator bytes, so the endpoint
    /// receives the whole body and nothing is stripped. The profile's declared
    /// inputReportSize of 362 is the length of its LARGEST declared report
    /// (0x31/0x32/0x33), not of the body submitted here — which is exactly why
    /// the two are separate fields.
    /// </summary>
    internal static RuntimeInputWireShape SwitchPro { get; } =
        new(
            SwitchProProfileId, 0x057E, 0x2009, "bluetooth",
            declaredInputReportSize: 362,
            fullWireLength: RuntimeSwitchProInputEncoder.EncodedReportSize,
            includesReportId: false,
            reportId: 0x00,
            sharedDataOffset: 0,
            sharedDataLength: RuntimeSwitchProInputEncoder.EncodedReportSize);

    /// <summary>
    /// Resolves the frozen shape for a catalog profile id. A profile with no
    /// shape has no encoder in this candidate and must be refused before any
    /// device is touched.
    /// </summary>
    internal static bool TryGet(string profileId, out RuntimeInputWireShape shape)
    {
        switch (profileId)
        {
            case DualSenseProfileId:
                shape = DualSense;
                return true;
            case XboxSeriesProfileId:
                shape = XboxSeries;
                return true;
            case SwitchProProfileId:
                shape = SwitchPro;
                return true;
            default:
                shape = default;
                return false;
        }
    }

    /// <summary>
    /// Field-for-field identity match against an embedded catalog profile.
    /// This is the generalization of the previous exact-DualSense guard and
    /// checks every field that guard checked.
    /// </summary>
    internal bool MatchesProfileIdentity(HMProfile profile)
    {
        return profile is not null &&
            string.Equals(profile.Id, ProfileId, StringComparison.Ordinal) &&
            profile.VendorId == VendorId &&
            profile.ProductId == ProductId &&
            string.Equals(profile.Connection, Connection, StringComparison.Ordinal) &&
            profile.InputReportSize == DeclaredInputReportSize &&
            profile.HasDescriptor;
    }

    /// <summary>
    /// Validates a produced report against this shape. Kept beside the shape so
    /// the seam and the controller cannot disagree about what "valid" means.
    /// </summary>
    internal void ValidateFullWireReport(ReadOnlySpan<byte> fullWireReport, string parameterName)
    {
        if (fullWireReport.Length != FullWireLength)
        {
            throw new ArgumentException(
                $"The full {ProfileId} wire report must be exactly {FullWireLength} bytes.",
                parameterName);
        }

        if (IncludesReportId && fullWireReport[0] != ReportId)
        {
            throw new ArgumentException(
                $"The full {ProfileId} wire report must begin with report ID 0x{ReportId:X2}.",
                parameterName);
        }
    }
}
