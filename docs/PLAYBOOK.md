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
4. **The gate** (all must be green before commit):
   ```
   cargo fmt --all -- --check
   cargo clippy --workspace --exclude vigem-client --all-targets -- -D warnings
   cargo test --workspace --exclude vigem-client
   cargo check --workspace
   cargo check -p ksx-output --features cab-tests --all-targets   # must compile, never runs in CI
   ```
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
- **Driver bindings are supervised, never incidental.** Nothing in ksx or in an
  agent session rebinds a device, runs `pnputil`, or installs an INF as a side
  effect of something else. `ksx winusb claim`/`release` are dry runs by default
  and need an explicit `--yes` plus an admin token; a rebind on the cabinet is a
  deliberate act performed with `docs/RECOVERY.md` §2 open and a second keyboard
  plugged in. The one refusal that is not negotiable: never claim a machine's
  last keyboard.

## Conventions

- Commits: imperative subject, body explains what/why, trailer
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Milestone commits land as one commit per milestone (plus doc commits as needed);
  push to `origin main` (SSH).
- Research artifacts live in `docs/research/`; machine-verified facts beat docs —
  when they disagree, re-verify live and update the doc.
