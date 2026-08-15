using System;

namespace HIDMaestro.Internal;

internal enum RawDualSenseRejectReason
{
    Source,
    ReportId,
    Length,
}

internal enum RawDualSenseDisposition
{
    ApplyLegacy,
    ApplyV2,
    StopLegacy,
    StopV2,
    StopAllZero,
    PreserveNoMotorValidity,
    PreserveSelectorOnly,
    PreserveMissingSelector,
    PreserveConflictingVariants,
}

internal readonly struct RawDualSenseFeedbackSnapshot
{
    internal RawDualSenseFeedbackSnapshot(byte largeMotor, byte smallMotor, uint sourceSeqNo)
    {
        LargeMotor = largeMotor;
        SmallMotor = smallMotor;
        SourceSeqNo = sourceSeqNo;
    }

    internal byte LargeMotor { get; }

    internal byte SmallMotor { get; }

    internal uint SourceSeqNo { get; }
}

internal readonly struct RawDualSenseFeedbackResult
{
    private RawDualSenseFeedbackResult(
        bool hasSnapshot,
        RawDualSenseRejectReason rejectReason,
        RawDualSenseDisposition disposition,
        RawDualSenseFeedbackSnapshot snapshot)
    {
        HasSnapshot = hasSnapshot;
        RejectReason = rejectReason;
        Disposition = disposition;
        Snapshot = snapshot;
    }

    internal bool HasSnapshot { get; }

    internal RawDualSenseRejectReason RejectReason { get; }

    internal RawDualSenseDisposition Disposition { get; }

    internal RawDualSenseFeedbackSnapshot Snapshot { get; }

    internal static RawDualSenseFeedbackResult Rejected(RawDualSenseRejectReason reason)
    {
        return new RawDualSenseFeedbackResult(
            hasSnapshot: false,
            rejectReason: reason,
            disposition: default,
            snapshot: default);
    }

    internal static RawDualSenseFeedbackResult Accepted(
        RawDualSenseDisposition disposition,
        RawDualSenseFeedbackSnapshot snapshot)
    {
        return new RawDualSenseFeedbackResult(
            hasSnapshot: true,
            rejectReason: default,
            disposition: disposition,
            snapshot: snapshot);
    }
}

internal sealed class RawDualSenseFeedbackAdapter
{
    internal const int OutputDataLength = 47;
    internal const byte OutputReportId = 0x02;

    internal const int ValidFlag0Offset = 0;
    internal const int RightSmallMotorOffset = 2;
    internal const int LeftLargeMotorOffset = 3;
    internal const int ValidFlag2Offset = 38;

    internal const byte CompatibleVibrationMask = 0x01;
    internal const byte HapticsSelectMask = 0x02;
    internal const byte CompatibleVibrationV2Mask = 0x04;

    private readonly object _gate = new();
    private byte _largeMotor;
    private byte _smallMotor;

    internal RawDualSenseFeedbackAdapter(byte initialLargeMotor = 0, byte initialSmallMotor = 0)
    {
        _largeMotor = initialLargeMotor;
        _smallMotor = initialSmallMotor;
    }

    internal RawDualSenseFeedbackResult Apply(in HMOutputPacket packet)
    {
        lock (_gate)
        {
            if (packet.Source != HMOutputSource.HidOutput)
            {
                return RawDualSenseFeedbackResult.Rejected(RawDualSenseRejectReason.Source);
            }

            if (packet.ReportId != OutputReportId)
            {
                return RawDualSenseFeedbackResult.Rejected(RawDualSenseRejectReason.ReportId);
            }

            if (packet.Data.Length != OutputDataLength)
            {
                return RawDualSenseFeedbackResult.Rejected(RawDualSenseRejectReason.Length);
            }

            ReadOnlySpan<byte> data = packet.Data.Span;
            RawDualSenseDisposition disposition;
            if (IsAllZero(data))
            {
                _largeMotor = 0;
                _smallMotor = 0;
                disposition = RawDualSenseDisposition.StopAllZero;
            }
            else
            {
                byte valid0 = data[ValidFlag0Offset];
                byte valid2 = data[ValidFlag2Offset];
                bool legacy = (valid0 & CompatibleVibrationMask) != 0;
                bool selector = (valid0 & HapticsSelectMask) != 0;
                bool v2 = (valid2 & CompatibleVibrationV2Mask) != 0;

                if (selector && legacy && !v2)
                {
                    disposition = ApplyMotorBytes(data, v2: false);
                }
                else if (selector && !legacy && v2)
                {
                    disposition = ApplyMotorBytes(data, v2: true);
                }
                else if (legacy && v2)
                {
                    disposition = RawDualSenseDisposition.PreserveConflictingVariants;
                }
                else if (selector)
                {
                    disposition = RawDualSenseDisposition.PreserveSelectorOnly;
                }
                else if (legacy || v2)
                {
                    disposition = RawDualSenseDisposition.PreserveMissingSelector;
                }
                else
                {
                    disposition = RawDualSenseDisposition.PreserveNoMotorValidity;
                }
            }

            return RawDualSenseFeedbackResult.Accepted(
                disposition,
                new RawDualSenseFeedbackSnapshot(_largeMotor, _smallMotor, packet.SeqNo));
        }
    }

    private static bool IsAllZero(ReadOnlySpan<byte> data)
    {
        for (int index = 0; index < data.Length; index++)
        {
            if (data[index] != 0)
            {
                return false;
            }
        }

        return true;
    }

    private RawDualSenseDisposition ApplyMotorBytes(ReadOnlySpan<byte> data, bool v2)
    {
        _smallMotor = data[RightSmallMotorOffset];
        _largeMotor = data[LeftLargeMotorOffset];
        bool stopped = _largeMotor == 0 && _smallMotor == 0;

        if (v2)
        {
            return stopped ? RawDualSenseDisposition.StopV2 : RawDualSenseDisposition.ApplyV2;
        }

        return stopped ? RawDualSenseDisposition.StopLegacy : RawDualSenseDisposition.ApplyLegacy;
    }
}
