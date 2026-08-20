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
/// BUTTONS DIVERGE PER LANE, deliberately. For descriptor-lane profiles with
/// layout metadata (Xbox Series, DualSense), semantic <see cref="HMButton"/>
/// flags are correct: the SDK's report builder maps them through the profile's
/// <c>buttonMap</c>. For the Switch protocol lane, upstream's packer indexes
/// the raw mask by the profile's LAYOUT BUTTON INDICES — feeding semantic
/// flags there lands Back on ZL (measured 2026-08-20), so this mapper builds a
/// layout-indexed mask for Switch.
/// </para>
/// <para>
/// The RETRO profiles (iBuffalo SNES, DaemonBite Genesis) carry NO layout
/// metadata at all — bare descriptors — and the builder's no-ButtonMap
/// fallback is IDENTITY (semantic bit b → descriptor button b, measured in
/// `HidReportBuilder.cs`). So this mapper emits DESCRIPTOR-ORDERED masks for
/// them: each bit position is the pad's own descriptor button index. The
/// bit→physical-label assignments below are PROVISIONAL (drawn from the
/// widely-published SDL/RetroArch mappings for these exact identities) until
/// the pads' supervised hardware leg adjudicates them in joy.cpl; what this
/// mapper guarantees regardless is that every ksx control lands on a DISTINCT,
/// STABLE descriptor button.
/// </para>
/// </remarks>
internal sealed class SdkStateMapper
{
    private enum Kind
    {
        /// <summary>Layout-carrying descriptor profile — semantic flags.</summary>
        Descriptor,
        /// <summary>The Switch protocol lane — layout-indexed mask.</summary>
        SwitchProtocol,
        /// <summary>iBuffalo Classic USB Gamepad (0583:2060): 3-byte report,
        /// X/Y axes + 8 buttons, no hat.</summary>
        IBuffaloSnes,
        /// <summary>DaemonBite Genesis/Saturn adapter (2341:8036): 9 buttons +
        /// signed −1..1 X/Y, no hat.</summary>
        DaemonBiteGenesis,
    }

