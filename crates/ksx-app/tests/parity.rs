//! **The surface-parity guard** — `docs/SURFACES.md` §1 and §3, as a test.
//!
//! # The two failures this exists for, and they are the same failure
//!
//! `ksx device pick` shipped as a verb with no web face and nobody noticed
//! until the owner opened the UI and found he could not list a board. That is
//! the obvious half. `docs/SURFACES.md` §1 records the other half, which is the
//! same shape pointed the other way: `MachineSource::devices()` was built for a
//! cabinet screen nobody ever wrote, and sat with **zero callers**, compiled
//! behind `#[cfg(all(windows, feature = "cabinet"))]` for a consumer that never
//! asks. A backend verb with no face is not finished — it is untested against a
//! real caller and its shape is a guess.
//!
//! §3's matrix is where those two are supposed to be reconciled. It is prose,
//! so it drifts: at its first audit **four** of its cells described capabilities
//! that did not exist, and two of them said "view" for a surface that renders
//! nothing at all — which reads as shipped. This file makes the matrix a claim
//! the tree either supports or does not.
//!
//! # What the guard checks against what
//!
//! Three evidence sources, none of them a list maintained by hand:
//!
//! | surface | evidence | read from |
//! |---|---|---|
//! | CLI | the clap command tree | the built binary, walked with `--help` |
//! | egui | `Screen::ALL` + every `Ask` variant | `ksx-cabinet/src/{nav,app}.rs`, by source text |
//! | Studio | every `.route()` inside `Router::new()` | `ksx-studio/src/server/mod.rs`, by source text |
//!
//! The two source-text readers work the way `ksx-backend/src/run/plan.rs`'s
//! source-guard test does, and for the same reason: the fact being checked is a
//! *structural* one that no value reachable at runtime reports. In Studio's case
//! the structure is load-bearing twice over — the scan stops at the guard layer
//! (`crate::guard::same_origin`), so a route declared after it, outside the CSRF
//! and DNS-rebinding checks, is invisible here and reads as a missing face.
//!
//! # Why the CLI is walked as a subprocess and not `Cli::command()`
//!
//! `ksx-app` has a `[[bin]]` and no `[lib]`. An integration test is its own
//! crate and can see a package's library types, never a binary's — so `Cli`,
//! `Command` and the derive output are not nameable from `tests/`. Walking the
//! binary's own `--help` is the same tree rendered by the same clap, which is
//! the property that matters: nothing here re-types a verb name. Give this
//! package a `[lib]` holding the CLI types and `walk_clap_tree` becomes eight
//! lines against `clap::CommandFactory`; until then this is the honest reading.
//!
//! The walk runs against a COPY of the binary in a temp directory with a
//! `ksx.toml` beside it, because `ksx` initialises logging before it parses
//! argv: the portable marker makes that temp directory the config root
//! (`ksx_config::ConfigRoot::resolve`), so forty `--help` runs write forty log
//! lines into a directory this test then deletes, instead of into the config
//! root of whoever is running the tests.
//!
//! # What the guard cannot see
//!
//! An `EXEMPT` verb, a cell with no anchor, and a face built under a name the
//! anchor table does not guess. The "nothing is there" direction is a tripwire
//! on the obvious name, not a proof — `/devices/pick` catches a device picker,
//! `/pick-a-board` would not. The "a face exists" direction is exact: the
//! anchors are read out of the tree, so a claim of a shipped face fails the
//! moment the thing backing it is gone.
//!
//! A profile CRUD row now names the still-planned CLI verbs explicitly, so the
//! guard no longer hides their absence inside configuration verbs that happen
//! to exist.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::LazyLock;

// ---------------------------------------------------------------------------
// Reading the tree
// ---------------------------------------------------------------------------

/// The repository root: this crate is `<root>/crates/ksx-app`.
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crates/ksx-app is two levels below the repo root")
        .to_path_buf()
}

/// A repo file, with line endings normalised.
///
/// Not cosmetic: two of the readers below slice on a literal `"\n}"`, and this
/// repository has already shipped one test that passed or failed on how the
/// checkout was configured (`.gitattributes`, commit c5f2532).
fn read_repo(rel: &str) -> String {
    let path = repo_root().join(rel);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{} is missing: {e}", path.display()))
        .replace("\r\n", "\n")
}

// ---------------------------------------------------------------------------
// Evidence 1: the CLI, from the clap command tree
// ---------------------------------------------------------------------------

/// The binary cargo built for this integration test.
const KSX: &str = env!("CARGO_BIN_EXE_ksx");

/// Every runnable verb path, space-separated: `pads`, `device pick`,
/// `macro trace`.
fn cli_verbs() -> &'static BTreeSet<String> {
    static VERBS: LazyLock<BTreeSet<String>> = LazyLock::new(walk_clap_tree);
    &VERBS
}

/// **A refusal may only name a verb that exists.**
///
/// `MachineSource`'s defaults are the sentence a surface says when it cannot do
/// something, and every one of them ends with a way forward. For months several
/// of those ways forward were `ksx panel status`, `ksx panel chart`,
/// `ksx panel program` and `ksx panel restore` — commands deleted by `3901990`
/// along with the encoder chart surface. A user who hit the refusal was told to
/// run something that answers `error: unrecognized subcommand`.
///
/// `ksx-api`'s own test could not catch it. That crate cannot see the clap tree,
/// so all it could check was that *a string* was present — and by asserting the
/// exact dead strings it ENFORCED them. This is the same class the parity suite
/// already exists for: the evidence lives in the built binary, so the guard has
/// to live where the built binary is.
///
/// Only ``ksx …`` in backticks counts, and only outside a doc comment. A
/// remedy is free to name a surface ("open the ksx Studio"), a concept
/// ("saved layout management"), or a fact ("ksx does not write to encoder
/// hardware") — what it may not do is spell a command that does not exist.
///
/// Prose is skipped deliberately. A doc comment names the verb a trait method
/// CORRESPONDS to, which is a statement about the domain and stays true while
/// a surface is missing; a remedy is an instruction to a user standing in
/// front of a refusal, and that has to work today.
#[test]
fn every_machine_remedy_names_a_verb_that_exists() {
    const SRC: &str = include_str!("../../ksx-api/src/machine.rs");

    // Verbs this build genuinely lacks because a Cargo feature is off. The
    // parity binary is built with default features, so `Studio` — which is
    // `#[cfg(feature = "studio")]` — is absent from its `--help` while being
    // perfectly real in a shipped build. Naming it here is cheaper and far
    // more honest than teaching the walk to build every feature combination.
    const FEATURE_GATED: &[&str] = &["studio"];

    let verbs = cli_verbs();
    let mut missing: Vec<String> = Vec::new();

    // Every ``ksx …`` token in the file, taken from the source rather than by
    // calling 200 trait defaults: the remedies are literals, and reading them
    // where they are written means a new one is covered the day it is added.
    for line in SRC.lines() {
        // Prose describes; a remedy instructs. Only the instruction is checked.
        if line.trim_start().starts_with("//") {
            continue;
        }
        for (at, _) in line.match_indices("`ksx ") {
            let rest = &line[at + 1..];
            let Some(end) = rest.find('`') else { continue };
            let quoted = &rest[..end];
            // Flags and placeholders are not part of the verb path: `ksx panel
            // program --yes` and `ksx device pick <ID>` are the `panel program` and
            // `device pick` verbs.
            let verb = quoted
                .split_whitespace()
                // A verb path segment is always a plain identifier, so the path
                // ends at the first word that is not one: a flag, a `<PLACEHOLDER>`,
                // or a quoted argument. `ksx preset new "<NAME>" --from-template
                // <ID>` is the `preset new` verb.
                .take_while(|word| {
                    !word.is_empty()
                        && !word.starts_with('-')
                        && word
                            .chars()
                            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
                })
                .collect::<Vec<_>>()
                .join(" ");
            let Some(path) = verb.strip_prefix("ksx ") else {
                continue;
            };
            if path.is_empty() || verbs.contains(path) || FEATURE_GATED.contains(&path) {
                continue;
            }
            missing.push(format!("`{quoted}` (no `{path}` verb)"));
        }
    }
    missing.sort();
    missing.dedup();

    assert!(
        missing.is_empty(),
        "crates/ksx-api/src/machine.rs tells a user to run commands this build \
         does not have. A refusal that names a dead verb is worse than one that \
         names nothing — the user follows it and gets `unrecognized \
         subcommand`. Either ship the verb or reword the remedy to name a \
         surface, a concept or a fact instead: {missing:#?}"
    );
}

