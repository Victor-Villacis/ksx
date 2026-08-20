//! Live driver-health collection (Windows only). Read-only: registry queries,
//! file metadata, WinVerifyTrust. Never elevates, never errors — a machine with
//! no drivers at all still yields a complete `DriverReport`.

pub(crate) mod devices;
pub use devices::ancestor_instance_ids;
mod filever;
// `crate::app_paths` reads a different hive through the same wrappers rather
// than opening a second registry binding beside this one.
pub(crate) mod registry;
mod services;
pub(crate) mod signature;
mod vigem_pads;

use std::path::{Path, PathBuf};

use std::os::windows::fs::MetadataExt as _;

use crate::sha256;

use crate::parse::{ci_mode_from_name, filetime_to_rfc3339, parse_cip_meta, resolve_image_path};
use crate::report::{
    BusDriverReport, CiPolicyReport, ClassFilterReport, CodeIntegrityReport, DriverFileReport,
    DriverReport, HidMaestroReport, InterceptionReport, ServiceInfo, StartType,
    WhqlEvaluationReport,
};
use crate::virtual_pads::{owner_candidates, VirtualPadReport};

const SERVICES: &str = "SYSTEM\\CurrentControlSet\\Services";
const KEYBOARD_CLASS: &str =
    "SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e96b-e325-11ce-bfc1-08002be10318}";
const MOUSE_CLASS: &str =
    "SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e96f-e325-11ce-bfc1-08002be10318}";
const WHQL_EVAL: &str = "SYSTEM\\CurrentControlSet\\Control\\CI\\WhqlOnlyEvaluation";
/// The 2026 cross-signed-trust-removal rollout policy
/// ("Microsoft Windows Cross Certificates for Code Integrity Exceptions Audit Policy").
const CROSS_CERT_POLICY_GUID: &str = "784C4414-79F4-4C32-A6A5-F0FB42A51D0D";

/// The bus service name — the single key both the service-health check and the
/// ghost-pad devnode lookup go through.
const VIGEMBUS_SERVICE: &str = "ViGEmBus";

/// HIDMaestro's service name and Driver Store package.
///
/// Kept in sync with the fixed production host, which applies the same two
/// hashes and exact-one rule at plug time. This crate deliberately has no
/// dependency on the host executable, so the pins are duplicated here.
const HIDMAESTRO_SERVICE: &str = "HIDMaestro";
const HIDMAESTRO_REPOSITORY: &str = r"System32\DriverStore\FileRepository";
const HIDMAESTRO_PACKAGE_PREFIX: &str = "hidmaestro.inf_amd64_";
const HIDMAESTRO_INF_SHA256: &str =
    "187D5B06625CEECC0E1B43C0FA8DDA5F6DAB6A9962F79B037BBAD419F1084704";
/// SHA-256 the SDK's own installer writes over the five unsigned payload
/// resources. Deterministic per SDK version, unlike the installed driver
/// DLL's bytes: `InstallDriver()` signs that DLL with a test certificate it
/// GENERATES AT INSTALL TIME (measured 2026-08-20: cert NotBefore equals the
/// install second minus a day, and signing appends ~1.4 KB), so a fixed pin
/// on the installed DLL bytes can never match any real installation. An
/// earlier revision of this probe pinned exactly that and refused every
/// legitimate install, this machine's included.
const HIDMAESTRO_MANIFEST_KEY: &str = r"SOFTWARE\HIDMaestro";
const HIDMAESTRO_MANIFEST_VALUE: &str = "InstalledManifestSha256";
const HIDMAESTRO_MANIFEST_SHA256: &str =
    "2f5c0313b3ea6fa79179a501648d9ff1b4330fbc4d1ab23294be14885edb2d8c";
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

