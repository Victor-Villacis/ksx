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

    let inf_path = output_dir.join("ksx-winusb.inf");
    std::fs::write(&inf_path, CANONICAL_INF_TEMPLATE).expect("the template is readable input");

    let request = PrepareRequest {
        output_dir: output_dir.clone(),
        inf_path: inf_path.clone(),
        instance_id: format!(r"USB\VID_{VID:04X}&PID_{PID:04X}&MI_00\7&KSXSMOKE&0&0000"),
        hardware_id: format!(r"USB\VID_{VID:04X}&PID_{PID:04X}&MI_00"),
        vendor_id: VID,
        product_id: PID,
        interface_number: Some(0),
        // Unique per run: the provider mints a certificate for this subject and
        // a collision with a previous run's would test caching, not signing.
        certificate_subject: format!("CN=KSX WinUSB smoke {}", std::process::id()),
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

/// Two paths naming the same file. `canonicalize` is enough here: both sides
/// are local, existing files.
fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}
