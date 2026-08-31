//! `ksx open`, and the tray item that is the same thing: ksx on screen as an
//! application window, or a sentence saying why not.
//!
//! docs/M9-DECISION.md cancelled the native config UI and made Studio the UI.
//! What that decision costs, and therefore what this file owes, is stated in
//! its §2: *"The thing that makes ksx feel like a web page is not HTML — it is
//! that you launch it by typing a URL, and that clicking a shortcut before the
//! daemon is up would hand you `ERR_CONNECTION_REFUSED`. Both are launcher
//! bugs."* This is the launcher.
//!
//! # The four things it does, in order
//!
//! 1. **Make sure a daemon is running.** [`ensure_daemon`] probes the control
//!    pipe, starts `ksx daemon` — the same verb `ksx autostart` registers —
//!    and waits, bounded, for the pipe to answer. A daemon that never answers
//!    is a WARNING and not the end: Studio's read side needs no daemon
//!    (M9-DECISION §4 item 7), so the window still opens, read-only, behind
//!    its own "No daemon" banner. Refusing to open at all would delete the
//!    recovery path.
//! 2. **Make sure Studio is serving.** Probe Studio's stable `/api/health`
//!    contract, start `ksx studio` if a live-machine provider does not answer,
//!    and **wait for it** before handing anyone a URL. A TCP listener, a 404,
//!    and a fixture wearing Studio's port are not Studio readiness. This is
//!    the `ERR_CONNECTION_REFUSED` half, and it is the property this file had
//!    before the rest of M9 existed.
//! 3. **Resolve a browser through `App Paths`, never `ShellExecute` on a
//!    URL** (§4 item 2). `ksx_platform::app_paths` asks the registry where
//!    `msedge.exe` — then `chrome.exe` — actually is. A default-browser
//!    activation cannot be given flags, so it cannot produce the window
//!    below; and on a stripped image there may be no `http` association at
//!    all.
//! 4. **Open a chrome-less application window** — `--app=<url>` with a
//!    `--user-data-dir` **ksx owns**, under `%LOCALAPPDATA%\ksx`. Its own
//!    taskbar button, its own alt-tab entry, no address bar, no tabs, and
//!    none of the user's extensions, cookies or zoom state (§2).
//!
//! # What it still does not do
//!
//! - **No single instance.** A second `ksx open` starts a second window
//!   rather than focusing the first — M9-DECISION §4 item 5, not built here.
//! - **No WebView2 host.** That is Option B, priced and held in reserve (§3);
//!   this window is a browser we drive, and its right-click menu, Ctrl+P and
//!   F12 are all still live. The triggers that would flip that decision are
//!   in §7 and none of them has fired.
//! - **No port option.** [`PORT`] is spelled once here and matches `ksx
//!   studio`'s default. A Studio deliberately served on another port is not
//!   found by this launcher, which starts one of its own on [`PORT`].
//!
//! # Where the fallback goes
//!
//! With no Chromium registered under either name, or with no directory ksx
//! can call its own, the window degrades to the default-browser
//! `shell_open` this file did before — **and says which and why**, because a
//! surface that cannot do the thing it promised must say so rather than
//! quietly do something else (docs/CONTROL-SURFACE.md).

use std::io::Write;
use std::path::{Path, PathBuf};

/// Studio's default port — the one `ksx studio` binds and the one this dials.
pub const PORT: u16 = 4460;

/// Where Studio will be, spelled once.
///
/// Returned to callers so a surface that cannot open a browser can still show
/// the address. On a 10-foot cabinet screen with a joystick and two buttons,
/// "type this on your phone" is frequently the *useful* outcome, and a UI that
/// only knows how to launch a local browser cannot offer it.
pub fn url() -> String {
    // `/redesign` is the current product workbench. Keep this authority in one
    // place so the CLI, installer-created shortcut and standalone launcher all
    // open the same route without changing Studio's established port.
    format!("http://127.0.0.1:{PORT}/redesign")
}

/// The small response shape the launcher accepts from Studio's stable health
/// endpoint.
///
/// This deliberately lives here instead of depending on a product page
/// payload. The endpoint is the operational boundary shared by launchers and
/// lane tooling; `/redesign` is only the page opened after that boundary has
/// proved who owns the listener.
#[cfg(any(windows, test))]
#[derive(serde::Deserialize)]
struct LauncherHealth {
    environment: LauncherEnvironment,
    staged: LauncherStaged,
    setup: Option<LauncherSetup>,
    setup_error: String,
}

#[cfg(any(windows, test))]
#[derive(serde::Deserialize)]
struct LauncherEnvironment {
    id: String,
    label: String,
    detail: String,
    fixture: bool,
    #[serde(default)]
    generation: String,
}

