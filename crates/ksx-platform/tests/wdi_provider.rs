//! The provider smoke, driven through the code the product actually ships.
//!
//! # Why this exists beside `third_party/libwdi/test-provider.ps1`
//!
//! That script re-implements the FFI boundary in PowerShell: its own
//! `[StructLayout]` copy of `wdi_device_info`, its own options struct, its own
//! path string. It was green for months while three separate defects sat in
//! the Rust side of the same boundary, and it was green *because* it re-built
//! the inputs:
//!
//! | defect | why the PowerShell smoke could not see it |
//! |---|---|
//! | `device_id`/`hardware_id` populated, which `external_inf` forbids | PowerShell zero-initializes exactly those fields |
//! | `\\?\` verbatim paths, which the provider rejects on character one | the smoke hand-builds a plain `C:\…` path |
//! | catalogue algorithm mismatch | the smoke never verified the catalogue it produced |
//!
//! A replica cannot fail the way the original does. So this test calls
//! [`ksx_platform::winusb::wdi::WdiProvider`] — the real struct, the real path
//! conversion, the real options — against the real DLL, and asserts what came
//! out.
//!
//! # It is `#[ignore]`d on purpose
//!
//! It needs an elevated process (the provider writes a certificate to the
//! machine stores) and a built `libwdi.dll`, neither of which a developer's
//! `cargo test` has. CI has both, and runs it explicitly:
//!
//! ```text
//! $env:KSX_WDI_SMOKE_DLL = "<abs path to libwdi.dll>"
//! cargo test -p ksx-platform --test wdi_provider -- --ignored --nocapture
//! ```
//!
//! Without the variable it SKIPS rather than passes, and says so — a smoke that
//! silently passes when its subject is absent is the check this file exists to
//! stop being.

#![cfg(windows)]

use std::path::{Path, PathBuf};

use ksx_platform::winusb::wdi::{
    DriverPreparer as _, PrepareRequest, WdiProvider, CANONICAL_INF_TEMPLATE,
};

/// Where CI puts the DLL under test. Absolute, because the provider refuses
/// anything that is not beside the executable that loads it.
const DLL_VAR: &str = "KSX_WDI_SMOKE_DLL";

/// The synthetic board: an Ultimarc I-PAC's keyboard interface, which is the
/// device every other WinUSB test in this repository is written about. Nothing
/// is plugged in — preparation writes files, it does not touch hardware.
const VID: u16 = 0xd209;
const PID: u16 = 0x0430;

