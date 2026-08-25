//! Portable, complete semantic layouts for supported panel encoders.
//!
//! These documents are deliberately not hardware recovery images. The raw
//! EEPROM backup store is fixed to a physical board and preserves unknown
//! bytes; a panel layout contains one validated semantic row for every
//! terminal and can be renamed, edited, and applied to another admitted board.
//! One resource per file keeps create/update/delete independent, while the
//! revision over the complete document makes every update a stale-safe
//! compare-and-replace.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use ksx_api::{
    PanelChartSpec, PanelChartView, PanelHardwareProfile, PanelHardwareProfileDeleteSpec,
    PanelHardwareProfileMutationView, PanelHardwareProfileSaveSpec, PanelHardwareProfilesView,
    PanelHardwareTerminal, PanelProgramSpec, PanelShiftState, PanelTerminalEdit, Refusal,
};
use ksx_config::{ConfigRoot, Timestamp};
use ksx_platform::sha256::{hex_upper, Sha256};

use crate::panel_programming::{
    canonical_panel_key_name, ipac4_terminal, ipac4_terminal_signature, terminal_edits,
    IPAC4_DRIVER, IPAC4_PROTOCOL_PROFILE, IPAC4_TERMINALS, IPAC4_TERMINAL_COUNT,
};

const PROFILE_SCHEMA: &str = "ksx.panel-hardware-profile.v1";
const PROFILE_EXTENSION: &str = ".ksxpanel-profile.json";
const MAX_NAME_CHARS: usize = 80;
const MAX_DESCRIPTION_CHARS: usize = 500;
static TEMP_SERIAL: AtomicU64 = AtomicU64::new(0);

/// One compare-and-replace lease shared by Studio, CLI and any future
/// process. Atomic rename prevents a torn document; this lease prevents two
/// processes from both accepting the same revision before either rename.
struct PanelLayoutsLease {
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
    lease_name: String,
    #[cfg(not(windows))]
    file: Option<fs::File>,
    #[cfg(not(windows))]
    path: PathBuf,
}

fn process_layout_leases() -> &'static Mutex<BTreeSet<String>> {
    static LEASES: std::sync::OnceLock<Mutex<BTreeSet<String>>> = std::sync::OnceLock::new();
    LEASES.get_or_init(|| Mutex::new(BTreeSet::new()))
}

fn claim_process_layout_lease(name: &str) -> std::io::Result<()> {
    let mut leases = process_layout_leases()
        .lock()
        .map_err(|_| std::io::Error::other("the panel-layout lease registry is poisoned"))?;
    if !leases.insert(name.to_owned()) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::WouldBlock,
            "the panel-layouts store is already being changed",
        ));
    }
    Ok(())
}

fn release_process_layout_lease(name: &str) {
    if let Ok(mut leases) = process_layout_leases().lock() {
        leases.remove(name);
    }
}

fn layout_lease_name(dir: &Path) -> String {
    let absolute = if dir.is_absolute() {
        dir.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(dir)
    };
    let spelling = absolute
        .as_os_str()
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_uppercase();
    let mut hasher = Sha256::new();
    hasher.update(spelling.as_bytes());
    let digest = hex_upper(&hasher.finish());
    format!(
        r"Global\KeyboardSplitterXboxPro.PanelLayouts.v1.{}",
        &digest[..32]
    )
}

impl PanelLayoutsLease {
    #[cfg(windows)]
    fn acquire(dir: &Path) -> Result<Self, Refusal> {
        use windows_sys::Win32::Foundation::{WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT};
        use windows_sys::Win32::System::Threading::{CreateMutexW, WaitForSingleObject};

        let lease_name = layout_lease_name(dir);
        claim_process_layout_lease(&lease_name).map_err(layout_lease_refusal)?;
        let wide = lease_name
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        // SAFETY: null security attributes and a fixed NUL-terminated name.
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, wide.as_ptr()) };
        if handle.is_null() {
            release_process_layout_lease(&lease_name);
            return Err(layout_lease_refusal(std::io::Error::last_os_error()));
        }
        // Saved-layout actions are explicit UI/CLI operations. Refuse a
        // competing editor immediately rather than queueing a stale form.
        let wait = unsafe { WaitForSingleObject(handle, 0) };
        if wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED {
            Ok(Self { handle, lease_name })
        } else {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
            release_process_layout_lease(&lease_name);
            let error = if wait == WAIT_TIMEOUT {
                std::io::Error::new(
                    std::io::ErrorKind::WouldBlock,
                    "the panel-layouts store is already being changed",
                )
            } else {
                std::io::Error::other(format!("WaitForSingleObject returned {wait:#x}"))
            };
            Err(layout_lease_refusal(error))
        }
    }

    #[cfg(not(windows))]
    fn acquire(dir: &Path) -> Result<Self, Refusal> {
        fs::create_dir_all(dir).map_err(|error| {
            store_refusal(format!(
                "the panel-layouts folder {} could not be created: {error}",
                dir.display()
            ))
        })?;
        let lease_name = layout_lease_name(dir);
        claim_process_layout_lease(&lease_name).map_err(layout_lease_refusal)?;
        let path = dir.join(".panel-layouts.lock");
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => Ok(Self {
                lease_name,
                file: Some(file),
                path,
            }),
            Err(error) => {
                release_process_layout_lease(&lease_name);
                Err(layout_lease_refusal(error))
            }
        }
    }
}