#[cfg(any(windows, test))]
#[derive(serde::Deserialize)]
struct LauncherStaged {
    reachable: bool,
    error: Option<String>,
}

#[cfg(any(windows, test))]
#[derive(serde::Deserialize)]
struct LauncherSetup {
    config_root: String,
}

/// Does `address` serve the live-machine KSX health contract within `timeout`?
///
/// This is intentionally a tiny HTTP/1.1 client made from `std`: launcher
/// readiness must not pull an async runtime or general-purpose HTTP client
/// into the backend. Every socket operation is bounded, the response is
/// capped, and only loopback addresses are admitted by the caller.
#[cfg(any(windows, test))]
fn studio_health_at(address: std::net::SocketAddr, timeout: std::time::Duration) -> bool {
    use std::io::{Read, Write as _};

    const MAX_HEALTH_RESPONSE_BYTES: usize = 64 * 1024;

    let started = std::time::Instant::now();
    let remaining = || {
        timeout
            .checked_sub(started.elapsed())
            .filter(|remaining| !remaining.is_zero())
    };

    let Some(connect_timeout) = remaining() else {
        return false;
    };
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(&address, connect_timeout) else {
        return false;
    };

    let request = format!(
        "GET /api/health HTTP/1.1\r\nHost: {address}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    let mut request = request.as_bytes();
    while !request.is_empty() {
        let Some(write_timeout) = remaining() else {
            return false;
        };
        if stream.set_write_timeout(Some(write_timeout)).is_err() {
            return false;
        }
        match stream.write(request) {
            Ok(0) | Err(_) => return false,
            Ok(written) => request = &request[written..],
        }
    }

    let mut response = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        let Some(read_timeout) = remaining() else {
            return false;
        };
        if stream.set_read_timeout(Some(read_timeout)).is_err() {
            return false;
        }

        let bytes_left = MAX_HEALTH_RESPONSE_BYTES + 1 - response.len();
        let chunk_len = chunk.len().min(bytes_left);
        match stream.read(&mut chunk[..chunk_len]) {
            Ok(0) => break,
            Ok(read) => {
                response.extend_from_slice(&chunk[..read]);
                if response.len() > MAX_HEALTH_RESPONSE_BYTES {
                    return false;
                }
            }
            Err(_) => return false,
        }
    }
    let Ok(response) = std::str::from_utf8(&response) else {
        return false;
    };
    let Some((head, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    let mut lines = head.split("\r\n");
    let Some(status) = lines.next() else {
        return false;
    };
    let mut status_parts = status.split_whitespace();
    if !status_parts
        .next()
        .is_some_and(|version| matches!(version, "HTTP/1.0" | "HTTP/1.1"))
        || status_parts.next() != Some("200")
    {
        return false;
    }

    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim(), value.trim()))
        .collect::<Vec<_>>();
    let header = |wanted: &str| {
        headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(wanted))
            .map(|(_, value)| *value)
    };
    if !header("content-type").is_some_and(|value| {
        value
            .split(';')
            .next()
            .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
    }) || !header("cache-control").is_some_and(|value| {
        value
            .split(',')
            .any(|directive| directive.trim().eq_ignore_ascii_case("no-store"))
    }) {
        return false;
    }

    let Ok(health) = serde_json::from_str::<LauncherHealth>(body) else {
        return false;
    };
    let environment_is_live = health.environment.id == "live-machine"
        && !health.environment.fixture
        && health.environment.generation.is_empty()
        && !health.environment.label.trim().is_empty()
        && !health.environment.detail.trim().is_empty();
    let staged_is_coherent = if health.staged.reachable {
        health.staged.error.is_none()
    } else {
        health
            .staged
            .error
            .as_deref()
            .is_some_and(|error| !error.trim().is_empty())
    };
    let setup_is_coherent = match health.setup {
        Some(setup) => !setup.config_root.trim().is_empty() && health.setup_error.is_empty(),
        None => !health.setup_error.trim().is_empty(),
    };

    environment_is_live && staged_is_coherent && setup_is_coherent
}

// ---------------------------------------------------------------------------
// The decision — pure, and the whole of what is tested. Nothing below this
// heading opens a socket, reads a registry or starts a process.
// ---------------------------------------------------------------------------

/// A Chromium ksx knows how to drive, and the name a human would recognise.
pub struct Chromium {
    /// The `App Paths` key name — also the file name on disk.
    pub exe: &'static str,
    pub name: &'static str,
}

/// The browsers to try, **in this order**.
///
/// Edge first because it is the one that is *there*: Windows 11 ships it
/// in-box, so on a machine nobody has configured it is the only Chromium with
/// a registered path (M9-DECISION §2 verified it on this machine). Chrome
/// second — a machine that has both usually got Chrome on purpose, but only
/// after Edge was already present, so preferring it would make the launcher's
/// behaviour depend on a browser race nobody ran.
///
/// This is a fixed list, not a search: a browser ksx has never been run
/// against is not made safer by being launched with Chromium's flags.
pub const CHROMIUM: [Chromium; 2] = [
    Chromium {
        exe: "msedge.exe",
        name: "Microsoft Edge",
    },
    Chromium {
        exe: "chrome.exe",
        name: "Google Chrome",
    },
];