/// Just the ViGEm bus's children, without the rest of the driver stack.
///
/// [`collect`] builds SIX reports — registry reads for two bus services, an
/// Interception class-filter walk, a hash-pinned HIDMaestro package probe, a
/// CI-policy read and a process snapshot — and a caller that wants the pad
/// list pays for all of it. Studio's /pads polls every 2 s and discards five
/// sixths of that report, which is what this exists to stop.
pub fn collect_virtual_pads() -> VirtualPadReport {
    virtual_pads()
}

/// Just the ViGEm bus's own health, without the rest of the driver stack.
///
/// Same reason as [`collect_virtual_pads`], for a different caller: `/start`
/// polls this only when a staged Xbox 360 or PlayStation persona requires
/// ViGEmBus. [`collect`] would also walk the Interception class filters, probe
/// HIDMaestro, read CI policy and snapshot processes. This smaller entry point
/// is two registry reads, one SCM query and one file-version read.
///
/// It is the SAME [`bus_driver`] call [`collect`] makes, so the judgement
/// [`crate::advice::vigembus_advice`] reaches from it is the judgement
/// `ksx doctor` reaches. A second, cheaper probe that answered differently
/// would be worse than the cost it saved.
pub fn collect_vigembus() -> BusDriverReport {
    bus_driver(VIGEMBUS_SERVICE, &windir())
}

/// Just the exact HIDMaestro package prerequisite, without the rest of the
/// driver-health report.
///
/// `/start` polls this only when a staged supported persona routes through
/// HIDMaestro. It is the same hash-pinned [`hidmaestro`] probe [`collect`]
/// uses; the smaller entry point avoids walking unrelated class filters,
/// virtual pads, process owners and code-integrity policy every two seconds.
/// This proves the installed package only. The protected host handshake and
/// virtual-controller endpoint are created and verified transactionally when
/// Play starts.
pub fn collect_hidmaestro() -> HidMaestroReport {
    hidmaestro(&windir())
}

/// Collect the full driver-health report from the live machine.
pub fn collect() -> DriverReport {
    let windir = windir();
    DriverReport {
        vigembus: bus_driver(VIGEMBUS_SERVICE, &windir),
        scpvbus: bus_driver("ScpVBus", &windir),
        interception: interception(&windir),
        code_integrity: code_integrity(&windir),
        virtual_pads: virtual_pads(),
        hidmaestro: hidmaestro(&windir),
    }
}

