//! `packaging/ksx.iss` and the release workflow, as tests.
//!
//! # Why a Rust test crate reads an Inno Setup script
//!
//! Two reasons, and neither is tidiness.
//!
//! 1. **The installer is moment 2 of `docs/FIRST-RUN.md` §1, and nothing else
//!    in this repository fails when it regresses.** §4 states four things the
//!    installer must do; each is one word or one flag on one line, each was
//!    WRONG at the audit that produced that file, and each is the kind of edit
//!    made in passing while fixing something else. ISCC compiles every broken
//!    version happily — a setup.exe that hands a first-run user a diagnostic
//!    is not a build failure, it is a working build of the wrong product.
//! 2. **ISCC does not run on the machine this is developed on.** The
//!    `release-binary` CI job is the only compile check the script gets, and it
//!    runs after the whole test suite. These are the part of that check that
//!    runs in milliseconds, on any platform, beside the code the installer
//!    launches.
//!
//! They do NOT re-encode the file. They assert the four sentences of §4 and one
//! landmine from `CLAUDE.md`. Everything else about the script — compression,
//! the driver payload, the uninstall hook, every comment — is free to change
//! without touching this file.
//!
//! # And why it also reads `.github/workflows/`
//!
//! Moment 2 is only reachable through moment 1: "a `.exe` from the releases
//! page. One file." The installer this file guards is built by
//! `build-installer.yml` and published by `release.yml`, and **both of those
//! run on a runner that no local command reproduces** — `release.yml` fires on
//! a tag push and on nothing else, so an ordinary branch push never executes a
//! line of it. Its first execution is a real release, of a real version number,
//! for real customers, and a version number spent on a failed run is spent.
//!
//! So the parts of it that can be checked without running it, are:
//!
//! - the version in `ksx.iss` and the version in `Cargo.toml` agree, which is
//!   the precondition the tag has to satisfy;
//! - the trigger really is a pushed tag, in a pattern this repo's own version
//!   can produce;
//! - the file that gets attached is the installer `ksx.iss` actually emits;
//! - the release body says how to verify the download, and what the unsigned
//!   installer's SmartScreen dialog is.
//!
//! Line endings: the script is CRLF in a Windows checkout and LF in a fresh
//! clone elsewhere, so every line is `trim()`ed before it is read. A test that
//! compared against `"\n"` would pass here and fail on CI, which this
//! repository has already paid for (`CLAUDE.md`, "Windows/CRLF").

use std::path::{Path, PathBuf};

/// The repository root: this crate is `<root>/crates/ksx-app`.
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crates/ksx-app is two levels below the repo root")
        .to_path_buf()
}

fn script() -> String {
    let path = repo_root().join("packaging").join("ksx.iss");
    std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("{} could not be read: {err}", path.display()))
}

fn read(relative: &str) -> String {
    let path = repo_root().join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
    std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("{} could not be read: {err}", path.display()))
}

fn workflow(name: &str) -> String {
    read(&format!(".github/workflows/{name}"))
}

/// Every meaningful line of one `[Section]`, in order: comments and blanks
/// dropped, each line trimmed.
///
/// A `;` comment in an `.iss` occupies a whole line — Inno has no trailing
/// comment form outside `[Code]` — so dropping lines that begin with one is the
/// entire parser this needs.
fn section(text: &str, want: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut inside = false;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with(';') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            inside = line.eq_ignore_ascii_case(want);
            continue;
        }
        if inside {
            out.push(line.to_owned());
        }
    }
    assert!(!out.is_empty(), "{want} is missing or empty in ksx.iss");
    out
}

/// One entry line's `Key: value` fields, split on the semicolons that are not
/// inside a quoted value.
fn fields(entry: &str) -> Vec<(String, String)> {
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for c in entry.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                current.push(c);
            }
            ';' if !quoted => {
                parts.push(std::mem::take(&mut current));
            }
            _ => current.push(c),
        }
    }
    parts.push(current);

    parts
        .iter()
        .filter_map(|part| {
            let (key, value) = part.split_once(':')?;
            let value = value.trim();
            // Inno doubles an embedded quote; the outer pair is the delimiter.
            let value = value
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .unwrap_or(value);
            Some((key.trim().to_owned(), value.to_owned()))
        })
        .collect()
}

/// The value of one field, or `None` if the entry does not carry it.
fn field(entry: &str, key: &str) -> Option<String> {
    fields(entry)
        .into_iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(key))
        .map(|(_, value)| value)
}

/// The value of a `#define NAME "value"` line.
fn define(text: &str, name: &str) -> String {
    text.lines()
        .find_map(|line| {
            let rest = line.trim().strip_prefix("#define")?.trim_start();
            let rest = rest.strip_prefix(name)?;
            if !rest.starts_with(char::is_whitespace) {
                return None;
            }
            Some(rest.trim().trim_matches('"').to_owned())
        })
        .unwrap_or_else(|| panic!("ksx.iss has no `#define {name}`"))
}

/// `{#AppName}-{#AppVersion}-setup` → `ksx-0.2.0-setup`.
fn expand(text: &str, value: &str) -> String {
    let mut out = String::new();
    let mut rest = value;
    while let Some(at) = rest.find("{#") {
        out.push_str(&rest[..at]);
        let tail = &rest[at + 2..];
        let end = tail
            .find('}')
            .unwrap_or_else(|| panic!("unterminated `{{#` in ksx.iss: {value}"));
        out.push_str(&define(text, &tail[..end]));
        rest = &tail[end + 1..];
    }
    out.push_str(rest);
    out
}

/// The value of one `Key=Value` line in `[Setup]`, with `{#defines}` expanded.
fn setup_value(text: &str, key: &str) -> String {
    let line = section(text, "[Setup]")
        .into_iter()
        .find(|line| {
            line.split_once('=')
                .is_some_and(|(k, _)| k.trim().eq_ignore_ascii_case(key))
        })
        .unwrap_or_else(|| panic!("[Setup] has no {key}"));
    let (_, value) = line.split_once('=').expect("matched above");
    expand(text, value.trim())
}

/// `[workspace.package] version` from the workspace manifest.
fn workspace_version() -> String {
    let manifest = read("Cargo.toml");
    let mut inside = false;
    for line in manifest.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            inside = line == "[workspace.package]";
            continue;
        }
        if inside {
            if let Some(value) = line
                .strip_prefix("version")
                .and_then(|rest| rest.trim_start().strip_prefix('='))
            {
                return value.trim().trim_matches('"').to_owned();
            }
        }
    }
    panic!("Cargo.toml has no [workspace.package] version")
}

// ---------------------------------------------------------------------------
// A YAML subset, which is not a YAML parser
// ---------------------------------------------------------------------------
//
// Block mappings, block sequences, and `- key: value` step lists: everything
// the three workflow files in this repository use, and nothing else. It is here
// so the tests below can assert STRUCTURE — "the only trigger is a tag push" —
// rather than substrings — "the file contains the word tags". The second kind
// passes against a workflow that mentions tags in a comment and publishes on
// every push to main.
//
// A dev-dependency on a YAML crate would be the other way to get this. It is
// forty lines against a new dependency in the crate `docs/GATES.md` watches, on
// a file format three files use, so: forty lines.

/// A line's leading-space count.
fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// One line with any trailing `# comment` removed. Quotes are tracked, so a `#`
/// inside a string stays.
fn strip_comment(line: &str) -> &str {
    let bytes = line.as_bytes();
    let mut quote: Option<u8> = None;
    for (at, byte) in bytes.iter().enumerate() {
        match byte {
            b'\'' | b'"' => match quote {
                Some(open) if open == *byte => quote = None,
                None => quote = Some(*byte),
                _ => {}
            },
            b'#' if quote.is_none() && (at == 0 || bytes[at - 1] == b' ') => {
                return line[..at].trim_end();
            }
            _ => {}
        }
    }
    line.trim_end()
}

