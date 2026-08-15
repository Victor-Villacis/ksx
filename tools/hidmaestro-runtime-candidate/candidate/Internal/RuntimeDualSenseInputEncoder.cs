using System;
using System.Collections.Generic;

namespace HIDMaestro.Internal;

internal sealed class RuntimeDualSenseInputEncoder
{
    // Source-only binding to tools/hidmaestro-input-contract/{contract.json,
    // golden-vectors.json}. Its nine scenarios / 37 frames remain an
    // unexecuted artifact behavior gate in S1.5d; this source freeze performs
    // no compile, assembly load, driver action, or device action.
    internal const byte ReportId = 0x01;
    internal const int EncodedReportSize = 64;

    internal void Encode(in HMGamepadState state, Span<byte> destination)
    {
        if (destination.Length != EncodedReportSize)
        {
            throw new ArgumentException(
                $"The DualSense report destination must be exactly {EncodedReportSize} bytes.",
                nameof(destination));
        }

        // The pinned USB profile takes the legacy descriptor-builder path.
        // Every call is a complete frame; no vendor byte, sequence, or prior
        // report state is retained.
        destination.Clear();
        destination[0] = ReportId;

        Dictionary<HMAxis, float>? axes = state.Axes;
        float x = GetNormalizedAxis(axes, HMAxis.X);
        float y = GetNormalizedAxis(axes, HMAxis.Y);
        float z = GetNormalizedAxis(axes, HMAxis.Z);
        float rz = GetNormalizedAxis(axes, HMAxis.Rz);
        float rx = GetNormalizedAxis(axes, HMAxis.Rx);
        float ry = GetNormalizedAxis(axes, HMAxis.Ry);

        destination[1] = ScaleAxis(x);
        destination[2] = ScaleAxis(y);
        destination[3] = ScaleAxis(z);
        destination[4] = ScaleAxis(rz);
        destination[5] = ScaleAxis(rx);
        destination[6] = ScaleAxis(ry);

        destination[8] = EncodeHat(state.Hat);
        uint buttons = (uint)state.Buttons;
        SetButton(buttons, HMButton.X, destination, wireByte: 8, mask: 0x10);
        SetButton(buttons, HMButton.A, destination, wireByte: 8, mask: 0x20);
        SetButton(buttons, HMButton.B, destination, wireByte: 8, mask: 0x40);
        SetButton(buttons, HMButton.Y, destination, wireByte: 8, mask: 0x80);

        SetButton(buttons, HMButton.LeftBumper, destination, wireByte: 9, mask: 0x01);
        SetButton(buttons, HMButton.RightBumper, destination, wireByte: 9, mask: 0x02);
        if (rx > 0.0f)
        {
            destination[9] |= 0x04;
        }

        if (ry > 0.0f)
        {
            destination[9] |= 0x08;
        }

        SetButton(buttons, HMButton.Back, destination, wireByte: 9, mask: 0x10);
        SetButton(buttons, HMButton.Start, destination, wireByte: 9, mask: 0x20);
        SetButton(buttons, HMButton.LeftStick, destination, wireByte: 9, mask: 0x40);
        SetButton(buttons, HMButton.RightStick, destination, wireByte: 9, mask: 0x80);

        SetButton(buttons, HMButton.Guide, destination, wireByte: 10, mask: 0x01);
        SetButton(buttons, HMButton.Touchpad, destination, wireByte: 10, mask: 0x02);
        SetButton(buttons, HMButton.Misc1, destination, wireByte: 10, mask: 0x04);
    }

    private static float GetNormalizedAxis(
        Dictionary<HMAxis, float>? axes,
        HMAxis axis)
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
                $"DualSense axis {axis} must be finite.");
        }

        return Math.Clamp(value, 0.0f, 1.0f);
    }

    private static byte ScaleAxis(float normalized)
    {
        return (byte)(int)Math.Truncate((double)normalized * 255.0);
    }

    private static byte EncodeHat(HMHat hat)
    {
        return hat switch
        {
            HMHat.None => (byte)8,
            HMHat.North => (byte)0,
            HMHat.NorthEast => (byte)1,
            HMHat.East => (byte)2,
            HMHat.SouthEast => (byte)3,
            HMHat.South => (byte)4,
            HMHat.SouthWest => (byte)5,
            HMHat.West => (byte)6,
            HMHat.NorthWest => (byte)7,
            _ => throw new ArgumentOutOfRangeException(
                nameof(hat),
                hat,
                "The DualSense hat must be None or one of the eight octants."),
        };
    }

    private static void SetButton(
        uint buttons,
        HMButton button,
        Span<byte> destination,
        int wireByte,
        byte mask)
    {
        if ((buttons & (uint)button) != 0)
        {
            destination[wireByte] |= mask;
        }
    }
}
