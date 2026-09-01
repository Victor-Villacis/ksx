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
//! Neither of those two tests checks that a doc is *true*. Nothing can. They
//! check the two mechanical properties that keep a doc reachable, which is the
//! precondition for anyone noticing it is not true.
//!
//! # What is actually in this file
//!
//! The header used to stop here, accounting for three tests in a file that had
//! five. The other two do not read Markdown at all, and a reader who trusted
//! this paragraph would not have known to look for them. The full set:
//!
//! | test | reads | guards |
//! |---|---|---|
//! | `every_section_number_the_code_cites_still_exists_in_device_identity` | `docs/*.md` + `crates/**/*.rs` | a renumber silently breaking a `§n` citation |
//! | `every_governing_doc_is_cited_from_the_code_it_governs` | same | a normative doc drifting into a memo |
//! | `the_docs_directory_has_no_unclassified_file` | `docs/*.md` | a NEW doc opting itself out of the guard above by not being added to a list |
//! | `the_setup_docs_name_the_picker_wherever_they_show_a_devnode` | two docs | a page teaching a reader to hand-author a device id |
//! | `the_devnode_detector_is_not_asleep` | `docs/DEVICE-IDENTITY.md` | the test above passing because its detector matches nothing |
//! | `managed_real_qa_is_an_idle_identity_checked_process_pair` | `tools/studio-env/*.ps1` | real-QA launching a session, or trusting an unidentified pipe |
//! | `the_generated_asset_graph_is_lock_guarded_and_receipted` | build scripts + `render_map.rs` | Node writers and Cargo readers racing on generated assets |
//! | `real_replacement_and_watch_defer_to_a_live_session` | `tools/studio-env/*.ps1` | a rebuild yanking a running Play session |
//! | `clean_ci_runs_the_environment_lifecycle_and_the_hardware_gate` | `.github/workflows/ci.yml` | CI dropping the jobs the above depend on |
//! | `release_promotes_the_exact_candidate_bytes` | release workflow + `tools/release/*.ps1` | promotion shipping look-alike bytes |
//! | `one_node_pin_governs_every_asset_build` | `.node-version`, `package*.json`, CI | two Node versions producing two asset builds |
//!
//! The last five were one 60-assertion test called
//! `development_and_release_promotion_are_identity_bound`. It read fourteen
//! files, and the first failing `assert!` aborted the rest — so a red run told
//! you one token and not which of five subsystems had drifted. Splitting it at
//! the seams the code already has costs nothing and names the subsystem.

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
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{} is missing: {e}", path.display()))
        .replace("\r\n", "\n")
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
///
/// **The hole this list has**, which [`the_docs_directory_has_no_unclassified_file`]
/// closes: a doc opts out of this guard by not being added to it. Nine files in
/// `docs/` have zero citations from `crates/**/*.rs` right now, and one of them
/// (`STUDIO-EXPERIENCE.md`) opens by calling itself "the product-level contract
/// for KSX Studio" — byte for byte the state described three paragraphs up.
///
/// Normative documents only. Runbooks and narrative (QUICKSTART, RECOVERY,
/// PLAYBOOK) are addressed to a human and are not on trial here.
const GOVERNING: &[&str] = &[
    "ARCHITECTURE.md",
    "CONTROL-SURFACE.md",
    "DEFERRED-SURFACES.md",
    "DEVICE-IDENTITY.md",
    "ENHANCEMENTS.md",
    "INPUT-TRANSFORMS.md",
    "M9-DECISION.md",
    "MAPPER-UX.md",
    "SURFACES.md",
    "UNIVERSAL-IO.md",
];

/// Docs deliberately NOT under the memo guard, each with the reason.
///
/// Split in two because the two halves fail in opposite directions. A
/// [`NARRATIVE`] doc is cited or not, and either is fine. An [`UNCITED`] doc is
/// a normative-shaped page with **zero** hooks into the code — the exact defect
/// the memo guard exists for, recorded here rather than left to be discovered,
/// so that the day one of them gets its first citation this file tells somebody
/// to promote it into [`GOVERNING`].
const NARRATIVE: &[&str] = &[
    "DESIGN-SYSTEM.md",
    "DRIVERS.md",
    "FIRST-RUN.md",
    "FORMA-DOGFOOD.md",
    "GATES.md",
    "HIDMAESTRO-STATE.md",
    "MIGRATION-WINUSB.md",
    "PLAYBOOK.md",
    "RECOVERY.md",
    "USE-CASES.md",
];