/// How ksx will put Studio on screen.
#[derive(Debug, PartialEq, Eq)]
pub enum Window {
    /// Our own Chromium invocation: a chrome-less application window.
    App {
        browser: &'static str,
        exe: PathBuf,
        argv: Vec<String>,
    },
    /// Whatever the user's `http` association opens — the pre-M9 behaviour,
    /// kept as the honest degradation. `why` is the sentence the user is owed.
    DefaultBrowser { url: String, why: String },
}

/// The ksx-owned browser profile directory, given the machine's
/// `%LOCALAPPDATA%`.
///
/// **Local, not roaming, and not the config root.** ksx's configuration lives
/// in `%APPDATA%\ksx` because it is small, hand-editable TOML a user might
/// legitimately sync between machines. A Chromium profile is neither: **63 MB
/// after one open**, measured here on 2026-08-08 by running exactly the argv
/// below, and it is cache and a code cache keyed to one installation — so it
/// grows, and none of it means anything on another machine. Beside
/// `config.toml` it would roam all of that and bury the handful of files a
/// human is meant to edit.
pub fn profile_dir(local_appdata: &Path) -> PathBuf {
    local_appdata.join("ksx").join("browser-profile")
}

/// The exact argument list that turns a browser into ksx's window.
///
/// Each flag, and what it is being *asked* for — Chromium's behaviour is
/// Chromium's to change, and §5 item 2 of the decision names that as a
/// dependency we do not control:
///
/// - `--app=<url>` — open this URL as an application window: no address bar,
///   no tab strip, its own taskbar button and alt-tab entry. This is the flag
///   the whole file exists to be able to pass, and the reason a default-browser
///   activation cannot substitute.
/// - `--user-data-dir=<ksx profile>` — use a profile ksx owns. Without it the
///   window would run inside the user's own browser profile and inherit its
///   extensions, its sign-in, its cookies and its per-origin zoom — the last
///   of which is how a stray Ctrl+scroll leaves ksx at 150 % forever, in the
///   user's browser, for every site on `127.0.0.1`.
/// - `--no-first-run` and `--no-default-browser-check` — a brand-new profile
///   is a brand-new browser installation as far as Chromium is concerned. Ask
///   it not to greet the user with a welcome flow or ask to be made the
///   default the first time ksx opens.
///
/// The URL comes from [`url`] rather than being spelled again, so the window
/// and the "type this on your phone" line can never name different addresses.
pub fn app_argv(url: &str, profile: &Path) -> Vec<String> {
    vec![
        format!("--app={url}"),
        format!("--user-data-dir={}", profile.display()),
        "--no-first-run".to_owned(),
        "--no-default-browser-check".to_owned(),
    ]
}

/// Decide how to show `url`, given a profile directory (or the reason there is
/// none) and a way to look an executable up.
///
/// The lookup is injected — every test drives this function with a fake
/// resolver, and no test has ever started a browser.
///
/// **A missing profile directory means no application window**, not an
/// application window without `--user-data-dir`. Dropping the flag would put
/// ksx inside the user's own browser profile, which is precisely the thing the
/// flag is there to prevent; the honest degradation is the default browser,
/// said out loud.
pub fn choose(
    url: &str,
    profile: Result<PathBuf, String>,
    resolve: &dyn Fn(&str) -> Option<PathBuf>,
) -> Window {
    let profile = match profile {
        Ok(dir) => dir,
        Err(why) => {
            return Window::DefaultBrowser {
                url: url.to_owned(),
                why: format!("ksx has no browser profile directory of its own ({why})"),
            }
        }
    };
    match CHROMIUM
        .iter()
        .find_map(|browser| resolve(browser.exe).map(|exe| (browser, exe)))
    {
        Some((browser, exe)) => Window::App {
            browser: browser.name,
            argv: app_argv(url, &profile),
            exe,
        },
        None => Window::DefaultBrowser {
            url: url.to_owned(),
            why: format!(
                "no Chromium browser is registered on this machine (looked for {})",
                CHROMIUM
                    .iter()
                    .map(|b| b.exe)
                    .collect::<Vec<_>>()
                    .join(" and ")
            ),
        },
    }
}

