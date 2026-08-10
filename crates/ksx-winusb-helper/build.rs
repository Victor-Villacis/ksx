//! Stamp the elevated helper with the KSX icon, version and UAC contract.

fn main() {
    println!("cargo:rerun-if-changed=../../assets/brand/dist/ksx.ico");
    println!("cargo:rerun-if-changed=build.rs");

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    #[cfg(windows)]
    windows_resources();
}

#[cfg(windows)]
fn windows_resources() {
    const MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="requireAdministrator" uiAccess="false" />
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}" />
    </application>
  </compatibility>
</assembly>"#;

    let mut resources = winresource::WindowsResource::new();
    resources.set_icon_with_id("../../assets/brand/dist/ksx.ico", "1");

    // A requireAdministrator manifest is attached to every shippable release
    // build and verified from the final PE in Actions. Debug/test harnesses
    // intentionally keep the default asInvoker manifest: otherwise Windows
    // refuses to execute `cargo test` with ERROR_ELEVATION_REQUIRED before a
    // single parser/exit-code test can run. The production transaction still
    // checks its elevated token, and the application always uses `runas`, so a
    // debug binary cannot cross the mutation boundary without elevation.
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        resources.set_manifest(MANIFEST);
    }

    let version = env!("CARGO_PKG_VERSION");
    resources
        .set("ProductName", "KSX")
        .set("FileDescription", "KSX WinUSB preparation helper")
        .set("OriginalFilename", "ksx-winusb-helper.exe")
        .set("InternalName", "ksx-winusb-helper")
        .set("CompanyName", "Victor Villacis")
        .set("LegalCopyright", "MIT OR Apache-2.0")
        .set("ProductVersion", version)
        .set("FileVersion", version);

    if let Err(error) = resources.compile() {
        println!(
            "cargo:warning=ksx-winusb-helper.exe resources not stamped ({error}); \
             the icon, version and embedded UAC manifest will be missing"
        );
    }
}
