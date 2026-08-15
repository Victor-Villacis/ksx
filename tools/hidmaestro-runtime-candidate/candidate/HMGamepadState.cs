using System;
using System.Collections.Generic;

namespace HIDMaestro;

public struct HMGamepadState
{
    public Dictionary<HMAxis, float>? Axes;
    public HMButton Buttons;
    public HMHat Hat;
}

public enum HMAxis : ushort
{
    None = 0,
    X = 0x0130,
    Y = 0x0131,
    Z = 0x0132,
    Rx = 0x0133,
    Ry = 0x0134,
    Rz = 0x0135,
    Slider = 0x0136,
    Dial = 0x0137,
    Wheel = 0x0138,
    Hat = 0x0139,
    Vx = 0x0140,
    Vy = 0x0141,
    Vz = 0x0142,
    Vbrx = 0x0143,
    Vbry = 0x0144,
    Vbrz = 0x0145,
    Vno = 0x0146,
    Aileron = 0x02B0,
    AileronTrim = 0x02B1,
    AntiTorque = 0x02B2,
    CollectiveControl = 0x02B5,
    DiveBrake = 0x02B6,
    Elevator = 0x02B8,
    ElevatorTrim = 0x02B9,
    Rudder = 0x02BA,
    Throttle = 0x02BB,
    LandingGear = 0x02BE,
    ToeBrake = 0x02BF,
    WingFlaps = 0x02C3,
    Accelerator = 0x02C4,
    Brake = 0x02C5,
    Clutch = 0x02C6,
    Shifter = 0x02C7,
    Steering = 0x02C8,
    TurretDirection = 0x02C9,
    BarrelElevation = 0x02CA,
    DivePlane = 0x02CB,
    Ballast = 0x02CC,
    BicycleCrank = 0x02CD,
    HandleBars = 0x02CE,
    FrontBrake = 0x02CF,
    RearBrake = 0x02D0,
}

[Flags]
public enum HMButton : uint
{
    None = 0,
    A = 1u << 0,
    B = 1u << 1,
    X = 1u << 2,
    Y = 1u << 3,
    LeftBumper = 1u << 4,
    RightBumper = 1u << 5,
    Back = 1u << 6,
    Start = 1u << 7,
    LeftStick = 1u << 8,
    RightStick = 1u << 9,
    Guide = 1u << 10,
    Touchpad = 1u << 11,
    Share = 1u << 12,
    RightPaddle = 1u << 13,
    LeftPaddle = 1u << 14,
    Misc1 = 1u << 15,
    RightPaddle2 = 1u << 16,
    LeftPaddle2 = 1u << 17,
    Cross = A,
    Circle = B,
    Square = X,
    Triangle = Y,
}

public enum HMHat : byte
{
    None = 0,
    North = 1,
    NorthEast = 2,
    East = 3,
    SouthEast = 4,
    South = 5,
    SouthWest = 6,
    West = 7,
    NorthWest = 8,
}
