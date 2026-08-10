//! `ksx autostart` — cold boot to a live tray (or, with `--mode run`, straight
//! into a session).
//!
//! The XML, the `schtasks` argv, the status parsing and the staleness rules all
//! live in `ksx_platform::autostart` (pure, tested off-Windows). This file is
//! the command: flags, validation, exit codes, and the one thing the platform
//! layer deliberately cannot do — decide whether the thing being registered
//! would actually *work*.
//!
//! The default registration is `ksx daemon`, not `ksx run` — see
//! [`ksx_platform::autostart::TaskMode`] for the rationale (a `run` at logon
//! captures the keyboards unconditionally on a machine that is also a desktop
//! PC; the daemon sits in the tray until asked).
//!
//! # Why `--enable` validates first
//!
//! A scheduled task is a promise made to a machine nobody is watching. Register
//! `ksx daemon --game "Example Launchr"` (typo for `Example Launcher`) and the failure surfaces at
//! 07:00 on a cold boot, as an instant exit-2 on a console that is not attached
//! to a screen, in a cabinet whose tray icon never appears. There is no error
//! message anywhere a human will look.
//!
//! So `--enable` refuses (exit 2) unless, right now:
//!
//! - the configuration validates — same rules as `ksx run`, no laxer;
//! - the named `--game` profile exists in `games.toml`;
//! - that profile's executable exists on disk.
//!
//! It is the difference between finding out in one second and finding out in
//! one morning.
//!
//! # Safety
//!
//! Nothing in the test suite touches the real Task Scheduler. `--dry-run`
//! prints the exact XML and the exact `schtasks` invocation and registers
//! nothing.

use ksx_platform::autostart::{
    self, check_staleness, AutostartError, EnablePlan, Staleness, Status, TaskMode, TaskSpec,
};

/// Refused: nothing was registered or removed.
pub const EXIT_REFUSED: i32 = 2;

/// Which of the three verbs was asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Status,
    Enable,
    Disable,
}

/// Everything the CLI passes in.
pub struct Options {
    pub action: Action,
    pub mode: TaskMode,
    pub game: Option<String>,
    pub delay_secs: u32,
    pub task_name: Option<String>,
    pub extra_args: Vec<String>,
    pub dry_run: bool,
    pub json: bool,
}

pub fn run(opts: Options) -> anyhow::Result<()> {
    match opts.action {
        Action::Status => status(&opts),
        Action::Enable => enable(&opts),
        Action::Disable => disable(&opts),
    }
}

fn task_name(opts: &Options) -> String {
    opts.task_name
        .clone()
        .unwrap_or_else(|| autostart::DEFAULT_TASK_NAME.to_owned())
}

// ---------------------------------------------------------------------------
// --status
// ---------------------------------------------------------------------------

