using Ksx.HidMaestroProbe;

namespace Ksx.HidMaestroFakeHost;

internal readonly record struct FakePersona(
    HostProfileId Profile,
    ushort VendorId,
    ushort ProductId);

/// <summary>
/// Compile-time identity emitted by the SDK-free fake. These are assertions
/// about the pin the daemon expects, not evidence that this process inspected
/// or loaded an SDK. CI compares them with the static inventory result.
/// </summary>
internal static class FakePinnedIdentity
{
    internal const string SdkSha256Hex =
        "ADADD9E2604B7B6B047F386EBDD03879FEEF48009C6290281E4C665E2190F6D5";
    internal const string CatalogSha256Hex =
        "8F407E6E1C3C241E16CF6BEF387216AD4D1F5DE055A2C4CC041CA16CE7954A6A";
    internal const ushort CatalogResourceCount = 228;

    internal const int MaximumControllerIdentities = 16;
    internal const int MaximumQueuedFeedback = 64;
    internal const ulong HostPumpIntervalMicroseconds = 16_000;
    internal const ulong ClientLeaseRefreshMicroseconds = 1_000_000;
    internal const ulong ClientLeaseTimeoutMicroseconds = 5_000_000;

    internal static byte[] SdkSha256() => Convert.FromHexString(SdkSha256Hex);

    internal static byte[] CatalogSha256() => Convert.FromHexString(CatalogSha256Hex);

    internal static FakePersona Persona(HostProfileId profile) => profile switch
    {
        HostProfileId.DualSense => new(profile, 0x054C, 0x0CE6),
        HostProfileId.SwitchPro => new(profile, 0x057E, 0x2009),
        HostProfileId.XboxSeries => new(profile, 0x045E, 0x0B13),
        HostProfileId.Snes => new(profile, 0x0583, 0x2060),
        HostProfileId.Genesis => new(profile, 0x2341, 0x8036),
        _ => throw new ArgumentOutOfRangeException(nameof(profile)),
    };
}
