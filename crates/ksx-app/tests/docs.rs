//! The design docs, as tests.
//!
//! # Why a test crate reads Markdown
//!
//! `docs/` is not reference material here — several files are *normative*, and
//! the code cites them by section number to explain why it refuses something.
//! That arrangement has two failure modes that no compiler catches:
//!
//! 1. **A renumber.** `docs/DEVICE-IDENTITY.md` is cited from twelve source
//!    files, around twenty-five times, by section number. Delete a section or
//!    insert one and every citation below it starts pointing at the wrong
//!    argument — silently, and only for the person reading the code at 2 a.m.
//! 2. **A doc drifting into a memo.** `docs/SURFACES.md` was written as a peer
//!    of `docs/CONTROL-SURFACE.md` and, at its first audit, had **zero**
//!    references anywhere in the repository while its peers had 8 to 106. A
//!    design document nothing points at is not consulted when the code it
//!    governs is written, and its rules get broken without anyone deciding to
//!    break them — which is exactly what that audit found.
//!
//! Neither test checks that a doc is *true*. Nothing can. They check the two
//! mechanical properties that keep a doc reachable, which is the precondition
//! for anyone noticing it is not true.
//!
//! The third test guards a specific promise rather than a mechanism, and it is
//! here because it is a documentation rule with a user-visible cost: the setup
//! docs must not teach someone to hand-author a device id.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// The repository root: this crate is `<root>/crates/ksx-app`.
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crates/ksx-app is two levels below the repo root")
        .to_path_buf()
}

/// This file, which is excluded from every scan below.
///
/// Not tidiness — correctness. These tests name the documents they check, in
/// prose, so a scan that included this file would find `SURFACES.md` cited by
/// the very test asserting that something cites it. It would pass for a
/// repository in exactly the state that motivated it.
const SELF: &str = "crates/ksx-app/tests/docs.rs";

/// Every `.rs` file under `crates/`, with its repo-relative path.
///
/// A hand-rolled walk rather than a dev-dependency: this crate's dev-deps are
/// part of what `docs/GATES.md` checks, and a directory walk is eleven lines.
fn source_files() -> Vec<(String, String)> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<(String, String)>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if path.file_name().is_some_and(|n| n == "target") {
                    continue;
                }
                walk(&path, root, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                let name = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .display()
                    .to_string()
                    .replace('\\', "/");
                if name == SELF {
                    continue;
                }
                if let Ok(text) = std::fs::read_to_string(&path) {
                    out.push((name, text));
                }
            }
        }
    }
    let root = repo_root();
    let mut out = Vec::new();
    walk(&root.join("crates"), &root, &mut out);
    assert!(
        out.len() > 50,
        "the source walk found {} files, which means it walked the wrong tree",
        out.len()
    );
    out
}

fn read_doc(name: &str) -> String {
    let path = repo_root().join("docs").join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{} is missing: {e}", path.display()))
}

fn read_repo_file(name: &str) -> String {
    let path = repo_root().join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{} is missing: {e}", path.display()))
}

/// Every `§N` cited within a few characters of `doc`'s filename, and who cites
/// it.
///
/// The window is deliberately tiny. Citations are written exactly two ways —
/// ``docs/DEVICE-IDENTITY.md` §6`` and `docs/DEVICE-IDENTITY.md §6)` — so three
/// characters is enough to find the `§`, and short enough that a section number
/// belonging to a *different* document mentioned in the same sentence cannot be
/// picked up by accident.
fn citations(doc: &str) -> BTreeMap<u32, BTreeSet<String>> {
    let mut found: BTreeMap<u32, BTreeSet<String>> = BTreeMap::new();
    for (file, text) in source_files() {
        for (at, _) in text.match_indices(doc) {
            let tail = &text[at + doc.len()..];
            let head: String = tail.chars().take(3).collect();
            let Some(rel) = head.find('§') else { continue };
            let digits: String = tail[rel + '§'.len_utf8()..]
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            if let Ok(section) = digits.parse::<u32>() {
                found.entry(section).or_default().insert(file.clone());
            }
        }
    }
    found
}

