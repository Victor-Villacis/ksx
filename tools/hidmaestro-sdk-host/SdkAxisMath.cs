namespace Ksx.HidMaestroSdkHost;

/// <summary>
/// ksx wire sample to HIDMaestro normalized [0,1].
/// </summary>
/// <remarks>
/// <para>
/// Deliberately SDK-FREE - only <see cref="short"/>, <see cref="byte"/>,
/// <see cref="float"/> and <see cref="Math"/>. <c>SdkStateMapper</c> cannot be
/// compiled without the hash-pinned <c>HIDMaestro.Core.dll</c>, which is a
/// 113 MB gitignored download, so nothing that references it can be exercised
/// in CI. This arithmetic is the part worth pinning, so it lives where the
/// golden-vector harness can compile THE SHIPPING SOURCE rather than a copy.
/// </para>
/// <para>
/// Extracted verbatim from <c>SdkStateMapper</c> with no behaviour change.
/// </para>
/// </remarks>
internal static class SdkAxisMath
{
    // Identical conversions to the candidate host's StateMapper, kept
    // byte-for-byte so a slot moved between lanes feels the same.
    internal static float Axis(short value, bool invert)
    {
        int sample = invert ? -Math.Clamp((int)value, -32767, 32767) : value;
        byte wire = (byte)(((long)sample + 32768L) * 255L / 65535L);
        return ByteValue(wire);
    }

    internal static float ByteValue(byte value) => value == 255 ? 1f : (value + 0.25f) / 255f;
}
