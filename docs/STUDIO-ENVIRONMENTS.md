# Studio environments

Updated 2026-08-24. This file is the port, provenance, seeding, and teardown
contract for people and agents working on Nocturne.

The label in Studio's title bar is authoritative. A fixture banner means every
device, chart, session, and saved configuration shown by that process is
synthetic. `LIVE MACHINE · REAL HARDWARE` means the production providers are
reading this computer and confirmed hardware actions can affect a physical
device.

## Environment roster

| Port | Banner | Purpose | State source | Who owns it |
|---|---|---|---|---|
| **4460** | `LIVE MACHINE · REAL HARDWARE` | Victor's production-like hardware QA: actual USB inventory, KSX config root, backups, daemon, and physical I-PAC | `CollectorSource` + `LocalMachine` | A person performing real-machine QA. Never seed it. |
| **4476** | `FIXTURE · SEEDED DEMO` | Rich visual/design workspace with controllers, mappings, and macros already present | `macro_fixture` seeded scenario | UI work and screenshots |
| **4478** | fixture (test-owned) | Macro-editor Playwright suite | test runner | Tests only. Never start, stop, or browse it manually. |
| **4479** | fixture (test-owned) | Canvas-controls Playwright suite | test runner | Tests only |
| **4488–4490** | fixture (test-owned) | SSR/hydration parity: idle, running, and daemon-down processes | test runner | Tests only |
| **4496** | fixture (test-owned) | Canvas suite's secondary live-stream process | test runner | Tests only |
| **4500** | fixture (test-owned) | Visual-smoke suite | test runner | Tests only |
| **4510–4512** | fixture (test-owned) | Theme-stamp suite: dark, light, and matrix | test runner | Tests only |
| **4520** | `FIXTURE · FIRST RUN` | KSX has no saved configuration, while its simulated I-PAC has a realistic preconfigured keyboard chart | `macro_fixture --first-run` | Manual onboarding QA |
| **4521** | `FIXTURE · BLANK ENCODER` | Explicit rare case: KSX has no config and the simulated encoder chart is all-Unassigned | `macro_fixture --blank-panel` | Blank-board/editor QA only |

`First run` describes KSX state, not hardware EEPROM state. A factory-new
I-PAC 4 normally ships with keyboard assignments; it must not be modeled as a
blank device. The blank chart lives on 4521 so that exceptional flow remains
testable without lying on 4520.

## Start or reseed a fixture

From the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/seed.ps1 -Environment seeded
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/seed.ps1 -Environment first-run
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/seed.ps1 -Environment blank-encoder
```

Seeding first builds the replacement into an isolated target directory. Only
after that succeeds does it stop the process recorded for the environment,
copy the replacement into ignored `tmp/studio-env`, and start it hidden. It
refuses an unrecorded listener instead of killing it. A `200` alone is not
health: the port's owning PID, the payload's exact fixture id, and its process
generation must all agree before the script reports success.

Seed, real start, and teardown share a named, machine-wide per-environment transition lock.
If another agent is already building or swapping that environment, the second
command refuses instead of racing its PID record. Every fixture launch also
receives a fresh GUID generation nonce; a reused Windows PID therefore cannot
make an old browser draft look current.

A new fixture process generation also clears browser-only drafts on that
fixture origin once, so “first run” really starts clean. It never clears
browser data on the real-machine origin.

Use `-SkipBuild` only when an isolated fixture executable already exists and
the embedded Studio assets have not changed. The real-hardware launcher refuses
`-SkipBuild`: every disposable real runtime must contain the machine-lifecycle
safety fences expected by the launcher and documentation.

## Start real-hardware QA

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/start-real.ps1
```

This builds `ksx-app` with the `studio` feature and starts a managed matched pair from
that exact build: one idle daemon plus Studio on fixed port 4460. It seeds
nothing and it never passes `--start`, so opening QA does not begin an
emulation session, create pads, or launch a game. A configured daemon may still
claim its prepared input interface for idle typethrough; an unconfigured host
with no prepared device claims nothing. The launcher waits for both daemon pipes, proves
their server PID is the recorded daemon, proves the Studio PID owns 4460, and
requires the live payload to report a reachable draft before it calls the pair
healthy.

The managed pair preserves installed-style config discovery
(`%APPDATA%\ksx`); “installed-style” describes the data root, not the binary.
Both processes run the same timestamped artifact built by that launcher
invocation, with its SHA-256 and diagnostic source revision in
`tmp/studio-env/real.json`. The hash proves the pair matches; it does not claim
that a concurrently edited checkout still equals the already-built artifact.
The launcher refuses to copy an executable across a nearby portable
`ksx.toml`, because doing so would silently change the config root. Launch a
portable installation's own executable in place instead.