/// A workflow's meaningful lines: blanks and comments gone, indentation kept.
fn yaml_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(strip_comment)
        .filter(|line| !line.trim().is_empty())
        .map(str::to_owned)
        .collect()
}

/// The lines nested under a key path, e.g. `["on", "push"]`.
fn yaml_block(lines: &[String], path: &[&str]) -> Vec<String> {
    let mut current = lines.to_vec();
    for key in path {
        let base = current
            .iter()
            .map(|line| indent_of(line))
            .min()
            .unwrap_or_else(|| panic!("nothing is nested under {path:?}"));
        let at = current
            .iter()
            .position(|line| {
                indent_of(line) == base
                    && line
                        .trim_start()
                        .strip_prefix(key)
                        .is_some_and(|rest| rest.starts_with(':'))
            })
            .unwrap_or_else(|| panic!("no `{key}:` where {path:?} expects one"));
        current = current[at + 1..]
            .iter()
            // A sequence may sit at its key's own indentation, so `- ` counts as
            // inside the block too.
            .take_while(|line| {
                indent_of(line) > base
                    || (indent_of(line) == base && line.trim_start().starts_with("- "))
            })
            .cloned()
            .collect();
    }
    current
}

/// The keys of the mapping at the top level of `lines`.
fn yaml_keys(lines: &[String]) -> Vec<String> {
    let Some(base) = lines.iter().map(|line| indent_of(line)).min() else {
        return Vec::new();
    };
    lines
        .iter()
        .filter(|line| indent_of(line) == base)
        .filter_map(|line| {
            let line = line.trim_start();
            if line.starts_with("- ") {
                return None;
            }
            Some(line.split_once(':')?.0.trim().to_owned())
        })
        .collect()
}

/// The items of the sequence at the top level of `lines`, unquoted.
fn yaml_items(lines: &[String]) -> Vec<String> {
    let Some(base) = lines.iter().map(|line| indent_of(line)).min() else {
        return Vec::new();
    };
    lines
        .iter()
        .filter(|line| indent_of(line) == base)
        .filter_map(|line| line.trim_start().strip_prefix("- "))
        .map(|item| item.trim().trim_matches(['\'', '"']).to_owned())
        .collect()
}

/// `(artifact name, path)` for every `actions/<verb>-artifact` step in a
/// workflow. `verb` is `upload` or `download`.
fn artifact_steps(text: &str, verb: &str) -> Vec<(String, String)> {
    let lines = yaml_lines(text);
    let marker = format!("uses: actions/{verb}-artifact");
    lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line.contains(&marker))
        .map(|(at, line)| {
            let base = indent_of(line);
            let body: Vec<&String> = lines[at + 1..]
                .iter()
                .take_while(|line| indent_of(line) > base)
                .collect();
            let value = |key: &str| -> String {
                body.iter()
                    .find_map(|line| {
                        line.trim_start()
                            .strip_prefix(key)?
                            .strip_prefix(':')
                            .map(|value| value.trim().trim_matches(['\'', '"']).to_owned())
                    })
                    .unwrap_or_default()
            };
            (value("name"), value("path"))
        })
        .collect()
}

/// The placeholders `release.yml` actually substitutes: the `{{NAME}}` of every
/// `.Replace('{{NAME}}', …)` call.
///
/// NOT every `{{NAME}}` the file mentions. The comment above that step names one
/// as an example of the failure it prevents, and a placeholder named in a
/// comment substitutes nothing — which is exactly how the first version of this
/// scan passed against a template carrying the placeholder from that example.
fn substituted_placeholders(release: &str) -> Vec<String> {
    const CALL: &str = ".Replace('{{";
    let mut out = Vec::new();
    let mut rest = release;
    while let Some(at) = rest.find(CALL) {
        let tail = &rest[at + CALL.len()..];
        let Some(end) = tail.find("}}'") else { break };
        out.push(tail[..end].to_owned());
        rest = &tail[end..];
    }
    out
}

/// `*` matches any run of characters. Nothing else is special — these are two
/// patterns out of two files, not a shell.
fn glob_matches(pattern: &str, text: &str) -> bool {
    match pattern.split_once('*') {
        None => pattern == text,
        Some((head, tail)) => text.strip_prefix(head).is_some_and(|rest| {
            (0..=rest.len()).any(|at| rest.is_char_boundary(at) && glob_matches(tail, &rest[at..]))
        }),
    }
}

/// **The post-install offer hands over the product without opening a console.**
///
/// Fails against the audited version, whose only `[Run]` line was
/// `Parameters: "doctor"; Description: "Check drivers and hardware now (ksx
/// doctor)"`. A user who ticked the single checkbox the installer offers got a
/// console of driver tables — a developer verb — as their first sight of ksx.
#[test]
fn the_post_install_offer_uses_the_console_free_launcher() {
    let text = script();
    let run = section(&text, "[Run]");
    let offers: Vec<&String> = run
        .iter()
        .filter(|line| {
            field(line.as_str(), "Flags").is_some_and(|flags| flags.contains("postinstall"))
        })
        .collect();
    assert_eq!(
        offers.len(),
        1,
        "exactly one post-install offer, or a first-run user is ranking checkboxes again: {run:?}"
    );
    let offer = offers[0];
    assert_eq!(
        field(offer, "Filename").as_deref(),
        Some("{app}\\{#LauncherExe}"),
        "the hand-off must target the GUI-subsystem launcher, not console-subsystem \
         ksx.exe: {offer}"
    );
    assert_eq!(
        field(offer, "Parameters"),
        None,
        "the launcher owns the one customer action (`ksx.exe open`), so the \
         installer must not carry a second argument contract: {offer}"
    );
    let flags = field(offer, "Flags").unwrap_or_default();
    for required in ["nowait", "runasoriginaluser"] {
        assert!(
            flags.split_whitespace().any(|flag| flag == required),
            "the post-install launcher needs `{required}`: {offer}"
        );
    }
    for line in &run {
        assert_ne!(
            field(line, "Parameters").as_deref(),
            Some("doctor"),
            "no [Run] entry may run the diagnostic: {line}"
        );
    }
}

/// The installer's last page must hand off to the guided app, not a
/// terminal-first Quickstart. Engineering docs are installed for support, but
/// they are not the customer hand-off.
#[test]
fn the_installer_does_not_show_a_cli_runbook_after_install() {
    let text = script();
    let setup = section(&text, "[Setup]");
    assert!(
        !setup.iter().any(|line| line.starts_with("InfoAfterFile=")),
        "Finish must hand off to the app, not render a Markdown/CLI runbook: {setup:?}"
    );
}

/// **The desktop icon is on by default; the customer installer has no PATH
/// integration at all.**
///
/// Fails against the audited version in both directions at once: `desktopicon`
/// carried `Flags: unchecked` — so declining the launch prompt left nothing on
/// screen and a Start menu to hunt through — and `addtopath` carried no flag at
/// all, so every install edited a machine-wide environment variable to buy a
/// customer who never opens a shell precisely nothing.
#[test]
fn the_desktop_icon_is_default_and_path_is_not_a_customer_task() {
    let text = script();
    let tasks = section(&text, "[Tasks]");
    let find = |name: &str| -> String {
        tasks
            .iter()
            .find(|line| field(line.as_str(), "Name").as_deref() == Some(name))
            .unwrap_or_else(|| panic!("no `{name}` task in ksx.iss: {tasks:?}"))
            .clone()
    };

    let desktop = find("desktopicon");
    assert!(
        !field(&desktop, "Flags")
            .unwrap_or_default()
            .contains("unchecked"),
        "the desktop icon must be checked by default (FIRST-RUN.md §4 bullet 1): {desktop}"
    );

    assert!(
        !tasks
            .iter()
            .any(|line| field(line, "Name").as_deref() == Some("addtopath")),
        "the customer installer must not advertise a terminal integration task: {tasks:?}"
    );
    assert!(
        !text.lines().any(|line| line.trim() == "[Registry]")
            && !text.contains("ValueName: \"Path\""),
        "removing the PATH checkbox must also remove the registry mutation behind it"
    );
}