/// **The renumber guard.**
///
/// `docs/DEVICE-IDENTITY.md`'s own status block calls its section numbers
/// "load-bearing" and used to name one file as the reason. It is twelve files.
/// Renumbering, or deleting a section, leaves every citation below it pointing
/// at an argument that is no longer there — and a citation is the only thing
/// explaining why several refusals are worded the way they are.
///
/// Breaks against: deleting a cited section, renumbering the file, or demoting
/// a `## §N` heading to plain text.
#[test]
fn every_section_number_the_code_cites_still_exists_in_device_identity() {
    let doc = read_doc("DEVICE-IDENTITY.md");
    let headings: BTreeSet<u32> = doc
        .lines()
        .filter_map(|line| {
            let rest = line.trim_start().strip_prefix("## §")?;
            rest.split_whitespace()
                .next()
                .and_then(|n| n.parse::<u32>().ok())
        })
        .collect();
    assert!(
        headings.len() >= 5,
        "the heading scan found {headings:?}, which means the format changed"
    );

    let cited = citations("DEVICE-IDENTITY.md");
    assert!(
        cited.len() >= 5,
        "the citation scan found {cited:?} — if the code really stopped citing \
         this document, that is the finding, not a passing test"
    );
    for (section, files) in &cited {
        assert!(
            headings.contains(section),
            "code cites docs/DEVICE-IDENTITY.md §{section}, which has no `## §{section}` \
             heading. Cited from:\n  {}\nHeadings present: {headings:?}",
            files.iter().cloned().collect::<Vec<_>>().join("\n  ")
        );
    }
}

/// **The memo guard.**
///
/// Every doc listed here states rules the code is supposed to follow. A rule
/// nobody is pointed at while writing the code is not enforced by anything —
/// and `SURFACES.md` proved it: written as a peer of `CONTROL-SURFACE.md`,
/// cited nowhere, and by its first audit four cells of its capability matrix
/// described capabilities that did not exist.
///
/// One citation is a low bar on purpose. This is not "cite the doc everywhere";
/// it is "a governing document must have at least one hook into the code it
/// governs", which is the difference between a design doc and a memo.
///
/// Breaks against: adding a normative doc with no call-site reference, or
/// deleting the last reference to one — the state `SURFACES.md` shipped in.
#[test]
fn every_governing_doc_is_cited_from_the_code_it_governs() {
    // Normative documents only. Runbooks and narrative (QUICKSTART, RECOVERY,
    // PLAYBOOK) are addressed to a human and are not on trial here.
    const GOVERNING: &[&str] = &[
        "ARCHITECTURE.md",
        "CONTROL-SURFACE.md",
        "DEVICE-IDENTITY.md",
        "ENHANCEMENTS.md",
        "INPUT-TRANSFORMS.md",
        "M9-DECISION.md",
        "MAPPER-UX.md",
        "SURFACES.md",
        "UNIVERSAL-IO.md",
    ];

    let sources = source_files();
    for doc in GOVERNING {
        assert!(
            repo_root().join("docs").join(doc).exists(),
            "docs/{doc} is listed as governing but does not exist"
        );
        let citing: Vec<&str> = sources
            .iter()
            .filter(|(_, text)| text.contains(doc))
            .map(|(file, _)| file.as_str())
            .take(3)
            .collect();
        assert!(
            !citing.is_empty(),
            "no source file mentions docs/{doc}. A design document with no hook \
             into the code it governs is a memo: nobody reads it while writing \
             the thing it constrains, and its rules get broken without anyone \
             deciding to break them. Cite it where it applies, or move it out \
             of docs/ and say it is history."
        );
    }
}

