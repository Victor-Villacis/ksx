using System;
using System.Collections.Generic;

namespace HIDMaestro.Internal;

/// <summary>
/// Input body encoder for the pinned <c>switch-pro</c> catalog profile
/// (Nintendo, 057E:2009, Bluetooth): the 48-byte report-<c>0x30</c> BODY the
/// driver's 60 Hz streamer serves.
/// </summary>
/// <remarks>
/// <para>
/// Source-only binding to tools/hidmaestro-input-contract-switch-pro/{contract.json,
/// golden-vectors.json}. Its scenarios remain an unexecuted artifact behavior
/// gate in S1.5d; this source freeze performs no compile, assembly load,
/// driver action, or device action.
/// </para>
/// <para>
/// WHY A BODY AND NOT A REPORT. An earlier revision of this file encoded the
/// descriptor's 12-byte report <c>0x3F</c>, on the argument that only
/// <c>0x3F</c> is described field by field. That argument was true and
/// irrelevant: derivability was never the selection criterion — the driver
/// decides, and the driver's Switch lane never treats the shared section as a
/// report at all. Upstream's <c>HMController.SubmitState</c> early-returns
/// into <c>SwitchProPacker.BuildBody</c> for 057E:2009, submitting this
/// 48-byte body; <c>driver.c</c> reads <c>Data[2..10]</c> (buttons + packed
/// sticks) and, when IMU streaming is armed and <c>DataSize &gt;= 48</c>,
/// <c>Data[12..47]</c> — and builds the <c>0x3F</c> frame ITSELF pre-handshake
/// from that same state. An 11-byte <c>0x3F</c> slice passes the driver's
/// <c>DataSize &gt;= 11</c> guard and is silently misparsed as this body: a
/// centred no-button frame decodes as eight buttons held with both sticks
/// pinned past the rail. The lane, not the shape, was the defect.
/// </para>
/// <para>
/// BODY LAYOUT, from <c>SwitchProPacker</c> (grounded in SDL_hidapi_switch.c,
/// the client under test) and <c>driver.c</c>'s reader:
/// </para>
/// <code>
///   byte  0      frame counter   — driver overlays; leave zero
///   byte  1      battery/conn    — driver overlays; leave zero
///   byte  2      buttons, right: bit0=Y bit1=X bit2=B bit3=A bit6=R bit7=ZR
///   byte  3      buttons, shared: bit0=Minus bit1=Plus bit2=RStick click
///                bit3=LStick click bit4=Home bit5=Capture
///   byte  4      buttons, left: bit0=Down bit1=Up bit2=Right bit3=Left
///                bit6=L bit7=ZL
///   byte  5..7   left stick, two 12-bit values little-nibble packed
///   byte  8..10  right stick, same packing
///   byte 11      vibrator ack    — driver overlays; leave zero
///   byte 12..47  IMU, three 12-byte frames — zeroed: this candidate's
///                HMGamepadState carries no accelerometer or gyro state
/// </code>
/// <para>
/// BUTTONS ARE MAPPED BY SEMANTIC, AND THAT IS A DELIBERATE DIVERGENCE worth
/// stating precisely. Upstream's own caller hands <c>SwitchProPacker</c> the
/// raw <c>HMButton</c> bit mask, and the packer indexes that mask by the
/// profile's layout button indices — with the raw mask those two numbering
/// systems disagree above the bumpers, so upstream lands <c>HMButton.Back</c>
/// on ZL, <c>Start</c> on ZR, <c>LeftStick</c> on Minus, <c>RightStick</c> on
/// Plus, <c>Guide</c> on LStick and <c>Share</c> on Home. No upstream test or
/// document states whether the consumer was meant to pre-convert. THIS host's
/// state mapper populates <c>HMButton</c> semantically (Back means the select
/// button), so this encoder binds each semantic button to the wire position
/// SDL documents for it: Back→Minus, Start→Plus, stick clicks→stick clicks,
/// Guide→Home, Share→Capture, faces positional (A=bottom=Nintendo B).
/// </para>
/// <para>
/// STICKS: 12 bits per axis, little-nibble packed as
/// <c>b0 = x&amp;0xFF; b1 = (x&gt;&gt;8) | ((y&amp;0xF)&lt;&lt;4);
/// b2 = y&gt;&gt;4</c> — the exact inverse of SDL's extraction. Scale is
/// centre <c>0x800</c>, range <c>±0x600</c>, matching the fabricated factory
/// calibration the driver serves from SPI 0x603D; the wire is up-positive
/// while <c>HMAxis.Y</c>/<c>Rz</c> are HID-style down-positive, so Y negates
/// the centred value. A neutral stick packs to <c>00 08 80</c>, byte-identical
/// to the driver's own neutral prefill. Scaling truncates toward zero exactly
/// as the upstream packer does.
/// </para>
/// <para>
/// ZL and ZR are digital on this pad (the layout's <c>triggers</c> list is
/// empty), so the analog trigger axes become bits the moment they leave rest,
/// exactly as DualSense derives its L2/R2 bits. The d-pad is four bits, not a
/// hat field; <see cref="EncodeDpad"/> decomposes <see cref="HMHat"/> into
/// them. The handshake (0x80/0x01 request-reply, SPI calibration image) is
/// entirely the driver's; this encoder has no handshake duty.
/// </para>
/// <para>
/// THE AXIS TRAP, same as every persona here: the host state mapper populates
/// <c>HMAxis</c> with a DualSense-shaped assignment where <c>Z</c>/<c>Rz</c>
/// are the RIGHT STICK and <c>Rx</c>/<c>Ry</c> are the TRIGGERS. Every read
/// below is by physical meaning, not by descriptor letter.
/// </para>
/// </remarks>
internal sealed class RuntimeSwitchProInputEncoder
{
    // The 48-byte report-0x30 body. The driver frames and streams it as
    // report 0x30 itself (and synthesizes 0x3F pre-handshake); no report-ID
    // byte is part of this submission.
    internal const int EncodedReportSize = 48;