/// **One Start-menu entry, and it is the same console-free product launcher as
/// the desktop icon.**
///
/// Fails against the audited version, which put five names at the top level of
/// the Start-menu group — `ksx`, `ksx daemon (tray only)`, `ksx Studio (serve
/// only)`, `ksx cabinet`, `ksx setup wizard` — and gave a new user no way to
/// rank them.
///
#[test]
fn customer_shortcuts_offer_only_the_console_free_product_launcher() {
    let text = script();
    let icons = section(&text, "[Icons]");
    assert_eq!(
        icons.len(),
        2,
        "[Icons] may contain only the Start-menu product entry and its optional \
         desktop twin; CLI/dev surfaces are not customer shortcuts: {icons:?}"
    );
    let group: Vec<(String, String)> = icons
        .iter()
        .filter_map(|line| {
            let name = field(line.as_str(), "Name")?;
            let inside = name.strip_prefix("{group}\\")?.to_owned();
            Some((inside, line.clone()))
        })
        .collect();

    let top: Vec<&(String, String)> = group.iter().filter(|(n, _)| !n.contains('\\')).collect();
    assert_eq!(
        top.len(),
        1,
        "exactly ONE Start-menu entry at the top level (FIRST-RUN.md §4 bullet 3): {:?}",
        top.iter().map(|(n, _)| n).collect::<Vec<_>>()
    );
    let (name, line) = top[0];
    assert_eq!(
        name.as_str(),
        "{#AppName}",
        "the one entry is ksx itself, not a verb: {line}"
    );
    for entry in &icons {
        assert_eq!(
            field(entry, "Filename").as_deref(),
            Some("{app}\\{#LauncherExe}"),
            "every customer shortcut must target the GUI-subsystem launcher: {entry}"
        );
        assert_eq!(
            field(entry, "Parameters"),
            None,
            "the launcher owns `ksx.exe open`; shortcut arguments would duplicate \
             that contract: {entry}"
        );
    }

    // And the desktop icon, when its task is taken, is the same app.
    let desktop = icons
        .iter()
        .find(|line| {
            field(line.as_str(), "Name").is_some_and(|name| name.starts_with("{autodesktop}"))
        })
        .expect("a desktop icon entry");
    assert_eq!(
        field(desktop, "Tasks").as_deref(),
        Some("desktopicon"),
        "the desktop icon stays tied to its task: {desktop}"
    );
    assert!(
        !group.iter().any(|(name, _)| name.contains('\\')),
        "there must be no nested advanced/dev shortcut folder: {group:?}"
    );
    assert!(
        !text.contains("AdvancedGroup"),
        "the removed advanced shortcut group must not survive as dead installer configuration"
    );
}

/// The installer lays down both halves of the hand-off, and CI builds both
/// before invoking ISCC. A shortcut to an uninstalled launcher is a product
/// that installs successfully and then appears to do nothing.
#[test]
fn installer_and_ci_package_the_launcher_beside_ksx() {
    let text = script();
    let files = section(&text, "[Files]");
    let sources: Vec<String> = files
        .iter()
        .filter_map(|line| field(line, "Source"))
        .collect();
    for expected in [
        "{#RepoRoot}\\target\\release\\{#AppExe}",
        "{#RepoRoot}\\target\\release\\{#LauncherExe}",
    ] {
        assert!(
            sources.iter().any(|source| source == expected),
            "the installer must copy {expected}: {sources:?}"
        );
    }

    let workflow = workflow("build-installer.yml");
    let app_build = "cargo build --release -p ksx-app --features cabinet,studio";
    let launcher_build = "cargo build --release -p ksx-launcher";
    assert!(
        workflow.contains(app_build),
        "the shipping workflow must build ksx.exe with both UI features"
    );
    assert!(
        workflow.contains(launcher_build),
        "the shipping workflow must build ksx-launcher.exe before ISCC packages it"
    );
    let launcher_at = workflow.find(launcher_build).expect("asserted above");
    let iscc_at = workflow
        .find("& $iscc /Qp 'packaging\\ksx.iss'")
        .expect("build-installer.yml invokes ISCC");
    assert!(
        launcher_at < iscc_at,
        "the launcher must exist before ISCC reads its [Files] entry"
    );
}

/// WinUSB preparation is an installed-only, elevated boundary. The helper and
/// dynamically replaceable LGPL provider must be siblings, the corresponding
/// modified source must ship with the installed DLL, and the user-writable
/// portable ZIP must omit all three together.
#[test]
fn installer_and_ci_package_the_prepare_provider_only_in_the_installed_product() {
    let iss = script();
    let files = section(&iss, "[Files]");
    for (source, destination) in [
        ("{#RepoRoot}\\target\\release\\{#LibwdiDll}", "{app}"),
        (
            "{#RepoRoot}\\third_party\\libwdi\\*",
            "{app}\\THIRD-PARTY-SOURCE\\libwdi",
        ),
    ] {
        let entry = files
            .iter()
            .find(|line| field(line, "Source").as_deref() == Some(source))
            .unwrap_or_else(|| panic!("installer does not package {source}: {files:?}"));
        assert_eq!(field(entry, "DestDir").as_deref(), Some(destination));
    }
    let helper_entries: Vec<_> = files
        .iter()
        .filter(|line| {
            field(line, "Source").as_deref()
                == Some("{#RepoRoot}\\target\\release\\{#WinUsbHelper}")
        })
        .collect();
    // ONE copy, installed. There used to be a second `dontcopy` entry extracted
    // into {tmp} and run before the install began, and the comment justifying
    // it called {tmp} "Inno's protected temporary directory". It is not
    // protected: Inno creates it inside the invoking user's TEMP, so it is
    // owned and writable by that user. The helper proves its own directory is
    // owned by SYSTEM/Administrators/TrustedInstaller and writable by nobody
    // else before it does anything, so from there it refused itself — exit code
    // 3, on every machine, before a single file was copied. The store is
    // initialized from {app} now, where that proof can actually hold.
    assert_eq!(
        helper_entries.len(),
        2,
        "one extracted copy for the read-only pre-install audit, one installed copy for the          mutating verbs"
    );
    let installed = helper_entries
        .iter()
        .find(|entry| field(entry, "DestDir").as_deref() == Some("{app}"))
        .expect("the mutating helper must be installed to {app}, where its own admin-only location proof can hold");
    assert!(
        field(installed, "Flags")
            .is_some_and(|flags| flags.split_whitespace().any(|flag| flag == "ignoreversion")),
        "the installed helper needs `ignoreversion`: {installed}"
    );
    let bootstrap = helper_entries
        .iter()
        .find(|entry| {
            field(entry, "Flags")
                .is_some_and(|flags| flags.split_whitespace().any(|flag| flag == "dontcopy"))
        })
        .expect("the auditor must be extractable before installation begins");
    assert_eq!(
        field(bootstrap, "DestDir"),
        None,
        "the extracted copy exists only for PrepareToInstall: {bootstrap}"
    );
    let source_entry = files
        .iter()
        .find(|line| {
            field(line, "Source").as_deref() == Some("{#RepoRoot}\\third_party\\libwdi\\*")
        })
        .expect("asserted above");
    let source_flags = field(source_entry, "Flags").unwrap_or_default();
    for required in ["recursesubdirs", "createallsubdirs"] {
        assert!(
            source_flags.split_whitespace().any(|flag| flag == required),
            "complete corresponding source needs `{required}`: {source_entry}"
        );
    }

    let build = workflow("build-installer.yml");
    let helper_build = "cargo build --release -p ksx-winusb-helper";
    let provider_build = "./third_party/libwdi/build.ps1";
    let provider_smoke = "./third_party/libwdi/test-provider.ps1";
    let iscc = "& $iscc /Qp 'packaging\\ksx.iss'";
    for contract in [
        "runs-on: windows-2022",
        helper_build,
        provider_build,
        "VC\\Tools\\MSVC\\14.44.35207\\bin\\Hostx64\\x64\\cl.exe",
        "Windows Kits\\10\\Include\\10.0.19041.0\\um\\Windows.h",
        "-VCToolsVersion 14.44.35207",
        "$firstHash -cne $secondHash",
        provider_smoke,
        "target/release/libwdi.dll",
        "subsystem \\(Windows GUI\\)",
        "-inputresource:$helper;#1",
        "requestedExecutionLevel\\s+level=\"requireAdministrator\"",
    ] {
        assert!(build.contains(contract), "release build lost `{contract}`");
    }
    let iscc_at = build.find(iscc).expect("release workflow invokes ISCC");
    for before in [helper_build, provider_build, provider_smoke] {
        assert!(
            build.find(before).expect("asserted above") < iscc_at,
            "`{before}` must complete before ISCC packages its output"
        );
    }

    let portable = build
        .split("- name: Package portable distribution with license material")
        .nth(1)
        .expect("portable packaging step exists")
        .split("- uses: actions/upload-artifact@v4")
        .next()
        .expect("portable step has an upload boundary");
    for forbidden in [
        "ksx-winusb-helper.exe",
        "libwdi.dll",
        "THIRD-PARTY-SOURCE",
        "third_party/libwdi",
    ] {
        assert!(
            !portable.contains(forbidden),
            "user-writable portable ZIP must omit installed-only `{forbidden}`"
        );
    }
}

