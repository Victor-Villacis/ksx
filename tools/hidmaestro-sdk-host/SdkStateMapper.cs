using HIDMaestro;
using Ksx.HidMaestroProbe;

namespace Ksx.HidMaestroSdkHost;

/// <summary>
/// Per-profile state mapping for the SDK lane.
/// </summary>
/// <remarks>
/// <para>
/// Unlike the candidate host's fixed DualSense-shaped assignment, this mapper
/// resolves the stick and trigger axis keys from the profile's own simple view
/// (<c>HMProfile.Sticks</c> / <c>Triggers</c>) once at bind time — the same
/// pattern PadForge uses, and the reason its callers can pass XInput-convention
/// values for every profile without knowing descriptor letters.
/// </para>
/// <para>
/// BUTTONS DIVERGE PER LANE, deliberately. For descriptor-lane profiles
/// (Xbox Series), semantic <see cref="HMButton"/> flags are correct: the SDK's
/// report builder maps them through the profile's <c>buttonMap</c>. For the
/// Switch protocol lane, upstream's packer indexes the raw mask by the
/// profile's LAYOUT BUTTON INDICES — feeding semantic flags there lands Back
/// on ZL and the stick clicks on Minus/Plus (measured 2026-08-20, and visible
/// in PadForge's own unconditional semantic mapping). This mapper therefore
/// builds a layout-indexed mask for Switch, so the wire is right even where
/// upstream's own caller is skewed. Final adjudication belongs to hardware;
/// `docs/HIDMAESTRO-STATE.md` carries the question.
/// </para>
/// </remarks>
internal sealed class SdkStateMapper
{
    private readonly bool _switchProtocol;
    private readonly HMAxis _leftStickX;
    private readonly HMAxis _leftStickY;
    private readonly HMAxis _rightStickX;
    private readonly HMAxis _rightStickY;
    private readonly HMAxis _leftTrigger;
    private readonly HMAxis _rightTrigger;

    // Reused across frames; the SDK consumes the dictionary by key lookup and
    // tolerates a reused reference (PadForge relies on the same property).
    private readonly Dictionary<HMAxis, float> _axes = new();

    internal SdkStateMapper(HMProfile profile)
    {
        _switchProtocol = profile.VendorId == 0x057E && profile.ProductId == 0x2009;

        IReadOnlyList<HMSimpleStick> sticks = profile.Sticks;
        if (sticks.Count > 0)
        {
            _leftStickX = sticks[0].XAxis;
            _leftStickY = sticks[0].YAxis;
        }

        if (sticks.Count > 1)
        {
            _rightStickX = sticks[1].XAxis;
            _rightStickY = sticks[1].YAxis;
        }

        IReadOnlyList<HMSimpleTrigger> triggers = profile.Triggers;
        if (triggers.Count > 0)
        {
            _leftTrigger = triggers[0].Axis;
        }

        if (triggers.Count > 1)
        {
            _rightTrigger = triggers[1].Axis;
        }
    }

    internal HMGamepadState Map(in KsxPadState input)
    {
        _axes.Clear();
        WriteAxis(_leftStickX, Axis(input.LeftX, invert: false));
        WriteAxis(_leftStickY, Axis(input.LeftY, invert: true));
        WriteAxis(_rightStickX, Axis(input.RightX, invert: false));
        WriteAxis(_rightStickY, Axis(input.RightY, invert: true));
        WriteAxis(_leftTrigger, ByteValue(input.LeftTrigger));
        WriteAxis(_rightTrigger, ByteValue(input.RightTrigger));

        return new HMGamepadState
        {
            Buttons = _switchProtocol
                ? SwitchLayoutMask(input)
                : SemanticButtons(input.Buttons),
            Hat = Hat(input.Buttons),
            Axes = _axes,
        };
    }

    private void WriteAxis(HMAxis axis, float value)
    {
        if (axis != HMAxis.None)
        {
            _axes[axis] = value;
        }
    }