/// **The one documentation rule with a user-visible cost.**
///
/// `docs/DEVICE-IDENTITY.md` §1: every path that teaches a user to paste a raw
/// device instance path "teaches them to hand-author a value they have no way
/// to know" — it is one specific board, in one specific socket, on one specific
/// machine. `ksx device pick` exists precisely so nobody has to, and it landed
/// while both of these pages still showed a devnode with no mention of it.
///
/// The rule is deliberately not "no devnode may appear". A migration page has
/// to show the id it is migrating *from*, and every config written before
/// selectors existed holds one. The rule is that the page cannot show one
/// without also naming the command that writes it for you.
///
/// Breaks against: the state both files shipped in, and against a future edit
/// that adds a hand-pasted example to either.
#[test]
fn the_setup_docs_name_the_picker_wherever_they_show_a_devnode() {
    for name in ["QUICKSTART.md", "MIGRATION-WINUSB.md"] {
        let text = read_doc(name);
        let shows_a_devnode = text
            .lines()
            .any(|line| line.contains("id ") && line.contains('=') && line.contains(r"VID_"));
        if !shows_a_devnode {
            continue;
        }
        assert!(
            text.contains("ksx device pick"),
            "docs/{name} shows a literal device instance path as an `id` but never \
             names `ksx device pick`. That teaches a reader to hand-author a value \
             they cannot look up — it is one person's board in one socket \
             (docs/DEVICE-IDENTITY.md §1)."
        );
        assert!(
            text.contains("usb:d209:0430:00"),
            "docs/{name} should show the `usb:` selector beside the devnode, since \
             that is what the picker writes and what a reader should copy"
        );
    }
}