/// The vendored provider deliberately exposes only the three upstream ABI
/// calls needed to prepare a canonical x64 WinUSB package. These source-level
/// invariants complement the PE/export/import verification in `verify.ps1`.
#[test]
fn vendored_libwdi_is_prepare_only_deterministic_and_fail_closed() {
    let definition = read("third_party/libwdi/src/libwdi.def");
    let exports: Vec<_> = definition
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("wdi_"))
        .collect();
    assert_eq!(
        exports,
        [
            "wdi_is_driver_supported",
            "wdi_prepare_driver",
            "wdi_strerror"
        ]
    );

    let template = read("third_party/libwdi/src/winusb.inf.in");
    for required in [
        "NTamd64.10.0",
        "Include = winusb.inf",
        "Needs   = WINUSB.NT",
        "Needs   = WINUSB.NT.Services",
        "PnpLockdown = 1",
    ] {
        assert!(
            template.contains(required),
            "canonical INF lost `{required}`"
        );
    }
    for forbidden in ["NTarm64", "CopyFiles", "CoInstallers", "libusb"] {
        assert!(
            !template.contains(forbidden),
            "canonical INF gained forbidden `{forbidden}`"
        );
    }

    let prepare = read("third_party/libwdi/src/libwdi.c");
    for required in [
        "RtlGetVersion",
        "KSX WinUSB Keyboard Interface",
        "{B8B2D1F8-6E0E-4C7F-9E5A-3A9C1D6F2E10}",
        "options->driver_type != WDI_WINUSB",
        "!options->external_inf",
        "options->disable_cat",
        "options->disable_signing",
        "options->use_wcid_driver",
        "FILE_FLAG_OPEN_REPARSE_POINT",
        "memcmp(buffer, ksx_winusb_inf_template",
        "fopenU(inf_path, \"wb\")",
        "wrote_body != body_chars",
        "close_result != 0",
        "01/01/2026",
        "1.5.1.788",
        "IsUserAnAdmin()",
    ] {
        assert!(
            prepare.contains(required),
            "prepare boundary lost `{required}`"
        );
    }

    let pki = read("third_party/libwdi/src/pki.c");
    for required in [
        "BCryptGenRandom",
        "KSX-libwdi-%02X%02X%02X%02X%02X%02X%02X%02X%02X%02X%02X%02X%02X%02X%02X%02X",
        "CRYPT_NEWKEYSET | CRYPT_MACHINE_KEYSET | CRYPT_SILENT",
        "MS_ENH_RSA_AES_PROV_W, PROV_RSA_AES",
        "KP_KEYLEN",
        "KP_PERMISSIONS",
        "CryptCATAdminAcquireContext2",
        "CryptCATAdminCalcHashFromFileHandle2",
        "szOID_NIST_sha256",
        "memcmp(left->pbCertEncoded, right->pbCertEncoded",
        "CertCreateCertificateContext",
        "CERT_KEY_CONTEXT_PROP_ID",
        "CERT_NCRYPT_KEY_HANDLE_PROP_ID",
    ] {
        assert!(pki.contains(required), "PKI boundary lost `{required}`");
    }
    assert!(
        !pki.contains("CRYPT_EXPORTABLE"),
        "one-time signing keys must never be exportable"
    );
    let sign_at = pki.find("hResult = pfSignerSignEx").expect("signing call");
    let delete_at = pki
        .find("if (!DeletePrivateKey(wszKeyContainer")
        .expect("fatal private-key deletion proof");
    let trust_at = pki
        .find("if (!AddCertToStore(pPublicCertContext, \"Root\"")
        .expect("public-only Root trust add");
    assert!(
        sign_at < delete_at && delete_at < trust_at,
        "the provider must sign, prove key deletion, then establish trust"
    );

    let project = read("third_party/libwdi/msvc/libwdi.vcxproj");
    for required in [
        "<WindowsTargetPlatformVersion>10.0.19041.0</WindowsTargetPlatformVersion>",
        "<RuntimeLibrary>MultiThreaded</RuntimeLibrary>",
        "<LinkTimeCodeGeneration>UseLinkTimeCodeGeneration</LinkTimeCodeGeneration>",
        "<AdditionalOptions>/Brepro %(AdditionalOptions)</AdditionalOptions>",
    ] {
        assert!(
            project.contains(required),
            "deterministic build lost `{required}`"
        );
    }

    let smoke = read("third_party/libwdi/test-provider.ps1");
    for required in [
        "finally {",
        // Mutating verbs go through Start-Process with file redirection, never
        // `& pnputil ... 2>&1`: DrvInst.exe inherits a redirected pipe and
        // outlives pnputil, so the pipe form deadlocks after the work is done.
        "Invoke-Pnputil 'add-driver' @('/add-driver', $infPath)",
        "@('/delete-driver', $package, '/uninstall', '/force')",
        "@('/scan-devices')",
        "Get-ExactPublishedPackages",
        "Remove-TransactionCertificates 'TrustedPublisher'",
        "Remove-TransactionCertificates 'Root'",
        "DeleteOwnedContainer",
        "Remove-Item -LiteralPath $output -Recurse -Force",
    ] {
        assert!(
            smoke.contains(required),
            "disposable provider cleanup proof lost `{required}`"
        );
    }
    let add_line = smoke
        .lines()
        .find(|line| line.contains("Invoke-Pnputil 'add-driver'"))
        .expect("asserted above");
    assert!(
        !add_line.contains("/install"),
        "Driver Store acceptance smoke must never bind the synthetic device"
    );
}