/// HIDMaestro install state. Never elevates, never errors: a machine without it
/// is a normal machine that cannot mount the production DualSense persona.
fn hidmaestro(windir: &str) -> HidMaestroReport {
    let service_key = format!("{SERVICES}\\{HIDMAESTRO_SERVICE}");
    let service_present = registry::key_exists(&service_key);
    let repository = PathBuf::from(format!("{windir}\\{HIDMAESTRO_REPOSITORY}"));
    let mut package_directories = std::fs::read_dir(&repository)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            // Directories only: the Driver Store keeps a "<package>.ini"
            // sidecar FILE beside every package directory, and it matches the
            // name prefix. Counting it made "exactly one package" see two on
            // every machine with the package staged (measured 2026-08-20).
            (name.starts_with(HIDMAESTRO_PACKAGE_PREFIX)
                && entry.file_type().is_ok_and(|kind| kind.is_dir()))
            .then(|| entry.path())
        })
        .collect::<Vec<_>>();
    package_directories.sort();
    let mut candidates = package_directories
        .iter()
        .filter_map(|directory| {
            let metadata = std::fs::symlink_metadata(directory).ok()?;
            if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            {
                return None;
            }
            let inf = directory.join("hidmaestro.inf");
            let dll = directory.join("HIDMaestro.dll");
            if !inf.is_file() || !dll.is_file() {
                return None;
            }
            // The INF installs verbatim, so its hash is deterministic and
            // stays pinned. The DLL only has to EXIST here: its bytes are
            // re-signed per install, and its version identity is proven by
            // the SDK's own manifest value below.
            let exact = sha256::hash_file(&inf)
                .is_ok_and(|digest| sha256::digest_matches(&digest, HIDMAESTRO_INF_SHA256));
            Some((dll, exact))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| left.0.cmp(&right.0));
    let exact = candidates
        .iter()
        .filter(|(_, exact)| *exact)
        .map(|(dll, _)| dll)
        .collect::<Vec<_>>();
    let manifest_ok = registry::read_string(HIDMAESTRO_MANIFEST_KEY, HIDMAESTRO_MANIFEST_VALUE)
        .is_some_and(|value| value.eq_ignore_ascii_case(HIDMAESTRO_MANIFEST_SHA256));
    // The service key is deliberately NOT part of `installed`: the UMDF
    // service materialises when the first `root\HIDMaestro` devnode binds the
    // INF, so requiring it here refuses the very install whose first spawn
    // would create it.
    let installed = package_directories.len() == 1 && exact.len() == 1 && manifest_ok;
    let reported_dll = if exact.len() == 1 {
        Some(exact[0].clone())
    } else {
        candidates.first().map(|(dll, _)| dll).cloned()
    };
    let looked_for = vec![
        repository
            .join(format!(
                "hidmaestro.inf_amd64_*\\hidmaestro.inf (SHA256 {HIDMAESTRO_INF_SHA256})"
            ))
            .display()
            .to_string(),
        repository
            .join("hidmaestro.inf_amd64_*\\HIDMaestro.dll (present; bytes are re-signed per install)")
            .display()
            .to_string(),
        format!(
            "HKLM\\{HIDMAESTRO_MANIFEST_KEY}\\{HIDMAESTRO_MANIFEST_VALUE} == {HIDMAESTRO_MANIFEST_SHA256}"
        ),
        format!("HKLM\\{service_key} (informational; registers on first controller creation)"),
    ];
    HidMaestroReport {
        // The exact package, not just the service key or a similarly named
        // DLL: the live host applies the same two hashes and exact-one rule.
        installed,
        service_key: service_present,
        driver_file: reported_dll.and_then(driver_file),
        looked_for,
    }
}

/// The bus's current child pads. The devnode is found by *service name* (the
/// same identity [`bus_driver`] reports on), never by pad VID/PIDs — a real
/// controller on a physical port hangs off a hub, not off ViGEmBus, and must
/// never be counted.
fn virtual_pads() -> VirtualPadReport {
    // The service filter lists devnodes *registered* to ViGEmBus, present or
    // not — an uninstalled or stopped bus leaves a registered id behind. Only
    // a devnode that locates as present (`child_instance_ids` → `Some`) may be
    // reported or named in the restart advice; a stale id would put a
    // non-restartable devnode in the `pnputil` command.
    let mut present_bus: Option<String> = None;
    let mut children: Vec<String> = Vec::new();
    for bus in vigem_pads::bus_instance_ids(VIGEMBUS_SERVICE) {
        if let Some(kids) = vigem_pads::child_instance_ids(&bus) {
            children.extend(kids);
            // A machine has one bus devnode; if several ever exist the
            // children are aggregated and the advice names the first present.
            present_bus.get_or_insert(bus);
        }
    }
    let owners = owner_candidates(&crate::process::snapshot(), std::process::id());
    VirtualPadReport::from_bus_children(present_bus, children, owners)
}

fn windir() -> String {
    std::env::var("SystemRoot")
        .or_else(|_| std::env::var("WINDIR"))
        .unwrap_or_else(|_| "C:\\Windows".to_string())
}

fn bus_driver(service: &str, windir: &str) -> BusDriverReport {
    let key = format!("{SERVICES}\\{service}");
    let installed = registry::key_exists(&key);
    if !installed {
        // No service key: still check for an orphaned driver file.
        return BusDriverReport {
            installed: false,
            service: None,
            driver_file: driver_file(default_sys_path(service, windir)),
        };
    }
    let image_path = registry::read_string(&key, "ImagePath");
    let resolved = image_path
        .as_deref()
        .map(|p| PathBuf::from(resolve_image_path(p, windir)))
        .unwrap_or_else(|| default_sys_path(service, windir));
    BusDriverReport {
        installed: true,
        service: Some(ServiceInfo {
            start_type: registry::read_u32(&key, "Start")
                .map(StartType::from_raw)
                .unwrap_or(StartType::Unknown),
            image_path,
            display_name: registry::read_string(&key, "DisplayName"),
            state: services::query_state(service),
        }),
        driver_file: driver_file(resolved),
    }
}