/// **`ksx.exe` has a second entry point, and it must be taken before clap.**
///
/// A chart write goes through `HidD_SetOutputReport`, which cannot be cancelled
/// once it is in the kernel, so `ksx-platform` re-executes THIS binary with one
/// private argument and can terminate that child on a deadline. The worker is
/// `pub`, and its doc says it must run "before any logging or argument parsing".
///
/// Nothing called it. Every chart read therefore died on its first packet with
/// "the HID output helper exited with code 2 without completing the report" —
/// code 2 being what clap returns for an argument it does not recognise. The
/// capability was written, made public, documented, and unreachable.
///
/// This asserts the shape that made it unreachable: the private argument must
/// not reach clap. It deliberately does NOT assert success — with no request on
/// stdin the worker fails, and that is fine. What must never happen is clap
/// answering instead.
#[test]
fn the_hid_output_worker_argument_never_reaches_clap() {
    const PRIVATE_ARG: &str = "__ksx-hid-output-worker-v1";

    let output = Command::new(KSX)
        .arg(PRIVATE_ARG)
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap_or_else(|e| panic!("running {KSX} {PRIVATE_ARG}: {e}"));
    let stderr = String::from_utf8_lossy(&output.stderr);

    for clap_says in [
        "unrecognized subcommand",
        "unexpected argument",
        "Usage:",
        "--help",
    ] {
        assert!(
            !stderr.contains(clap_says),
            "the private worker argument reached clap ({clap_says:?}), so the \
             killable HID output helper cannot run and every chart read fails \
             on its first packet:\n{stderr}"
        );
    }
}

fn walk_clap_tree() -> BTreeSet<String> {
    let dir = std::env::temp_dir().join(format!("ksx-parity-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap_or_else(|e| panic!("temp dir {}: {e}", dir.display()));
    let name = Path::new(KSX)
        .file_name()
        .expect("the built binary has a file name");
    let exe = dir.join(name);
    std::fs::copy(KSX, &exe).unwrap_or_else(|e| panic!("copying {KSX}: {e}"));
    // The portable marker (`ksx_config::paths::PORTABLE_MARKER`). Its presence
    // beside the exe makes this directory the config root, so the logging
    // `ksx` sets up before `Cli::parse()` lands here and is deleted with it.
    std::fs::write(dir.join("ksx.toml"), "schema_version = 1\n").expect("portable marker");

    let mut out = BTreeSet::new();
    walk(&exe, &[], &mut out, 0);
    let _ = std::fs::remove_dir_all(&dir);

    assert!(
        out.len() >= 20,
        "the clap walk found {} verbs ({out:?}), which means it walked nothing — \
         the help format changed, or the binary did not run",
        out.len()
    );
    out
}

fn walk(exe: &Path, path: &[String], out: &mut BTreeSet<String>, depth: usize) {
    assert!(
        depth < 4,
        "the clap tree is deeper than this walk expects at {path:?}; raise the cap \
         deliberately rather than by accident"
    );
    let mut args: Vec<&str> = path.iter().map(String::as_str).collect();
    args.push("--help");
    let output = Command::new(exe)
        .args(&args)
        .output()
        .unwrap_or_else(|e| panic!("running {} {args:?}: {e}", exe.display()));
    assert!(
        output.status.success(),
        "{} {args:?} exited {:?}",
        exe.display(),
        output.status.code()
    );
    // stdout only: `logging::announce` writes its line to stderr, which is
    // where it belongs and out of the way here.
    let help = String::from_utf8_lossy(&output.stdout).replace("\r\n", "\n");
    assert!(
        help.contains("Usage:"),
        "{} {args:?} printed no usage line:\n{help}",
        exe.display()
    );

    // A node whose usage line demands `<COMMAND>` is a group and nothing else.
    // `ksx macro` is BOTH — it takes `--preset`/`--name` and has a `trace`
    // subcommand — so the test is the usage line, not the presence of children.
    if !path.is_empty() && !usage_demands_a_subcommand(&help) {
        out.insert(path.join(" "));
    }
    for child in subcommands(&help) {
        let mut next = path.to_vec();
        next.push(child);
        walk(exe, &next, out, depth + 1);
    }
}

fn usage_demands_a_subcommand(help: &str) -> bool {
    help.lines()
        .find(|line| line.starts_with("Usage:"))
        .is_some_and(|line| line.contains("<COMMAND>"))
}

/// The names in clap's `Commands:` block. Entries sit at exactly two spaces of
/// indent; wrapped descriptions are indented to the description column, which
/// is much deeper, and the name shape is checked besides.
fn subcommands(help: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut inside = false;
    for line in help.lines() {
        if line.starts_with("Commands:") {
            inside = true;
            continue;
        }
        if !inside {
            continue;
        }
        if !line.starts_with("  ") || line.trim().is_empty() {
            break;
        }
        if line.as_bytes().get(2) == Some(&b' ') {
            continue;
        }
        let Some(name) = line.split_whitespace().next() else {
            continue;
        };
        // clap's own `help` verb prints this message; it is not a ksx verb.
        if name == "help" {
            continue;
        }
        if name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            out.push(name.to_string());
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Evidence 2: Studio, from the routes inside the guarded router
// ---------------------------------------------------------------------------

/// Every path registered inside `Router::new()`, up to the guard layer.
///
/// **The cut is at `crate::guard::same_origin`'s `.layer()`, and deliberately
/// not at the first `.layer()` in the chain.** Anything after the guard is
/// outside the CSRF and DNS-rebinding checks, so the guard layer is the honest
/// boundary of "the routes this application serves under its own rules";
/// stopping earlier would drop every route declared after whatever `.layer()`
/// happened to come first and report each one as a missing face.
///
/// That was not a hypothetical when this reader was written. The import route
/// carried its own `DefaultBodyLimit` layer partway down the chain, and cutting
/// at the first `.layer()` would have hidden the six routes below it.
///
/// **That body limit is gone, and this comment is the last place in the tree
/// that records it existed.** It disappeared with `/setup/import` in the
/// 2026-08-25 cutover (`git log -S DefaultBodyLimit`); `grep -rn
/// DefaultBodyLimit crates/` now finds only these lines. The successor route
/// `/nocturne/import` runs on axum's 2 MB default while its refusal copy still
/// promises 8 MB — which is exactly the failure the limit was added to prevent,
/// arriving from the other direction. Restoring it is a Studio change; the cut
/// point here is correct either way, and is now correct for the reason above
/// rather than because of one route's layer.
fn studio_routes() -> &'static BTreeSet<String> {
    static ROUTES: LazyLock<BTreeSet<String>> = LazyLock::new(|| {
        const SERVER: &str = "crates/ksx-studio/src/server/mod.rs";
        let text = read_repo(SERVER);
        let start = text
            .find("Router::new()")
            .unwrap_or_else(|| panic!("{SERVER} no longer builds its router with Router::new()"));
        let guard = text[start..]
            .find(".layer(axum::middleware::from_fn")
            .unwrap_or_else(|| {
                panic!(
                    "{SERVER} no longer ends its route chain with the guard layer. \
                     Every mutating route goes inside Router::new() BEFORE that \
                     .layer() — if the guard moved, this reader has to move with it."
                )
            });
        let chain = &text[start..start + guard];

        let mut out = BTreeSet::new();
        for (at, _) in chain.match_indices(".route(") {
            let rest = chain[at + ".route(".len()..].trim_start();
            if let Some(rest) = rest.strip_prefix('"') {
                if let Some(end) = rest.find('"') {
                    out.insert(rest[..end].to_string());
                }
            }
        }
        // Sentinels: the product page and one tool page. These were `/` and
        // `/map` until those pages were deleted — if this reader ever stops
        // finding BOTH, it is reading the wrong span again, not observing a
        // smaller router.
        assert!(
            out.len() >= 30 && out.contains("/nocturne") && out.contains("/check"),
            "the route scan found {} paths ({out:?}), which means it read the wrong \
             span of {SERVER}",
            out.len()
        );
        out
    });
    &ROUTES
}

// ---------------------------------------------------------------------------
// Evidence 3: the egui, from its screens and its verbs
// ---------------------------------------------------------------------------

/// `Screen::<Name>` for every tab, and `Ask::<Name>` for every write the
/// cabinet can perform.
///
/// Two sources because the surface has two halves and the matrix claims both:
/// "primary" for `"Press a button, see it light"` is a SCREEN (it decides
/// nothing), "slot→preset only" for config editing is an ASK.
fn cabinet_surface() -> &'static BTreeSet<String> {
    static SURFACE: LazyLock<BTreeSet<String>> = LazyLock::new(|| {
        let mut out = BTreeSet::new();

        let nav = read_repo("crates/ksx-cabinet/src/nav.rs");
        let all = between(
            &nav,
            "pub const ALL: [Screen;",
            "];",
            "nav.rs's Screen::ALL",
        );
        for (at, _) in all.match_indices("Screen::") {
            let ident = leading_ident(&all[at + "Screen::".len()..]);
            if !ident.is_empty() {
                out.insert(format!("Screen::{ident}"));
            }
        }

        let app = read_repo("crates/ksx-cabinet/src/app.rs");
        let asks = between(&app, "pub enum Ask {", "\n}", "app.rs's Ask enum");
        for line in asks.lines() {
            let line = line.trim_start();
            if line.starts_with("//") || line.starts_with("#[") {
                continue;
            }
            let ident = leading_ident(line);
            if ident.is_empty() || !ident.starts_with(|c: char| c.is_ascii_uppercase()) {
                continue;
            }
            // A variant, not a struct-variant field: what follows the name is
            // `,` (unit), `(` (tuple) or `{` (struct).
            if line[ident.len()..]
                .trim_start()
                .starts_with([',', '(', '{'])
            {
                out.insert(format!("Ask::{ident}"));
            }
        }

        assert!(
            out.len() >= 10 && out.contains("Screen::ButtonCheck") && out.contains("Ask::Assign"),
            "the cabinet scan found {out:?}, which means one of the two readers \
             matched nothing"
        );
        out
    });
    &SURFACE
}

fn between<'a>(text: &'a str, open: &str, close: &str, what: &str) -> &'a str {
    let start = text
        .find(open)
        .unwrap_or_else(|| panic!("{what}: no `{open}` — the shape this reader assumes is gone"))
        + open.len();
    let len = text[start..]
        .find(close)
        .unwrap_or_else(|| panic!("{what}: `{open}` is never closed by `{close}`"));
    &text[start..start + len]
}

