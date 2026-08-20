using System;
using System.Collections.Generic;

namespace HIDMaestro.Internal;

/// <summary>
/// Input report encoder for the pinned <c>switch-pro</c> catalog profile
/// (Nintendo, 057E:2009, Bluetooth), report <c>0x3F</c>.
/// </summary>
/// <remarks>
/// <para>
/// Source-only binding to tools/hidmaestro-input-contract-switch-pro/{contract.json,
/// golden-vectors.json}. Its eleven scenarios / 43 frames remain an unexecuted
/// artifact behavior gate in S1.5d; this source freeze performs no compile,
/// assembly load, driver action, or device action.
/// </para>
/// <para>
/// WHY REPORT 0x3F AND NOT THE OTHERS. This descriptor declares six input
/// reports. The profile's own notes settle which one is encodable: report
/// <c>0x3F</c> is "a real HID gamepad (16 buttons, null-state hat, X/Y/Rx/Ry
/// 16-bit)", while <c>0x21</c>/<c>0x30</c> and <c>0x31</c>-<c>0x33</c> are
/// vendor blobs, and "DirectInput parses only 0x3F". Only <c>0x3F</c> is
/// described field by field in the descriptor, so only <c>0x3F</c> can be
/// derived rather than guessed. The descriptor walk gives twelve bytes:
/// </para>
/// <code>
///   byte  0      report ID 0x3F
///   byte  1..2   buttons 1..16, one bit each
///   byte  3      hat switch, 4 bits, logical 0..7, then 4 bits padding
///   byte  4..5   X   16 bits, logical 0..65535
///   byte  6..7   Y   16 bits
///   byte  8..9   Rx  16 bits
///   byte 10..11  Ry  16 bits
/// </code>
/// <para>
/// WHY THE PROFILE SAYS 362 AND THIS ENCODER SAYS 12. <c>inputReportSize</c>
/// IS a report length: this descriptor declares reports <c>0x31</c>/<c>0x32</c>/
/// <c>0x33</c> at 361 data bytes plus a report ID, so 362 is the largest report
/// the profile can carry. (Upstream's shared input section is also 362 bytes,
/// because it was sized to hold the largest report in the catalog — two
/// different quantities that happen to share a number. An earlier revision of
/// this comment asserted they were the same thing; they are not.)
/// A short submission is nonetheless ordinary, for a different reason: the
/// shared section carries an explicit <c>DataSize</c> field, and DualSense
/// already submits 63 bytes into that same section.
/// </para>
/// <para>
/// THE AXIS TRAP, same as every other persona here.
/// <see cref="HMGamepadState.Axes"/> is keyed by <see cref="HMAxis"/>, but the
/// host writes ONE fixed physical assignment shaped by the DualSense
/// descriptor: <c>Z</c>/<c>Rz</c> are the right stick and <c>Rx</c>/<c>Ry</c>
/// are the triggers. This descriptor names its right stick <c>Rx</c>/<c>Ry</c>,
/// so the right stick is read from <c>HMAxis.Z</c>/<c>HMAxis.Rz</c> and the
/// letters deliberately disagree.
/// </para>
/// <para>
/// FACE BUTTONS ARE POSITIONAL. Nintendo labels the bottom face button B and
/// the right one A — the mirror of Xbox. The profile's <c>layout</c> gives
/// <c>face_b</c> descriptor index 0 and <c>face_a</c> index 1, and this encoder
/// binds <see cref="HMButton.A"/> to index 0. That is deliberate: A is the
/// bottom button on every persona, so a player pressing the bottom button gets
/// the same action here as on an Xbox pad rather than a mirrored one.
/// </para>
/// <para>
/// The two triggers are digital. The profile's layout carries an empty
/// <c>triggers</c> list and gives ZL and ZR button indices 6 and 7, so the
/// analog trigger axes become bits exactly as DualSense derives its L2/R2 bits.
/// </para>
/// </remarks>
internal sealed class RuntimeSwitchProInputEncoder
{
    internal const byte ReportId = 0x3F;
    internal const int EncodedReportSize = 12;

    private const int ButtonCount = 16;

    /// <summary>
    /// Descriptor button index for each carried button, taken from the
    /// profile's <c>layout</c> roles.
    /// </summary>
    private static readonly (HMButton Button, int Index)[] ButtonMap =
    [
        (HMButton.A, 0),
        (HMButton.B, 1),
        (HMButton.X, 2),
        (HMButton.Y, 3),
        (HMButton.LeftBumper, 4),
        (HMButton.RightBumper, 5),
        (HMButton.Back, 8),
        (HMButton.Start, 9),
        (HMButton.LeftStick, 10),
        (HMButton.RightStick, 11),
        (HMButton.Guide, 12),
        (HMButton.Share, 13),
    ];

