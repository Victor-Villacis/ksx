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

Seed, real start, and teardown share a named per-environment transition lock.
If another agent is already building or swapping that environment, the second
command refuses instead of racing its PID record. Every fixture launch also
receives a fresh GUID generation nonce; a reused Windows PID therefore cannot
make an old browser draft look current.

A new fixture process generation also clears browser-only drafts on that
fixture origin once, so “first run” really starts clean. It never clears
browser data on the real-machine origin.

Use `-SkipBuild` only when the isolated fixture executable already exists and
the embedded Studio assets have not changed.

## Start real-hardware QA

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/start-real.ps1
```

This builds `ksx-app` with the `studio` feature and starts the production
providers on fixed port 4460. It seeds nothing. The managed launcher preserves
installed-mode config discovery (`%APPDATA%\ksx`); it refuses to copy an
executable across a nearby portable `ksx.toml`, because doing so would silently
change the config root. Launch a portable installation's own executable in
place instead.

The replacement is built before the previous managed process is stopped. The
same owning-PID and payload-provenance checks used for fixtures must pass before
the script calls the live process healthy. The script warns when WinIPAC is
open but never closes it: WinIPAC may continue to own the I-PAC configuration
collection, in which case keyboard presses can be observed while chart reads
correctly report that the collection is busy.

Persistent I-PAC writes are allowed only when the assigned task explicitly
calls for real hardware mutation and the in-app supervised confirmation is
completed. A fixture result is never evidence for a real write.

## Status and teardown

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/status.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/teardown.ps1 -Environment first-run
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/teardown.ps1 -All
```

Teardown validates the recorded executable path and PID before stopping it. It
will not kill an unrecorded process merely because that process owns a known
port. Logs remain under `tmp/studio-env/logs`; PID records and copied
executables are disposable and ignored by Git.

Status lists every manual and default Playwright port. `managed / running`
means the listener PID, process record, environment id, fixture/live bit, and
fixture generation all agree. A portable executable launched in place can
instead report `manual live / running`; teardown deliberately leaves that
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