/// Store creation and cleanup are transaction gates, not path-based installer
/// mutations or best-effort hooks.  The INSTALLED helper owns the exact
/// handle/ACL protocol — it proves its own directory is admin-only, which is
/// true in `{app}` and can never be true in `{tmp}`; the installed
/// helper/provider remain present on every nonzero cleanup so recovery can be
/// retried.  The uninstall half runs in
/// `usUninstall` — after the user has confirmed, before Inno removes a file — so
/// that answering No to the confirmation costs nothing.
#[test]
fn installer_initializes_state_from_the_installed_helper_and_uninstall_is_cleanup_gated() {
    let iss = script();
    for contract in [
        // The store is initialized from the INSTALLED helper, never from a copy
        // extracted into {tmp}. Inno creates {tmp} inside the invoking user's
        // TEMP, so it is user-owned and user-writable, and the helper's first
        // act is to prove its own directory is neither. Running it there made
        // setup refuse itself with exit code 3 on every machine, every time.
        "function PrepareToInstall(var NeedsRestart: Boolean): string;",
        "ExtractTemporaryFile('{#WinUsbHelper}')",
        "'check-store'",
        "No KSX files were installed",
        "function RecoveryStoreProblem: string;",
        "HelperPath := ExpandConstant('{app}\\{#WinUsbHelper}')",
        "'initialize-store'",
        "if ResultCode <> 0 then",
        "InitializeRecoveryStore;",
        "function InitializeUninstall(): Boolean;",
        "Result := False;",
        "procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);",
        // The phase itself is deliberately NOT pinned as a literal here. It is
        // checked below against Inno's actual enum, and a literal in this list
        // would fire first and mask that check — which it did, the first time
        // this guard was tested against a fictional phase.
        "'uninstall-quiesce'",
        "'cleanup-owned'",
        "ewWaitUntilTerminated",
        "if ResultCode = 0 then",
        "Result := True;",
        "if ResultCode = 4 then",
        "Nothing was uninstalled",
    ] {
        assert!(
            iss.contains(contract),
            "installer cleanup contract lost `{contract}`"
        );
    }

    // One routine's body: from its header to its own column-0 `end;`. Nested
    // blocks close with an INDENTED `end;`, so the unindented one terminates
    // the routine — and stopping there keeps the next routine's doc comment,
    // which naturally names the verb that routine runs, out of the slice.
    fn routine<'a>(iss: &'a str, header: &str) -> &'a str {
        let start = iss
            .find(header)
            .unwrap_or_else(|| panic!("ksx.iss lost `{header}`"));
        let tail = &iss[start..];
        let end = tail
            .find("\nend;")
            .map(|at| at + "\nend;".len())
            .unwrap_or(tail.len());
        &tail[..end]
    }

    // Cancelling must cost nothing. `InitializeUninstall` runs BEFORE Inno asks
    // "are you sure you want to completely remove ksx?", so nothing in it may
    // touch the machine. Fails against the version that ran `cleanup-owned`
    // there, where answering No had already released the user's keyboard.
    let init_uninstall = routine(&iss, "function InitializeUninstall(): Boolean;");
    for forbidden in ["Exec(", "cleanup-owned", "uninstall-quiesce"] {
        assert!(
            !init_uninstall.contains(forbidden),
            "InitializeUninstall runs before the confirmation, so it must not `{forbidden}`"
        );
    }

    // Order is the contract: a keyboard released out from under a live Play
    // session races the driver rollback.
    let step = routine(
        &iss,
        "procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);",
    );
    // Inno's TUninstallStep, verbatim. Every other assertion here pins the name
    // the script HAPPENS to use; this one pins that the name exists. `ussInit`
    // was written into this gate once, taken from TSetupStep's `ss` prefix, and
    // the assertions of the day pinned it faithfully — a fictional phase, held
    // in place by its own tests, with ISCC on a runner the only thing in this
    // repository able to say so.
    const UNINSTALL_STEPS: [&str; 4] = [
        "usAppMutexCheck",
        "usUninstall",
        "usPostUninstall",
        "usDone",
    ];
    let phase = step
        .lines()
        .find_map(|line| {
            let rest = line.trim().strip_prefix("if CurUninstallStep <> ")?;
            rest.split_whitespace().next().map(str::to_owned)
        })
        .expect("the gate must compare CurUninstallStep against a phase");
    assert!(
        UNINSTALL_STEPS.contains(&phase.as_str()),
        "`{phase}` is not a TUninstallStep — Inno defines exactly {UNINSTALL_STEPS:?}. \
         A plausible-looking phase name compiles nowhere and fails only on a runner."
    );

    let quiesce = step
        .find("if not SessionQuiesced() then")
        .expect("the usUninstall gate must stop the session");
    let release = step
        .find("if not OwnedRecoveryReleased() then")
        .expect("the usUninstall gate must release what KSX owns");
    assert!(
        quiesce < release,
        "the session must be quiesced before the WinUSB rollback, not after"
    );

    // Pascal Script's `except` catches EAbort like any other exception, so an
    // Abort raised inside a handler-wrapped routine is swallowed and the
    // uninstall carries on deleting. Both aborts live in this try-free step.
    assert!(
        !step.contains("try"),
        "CurUninstallStepChanged must stay try-free or its Abort is swallowed"
    );
    assert_eq!(
        step.matches("Abort;").count(),
        2,
        "both the quiesce and the rollback failure must abort the uninstall"
    );
    for forbidden in ["RunIcacls", "icacls.exe", "ForceDirectories(", " /T "] {
        assert!(
            !iss.contains(forbidden),
            "Inno must not mutate ProgramData by path before the handle-anchored helper: `{forbidden}`"
        );
    }
    assert!(
        !iss.lines().any(|line| line.trim() == "[Dirs]"),
        "Inno [Dirs] must not touch ProgramData before the helper's handle-anchored initialization"
    );

    let helper = read("crates/ksx-winusb-helper/src/main.rs");
    for contract in [
        "cleanup-owned-worker",
        "protected_install_sibling(&current, &current)",
        "CLEANUP_WORKER_WAIT",
        "child.try_wait()",
        "EXIT_RECOVERY",
    ] {
        assert!(
            helper.contains(contract),
            "bounded installed cleanup helper lost `{contract}`"
        );
    }
    for forbidden in [".kill()", "taskkill", "TerminateProcess"] {
        assert!(
            !helper.contains(forbidden),
            "cleanup must leave a timed-out mutating worker alive: `{forbidden}`"
        );
    }

    let build = workflow("build-installer.yml");
    for contract in [
        "New-Item -ItemType Junction -Path $link -Target $target",
        "if ($process.ExitCode -eq 0)",
        "Get-Acl -LiteralPath $target).Sddl",
        "Get-Acl -LiteralPath $marker).Sddl",
        "Get-FileHash -LiteralPath $marker -Algorithm SHA256",
        "$process.WaitForExit(120000)",
        "process was left running",
        "Remove-Item -LiteralPath $link -Force",
    ] {
        assert!(
            build.contains(contract),
            "disposable hostile-junction smoke lost `{contract}`"
        );
    }
    assert!(
        !iss.lines().any(|line| line.trim() == "[UninstallRun]"),
        "[UninstallRun] is replayed from the uninstall log while files are already being \
         removed, which is after the usUninstall gate — the autostart task and the WinUSB \
         rollback both have to happen before that, so the section may not come back"
    );
    let deletes = section(&iss, "[UninstallDelete]");
    for (kind, path) in [
        ("filesandordirs", "{commonappdata}\\KSX\\WinUSB"),
        ("dirifempty", "{commonappdata}\\KSX"),
    ] {
        assert!(
            deletes.iter().any(|line| {
                field(line, "Type").as_deref() == Some(kind)
                    && field(line, "Name").as_deref() == Some(path)
            }),
            "post-cleanup deletion lost {kind} {path}: {deletes:?}"
        );
    }
}

