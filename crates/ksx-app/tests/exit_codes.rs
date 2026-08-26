//! **The exit codes, run rather than promised.**
//!
//! Seven tests in `main.rs` assert that `--help` SAYS `2 = refused`:
//! `pads_help_documents_exit_codes`, `doctor_parses_and_documents_exit_codes`,
//! `devices_help_documents_exit_codes`,
//! `run_help_documents_escapes_and_exit_codes`,
//! `winusb_help_states_the_trade_and_the_exit_codes`,
//! `map_help_documents_conflicts_rewrite_and_exit_codes` and
//! `session_help_documents_the_pipe_and_exit_codes`. Until this file existed,
//! **nothing anywhere ran the binary and checked it returned those numbers.**
//! A change that made a refusal exit 1 shipped with all seven green — the
//! promise was pinned and the behaviour was not, which is `render.rs`'s "the
//! slot exists" one layer out.
//!
//! # Why 2 is the interesting number
//!
//! Because clap also exits 2. `ksx map --preset X --function A` with no `--key`
//! exits 2 without ksx's refusal path running at all: clap rejects the missing
//! required argument first. A test built on that case would pass against a
//! binary whose own refusals had stopped returning 2 entirely. So every case
//! below is one clap PARSES cleanly and ksx then refuses on its own terms.
//!
//! # Why these cases and not others
//!
//! The machine running these tests may have a live daemon on it, with hardware
//! attached (`CLAUDE.md`). So: nothing here starts a session, plugs a pad,
//! touches a driver, or asks the daemon anything. `ksx session status` is
//! deliberately absent — it answers 0 on a machine with a daemon and 2 on one
//! without, which makes it a test of the tester's machine.
//!
//! # The portable marker
//!
//! `ksx` initialises logging BEFORE `Cli::parse()`, so without `ksx.toml`
//! beside the exe every run below would append to the config root of whoever
//! is running the tests — possibly the live one. `parity.rs` and
//! `no_interception_dll.rs` write the same marker for the same reason.

use std::path::{Path, PathBuf};
use std::process::Output;

/// The binary cargo built for this integration test.
const KSX: &str = env!("CARGO_BIN_EXE_ksx");

/// A throwaway config root with `ksx.exe` in it: no config, no presets, no
/// logs anybody else will read.
struct Sandbox {
    dir: PathBuf,
    exe: PathBuf,
}

impl Sandbox {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("ksx-exit-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap_or_else(|e| panic!("temp dir {}: {e}", dir.display()));
        let name = Path::new(KSX)
            .file_name()
            .expect("the built binary has a file name");
        let exe = dir.join(name);
        std::fs::copy(KSX, &exe).unwrap_or_else(|e| panic!("copying {KSX}: {e}"));
        // `ksx_config::paths::PORTABLE_MARKER` — see the module docs.
        std::fs::write(dir.join("ksx.toml"), "schema_version = 1\n").expect("portable marker");
        Self { dir, exe }
    }

    fn run(&self, args: &[&str]) -> Output {
        std::process::Command::new(&self.exe)
            .args(args)
            .current_dir(&self.dir)
            .output()
            .unwrap_or_else(|e| panic!("running ksx {args:?}: {e}"))
    }

