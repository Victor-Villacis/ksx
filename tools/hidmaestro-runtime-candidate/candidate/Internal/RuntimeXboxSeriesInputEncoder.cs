using System;
using System.Collections.Generic;

namespace HIDMaestro.Internal;

/// <summary>
/// Input report encoder for the pinned <c>xbox-series-xs-bt</c> catalog
/// profile (Microsoft, 045E:0B13, Bluetooth).
/// </summary>
/// <remarks>
/// <para>
/// Source-only binding to tools/hidmaestro-input-contract-xbox-series/{contract.json,
/// golden-vectors.json}. Its thirteen scenarios / 45 frames remain an
/// unexecuted artifact behavior gate in S1.5d; this source freeze performs no
/// compile, assembly load, driver action, or device action.
/// </para>
/// <para>
/// EVERY OFFSET BELOW IS READ OUT OF THE PROFILE'S OWN HID REPORT DESCRIPTOR.
/// Walking the pinned 262-byte descriptor yields exactly seventeen bytes with
/// no report ID:
/// </para>
/// <code>
///   byte  0..1   X            16 bits, logical 0..65535
///   byte  2..3   Y            16 bits, logical 0..65535
///   byte  4..5   Rx           16 bits, logical 0..65535
///   byte  6..7   Ry           16 bits, logical 0..65535
///   byte  8..9   Z            10 bits, logical 0..1023, then 6 bits padding
///   byte 10..11  Rz           10 bits, logical 0..1023, then 6 bits padding
///   byte 12..13  buttons 1..12, one bit each, then 4 bits padding
///   byte 14      hat switch    4 bits, logical 1..8, then 4 bits padding
///   byte 15      System Main Menu, 1 bit, then 7 bits padding
///   byte 16      Generic Device battery strength, 8 bits
/// </code>
/// <para>
/// THE TRAP THIS FILE EXISTS TO AVOID. <see cref="HMGamepadState.Axes"/> is
/// keyed by <see cref="HMAxis"/>, whose members are named after HID usages —
/// but the host does not populate them per-descriptor. It writes ONE fixed
/// physical assignment, and that assignment follows the DualSense descriptor
/// because DualSense was the first profile:
/// </para>
/// <code>
///   HMAxis.X  = left stick X      HMAxis.Y  = left stick Y
///   HMAxis.Z  = right stick X     HMAxis.Rz = right stick Y
///   HMAxis.Rx = LEFT TRIGGER      HMAxis.Ry = RIGHT TRIGGER
/// </code>
/// <para>
/// The Xbox descriptor assigns those same six letters differently: here
/// <c>Rx</c>/<c>Ry</c> are the right stick and <c>Z</c>/<c>Rz</c> are the
/// triggers. So an encoder that read <c>HMAxis.Rx</c> into the descriptor's
/// <c>Rx</c> field would put the LEFT TRIGGER where the right stick belongs and
/// the right stick where the triggers belong. Every read below is therefore by
/// PHYSICAL MEANING — the descriptor letter and the dictionary key deliberately
/// disagree on four of the six axes, and that disagreement is correct.
/// </para>
/// <para>
/// Two further consequences of the descriptor, both differing from the
/// DualSense encoder beside this file. There is no report ID, so byte zero is
/// the first axis rather than <c>0x01</c>, and nothing is stripped before the
/// endpoint sees it. And the descriptor's hat is logical <c>1..8</c> where
/// DualSense's is <c>0..7</c> with a null state of 8 — the two pads disagree on
/// every hat value, so each one is written out explicitly below rather than
/// cast from the enum, which would silently follow a renumbering of
/// <see cref="HMHat"/> straight onto the wire.
/// </para>
/// <para>
/// Button placement follows the profile's <c>buttonMap</c>
/// <c>[0,1,2,3,4,5,6,7,8,9,-1,-1,11]</c>, indexed by <see cref="HMButton"/> bit
/// position: ten buttons land in order, Guide and Touchpad are <c>-1</c>
/// because this pad carries neither as a plain button, and Share lands at
/// descriptor button index 11. Guide is reported through the separate System
/// Main Menu bit, exactly as the profile's note describes.
/// </para>
/// <para>
/// KNOWN PRECISION LIMIT, stated rather than hidden: the sticks are sixteen
/// bits wide here, but the state reaching this encoder has already been
/// quantised to eight by the shared host state mapper, whose byte round-trip
/// the frozen DualSense contract depends on. Widening that is a change to the
/// mapper and to DualSense's golden vectors, so it is deliberately not made
/// here. Scaling truncates rather than rounds for the same reason: the mapper
/// adds a documented quarter-unit bias chosen so that TRUNCATION round-trips
/// every byte, so rounding here would fight a bias that is already correct.
/// </para>
/// </remarks>
internal sealed class RuntimeXboxSeriesInputEncoder
{
    // The profile declares inputReportSize 17, and the descriptor walk agrees:
    // 136 input bits with no report ID.
    internal const int EncodedReportSize = 17;