/// Third-party terms are part of both Windows distributions, not repository
/// archaeology. `Cargo.lock` pins dependency bytes but contains no license
/// texts; the installed directory and portable ZIP therefore carry the
/// authored NOTICE, product licenses, direct-payload texts, and the generated
/// locked Rust dependency report.
#[test]
fn installer_and_portable_zip_carry_complete_license_material() {
    let expected = [
        ("LICENSE-MIT", "Copyright (c) 2026 Victor Villacis"),
        ("LICENSE-APACHE", "Apache License"),
        ("NOTICE", "ViGEmBus 1.22.0 redistributable"),
        (
            "THIRD-PARTY-LICENSES/Gamepad-Asset-Pack-MIT.txt",
            "Copyright (c) 2024 Al. Lopez",
        ),
        (
            "THIRD-PARTY-LICENSES/Lucide-ISC.txt",
            "Lucide Contributors 2022",
        ),
        (
            "THIRD-PARTY-LICENSES/vigem-client-MIT.txt",
            "CasualX@users.noreply.github.com",
        ),
        (
            "THIRD-PARTY-LICENSES/ViGEmBus-BSD-3-Clause.txt",
            "Nefarius Software Solutions e.U.",
        ),
        (
            "THIRD-PARTY-LICENSES/Forma-MIT.txt",
            "Copyright (c) 2026 Forma",
        ),
        (
            "THIRD-PARTY-LICENSES/alien-signals-MIT.txt",
            "Copyright (c) 2024-present Johnson Chu",
        ),
        (
            "THIRD-PARTY-LICENSES/Rust-dependencies.html",
            "interception-sys 0.1.3",
        ),
        (
            "THIRD-PARTY-LICENSES/Rust-dependencies-winusb-helper.html",
            "ksx-winusb-helper 0.2.0",
        ),
        (
            "THIRD-PARTY-LICENSES/libwdi-LGPL-3.0-or-later.txt",
            "GNU LESSER GENERAL PUBLIC LICENSE",
        ),
        (
            "THIRD-PARTY-LICENSES/GPL-3.0.txt",
            "GNU GENERAL PUBLIC LICENSE",
        ),
    ];
    for (path, marker) in expected {
        let text = read(path);
        assert!(
            text.contains(marker),
            "{path} is missing its pinned copyright/component marker `{marker}`"
        );
    }

    let notice = read("NOTICE");
    assert!(notice.contains("forma-ir 0.2.0 and forma-server 0.2.0"));
    assert!(notice.contains("interception-sys` 0.1.3 as LGPL-3.0"));
    assert!(notice.contains("libwdi 1.5.1 prepare provider"));
    assert!(notice.contains("9b23b82a2dd1cbffc16d46c212f92c6bf8c0c602"));
    assert!(
        !notice.contains("licenses travel with them in `Cargo.lock`"),
        "Cargo.lock carries versions and checksums, not distributable license text"
    );

    let files = section(&script(), "[Files]");
    let entry = files
        .iter()
        .find(|line| {
            field(line, "Source").as_deref() == Some("{#RepoRoot}\\THIRD-PARTY-LICENSES\\*")
        })
        .expect("the installer must copy THIRD-PARTY-LICENSES/*");
    assert_eq!(
        field(entry, "DestDir").as_deref(),
        Some("{app}\\THIRD-PARTY-LICENSES")
    );
    let flags = field(entry, "Flags").unwrap_or_default();
    for required in ["recursesubdirs", "createallsubdirs"] {
        assert!(
            flags.split_whitespace().any(|flag| flag == required),
            "the third-party license directory needs `{required}`: {entry}"
        );
    }

    let build = workflow("build-installer.yml");
    for contract in [
        "'target/release/ksx.exe'",
        "'target/release/ksx-launcher.exe'",
        "'README.md'",
        "'NOTICE'",
        "'LICENSE-MIT'",
        "'LICENSE-APACHE'",
        "Copy-Item $files -Destination $root",
        "Copy-Item 'THIRD-PARTY-LICENSES' -Destination $root -Recurse",
        "Compress-Archive",
        "name: ksx-windows-portable",
    ] {
        assert!(
            build.contains(contract),
            "portable packaging lost `{contract}`"
        );
    }

    let release = workflow("release.yml");
    assert!(release.contains("name: ksx-windows-portable"));
    let assets = release
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("$assets") && line.contains("@("))
        .expect("release.yml declares its assets in one `$assets = @(…)` line");
    assert!(
        assets.contains("PORTABLE_NAME"),
        "the portable ZIP carrying license material must be a release asset: {assets}"
    );
    assert!(
        !assets.contains("dist/ksx.exe"),
        "a bare executable cannot replace the licensed portable distribution: {assets}"
    );
}

/// **Moment 7 has a driver under it, and the wizard asks.**
///
/// Fails against every version before this one, where the `[Tasks]` section had
/// two entries and neither was the driver. The bundled ViGEmBus setup shipped
/// to `{app}\drivers` and was never executed, so on a machine that has never
/// had ViGEmBus a first-run user reached Play, pressed it, and nothing plugged
/// — and the documented fix was `ksx install-drivers` from an elevated shell,
/// which `docs/FIRST-RUN.md` §7 rules out as an answer.
///
/// It fails in the other direction too. Installing a kernel driver without
/// asking is what `docs/DRIVERS.md` refuses, so this asserts a checkbox exists
/// AND that its label says what it does: "install drivers" is a phrase a
/// first-time user cannot rank, and a checkbox nobody understands is not
/// consent.
#[test]
fn the_bundled_driver_is_offered_checked_and_the_label_says_what_it_is() {
    let text = script();
    let tasks = section(&text, "[Tasks]");
    let task = tasks
        .iter()
        .find(|line| field(line.as_str(), "Name").as_deref() == Some("vigembus"))
        .unwrap_or_else(|| {
            panic!("no `vigembus` task: nothing in this installer installs the driver: {tasks:?}")
        });

    assert!(
        !field(task, "Flags")
            .unwrap_or_default()
            .contains("unchecked"),
        "the driver box is ticked by default — the whole point is that a first run does \
         not have to know it needs one: {task}"
    );

    let description = field(task, "Description").expect("the task must carry a Description");
    assert!(
        description.contains("ViGEmBus"),
        "the label names the driver, so somebody who already has one can recognise it: \
         {description}"
    );
    assert!(
        description.to_ascii_lowercase().contains("controller"),
        "and says what it is FOR, in a word a first-run user has (`controller`), not one \
         only we have: {description}"
    );
}

/// **The install goes through the verb that verifies it.**
///
/// `drivers\ViGEmBus_1.22.0_x64_x86_arm64.exe` is sitting in `{app}` and a
/// one-line `[Run]` entry could execute it. That version would pass every other
/// test in this file and would throw away `docs/DRIVERS.md`'s entire
/// guarantee: the protected-directory search, the sealed handle, the SHA-256
/// and the Authenticode chain all live in `ksx install-drivers`, and none of
/// them becomes optional because Inno is doing the running.
///
/// So this asserts the bundled file name appears only as a payload to COPY,
/// never as something to execute, and that the driver step names the verb.
#[test]
fn nothing_executes_the_bundled_setup_directly() {
    let text = script();
    let bundle = ksx_platform::installer::INSTALLER_FILE_NAME;

    for line in text.lines() {
        let line = line.trim();
        if line.starts_with(';') || line.starts_with("//") || !line.contains(bundle) {
            continue;
        }
        assert!(
            line.starts_with("Source:"),
            "{bundle} may only be COPIED by this installer. Running it directly skips \
             every check `ksx install-drivers` makes on it (docs/DRIVERS.md): {line}"
        );
    }

    let code = section(&text, "[Code]").join("\n");
    assert!(
        code.contains("install-drivers --yes"),
        "the driver step must run `ksx install-drivers --yes` — one code path owns the \
         hash pin, the signature pin and the sealed handle"
    );
}