fn default_sys_path(service: &str, windir: &str) -> PathBuf {
    PathBuf::from(format!("{windir}\\System32\\drivers\\{service}.sys"))
}

fn driver_file(path: PathBuf) -> Option<DriverFileReport> {
    if !path.is_file() {
        return None;
    }
    let path_str = path.display().to_string();
    let ver = filever::query(&path_str);
    Some(DriverFileReport {
        file_version: ver.fixed_version,
        file_version_string: ver.file_version_string,
        company: ver.company,
        description: ver.description,
        signature: Some(signature::verify(&path_str)),
        path: path_str,
    })
}

fn interception(windir: &str) -> InterceptionReport {
    let keyboard = class_filter(KEYBOARD_CLASS, "keyboard", windir);
    let mouse = class_filter(MOUSE_CLASS, "mouse", windir);
    InterceptionReport {
        installed: keyboard.filter_active && keyboard.driver_file.is_some(),
        keyboard,
        mouse,
    }
}

fn class_filter(class_key: &str, filter_name: &str, windir: &str) -> ClassFilterReport {
    let upper_filters = registry::read_multi_string(class_key, "UpperFilters").unwrap_or_default();
    let filter_active = upper_filters
        .iter()
        .any(|f| f.eq_ignore_ascii_case(filter_name));
    ClassFilterReport {
        filter_active,
        driver_file: driver_file(default_sys_path(filter_name, windir)),
        upper_filters,
    }
}

fn code_integrity(windir: &str) -> CodeIntegrityReport {
    let active_dir = Path::new(windir).join("System32\\CodeIntegrity\\CiPolicies\\Active");
    let mut count = None;
    let mut cross_cert_policy = None;

    if let Ok(entries) = std::fs::read_dir(&active_dir) {
        let mut n = 0usize;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.to_ascii_lowercase().ends_with(".cip") {
                continue;
            }
            n += 1;
            if name.to_ascii_uppercase().contains(CROSS_CERT_POLICY_GUID) {
                cross_cert_policy = Some(cip_report(&entry.path()));
            }
        }
        count = Some(n);
    }

    CodeIntegrityReport {
        cross_cert_policy,
        active_policy_count: count,
        whql_evaluation: whql_evaluation(),
    }
}

fn cip_report(path: &Path) -> CiPolicyReport {
    // The .cip is PKCS#7-signed; name/id are scraped from embedded UTF-16
    // strings (see parse::parse_cip_meta) — authoritative flag parsing would
    // need elevated `CiTool --list-policies`.
    let meta = std::fs::read(path)
        .map(|b| parse_cip_meta(&b))
        .unwrap_or_default();
    CiPolicyReport {
        guid: format!("{{{CROSS_CERT_POLICY_GUID}}}"),
        file_path: path.display().to_string(),
        mode: ci_mode_from_name(meta.name.as_deref()),
        name: meta.name,
        policy_id: meta.id,
    }
}

fn whql_evaluation() -> Option<WhqlEvaluationReport> {
    if !registry::key_exists(WHQL_EVAL) {
        return None;
    }
    Some(WhqlEvaluationReport {
        num_boot_sessions: registry::read_u32(WHQL_EVAL, "NumBootSessions"),
        latest_boot_id: registry::read_u32(WHQL_EVAL, "LatestBootId"),
        status_event_time_utc: registry::read_u64(WHQL_EVAL, "StatusEventTimestamp")
            .and_then(filetime_to_rfc3339),
        system_uptime_secs: registry::read_u64(WHQL_EVAL, "SystemUptime").map(|t| t / 10_000_000),
    })
}

