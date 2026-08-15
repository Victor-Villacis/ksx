//! Source-pinned plain-USB DualSense `HMController.OutputReceived` reduction.
//!
//! This file is also compiled directly by the standalone S1.5c golden-vector
//! harness. Keep it dependency-free: it is the single implementation shared by
//! the product crate and that contract, not an independently copied model.

/// `HMOutputSource.HidOutput` in HIDMaestro v1.6.1.
pub const HID_OUTPUT_SOURCE: u8 = 0;
/// Plain-USB DualSense output report ID.
pub const DUALSENSE_USB_OUTPUT_REPORT_ID: u8 = 0x02;
/// Payload bytes after HIDMaestro separates the report-ID byte.
pub const DUALSENSE_USB_OUTPUT_DATA_LEN: usize = 47;

pub const DUALSENSE_VALID_FLAG0_OFFSET: usize = 0;
pub const DUALSENSE_RIGHT_SMALL_MOTOR_OFFSET: usize = 2;
pub const DUALSENSE_LEFT_LARGE_MOTOR_OFFSET: usize = 3;
pub const DUALSENSE_VALID_FLAG2_OFFSET: usize = 38;

pub const DUALSENSE_COMPATIBLE_VIBRATION_MASK: u8 = 0x01;
pub const DUALSENSE_HAPTICS_SELECT_MASK: u8 = 0x02;
pub const DUALSENSE_COMPATIBLE_VIBRATION_V2_MASK: u8 = 0x04;

/// Borrowed view of one raw `HMController.OutputReceived` callback.
///
/// `data` excludes the report-ID byte. HIDMaestro reuses the managed backing
/// buffer while draining its output ring, so consumers must decode or copy it
/// synchronously rather than retain this slice after the callback returns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RawDualSensePacket<'a> {
    pub source: u8,
    pub report_id: u8,
    pub data: &'a [u8],
    pub seq_no: u32,
}

/// Complete effective classic-rumble state for one controller.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EffectiveMotorSnapshot {
    pub large_motor: u8,
    pub small_motor: u8,
    pub source_seq_no: u32,
}

/// Why a callback was rejected before any payload coordinate was read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DualSenseRejectReason {
    Source,
    ReportId,
    Length,
}

/// How a structurally accepted DualSense callback affected motor state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DualSenseDisposition {
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

impl DualSenseDisposition {
    /// Stable spelling used by the checked-in golden-vector table.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ApplyLegacy => "apply-legacy",
            Self::ApplyV2 => "apply-v2",
            Self::StopLegacy => "stop-legacy",
            Self::StopV2 => "stop-v2",
            Self::StopAllZero => "stop-all-zero",
            Self::PreserveNoMotorValidity => "preserve-no-motor-validity",
            Self::PreserveSelectorOnly => "preserve-selector-only",
            Self::PreserveMissingSelector => "preserve-missing-selector",
            Self::PreserveConflictingVariants => "preserve-conflicting-variants",
        }
    }
}

/// Result of reducing one raw callback.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DualSenseDecodeResult {
    /// Wrong source, report ID, or exact payload length. No snapshot is emitted.
    Rejected(DualSenseRejectReason),
    /// Structurally accepted. The snapshot is complete even when unrelated or
    /// ambiguous flags preserve the previous motor values.
    Snapshot {
        disposition: DualSenseDisposition,
        snapshot: EffectiveMotorSnapshot,
    },
}

/// Stateful reducer from partial DualSense commands to complete motor state.
///
/// Full snapshots are required by the bounded/latest-wins host queue: dropping
/// an older lightbar-only callback must never resurrect or stutter motor state.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DualSenseFeedbackDecoder {
    large_motor: u8,
    small_motor: u8,
}

impl DualSenseFeedbackDecoder {
    pub const fn new(large_motor: u8, small_motor: u8) -> Self {
        Self {
            large_motor,
            small_motor,
        }
    }

    pub const fn effective_motors(self) -> (u8, u8) {
        (self.large_motor, self.small_motor)
    }

    /// Applies one callback without retaining its borrowed data.
    pub fn apply(&mut self, packet: RawDualSensePacket<'_>) -> DualSenseDecodeResult {
        if packet.source != HID_OUTPUT_SOURCE {
            return DualSenseDecodeResult::Rejected(DualSenseRejectReason::Source);
        }
        if packet.report_id != DUALSENSE_USB_OUTPUT_REPORT_ID {
            return DualSenseDecodeResult::Rejected(DualSenseRejectReason::ReportId);
        }
        if packet.data.len() != DUALSENSE_USB_OUTPUT_DATA_LEN {
            return DualSenseDecodeResult::Rejected(DualSenseRejectReason::Length);
        }

        let disposition = if packet.data.iter().all(|byte| *byte == 0) {
            // SDL emits this exact state when restoring audio haptics after
            // classic rumble. Preserving here would leave simple-rumble output
            // stuck on downstream.
            self.large_motor = 0;
            self.small_motor = 0;
            DualSenseDisposition::StopAllZero
        } else {
            let valid0 = packet.data[DUALSENSE_VALID_FLAG0_OFFSET];
            let valid2 = packet.data[DUALSENSE_VALID_FLAG2_OFFSET];
            let legacy = valid0 & DUALSENSE_COMPATIBLE_VIBRATION_MASK != 0;
            let selector = valid0 & DUALSENSE_HAPTICS_SELECT_MASK != 0;
            let v2 = valid2 & DUALSENSE_COMPATIBLE_VIBRATION_V2_MASK != 0;

            match (selector, legacy, v2) {
                (true, true, false) => self.apply_motor_bytes(packet.data, false),
                (true, false, true) => self.apply_motor_bytes(packet.data, true),
                (true, false, false) => DualSenseDisposition::PreserveSelectorOnly,
                (false, false, false) => DualSenseDisposition::PreserveNoMotorValidity,
                (_, true, true) => DualSenseDisposition::PreserveConflictingVariants,
                (false, true, false) | (false, false, true) => {
                    DualSenseDisposition::PreserveMissingSelector
                }
            }
        };

        DualSenseDecodeResult::Snapshot {
            disposition,
            snapshot: EffectiveMotorSnapshot {
                large_motor: self.large_motor,
                small_motor: self.small_motor,
                source_seq_no: packet.seq_no,
            },
        }
    }

    fn apply_motor_bytes(&mut self, data: &[u8], v2: bool) -> DualSenseDisposition {
        self.small_motor = data[DUALSENSE_RIGHT_SMALL_MOTOR_OFFSET];
        self.large_motor = data[DUALSENSE_LEFT_LARGE_MOTOR_OFFSET];

        match (v2, self.large_motor == 0 && self.small_motor == 0) {
            (false, false) => DualSenseDisposition::ApplyLegacy,
            (true, false) => DualSenseDisposition::ApplyV2,
            (false, true) => DualSenseDisposition::StopLegacy,
            (true, true) => DualSenseDisposition::StopV2,
        }
    }
}