    private static HMButton SemanticButtons(KsxButtons input)
    {
        HMButton buttons = HMButton.None;
        Map(input, KsxButtons.A, HMButton.A, ref buttons);
        Map(input, KsxButtons.B, HMButton.B, ref buttons);
        Map(input, KsxButtons.X, HMButton.X, ref buttons);
        Map(input, KsxButtons.Y, HMButton.Y, ref buttons);
        Map(input, KsxButtons.LeftBumper, HMButton.LeftBumper, ref buttons);
        Map(input, KsxButtons.RightBumper, HMButton.RightBumper, ref buttons);
        Map(input, KsxButtons.Back, HMButton.Back, ref buttons);
        Map(input, KsxButtons.Start, HMButton.Start, ref buttons);
        Map(input, KsxButtons.LeftThumb, HMButton.LeftStick, ref buttons);
        Map(input, KsxButtons.RightThumb, HMButton.RightStick, ref buttons);
        Map(input, KsxButtons.Guide, HMButton.Guide, ref buttons);
        return buttons;
    }

    /// <summary>
    /// Layout-indexed mask for the Switch protocol lane, per
    /// switch-pro.json's own layout: 0=B 1=A 2=Y 3=X 4=L 5=R 6=ZL 7=ZR
    /// 8=Minus 9=Plus 10=LStick 11=RStick 12=Home 13=Capture. Faces are
    /// positional (ksx A is the bottom button, Nintendo's B position), the
    /// system cluster is semantic (Back means Minus), and ZL/ZR are digital —
    /// derived from the trigger bytes, since this pad has no analog triggers.
    /// </summary>
    private static HMButton SwitchLayoutMask(in KsxPadState input)
    {
        uint mask = 0;
        KsxButtons pressed = input.Buttons;
        void Set(KsxButtons source, int layoutIndex)
        {
            if ((pressed & source) != 0)
            {
                mask |= 1u << layoutIndex;
            }
        }

        Set(KsxButtons.A, 0);
        Set(KsxButtons.B, 1);
        Set(KsxButtons.X, 2);
        Set(KsxButtons.Y, 3);
        Set(KsxButtons.LeftBumper, 4);
        Set(KsxButtons.RightBumper, 5);
        Set(KsxButtons.Back, 8);
        Set(KsxButtons.Start, 9);
        Set(KsxButtons.LeftThumb, 10);
        Set(KsxButtons.RightThumb, 11);
        Set(KsxButtons.Guide, 12);
        if (input.LeftTrigger > 0)
        {
            mask |= 1u << 6;
        }

        if (input.RightTrigger > 0)
        {
            mask |= 1u << 7;
        }

        return (HMButton)mask;
    }

    private static void Map(KsxButtons actual, KsxButtons source, HMButton target, ref HMButton output)
    {
        if ((actual & source) != 0)
        {
            output |= target;
        }
    }

    // Identical conversions to the candidate host's StateMapper, kept
    // byte-for-byte so a slot moved between lanes feels the same.
    private static float Axis(short value, bool invert)
    {
        int sample = invert ? -Math.Clamp((int)value, -32767, 32767) : value;
        byte wire = (byte)(((long)sample + 32768L) * 255L / 65535L);
        return ByteValue(wire);
    }

    private static float ByteValue(byte value) => value == 255 ? 1f : (value + 0.25f) / 255f;

    private static HMHat Hat(KsxButtons buttons)
    {
        bool up = (buttons & KsxButtons.DpadUp) != 0;
        bool down = (buttons & KsxButtons.DpadDown) != 0;
        bool left = (buttons & KsxButtons.DpadLeft) != 0;
        bool right = (buttons & KsxButtons.DpadRight) != 0;
        if (up && down)
        {
            up = down = false;
        }

        if (left && right)
        {
            left = right = false;
        }

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