    fn write(&self, name: &str, body: &str) -> PathBuf {
        let path = self.dir.join(name);
        std::fs::write(&path, body).expect("fixture");
        path
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn code(out: &Output) -> Option<i32> {
    out.status.code()
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

/// **A refusal exits 2, from ksx's own path.**
///
/// Every case here parses cleanly — clap is satisfied and hands off — and ksx
/// then declines on its own terms. That is what makes the 2 meaningful rather
/// than clap's 2 by coincidence.
#[test]
fn a_verb_that_refuses_exits_two_and_writes_nothing() {
    let sandbox = Sandbox::new("refuse");
    sandbox.write("garbage.json", "not json at all {{{\n");

    for args in [
        // Unknown preset: the map verb's own "2 = refused (unknown preset...)".
        &[
            "map",
            "--preset",
            "no-such-preset",
            "--function",
            "slot1.a",
            "--key",
            "G",
        ][..],
        // An unreadable document, which `config import`'s help lists under 2.
        &["config", "import", "garbage.json"][..],
        // Unknown preset again, through a completely different verb, so this
        // is not one code path answered twice.
        &[
            "macro",
            "trace",
            "--preset",
            "no-such-preset",
            "--macro",
            "nope",
        ][..],
        &["preset", "show", "no-such-preset"][..],
    ] {
        let out = sandbox.run(args);
        assert_eq!(
            code(&out),
            Some(2),
            "ksx {args:?} exited {:?}, not the 2 its --help promises for a refusal.\n\
             stderr: {}",
            code(&out),
            stderr(&out)
        );
        assert!(
            !stderr(&out).trim().is_empty(),
            "ksx {args:?} refused in silence: a refusal owes a sentence"
        );
    }

    // ...and nothing was written while refusing. `config.toml` is the file
    // every one of those verbs would have touched had it gone through.
    assert!(
        !sandbox.dir.join("config.toml").exists(),
        "a refused verb created config.toml in the config root"
    );
}

/// **The premise, stated so this file cannot quietly become a clap test.**
///
/// `ksx map --preset X --function A` with no `--key` also exits 2 — but clap
/// produces that one, before any ksx code runs. If the cases above ever became
/// clap-refusals too, they would keep passing while ksx's own refusal path was
/// broken. So: prove the two are distinguishable, by their output.
#[test]
fn claps_two_and_ksxs_two_are_not_the_same_two() {
    let sandbox = Sandbox::new("clap");

    let clap_refusal = sandbox.run(&["map", "--preset", "ksx-keyboard", "--function", "slot1.a"]);
    assert_eq!(code(&clap_refusal), Some(2));
    assert!(
        stderr(&clap_refusal).contains("required arguments were not provided"),
        "expected clap's own refusal, got: {}",
        stderr(&clap_refusal)
    );

    let ksx_refusal = sandbox.run(&[
        "map",
        "--preset",
        "no-such-preset",
        "--function",
        "slot1.a",
        "--key",
        "G",
    ]);
    assert_eq!(code(&ksx_refusal), Some(2));
    assert!(
        !stderr(&ksx_refusal).contains("required arguments were not provided"),
        "the unknown-preset case is being refused by clap, not by ksx, so \
         `a_verb_that_refuses_exits_two_and_writes_nothing` proves nothing about ksx: {}",
        stderr(&ksx_refusal)
    );
}

/// The other end: a verb that answers exits 0. Without this, a binary that
/// exited 2 for everything would pass the test above.
#[test]
fn a_verb_that_answers_exits_zero() {
    let sandbox = Sandbox::new("ok");
    for args in [&["--version"][..], &["--help"][..], &["map", "--help"][..]] {
        let out = sandbox.run(args);
        assert_eq!(
            code(&out),
            Some(0),
            "ksx {args:?} exited {:?}\nstderr: {}",
            code(&out),
            stderr(&out)
        );
    }
}

/// **The run is portable, not the tester's config root.**
///
/// This is the property the sandbox depends on, and it is invisible if nobody
/// checks it: `ksx` sets up logging before `Cli::parse()`, so a missing marker
/// silently redirects every run above into the real config root — which on a
/// developer machine may be the one a live daemon is using. `parity.rs`
/// records the same hazard ("forty `--help` runs write forty log lines into a
/// directory this test then deletes").
#[test]
fn the_sandbox_really_is_the_config_root() {
    let sandbox = Sandbox::new("root");
    let out = sandbox.run(&["--version"]);
    assert_eq!(code(&out), Some(0));
    assert!(
        sandbox.dir.join("logs").is_dir(),
        "ksx logged somewhere other than the sandbox, so the portable marker is not \
         being honoured and these tests are writing into the real config root.\n\
         stderr: {}",
        stderr(&out)
    );
}