fn leading_ident(text: &str) -> &str {
    let end = text
        .find(|c: char| !c.is_alphanumeric() && c != '_')
        .unwrap_or(text.len());
    &text[..end]
}

// ---------------------------------------------------------------------------
// The claim: docs/SURFACES.md §3
// ---------------------------------------------------------------------------

/// One matrix row, cells as written.
#[derive(Debug)]
struct Row {
    capability: String,
    cli: String,
    egui: String,
    studio: String,
}

/// What a cell asserts about whether a face exists.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Claim {
    /// A face is there today: `owns`, `primary`, `view`, `convenience`.
    Shipped,
    /// Nothing is there: `—`, `planned …`, `never …`. §3 spells the first one
    /// out — **"planned" = nothing is there** — because the previous version of
    /// the table used "view" for two cells that render nothing at all.
    Absent,
}

/// **The blind spot this creates, stated so it is not rediscovered a third
/// time.**
///
/// Only the first word is read, so everything in a cell's parenthetical is
/// invisible here. `every_section_cross_reference_points_at_a_section_about_that_row`
/// closes half of that — a `(§N)` has to exist and be about the row — and
/// nothing closes the other half: a ROUTE NAME in a parenthetical is checked by
/// no test in this file.
///
/// That is not theoretical. On 2026-08-25 Studio deleted five pages, and six
/// Studio cells went on naming `/start`, `/setup` or `/profiles` in their
/// parentheticals for a fortnight while every test here stayed green — the
/// anchor table below had been migrated, the prose beside it had not. The cheap
/// guard, if one is wanted, is the same shape as the `(§N)` one: pull every
/// `` `/…` `` token out of a cell that classifies as `Shipped` and require
/// `studio_routes()` to contain it.
fn classify(cell: &str) -> Claim {
    let plain = cell.replace("**", "").replace('`', "");
    let plain = plain.trim();
    // The FIRST word decides, and the qualifier that follows never does.
    // "planned primary" is a plan; "input only (ksx monitor)" is a shipped
    // verb; "**primary** (§3a)" is a shipped page. Reading from the other end
    // would classify the first of those three backwards.
    match plain.split_whitespace().next().unwrap_or("") {
        "owns" | "primary" | "view" | "convenience" | "input" => Claim::Shipped,
        "slot→preset" => Claim::Shipped,
        // A face that ships SOME of the row's verbs and says which — the
        // stage row's CLI cell (view/adopt/reorder/socd/apply, while save and
        // play stay surface acts). Shipped: the named verbs must resolve.
        "partial" => Claim::Shipped,
        "planned" | "never" | "—" | "-" => Claim::Absent,
        other => panic!(
            "docs/SURFACES.md §3 has a cell starting `{other}` ({cell:?}) that this guard \
             does not know how to read. Every cell has to say whether a face EXISTS — \
             teach `classify` the new word and decide which side it falls on, because a \
             word nobody classified is a claim nobody checks."
        ),
    }
}

/// Normalised capability text, for matching a row to its anchors.
fn key(capability: &str) -> String {
    capability
        .replace("**", "")
        .replace('`', "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn matrix() -> &'static Vec<Row> {
    static MATRIX: LazyLock<Vec<Row>> = LazyLock::new(|| {
        let doc = read_repo("docs/SURFACES.md");
        let mut rows = Vec::new();
        let mut inside = false;
        let mut header = 0;
        for line in doc.lines() {
            if line.starts_with("## §3 ") {
                inside = true;
                continue;
            }
            if inside && line.starts_with('#') {
                break;
            }
            let line = line.trim();
            if !inside || !line.starts_with('|') {
                continue;
            }
            let cells: Vec<&str> = line.trim_matches('|').split('|').map(str::trim).collect();
            assert_eq!(
                cells.len(),
                4,
                "docs/SURFACES.md §3's matrix row {line:?} has {} columns, not the four \
                 this guard reads (capability, CLI, egui, Studio). A new column is a new \
                 kind of claim and needs a reader.",
                cells.len()
            );
            if cells[0] == "Capability" {
                header += 1;
                continue;
            }
            if cells.iter().all(|c| c.chars().all(|ch| ch == '-')) {
                continue;
            }
            rows.push(Row {
                capability: key(cells[0]),
                cli: cells[1].to_string(),
                egui: cells[2].to_string(),
                studio: cells[3].to_string(),
            });
        }
        assert_eq!(
            header, 1,
            "docs/SURFACES.md §3 should hold exactly one matrix; found {header} headers"
        );
        assert!(
            rows.len() >= 8,
            "the matrix parser found {} rows, which means the table moved or changed shape",
            rows.len()
        );
        rows
    });
    &MATRIX
}

// ---------------------------------------------------------------------------
// The binding: which evidence would make each cell true
// ---------------------------------------------------------------------------

/// A row of §3's matrix, bound to the things that would make its cells true.
///
/// This table is the guard, and it is a SPECIFICATION, not a mirror of the
/// implementation: it says what each capability is made of on each surface. The
/// lists are read in both directions — every name must exist where a cell says
/// the face is shipped, and none may exist where a cell says nothing is there.
///
/// `cli` doubles as the coverage list: a verb no row names and no `EXEMPT`
/// entry covers is a verb with no face and no reason to lack one.
struct Anchors {
    capability: &'static str,
    cli: &'static [&'static str],
    egui: &'static [&'static str],
    studio: &'static [&'static str],
}