/// **The managed real-QA lifecycle contract.**
///
/// Port 4460 is useful only when Studio and the daemon share one matched
/// managed artifact. These assertions intentionally guard the small set of
/// script tokens that prove that relationship: an idle daemon, a reachable draft, exact ownership of
/// both global pipes, same-handle shutdown, and a paired schema-v2 record.
#[test]
fn managed_real_qa_is_an_idle_identity_checked_process_pair() {
    let start = read_repo_file("tools/studio-env/start-real.ps1");
    let probe = read_repo_file("tools/studio-env/runtime-probe.ps1");
    let teardown = read_repo_file("tools/studio-env/teardown.ps1");
    let status = read_repo_file("tools/studio-env/status.ps1");

    assert!(
        start.contains(r#"-ArgumentList @("daemon", "--console")"#),
        "real QA must launch the managed daemon in the foreground logging mode"
    );
    assert!(
        !start.contains(r#"-ArgumentList @("daemon", "--start")"#),
        "opening real QA must not start an emulation session"
    );
    assert!(
        start.contains("$Payload.staged.reachable"),
        "the real-QA health gate must require Studio's draft channel to reach the daemon"
    );
    for pipe in [r#"-PipeName "ksx-daemon""#, r#"-PipeName "ksx-live""#] {
        assert!(
            start.matches(pipe).count() >= 2,
            "the startup and post-Studio health gates must both verify ownership of {pipe}"
        );
        assert!(
            status.contains(pipe),
            "status must verify ownership of {pipe} before calling real QA healthy"
        );
    }

    assert!(
        probe.contains("GetNamedPipeServerProcessId(pipe.SafePipeHandle"),
        "pipe identity must come from the connected handle"
    );
    assert!(
        probe.matches("TokenImpersonationLevel.Anonymous").count() >= 2
            && probe.matches("HandleInheritability.None").count() >= 2,
        "identity and quit probes must use anonymous, non-inheritable pipe handles"
    );
    let quit_start = probe
        .find("public static void RequestExactDaemonQuit")
        .expect("runtime probe must expose an exact-daemon quit operation");
    let quit_end = probe[quit_start..]
        .find("function Stop-KsxDaemonGracefully")
        .map(|offset| quit_start + offset)
        .expect("the C# exact-quit helper must end before its PowerShell wrapper");
    let exact_quit = &probe[quit_start..quit_end];
    assert_eq!(
        exact_quit.matches("new NamedPipeClientStream(").count(),
        1,
        "exact quit must validate and write through one connected pipe handle"
    );
    assert!(
        exact_quit.contains("GetNamedPipeServerProcessId(pipe.SafePipeHandle")
            && exact_quit.contains("new StreamWriter(\n                    pipe,")
            && exact_quit.contains(r#"writer.WriteLine("{\"verb\":\"quit\"}")"#),
        "exact quit must check the server PID and send quit on that same handle"
    );

    assert!(
        start.contains("schema_version = 2") && start.contains("processes = @("),
        "the real launcher must persist its daemon and Studio as a schema-v2 process pair"
    );
    for (name, script) in [("teardown", &teardown), ("status", &status)] {
        assert!(
            script.contains(r#"PSObject.Properties.Name -contains "processes""#)
                && script.contains(r#"role -eq "studio""#)
                && script.contains(r#"role -eq "daemon""#)
                && script.contains(r#"PSObject.Properties.Name -contains "schema_version""#),
            "{name} must understand both roles in the paired schema-v2 record"
        );
    }
    assert!(
        teardown.contains("Stop-KsxDaemonGracefully -ExpectedProcessId $ManagedProcessId"),
        "teardown must use the identity-checked same-handle daemon quit"
    );
    assert!(
        status.contains("$DaemonReachable = [bool]$Payload.staged.reachable")
            && status.contains("$DaemonPipesValid"),
        "status must require both draft reachability and exact pipe ownership"
    );
    assert!(
        start.contains("Get-Process WinIPAC -ErrorAction SilentlyContinue")
            && start.contains("This script will not close it."),
        "real QA may warn that WinIPAC can contend for MI_02, but must never close the user's configurator"
    );
    let winipac_start = start
        .find("$WinIpac = Get-Process WinIPAC -ErrorAction SilentlyContinue")
        .expect("real QA must retain its advisory WinIPAC probe");
    let winipac_end = start[winipac_start..]
        .find("$TransitionMutex = $null")
        .map(|offset| winipac_start + offset)
        .expect("the advisory WinIPAC block must end before environment transition work");
    let winipac_block = &start[winipac_start..winipac_end];
    for forbidden in ["Stop-Process", "CloseMainWindow", ".Kill("] {
        assert!(
            !winipac_block.contains(forbidden),
            "the advisory WinIPAC block must not use {forbidden}"
        );
    }
}

/// The fast development loop and the release pipeline protect different
/// boundaries, but together they make one claim: the bytes being observed are
/// identified, coherent, and never silently replaced by look-alike output.
#[test]
fn development_and_release_promotion_are_identity_bound() {
    let build_graph = read_repo_file("tools/studio-env/build-graph.ps1");
    let assets = read_repo_file("tools/studio-env/build-assets.ps1");
    let source_graph = read_repo_file("tools/studio-env/source-graph.ps1");
    let render_map = read_repo_file("crates/ksx-studio/src/render_map.rs");
    let watch = read_repo_file("tools/studio-env/watch.ps1");
    let start = read_repo_file("tools/studio-env/start-real.ps1");
    let seed = read_repo_file("tools/studio-env/seed.ps1");
    let status = read_repo_file("tools/studio-env/status.ps1");
    let teardown = read_repo_file("tools/studio-env/teardown.ps1");
    let ci = read_repo_file(".github/workflows/ci.yml");
    let installer = read_repo_file(".github/workflows/build-installer.yml");
    // Git may materialize workflow files with CRLF on Windows. These checks
    // care about YAML structure, not the checkout's newline convention.
    let release = read_repo_file(".github/workflows/release.yml").replace("\r\n", "\n");
    let promotion_controls = read_repo_file("tools/release/assert-promotion-controls.ps1");
    let promotion_activation = read_repo_file("tools/release/activate-studio-promotion-checks.ps1");
    let pipeline = read_doc("DEVELOPMENT-PIPELINE.md");

    assert!(
        build_graph.contains(r#"Global\KSXStudioBuildGraph-v1"#)
            && build_graph.contains("assets.dirty")
            && build_graph.contains("assets-state.json")
            && build_graph.contains("Assert-KsxStudioAssetGraphReady"),
        "one shared graph lock and fail-closed receipt must guard Node writers and Cargo readers"
    );
    assert_eq!(
        assets.matches("Invoke-StudioAssetBuild").count(),
        3,
        "the wrapper should define one build operation and invoke it exactly twice"
    );
    for token in [
        "studio_input_sha256",
        "zone_producer_sha256",
        "asset_graph_sha256",
        "generated_file_count",
        "Get-FileHash",
    ] {
        assert!(assets.contains(token), "asset receipt lost {token}");
    }
    assert!(
        source_graph.contains(r#""tools\studio-env\build-assets.ps1""#)
            && source_graph.contains(r#""tools\studio-env\build-graph.ps1""#)
            && source_graph.contains(r#""tools\studio-env\source-graph.ps1""#)
            && source_graph
                .contains(r#"-ExcludedRelativePrefixes @("studio-ui/tokens/zones.json")"#),
        "asset compiler semantics must be inputs while the Rust handoff remains an output"
    );
    assert!(
        render_map
            .contains("generated zone tokens are stale; run tools/studio-env/build-assets.ps1"),
        "the Rust handoff verifier must route remediation through the locked wrapper"
    );
    assert!(
        assets
            .find("$StudioInputBefore = Get-KsxSourceGraphFingerprint")
            .unwrap()
            < assets
                .find("$Toolchain = Resolve-KsxStudioToolchain")
                .unwrap(),
        "asset authoring identity must be captured before long preflight/generation work"
    );
    for (name, script) in [("real", &start), ("fixture", &seed)] {
        assert!(
            script.contains("Enter-KsxStudioBuildGraphLock")
                && script.contains("Assert-KsxStudioAssetGraphReady"),
            "{name} Cargo build must share the generated-asset graph lock"
        );
    }

    assert!(
        start.contains(r#"Global\KeyboardSplitterXboxPro.PanelProgramming.v1"#)
            && start.contains("KSX_WATCH_DEFERRED:")
            && start.contains("$ExactStopped")
            && start.contains("$ExactAbsent")
            && start.contains(r#"Payload.run -ceq "stopped""#)
            && start.contains(r#"Payload.code -ceq "daemon-not-running""#),
        "real replacement must defer across Play and persistent panel transactions"
    );
    assert!(
        teardown.contains(r#"Global\KeyboardSplitterXboxPro.PanelProgramming.v1"#)
            && teardown.contains("Invoke-KsxDaemonStatusProbe")
            && teardown.contains("$ExactIncompleteAbsent"),
        "direct real teardown must share the hardware lease and require typed idle/absence"
    );
    assert!(
        watch.contains(r#"Global\KSXStudioEnvironment-$Environment-watch-v1"#)
            && watch.contains("DebounceMilliseconds = 900")
            && watch.contains("another edit arrived during the build")
            && watch.contains("leaves the last healthy process running")
            && watch.contains("Get-KsxPostFailureObservation")
            && watch.contains("LastFailedZoneProducers")
            && watch.contains("restart-required"),
        "watch mode must be singleton, debounced, sequential, and preserve healthy service"
    );
    for token in [
        "$Environment",
        "$Json",
        "$RequireHealthy",
        "$RequireCurrent",
        "$Unhealthy",
        "$NotCurrent",
        "ProvenanceComplete",
    ] {
        assert!(
            status.contains(token),
            "automation-safe status lost {token}"
        );
    }

    assert!(
        ci.contains("studio-environments:")
            && ci.contains("tools/studio-env/build-assets.ps1")
            && ci.contains("Prove PowerShell 5.1 and 7 hash the same build graph")
            && ci.contains("watch.ps1")
            && ci.contains("-Environment blank-encoder -Once")
            && ci.contains("format('source-{0}-{1}', github.event_name, github.ref)")
            && ci.contains("cargo check -p ksx-output --features cab-tests --all-targets")
            && ci.contains("needs: [test, studio-browser, studio-environments,"),
        "clean CI must execute the environment lifecycle and compile the hardware-only gate"
    );
    for token in [
        "ksx-candidate-manifest.json",
        "CANDIDATE_RUN_ID",
        "CANDIDATE_RUN_ATTEMPT",
        "SETUP_SHA256",
        "PORTABLE_SHA256",
    ] {
        assert!(installer.contains(token), "candidate manifest lost {token}");
    }
    assert!(
        release.contains("Prove the tag commit is exactly origin/main HEAD")
            && release.contains("environment:\n      name: production")
            && release.contains("KSX_PRODUCTION_APPROVAL_CONFIGURED")
            && release.contains("assert-promotion-controls.ps1")
            && release.contains("ksx-windows-candidate-manifest")
            && release.contains("queue: max")
            && release.contains("gh api --paginate --slurp")
            && release.contains("--draft")
            && release.contains("$_.digest")
            && release.contains("isImmutable")
            && release.contains("the downloaded candidate bytes do not match"),
        "release must wait for approval and promote the exact tag-run bytes"
    );
    for token in [
        "can_admins_bypass",
        "immutable-releases",
        "sha_pinning_required",
        "RequireNoRulesetBypassActors",
        "PolicyRows[0].type -cne 'tag'",
        "KSX main promotion gate",
        "KSX release tag immutability",
        "studio-environments",
        "refs/tags/v*",
        "'update'",
    ] {
        assert!(
            promotion_controls.contains(token),
            "promotion-control verifier lost {token}"
        );
    }
    assert!(
        promotion_activation.contains("contents/.github/workflows?ref=")
            && promotion_activation.contains("[0-9a-fA-F]{40}")
            && promotion_activation
                .find(r#"repos/$Repository/actions/permissions" --input -"#)
                .unwrap()
                < promotion_activation
                    .find(r#"repos/$Repository/rulesets/$([int64]$Detail.id)" --input -"#)
                    .unwrap(),
        "post-merge activation must verify default workflows and fail closed by enabling SHA policy before six-check rules"
    );
    for phrase in [
        "DEV BUILD · REAL HARDWARE",
        "INSTALLED QA",
        "Same run id",
        "without rebuilding",
    ] {
        assert!(pipeline.contains(phrase), "pipeline runbook lost {phrase}");
    }

    let node_pin = read_repo_file(".node-version").trim().to_owned();
    let package = read_repo_file("studio-ui/package.json");
    let package_lock = read_repo_file("studio-ui/package-lock.json");
    assert_eq!(
        node_pin, "24.19.0",
        "production asset Node pin must be current LTS"
    );
    for contract in [r#""node": "24.19.0""#, r#""npm": "11.17.0""#] {
        assert!(
            package.contains(contract),
            "package metadata lost {contract}"
        );
        assert!(
            package_lock.contains(contract),
            "lock metadata lost {contract}"
        );
    }
    assert!(package.contains(r#""packageManager": "npm@11.17.0""#));
    assert!(package.contains("tools/studio-env/build-assets.ps1"));
    assert!(assets.contains(r#"$RequiredNodeVersion = "24.19.0""#));
    assert!(assets.contains(r#"$RequiredNpmVersion = "11.17.0""#));
    assert_eq!(
        ci.matches("node-version-file: '.node-version'").count(),
        3,
        "every Node-bearing CI job must consume the one root pin"
    );
}