#[test]
#[ignore = "needs an elevated CI process and a built libwdi.dll (see the module docs)"]
fn the_shipped_provider_binding_prepares_a_signed_package() {
    let Some(dll) = std::env::var_os(DLL_VAR).map(PathBuf::from) else {
        println!("SKIP: {DLL_VAR} is not set, so there is no provider to smoke");
        return;
    };
    assert!(
        dll.is_absolute() && dll.is_file(),
        "{DLL_VAR} must be an absolute path to a built libwdi.dll, got {}",
        dll.display()
    );

    // The provider must live beside the executable that loads it, so the test
    // binary's own directory is the one place it can be. CI copies it there.
    let exe = std::env::current_exe().expect("the test binary has a path");
    let beside = exe
        .parent()
        .expect("a test binary has a directory")
        .join("libwdi.dll");
    if !same_file(&dll, &beside) {
        std::fs::copy(&dll, &beside).unwrap_or_else(|err| {
            panic!(
                "could not place the provider beside {}: {err}",
                exe.display()
            )
        });
    }
    let provider = WdiProvider::at(beside.clone(), &exe).expect("the provider is beside the test");

    // A REAL canonicalized directory, which on Windows means a `\\?\` verbatim
    // path — the exact form the transaction store produces and the exact form
    // that used to fail on its first character. Building a plain `C:\…` string
    // here would reproduce the blind spot this file exists to remove.
    let work = std::env::temp_dir().join(format!("ksx-wdi-smoke-{}", std::process::id()));
    std::fs::create_dir_all(&work).expect("scratch directory");
    let output_dir = work.canonicalize().expect("canonical scratch directory");
    assert!(
        output_dir.to_string_lossy().starts_with(r"\\?\"),
        "this test is worthless unless the path really is verbatim: {}",
        output_dir.display()
    );

    // ONE id, spelled into both names, exactly as the transaction layer does
    // (`winusb_transaction.rs`: `ksx-winusb-{transaction_id}.inf` and
    // `CN=KSX WinUSB {transaction_id}`). Inventing either separately is how the
    // first two runs of this test were refused — see `transaction_id`.
    let id = transaction_id();
    let inf_path = output_dir.join(format!("ksx-winusb-{id}.inf"));
    std::fs::write(&inf_path, CANONICAL_INF_TEMPLATE).expect("the template is readable input");

    let request = PrepareRequest {
        output_dir: output_dir.clone(),
        inf_path: inf_path.clone(),
        instance_id: format!(r"USB\VID_{VID:04X}&PID_{PID:04X}&MI_00\7&KSXSMOKE&0&0000"),
        hardware_id: format!(r"USB\VID_{VID:04X}&PID_{PID:04X}&MI_00"),
        vendor_id: VID,
        product_id: PID,
        interface_number: Some(0),
        certificate_subject: format!("CN=KSX WinUSB {id}"),
    };

    let prepared = provider
        .prepare(&request)
        .unwrap_or_else(|err| panic!("the shipped provider binding could not prepare: {err}"));

    // The two artifacts, and the fact that the catalogue is not empty — the
    // catalogue was produced for months with a member the verifier could not
    // match, and nothing downstream of "the call returned 0" noticed.
    assert!(
        prepared.inf_path.is_file(),
        "no INF at {}",
        prepared.inf_path.display()
    );
    assert!(
        prepared.catalog_path.is_file(),
        "no catalogue at {}",
        prepared.catalog_path.display()
    );
    let catalog = std::fs::metadata(&prepared.catalog_path).expect("catalogue metadata");
    assert!(catalog.len() > 0, "the catalogue is empty");

    // Prepared output is UTF-16, which is how the provider signals it rewrote
    // the template rather than leaving the input in place.
    let inf = std::fs::read(&prepared.inf_path).expect("the prepared INF is readable");
    assert_eq!(
        &inf[..2],
        &[0xff, 0xfe],
        "the prepared INF is not UTF-16LE, so the template was not rewritten"
    );

    let _ = std::fs::remove_dir_all(&work);
}

/// A transaction id in production's shape: 32 lowercase hex characters.
///
/// Both names the provider validates are spelled from this one value, and that
/// is the lesson of this function's history. The provider refused two
/// successive versions of this test, on its first CI run and on its second:
///
/// | invented | the rule it broke |
/// |---|---|
/// | `CN=KSX WinUSB smoke <pid>` | `ksx_is_safe_cert_subject`: the prefix, then ≥32 characters that are hex digits or `-` and nothing else |
/// | `ksx-winusb.inf` | `ksx_is_safe_inf_name`: `ksx-winusb-`, then lowercase hex or `-`, then `.inf` |
///
/// Both refusals were correct, and both were this test inventing a shape
/// instead of using the product's. That is precisely the failure mode the
/// PowerShell smoke could never have: it never asks the provider anything it
/// did not construct itself, so it could not be told it was wrong.
///
/// Unique per call, because the provider mints a certificate for the subject
/// and reusing one would exercise the cache rather than the signing path.
fn transaction_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or_default();
    format!("{:016x}{:016x}", u64::from(std::process::id()), nanos)
}

/// Two paths naming the same file. `canonicalize` is enough here: both sides
/// are local, existing files.
fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Both names this file hands the provider satisfy the provider's own rules.
///
/// NOT `#[ignore]`d: it needs no DLL and no elevation, and it exists because
/// the smoke above was refused twice for inventing a name — one full CI round
/// trip each. The expensive test can only run in one place; this one runs
/// everywhere and catches the same class in milliseconds.
///
/// It duplicates `ksx_is_safe_cert_subject` and `ksx_is_safe_inf_name` from
/// `third_party/libwdi/src/libwdi.c`, deliberately: the two copies disagreeing
/// is exactly the failure it reports.
#[test]
fn the_smoke_names_are_ones_the_provider_accepts() {
    let id = transaction_id();

    // ksx_is_safe_cert_subject
    let subject = format!("CN=KSX WinUSB {id}");
    assert!(
        subject.len() < 96,
        "the provider rejects a subject of 96 characters or more: {subject}"
    );
    assert!(
        id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'),
        "the provider allows only hex digits and '-' after the prefix: {subject}"
    );
    assert!(
        id.chars().filter(char::is_ascii_hexdigit).count() >= 32,
        "the provider requires at least 32 hex digits: {subject}"
    );

    // ksx_is_safe_inf_name. Lowercase only, which `{:x}` gives and `{:X}`
    // would not — the kind of difference that costs a CI round trip.
    let inf = format!("ksx-winusb-{id}.inf");
    let stem = inf
        .strip_prefix("ksx-winusb-")
        .and_then(|rest| rest.strip_suffix(".inf"))
        .unwrap_or_else(|| panic!("the provider requires ksx-winusb-<id>.inf: {inf}"));
    assert!(!stem.is_empty(), "the id may not be empty: {inf}");
    assert!(inf.len() < 120, "the provider caps the name at 120: {inf}");
    assert!(
        stem.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
        "the provider allows only lowercase letters, digits and '-' in the stem: {inf}"
    );

    // Unique per call, or the certificate cache is what gets exercised.
    assert_ne!(transaction_id(), id);
}
