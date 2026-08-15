using HIDMaestro;
using Ksx.HidMaestroProbe;

namespace Ksx.HidMaestroHost;

internal static class StateMapper
{
    internal static HMGamepadState Map(in KsxPadState input)
    {
        HMButton buttons = HMButton.None;
        Map(input.Buttons, KsxButtons.A, HMButton.A, ref buttons);
        Map(input.Buttons, KsxButtons.B, HMButton.B, ref buttons);
        Map(input.Buttons, KsxButtons.X, HMButton.X, ref buttons);
        Map(input.Buttons, KsxButtons.Y, HMButton.Y, ref buttons);
        Map(input.Buttons, KsxButtons.LeftBumper, HMButton.LeftBumper, ref buttons);
        Map(input.Buttons, KsxButtons.RightBumper, HMButton.RightBumper, ref buttons);
        Map(input.Buttons, KsxButtons.Back, HMButton.Back, ref buttons);
        Map(input.Buttons, KsxButtons.Start, HMButton.Start, ref buttons);
        Map(input.Buttons, KsxButtons.LeftThumb, HMButton.LeftStick, ref buttons);
        Map(input.Buttons, KsxButtons.RightThumb, HMButton.RightStick, ref buttons);
        Map(input.Buttons, KsxButtons.Guide, HMButton.Guide, ref buttons);

        return new HMGamepadState
        {
            Buttons = buttons,
            Hat = Hat(input.Buttons),
            Axes = new Dictionary<HMAxis, float>
            {
                [HMAxis.X] = Axis(input.LeftX, invert: false),
                [HMAxis.Y] = Axis(input.LeftY, invert: true),
                [HMAxis.Z] = Axis(input.RightX, invert: false),
                [HMAxis.Rz] = Axis(input.RightY, invert: true),
                [HMAxis.Rx] = Byte(input.LeftTrigger),
                [HMAxis.Ry] = Byte(input.RightTrigger),
            },
        };
    }

    private static void Map(KsxButtons actual, KsxButtons source, HMButton target, ref HMButton output)
    {
        if ((actual & source) != 0) output |= target;
    }

    private static float Axis(short value, bool invert)
    {
        int sample = invert ? -Math.Clamp((int)value, -32767, 32767) : value;
        byte wire = (byte)(((long)sample + 32768L) * 255L / 65535L);
        return Byte(wire);
    }

    // The candidate encoder truncates normalized*255. A quarter-unit bias
    // round-trips every byte except 255, which is represented exactly by 1.0.
    private static float Byte(byte value) => value == 255 ? 1f : (value + 0.25f) / 255f;

    private static HMHat Hat(KsxButtons buttons)
    {
        bool up = (buttons & KsxButtons.DpadUp) != 0;
        bool down = (buttons & KsxButtons.DpadDown) != 0;
        bool left = (buttons & KsxButtons.DpadLeft) != 0;
        bool right = (buttons & KsxButtons.DpadRight) != 0;
        if (up && down) up = down = false;
        if (left && right) left = right = false;
        return (up, down, left, right) switch
        {
            (true, false, false, false) => HMHat.North,
            (true, false, false, true) => HMHat.NorthEast,
            (false, false, false, true) => HMHat.East,
            (false, true, false, true) => HMHat.SouthEast,
            (false, true, false, false) => HMHat.South,
            (false, true, true, false) => HMHat.SouthWest,
            (false, false, true, false) => HMHat.West,
            (true, false, true, false) => HMHat.NorthWest,
            _ => HMHat.None,
        };
    }
}