/// **A driver that will not install must not fail the install.**
///
/// ksx without ViGEmBus still runs, still configures, still maps and still
/// saves; it just cannot plug a pad. Rolling the whole install back over that
/// would take away the nine tenths that work to punish the one tenth that did
/// not — and would leave the user with no ksx *and* no driver.
///
/// Fails against the obvious "fix" for a failed driver step: `Abort`,
/// `ExitSetupMsgBox` or a `RaiseException` in the driver path, any of which
/// turns a recoverable outcome into a rolled-back install.
///
/// It also pins the other half of the obligation — that a failure SAYS so and
/// names a way back — because a step that fails silently is the same bug as a
/// step that fails loudly and takes everything with it.
///
/// `CurUninstallStepChanged` is exempt and only it: aborting there is the whole
/// point of the uninstall gate, and no uninstall-only routine can roll back an
/// install.
#[test]
fn a_failed_driver_install_reports_and_continues() {
    let text = script();

    // The install path is all of [Code] EXCEPT that uninstall-only gate. Prose
    // is not code either, so the `//` lines that explain why the gate aborts
    // are dropped too — what is scanned is what ISCC will actually run.
    // `InitializeRecoveryStore` is exempt for the opposite reason to the
    // uninstall gate: it is the ONE routine on the install path that is
    // supposed to roll the install back. A machine with no ViGEmBus still
    // wants ksx; a machine whose fixed recovery store could not be proved safe
    // must not keep an elevated helper that mutates a driver store on its word.
    let mut install_code = String::new();
    let mut inside_uninstall_gate = false;
    let mut gate_seen = false;
    let mut inside_store_gate = false;
    let mut store_gate_seen = false;
    for line in section(&text, "[Code]") {
        if line.starts_with("procedure CurUninstallStepChanged(") {
            inside_uninstall_gate = true;
            gate_seen = true;
        }
        if line.starts_with("procedure InitializeRecoveryStore") {
            inside_store_gate = true;
            store_gate_seen = true;
        }
        if inside_store_gate {
            inside_store_gate = line != "end;";
            continue;
        }
        if inside_uninstall_gate {
            inside_uninstall_gate = line != "end;";
            continue;
        }
        if line.starts_with("//") {
            continue;
        }
        install_code.push_str(&line);
        install_code.push('\n');
    }
    assert!(
        gate_seen && !inside_uninstall_gate,
        "the uninstall gate must exist and close with an unindented `end;`, or this scan \
         is silently exempting the rest of [Code] instead of just the gate"
    );
    assert!(
        store_gate_seen && !inside_store_gate,
        "the recovery-store gate must exist and close with an unindented `end;`, or this \
         scan is silently exempting the rest of [Code] instead of just the gate"
    );
    let code = install_code;

    for wrecker in ["Abort", "ExitSetupMsgBox", "RaiseException"] {
        assert!(
            !code.contains(wrecker),
            "`{wrecker}` on the install path would let a failed driver install take the \
             whole install with it. A machine with no ViGEmBus still wants ksx."
        );
    }

    // An EXCEPTION out of `CurStepChanged` rolls the install back just as
    // effectively as an `Abort`, and it is the failure mode ISCC cannot catch:
    // a constant that does not expand compiles perfectly and throws at run
    // time, on a shipped setup.exe, on somebody else's machine.
    assert!(
        code.contains("try") && code.contains("except"),
        "the driver step must be wrapped in try..except — CI proves this file \
         COMPILES and proves nothing about what it does when run"
    );

    // The retry the user can actually perform comes first: they are looking at
    // the installer that offers it. `FIRST-RUN.md` §6 puts "the only way out of
    // a mistake is a shell command" on the list of things that must never
    // happen, so the command is named as well, never instead.
    assert!(
        code.contains("run this installer again"),
        "a failure must name the no-terminal retry — this installer, with the box ticked"
    );
    assert!(
        code.contains("ksx install-drivers --yes"),
        "...and the command, for somebody who has a terminal open anyway"
    );
}

/// **Every byte the user can see is ASCII.**
///
/// `ksx.iss` has no UTF-8 BOM, so ISCC reads it in the system code page: one
/// byte above 127 in a wizard checkbox, a shortcut tooltip or a message box
/// becomes mojibake on somebody else's machine, and it renders correctly on
/// the machine that wrote it. This is the one class of mistake in this file
/// that cannot be caught by looking at it, and the number of user-visible
/// strings just tripled.
///
/// Comment lines are exempt and stay exempt — ISCC discards them, and this
/// repository's prose uses en dashes and section marks everywhere.
#[test]
fn no_user_visible_string_carries_a_byte_above_127() {
    for (number, line) in script().lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with(';') || trimmed.starts_with("//") {
            continue;
        }
        assert!(
            line.is_ascii(),
            "line {} has a byte above 127 outside a comment. ksx.iss has no BOM, so ISCC \
             reads it in the system code page and this reaches a user as mojibake — keep \
             it ASCII, or put the sentence in a comment: {line}",
            number + 1
        );
    }
}

/// **The `CLAUDE.md` landmine, as an assertion.** No Pascal `{ }` comment in
/// `[Code]`.
///
/// Fails against the version that shipped one. Pascal Script ends a brace
/// comment at the FIRST `}`, so a comment explaining what `{app}` means closes
/// four characters in and the rest of the sentence is compiled as code. The
/// symptom is an ISCC syntax error pointing at prose, and it cost this file its
/// first compile.
///
/// The scan tracks state rather than banning the character, because both other
/// uses are legitimate and present: `{` inside a single-quoted string
/// (`ExpandConstant('{app}')`) and `{` inside a `//` comment — which is how the
/// note warning about all this is written.
#[test]
fn the_code_section_uses_line_comments_only() {
    let text = script();
    for line in section(&text, "[Code]") {
        let chars: Vec<char> = line.chars().collect();
        let mut in_string = false;
        for (index, c) in chars.iter().enumerate() {
            match c {
                '\'' => in_string = !in_string,
                // The rest of the line is a `//` comment: stop reading.
                '/' if !in_string && chars.get(index + 1) == Some(&'/') => break,
                '{' if !in_string => panic!(
                    "a `{{ }}` comment in [Code] ends at the FIRST `}}` — use `//` \
                     instead (CLAUDE.md; this has broken ksx.iss once): {line}"
                ),
                _ => {}
            }
        }
    }
}

/// **One version, spelled in two files, and a tag that has to equal both.**
///
/// `#define AppVersion` is the installer's filename, its `VersionInfoVersion`,
/// and the "ksx 0.2.0" row in Apps & Features — what the INSTALLED program says
/// about itself. `[workspace.package] version` is what `ksx --version` prints.
/// `.github/workflows/build-installer.yml` refuses to build a release unless the
/// tag equals both, and it is the release that makes the disagreement expensive:
/// a tag is a public name you cannot reuse, so learning ten minutes into a
/// release run that two files disagree costs a deleted tag and a burned version
/// number.
///
/// Fails against the ordinary broken tree: someone bumps `Cargo.toml` to 0.2.1
/// and `ksx.iss` keeps 0.2.0. Nothing else in this repository notices — the
/// build is fine, the tests are green, the installer compiles — until the tag.
#[test]
fn the_installer_version_and_the_workspace_version_cannot_drift() {
    let installer = define(&script(), "AppVersion");
    let workspace = workspace_version();
    assert_eq!(
        installer, workspace,
        "packaging/ksx.iss says AppVersion {installer} and Cargo.toml's \
         [workspace.package] says {workspace}. A release tag has to equal both \
         (.github/workflows/build-installer.yml, \"Version agreement\"), so one \
         of these two files is wrong right now — decide which before tagging."
    );
}

/// **The release is a pushed tag, and nothing else is a release.**
///
/// Fails against three broken versions, each of which has a plausible author:
///
/// 1. `on: release: types: [published]` — the belief that publishing requires
///    creating a Release in the web UI first. It does not: the UI works only
///    *because* it creates a tag. Under that trigger `git push origin v0.2.0`
///    does nothing at all, which is indistinguishable from a broken workflow
///    and is how a repo ends up with tags and an empty releases page.
/// 2. `branches:` added beside `tags:`, which cuts a release on every push.
/// 3. A pattern this repository's own version cannot produce (`release-v*`,
///    `v*.*.*-*`): the workflow then exists, is valid, and never fires.
#[test]
fn the_release_is_triggered_by_pushing_a_version_tag() {
    let lines = yaml_lines(&workflow("release.yml"));
    let triggers = yaml_keys(&yaml_block(&lines, &["on"]));
    assert_eq!(
        triggers,
        vec!["push"],
        "the only trigger may be a push. A `release:` trigger would wait for a \
         human to create a Release in the browser, and then a CLI-pushed tag \
         publishes nothing; a `workflow_dispatch` would run the publish job on a \
         branch, where there is no tag to attach a release to."
    );

    let push = yaml_block(&lines, &["on", "push"]);
    assert_eq!(
        yaml_keys(&push),
        vec!["tags"],
        "a `branches:` filter beside `tags:` would publish a release on every \
         branch push: {push:?}"
    );

    let patterns = yaml_items(&yaml_block(&lines, &["on", "push", "tags"]));
    assert!(!patterns.is_empty(), "no tag patterns in release.yml");
    let tag = format!("v{}", workspace_version());
    assert!(
        patterns.iter().any(|pattern| glob_matches(pattern, &tag)),
        "this repository is at version {}, so the tag to push is `{tag}` — and \
         none of release.yml's patterns {patterns:?} match it. A workflow that \
         cannot fire for the version in the tree is a workflow that never fires.",
        workspace_version()
    );
}