const ANCHORS: &[Anchors] = &[
    Anchors {
        capability: "First run: stage a setup, save or play",
        // `ksx stage` exists now (view / adopt / reorder / socd — the
        // operator faces of the daemon-held draft). Save and Play stay
        // surface acts on purpose: the two buttons carry the §2 consequence
        // copy, and a shell spelling of them would be a third place for that
        // copy to drift. The row's CLI cell says exactly that.
        cli: &[
            "stage view",
            "stage adopt",
            "stage reorder",
            "stage socd",
            "stage apply",
        ],
        egui: &["Screen::FirstRun", "Ask::Stage"],
        // The two acts §2 requires be separable, plus the page they live on,
        // plus the one that gives a staged controller its BINDINGS. Naming
        // all four is deliberate: a page that could only save, or only play,
        // would satisfy a one-anchor row while failing the requirement the row
        // exists for — and a flow that could not map would satisfy both while
        // playing a pad on which nothing works.
        //
        // These were the `/start/*` routes until that page was deleted and
        // /nocturne became the product; `/nocturne/controller` is the
        // add-with-a-layout verb the old `/start/controller/layout` was.
        studio: &[
            "/nocturne",
            "/nocturne/device/identify",
            "/nocturne/controller",
            "/nocturne/save",
            "/nocturne/play",
        ],
    },
    Anchors {
        capability: "Author presets / key mappings",
        cli: &[
            "setup",
            "preset list",
            "preset new",
            "map",
            "macro",
            "macro trace",
        ],
        // The names a cabinet mapper would take. Neither exists, which is what
        // makes the egui cell's "—" honest.
        egui: &["Screen::Mapper", "Ask::Bind"],
        studio: &["/nocturne", "/nocturne/bind/toggle"],
    },
    Anchors {
        capability: "Rename / delete a controller layout",
        // Separate from "Author presets" on purpose: that row is about a
        // layout's CONTENTS, this one is about the file's existence and its
        // name. They fail differently — a bad binding is a button that does
        // the wrong thing, a bad rename is a cabinet that will not start.
        cli: &["preset rename", "preset delete"],
        // The names a cabinet layout manager would take. Neither exists, and
        // that is what makes the egui cell honest: the cabinet is the surface
        // somebody uses while PLAYING, and renaming files is not that moment.
        egui: &["Screen::Layouts", "Ask::RenamePreset"],
        studio: &["/nocturne/layout/rename", "/nocturne/layout/delete"],
    },
    Anchors {
        capability: "Measure simultaneous keyboard / encoder host signals",
        cli: &["input-test start", "input-test poll", "input-test cancel"],
        // Deliberately absent from the 10-foot surface: this is a timed,
        // close-range setup diagnostic, not an operating control.
        egui: &["Screen::InputTest"],
        studio: &[
            "/api/input-test",
            "/api/input-test/start",
            "/api/input-test/cancel",
        ],
    },
    Anchors {
        capability: "Edit configuration",
        cli: &["slot list", "slot assign", "config export", "config import"],
        // `Ask::Assign` IS the "slot→preset only" cell: the Presets screen
        // builds one, and `assign_destination` decides which file it lands in.
        egui: &["Ask::Assign"],
        studio: &["/nocturne/save", "/nocturne/import"],
    },
    Anchors {
        capability: "Create / update / delete profiles",
        cli: &["games new", "games update", "games delete"],
        egui: &["Screen::Profiles"],
        studio: &[
            "/nocturne/game",
            "/nocturne/game/update",
            "/nocturne/game/delete",
        ],
    },
    Anchors {
        capability: "Device pick / remove",
        cli: &["device scan", "device pick", "device remove"],
        egui: &["Screen::Devices", "Ask::DevicePick"],
        studio: &["/devices/pick", "/devices/remove"],
    },
    Anchors {
        capability: "WinUSB claim / release",
        // `release-all` is the same capability with the journal taken away:
        // the surfaces carry per-device Release, and this is what remains
        // reachable when the recovery store itself is gone. A page could
        // not be the answer to that, because a page needs the product to
        // be working.
        cli: &[
            "winusb status",
            "winusb claim",
            "winusb release",
            "winusb release-all",
            "winusb repair",
        ],
        egui: &["Ask::WinusbClaim"],
        // Installed Studio gathers explicit device/certificate consent, then
        // crosses the narrow elevated helper boundary. The browser never
        // accepts provider paths, driver bytes, or arbitrary helper arguments.
        studio: &["/nocturne/capture/prepare", "/nocturne/capture/release"],
    },
    Anchors {
        capability: "\"Press a button, see it light\"",
        cli: &["monitor"],
        egui: &["Screen::ButtonCheck"],
        // §5/§8: `/check` carries the roster and `/api/live` carries the SSE
        // frames. Both are load-bearing — a page without the feed is a layout.
        studio: &["/check", "/api/live"],
    },
    Anchors {
        capability: "Is it working: pads, drivers",
        cli: &["doctor", "devices", "session status"],
        egui: &["Screen::Status"],
        studio: &["/nocturne", "/api/nocturne"],
    },
    Anchors {
        capability: "Spawn test pads / prune the bus",
        // One verb, both halves: `ksx pads --count N` and `ksx pads --prune`.
        cli: &["pads"],
        egui: &["Ask::PadsSpawn", "Ask::PadsPrune"],
        studio: &["/pads/spawn", "/pads/prune"],
    },
    Anchors {
        capability: "What ksx left behind (receipts and signing certificates)",
        // Two kinds of residue with two lifetimes: a receipt is ksx's own
        // bookkeeping, a certificate is a change to the machine's trust
        // stores that outlives the config that made it. The CLI owns both
        // repair verbs. Devices reports both and exposes the narrow, explicit
        // certificate-only cleanup through the same installed elevated
        // helper; receipt reconciliation remains a CLI recovery operation.
        cli: &["winusb repair", "winusb sweep-certificates"],
        egui: &[],
        studio: &["/devices", "/devices/certificates/sweep"],
    },
    Anchors {
        capability: "What opposite directions do (SOCD)",
        // Not its own verb: SOCD is a property OF A SLOT, so it rides the verb
        // that already writes slots rather than becoming a second way to edit
        // one. `slot assign` is named by the config row too, which is correct
        // - one verb can serve two capabilities, and this one does.
        cli: &["slot assign"],
        // NOTHING in the egui, checked rather than assumed: `git grep -i socd`
        // over crates/ksx-cabinet finds one line, and it is the `socd: None`
        // this change added to keep the cabinet's slot write "not asked
        // about". The cabinet does not even DISPLAY a slot's policy, so the
        // cell is "—" and not "view".
        egui: &[],
        studio: &["/nocturne/controller/socd"],
    },
    Anchors {
        capability: "Split or freeze, after saving",
        // THE ROW WITH NO CLI VERB, and it is here on purpose. Until now this
        // capability had no verb on ANY surface: `stage::apply` wrote
        // `settings.block_keyboards` during first run and nothing could ever
        // write it again. `every_cli_verb_is_claimed_by_a_row_or_exempt_with_a_reason` walks
        // the CLI tree and asks which surface performs each verb, so a config
        // concept nobody had given a verb to was invisible to this guard by
        // construction. An empty `cli` is the honest cell, not an oversight -
        // and it is what makes the gap visible if somebody adds the flag later.
        cli: &[],
        egui: &["Ask::Blocking"],
        studio: &["/nocturne/blocking"],
    },
    Anchors {
        capability: "Studio theme",
        // No CLI verb, same reasoning as blocking: a theme is picked where it
        // is seen. The egui anchor is the name a cabinet theme prompt would
        // take, asserted ABSENT — the 10-foot surface is dark-only by design
        // (theme.rs's own docs), so a face appearing there is a decision this
        // row exists to surface.
        cli: &[],
        egui: &["Ask::Theme"],
        studio: &["/nocturne/theme"],
    },
    Anchors {
        capability: "Start ksx at sign-in",
        // The CLI keeps every option (--mode, --game, --delay-secs,
        // --task-name); Studio takes the one a first run needs and the
        // defaults for the rest. That is not a gap, it is the split: a person
        // finishing their first setup wants a cabinet that comes up, not four
        // knobs to get wrong.
        cli: &["autostart"],
        // The name a cabinet toggle would take. It does not exist, which is
        // what makes the egui cell's "planned" honest — and the cabinet is
        // where this belongs next, since the machine it commissions is the one
        // the window is running on.
        egui: &["Ask::Autostart"],
        studio: &["/nocturne/autostart"],
    },
    Anchors {
        capability: "Record / replay a session",
        // One capability, both halves: `ksx monitor --record` writes the
        // timeline and `ksx play` drives the pipeline from it. `monitor` is
        // named by the button-check row as well, which is correct — a verb can
        // be part of two capabilities, and this one genuinely is.
        cli: &["monitor", "play"],
        // The names an attract-mode button would take (§3b). Neither exists,
        // which is what makes the egui cell's "planned" honest.
        egui: &["Screen::Replay", "Ask::Play"],
        studio: &["/play", "/recordings"],
    },
    Anchors {
        capability: "Start / stop / switch profile",
        // `session resume` is named here rather than given a row of its own:
        // it is the other half of stop, not a capability. It is a SEPARATE
        // verb because start is defined as the config on disk and a paused
        // staged session is not on disk — see `ksx_api::ControlSource::resume`.
        cli: &[
            "run",
            "session start",
            "session stop",
            "session resume",
            "session reload",
            "session quit",
        ],
        egui: &["Screen::Session", "Ask::Start", "Ask::Stop"],
        studio: &["/nocturne/play", "/nocturne/stop", "/nocturne/adopt"],
    },
    Anchors {
        capability: "Identify an arcade encoder (family, release, whether its chart can be read)",
        // Strictly passive: it walks the USB and HID device trees Windows has
        // already enumerated and sends no report to any board. That is why it
        // can own the capability outright while the chart READ — which does
        // open the configuration collection — is a separate verb.
        cli: &["panel status"],
        egui: &[],
        // Planned, and deliberately not claimed yet. The identity facts are
        // already served on every `BoardRow` (`family_label`, `profile_state`,
        // `terminal_count`, `chart_readable`); what is missing is the surface
        // that renders them. Naming a route here before one exists would be
        // the "unbacked published claim" this matrix exists to prevent.
        studio: &[],
    },
    Anchors {
        capability: "Read an encoder's stored chart (what every terminal emits)",
        // The explicit hardware read: it opens the configuration collection and
        // performs the vendor transaction, which is why it is a separate verb
        // from `panel status` and never something a surface does unasked. It
        // reads the board twice and refuses if the images differ.
        cli: &["panel chart", "panel backups"],
        egui: &[],
        studio: &["/api/panel/chart"],
    },
    Anchors {
        capability: "Say what ksx knows about each terminal, and how it knows it",
        // Separate from the read because it answers a different question. The
        // chart says what the board STORES; this composes that with what
        // presses proved and what the user locked in, and where they disagree
        // it reports the disagreement rather than picking a winner. It is the
        // only verb that can name an onboard macro, which a chart read cannot
        // detect even in principle.
        cli: &["panel truth"],
        egui: &[],
        // Planned. The composition ships and is proven in CI; the surface for
        // it does not exist yet, and naming a route before one exists is the
        // claim this matrix is here to stop.
        studio: &[],
    },
    Anchors {
        capability: "Record what a person knows about a terminal ksx cannot read",
        // The one source ksx did not obtain itself. It is stored beside what
        // presses proved rather than in the layout store, because that store's
        // contract is "programmable onto a board" and a declaration is not.
        cli: &["panel declare", "panel forget"],
        egui: &[],
        // Planned. Typing a key is the half a browser is genuinely better at,
        // and the surface for it is the next thing owed.
        studio: &[],
    },
];

