//! Pure contract for the pinned HIDMaestro v1.6.1 plain-USB DualSense
//! `HMController.OutputReceived` boundary.
//!
//! This crate has no dependencies, binary target, SDK loading, Win32 calls,
//! process launch, shared-memory access, driver access, or hardware access. It
//! compiles the exact dependency-free reducer used by `ksx-hidmaestro`, then
//! drives that one implementation through the frozen golden vectors.

#![forbid(unsafe_code)]

#[path = "../../../crates/ksx-hidmaestro/src/dualsense_feedback.rs"]
mod reducer;

pub use reducer::*;

// Short aliases keep the compact contract tests readable while the canonical
// product API remains explicit at call sites.
pub use reducer::{
    DualSenseDecodeResult as DecodeResult, DualSenseDisposition as Disposition,
    DualSenseFeedbackDecoder as Decoder, DualSenseRejectReason as RejectReason,
    RawDualSensePacket as RawPacket,
};

#[cfg(test)]
mod tests {
    use super::*;

    const CARGO_MANIFEST: &str = include_str!("../Cargo.toml");
    const CONTRACT: &str = include_str!("../contract.json");
    const GOLDEN: &str = include_str!("../golden-vectors.tsv");
    const PRODUCT_FEEDBACK_FACADE: &str =
        include_str!("../../../crates/ksx-hidmaestro/src/feedback.rs");

    #[test]
    fn cargo_manifest_disables_automatic_authority_targets() {
        for setting in [
            "autobins = false",
            "autoexamples = false",
            "autotests = false",
            "autobenches = false",
            "build = false",
        ] {
            assert!(CARGO_MANIFEST.contains(setting), "missing {setting}");
        }
        assert!(!CARGO_MANIFEST.contains("[[bin]]"));
        assert!(!CARGO_MANIFEST.contains("[[example]]"));
        assert!(!CARGO_MANIFEST.contains("[[test]]"));
        assert!(!CARGO_MANIFEST.contains("[[bench]]"));
        assert!(!CARGO_MANIFEST.contains("[build-dependencies]"));
    }

    #[test]
    fn product_feedback_facade_uses_the_shared_reducer() {
        assert!(PRODUCT_FEEDBACK_FACADE.contains("pub use crate::dualsense_feedback::{"));
        assert!(!PRODUCT_FEEDBACK_FACADE.contains("impl DualSenseFeedbackDecoder"));
    }

    #[derive(Debug)]
    struct Vector {
        name: String,
        source: u8,
        report_id: u8,
        data: Vec<u8>,
        initial_large: u8,
        initial_small: u8,
        expected_disposition: String,
        expected_large: u8,
        expected_small: u8,
    }

    fn byte(text: &str) -> u8 {
        let hex = text.strip_prefix("0x").unwrap_or(text);
        u8::from_str_radix(hex, 16).unwrap()
    }

    fn vectors() -> Vec<Vector> {
        GOLDEN
            .lines()
            .filter(|line| {
                !line.is_empty() && !line.starts_with('#') && !line.starts_with("name\t")
            })
            .map(|line| {
                let fields: Vec<_> = line.split('\t').collect();
                assert_eq!(fields.len(), 10, "malformed golden vector: {line}");
                let mut data = vec![0; fields[3].parse::<usize>().unwrap()];
                if fields[4] != "-" {
                    for patch in fields[4].split(',') {
                        let (offset, value) = patch.split_once(':').unwrap();
                        data[offset.parse::<usize>().unwrap()] = byte(value);
                    }
                }
                Vector {
                    name: fields[0].to_owned(),
                    source: fields[1].parse().unwrap(),
                    report_id: byte(fields[2]),
                    data,
                    initial_large: byte(fields[5]),
                    initial_small: byte(fields[6]),
                    expected_disposition: fields[7].to_owned(),
                    expected_large: byte(fields[8]),
                    expected_small: byte(fields[9]),
                }
            })
            .collect()
    }

