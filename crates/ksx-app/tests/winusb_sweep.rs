//! Read-only CLI contract for the orphaned-certificate report.
//!
//! Both invocations are structurally non-mutating. There is deliberately no
//! `--yes` without `--dry-run` in this test: a developer or CI machine may
//! contain a real KSX signer, and tests never authorize deleting it.

#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::process::Command;

const KSX: &str = env!("CARGO_BIN_EXE_ksx");

fn portable_copy() -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!(
        "ksx-sweep-report-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("create isolated portable root");
    let name = Path::new(KSX)
        .file_name()
        .expect("the test binary has a file name");
    let exe = root.join(name);
    std::fs::copy(KSX, &exe).expect("copy ksx into the portable root");
    std::fs::write(root.join("ksx.toml"), "schema_version = 1\n").expect("write portable marker");
    (root, exe)
}

fn report(args: &[&str]) -> serde_json::Value {
    let (root, exe) = portable_copy();
    let output = Command::new(exe)
        .args(args)
        .output()
        .expect("run read-only certificate report");
    let _ = std::fs::remove_dir_all(root);
    assert!(
        output.status.success(),
        "report failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "stdout must be exactly one JSON document ({error}): {}",
            String::from_utf8_lossy(&output.stdout)
        )
    })
}

/// **The shape, and enough of the content that an empty store is visibly an
/// empty store.**
///
/// `verified: true` / `attempted: false` used to be the whole test. On a
/// machine with zero orphaned KSX certificates those are the trivial answers,
/// so the test proved the JSON shape and nothing about the sweep — and a
/// developer box is exactly as likely to be empty as to be full. The counts
/// below make the difference visible: the document has to SAY how many it
/// examined, and a machine with none says `0` rather than saying nothing.
#[test]
fn report_and_yes_dry_run_each_emit_one_truthful_json_document() {
    let mut counts = Vec::new();
    for args in [
        ["winusb", "sweep-certificates", "--json"].as_slice(),
        [
            "winusb",
            "sweep-certificates",
            "--yes",
            "--dry-run",
            "--json",
        ]
        .as_slice(),
    ] {
        let value = report(args);
        assert_eq!(value["ok"], true);
        assert_eq!(value["action"], "sweep-certificates");
        assert_eq!(value["will_apply"], false);
        assert_eq!(value["attempted"], false);
        assert_eq!(value["applied"], false);
        assert_eq!(value["verified"], true);

        // How many it looked at. Absent is not the same as none, and only one
        // of the two is an answer.
        let examined = value["leftover_certificates"].as_u64().unwrap_or_else(|| {
            panic!(
                "{args:?} reported no `leftover_certificates` count, so an empty store and \
                 a sweep that never ran look identical: {value}"
            )
        });
        counts.push(examined);

        for field in ["leftover_subjects", "blocked", "in_use_subjects"] {
            assert!(
                value[field].is_array(),
                "{args:?}: `{field}` must always be present as an array, empty or not: {value}"
            );
        }
        let subjects = value["leftover_subjects"]
            .as_array()
            .expect("checked above");
        assert!(
            subjects.len() as u64 <= examined,
            "{args:?} named {} distinct subjects out of {examined} certificates: {value}",
            subjects.len()
        );

        // **The safety property.** This verb deletes certificates when it is
        // given `--yes` without `--dry-run`. Naming one that is not ksx's own
        // is the single catastrophic failure available to it, and it is
        // checkable here for free, on whatever the machine happens to hold.
        for subject in subjects {
            let subject = subject.as_str().unwrap_or_default();
            assert!(
                subject.starts_with("CN=KSX WinUSB "),
                "the sweep listed {subject:?}, which is not a KSX signer. This verb \
                 REMOVES what it lists: {value}"
            );
        }
    }

    // Both invocations describe the same machine. A `--yes --dry-run` that
    // reported a different count from the plain report would be rehearsing
    // against a store it is not about to act on.
    assert_eq!(
        counts[0], counts[1],
        "the report and the dry run disagree about how many certificates are there \
         ({} vs {})",
        counts[0], counts[1]
    );
}