/// A verb that is right to leave CLI-only, and why.
///
/// The reason is a field rather than a comment so that it reaches the failure
/// message and so that an entry cannot land without one. "Nobody got round to
/// it" is not on this list — that is the thing the guard is for.
///
/// The test for membership is *what makes the other surfaces the wrong place*,
/// and it is a narrower test than "feels like plumbing". `ksx doctor` looks like
/// an exemption and is not one: `StatusSnapshot` carries `vigem`,
/// `interception`, `pads` and `autostart`, the egui's Status screen renders
/// them and so does `/api/nocturne` (it was `/api/status` until that page was
/// deleted), which is precisely §3's "Is it working: pads, drivers" row. It is
/// claimed there, not excused here.
struct Exempt {
    verb: &'static str,
    /// The cargo feature that has to be on for this verb to exist at all.
    gate: Option<&'static str>,
    why: &'static str,
}

const EXEMPT: &[Exempt] = &[
    Exempt {
        verb: "daemon",
        gate: None,
        why: "Not a capability — the process the capabilities run inside, and its face is \
              the tray icon it installs. Whether it is up is already on both other \
              surfaces (`StatusSnapshot::daemon_running`). What is not is STARTING it, \
              and a button that starts the thing serving the button is a bootstrap \
              problem, not a surface gap.",
    },
    Exempt {
        verb: "install-drivers",
        gate: None,
        why: "Needs an administrator token and ksx never self-elevates, so this sits on \
              the same line §3a draws for WinUSB claim: a page could only ever print the \
              command. §3 marks that column `never` for a reason. What changed is WHO \
              runs it: the setup wizard does, from a ticked-by-default checkbox, because \
              setup is the one place an admin token already exists and has already been \
              consented to (packaging/ksx.iss, docs/DRIVERS.md \"Who runs it, and when\"). \
              That is still not a surface — it happens once, before any surface exists. \
              What the surfaces carry is the STATE: `MachineSource::controller_outputs` \
              evaluates only the backends required by the currently staged supported \
              personas and is said before the Play button; Status/System inventories both \
              installed output stacks without claiming HIDMaestro's endpoint exists before \
              Play. That is the row §3 already gives them (\"Is it working: pads, drivers\").",
    },
    Exempt {
        verb: "studio",
        gate: Some("studio"),
        why: "It LAUNCHES a surface. Studio cannot be the place you go to open Studio.",
    },
    Exempt {
        verb: "cabinet",
        gate: Some("cabinet"),
        why: "Same, and §6 already fixed the direction: the egui opens Studio, never the \
              reverse — a browser would need a registered ksx:// protocol to do it.",
    },
    Exempt {
        verb: "open",
        gate: Some("studio"),
        why: "It IS the product's front door — start the daemon if needed, then show Studio \
              in its own window — so it is the same class as `studio` and `cabinet`: a verb \
              that launches a surface cannot have a face on the surface it launches. It is \
              what the installer's shortcut and the Start menu entry both run, which is \
              precisely the point at which no other surface exists yet.",
    },
];

/// **The guard's own blind spot, stated so it is not rediscovered.**
///
/// `EXEMPT` gates and the two feature-gated verbs above are only visible when
/// the test binary was built with that feature on. A plain `cargo test
/// --workspace` builds with default features — where `studio` and `cabinet` are
/// off (`CLAUDE.md`: "the default build compiles neither") — so **a local green
/// run has NOT checked `ksx open`, `ksx studio` or `ksx cabinet`.** `ksx open`
/// sat unaccounted for exactly that reason until 2026-08-08.
///
/// That hole used to say "the fix is a feature-enabled test job… written down
/// rather than done". **It is done**: `.github/workflows/ci.yml` runs
/// `cargo test -p $p --features studio,cabinet` as its own step, so the three
/// verbs above ARE checked on every CI run. What remains true is only the local
/// half: if you are reading a green terminal rather than a green CI run, these
/// three verbs were skipped, and the difference is four tests.
#[cfg(test)]
const _FEATURE_GATED_VERBS_ARE_CHECKED_IN_CI_NOT_IN_A_LOCAL_RUN: () = ();

fn gate_is_on(feature: &str) -> bool {
    match feature {
        "studio" => cfg!(feature = "studio"),
        "cabinet" => cfg!(feature = "cabinet"),
        other => panic!(
            "EXEMPT names cargo feature `{other}`, which this guard cannot evaluate — \
             `cfg!(feature = ..)` needs a literal, so add it beside the other two"
        ),
    }
}

fn anchors() -> BTreeMap<String, &'static Anchors> {
    ANCHORS.iter().map(|a| (key(a.capability), a)).collect()
}

/// Which evidence set a surface's anchors are looked up in.
fn evidence(surface: &str, name: &str) -> bool {
    match surface {
        "CLI" => cli_verbs().contains(name),
        "egui" => cabinet_surface().contains(name),
        "Studio" => studio_routes().contains(name),
        other => unreachable!("no evidence source for {other}"),
    }
}

fn source_of(surface: &str) -> &'static str {
    match surface {
        "CLI" => "the clap tree (`ksx --help`, walked)",
        "egui" => "crates/ksx-cabinet/src/{nav,app}.rs (Screen::ALL, enum Ask)",
        "Studio" => "crates/ksx-studio/src/server/mod.rs (Router::new(), guard side)",
        other => unreachable!("no evidence source for {other}"),
    }
}