impl Drop for PanelLayoutsLease {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::System::Threading::ReleaseMutex(self.handle);
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
        #[cfg(not(windows))]
        {
            drop(self.file.take());
            let _ = fs::remove_file(&self.path);
        }
        release_process_layout_lease(&self.lease_name);
    }
}

fn layout_lease_refusal(error: std::io::Error) -> Refusal {
    Refusal::with_remedy(
        ksx_api::codes::REFUSED,
        format!(
            "another KSX process is reading or changing saved encoder layouts ({error}); nothing was changed"
        ),
        "finish the other Encoder setup save/delete, refresh the saved layouts, and retry",
    )
}

fn bad_request(message: impl Into<String>, remedy: impl Into<String>) -> Refusal {
    Refusal::with_remedy(ksx_api::codes::BAD_REQUEST, message, remedy)
}

fn store_refusal(message: impl Into<String>) -> Refusal {
    Refusal::with_remedy(
        ksx_api::codes::REFUSED,
        message,
        "refresh Encoder setup and retry; if it still fails, make sure KSX can access its panel-layouts folder",
    )
}

fn root() -> Result<ConfigRoot, Refusal> {
    ConfigRoot::discover().map_err(|error| {
        store_refusal(format!(
            "KSX could not resolve the configuration root for saved encoder layouts: {error}"
        ))
    })
}

/// List saved hardware layouts from the active portable/installed config root.
pub fn profiles() -> Result<PanelHardwareProfilesView, Refusal> {
    profiles_at(&root()?)
}

/// Create or stale-safely update one saved hardware layout.
pub fn save(
    spec: &PanelHardwareProfileSaveSpec,
) -> Result<PanelHardwareProfileMutationView, Refusal> {
    save_at(&root()?, spec, Timestamp::now_utc())
}

/// Delete one saved layout without touching the physical encoder.
pub fn delete(
    spec: &PanelHardwareProfileDeleteSpec,
) -> Result<PanelHardwareProfileMutationView, Refusal> {
    delete_at(&root()?, spec)
}

/// Convert a complete live chart into the portable semantic profile model.
/// Opaque shift state is represented as no *active* shift role and remains
/// protected by baseline-sensitive programming. Opaque normal/alternate
/// actions refuse instead of becoming a destructive Unassigned guess.
pub fn terminals_from_chart(chart: &PanelChartView) -> Result<Vec<PanelHardwareTerminal>, Refusal> {
    if chart.terminals.len() != IPAC4_TERMINAL_COUNT {
        return Err(store_refusal(format!(
            "the live encoder chart returned {} of {IPAC4_TERMINAL_COUNT} terminal rows; no layout was saved",
            chart.terminals.len()
        )));
    }
    let mut terminals = Vec::with_capacity(IPAC4_TERMINAL_COUNT);
    for row in &chart.terminals {
        if !row.normal.supported || !row.shifted.supported {
            return Err(bad_request(
                format!(
                    "terminal {} contains a vendor action KSX cannot safely store as a portable key layout",
                    row.terminal_id
                ),
                "reconfigure that action to a served key or Unassigned, then read and save the chart again",
            ));
        }
        terminals.push(PanelHardwareTerminal {
            terminal_id: row.terminal_id.clone(),
            normal_key: row.normal.key.clone(),
            shifted_key: row.shifted.key.clone(),
            is_shift: row.shift_state == PanelShiftState::Enabled,
            allow_shared_key: false,
        });
    }

    // A chart can deliberately fan one keyboard action into several physical
    // terminals. Carry that acknowledgement so saving the *current* hardware
    // state does not reject a real, already-working arrangement.
    let mut repeated = BTreeSet::new();
    for shifted in [false, true] {
        let mut uses: BTreeMap<String, Vec<usize>> = BTreeMap::new();
        for (index, row) in terminals.iter().enumerate() {
            let key = if shifted {
                row.shifted_key.as_ref()
            } else {
                row.normal_key.as_ref()
            };
            if let Some(key) = key {
                uses.entry(key.to_ascii_uppercase())
                    .or_default()
                    .push(index);
            }
        }
        for indices in uses.into_values().filter(|indices| indices.len() > 1) {
            repeated.extend(indices);
        }
    }
    for index in repeated {
        terminals[index].allow_shared_key = true;
    }
    normalize_terminals(&terminals)
}

