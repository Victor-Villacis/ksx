# ksx Engineering Playbook

How milestones get executed on this project. Several rules are adapted from Bun's
Zig→Rust rewrite ([bun.com/blog/bun-in-rust](https://bun.com/blog/bun-in-rust) —
535k LOC in 11 days, 1 engineer + Claude workflows); scale tactics were rejected,
process patterns adopted. See the plan's "Bun-in-Rust lessons" for the full
adopt/reject rationale.

## Milestone execution shape

1. **Contracts first** when multiple agents will build in parallel: one agent (or
   the lead) defines shared types/trait signatures; implementers build against them.
2. **Parallel implementation** with strict crate ownership — one agent per crate,
   never two writers in one file. `ksx-backend` wiring is its own sequential step.
3. **Adversarial review, Bun ratio** (M3 onward — driver-touching code can brick
   keyboards): every implementation gets **2 independent adversarial reviewers**
   with distinct lenses — (a) correctness against KSX's typed contracts,
   typed fixtures and regression tests, (b) crash/hang/recovery safety (what happens on kill,
   hang, unplug, driver absence). Their only job: find why the code does not work.
   Mechanical fixes they may apply; semantic divergences they report.
4. **The gate.** These five must be green before commit:
   ```
   cargo fmt --all -- --check
   cargo clippy --workspace --exclude vigem-client --all-targets -- -D warnings
   cargo test --workspace --exclude vigem-client
   cargo check --workspace
   cargo check -p ksx-output --features cab-tests --all-targets   # must compile, never runs in CI
   ```
   **They are not the whole gate, and the part they omit is the part that keeps
   breaking.** `.github/workflows/ci.yml` also runs, and a green local five does
   not predict any of them:
   ```
   # the four feature combinations, for BOTH crates that spell the opt-in
   foreach ($p in 'ksx-app','ksx-backend') { foreach ($f in '','studio','cabinet','studio,cabinet') { ... } }
   # ...and then EXECUTE the union, because the clippy pass above runs no test
   cargo test -p ksx-app      --features studio,cabinet
   cargo test -p ksx-backend  --features studio,cabinet
   cargo test --workspace --exclude vigem-client --examples   # example targets
   cargo test -p ksx-platform --lib --features hidmaestro-fake-host-tests
   cargo check -p vigem-client --all-features
   tools/studio-env/build-assets.ps1      # deterministic: builds twice, byte-compares
   cd studio-ui/pwtest; npm test          # pinned-Chromium Studio suite
   ```
   The default build compiles neither `studio` nor `cabinet`; five breakages
   have reached `main` through that gap, and `profile_edit`'s tests sat red from
   `b652579` until 2026-08-12 because `cargo test --workspace` runs default
   features and never compiled them. Do **not** run the four-way matrix
   locally — push the branch and let CI do it (`HANDOFF.md` §6). The
   `--examples` and `ksx-platform` lines are the exception worth making: both
   finish in seconds on a warm target directory, neither needs hardware, and
   each covers a class the five above cannot see, so run them before you push
   rather than after.

   **How many tests the five hide, measured.** An audit on 2026-08-26 ran every
   line above and diffed the counts. The local five execute 2,449 tests in 47
   binaries (`--workspace --exclude vigem-client`, 0 failed, 5 ignored). The
   lines below them execute **71 more that no local command reaches**:

   | what the five miss | run | vs default |
   |---|---|---|
   | `ksx-backend` behind `any(studio, cabinet)` | 790 | 735 (**+55**) |
   | `ksx-app` behind the same opt-in | 65 | 60 (**+5**) |
   | tests *inside* example targets | 8 | 0 (**+8**) |
   | `ksx-platform`'s elevation boundary | 262 | 259 (**+3**) |

   Two of those four had no CI step at all until 2026-08-26. **`cargo test`
   builds example targets and does not run them** — `--examples` is what turns
   an example into a test binary — so the eight tests in
   `crates/ksx-studio/examples/macro_fixture.rs`, the fixture the whole
   Playwright gate launches, had never been executed by any gate. And
   `ksx-platform`'s `hidmaestro-fake-host-tests` guards three assertions about
   the fixed SDK-free child's session and privilege inheritance; the default
   build compiles none of them. Both now have steps in `ci.yml`.

   The reason this is worth four extra lines: **`ksx open` shipped a 404 with a
   green suite.** `studio_launch::url()` returned the deleted `/start`, so the
   desktop icon, the Start-menu entry and the tray all opened a chrome-less
   window on a 404 with no address bar to correct it in — and a test in the same
   file pinned the wrong value, so the suite agreed with the bug. It reached a
   build because that file sits behind `--features studio` and no local run
   compiled it (fixed in `ad520b4`). *A test that never runs and a test that
   pins the wrong answer are indistinguishable from outside: both are green.*

   > ⚠ **`cargo test --workspace` can fail with `LNK1104` while a studio-env
   > lane is up**, and it is not your change. Default target selection *builds*
   > examples, so it must relink `target/debug/examples/macro_fixture.exe` —
   > which a running fixture lane holds open. Stop the lane
   > (`tools/studio-env/teardown.ps1`) or add `--lib --bins --tests` to skip
   > building examples. The `--examples` line is immune: it emits a separate
   > `macro_fixture-<hash>.exe` test harness and never touches the locked file.
   > (`STATUS_ACCESS_VIOLATION` and `LNK1201`/`LNK1207` are the *other*, unrelated
   > local build failures — see `DEVELOPMENT-PIPELINE.md`.)
5. **Live milestone exit test on the cabinet** per docs/ARCHITECTURE.md's table —
   a milestone is not done until its hardware gate passes.

## Test oracle strategy

No external implementation is KSX's oracle. The product contract is built from
its own measurements and tests:

- **Now**: proptest invariants on the engine, configuration round trips, and
  XInput loopback (`cab-tests`).
- **M3**: `ksx monitor --record` can capture a local diagnostic stream (device +
  scancode + timing). Committed replay tests use synthetic recordings and assert
  byte-identical pad-state sequences; private hardware captures are not shipped.
- **M3/M6 fuzzing**: `cargo-fuzz` targets for TOML config (M3) and the raw NKRO
  HID report parser (M6 — hardware-supplied bytes). Run in
  local bursts before each milestone gate, not 24/7.

## Standing rules

- **Workaround rejection** (Bun, verbatim): "If you need a paragraph-long comment
  to justify why the workaround is OK, the code is wrong — fix the code."
- **Hot-path purity**: no tokio, no allocation, no locks in the capture thread;
  latency is measured (p99 < 1 ms), not assumed.
- **CLI is AI-drivable**: every command has stable exit codes and `--json` where
  output is structured; config stays plain TOML.
- **Crate ownership**: vendored `vigem-client` keeps upstream style (lint-allowed
  in its manifest); never edit its `src/`.
- **Boring rollout**: do not call a candidate released or hardware-proven until
  the applicable software matrix and supervised cabinet gates both pass.
- **Driver safety**: no Windows feature updates on the cabinet until M6 removes
  the Interception dependency (audit→enforcement CI-policy cliff);
  `docs/RECOVERY.md` before any capture-layer experiment.
- **Device support grows outward, one verb at a time.** Core keyboard splitting
  gets made right first; a new board is added by itself, gated by itself, and
  confirmed on real silicon by itself. The single-dump extraction of the encoder
  chart surface is the counter-example this rule exists for — it removed four
  behaviours in one pass and each was found separately afterwards. Never claim a
  capability ksx cannot currently perform, and never retire an unknown device's
  bindings on a hunch: keep it and mark it unverified.
  `docs/DEVELOPMENT-PIPELINE.md`, "Adding a new input device", is the workflow.
- **Driver bindings are supervised, never incidental.** Nothing in ksx or in an
  agent session rebinds a device, runs `pnputil`, or installs an INF as a side
  effect of something else. `ksx winusb claim`/`release` are dry runs by default
  and need an explicit `--yes` plus an admin token; a rebind on the cabinet is a
  deliberate act performed with `docs/RECOVERY.md` §2 open and a second keyboard
  plugged in. The one refusal that is not negotiable: never claim a machine's
  last keyboard.

## Conventions

- Commits: imperative subject, body explains what/why, then the two trailers
  the current tree actually uses — `Co-Authored-By:` naming the model, and
  `Claude-Session:` with the session URL. Copy the trailers off `git log -1`
  rather than from here; the model name changes and a stale convention in a doc
  is worse than no convention.
- Milestone commits land as one commit per milestone (plus doc commits as
  needed). **Push a branch, not `main`.** `main` blocks force-push and deletion
  and requires the repository ruleset's checks
  (`DEVELOPMENT-PIPELINE.md`, "Repository controls"), so a direct push is
  refused; release promotion goes through a merge and then a CLI-pushed tag.
- Research artifacts live in `docs/research/`; machine-verified facts beat docs —
  when they disagree, re-verify live and update the doc.