/// **What gets attached is the installer, under the name `ksx.iss` emits.**
///
/// `docs/FIRST-RUN.md` §1 moment 1 is "a `.exe` from the releases page. One
/// file" — and that file is the setup.exe. The chain from the Inno script to the
/// release asset runs through three files, and every link is a string:
///
/// ```text
///   ksx.iss OutputDir + OutputBaseFilename
///     -> build-installer.yml upload path glob
///       -> artifact name
///         -> release.yml download
///           -> gh release create <asset>
/// ```
///
/// Fails against:
///
/// - `OutputDir=dist` in `ksx.iss` (one word; ISCC compiles it happily) — the
///   upload glob then matches nothing;
/// - an artifact renamed in one file and not the other, which fails the publish
///   AFTER a ten-minute build, on a tag that is already public;
/// - a release that attaches only `ksx.exe`. A bare console binary with no
///   driver folder beside it is not what moment 1 means by "one file".
#[test]
fn the_release_attaches_the_installer_that_ksx_iss_actually_produces() {
    let iss = script();
    // OutputDir is relative to the .iss, which lives in packaging/.
    let produced = format!(
        "packaging/{}/{}.exe",
        setup_value(&iss, "OutputDir"),
        setup_value(&iss, "OutputBaseFilename")
    );

    let build = workflow("build-installer.yml");
    let uploads = artifact_steps(&build, "upload");
    assert!(!uploads.is_empty(), "build-installer.yml uploads nothing");
    let (installer_artifact, glob) = uploads
        .iter()
        .find(|(_, path)| glob_matches(path, &produced))
        .unwrap_or_else(|| {
            panic!(
                "ksx.iss writes {produced}, and no upload in build-installer.yml \
                 collects it: {uploads:?}"
            )
        });
    assert!(
        glob.contains("setup"),
        "the installer upload should still name the installer: {glob}"
    );

    let release = workflow("release.yml");
    let downloads = artifact_steps(&release, "download");
    let names: Vec<&str> = downloads.iter().map(|(name, _)| name.as_str()).collect();
    assert!(
        names.contains(&installer_artifact.as_str()),
        "build-installer.yml uploads the installer as `{installer_artifact}` and \
         release.yml downloads {names:?} — the publish would fail after the build, \
         with the tag already pushed."
    );
    for (name, _) in &downloads {
        assert!(
            uploads.iter().any(|(uploaded, _)| uploaded == name),
            "release.yml downloads an artifact `{name}` that build-installer.yml \
             never uploads: {uploads:?}"
        );
    }

    // The assets, as data rather than as a command line, so this can read them.
    let assets = release
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("$assets") && line.contains("@("))
        .expect(
            "release.yml's publish step must name its release assets in one \
             `$assets = @(...)` line, so this test can see what gets attached",
        );
    assert!(
        assets.contains("SETUP_NAME"),
        "the installer must be a release asset (FIRST-RUN.md §1 moment 1): {assets}"
    );
    assert!(
        assets.contains("PORTABLE_NAME"),
        "the portable distribution rides along for people who want no installer: {assets}"
    );
}

/// **The release body explains the scary dialog, and lets a download be
/// checked.**
///
/// Two sentences carry the whole weight of moment 1 and neither can be
/// generated:
///
/// - The installer is unsigned, so Windows shows "Windows protected your PC"
///   with only a *Don't run* button visible. A first-time user who meets an
///   unexplained warning stops there, and no later screen gets a turn. The body
///   has to name the dialog and the two clicks through it.
/// - The SHA-256 and the commit are what make "click Run anyway" checkable
///   rather than a request for trust. Both already exist — the build computes
///   them — so the only failure mode is not printing them.
///
/// Fails against a body that drops either, and against a template that grows a
/// placeholder `release.yml` does not substitute: `{{SIZE}}` would then appear
/// on a public page as five literal characters.
#[test]
fn the_release_body_carries_the_hash_the_commit_and_the_smartscreen_step() {
    let notes = read("packaging/release-notes.md");
    for placeholder in ["{{SETUP_NAME}}", "{{SETUP_SHA256}}", "{{COMMIT}}"] {
        assert!(
            notes.contains(placeholder),
            "the release body must carry {placeholder}: a download nobody can \
             verify against the run that built it is a download nobody can verify"
        );
    }
    for phrase in ["Windows protected your PC", "More info", "Run anyway"] {
        assert!(
            notes.contains(phrase),
            "the release body must say \"{phrase}\". The installer is not \
             code-signed; SmartScreen's dialog shows a single `Don't run` button, \
             and a first-time user who is not told about it does not reach moment 2."
        );
    }

    // Every placeholder the template uses is one the workflow fills in.
    let filled = substituted_placeholders(&workflow("release.yml"));
    assert!(
        !filled.is_empty(),
        "no `.Replace('{{{{NAME}}}}', …)` calls found in release.yml — either the \
         compose step is gone or it stopped substituting by that spelling, and \
         this test can no longer see what it fills in"
    );
    let mut rest = notes.as_str();
    while let Some(at) = rest.find("{{") {
        let tail = &rest[at + 2..];
        let end = tail
            .find("}}")
            .unwrap_or_else(|| panic!("unterminated `{{{{` in packaging/release-notes.md"));
        let name = &tail[..end];
        assert!(
            filled.iter().any(|known| known == name),
            "packaging/release-notes.md uses {{{{{name}}}}} and \
             .github/workflows/release.yml substitutes only {filled:?} — it would \
             reach the releases page as literal braces"
        );
        rest = &tail[end + 2..];
    }
}

/// Setup must not put ksx back on its feet while it is still installing.
///
/// Defect 6 of the 2026-08-11 hardware session: an upgrade died on *"Setup
/// refused an unsafe or unavailable KSX WinUSB recovery directory (initializer
/// exit code 3)"*, with the progress label reading "Restarting
/// applications...". Inno's default `RestartApplications=yes` had the
/// RestartManager bring ksx.exe back while `CurStepChanged(ssPostInstall)` was
/// still running `initialize-store`, and the restarted ksx reopens the
/// protected WinUSB store and takes the handles the initializer needs.
///
/// The initializer is the one step that can roll an install back, so it must
/// not be the step racing a process Setup itself started. `RestartApplications`
/// is one word on one line, ISCC compiles either value happily, and the failure
/// only appears on a machine that already had ksx running — which is to say,
/// never in CI and always on a customer's second install.
#[test]
fn setup_closes_a_running_ksx_and_does_not_restart_it_mid_install() {
    let entries = section(&script(), "[Setup]");
    let value = |key: &str| {
        entries
            .iter()
            .find_map(|line| {
                let (name, value) = line.split_once('=')?;
                name.trim()
                    .eq_ignore_ascii_case(key)
                    .then(|| value.trim().to_ascii_lowercase())
            })
            .unwrap_or_else(|| panic!("[Setup] does not set {key}"))
    };
    assert_eq!(
        value("CloseApplications"),
        "yes",
        "a running ksx must be closed, or its files cannot be replaced"
    );
    assert_eq!(
        value("RestartApplications"),
        "no",
        "restarting ksx before ssPostInstall finishes races `initialize-store` \
         for the protected WinUSB store, which rolls the whole install back"
    );
}