fn print_json<T: serde::Serialize>(value: &T) -> anyhow::Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn render_profiles(view: &PanelHardwareProfilesView) -> String {
    let mut out = format!("Saved encoder layouts\n{}\n", view.summary);
    for profile in &view.profiles {
        use std::fmt::Write as _;
        let _ = writeln!(
            out,
            "{}  {}  {} terminals\n  revision {}",
            profile.profile_id,
            profile.name,
            profile.terminals.len(),
            profile.revision
        );
    }
    out
}

fn render_mutation(view: &PanelHardwareProfileMutationView) -> String {
    format!("Saved encoder layout · {}\n{}\n", view.state, view.summary)
}

pub fn run_profiles_cli(json: bool) -> anyhow::Result<()> {
    let view = profiles()?;
    if json {
        print_json(&view)
    } else {
        print!("{}", render_profiles(&view));
        Ok(())
    }
}

/// Read the selected physical chart and save its complete supported semantic
/// state as a portable KSX layout. This sends the chart query only; it sends
/// no persistent hardware report.
pub fn run_profile_save_current_cli(
    device: Option<String>,
    name: String,
    description: String,
    profile_id: Option<String>,
    expected_revision: Option<String>,
    json: bool,
) -> anyhow::Result<()> {
    let chart = crate::panel_programming::chart(&PanelChartSpec {
        device,
        backup: false,
    })?;
    let view = save(&PanelHardwareProfileSaveSpec {
        profile_id,
        expected_revision,
        name,
        description,
        terminals: terminals_from_chart(&chart)?,
    })?;
    if json {
        print_json(&view)
    } else {
        print!("{}", render_mutation(&view));
        Ok(())
    }
}

pub fn run_profile_delete_cli(
    profile_id: String,
    expected_revision: String,
    json: bool,
) -> anyhow::Result<()> {
    let view = delete(&PanelHardwareProfileDeleteSpec {
        profile_id,
        expected_revision,
    })?;
    if json {
        print_json(&view)
    } else {
        print!("{}", render_mutation(&view));
        Ok(())
    }
}

fn timestamp_rfc3339(timestamp: Timestamp) -> String {
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        timestamp.year,
        timestamp.month,
        timestamp.day,
        timestamp.hour,
        timestamp.minute,
        timestamp.second
    )
}

fn safe_profile_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

fn profile_path(dir: &Path, profile_id: &str) -> Result<PathBuf, Refusal> {
    if !safe_profile_id(profile_id) {
        return Err(bad_request(
            format!("'{profile_id}' is not a saved encoder layout id"),
            "refresh Encoder setup and choose the saved layout again",
        ));
    }
    Ok(dir.join(format!("{profile_id}{PROFILE_EXTENSION}")))
}

fn slug(name: &str) -> String {
    let mut out = String::new();
    let mut separator = false;
    for character in name.chars() {
        if character.is_ascii_alphanumeric() {
            if separator && !out.is_empty() {
                out.push('-');
            }
            separator = false;
            out.push(character.to_ascii_lowercase());
        } else {
            separator = true;
        }
        if out.len() >= 48 {
            break;
        }
    }
    let out = out.trim_matches('-');
    if out.is_empty() {
        "panel-layout".to_owned()
    } else {
        out.to_owned()
    }
}

