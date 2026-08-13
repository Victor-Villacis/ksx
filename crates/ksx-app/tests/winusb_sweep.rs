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

#[test]
fn report_and_yes_dry_run_each_emit_one_truthful_json_document() {
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
    }
}