The replacement is built before the previous managed pair is stopped. A
machine-global daemon that is not in the managed record is never adopted: even
if its `status` response parses, it may be an installed or other-branch binary
with the same display version. Start refuses that mixed runtime. Teardown
validates every PID/executable first, stops Studio, asks the exact proven daemon
to quit gracefully, and only then falls back to stopping that exact recorded
PID. The script warns when WinIPAC is open but never closes it: WinIPAC may
continue to own the I-PAC configuration collection, in which case keyboard
presses can be observed while chart reads correctly report that the collection
is busy.

If start reports an unmanaged daemon, quit it from the tray belonging to the
copy that launched it, or run that exact copy's `session quit`; verify
`status.ps1` shows no daemon, then rerun `start-real.ps1`. Do not solve the
conflict with a broad process kill.

A portable product must also be a deliberate transition: tear down managed
4460, stop the exact prior daemon, and require `status.ps1` to show neither a
4460 listener nor a daemon. Only then run `portable\ksx.exe open` in place, and
require status to report `manual live / running`. Product `open` can adopt
already-answering global endpoints, so skipping that empty-state proof can
silently create a mixed pair.

Persistent I-PAC writes are allowed only when the assigned task explicitly
calls for real hardware mutation and the in-app supervised confirmation is
completed. A fixture result is never evidence for a real write.

## Development loop versus installation

Do **not** reinstall KSX for each code iteration. The ordinary product-shaped
loop is:

1. edit and run the relevant unit/UI tests;
2. rebuild generated Studio assets once under the asset lock, when applicable;
3. run `start-real.ps1`, refresh 4460, and exercise the matched artifact built
   by that invocation against the real `%APPDATA%\ksx` state and hardware;
4. use `status.ps1` as the evidence that both artifact-matched processes and both
   daemon pipes agree; then tear down or run the next replacement.

The Start-menu shortcut and `C:\Program Files\ksx\ksx.exe` are a separate
installed-product acceptance lane. Use a coherent installer/upgrade candidate
at checkpoints, before release, and whenever testing protected installed-only
helpers. Do not open the installed shortcut alongside 4460: the installed and
development executables may print the same package version while containing
different bytes, and the daemon pipe is machine-global.

The 4460 lane is production-state compatible, not an isolated sandbox: saves
write Victor's real `%APPDATA%\ksx` configuration. A newer branch can persist a
draft that an older installed build cannot read. Keep the installed shortcut
closed until 4460 is torn down, and use fixtures for disposable or clean-state
UI work.

The fast 4460 lane exercises I-PAC/HID keyboard work and ordinary Studio/daemon
integration, but it deliberately cannot prove protected-install behavior.
HIDMaestro hosts and elevated WinUSB preparation require their complete,
access-controlled Program Files layout; test those by installing the whole
candidate. Never add a development bypass for that security boundary.
The sign-in/autostart status remains readable on 4460, but changing it is also
fenced: a disposable path must never replace or delete the installed logon
task. Test that write from the complete installed candidate.

## Status and teardown

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/status.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/teardown.ps1 -Environment first-run
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/teardown.ps1 -All
```

Teardown opens and validates each exact recorded process generation before
stopping anything. It will not kill an unrecorded process merely because it
owns a known port or daemon pipe. Logs remain under `tmp/studio-env/logs`; PID
records and copied executables are disposable and ignored by Git.

Status lists every manual and default Playwright port. For 4460,
`managed / running` means the Studio listener, daemon process, control pipe,
live-feed pipe, recorded matched artifact, environment id, and writable draft
reachability all agree. A Studio-only process is reported as daemon unavailable,
not healthy. For fixtures, the listener PID, process record, environment id,
fixture/live bit, and fixture generation must agree. A portable executable launched in place can
instead report `manual live / running` only when the Studio listener and both
daemon pipes resolve to that same executable; teardown deliberately leaves that
unrecorded process alone. Any other `unmanaged listener` or `provenance
mismatch` must be resolved before using that page as QA evidence. Test port
environment variables may move a suite for parallel work, but must never be
pointed at 4460, 4476, 4520, or 4521.

## Asset rebuild lock

The scripts consume the already-generated files in `crates/ksx-studio/assets`.
They do not run `studio-ui/build.mjs`. When Studio source changes, the one agent
holding the asset-rebuild lock runs `node studio-ui/build.mjs` once after the
source graph settles, verifies the generated byte diff, and only then reseeds
the desired environments. No second agent should rebuild or hand-merge
`manifest.json` or `sw.js`.