fn next_profile_id(name: &str, occupied: &BTreeSet<String>) -> String {
    let base = slug(name);
    if !occupied.contains(&base) {
        return base;
    }
    for suffix in 2usize.. {
        let candidate = format!("{base}-{suffix}");
        if !occupied.contains(&candidate) && candidate.len() <= 64 {
            return candidate;
        }
    }
    unreachable!("the finite profile directory cannot occupy every usize suffix")
}

fn normalize_optional_key(value: &Option<String>) -> Result<Option<String>, Refusal> {
    match value {
        Some(value) => canonical_panel_key_name(value),
        None => Ok(None),
    }
}

fn normalize_terminals(
    terminals: &[PanelHardwareTerminal],
) -> Result<Vec<PanelHardwareTerminal>, Refusal> {
    if terminals.len() != IPAC4_TERMINAL_COUNT {
        return Err(bad_request(
            format!(
                "a complete I-PAC 4 layout needs exactly {IPAC4_TERMINAL_COUNT} terminal rows; received {}",
                terminals.len()
            ),
            "refresh the complete terminal chart before saving the layout",
        ));
    }

    let mut by_id = BTreeMap::new();
    for row in terminals {
        let terminal_id = row.terminal_id.trim().to_ascii_lowercase();
        if ipac4_terminal(&terminal_id).is_none() {
            return Err(bad_request(
                format!("'{}' is not a physical I-PAC 4 terminal", row.terminal_id),
                "refresh the complete terminal chart before saving the layout",
            ));
        }
        let normalized = PanelHardwareTerminal {
            terminal_id: terminal_id.clone(),
            normal_key: normalize_optional_key(&row.normal_key)?,
            shifted_key: normalize_optional_key(&row.shifted_key)?,
            is_shift: row.is_shift,
            allow_shared_key: row.allow_shared_key,
        };
        if by_id.insert(terminal_id.clone(), normalized).is_some() {
            return Err(bad_request(
                format!("terminal {terminal_id} appears more than once in the saved layout"),
                "keep exactly one row for every physical terminal",
            ));
        }
    }

    let mut normalized = Vec::with_capacity(IPAC4_TERMINAL_COUNT);
    for terminal in IPAC4_TERMINALS {
        let Some(row) = by_id.remove(terminal.id) else {
            return Err(bad_request(
                format!("terminal {} is missing from the saved layout", terminal.id),
                "refresh the complete terminal chart before saving the layout",
            ));
        };
        normalized.push(row);
    }

    // Reuse the hardware planner's key and deliberate-fan-in validation. A
    // profile is complete, so every None is sent as an explicit clear rather
    // than the sparse custom editor's "unchanged".
    let edits = normalized
        .iter()
        .map(|row| PanelTerminalEdit {
            terminal_id: row.terminal_id.clone(),
            normal_key: Some(row.normal_key.clone().unwrap_or_default()),
            shifted_key: Some(row.shifted_key.clone().unwrap_or_default()),
            is_shift: Some(row.is_shift),
            allow_shared_key: row.allow_shared_key,
        })
        .collect();
    terminal_edits(&PanelProgramSpec {
        layout: "custom".to_owned(),
        edits,
        ..Default::default()
    })?;
    Ok(normalized)
}

fn normalize_name(name: &str) -> Result<String, Refusal> {
    let name = name.trim();
    if name.is_empty() {
        return Err(bad_request(
            "a saved encoder layout needs a name",
            "give the layout a short name you will recognize",
        ));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(bad_request(
            format!("an encoder layout name can be at most {MAX_NAME_CHARS} characters"),
            "shorten the layout name and save again",
        ));
    }
    Ok(name.to_owned())
}

fn normalize_description(description: &str) -> Result<String, Refusal> {
    let description = description.trim();
    if description.chars().count() > MAX_DESCRIPTION_CHARS {
        return Err(bad_request(
            format!(
                "an encoder layout description can be at most {MAX_DESCRIPTION_CHARS} characters"
            ),
            "shorten the description and save again",
        ));
    }
    Ok(description.to_owned())
}

fn profile_revision(profile: &PanelHardwareProfile) -> String {
    let mut content = profile.clone();
    content.revision.clear();
    let bytes =
        serde_json::to_vec(&content).unwrap_or_else(|_| format!("{content:?}").into_bytes());
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    format!("hp1-{}", hex_upper(&hasher.finish()))
}