    private readonly Kind _kind;
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
        _kind = (profile.VendorId, profile.ProductId) switch
        {
            (0x057E, 0x2009) => Kind.SwitchProtocol,
            (0x0583, 0x2060) => Kind.IBuffaloSnes,
            (0x2341, 0x8036) => Kind.DaemonBiteGenesis,
            _ => Kind.Descriptor,
        };

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
        return _kind switch
        {
            Kind.IBuffaloSnes => MapIBuffalo(in input),
            Kind.DaemonBiteGenesis => MapDaemonBite(in input),
            _ => MapModern(in input),
        };
    }

    private HMGamepadState MapModern(in KsxPadState input)
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
            Buttons = _kind == Kind.SwitchProtocol
                ? SwitchLayoutMask(input)
                : SemanticButtons(input.Buttons),
            Hat = Hat(input.Buttons),
            Axes = _axes,
        };
    }

    /// <summary>
    /// iBuffalo SNES: X/Y byte axes carry the D-pad (with the left stick as a
    /// keyboard-couch alias when the D-pad is centred), and the 8 descriptor
    /// buttons are driven positionally — ksx A is the bottom button, which is
    /// SNES B, exactly the positional rule the Switch lane uses.
    /// PROVISIONAL bit order (the pad's decade-old SDL mapping:
    /// b0=B b1=A b2=Y b3=X b4=L b5=R b6=Select b7=Start), adjudicated on
    /// hardware.
    /// </summary>
    private HMGamepadState MapIBuffalo(in KsxPadState input)
    {
        _axes.Clear();
        WriteDpadOrStickAxes(in input, half: 0.5f);

        uint mask = 0;
        KsxButtons pressed = input.Buttons;
        void Set(KsxButtons source, int bit)
        {
            if ((pressed & source) != 0)
            {
                mask |= 1u << bit;
            }
        }

        Set(KsxButtons.A, 0); // bottom → SNES B
        Set(KsxButtons.B, 1); // right  → SNES A
        Set(KsxButtons.X, 2); // left   → SNES Y
        Set(KsxButtons.Y, 3); // top    → SNES X
        Set(KsxButtons.LeftBumper, 4); // L
        Set(KsxButtons.RightBumper, 5); // R
        Set(KsxButtons.Back, 6); // Select
        Set(KsxButtons.Start, 7); // Start
        // Triggers, stick clicks and Guide have no home on an 8-button pad
        // and are deliberately dropped.

        return new HMGamepadState
        {
            Buttons = (HMButton)mask,
            Hat = HMHat.None,
            Axes = _axes,
        };
    }

    /// <summary>
    /// DaemonBite Genesis/Saturn: signed −1..1 X/Y axes carry the D-pad, and
    /// the 9 descriptor buttons take the six-button fighting layout — ksx's
    /// face-plus-bumper six map onto Genesis A/B/C (bottom row) and X/Y/Z
    /// (top row). PROVISIONAL bit order (the adapter firmware's declared
    /// order: b0=A b1=B b2=C b3=X b4=Y b5=Z b6=Start b7=Mode b8=Home),
    /// adjudicated on hardware.
    /// </summary>
    private HMGamepadState MapDaemonBite(in KsxPadState input)
    {
        _axes.Clear();
        WriteDpadOrStickAxes(in input, half: 0.5f);

        uint mask = 0;
        KsxButtons pressed = input.Buttons;
        void Set(KsxButtons source, int bit)
        {
            if ((pressed & source) != 0)
            {
                mask |= 1u << bit;
            }
        }

        Set(KsxButtons.X, 0); // Genesis A (bottom-left)
        Set(KsxButtons.A, 1); // Genesis B (bottom-centre)
        Set(KsxButtons.B, 2); // Genesis C (bottom-right)
        Set(KsxButtons.Y, 3); // Genesis X (top-left)
        Set(KsxButtons.LeftBumper, 4); // Genesis Y (top-centre)
        Set(KsxButtons.RightBumper, 5); // Genesis Z (top-right)
        Set(KsxButtons.Start, 6); // Start
        Set(KsxButtons.Back, 7); // Mode
        Set(KsxButtons.Guide, 8); // Home (the adapter's ninth button)

        return new HMGamepadState
        {
            Buttons = (HMButton)mask,
            Hat = HMHat.None,
            Axes = _axes,
        };
    }

    /// <summary>
    /// Retro pads carry the D-pad on their X/Y axes: the D-pad wins when
    /// pressed, else the left stick drives the same axes so keyboard-couch
    /// bindings work unchanged. `half` is the builder's float centre (it
    /// scales 0..1 across each descriptor's own logical range, so 0.5 is the
    /// centre for both the 0..255 and the −1..1 pads).
    /// </summary>
    private void WriteDpadOrStickAxes(in KsxPadState input, float half)
    {
        KsxButtons b = input.Buttons;
        bool left = (b & KsxButtons.DpadLeft) != 0;
        bool right = (b & KsxButtons.DpadRight) != 0;
        bool up = (b & KsxButtons.DpadUp) != 0;
        bool down = (b & KsxButtons.DpadDown) != 0;

        float x = (left, right) switch
        {
            (true, false) => 0f,
            (false, true) => 1f,
            _ => half,
        };
        float y = (up, down) switch
        {
            (true, false) => 0f,
            (false, true) => 1f,
            _ => half,
        };
        if (!left && !right && input.LeftX != 0)
        {
            x = Axis(input.LeftX, invert: false);
        }

        if (!up && !down && input.LeftY != 0)
        {
            y = Axis(input.LeftY, invert: true);
        }

        _axes[HMAxis.X] = x;
        _axes[HMAxis.Y] = y;
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