/// The refusal off Windows, for both entry points.
///
/// Nothing here has a portable form: `App Paths` is a Windows registry key and
/// `ksx_platform::process::shell_open` is `ShellExecuteW`. The verb exists on
/// every platform so the CLI's shape does not depend on the host; it declines
/// on the ones where it would only fail later, and names what to do instead.
#[cfg(not(windows))]
const NOT_WINDOWS: &str = "`ksx open` is Windows-only: it resolves a browser through the Windows \
     App Paths registry and starts the daemon that serves Studio. Run `ksx studio` and open its \
     URL yourself.";

// ---------------------------------------------------------------------------
// Doing it — probes, spawns, and the two entry points.
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod live {
    use super::*;

    use std::net::{Ipv4Addr, SocketAddr};
    use std::time::{Duration, Instant};

    /// How long to wait for a freshly started Studio to answer.
    const READY_TIMEOUT: Duration = Duration::from_secs(8);
    /// How long to wait for a freshly started daemon's control pipe.
    ///
    /// Same shape and the same reasoning as `CONNECT_BUDGET` in
    /// `ksx-api/src/pipe.rs`: a deadline, a retry pause, and a worded failure
    /// — never an unbounded wait on a process that may have exited two
    /// seconds ago. Longer than that transport's two seconds because this one
    /// is waiting for a process to *start*, not for an instance to rotate.
    const DAEMON_TIMEOUT: Duration = Duration::from_secs(8);
    const PROBE_EVERY: Duration = Duration::from_millis(150);
    /// A connect attempt that hangs is a machine problem, not a busy server.
    const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);

    /// Open ksx from the tray. Never blocks the caller.
    ///
    /// Everything below happens on a thread of its own, because "poll a port
    /// for eight seconds" is not something the daemon's control loop may do
    /// while a session is waiting to be reaped.
    ///
    /// No [`ensure_daemon`] step here, and that is not an omission: this code
    /// runs *inside* the daemon. The console may be gone by now (the daemon
    /// detaches once the tray icon exists), so the outcome — including which
    /// browser was used — goes to the log, which is the surface that always
    /// exists.
    pub fn open(out: &mut dyn Write) {
        let _ = writeln!(out, "opening ksx…");
        let _ =
            std::thread::Builder::new()
                .name("ksx-open".into())
                .spawn(|| match ensure_and_open() {
                    Ok(done) => tracing::info!("{done}"),
                    Err(why) => tracing::error!("could not open ksx: {why}"),
                });
    }

    /// `ksx open` — the whole launcher, on the caller's thread.
    ///
    /// Blocking on purpose: this process exists to put a window on screen and
    /// then exit, and a shortcut that returns before the window is up is the
    /// bug this file was written to fix.
    pub fn run() -> anyhow::Result<()> {
        let mut out = std::io::stdout();
        if let Err(why) = ensure_daemon(&mut out) {
            // Not fatal. Studio's read side needs no daemon, so the window is
            // still worth opening — and the banner it opens behind is the
            // documented recovery path (M9-DECISION §4 item 7), not a
            // degraded mode we are hiding.
            let _ = writeln!(out, "[WARN] {why}");
            let _ = writeln!(
                out,
                "       Studio will open read-only, behind its \"No daemon\" banner."
            );
        }
        match ensure_and_open() {
            Ok(done) => {
                let _ = writeln!(out, "{done}");
                Ok(())
            }
            Err(why) => Err(anyhow::anyhow!("{why}")),
        }
    }

    /// Studio, then a window. Shared by both entry points, which is what makes
    /// the tray item and the verb the same thing rather than two things that
    /// agree today.
    fn ensure_and_open() -> Result<String, String> {
        ensure_studio()?;
        show(choose(
            &url(),
            prepare_profile(),
            &ksx_platform::app_paths::resolve,
        ))
    }

    /// Start the window, and say what happened either way.
    fn show(window: Window) -> Result<String, String> {
        match window {
            Window::App { browser, exe, argv } => {
                ksx_platform::process::no_window(std::process::Command::new(&exe).args(&argv))
                    .spawn()
                    .map(|_| format!("opened ksx in {browser} ({})", exe.display()))
                    .map_err(|err| format!("could not start {browser} at {}: {err}", exe.display()))
            }
            Window::DefaultBrowser { url, why } => ksx_platform::process::shell_open(&url)
                .map(|()| format!("{why} — opened {url} in your default browser instead"))
                .map_err(|err| {
                    format!(
                        "{why}, and the default browser could not be opened either: {err} ({url})"
                    )
                }),
        }
    }

    /// The ksx-owned profile directory, created if it is not there.
    ///
    /// Created by us rather than left to Chromium so that a failure is ksx's
    /// sentence on ksx's console, instead of a browser error dialog about a
    /// path the user never chose.
    fn prepare_profile() -> Result<PathBuf, String> {
        let base = std::env::var_os("LOCALAPPDATA")
            .ok_or_else(|| "%LOCALAPPDATA% is not set".to_owned())?;
        let dir = profile_dir(Path::new(&base));
        std::fs::create_dir_all(&dir)
            .map_err(|err| format!("{} could not be created: {err}", dir.display()))?;
        Ok(dir)
    }

    /// Bring a daemon up, and wait — bounded — for its control pipe.
    fn ensure_daemon(out: &mut dyn Write) -> Result<(), String> {
        if daemon_answering() {
            return Ok(());
        }
        let _ = writeln!(out, "starting the ksx daemon…");
        start_daemon()?;
        let deadline = Instant::now() + DAEMON_TIMEOUT;
        while !daemon_answering() {
            if Instant::now() >= deadline {
                return Err(format!(
                    "started `ksx daemon` but its control pipe did not answer within {}s — \
                     run `ksx daemon --console` to see why (a configuration it refuses exits 2)",
                    DAEMON_TIMEOUT.as_secs()
                ));
            }
            std::thread::sleep(PROBE_EVERY);
        }
        Ok(())
    }

    /// Bring Studio up, and wait — bounded — for its health contract.
    ///
    /// **"It must never be possible to reach `ERR_CONNECTION_REFUSED` by
    /// clicking a ksx shortcut"** (M9-DECISION §4 item 1). A launcher that
    /// opens a browser at a port nothing is listening on has not opened
    /// Studio; it has produced an error page with ksx's name on it.
    fn ensure_studio() -> Result<(), String> {
        if studio_answering() {
            return Ok(());
        }
        start_studio()?;
        let deadline = Instant::now() + READY_TIMEOUT;
        while !studio_answering() {
            if Instant::now() >= deadline {
                return Err(format!(
                    "started `ksx studio` but no live-machine KSX health response answered \
                     http://127.0.0.1:{PORT}/api/health within {}s — run `ksx studio` in a \
                     console to see why (another process may own the port)",
                    READY_TIMEOUT.as_secs()
                ));
            }
            std::thread::sleep(PROBE_EVERY);
        }
        Ok(())
    }

    /// Is the live-machine Studio provider serving its stable health contract?
    ///
    /// A TCP accept is not readiness: it can be an unrelated process, a stale
    /// fixture, or Studio before the router is ready. The launcher accepts
    /// only HTTP 200 from `/api/health` with the live-machine provenance and
    /// coherent stable fields. `staged.reachable == false` is still healthy
    /// enough to open because the read-only daemon recovery path is part of
    /// the product contract.
    fn studio_answering() -> bool {
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, PORT));
        studio_health_at(address, CONNECT_TIMEOUT)
    }

    /// Is a daemon answering the control pipe?
    ///
    /// One real `status` request through the same client `ksx session` uses —
    /// not a file-existence test — because the question is "will the pipe
    /// answer", and that is the only way to ask it. Only `NotRunning` counts
    /// as absent: a daemon that answers with a REFUSAL is a daemon, and a
    /// conversation that breaks mid-flight is not a problem a second daemon
    /// would fix (the pipe's first instance owns the name, so a second daemon
    /// exits rather than splitting the stream).
    fn daemon_answering() -> bool {
        use crate::daemon::pipe::{client, PIPE_NAME};

        let request = serde_json::to_value(ksx_api::Request::Status)
            .unwrap_or_else(|err| unreachable!("a control request is always serializable: {err}"));
        !matches!(
            client::request(PIPE_NAME, &request),
            Err(client::ClientError::NotRunning)
        )
    }

    /// Start `ksx daemon` — the same verb, spelled the same way, that
    /// `ksx autostart` registers with Task Scheduler
    /// ([`ksx_platform::autostart::TaskMode::verb`]). One spelling, so a
    /// machine that boots into ksx and a machine where someone clicked the
    /// shortcut are running the same command line.
    fn start_daemon() -> Result<(), String> {
        spawn_self(&[ksx_platform::autostart::TaskMode::Daemon.verb()])
    }

    /// Start `ksx studio` on the port this file dials.
    fn start_studio() -> Result<(), String> {
        spawn_self(&["studio", "--port", &PORT.to_string()])
    }

    /// Start one of OUR OWN verbs as a detached child, using OUR OWN
    /// executable.
    ///
    /// `current_exe`, never a `PATH` lookup: a launcher started from a build
    /// tree, a staging folder or an installer must start the binary it IS, not
    /// whichever ksx happens to be first on the path.
    ///
    /// `no_window`, and here it is load-bearing rather than tidy: both
    /// children are **long-lived**, so a console window would not flash — it
    /// would sit on the cabinet's game screen for as long as ksx is up, and
    /// closing it would kill what it belongs to. A parent that has already
    /// released its own console (the daemon) is exactly the condition under
    /// which Windows hands a console-subsystem child a fresh one.
    ///
    /// Nothing waits on the child: it outlives this process by design, which
    /// on Windows needs no detach ceremony — a child is not in its parent's
    /// job unless someone puts it there.
    fn spawn_self(args: &[&str]) -> Result<(), String> {
        let exe =
            std::env::current_exe().map_err(|err| format!("cannot find my own path: {err}"))?;
        ksx_platform::process::no_window(std::process::Command::new(&exe).args(args))
            .spawn()
            .map(|_| ())
            .map_err(|err| {
                format!(
                    "could not start `{} {}`: {err}",
                    exe.display(),
                    args.join(" ")
                )
            })
    }
}