/// Zero citations from `crates/**/*.rs`, verified below. Ordered as `ls` gives
/// them so a diff against `docs/` is readable.
const UNCITED: &[&str] = &[
    // Process/runbook pages, addressed to whoever is doing the release.
    "DEVELOPMENT-PIPELINE.md",
    "HANDOFF.md",
    "ORGANIZATION.md",
    "QUICKSTART.md",
    "RELEASING.md",
    "STUDIO-ENVIRONMENTS.md",
    // ...and these two are NOT process pages. `INTEGRATION.md` states a rule
    // ("something must always stop ksx") and `STUDIO-EXPERIENCE.md` calls
    // itself a contract; `HIDMAESTRO.md` describes a driver this repo drives.
    // They are here because they have no hook, which is a finding, not a
    // classification.
    "HIDMAESTRO.md",
    "INTEGRATION.md",
    "STUDIO-EXPERIENCE.md",
];

/// **Nothing in `docs/` gets to be unclassified.**
///
/// The memo guard above is a hand-written list, so the cheapest way past it is
/// to add a normative doc and not add it to the list — which is how nine of
/// them ended up uncited without anyone deciding anything. Every `docs/*.md`
/// must therefore be in exactly one of [`GOVERNING`], [`NARRATIVE`] or
/// [`UNCITED`], and a new file fails here until somebody says which it is.
#[test]
fn the_docs_directory_has_no_unclassified_file() {
    let dir = repo_root().join("docs");
    let mut on_disk: BTreeSet<String> = BTreeSet::new();
    for entry in std::fs::read_dir(&dir).expect("docs/ exists").flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".md") {
            on_disk.insert(name);
        }
    }
    assert!(!on_disk.is_empty(), "docs/ is empty — did the walk break?");

    let mut classified: BTreeSet<String> = BTreeSet::new();
    for name in GOVERNING.iter().chain(NARRATIVE).chain(UNCITED) {
        assert!(
            classified.insert((*name).to_owned()),
            "docs/{name} is classified twice"
        );
        assert!(
            on_disk.contains(*name),
            "docs/{name} is classified here but no longer exists — delete the entry"
        );
    }
    let unclassified: Vec<&String> = on_disk.difference(&classified).collect();
    assert!(
        unclassified.is_empty(),
        "these docs are in neither GOVERNING, NARRATIVE nor UNCITED: {unclassified:?}. \
         Say which. If the page states rules the code must follow, it belongs in \
         GOVERNING and needs a citation from the code it governs."
    );

    // The UNCITED ledger has to stay true, or it is a lie that looks like a
    // decision. When one of these gains its first hook, promote it.
    let sources = source_files();
    for name in UNCITED {
        let citing: Vec<&str> = sources
            .iter()
            .filter(|(_, text)| text.contains(name))
            .map(|(file, _)| file.as_str())
            .take(3)
            .collect();
        assert!(
            citing.is_empty(),
            "docs/{name} is listed as having no hook into the code, but {citing:?} cite it \
             now. Move it into GOVERNING so the memo guard keeps it there."
        );
    }
}

