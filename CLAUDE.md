# ksx — orientation

Read this before touching anything. It is the map, not the reasoning: it says
**where things are and what will bite you**. The `docs/` files say *why*, and
this file points at the right one instead of repeating it.

KSX splits one keyboard (an arcade encoder — an I-PAC) into up to 16 virtual
gamepads on Windows 11. It is a standalone Rust workspace with one vendored
dependency.

## The one rule everything else follows

**The backend owns state; every surface is a view** (`docs/SURFACES.md` §1).

A capability becomes a *typed spec in, pure plan out* in the backend; the CLI,
the egui cabinet panel and Studio (browser) each call it and render the result.
No logic in a surface. A constant like `MAX_SLOTS` lives in `ksx-core` **only**
and is served to surfaces — a number hardcoded in TypeScript is the specific
bug this rule exists for.

Build order for any new capability: **backend verb → CLI → the surface a human
performs it on**. There is no "egui first or web first" question.

## Where things are

### Studio ports are evidence boundaries

Before opening, restarting, or judging a Nocturne page, read
[`docs/STUDIO-ENVIRONMENTS.md`](docs/STUDIO-ENVIRONMENTS.md). Port 4460 is the
real-machine QA process; 4476, 4520, and 4521 are distinct synthetic fixtures.
The default Playwright ports and ranges recorded in that document are test-owned
(notably 4478, 4479, 4488–4490, 4496, 4500, and 4510–4512). Use the checked-in
seed/status/teardown scripts under `tools/studio-env` rather than starting an
anonymous fixture by hand. The persistent title-bar banner is the provenance
authority: fixture evidence never proves what Victor's physical I-PAC contains.
The 4460 launcher owns a daemon/Studio pair from one artifact built by that
invocation; do not open
the installed shortcut beside it or call a Studio-only process healthy. Daily
real-hardware iteration does not require reinstalling. A full candidate install
is still required to test protected Program Files-only WinUSB/HIDMaestro paths.

| you want | it is here |
|---|---|
| domain model, engine, keys, personas, `MAX_SLOTS`, `DeviceSelector` | `crates/ksx-core` |
| config + games + presets TOML, validation | `crates/ksx-config` |
| capture backends (Interception, WinUSB) behind `CaptureBackend` | `crates/ksx-capture` |
| ViGEm pad output, persona routing | `crates/ksx-output` |
| Windows plumbing: USB enumeration, WinUSB claim/release | `crates/ksx-platform` |
| the wire contract between backend and every surface | `crates/ksx-api` |
| **every verb's body** — daemon, tray, session supervisor, writers | `crates/ksx-backend` |
| the `ksx` binary: clap definitions and verb dispatch, and nothing else | `crates/ksx-app` |
| the browser UI (Rust render seams + routes) | `crates/ksx-studio` |
| the browser UI's TypeScript islands | `studio-ui/src` |
| the 10-foot cabinet panel (egui) | `crates/ksx-cabinet` |

**The last two rows are the pair that catches people.** `crates/ksx-app` is one
file — `main.rs`, 3,873 lines of clap `#[derive]` and one `match` — and it is
the only crate in the workspace that knows clap exists. If you are adding a
flag, it goes there. If you are adding *behaviour*, it does not: the body lives
in `ksx-backend` and `main.rs` gains one arm calling it. That boundary is
`docs/SURFACES.md` §1 ("the backend owns state; every surface is a view") made
into a compiler error instead of a review comment; before the split the two were
the same 50,665-line crate and the rule was on the honour system.

`crates/ksx-backend/src/` is the biggest surface area. Orient by verb:
`device_edit.rs` / `device_scan.rs` are the device picker's write and read
halves; `run/` is the session supervisor (`plan.rs` builds a plan, `resolve.rs`
turns config spellings into live devnodes); `daemon/` is the resident tray
process and its control pipe; `sources.rs` is where surfaces get their data.

`crates/ksx-app/tests/` did NOT follow the code, on purpose. Each of the five
tests the *binary* rather than a verb: `parity.rs` walks the built exe's clap
tree, `no_interception_dll.rs` parses that exe's PE import table, `installer.rs`
reads `packaging/ksx.iss` against the shipped version, `docs.rs` walks the whole
repo's Markdown, and `replay.rs` drives `ksx-core` from a recorded session with
no ksx-app or ksx-backend code in it at all.


### The suffix rule in `ksx-backend/src/`

52 files is where a convention has to carry the weight. Three families exist
and are consistent; use them, and put a new file in one of them:

| suffix | what it holds | examples |
|---|---|---|
| `*_cli` | a thin driver over a planner: parse, call, print. No rules of its own. | `macro_cli`, `preset_cli`, `slot_cli` |
| `*_edit` | a pure plan/apply pair over one document. Refuses in its own words; touches disk only in `apply`. | `device_edit`, `preset_edit`, `profile_edit` |
| bare noun | a READ that collects and reports, changing nothing. | `devices`, `device_scan`, `doctor` |