#[cfg(windows)]
pub use live::{open, run};

/// The tray item, off Windows: it says what it cannot do (see [`NOT_WINDOWS`]).
#[cfg(not(windows))]
pub fn open(out: &mut dyn Write) {
    let _ = writeln!(out, "{NOT_WINDOWS}");
}

/// `ksx open`, off Windows: a refusal, not a half-launch.
#[cfg(not(windows))]
pub fn run() -> anyhow::Result<()> {
    anyhow::bail!("{NOT_WINDOWS} ({})", url())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A resolver that knows about a fixed set of browsers, and remembers what
    /// it was asked. No registry, no filesystem, no browser — ever.
    struct FakeAppPaths {
        installed: Vec<&'static str>,
        asked: std::cell::RefCell<Vec<String>>,
    }

    impl FakeAppPaths {
        fn with(installed: &[&'static str]) -> Self {
            Self {
                installed: installed.to_vec(),
                asked: std::cell::RefCell::new(Vec::new()),
            }
        }

        fn resolver(&self) -> impl Fn(&str) -> Option<PathBuf> + '_ {
            move |exe| {
                self.asked.borrow_mut().push(exe.to_owned());
                self.installed
                    .contains(&exe)
                    .then(|| PathBuf::from(format!(r"C:\Program Files\{exe}")))
            }
        }
    }

    fn profile() -> PathBuf {
        profile_dir(Path::new(r"C:\Users\TestUser\AppData\Local"))
    }

    /// Serve exactly one deterministic HTTP response and run the real
    /// launcher probe against it. The listener is ephemeral and loopback-only;
    /// no test depends on whichever process owns the product port.
    fn probe_response(response: impl Into<Vec<u8>>, timeout: std::time::Duration) -> bool {
        use std::io::{Read as _, Write as _};

        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let response = response.into();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(1)))
                .unwrap();
            let mut request = [0_u8; 1024];
            let read = stream.read(&mut request).unwrap();
            let request = std::str::from_utf8(&request[..read]).unwrap();
            assert!(
                request.starts_with("GET /api/health HTTP/1.1\r\n"),
                "{request}"
            );
            let _ = stream.write_all(&response);
        });
        let ready = studio_health_at(address, timeout);
        server.join().unwrap();
        ready
    }

    fn http_response(status: &str, content_type: &str, cache_control: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nCache-Control: {cache_control}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn live_health_body() -> &'static str {
        r#"{"environment":{"id":"live-machine","label":"LIVE MACHINE · REAL HARDWARE","detail":"Live providers read this computer's devices.","fixture":false,"generation":""},"staged":{"reachable":false,"error":"No daemon answered."},"setup":null,"setup_error":"Configuration could not be read. Reopen ksx and try again."}"#
    }

    #[test]
    fn studio_readiness_accepts_the_live_health_contract_even_without_a_daemon() {
        let response = http_response(
            "200 OK",
            "application/json; charset=utf-8",
            "private, no-store",
            live_health_body(),
        );
        assert!(probe_response(response, std::time::Duration::from_secs(1)));
    }

    #[test]
    fn studio_readiness_rejects_a_random_listener_and_a_fixture() {
        assert!(!probe_response(
            b"SSH-2.0-not-studio\r\n".to_vec(),
            std::time::Duration::from_secs(1)
        ));

        let fixture = live_health_body()
            .replacen(r#""id":"live-machine","#, r#""id":"fixture-seeded","#, 1)
            .replacen(r#""fixture":false"#, r#""fixture":true"#, 1);
        let response = http_response("200 OK", "application/json", "no-store", &fixture);
        assert!(!probe_response(response, std::time::Duration::from_secs(1)));
    }

    #[test]
    fn studio_readiness_rejects_404_and_malformed_health_responses() {
        let not_found = http_response("404 Not Found", "application/json", "no-store", "{}");
        assert!(!probe_response(
            not_found,
            std::time::Duration::from_secs(1)
        ));

        let malformed = http_response("200 OK", "application/json", "no-store", "{not-json");
        assert!(!probe_response(
            malformed,
            std::time::Duration::from_secs(1)
        ));
    }

    #[test]
    fn studio_readiness_is_bounded_and_rejects_connection_failure() {
        use std::io::Read as _;

        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            std::thread::sleep(std::time::Duration::from_millis(500));
        });
        let started = std::time::Instant::now();
        assert!(!studio_health_at(
            address,
            std::time::Duration::from_millis(20)
        ));
        assert!(
            started.elapsed() < std::time::Duration::from_millis(400),
            "the response timeout was not enforced: {:?}",
            started.elapsed()
        );
        server.join().unwrap();

        let unused = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let unused_address = unused.local_addr().unwrap();
        drop(unused);
        assert!(!studio_health_at(
            unused_address,
            std::time::Duration::from_millis(50)
        ));
    }

    #[test]
    fn studio_readiness_has_one_deadline_even_when_the_peer_drips_bytes() {
        use std::io::{Read as _, Write as _};

        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);

            // Stay active well past the probe's budget while ensuring every
            // individual read receives data before that budget expires. A
            // per-read timeout therefore takes roughly 800 ms; an absolute
            // deadline returns near the requested 80 ms.
            for _ in 0..80 {
                if stream.write_all(b"H").is_err() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        });

        let started = std::time::Instant::now();
        assert!(!studio_health_at(
            address,
            std::time::Duration::from_millis(80)
        ));
        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_millis(500),
            "a slow-drip peer extended the total readiness deadline: {elapsed:?}"
        );

        server.join().unwrap();
    }

    /// **The M9 launcher bug, as an assertion.** Before this pass the tray
    /// handed the URL to `shell_open` and nothing else: a tab in whatever
    /// browser the user had, inside the user's own profile.
    ///
    /// Every element below is load-bearing and fails against a plausible
    /// wrong version: no `--app=` is a browser tab, no `--user-data-dir` is
    /// the user's own profile with their extensions and their zoom state, and
    /// the URL must be the one Studio is actually serving.
    #[test]
    fn the_window_is_an_app_window_in_a_profile_ksx_owns() {
        let paths = FakeAppPaths::with(&["msedge.exe"]);
        let window = choose(&url(), Ok(profile()), &paths.resolver());
        let Window::App { browser, exe, argv } = window else {
            panic!("Edge is installed in this fixture; expected an app window");
        };
        assert_eq!(browser, "Microsoft Edge");
        assert_eq!(exe, PathBuf::from(r"C:\Program Files\msedge.exe"));
        assert_eq!(
            argv,
            vec![
                "--app=http://127.0.0.1:4460/redesign".to_owned(),
                r"--user-data-dir=C:\Users\TestUser\AppData\Local\ksx\browser-profile".to_owned(),
                "--no-first-run".to_owned(),
                "--no-default-browser-check".to_owned(),
            ]
        );
    }

    /// The profile is ksx's, it is under `%LOCALAPPDATA%`, and it is NOT the
    /// config root. Catches a version that reuses `%APPDATA%\ksx` — which
    /// would roam a multi-hundred-megabyte browser cache and bury the handful
    /// of TOML files a human is meant to edit — and one that points
    /// `--user-data-dir` at the user's own Chrome profile.
    #[test]
    fn the_browser_profile_lives_under_local_appdata_and_belongs_to_ksx() {
        let local = Path::new(r"C:\Users\TestUser\AppData\Local");
        let dir = profile_dir(local);
        assert!(dir.starts_with(local), "{}", dir.display());
        assert!(dir.starts_with(local.join("ksx")), "{}", dir.display());
        assert_ne!(dir, local.join("ksx"), "the profile is not the ksx root");
        let text = dir.display().to_string();
        assert!(!text.contains("Roaming"), "{text}");
        assert!(!text.contains("Google"), "{text}");
    }

    /// Edge is asked for first and Chrome only if Edge is absent. Catches a
    /// version that iterates an unordered collection, or that prefers Chrome
    /// — on a stock Windows 11 the answer would then depend on which browser
    /// the user happened to install rather than on which one is guaranteed to
    /// be there.
    #[test]
    fn edge_is_preferred_and_chrome_is_the_fallback() {
        let both = FakeAppPaths::with(&["msedge.exe", "chrome.exe"]);
        match choose(&url(), Ok(profile()), &both.resolver()) {
            Window::App { browser, .. } => assert_eq!(browser, "Microsoft Edge"),
            other => panic!("expected an app window, got {other:?}"),
        }
        assert_eq!(both.asked.borrow().as_slice(), ["msedge.exe"]);

        let chrome_only = FakeAppPaths::with(&["chrome.exe"]);
        match choose(&url(), Ok(profile()), &chrome_only.resolver()) {
            Window::App { browser, exe, .. } => {
                assert_eq!(browser, "Google Chrome");
                assert_eq!(exe, PathBuf::from(r"C:\Program Files\chrome.exe"));
            }
            other => panic!("expected an app window, got {other:?}"),
        }
        // Both names are tried, in order, before giving up on the second.
        assert_eq!(
            chrome_only.asked.borrow().as_slice(),
            ["msedge.exe", "chrome.exe"]
        );
    }

    /// No Chromium at all: fall back to the default browser **and say so**,
    /// naming what was looked for. Catches the version that falls back
    /// silently — the user would have no way to tell an app window from a tab
    /// except by looking at it — and the version that gives up entirely,
    /// which would make a machine with only Firefox unable to open ksx.
    #[test]
    fn with_no_chromium_the_default_browser_is_used_and_the_user_is_told() {
        let none = FakeAppPaths::with(&[]);
        let Window::DefaultBrowser { url: target, why } =
            choose(&url(), Ok(profile()), &none.resolver())
        else {
            panic!("nothing is installed in this fixture; expected the fallback");
        };
        assert_eq!(target, url());
        assert!(why.contains("msedge.exe"), "{why}");
        assert!(why.contains("chrome.exe"), "{why}");
        assert_eq!(none.asked.borrow().as_slice(), ["msedge.exe", "chrome.exe"]);
    }

    /// **No profile directory means no app window.** Catches the version that
    /// keeps `--app=` and drops `--user-data-dir` when `%LOCALAPPDATA%` is
    /// unavailable: that window would run in the user's own browser profile,
    /// inheriting their extensions and leaving ksx's zoom state behind in it —
    /// exactly what the flag exists to prevent. The reason travels with the
    /// refusal, so the console says which of the two fallbacks happened.
    #[test]
    fn without_a_ksx_owned_profile_there_is_no_app_window() {
        let paths = FakeAppPaths::with(&["msedge.exe", "chrome.exe"]);
        let window = choose(
            &url(),
            Err("%LOCALAPPDATA% is not set".to_owned()),
            &paths.resolver(),
        );
        let Window::DefaultBrowser { why, .. } = window else {
            panic!("a browser without a ksx profile must not get an app window");
        };
        assert!(why.contains("%LOCALAPPDATA%"), "{why}");
        assert!(
            paths.asked.borrow().is_empty(),
            "a browser is not even looked for when it could not be used"
        );
    }

    /// The window's URL is the one this module hands out for typing on a
    /// phone. Catches a drift between the `--app=` target and [`url`] — two
    /// spellings of a port is how a launcher opens an empty window while
    /// telling the user a working address.
    #[test]
    fn the_window_opens_the_address_the_module_publishes() {
        let argv = app_argv(&url(), Path::new(r"C:\p"));
        assert_eq!(argv[0], format!("--app={}", url()));
        assert!(argv[0].contains(&PORT.to_string()));
    }

    /// **The published address has to be a page Studio actually serves.**
    ///
    /// THE BUG, 2026-08-25: this test used to open with
    /// `assert_eq!(url(), format!("http://127.0.0.1:{PORT}/start"))` — the body
    /// of [`url`], retyped. Two spellings of the same literal agree by
    /// construction, so when `/start` was deleted in the cutover the test went
    /// on passing and `ksx open` shipped a 404: to the browser it launches, and
    /// to the cabinet user told to type the address on their phone.
    ///
    /// The fix is that the route may not come from this module. It is checked
    /// against `manifest.json` — the file `ksx-studio` embeds and routes off,
    /// the same one `EmbeddedPage::load` reads — so deleting the page fails the
    /// launcher's test. (`ksx-studio`'s own `render_check`/`render_devices`
    /// tests pin the links INSIDE the pages; nothing but this pins the address
    /// ksx hands to a human.)
    ///
    /// The manifest is read as a file rather than through the crate because
    /// nothing in `ksx-studio` publishes its routes: `AssetManifest` and
    /// `EmbeddedPage` are both `pub(crate)`. A `pub const PRODUCT_ROUTE` over
    /// there would let this assert against a symbol instead of a path.
    #[test]
    fn the_published_address_is_a_route_studio_serves() {
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../ksx-studio/assets/manifest.json"))
                .expect("the embedded studio manifest is JSON");
        let published = url();
        let route = published
            .strip_prefix(&format!("http://127.0.0.1:{PORT}"))
            .unwrap_or_else(|| panic!("{published} is not the local Studio origin"));
        let routes = manifest["routes"]
            .as_object()
            .expect("manifest.json has a routes table");
        assert!(
            routes.contains_key(route),
            "ksx opens '{route}', which studio does not serve — it serves {:?}",
            routes.keys().collect::<Vec<_>>()
        );
        // Not just present: the route has to carry the page. A manifest entry
        // with no module behind it renders nothing.
        assert!(
            routes[route]["js"]
                .as_array()
                .is_some_and(|js| !js.is_empty()),
            "'{route}' is in the manifest with no module behind it: {}",
            routes[route]
        );
    }
}