#[test]
fn every_governing_doc_is_cited_from_the_code_it_governs() {
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
///
/// **Neither page shows a devnode today**, so this is a ratchet rather than a
/// live check — which is exactly the state that makes a guard worth
/// distrusting. It used to detect one with `line.contains("id ") &&
/// line.contains('=') && line.contains("VID_")`, a three-substring conjunction
/// that matched nothing in either file (they contain no `VID_` at all), so both
/// loop iterations hit `continue` and the test ran zero assertions. The
/// detector below is the shape a device instance path actually has, and
/// [`the_devnode_detector_is_not_asleep`] proves it still fires on a page that
/// does show one.
#[test]
fn the_setup_docs_name_the_picker_wherever_they_show_a_devnode() {
    for name in ["QUICKSTART.md", "MIGRATION-WINUSB.md"] {
        let text = read_doc(name);
        let Some(line) = devnode_line(&text) else {
            continue;
        };
        let _ = line;
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

/// A line that shows a Windows device instance path — `USB\VID_xxxx&PID_yyyy…`
/// or the `HID\…` form — which is the value a reader could be tempted to copy.
///
/// Deliberately not keyed on `id ` or `=`: the sentence in
/// docs/DEVICE-IDENTITY.md §1 is about showing the *path*, and a page that
/// prints one in a table or a code fence teaches the same wrong lesson as one
/// that prints it beside an `=`.
fn devnode_line(text: &str) -> Option<&str> {
    text.lines()
        .find(|line| line.contains('\\') && line.contains("VID_") && line.contains("&PID_"))
}

/// **...and the detector above is not asleep.**
///
/// Companion in the same spirit as `ksx-cabinet`'s
/// `sixteen_rows_do_not_fit_on_a_cabinet_panel`: the guard it protects passes
/// today by finding nothing, and a guard that passes by finding nothing is one
/// rewrite away from being permanently green and permanently useless. So this
/// drives [`devnode_line`] against a page that certainly does show a devnode,
/// and requires the whole rule to hold there.
#[test]
fn the_devnode_detector_is_not_asleep() {
    let text = read_doc("DEVICE-IDENTITY.md");
    let line = devnode_line(&text).expect(
        "docs/DEVICE-IDENTITY.md no longer shows a device instance path, so nothing \
         anywhere proves `devnode_line` still matches one. Point this at another page \
         that does, or the setup-doc guard is asleep.",
    );
    assert!(
        line.contains("VID_"),
        "the matched line is not a devnode: {line:?}"
    );
    // The rule itself, on a page where the premise is live.
    assert!(
        text.contains("ksx device pick"),
        "docs/DEVICE-IDENTITY.md shows a devnode without naming the picker"
    );
    // A page that shows NO devnode must not match — otherwise the detector is
    // matching prose and the guard above would fire on every page forever.
    assert!(
        devnode_line(&read_doc("QUICKSTART.md")).is_none(),
        "the detector matched docs/QUICKSTART.md, which shows no device instance path"
    );
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
    let seed = read_repo_file("tools/studio-env/seed.ps1");
    let teardown = read_repo_file("tools/studio-env/teardown.ps1");
    let status = read_repo_file("tools/studio-env/status.ps1");

    for (name, script) in [
        ("real startup", &start),
        ("fixture seed", &seed),
        ("status", &status),
    ] {
        assert!(
            script.contains("/api/health") && !script.contains("/api/nocturne"),
            "{name} must prove its listener through the stable health contract"
        );
    }
    for (name, script) in [
        ("real startup", &start),
        ("fixture seed", &seed),
        ("status", &status),
    ] {
        assert!(
            script.contains("/redesign"),
            "{name} must direct operators to the redesign product route"
        );
    }

    assert!(
        start.contains(r#"-ArgumentList @("daemon", "--console")"#),
        "real QA must launch the managed daemon in the foreground logging mode"
    );
    assert!(
        !start.contains(r#"-ArgumentList @("daemon", "--start")"#),
        "opening real QA must not start an emulation session"
    );
    assert!(
        start.contains("Get-CargoInterceptionRuntimeSource")
            && start.contains(r#"-Filter "interception-sys-*""#)
            && start.contains("CandidateHashes.Count -ne 1")
            && start.contains("InterceptionSourceHash"),
        "real QA must discover Cargo's current Interception runtime without accepting ambiguous or stale bytes"
    );
    assert!(
        start
            .find("$CargoInterceptionSource = Get-CargoInterceptionRuntimeSource")
            .unwrap()
            < start
                .find(
                    r#"& (Join-Path $PSScriptRoot "teardown.ps1") -Environment real -AllowMissing"#,
                )
                .unwrap(),
        "Interception runtime ambiguity must fail before a healthy real lane is torn down"
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
        probe.contains("ProcessQueryLimitedInformation | Synchronize")
            && probe.contains("ProcessTerminate | ProcessQueryLimitedInformation | Synchronize")
            && probe.contains("StaleIdentityAsMissing")
            && probe.contains("Test-KsxProcessNameProvesStaleIdentity")
            && probe.contains("NativeErrorCode -eq 5")
            && teardown.contains("-StaleIdentityAsMissing")
            && start.contains("-StaleIdentityAsMissing"),
        "receipt recovery must inspect identity before requesting termination and tolerate only proven-stale generations"
    );
    let try_open_start = probe
        .find("public static ExactProcess TryOpen")
        .expect("runtime probe must expose exact-process inspection");
    let terminate_start = probe[try_open_start..]
        .find("public void Terminate")
        .map(|offset| try_open_start + offset)
        .expect("runtime probe must expose lazy exact-process termination");
    assert!(
        !probe[try_open_start..terminate_start].contains("ProcessTerminate"),
        "initial identity inspection must not request process-termination authority"
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
}

// ── The five below were one test ────────────────────────────────────────────
//
// `development_and_release_promotion_are_identity_bound` made one true claim —
// "the bytes being observed are identified, coherent, and never silently
// replaced by look-alike output" — across fourteen files and some sixty
// assertions in a single `fn`. The claim survives; what does not is the single
// failure message. `assert!` aborts, so a red run named one token and left you
// to work out which of five subsystems had drifted. These are split at the
// seams the code already has: asset graph, watch/teardown, CI, promotion, and
// the Node pin.

/// **The generated-asset handoff.** Node writes `studio-ui/tokens/*` and
/// `crates/ksx-studio/assets/*`; Cargo reads them. One lock and one receipt is
/// what stops a reader from seeing half a build.
#[test]
fn the_generated_asset_graph_is_lock_guarded_and_receipted() {
    let build_graph = read_repo_file("tools/studio-env/build-graph.ps1");
    let assets = read_repo_file("tools/studio-env/build-assets.ps1");
    let source_graph = read_repo_file("tools/studio-env/source-graph.ps1");
    let render_map = read_repo_file("crates/ksx-studio/src/render_map.rs");
    let start = read_repo_file("tools/studio-env/start-real.ps1");
    let seed = read_repo_file("tools/studio-env/seed.ps1");

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
}

/// **A rebuild must never yank a running Play session.** The watcher is a
/// singleton, it debounces, and both it and teardown require a typed idle or
/// absent answer before they replace anything.
#[test]
fn real_replacement_and_watch_defer_to_a_live_session() {
    let watch = read_repo_file("tools/studio-env/watch.ps1");
    let start = read_repo_file("tools/studio-env/start-real.ps1");
    let status = read_repo_file("tools/studio-env/status.ps1");
    let teardown = read_repo_file("tools/studio-env/teardown.ps1");

    assert!(
        start.contains("KSX_WATCH_DEFERRED:")
            && start.contains("$ExactStopped")
            && start.contains("$ExactAbsent")
            && start.contains(r#"Payload.run -ceq "stopped""#)
            && start.contains(r#"Payload.code -ceq "daemon-not-running""#),
        "real replacement must defer across a live Play session"
    );
    assert!(
        teardown.contains("Invoke-KsxDaemonStatusProbe")
            && teardown.contains("$ExactIncompleteAbsent"),
        "direct real teardown must require typed idle/absence"
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
}

/// **CI has to actually run the lifecycle above.** Every guard in this file is
/// a source freeze; the only thing that proves the scripts still work is the
/// job that executes them.
#[test]
fn clean_ci_runs_the_environment_lifecycle_and_the_hardware_gate() {
    let ci = read_repo_file(".github/workflows/ci.yml");

    assert!(
        ci.contains("studio-environments:")
            && ci.contains("tools/studio-env/build-assets.ps1")
            && ci.contains("http://127.0.0.1:4476/api/health")
            && !ci.contains("http://127.0.0.1:4476/api/nocturne")
            && ci.contains("Prove PowerShell 5.1 and 7 hash the same build graph")
            && ci.contains("watch.ps1")
            && ci.contains("-Environment seeded -Once")
            && ci.contains("format('source-{0}-{1}', github.event_name, github.ref)")
            && ci.contains("cargo check -p ksx-output --features cab-tests --all-targets")
            && ci.contains("needs: [test, studio-browser, studio-environments,"),
        "clean CI must execute the environment lifecycle and compile the hardware-only gate"
    );
}

/// **Promotion ships the exact bytes CI built.** A release that rebuilds is a
/// release nobody tested: the tag run's artifact is downloaded, its digest
/// checked, and the whole thing waits behind a production approval.
#[test]
fn release_promotes_the_exact_candidate_bytes() {
    let installer = read_repo_file(".github/workflows/build-installer.yml");
    // Git may materialize workflow files with CRLF on Windows. These checks
    // care about YAML structure, not the checkout's newline convention.
    let release = read_repo_file(".github/workflows/release.yml").replace("\r\n", "\n");
    let promotion_controls = read_repo_file("tools/release/assert-promotion-controls.ps1");
    let promotion_activation = read_repo_file("tools/release/activate-studio-promotion-checks.ps1");
    let pipeline = read_doc("DEVELOPMENT-PIPELINE.md");

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
}

/// **One Node pin, everywhere.** Two Node versions produce two asset builds,
/// and the generated files are byte-compared by
/// `render_map.rs`'s stale-token check — so a drifting pin surfaces as a
/// mysterious "generated zone tokens are stale" instead of as itself.
#[test]
fn one_node_pin_governs_every_asset_build() {
    let assets = read_repo_file("tools/studio-env/build-assets.ps1");
    let ci = read_repo_file(".github/workflows/ci.yml");
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