/// The three cells of a row, paired with the anchors that would make them true.
fn cells<'a>(
    row: &'a Row,
    a: &'a Anchors,
) -> [(&'static str, &'a str, &'static [&'static str]); 3] {
    [
        ("CLI", row.cli.as_str(), a.cli),
        ("egui", row.egui.as_str(), a.egui),
        ("Studio", row.studio.as_str(), a.studio),
    ]
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

/// **A cell that claims a shipped face must have one.**
///
/// This is the direction that caught `ksx device pick`: a verb in the tree, a
/// row in the table, and no page anywhere. It is also the direction that the
/// first audit of §3 walked by hand and found four wrong cells in, including
/// two saying "view" for surfaces that render nothing.
///
/// Breaks against: the tree as it was before task #22, where §3's device row
/// claimed a Studio face and `server.rs` had no `/devices*` route at all;
/// against deleting `ksx winusb claim` while the row still says "owns"; and
/// against moving a mutating route outside the `.layer()` guard, which takes it
/// out of the router this reader can see.
#[test]
fn every_cell_claiming_a_shipped_face_has_one() {
    let anchors = anchors();
    let mut problems = Vec::new();

    for row in matrix() {
        let Some(a) = anchors.get(&row.capability) else {
            continue; // the bookkeeping test below is what reports this
        };
        for (surface, cell, names) in cells(row, a) {
            if classify(cell) != Claim::Shipped {
                continue;
            }
            let missing: Vec<&str> = names
                .iter()
                .copied()
                .filter(|n| !evidence(surface, n))
                .collect();
            if missing.is_empty() {
                continue;
            }
            problems.push(format!(
                "docs/SURFACES.md §3 — {capability}\n  \
                 the {surface} cell says {cell:?}, which means the face is THERE.\n  \
                 missing: {missing:?}\n  \
                 looked in: {source}\n  \
                 Fix it one of three ways: BUILD the face; change the cell to `planned` \
                 (§3: \"planned\" = nothing is there); or, if the face shipped under \
                 another name, update this row's anchors in tests/parity.rs.",
                capability = row.capability,
                source = source_of(surface),
            ));
        }
    }

    assert!(
        problems.is_empty(),
        "{} capability cell(s) claim a face that is not in the tree:\n\n{}",
        problems.len(),
        problems.join("\n\n")
    );
}

/// **A cell that says nothing is there must be right about that.**
///
/// The symmetric failure, and the one §1 records: `MachineSource::devices()`
/// was written for a screen nobody had, so the backend grew a shape no caller
/// ever checked. Read forwards it catches the cheaper mistake — a face ships
/// and the table still calls it planned, which is how a matrix stops being
/// worth reading.
///
/// Breaks against the tree as committed at def1c31, where two Studio cells
/// still said "planned" after `/devices/pick`, `/devices/remove`, `/setup/slot`
/// and `/profiles/new` had all shipped. Two of those four names no longer
/// resolve — `/setup/slot` and `/profiles/new` were deleted in the 2026-08-25
/// single-page cutover — but they are kept as written, because this paragraph
/// is dated by a SHA and describes the tree at that SHA. A reader chasing
/// `/setup/slot` today should know it is gone and that `assign_slot` lost its
/// Studio caller with it (`docs/SURFACES.md` §3's corrections list). It also
/// breaks the day someone adds `Screen::Devices` to the cabinet without
/// touching §3 row 3.
///
/// The limit is stated where the anchors are: this is a tripwire on the name a
/// face would obviously take, not a proof that no face exists.
#[test]
fn every_cell_claiming_nothing_is_there_is_right() {
    let anchors = anchors();
    let mut problems = Vec::new();

    for row in matrix() {
        let Some(a) = anchors.get(&row.capability) else {
            continue;
        };
        for (surface, cell, names) in cells(row, a) {
            if classify(cell) != Claim::Absent {
                continue;
            }
            let present: Vec<&str> = names
                .iter()
                .copied()
                .filter(|n| evidence(surface, n))
                .collect();
            if present.is_empty() {
                continue;
            }
            problems.push(format!(
                "docs/SURFACES.md §3 — {capability}\n  \
                 the {surface} cell says {cell:?}, and §3 spells that out: \
                 \"planned\" = nothing is there.\n  \
                 but this IS there: {present:?}\n  \
                 found in: {source}\n  \
                 The face shipped and the table did not notice. Update the cell to what \
                 the surface now does — and if the row's shape changed with it, say so in \
                 §3's corrections list the way the other four are recorded.",
                capability = row.capability,
                source = source_of(surface),
            ));
        }
    }

    assert!(
        problems.is_empty(),
        "{} capability cell(s) say nothing is there when something is:\n\n{}",
        problems.len(),
        problems.join("\n\n")
    );
}

/// Every backticked token in a matrix cell, parentheticals included.
fn backticked(cell: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = cell;
    while let Some(open) = rest.find('`') {
        rest = &rest[open + 1..];
        let Some(close) = rest.find('`') else { break };
        out.push(&rest[..close]);
        rest = &rest[close + 1..];
    }
    out
}

/// **The blind spot `classify` documents, closed.**
///
/// `classify` reads only a cell's FIRST word, so everything in a parenthetical
/// is invisible to the two tests above. That is not theoretical: on 2026-08-25
/// Studio deleted five pages, and six §3 cells went on naming `/start`,
/// `/setup` or `/profiles` in their parentheticals for a fortnight while every
/// test in this file stayed green — the anchor table had been migrated, the
/// prose beside it had not. The cells are clean today, and until now nothing
/// held them there.
///
/// So: pull every `` `/…` `` token out of a cell that classifies as `Shipped`
/// and require [`studio_routes`] to contain it. A route named in prose is a
/// promise a reader will follow, and a promise that 404s is worse than a blank
/// cell.
#[test]
fn every_route_named_in_a_shipped_cell_still_resolves() {
    let routes = studio_routes();
    let mut named = 0;
    let mut problems = Vec::new();

    for row in matrix() {
        for (surface, cell) in [
            ("CLI", &row.cli),
            ("egui", &row.egui),
            ("Studio", &row.studio),
        ] {
            if classify(cell) != Claim::Shipped {
                continue;
            }
            for token in backticked(cell) {
                if !token.starts_with('/') {
                    continue;
                }
                named += 1;
                if !routes.contains(token) {
                    problems.push(format!(
                        "docs/SURFACES.md §3 — {capability}\n  \
                         the {surface} cell names `{token}`, and no such route is in \
                         crates/ksx-studio/src/server/mod.rs.\n  \
                         Either the page moved and the prose did not, or the page was \
                         deleted (five were, on 2026-08-25) and the cell still sends a \
                         reader to a 404.",
                        capability = row.capability,
                    ));
                }
            }
        }
    }

    assert!(
        problems.is_empty(),
        "{} cell(s) name a route that does not exist:\n\n{}",
        problems.len(),
        problems.join("\n\n")
    );
    // ...and the premise: §3's cells DO name routes in their parentheticals.
    // If they ever stop, this guard passes by finding nothing — which is
    // exactly the state the tests above were in for that fortnight.
    assert!(
        named >= 6,
        "only {named} route(s) named across §3's shipped cells, so this guard is \
         checking almost nothing. Either the table stopped naming routes, or \
         `backticked` no longer reads the parentheticals."
    );
}

/// **Every verb is in the matrix, or exempt with a reason.**
///
/// The task list's #26 in one sentence: no backend verb ships without a face.
/// Four verbs did, and the finding was made by a human opening the UI.
///
/// Breaks against the tree at the moment `ksx device pick` landed: a new verb
/// in the clap tree, no row in §3 naming it, no exemption. It also breaks if a
/// verb is quietly deleted, because `EXEMPT` and the anchor lists are checked
/// against the live tree by the bookkeeping test below.
#[test]
fn every_cli_verb_is_claimed_by_a_row_or_exempt_with_a_reason() {
    let claimed: BTreeSet<&str> = ANCHORS.iter().flat_map(|a| a.cli.iter().copied()).collect();
    let exempt: BTreeMap<&str, &Exempt> = EXEMPT.iter().map(|e| (e.verb, e)).collect();

    let orphans: Vec<&String> = cli_verbs()
        .iter()
        .filter(|v| !claimed.contains(v.as_str()) && !exempt.contains_key(v.as_str()))
        .collect();

    assert!(
        orphans.is_empty(),
        "{} CLI verb(s) exist with nothing in docs/SURFACES.md §3 accounting for them: \
         {orphans:?}\n\n\
         A backend verb with no face is not finished — it is untested against a real \
         caller and its shape is a guess (§1). Pick one:\n  \
         1. ADD A ROW to §3's matrix saying which surface performs it, then name the verb \
         in that row's `cli` anchors in tests/parity.rs;\n  \
         2. NAME IT in an existing row, if it is part of a capability already in the \
         table;\n  \
         3. ADD AN EXEMPTION to `EXEMPT` in tests/parity.rs with a `why` that says what \
         makes CLI-only the RIGHT answer — a migration run once, a step that needs an \
         administrator token, a verb that launches a surface. Not \"no UI yet\".",
        orphans.len(),
    );
}

/// **The guard's own bookkeeping.**
///
/// Everything above compares two lists; this checks that both lists are still
/// about the same repository. Without it the guard rots quietly in the one way
/// that matters — an anchor row for a capability the doc no longer has, or an
/// exemption for a verb that was deleted, both of which make the guard pass by
/// checking less.
///
/// Breaks against: renaming a §3 capability without touching `ANCHORS`, adding
/// a matrix row with no anchors (which would otherwise be skipped in silence),
/// deleting a verb an exemption still names, and an exemption whose `why` is a
/// placeholder.
#[test]
fn the_guard_is_still_bound_to_the_documents_and_the_tree_it_reads() {
    let mut problems = Vec::new();

    let anchored: BTreeSet<String> = ANCHORS.iter().map(|a| key(a.capability)).collect();
    let documented: BTreeSet<String> = matrix().iter().map(|r| r.capability.clone()).collect();

    for capability in documented.difference(&anchored) {
        problems.push(format!(
            "docs/SURFACES.md §3 has a row `{capability}` that tests/parity.rs does not \
             bind. An unbound row is checked by NOTHING. Add an `Anchors` entry naming, \
             per surface, the verbs / screens / routes that would make its cells true."
        ));
    }
    for capability in anchored.difference(&documented) {
        problems.push(format!(
            "tests/parity.rs binds `{capability}`, which is not a row in docs/SURFACES.md \
             §3 any more. Either the row was renamed — match the new wording — or the \
             capability left the table, and its anchors should leave with it."
        ));
    }

    let verbs = cli_verbs();
    let claimed: BTreeSet<&str> = ANCHORS.iter().flat_map(|a| a.cli.iter().copied()).collect();
    // Only where the ROW SAYS THE VERB IS THERE. A `planned` CLI cell anchored
    // on a name that does not resolve is not a stale anchor — it is the claim
    // (§3c). The egui and Studio columns have always worked this way:
    // `Screen::Mapper` and `/play` name nothing, which is exactly what makes
    // their cells honest, and the CLI column was the odd one out until the
    // first row with a genuinely planned CLI half arrived.
    //
    // The Studio example used to be `/winusb/claim`, which stopped illustrating
    // anything once the WinUSB row's Studio cell became Shipped on
    // `/nocturne/capture/prepare|release`: a name that is not an anchor of any
    // row proves nothing about how absent anchors are treated. `/play` is an
    // anchor — the record/replay row's, beside `/recordings` — and it resolves
    // to nothing, which is the property this paragraph is about.
    //
    // Nothing is lost by narrowing it. A `owns` cell whose verb was renamed or
    // deleted still fails, one test up, in
    // `every_cell_claiming_a_shipped_face_has_one` — with a better message.
    let bound = anchors();
    let shipped_cli: BTreeSet<&str> = matrix()
        .iter()
        .filter(|row| classify(&row.cli) == Claim::Shipped)
        .filter_map(|row| bound.get(&row.capability))
        .flat_map(|a| a.cli.iter().copied())
        .collect();
    for verb in &shipped_cli {
        if !verbs.contains(*verb) {
            problems.push(format!(
                "tests/parity.rs anchors a capability on `ksx {verb}`, whose §3 cell says the \
                 CLI OWNS it, and it is not in the clap tree. Either the verb was renamed and \
                 the anchor is stale, or it was deleted and §3 still promises it."
            ));
        }
    }

    for e in EXEMPT {
        if let Some(feature) = e.gate {
            if !gate_is_on(feature) {
                continue; // this build does not compile the verb at all
            }
        }
        if !verbs.contains(e.verb) {
            problems.push(format!(
                "`ksx {}` is on the EXEMPT list and is not in the clap tree. An exemption \
                 for a verb that does not exist excuses nothing; delete it.",
                e.verb
            ));
        }
        if claimed.contains(e.verb) {
            problems.push(format!(
                "`ksx {}` is BOTH exempt and named by a capability row. It cannot be both \
                 CLI-only-on-purpose and part of a capability with a face; pick one.",
                e.verb
            ));
        }
        assert!(
            e.why.len() >= 60,
            "the EXEMPT entry for `ksx {}` has a {}-character reason. The reason is the \
             whole point of the list — it has to say what makes CLI-only RIGHT, not that \
             nobody has built the face yet.",
            e.verb,
            e.why.len()
        );
    }

    assert!(
        problems.is_empty(),
        "the parity guard has drifted from what it reads:\n\n{}",
        problems.join("\n\n")
    );
}

/// **A setting nobody can reach is invisible to every other test in this file.**
///
/// The guard above walks CLI VERBS and asks which surface performs each one. A
/// capability that never got a verb is not missing from that walk — it was
/// never in it. That is not a hypothetical: `socd` sat in the config model and
/// the engine from the beginning, was copied between profiles by
/// `profile_edit`, was acted on every frame by the engine, and could be set
/// only by editing TOML by hand. So did `block_keyboards` after first run.
/// Both shipped for months; both were found by reading the config struct, not
/// by this file.
///
/// So this walks the other way round: from the FIELDS a user's config can
/// hold, to the row that lets somebody change one.
///
/// The list is written out rather than derived, and the fixture below is
/// constructed field by field with no `..Default::default()`, which is the
/// tripwire: add a field to `Settings` or `SlotEntry` and this stops
/// COMPILING until somebody says which surface reaches it, or says out loud
/// that none does and why.
struct ConfigSurface {
    /// The field, as it is spelled in the file a user could open.
    field: &'static str,
    /// The §3 row that carries it, or `None` with a reason below.
    row: Option<&'static str>,
    /// Why nothing reaches it, when nothing does. An empty reason is a
    /// failure: "no face" is a decision, and a decision owes a sentence.
    why: &'static str,
}

const CONFIG_SURFACES: &[ConfigSurface] = &[
    ConfigSurface {
        field: "block_keyboards",
        row: Some("Split or freeze, after saving"),
        why: "",
    },
    ConfigSurface {
        field: "block_mice",
        row: None,
        why: "NO FACE. A mouse is blocked or not blocked with the keyboard it \
              was configured beside, and nothing offers the choice separately. \
              Reachable only by editing config.toml, which is the same hole \
              `socd` was in until 2026-08-12.",
    },
    ConfigSurface {
        field: "mouse_move_deadzone",
        row: None,
        why: "NO FACE. A tuning number for trackball feel with no control \
              anywhere. Whoever wants it has an editor open already, but that \
              is an explanation and not a defence.",
    },
    ConfigSurface {
        field: "starting_user_index",
        row: None,
        why: "NO FACE, AND CORRECTLY SO - this setting is INERT. Nothing reads it. \
              Its definition, a 1..=4 range check in `validate`, serialization \
              fixtures and this ledger are every reference in the workspace; no \
              engine, no run plan, no output backend consults it. \
              It is dead for a reason rather than by oversight: `ksx-output`'s \
              module docs record that on real hardware BOTH `get_user_index()` \
              and the LED notification channel report wrong or missing slots \
              (docs/research/m2-xinput-findings.md), so ksx establishes slot \
              identity by ACTIVE CORRELATION - pulse LT below the game-visible \
              threshold, watch which XInput slot echoes. Windows assigns the \
              index and ksx discovers which one it got, so a preferred index \
              has nowhere to be applied. \
              A control here would promise something the platform does not \
              offer, which is worse than no control. If this ever gets a face, \
              the face is a READ of where each pad actually landed.",
    },
    ConfigSurface {
        field: "theme",
        row: Some("Studio theme"),
        why: "",
    },
    ConfigSurface {
        field: "number",
        row: Some("Edit configuration"),
        why: "",
    },
    ConfigSurface {
        field: "keyboard",
        row: Some("Device pick / remove"),
        why: "",
    },
    ConfigSurface {
        field: "mouse",
        row: None,
        why: "NO FACE. `/devices` picks keyboards; a slot's mouse is set by \
              hand. Same family as `block_mice`.",
    },
    ConfigSurface {
        field: "preset",
        row: Some("Edit configuration"),
        why: "",
    },
    ConfigSurface {
        field: "persona",
        row: Some("Edit configuration"),
        why: "",
    },
    ConfigSurface {
        field: "socd",
        row: Some("What opposite directions do (SOCD)"),
        why: "",
    },
    ConfigSurface {
        field: "macros",
        row: None,
        why: "NO FACE for the SWITCH. The macro EDITOR ships (`/nocturne`'s \
              macro tabs write `[macros.<name>]` into a preset — the `/map` \
              page they were on until 2026-08-25 is gone, the editor is not); \
              what has no control is this per-slot on/off, so a cabinet can \
              carry macros it cannot turn off without an editor.",
    },
];

/// Every config field is either carried by a §3 row that exists, or refused a
/// face on purpose and in writing.
#[test]
fn every_setting_a_config_can_hold_is_reachable_or_says_why_not() {
    let matrix = matrix();
    let names: Vec<&str> = matrix.iter().map(|r| r.capability.as_str()).collect();

    let mut unbound = Vec::new();
    for entry in CONFIG_SURFACES {
        match entry.row {
            Some(row) => assert!(
                names.contains(&row),
                "config field `{}` claims §3 row {row:?}, which is not in the matrix. \
                 Rows present: {names:?}",
                entry.field
            ),
            None => {
                assert!(
                    !entry.why.trim().is_empty(),
                    "config field `{}` has no face and no reason. \"No face\" is a \
                     decision and a decision owes a sentence.",
                    entry.field
                );
                unbound.push(entry.field);
            }
        }
    }

    // Not a failure — a LEDGER. Four of these were found by reading the config
    // struct on 2026-08-12, months after they shipped, and the point of writing
    // them down is that the next person meets the list instead of the surprise.
    assert_eq!(
        unbound,
        [
            "block_mice",
            "mouse_move_deadzone",
            "starting_user_index",
            "mouse",
            "macros"
        ],
        "the set of settings no surface can reach has CHANGED. If a face was \
         added, move that field to its row. If a field was added with no face, \
         add it here with the reason."
    );
}

/// The list above describes the config this build actually writes.
///
/// Constructed field by field on purpose: no `..Default::default()`, so a new
/// field on either struct fails to COMPILE here rather than quietly joining
/// the set of things nobody can reach.
#[test]
fn the_config_surface_ledger_names_every_field_that_exists() {
    // EVERY VALUE NON-DEFAULT, and that is the whole trick. Most of these
    // fields carry `skip_serializing_if = "is_default"`, so a fixture built
    // from defaults serializes to almost nothing and this walk passes
    // VACUOUSLY — which is exactly what it did when first written: deleting
    // `socd` from the ledger left the test green, because `socd` at its
    // default is not in the document at all.
    let settings = ksx_config::Settings {
        block_keyboards: ksx_core::Blocking::Whole,
        block_mice: true,
        mouse_move_deadzone: 7,
        starting_user_index: 2,
        theme: Some("light".to_owned()),
        board: None,
    };
    let slot = ksx_config::SlotEntry {
        number: 3,
        keyboard: Some("panel".to_owned()),
        mouse: Some("trackball".to_owned()),
        preset: "Player 3".to_owned(),
        persona: ksx_core::Persona::PlayStation,
        socd: ksx_core::Socd::UpPriority,
        macros: ksx_core::MacroSwitch::On,
    };

    // Serialize with everything non-default where it matters, so
    // `skip_serializing_if` cannot hide a field from this walk.
    let mut fields: Vec<String> = Vec::new();
    for value in [
        serde_json::to_value(&settings).expect("settings serialize"),
        serde_json::to_value(&slot).expect("slot serializes"),
    ] {
        if let Some(map) = value.as_object() {
            fields.extend(map.keys().cloned());
        }
    }

    for field in &fields {
        assert!(
            CONFIG_SURFACES.iter().any(|c| c.field == field),
            "config field `{field}` is not in CONFIG_SURFACES. Say which §3 row \
             reaches it, or that none does and why."
        );
    }
}

/// **A `(§N)` in a matrix cell has to point somewhere, and somewhere RELEVANT.**
///
/// `classify` reads only the first word of a cell, so `**primary** (§3a)`
/// classifies as Shipped and the parenthetical is never looked at. That is how
/// the pads row came to cite §3a — a section titled "Why installed WinUSB
/// preparation has a narrow Studio face", which says nothing about pads. §3's
/// own prose confesses to having had exactly this bug before ("the
/// cross-reference pointed at the wrong section"), and nothing caught the
/// second one either.
///
/// EXISTENCE IS NOT ENOUGH, and testing that first is what showed it: every
/// reference in the file names a section that exists, including the wrong one.
/// So this also asks whether the section is ABOUT the row, by requiring two
/// distinct content words from the capability to appear in it.
///
/// Two, not one, and that is the whole design: "Spawn test pads / prune the
/// bus" shares exactly one word with §3a — "test" — which is the kind of
/// coincidence a single-word rule accepts. The rows that are right share three
/// each ("press, button, light"; "record, replay, session").
#[test]
fn every_section_cross_reference_points_at_a_section_about_that_row() {
    let text = read_repo("docs/SURFACES.md");

    // Section bodies, keyed by their § number.
    let heads: Vec<(usize, String)> = text
        .match_indices("\n#")
        .filter_map(|(at, _)| {
            let line = text[at + 1..].lines().next()?;
            let rest = line.trim_start_matches('#').trim_start();
            let name = rest.strip_prefix('§')?;
            let id: String = name
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect();
            (!id.is_empty()).then_some((at, id))
        })
        .collect();
    let body_of = |id: &str| -> Option<String> {
        let i = heads.iter().position(|(_, n)| n == id)?;
        let start = heads[i].0;
        let end = heads.get(i + 1).map_or(text.len(), |(at, _)| *at);
        Some(text[start..end].to_lowercase())
    };

    // Words too common to carry meaning about which section a row belongs to.
    const NOISE: &[&str] = &[
        "this",
        "that",
        "with",
        "from",
        "into",
        "what",
        "they",
        "them",
        "after",
        "saving",
        "does",
        "opposite",
        "directions",
        "left",
        "behind",
    ];

    let mut wrong = Vec::new();
    for row in matrix() {
        let words: Vec<String> = row
            .capability
            .to_lowercase()
            .split(|c: char| !c.is_ascii_alphanumeric())
            .filter(|w| w.len() >= 4 && !NOISE.contains(w))
            .map(str::to_owned)
            .collect();

        for cell in [&row.cli, &row.egui, &row.studio] {
            let mut rest = cell.as_str();
            while let Some(at) = rest.find("(§") {
                let tail = &rest[at + "(§".len()..];
                let id: String = tail
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric())
                    .collect();
                rest = &tail[id.len()..];
                if id.is_empty() {
                    continue;
                }
                let Some(body) = body_of(&id) else {
                    wrong.push(format!(
                        "row {:?} cites §{id}, and docs/SURFACES.md has no such section",
                        row.capability
                    ));
                    continue;
                };
                let hits: Vec<&String> = words.iter().filter(|w| body.contains(*w)).collect();
                if hits.len() < 2 {
                    wrong.push(format!(
                        "row {:?} cites §{id}, which shares {} word(s) with it ({:?}). \
                         Either the reference is stale, or that section is not about this row.",
                        row.capability,
                        hits.len(),
                        hits
                    ));
                }
            }
        }
    }

    assert!(
        wrong.is_empty(),
        "{} cross-reference(s) in docs/SURFACES.md §3 point somewhere they should not:\n  {}",
        wrong.len(),
        wrong.join("\n  ")
    );
}