Two names predate the rule and are the ones that cost people time —
`map.rs` beside `mapping.rs`, and `devices.rs` beside `device_scan.rs` beside
`device_edit.rs`. Renaming them is a separate change from writing the rule
down; the rule comes first, or a rename just relocates the confusion.

### `ksx-studio/src/server/` is one module per page

`server.rs` reached 4,241 lines carrying 72 routes and 62 handlers before it
was split by page in August 2026. The split mirrors `render_*.rs`, so one
screen is one `render_<page>.rs` and one `server/<page>.rs`.

`server/mod.rs` keeps what is genuinely shared — `AppState`, the router,
`flash_of`, `act`, `urlencode`, the session verbs — and each child does
`use super::*` to reach it. The router names handlers unqualified through glob
re-exports, which is what made the split a move rather than a rewrite: no route
changed and no test changed.

**`parity.rs` reads that router by source text.** It is pointed at
`server/mod.rs`; if the router ever moves again, the guard has to move with it,
and it will tell you so by failing rather than by quietly finding no routes.

## Adding things — the shapes to copy

**A CLI verb**: two files. The body goes in `ksx-backend/src/<verb>.rs` and is a
typed spec in, a pure plan out, a timestamped backup before any write, the
store's atomic save doing the I/O — copy `ksx-backend/src/device_edit.rs`, its
module docs state the pattern. Then `ksx-app/src/main.rs` gets the clap
definition and one `match` arm calling it, plus its module in the
`use ksx_backend::{…}` list at the top. Refusals carry a stable `code()` and an
`advice()` that names a command that actually exists.

**A Studio page**: routes go in the ONE `Router::new()` chain in
`ksx-studio/src/server.rs`, **before** the `.layer()` guard — anything after it
is unguarded. Every mutating route obeys `guard.rs` (CSRF/DNS-rebinding) and
303-redirects with the outcome in `?flash=`. A page is four seams (scalars,
lists, shows, `build_slots`) plus one layout test — copy `render_devices.rs`,
and read its top comment about what must never come back into a view. The Rust
seam and the TypeScript island are mirrors: every string composed in Rust must
be composed identically in TS, and the layout test pins the Rust side.

**A cabinet screen**: `ksx-cabinet/src/nav.rs` lists them. Remember there is no
mouse and no keyboard at a cabinet — the arcade panel is the input, so anything
you add must be panel-navigable.

## The gate — CI runs it, not your machine

**Push your branch and let the runner gate it.** CI triggers on every branch,
so `git push -u origin <branch>` runs the pinned toolchain and full matrix from
a clean checkout. A local pass is useful iteration evidence, but it does not
replace the reproducible runner result used for a release.

Locally, run the *narrow* thing — `cargo test -p <the crate you touched>` — to
iterate. Do not run the full matrix locally; that is what the runner is for.

For reference, this is what CI runs, and what you would have to reproduce if
you ever gate by hand:

```
cargo fmt --check                       # on the crates you touched
cargo clippy --workspace --exclude vigem-client --all-targets -- -D warnings
# then, for BOTH ksx-app and ksx-backend, all four combinations:
cargo clippy -p <crate> --all-targets -- -D warnings                       # no features
cargo clippy -p <crate> --all-targets --features studio -- -D warnings
cargo clippy -p <crate> --all-targets --features cabinet -- -D warnings
cargo clippy -p <crate> --all-targets --features studio,cabinet -- -D warnings
cargo test --workspace --exclude vigem-client
```

The four feature combinations are not paranoia: `studio` and `cabinet` are
independent opt-ins, so the default build compiles neither, and **five separate
breakages have reached main through that gap**. `--features studio` alone has
caught dead code twice. Both crates, because `ksx-app` merely *forwards* those
features to `ksx-backend`: `-p ksx-app --all-targets` compiles the backend's
gated code but not the backend's tests, which is where most of it is tested.

Touched `studio-ui/`? Also `cd studio-ui && node build.mjs`, commit the
regenerated assets **plus the committed outputs it writes —
`studio-ui/src/zones.gen.ts`, `studio-ui/src/tokens.gen.css` and
`crates/ksx-studio/src/theme_tokens.rs`** — and confirm a fresh rebuild is
byte-identical. If the Rust vocabulary or mapper art tables changed, first run
`cargo test -p ksx-studio write_generated_zone_tokens_json -- --ignored` and
commit its `studio-ui/tokens/zones.json` handoff too. (The Node rebuild is cheap
and local; it is not rustc.)

## Landmines — each one has already cost a day