    internal void Encode(in HMGamepadState state, Span<byte> destination)
    {
        if (destination.Length != EncodedReportSize)
        {
            throw new ArgumentException(
                $"The Switch Pro report destination must be exactly {EncodedReportSize} bytes.",
                nameof(destination));
        }

        // Every call is a complete frame: no vendor byte, no sequence counter,
        // and no carry-over from the previous report.
        destination.Clear();
        destination[0] = ReportId;

        Dictionary<HMAxis, float>? axes = state.Axes;

        // Read by PHYSICAL MEANING, not by descriptor letter — see the remarks.
        float leftStickX = GetNormalizedAxis(axes, HMAxis.X);
        float leftStickY = GetNormalizedAxis(axes, HMAxis.Y);
        float rightStickX = GetNormalizedAxis(axes, HMAxis.Z);
        float rightStickY = GetNormalizedAxis(axes, HMAxis.Rz);
        float leftTrigger = GetNormalizedAxis(axes, HMAxis.Rx);
        float rightTrigger = GetNormalizedAxis(axes, HMAxis.Ry);

        uint buttons = (uint)state.Buttons;
        foreach ((HMButton button, int index) in ButtonMap)
        {
            if ((buttons & (uint)button) == 0)
            {
                continue;
            }

            if (index < 0 || index >= ButtonCount)
            {
                throw new InvalidOperationException(
                    $"Switch Pro button {button} maps outside the descriptor's {ButtonCount} buttons.");
            }

            destination[1 + (index / 8)] |= (byte)(1 << (index % 8));
        }

        // ZL and ZR are buttons on this pad, so the analog trigger axes become
        // bits the moment they leave rest.
        if (leftTrigger > 0.0f)
        {
            destination[1] |= 0x40;
        }

        if (rightTrigger > 0.0f)
        {
            destination[1] |= 0x80;
        }

        destination[3] = EncodeHat(state.Hat);

        WriteUInt16(destination, 4, leftStickX);
        WriteUInt16(destination, 6, leftStickY);
        WriteUInt16(destination, 8, rightStickX);
        WriteUInt16(destination, 10, rightStickY);
    }

    private static float GetNormalizedAxis(Dictionary<HMAxis, float>? axes, HMAxis axis)
    {
        if (axes is null || !axes.TryGetValue(axis, out float value))
        {
            return 0.0f;
        }

        if (!float.IsFinite(value))
        {
            throw new ArgumentOutOfRangeException(
                nameof(axes),
                value,
                $"Switch Pro axis {axis} must be finite.");
        }

        return Math.Clamp(value, 0.0f, 1.0f);
    }

    private static void WriteUInt16(Span<byte> destination, int offset, float normalized)
    {
        ushort scaled = (ushort)ScaleAxis(normalized, ushort.MaxValue);
        destination[offset] = (byte)(scaled & 0xFF);
        destination[offset + 1] = (byte)(scaled >> 8);
    }

    /// <summary>
    /// Truncates, matching the DualSense encoder and the quarter-unit bias the
    /// host state mapper applies for exactly that reason.
    /// </summary>
    private static int ScaleAxis(float normalized, int logicalMaximum)
    {
        double scaled = Math.Truncate((double)normalized * logicalMaximum);
        return (int)Math.Clamp(scaled, 0.0, logicalMaximum);
    }

    /// <summary>
    /// Eight directions occupy 0..7 clockwise from North and the centred hat is
    /// the out-of-range 8. Each value is written out explicitly rather than
    /// cast from the enum, which would silently follow a renumbering of
    /// <see cref="HMHat"/> straight onto the wire.
    /// </summary>
    private static byte EncodeHat(HMHat hat)
    {
        return hat switch
        {
            HMHat.North => (byte)0,
            HMHat.NorthEast => (byte)1,
            HMHat.East => (byte)2,
            HMHat.SouthEast => (byte)3,
            HMHat.South => (byte)4,
            HMHat.SouthWest => (byte)5,
            HMHat.West => (byte)6,
            HMHat.NorthWest => (byte)7,
            HMHat.None => (byte)8,
            _ => throw new ArgumentOutOfRangeException(
                nameof(hat),
                hat,
                "The Switch Pro hat must be None or one of the eight octants."),
        };
    }
}