    private const int ButtonCount = 12;

    /// <summary>
    /// Descriptor button index (zero-based) for each carried button, in the
    /// profile's own <c>buttonMap</c> order. Buttons the profile maps to
    /// <c>-1</c> are absent from this table rather than carried as sentinels.
    /// </summary>
    private static readonly (HMButton Button, int Index)[] ButtonMap =
    [
        (HMButton.A, 0),
        (HMButton.B, 1),
        (HMButton.X, 2),
        (HMButton.Y, 3),
        (HMButton.LeftBumper, 4),
        (HMButton.RightBumper, 5),
        (HMButton.Back, 6),
        (HMButton.Start, 7),
        (HMButton.LeftStick, 8),
        (HMButton.RightStick, 9),
        (HMButton.Share, 11),
    ];

    internal void Encode(in HMGamepadState state, Span<byte> destination)
    {
        if (destination.Length != EncodedReportSize)
        {
            throw new ArgumentException(
                $"The Xbox Series report destination must be exactly {EncodedReportSize} bytes.",
                nameof(destination));
        }

        // Every call is a complete frame: no vendor byte, no sequence counter,
        // and no carry-over from the previous report.
        destination.Clear();

        Dictionary<HMAxis, float>? axes = state.Axes;

        // Read by PHYSICAL MEANING, not by descriptor letter — see the remarks.
        float leftStickX = GetNormalizedAxis(axes, HMAxis.X);
        float leftStickY = GetNormalizedAxis(axes, HMAxis.Y);
        float rightStickX = GetNormalizedAxis(axes, HMAxis.Z);
        float rightStickY = GetNormalizedAxis(axes, HMAxis.Rz);
        float leftTrigger = GetNormalizedAxis(axes, HMAxis.Rx);
        float rightTrigger = GetNormalizedAxis(axes, HMAxis.Ry);

        WriteUInt16(destination, 0, leftStickX);
        WriteUInt16(destination, 2, leftStickY);
        WriteUInt16(destination, 4, rightStickX);
        WriteUInt16(destination, 6, rightStickY);

        // The two triggers are ten-bit fields, each starting on a byte
        // boundary with six bits of padding above them.
        WriteUInt10(destination, 8, leftTrigger);
        WriteUInt10(destination, 10, rightTrigger);

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
                    $"Xbox Series button {button} maps outside the descriptor's {ButtonCount} buttons.");
            }

            destination[12 + (index / 8)] |= (byte)(1 << (index % 8));
        }

        destination[14] = EncodeHat(state.Hat);

        if ((buttons & (uint)HMButton.Guide) != 0)
        {
            // Guide is not a button on this pad: the descriptor carries it as
            // Generic Desktop "System Main Menu" in its own byte.
            destination[15] |= 0x01;
        }
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
                $"Xbox Series axis {axis} must be finite.");
        }

        return Math.Clamp(value, 0.0f, 1.0f);
    }

    private static void WriteUInt16(Span<byte> destination, int offset, float normalized)
    {
        ushort scaled = (ushort)ScaleAxis(normalized, ushort.MaxValue);
        destination[offset] = (byte)(scaled & 0xFF);
        destination[offset + 1] = (byte)(scaled >> 8);
    }

    private static void WriteUInt10(Span<byte> destination, int offset, float normalized)
    {
        ushort scaled = (ushort)ScaleAxis(normalized, 1023);
        destination[offset] = (byte)(scaled & 0xFF);
        destination[offset + 1] = (byte)((scaled >> 8) & 0x03);
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
    /// Each hat value is written out explicitly. This descriptor's logical
    /// range is 1..8 with the centred hat falling outside it at 0, which is a
    /// different mapping from DualSense's 0..7 plus null-state 8 — so the wire
    /// value is stated per octant and never cast from the enum.
    /// </summary>
    private static byte EncodeHat(HMHat hat)
    {
        return hat switch
        {
            HMHat.None => (byte)0,
            HMHat.North => (byte)1,
            HMHat.NorthEast => (byte)2,
            HMHat.East => (byte)3,
            HMHat.SouthEast => (byte)4,
            HMHat.South => (byte)5,
            HMHat.SouthWest => (byte)6,
            HMHat.West => (byte)7,
            HMHat.NorthWest => (byte)8,
            _ => throw new ArgumentOutOfRangeException(
                nameof(hat),
                hat,
                "The Xbox Series hat must be None or one of the eight octants."),
        };
    }
}