    #[test]
    fn golden_vectors_are_exact() {
        let vectors = vectors();
        assert_eq!(vectors.len(), 16);
        assert!(CONTRACT.contains("\"goldenVectorCount\": 16"));
        assert!(CONTRACT.contains(
            "\"canonicalRustSource\": \"../../crates/ksx-hidmaestro/src/dualsense_feedback.rs\""
        ));

        for (index, vector) in vectors.iter().enumerate() {
            let mut decoder = Decoder::new(vector.initial_large, vector.initial_small);
            let result = decoder.apply(RawPacket {
                source: vector.source,
                report_id: vector.report_id,
                data: &vector.data,
                seq_no: (index + 1) as u32,
            });

            let expected_seq_no = (index + 1) as u32;
            let actual_disposition = match result {
                DecodeResult::Rejected(RejectReason::Source) => "reject-source",
                DecodeResult::Rejected(RejectReason::ReportId) => "reject-report-id",
                DecodeResult::Rejected(RejectReason::Length) => "reject-length",
                DecodeResult::Snapshot {
                    disposition,
                    snapshot,
                } => {
                    assert_eq!(
                        snapshot,
                        EffectiveMotorSnapshot {
                            large_motor: vector.expected_large,
                            small_motor: vector.expected_small,
                            source_seq_no: expected_seq_no,
                        },
                        "snapshot mismatch for {}",
                        vector.name
                    );
                    disposition.as_str()
                }
            };
            assert_eq!(
                actual_disposition, vector.expected_disposition,
                "disposition mismatch for {}",
                vector.name
            );
            assert_eq!(
                decoder.effective_motors(),
                (vector.expected_large, vector.expected_small),
                "effective state mismatch for {}",
                vector.name
            );
        }
    }

    #[test]
    fn preserved_packet_still_emits_a_complete_effective_snapshot() {
        let mut decoder = Decoder::default();
        let mut start = [0u8; DUALSENSE_USB_OUTPUT_DATA_LEN];
        start[0] = DUALSENSE_COMPATIBLE_VIBRATION_MASK | DUALSENSE_HAPTICS_SELECT_MASK;
        start[DUALSENSE_RIGHT_SMALL_MOTOR_OFFSET] = 0x34;
        start[DUALSENSE_LEFT_LARGE_MOTOR_OFFSET] = 0x78;
        let _ = decoder.apply(RawPacket {
            source: HID_OUTPUT_SOURCE,
            report_id: DUALSENSE_USB_OUTPUT_REPORT_ID,
            data: &start,
            seq_no: 41,
        });

        let mut lightbar_only = [0u8; DUALSENSE_USB_OUTPUT_DATA_LEN];
        lightbar_only[1] = 0x04;
        lightbar_only[44..47].copy_from_slice(&[0x10, 0x20, 0x30]);
        let result = decoder.apply(RawPacket {
            source: HID_OUTPUT_SOURCE,
            report_id: DUALSENSE_USB_OUTPUT_REPORT_ID,
            data: &lightbar_only,
            seq_no: 42,
        });

        assert_eq!(
            result,
            DecodeResult::Snapshot {
                disposition: Disposition::PreserveNoMotorValidity,
                snapshot: EffectiveMotorSnapshot {
                    large_motor: 0x78,
                    small_motor: 0x34,
                    source_seq_no: 42,
                },
            }
        );
    }

    #[test]
    fn raw_callback_memory_is_not_retained() {
        let mut decoder = Decoder::default();
        let mut callback_buffer = vec![0u8; DUALSENSE_USB_OUTPUT_DATA_LEN];
        callback_buffer[0] = DUALSENSE_COMPATIBLE_VIBRATION_MASK | DUALSENSE_HAPTICS_SELECT_MASK;
        callback_buffer[DUALSENSE_RIGHT_SMALL_MOTOR_OFFSET] = 0x12;
        callback_buffer[DUALSENSE_LEFT_LARGE_MOTOR_OFFSET] = 0xAB;
        let result = decoder.apply(RawPacket {
            source: HID_OUTPUT_SOURCE,
            report_id: DUALSENSE_USB_OUTPUT_REPORT_ID,
            data: &callback_buffer,
            seq_no: 7,
        });

        callback_buffer.fill(0xFF);
        assert_eq!(decoder.effective_motors(), (0xAB, 0x12));
        assert!(matches!(
            result,
            DecodeResult::Snapshot {
                snapshot: EffectiveMotorSnapshot {
                    large_motor: 0xAB,
                    small_motor: 0x12,
                    source_seq_no: 7,
                },
                ..
            }
        ));
    }
}