    /// <summary>
    /// Semantic wire map: each carried <see cref="HMButton"/>, the body byte
    /// it lands in, and its bit. Wire positions are SDL's
    /// <c>HandleFullControllerState</c> layout as documented by the upstream
    /// packer; the semantic pairing is this host's (see remarks).
    /// </summary>
    private static readonly (HMButton Button, int BodyByte, int Bit)[] ButtonMap =
    [
        (HMButton.A, 2, 2),
        (HMButton.B, 2, 3),
        (HMButton.X, 2, 0),
        (HMButton.Y, 2, 1),
        (HMButton.RightBumper, 2, 6),
        (HMButton.LeftBumper, 4, 6),
        (HMButton.Back, 3, 0),
        (HMButton.Start, 3, 1),
        (HMButton.RightStick, 3, 2),
        (HMButton.LeftStick, 3, 3),
        (HMButton.Guide, 3, 4),
        (HMButton.Share, 3, 5),
    ];

    internal void Encode(in HMGamepadState state, Span<byte> destination)
    {
        if (destination.Length != EncodedReportSize)
        {
            throw new ArgumentException(
                $"The Switch Pro body destination must be exactly {EncodedReportSize} bytes.",
                nameof(destination));
        }

        // Every call is a complete frame: no carry-over, and the counter,
        // battery and vibrator bytes stay zero for the driver's own overlay.
        destination.Clear();

        Dictionary<HMAxis, float>? axes = state.Axes;

        // Read by PHYSICAL MEANING, not by descriptor letter — see the remarks.
        float leftStickX = GetNormalizedAxis(axes, HMAxis.X);
        float leftStickY = GetNormalizedAxis(axes, HMAxis.Y);
        float rightStickX = GetNormalizedAxis(axes, HMAxis.Z);
        float rightStickY = GetNormalizedAxis(axes, HMAxis.Rz);
        float leftTrigger = GetNormalizedAxis(axes, HMAxis.Rx);
        float rightTrigger = GetNormalizedAxis(axes, HMAxis.Ry);

        uint buttons = (uint)state.Buttons;
        foreach ((HMButton button, int bodyByte, int bit) in ButtonMap)
        {
            if ((buttons & (uint)button) == 0)
            {
                continue;
            }

            destination[bodyByte] |= (byte)(1 << bit);
        }

        destination[4] |= EncodeDpad(state.Hat);

        // ZL and ZR are buttons on this pad, so the analog trigger axes become
        // bits the moment they leave rest.
        if (leftTrigger > 0.0f)
        {
            destination[4] |= 0x80;
        }

        if (rightTrigger > 0.0f)
        {
            destination[2] |= 0x80;
        }

        WriteStickX(destination, 5, leftStickX);
        WriteStickY(destination, 5, leftStickY);
        WriteStickX(destination, 8, rightStickX);
        WriteStickY(destination, 8, rightStickY);
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

    /// <summary>
    /// One 12-bit stick value: centre 0x800, range ±0x600 (the fabricated
    /// factory calibration the driver serves), truncating toward zero exactly
    /// as the upstream packer does. The wire is up-positive while the HID-style
    /// axis is down-positive, so Y negates the centred value.
    /// </summary>
    private static ushort StickRaw(float normalized, bool invert)
    {
        double centered = ((double)normalized * 2.0) - 1.0;
        if (invert)
        {
            centered = -centered;
        }

        int raw = 0x800 + (int)(centered * 0x600);
        return (ushort)Math.Clamp(raw, 0, 0xFFF);
    }

    /// <summary>Low half of the little-nibble pair: the axis byte and the low
    /// nibble of the shared middle byte.</summary>
    private static void WriteStickX(Span<byte> destination, int offset, float normalized)
    {
        ushort raw = StickRaw(normalized, invert: false);
        destination[offset] = (byte)(raw & 0xFF);
        destination[offset + 1] |= (byte)((raw >> 8) & 0x0F);
    }

    /// <summary>High half of the pair: the high nibble of the shared middle
    /// byte and the top byte. Carries the wire's Y inversion.</summary>
    private static void WriteStickY(Span<byte> destination, int offset, float normalized)
    {
        ushort raw = StickRaw(normalized, invert: true);
        destination[offset + 1] |= (byte)((raw & 0x0F) << 4);
        destination[offset + 2] = (byte)(raw >> 4);
    }

    /// <summary>
    /// The d-pad is four plain bits in the left button byte (bit0=Down bit1=Up
    /// bit2=Right bit3=Left), not a hat field, so each octant decomposes into
    /// its bit pair. Values are written out explicitly — a renumbering of
    /// <see cref="HMHat"/> must fail here, never reach the wire.
    /// </summary>
    private static byte EncodeDpad(HMHat hat)
    {
        return hat switch
        {
            HMHat.None => (byte)0,
            HMHat.North => (byte)2,
            HMHat.NorthEast => (byte)6,
            HMHat.East => (byte)4,
            HMHat.SouthEast => (byte)5,
            HMHat.South => (byte)1,
            HMHat.SouthWest => (byte)9,
            HMHat.West => (byte)8,
            HMHat.NorthWest => (byte)10,
            _ => throw new ArgumentOutOfRangeException(
                nameof(hat),
                hat,
                "The Switch Pro d-pad must be None or one of the eight octants."),
        };
    }
}