fn status(opts: &Options) -> anyhow::Result<()> {
    let name = task_name(opts);
    let status = autostart::query(&name)?;
    let exe = std::env::current_exe().ok();
    let stale = match (&status, &exe) {
        (Status::Registered(task), Some(exe)) => Some(check_staleness(task, exe, |p| p.is_file())),
        _ => None,
    };

    if opts.json {
        let mut value = autostart::status_json(&name, &status);
        value["stale"] = match &stale {
            Some(stale) => serde_json::json!({
                "code": stale.code(),
                "broken": stale.is_broken(),
                "message": stale.message(),
            }),
            None => serde_json::Value::Null,
        };
        println!("{}", serde_json::to_string_pretty(&value)?);
    } else {
        println!("{}", autostart::render_status(&name, &status));
        if let Some(message) = stale.as_ref().and_then(Staleness::message) {
            println!("\n[WARN] {message}");
        }
    }

    // A registration that cannot run is a problem, and `--status` is what a
    // health check calls. Say so in the exit code, not only in the text.
    if stale.as_ref().is_some_and(Staleness::is_broken) {
        std::process::exit(EXIT_REFUSED);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// --enable
// ---------------------------------------------------------------------------

fn enable(opts: &Options) -> anyhow::Result<()> {
    let plan = match build_plan(opts) {
        Ok(plan) => plan,
        Err(refusal) => {
            if opts.json {
                println!("{}", crate::pads::error_json("autostart-refused", &refusal));
            } else {
                eprintln!("refusing to register the autostart task:\n{refusal}");
            }
            std::process::exit(EXIT_REFUSED);
        }
    };

    if opts.dry_run {
        if opts.json {
            println!("{}", serde_json::to_string_pretty(&plan.to_json(true))?);
        } else {
            print!("{}", plan.render_human(true));
        }
        return Ok(());
    }

    autostart::apply(&plan)?;
    if opts.json {
        println!("{}", serde_json::to_string_pretty(&plan.to_json(false))?);
    } else {
        print!("{}", plan.render_human(false));
        println!("\nregistered. Verify with `ksx autostart --status`, remove with `--disable`.");
    }
    Ok(())
}

/// Validate everything, then build the plan. `Err` is a user-facing refusal.
fn build_plan(opts: &Options) -> Result<EnablePlan, String> {
    validate_target(opts.mode, opts.game.as_deref())?;
    let spec = spec(opts).map_err(|err| err.to_string())?;
    autostart::enable_plan(spec).map_err(|err| err.to_string())
}

fn spec(opts: &Options) -> Result<TaskSpec, AutostartError> {
    autostart::spec_for_current_exe(
        opts.mode,
        opts.game.clone(),
        opts.extra_args.clone(),
        opts.delay_secs,
        opts.task_name.clone(),
    )
}

/// The check that makes a scheduled task worth trusting: would
/// `ksx daemon`/`ksx run` (with the given `--game`) start *right now*?
///
/// The same gate applies to both modes: the daemon refuses to start (exit 2)
/// on a configuration `ksx run` would refuse, so anything registered here has
/// to resolve today or the logon task dies silently either way.
fn validate_target(mode: TaskMode, game: Option<&str>) -> Result<(), String> {
    let root = ksx_config::ConfigRoot::discover().map_err(|err| {
        format!("  [FAIL] {err}\n  Fix the configuration before registering an autostart task.")
    })?;

    // Exactly the resolution `ksx run` performs — config validation, the game
    // lookup, preset resolution, slot sanity. Anything it refuses at 07:00 it
    // must refuse here, where somebody is looking at the screen.
    crate::run::plan::resolve(&root, game).map_err(|err| {
        format!(
            "  [FAIL] {err}\n  `ksx {}{}` would exit 2 at logon, on a console nobody sees.",
            mode.verb(),
            match game {
                Some(title) => format!(" --game \"{title}\""),
                None => String::new(),
            }
        )
    })?;

    // ...and, for a profile, that the program it names is actually there.
    if let Some(title) = game {
        let games = ksx_config::Store::new(root.clone())
            .load_games()
            .map_err(|err| format!("  [FAIL] {err}"))?;
        if let Some(entry) = games.value.games.iter().find(|g| g.title == title) {
            let launch = ksx_games::LaunchSpec::from_entry(entry);
            ksx_games::preflight(&launch).map_err(|err| format!("  [FAIL] {err}"))?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// --disable
// ---------------------------------------------------------------------------

fn disable(opts: &Options) -> anyhow::Result<()> {
    let name = task_name(opts);
    if opts.dry_run {
        let argv = autostart::delete_argv(&name);
        if opts.json {
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "action": "dry-run",
                    "task_name": name,
                    "schtasks_argv": argv,
                }))?
            );
        } else {
            println!(
                "command:      schtasks {}\n\ndry run: nothing was removed.",
                ksx_platform::installer::quote_argv(&argv)
            );
        }
        return Ok(());
    }

    let removed = autostart::remove(&name)?;
    if opts.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "action": "disable",
                "task_name": name,
                "removed": removed,
            }))?
        );
    } else if removed {
        println!("autostart removed (scheduled task '{name}' deleted)");
    } else {
        // Idempotent on purpose: `--disable` must be safe to run twice, and in
        // a script "it was already gone" is success, not an error.
        println!("autostart was not registered; nothing to remove");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Installed uninstaller quiesce
// ---------------------------------------------------------------------------

/// The single elevated command Inno Setup may run before WinUSB cleanup.
///
/// Inno's uninstaller cannot use `ExecAsOriginalUser`, and executing
/// `{app}\ksx.exe` with its administrator token would be an elevation bug if a
/// custom install directory were user-writable. Validate the *running file
/// itself* as a protected Program Files install first, then remove and freshly
/// prove absence of the one fixed machine task before asking the daemon to
/// quit. No profile path or caller-supplied task name enters this path.
pub fn uninstall_quiesce() -> anyhow::Result<()> {
    let current = std::env::current_exe()
        .map_err(|error| anyhow::anyhow!("cannot resolve the installed ksx executable: {error}"))?;
    let outcome = quiesce_with(
        || {
            ksx_platform::process::protected_install_sibling(&current, &current)
                .map(|_| ())
                .map_err(|error| format!("refusing elevated uninstall quiesce: {error}"))
        },
        || {
            autostart::remove_verified(autostart::DEFAULT_TASK_NAME)
                .map_err(|error| format!("could not disable the fixed autostart task: {error}"))
        },
        || crate::session::quit_for_uninstall().map_err(|error| error.to_string()),
    )
    .map_err(anyhow::Error::msg)?;
    println!(
        "uninstall quiesced: autostart {}; {}",
        if outcome.0 {
            "removed and verified absent"
        } else {
            "already absent"
        },
        outcome.1
    );
    Ok(())
}

fn quiesce_with(
    verify_install: impl FnOnce() -> Result<(), String>,
    disable_fixed_task: impl FnOnce() -> Result<bool, String>,
    quit_daemon: impl FnOnce() -> Result<String, String>,
) -> Result<(bool, String), String> {
    verify_install()?;
    let removed = disable_fixed_task()?;
    let daemon = quit_daemon()?;
    Ok((removed, daemon))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn uninstall_quiesce_is_protected_then_task_absent_then_daemon_quit() {
        let order = std::sync::Mutex::new(Vec::new());
        let outcome = quiesce_with(
            || {
                order.lock().unwrap().push("protected-install");
                Ok(())
            },
            || {
                order.lock().unwrap().push("task-absent");
                Ok(false)
            },
            || {
                order.lock().unwrap().push("daemon-quit");
                Ok("daemon already stopped".to_owned())
            },
        )
        .unwrap();
        assert_eq!(
            *order.lock().unwrap(),
            ["protected-install", "task-absent", "daemon-quit"]
        );
        assert_eq!(outcome, (false, "daemon already stopped".to_owned()));
    }

    #[test]
    fn uninstall_quiesce_never_quits_after_task_absence_cannot_be_proved() {
        let quit_called = std::cell::Cell::new(false);
        let error = quiesce_with(
            || Ok(()),
            || Err("task still registered".to_owned()),
            || {
                quit_called.set(true);
                Ok("stopped".to_owned())
            },
        )
        .unwrap_err();
        assert_eq!(error, "task still registered");
        assert!(!quit_called.get());
    }

    /// The refusal is what stops a typo becoming a dead cabinet, so its wording
    /// is part of the contract: it must name the failure AND say what would
    /// have happened.
    #[test]
    fn an_unknown_game_profile_is_refused_with_an_explanation() {
        // `resolve` is the shared gate; drive it directly so this test needs no
        // config on disk.
        let games: ksx_config::GamesFile =
            toml::from_str("[[game]]\ntitle = \"Example Launcher\"\npath = 'C:\\steam.exe'\n")
                .unwrap();
        let config: ksx_config::ConfigFile = toml::from_str(
            "schema_version = 1\n[[slot]]\nnumber = 1\nkeyboard = 'HID\\X\\1'\npreset = \"default\"\n",
        )
        .unwrap();
        let err = crate::run::plan::build_plan(&config, &games, &[], Some("Steem")).unwrap_err();
        let text = err.to_string();
        assert!(text.contains("'Steem'"), "{text}");
        assert!(
            text.contains("Example Launcher"),
            "the known titles must be listed: {text}"
        );
    }

    /// Exit codes are part of the API a frontend script depends on.
    #[test]
    fn refusal_uses_the_same_code_as_every_other_cannot_start() {
        assert_eq!(EXIT_REFUSED, crate::run::EXIT_CANNOT_START);
    }

    fn spec_for(mode: TaskMode, game: Option<&str>) -> TaskSpec {
        TaskSpec {
            task_name: "ksx\\autostart".into(),
            exe: PathBuf::from(r"C:\Program Files\ksx\ksx.exe"),
            mode,
            game: game.map(str::to_owned),
            extra_args: Vec::new(),
            user_id: "CAB\\testuser".into(),
            delay_secs: 10,
        }
    }

    /// `--dry-run` must produce the whole document, and register nothing.
    /// `--mode run` here: the kiosk shape is still a first-class registration.
    #[test]
    fn dry_run_renders_the_exact_xml_and_command() {
        let plan = autostart::enable_plan(spec_for(TaskMode::Run, Some("Example Game"))).unwrap();
        let text = plan.render_human(true);
        assert!(text.contains("schtasks /Create"), "{text}");
        assert!(text.contains("<LogonTrigger>"), "{text}");
        // Quotes are XML-escaped inside the document but must survive the
        // round trip back out — Task Scheduler hands the unescaped string to
        // CommandLineToArgvW, and a half-escaped title is an autostart that
        // silently starts the wrong profile.
        assert!(
            text.contains("<Arguments>run --game &quot;Example Game&quot;</Arguments>"),
            "{text}"
        );
        assert_eq!(
            autostart::parse_registered(&plan.xml).arguments.as_deref(),
            Some(r#"run --game "Example Game""#)
        );
        assert_eq!(
            autostart::parse_registered(&plan.xml).game().as_deref(),
            Some("Example Game")
        );
        assert!(text.contains("nothing was registered"), "{text}");
        assert!(
            text.contains("LeastPrivilege"),
            "the task must never be elevated: {text}"
        );
    }

    /// Every mode×game combination produces the command line it promises, and
    /// the registered XML reads back with the same mode and game.
    #[test]
    fn every_mode_and_game_combination_round_trips_through_plan_and_inspection() {
        for (mode, game, want_args) in [
            (TaskMode::Daemon, None, "daemon"),
            (
                TaskMode::Daemon,
                Some("Example Launcher"),
                "daemon --game \"Example Launcher\"",
            ),
            (TaskMode::Run, None, "run"),
            (
                TaskMode::Run,
                Some("Example Launcher"),
                "run --game \"Example Launcher\"",
            ),
        ] {
            let plan = autostart::enable_plan(spec_for(mode, game)).unwrap();
            assert_eq!(plan.spec.arguments(), want_args);
            assert_eq!(
                plan.spec.command_line(),
                format!(r#""C:\Program Files\ksx\ksx.exe" {want_args}"#)
            );
            let registered = autostart::parse_registered(&plan.xml);
            assert_eq!(registered.mode(), Some(mode), "{want_args}");
            assert_eq!(registered.game().as_deref(), game, "{want_args}");
        }
    }
}