fn validate_loaded(profile: PanelHardwareProfile) -> Result<PanelHardwareProfile, Refusal> {
    if profile.schema != PROFILE_SCHEMA
        || profile.driver != IPAC4_DRIVER
        || profile.protocol_profile != IPAC4_PROTOCOL_PROFILE
        || profile.terminal_signature != ipac4_terminal_signature()
        || !safe_profile_id(&profile.profile_id)
        || profile.created_at.trim().is_empty()
        || profile.updated_at.trim().is_empty()
    {
        return Err(store_refusal(format!(
            "saved encoder layout '{}' does not match the supported profile schema",
            profile.profile_id
        )));
    }
    let normalized_name = normalize_name(&profile.name)?;
    let normalized_description = normalize_description(&profile.description)?;
    let normalized_terminals = normalize_terminals(&profile.terminals)?;
    if normalized_name != profile.name
        || normalized_description != profile.description
        || normalized_terminals != profile.terminals
        || profile_revision(&profile) != profile.revision
    {
        return Err(store_refusal(format!(
            "saved encoder layout '{}' is not a complete canonical KSX document",
            profile.profile_id
        )));
    }
    Ok(profile)
}

fn read_profile(path: &Path) -> Result<PanelHardwareProfile, Refusal> {
    let bytes = fs::read(path).map_err(|error| {
        store_refusal(format!(
            "saved encoder layout {} could not be read: {error}",
            path.display()
        ))
    })?;
    let profile: PanelHardwareProfile = serde_json::from_slice(&bytes).map_err(|error| {
        store_refusal(format!(
            "saved encoder layout {} is not valid JSON: {error}",
            path.display()
        ))
    })?;
    let profile = validate_loaded(profile)?;
    let expected_name = format!("{}{}", profile.profile_id, PROFILE_EXTENSION);
    if path.file_name().and_then(|name| name.to_str()) != Some(expected_name.as_str()) {
        return Err(store_refusal(format!(
            "saved encoder layout {} does not match the profile id inside it",
            path.display()
        )));
    }
    Ok(profile)
}

fn list_dir(dir: &Path) -> Result<Vec<PanelHardwareProfile>, Refusal> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    if !dir.is_dir() {
        return Err(store_refusal(format!(
            "the panel-layouts path {} is not a directory",
            dir.display()
        )));
    }
    let mut paths = fs::read_dir(dir)
        .map_err(|error| {
            store_refusal(format!(
                "saved encoder layouts in {} could not be listed: {error}",
                dir.display()
            ))
        })?
        .map(|entry| {
            entry.map(|entry| entry.path()).map_err(|error| {
                store_refusal(format!(
                    "a saved encoder layout entry in {} could not be read: {error}",
                    dir.display()
                ))
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    paths.sort();

    let mut profiles = Vec::new();
    for path in paths {
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if name.ends_with(PROFILE_EXTENSION) {
            profiles.push(read_profile(&path)?);
        }
    }
    profiles.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| left.profile_id.cmp(&right.profile_id))
    });
    Ok(profiles)
}