- **Shipped binaries come only from the clean CI runner.** A local success or
  failure is diagnostic, not release evidence: reproduce unexpected compiler
  failures on a clean runner, and never substitute a developer-built binary for
  the artifact tied to the release commit.
- **The toolchain is pinned** (`rust-toolchain.toml`, 1.97.1). Never
  `rustup override`. Local 1.96 vs CI 1.97 once made "clippy clean" mean two
  different things and shipped 24 diagnostics to CI.
- **Never hand-merge generated assets** (`ksx-studio/assets/*`, `manifest.json`,
  `sw.js`, hashed bundles, `studio-ui/tokens/zones.json`,
  `studio-ui/src/zones.gen.ts`, `studio-ui/src/tokens.gen.css`, and
  `crates/ksx-studio/src/theme_tokens.rs`). Regenerate `zones.json` with its
  ignored Rust writer test, then regenerate its TypeScript projection and the
  other Studio outputs with `studio-ui/build.mjs`. A hand-resolved manifest
  yields a page whose HTML and JS disagree — it fails in a browser and in no
  Rust test; a hand-resolved generated handoff can silently ship a vocabulary
  or palette no one chose.
- **Never assert what the code cannot know.** A refusal once said "this id names
  one specific USB SOCKET"; a live port move disproved it, because Windows keys
  a devnode off the serial when the board reports one. State what *decides* the
  behaviour, not what you assume follows.
- **A failed read is not an absence.** "I could not read this" and "there is
  nothing here" are different sentences and users act on them differently. This
  project's signature bug is reporting success while the panel is dead.
- **Doc section numbers are load-bearing.** ~25 code sites cite
  `DEVICE-IDENTITY.md` by §number; `crates/ksx-app/tests/docs.rs` fails the
  build if a cited section stops existing. Renumbering breaks all of them.
- **`.iss` files**: never write a Pascal `{ }` comment containing `{app}` —
  Inno ends the comment at the first `}`. Use `//`. This broke the installer.
- **The version is spelled twice** — `Cargo.toml`'s `[workspace.package]` and
  `packaging/ksx.iss`'s `#define AppVersion` — and a release tag must equal
  both. Bump them in the same commit; `crates/ksx-app/tests/installer.rs` fails
  if they drift, and the release refuses to build rather than guessing
  (`docs/RELEASING.md`).
- **Windows/CRLF**: `include_str!` reads files as checked out. A test comparing
  against `\n` passes locally and fails on every fresh clone. CI was red 57 runs
  over this.

## Tests

A test must **fail against the broken version**. Name in a comment which broken
version it catches. A test that re-encodes the implementation is worse than
none — several have been deleted for this. Hardware-touching tests live behind
the `cab-tests` feature and never run in CI.

Unit tests live beside the code, so most of them are in `ksx-backend`.
`crates/ksx-app/tests/` holds the cross-cutting ones, which test the shipped
binary rather than a verb: `docs.rs` (doc citations stay true), `replay.rs` (a
real 392-event cabinet recording drives the engine offline — the regression
oracle for the whole input path).

**insta snapshot files are keyed by `module_path!()`, which starts with the
crate name.** A snapshot that moves crates has to be renamed with it
(`ksx__x.snap` → `ksx_backend__x.snap`) or the test fails looking for a file
that is sitting right there.

## Which doc to open

| question | doc |
|---|---|
| taking the project over / broad orientation | `docs/HANDOFF.md` |
| which surface does this belong on? | `docs/SURFACES.md` |
| how is a device identified, and why not by path? | `docs/DEVICE-IDENTITY.md` |
| what can each control surface do? | `docs/CONTROL-SURFACE.md` |
| the milestone map and exit criteria | `docs/ARCHITECTURE.md` |
| the HIDMaestro M8 implementation sprint | `docs/HIDMAESTRO.md` |
| how a customer gets a build (tag → releases page) | `docs/RELEASING.md` |
| supervised cabinet runbooks (the hardware gates) | `docs/GATES.md` |
| the panel is dead / a claim went wrong | `docs/RECOVERY.md` |
| keys, chords, turbo, SOCD, macros | `docs/INPUT-TRANSFORMS.md` |
| Studio's visual language | `docs/DESIGN-SYSTEM.md` |
| why there is no native config UI | `docs/M9-DECISION.md` |
| the enhancement/idea ledger | `docs/ENHANCEMENTS.md` |
| panel encoder discovery/programming evidence and current state | `docs/PANEL-PROGRAMMING-STATE.md` |
| encoder families, open-source evidence, licensing boundary and provider admission | `docs/ENCODER-ECOSYSTEM.md` |

## Working style here

Commit early and often — several small commits beat one perfect one that never
lands. Write commit messages that explain **why**, in the repo's voice: read
`git log` before writing one. Never push unless asked.