fn profiles_at(root: &ConfigRoot) -> Result<PanelHardwareProfilesView, Refusal> {
    let _lease = PanelLayoutsLease::acquire(&root.panel_layouts_dir())?;
    let profiles = list_dir(&root.panel_layouts_dir())?;
    Ok(PanelHardwareProfilesView {
        summary: format!(
            "{} saved encoder layout{}.",
            profiles.len(),
            if profiles.len() == 1 { "" } else { "s" }
        ),
        config_root: root.panel_layouts_dir().display().to_string(),
        terminal_signature: ipac4_terminal_signature(),
        profiles,
    })
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), Refusal> {
    let Some(parent) = path.parent() else {
        return Err(store_refusal(
            "the saved encoder layout has no parent folder",
        ));
    };
    fs::create_dir_all(parent).map_err(|error| {
        store_refusal(format!(
            "the panel-layouts folder {} could not be created: {error}",
            parent.display()
        ))
    })?;
    let serial = TEMP_SERIAL.fetch_add(1, Ordering::Relaxed);
    let temp = parent.join(format!(".panel-layout.tmp-{}-{serial}", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|error| {
                store_refusal(format!(
                    "a temporary encoder layout could not be created in {}: {error}",
                    parent.display()
                ))
            })?;
        file.write_all(bytes).map_err(|error| {
            store_refusal(format!(
                "the temporary encoder layout could not be written: {error}"
            ))
        })?;
        file.sync_all().map_err(|error| {
            store_refusal(format!(
                "the temporary encoder layout could not be made durable: {error}"
            ))
        })?;
        drop(file);
        fs::rename(&temp, path).map_err(|error| {
            store_refusal(format!(
                "the saved encoder layout could not be replaced atomically: {error}"
            ))
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn duplicate_name(profiles: &[PanelHardwareProfile], name: &str, except_id: Option<&str>) -> bool {
    profiles.iter().any(|profile| {
        Some(profile.profile_id.as_str()) != except_id && profile.name.eq_ignore_ascii_case(name)
    })
}

fn save_at(
    root: &ConfigRoot,
    spec: &PanelHardwareProfileSaveSpec,
    timestamp: Timestamp,
) -> Result<PanelHardwareProfileMutationView, Refusal> {
    let dir = root.panel_layouts_dir();
    let _lease = PanelLayoutsLease::acquire(&dir)?;
    let existing = list_dir(&dir)?;
    let name = normalize_name(&spec.name)?;
    let description = normalize_description(&spec.description)?;
    let terminals = normalize_terminals(&spec.terminals)?;
    let now = timestamp_rfc3339(timestamp);

    let (profile_id, created_at, state, current) = match (
        spec.profile_id.as_deref(),
        spec.expected_revision.as_deref(),
    ) {
        (None, None) => {
            if duplicate_name(&existing, &name, None) {
                return Err(bad_request(
                    format!("a saved encoder layout called '{name}' already exists"),
                    "choose a distinct name, or update the existing saved layout",
                ));
            }
            let occupied = existing
                .iter()
                .map(|profile| profile.profile_id.clone())
                .collect();
            (
                next_profile_id(&name, &occupied),
                now.clone(),
                "created",
                None,
            )
        }
        (Some(profile_id), Some(expected_revision)) => {
            let path = profile_path(&dir, profile_id)?;
            let current = read_profile(&path)?;
            if current.revision != expected_revision {
                return Err(Refusal::with_remedy(
                    ksx_api::codes::REFUSED,
                    format!(
                        "saved encoder layout '{}' changed while this edit was open; nothing was written",
                        current.name
                    ),
                    "refresh Encoder setup, review the newer layout, and apply the edit again",
                ));
            }
            if duplicate_name(&existing, &name, Some(profile_id)) {
                return Err(bad_request(
                    format!("a saved encoder layout called '{name}' already exists"),
                    "choose a distinct name, or update that saved layout instead",
                ));
            }
            (
                current.profile_id.clone(),
                current.created_at.clone(),
                "updated",
                Some(current),
            )
        }
        _ => {
            return Err(bad_request(
                "a saved encoder layout update needs both its id and exact revision",
                "refresh Encoder setup and save the layout again",
            ));
        }
    };

    let mut profile = PanelHardwareProfile {
        schema: PROFILE_SCHEMA.to_owned(),
        profile_id: profile_id.clone(),
        name,
        description,
        driver: IPAC4_DRIVER.to_owned(),
        protocol_profile: IPAC4_PROTOCOL_PROFILE.to_owned(),
        terminal_signature: ipac4_terminal_signature(),
        revision: String::new(),
        created_at,
        updated_at: now,
        terminals,
    };

    if let Some(current) = current.as_ref() {
        if current.name == profile.name
            && current.description == profile.description
            && current.terminals == profile.terminals
        {
            return Ok(PanelHardwareProfileMutationView {
                state: "unchanged".to_owned(),
                summary: format!(
                    "saved encoder layout '{}' is already up to date",
                    current.name
                ),
                profile_id,
                profile: Some(current.clone()),
            });
        }
    }

    profile.revision = profile_revision(&profile);
    let bytes = serde_json::to_vec_pretty(&profile).map_err(|error| {
        store_refusal(format!(
            "the saved encoder layout could not be encoded: {error}"
        ))
    })?;
    write_atomic(&profile_path(&dir, &profile.profile_id)?, &bytes)?;
    Ok(PanelHardwareProfileMutationView {
        state: state.to_owned(),
        summary: format!("{state} saved encoder layout '{}'", profile.name),
        profile_id,
        profile: Some(profile),
    })
}

fn delete_at(
    root: &ConfigRoot,
    spec: &PanelHardwareProfileDeleteSpec,
) -> Result<PanelHardwareProfileMutationView, Refusal> {
    let dir = root.panel_layouts_dir();
    let _lease = PanelLayoutsLease::acquire(&dir)?;
    let path = profile_path(&dir, spec.profile_id.trim())?;
    let current = read_profile(&path)?;
    if current.revision != spec.expected_revision {
        return Err(Refusal::with_remedy(
            ksx_api::codes::REFUSED,
            format!(
                "saved encoder layout '{}' changed while deletion was being confirmed; nothing was deleted",
                current.name
            ),
            "refresh Encoder setup, review the newer layout, and confirm deletion again",
        ));
    }
    fs::remove_file(&path).map_err(|error| {
        store_refusal(format!(
            "saved encoder layout '{}' could not be deleted: {error}",
            current.name
        ))
    })?;
    Ok(PanelHardwareProfileMutationView {
        state: "deleted".to_owned(),
        summary: format!(
            "deleted saved encoder layout '{}' — the physical encoder was not changed",
            current.name
        ),
        profile_id: current.profile_id,
        profile: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_SERIAL: AtomicU64 = AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let serial = TEST_SERIAL.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "ksx-panel-profiles-{}-{label}-{serial}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn stamp(second: u8) -> Timestamp {
        Timestamp {
            year: 2026,
            month: 8,
            day: 23,
            hour: 18,
            minute: 0,
            second,
        }
    }

    fn terminals() -> Vec<PanelHardwareTerminal> {
        IPAC4_TERMINALS
            .iter()
            .enumerate()
            .map(|(index, terminal)| PanelHardwareTerminal {
                terminal_id: terminal.id.to_owned(),
                normal_key: (index == 0).then(|| "j".to_owned()),
                shifted_key: None,
                is_shift: false,
                allow_shared_key: false,
            })
            .collect()
    }

    fn create_spec(name: &str) -> PanelHardwareProfileSaveSpec {
        PanelHardwareProfileSaveSpec {
            name: name.to_owned(),
            description: "Four-player cabinet".to_owned(),
            terminals: terminals(),
            ..Default::default()
        }
    }

    fn chart() -> PanelChartView {
        PanelChartView {
            terminals: IPAC4_TERMINALS
                .iter()
                .enumerate()
                .map(|(index, terminal)| ksx_api::PanelTerminalRow {
                    terminal_id: terminal.id.to_owned(),
                    normal: ksx_api::PanelKeyValue {
                        key: (index < 2).then(|| "J".to_owned()),
                        label: if index < 2 { "J" } else { "Unassigned" }.to_owned(),
                        supported: true,
                        ..Default::default()
                    },
                    shifted: ksx_api::PanelKeyValue {
                        label: "Unassigned".to_owned(),
                        supported: true,
                        ..Default::default()
                    },
                    shift_state: if index == 0 {
                        PanelShiftState::Enabled
                    } else if index == 1 {
                        PanelShiftState::Opaque
                    } else {
                        PanelShiftState::Disabled
                    },
                    is_shift: index == 0,
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn create_normalizes_and_persists_one_complete_atomic_document() {
        let dir = TestDir::new("create");
        let root = ConfigRoot::at(&dir.0);
        let outcome = save_at(&root, &create_spec("  Tournament Panel  "), stamp(1)).unwrap();
        assert_eq!(outcome.state, "created");
        let profile = outcome.profile.unwrap();
        assert_eq!(profile.profile_id, "tournament-panel");
        assert_eq!(profile.name, "Tournament Panel");
        assert_eq!(profile.terminals.len(), IPAC4_TERMINAL_COUNT);
        assert_eq!(profile.terminals[0].normal_key.as_deref(), Some("J"));
        assert!(profile.revision.starts_with("hp1-"));
        assert_eq!(profiles_at(&root).unwrap().profiles, vec![profile]);
        assert!(fs::read_dir(root.panel_layouts_dir())
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".tmp-")));
    }

    #[test]
    fn current_chart_conversion_keeps_fan_in_and_never_promotes_opaque_shift() {
        let rows = terminals_from_chart(&chart()).unwrap();
        assert_eq!(rows.len(), IPAC4_TERMINAL_COUNT);
        assert!(rows[0].is_shift);
        assert!(!rows[1].is_shift, "opaque is not a known enabled role");
        assert!(rows[0].allow_shared_key && rows[1].allow_shared_key);

        let mut unsupported = chart();
        unsupported.terminals[0].normal.supported = false;
        unsupported.terminals[0].normal.key = None;
        assert!(terminals_from_chart(&unsupported).is_err());
    }

    /// Catches the broken implementation that trusted an edit form's old
    /// copy and silently replaced a newer save.
    #[test]
    fn update_and_delete_refuse_stale_revisions() {
        let dir = TestDir::new("stale");
        let root = ConfigRoot::at(&dir.0);
        let created = save_at(&root, &create_spec("Cabinet"), stamp(1))
            .unwrap()
            .profile
            .unwrap();
        let mut update = create_spec("Cabinet v2");
        update.profile_id = Some(created.profile_id.clone());
        update.expected_revision = Some(created.revision.clone());
        let updated = save_at(&root, &update, stamp(2)).unwrap().profile.unwrap();
        assert_ne!(created.revision, updated.revision);
        assert!(save_at(&root, &update, stamp(3)).is_err());
        assert!(delete_at(
            &root,
            &PanelHardwareProfileDeleteSpec {
                profile_id: created.profile_id,
                expected_revision: created.revision,
            }
        )
        .is_err());
        assert_eq!(profiles_at(&root).unwrap().profiles, vec![updated]);
    }

    /// Catches the broken process-local-only CAS: Studio and CLI could both
    /// accept revision A and the last atomic rename silently won. Holding the
    /// path-scoped lease stands in for that other process deterministically.
    #[test]
    fn cross_process_lease_spans_list_revision_check_replace_and_delete() {
        let dir = TestDir::new("lease");
        let root = ConfigRoot::at(&dir.0);
        let created = save_at(&root, &create_spec("Cabinet"), stamp(1))
            .unwrap()
            .profile
            .unwrap();
        let mut update = create_spec("Cabinet v2");
        update.profile_id = Some(created.profile_id.clone());
        update.expected_revision = Some(created.revision.clone());
        let delete = PanelHardwareProfileDeleteSpec {
            profile_id: created.profile_id.clone(),
            expected_revision: created.revision.clone(),
        };

        let lease = PanelLayoutsLease::acquire(&root.panel_layouts_dir()).unwrap();
        assert!(
            profiles_at(&root).is_err(),
            "a read must not race a replace"
        );
        assert!(
            save_at(&root, &update, stamp(2)).is_err(),
            "the second process must not pass the same revision gate"
        );
        assert!(
            delete_at(&root, &delete).is_err(),
            "delete must share the same store lease"
        );
        drop(lease);

        let updated = save_at(&root, &update, stamp(2)).unwrap();
        assert_eq!(updated.state, "updated");
    }

    #[test]
    fn complete_profiles_reject_missing_unknown_and_accidental_shared_keys() {
        let dir = TestDir::new("validation");
        let root = ConfigRoot::at(&dir.0);
        let mut missing = create_spec("Missing");
        missing.terminals.pop();
        assert!(save_at(&root, &missing, stamp(1)).is_err());

        let mut shared = create_spec("Shared");
        shared.terminals[1].normal_key = Some("J".to_owned());
        assert!(save_at(&root, &shared, stamp(1)).is_err());
        shared.terminals[0].allow_shared_key = true;
        shared.terminals[1].allow_shared_key = true;
        assert!(save_at(&root, &shared, stamp(1)).is_ok());
    }

    /// Catches treating a corrupt/unreadable file as an empty list.
    #[test]
    fn one_broken_profile_makes_the_read_explicitly_fail() {
        let dir = TestDir::new("corrupt");
        let root = ConfigRoot::at(&dir.0);
        fs::create_dir_all(root.panel_layouts_dir()).unwrap();
        fs::write(
            root.panel_layouts_dir()
                .join(format!("broken{PROFILE_EXTENSION}")),
            b"{not-json",
        )
        .unwrap();
        assert!(profiles_at(&root).is_err());
    }

    #[test]
    fn delete_removes_only_the_saved_profile_not_hardware_or_other_layouts() {
        let dir = TestDir::new("delete");
        let root = ConfigRoot::at(&dir.0);
        let one = save_at(&root, &create_spec("One"), stamp(1))
            .unwrap()
            .profile
            .unwrap();
        let two = save_at(&root, &create_spec("Two"), stamp(2))
            .unwrap()
            .profile
            .unwrap();
        let outcome = delete_at(
            &root,
            &PanelHardwareProfileDeleteSpec {
                profile_id: one.profile_id,
                expected_revision: one.revision,
            },
        )
        .unwrap();
        assert_eq!(outcome.state, "deleted");
        assert_eq!(profiles_at(&root).unwrap().profiles, vec![two]);
    }
}
