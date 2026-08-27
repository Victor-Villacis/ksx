# Development and delivery pipeline

Last verified: **2026-08-26**. This is the operational contract for
agents and people changing KSX. It complements `STUDIO-ENVIRONMENTS.md`, which
owns the localhost ports and process-safety details.

KSX is a Windows desktop/hardware product, so its promotion lanes are artifacts
and machines rather than four permanently deployed web servers. The equivalent
of a SaaS dev → stage → QA → production flow is:

| Lane | What runs | State/hardware | Restart or promotion rule | Evidence |
|---|---|---|---|---|
| **DEV · SYNTHETIC** | Current source on 4476 (`seeded`: controllers, mappings and macros already present — UI work and screenshots) or 4520 (`first-run`: nothing configured — onboarding QA) | Disposable fixtures only | Watched rebuild/reseed | Exact fixture id, process generation, healthy status |
| **DEV BUILD · REAL HARDWARE** | Matched local daemon + Studio on 4460 | Real `%APPDATA%\ksx`, USB devices, and I-PAC | Watched rebuild; swap only while Play is stopped | Executable hash, source/asset graph hashes, exact PIDs/pipes, real banner |
| **CI CANDIDATE** | Clean Windows runner | No physical cabinet | Every branch/PR runs the full matrix and produces immutable artifacts | Commit, run id, installer/ZIP hashes, candidate manifest |
| **INSTALLED QA** | Exact tag-run installer | A real Windows machine and cabinet | Human installs and exercises the candidate while publication waits | Candidate manifest hash plus Gates 1–4 ledger bound to the installer SHA |
| **PRODUCTION** | The approved tag-run files | Customer machines | A required reviewer releases the exact QA-tested files; there is no rebuild | Same run id, names, sizes, and SHA-256 values on the GitHub Release |

Do not call a lane “stage”: KSX already uses *staged setup* for an unsaved
controller configuration. `CI CANDIDATE` is the product-delivery equivalent.

**Ten more ports exist and none of them are yours.** 4478, 4479, 4488–4490,
4496, 4500 and 4510–4512 belong to Playwright suites; `STUDIO-ENVIRONMENTS.md`
says which suite owns which. They are listed by `status.ps1` so a stray process
is visible, not so a person starts one. Never start, stop or browse them by
hand.

**Never seed onto 4460.** It is the only lane wired to the real USB inventory,
the real `%APPDATA%\ksx`, the real backups and a physical encoder; a fixture
answering there would put a synthetic device list in front of someone about to
claim a keyboard. The rule is enforced in code twice and does not depend on
anyone reading this paragraph — `seed.ps1` accepts only `seeded|first-run`
(`param` block) and refuses again if a definition's port is 4460 or a test
port, and `start-real.ps1` holds the complementary reserved list — but it is
written here because the enforcement is the safety net, not the explanation.

## Daily development

Build the committed Studio graph through its lock-owning wrapper, never by
calling `node build.mjs` directly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/build-assets.ps1
```

The wrapper installs the lockfile's Node dependencies when necessary, holds
`Global\KSXStudioBuildGraph-v1`, marks the graph dirty before generation, runs
two builds, and compares every output by path, length, and SHA-256. Cargo-based
environment launchers share that lock and refuse a missing, stale, or dirty
asset receipt.

Start a watched lane:

```powershell
# Real devices and real saved state. This is the normal hardware iteration loop.
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/watch.ps1 -Environment real

# Synthetic alternatives.
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/watch.ps1 -Environment seeded
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/watch.ps1 -Environment first-run
```

The watcher debounces an editor save, fingerprints file contents as the source
of truth, orders Studio generation before Cargo, and runs one build at a time.
It also reconciles process health: if a managed fixture or Studio process dies,
the same proven graph is restarted without requiring a fake source edit.
Transient save/rename observation errors are retried without touching the
running process. A permanent compile/generation failure is attempted once for
that exact content graph and then waits for another edit; hardware/session and
machine-lock deferrals keep retrying because the source itself is not broken.
On 4460 the launcher proves the daemon is stopped before replacing anything;
a running game becomes a visible deferred state. `Ctrl+C` stops only the watcher. Refresh the
browser after a healthy replacement.

Stop a lane — `Ctrl+C` does not, and that is on purpose: the watcher is a
supervisor, not the process:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/teardown.ps1 -Environment real
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/teardown.ps1 -Environment seeded
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/teardown.ps1 -All
```

`-Environment` takes `seeded`, `first-run` or `real`; `-All` takes no
environment and stops all three. Add `-AllowMissing` when a lane may already be
down and you do not want that to be an error. Teardown opens and validates each
exact recorded process generation before stopping anything, so it will not kill
an unrecorded process merely because that process owns a known port — which is
also why it deliberately leaves a hand-launched portable executable alone.
`STUDIO-ENVIRONMENTS.md` has the full contract.

`-NoInitialRefresh` may attach to an already running lane without replacing a
healthy current artifact. It is not a promise to tolerate a stale/stopped lane:
the first reconciliation schedules current/health recovery. It cannot be
combined with `-Once`, because that combination would perform no work.

For one deterministic refresh without a resident watcher:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/watch.ps1 -Environment real -Once
```

Inspect or gate a lane:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/status.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/status.ps1 -Environment real -RequireHealthy -RequireCurrent
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/status.ps1 -Environment first-run -Json -RequireHealthy -RequireCurrent
```

`Healthy` proves the recorded processes, listener, fixture/live identity, and
daemon endpoints agree. `ProvenanceComplete` says the managed receipt carries
all four exact identities: the runtime source graph, Studio authoring graph,
Rust zone-producer graph, and generated asset graph. `Current` is stricter: a
healthy managed artifact must match all four checkout identities now, and the
generated files on disk must still hash to their receipt. `-RequireHealthy`
and `-RequireCurrent` turn those separate facts into nonzero automation gates.
JSON is for scripts; the table is for people. Both include watcher state.

Do not reinstall for each edit. The installed lane is reserved for acceptance
of a coherent CI candidate and for installed-only Program Files/UAC/helper
boundaries that a development copy intentionally cannot exercise.

### Three build failures that are not your change

All three have cost time by being read as evidence about the tree. None of them
is.

**A failed or interrupted asset build leaves tracked files deleted.**
`studio-ui/build.mjs` sets `outputDir = "../crates/ksx-studio/assets"` and
`build()` calls `rmSync(outputDir, { recursive: true, force: true })` *before*
it emits anything. 24 files in that directory are tracked by Git. If the
generator dies between the delete and the write — a crashed Node, a `Ctrl+C`, a
0xc0000005 below — the checkout is sitting there with 24 tracked files gone and
an `assets.dirty` sentinel that correctly refuses every launcher. That is not a
corrupt tree and needs no investigation:

```powershell
git checkout -- crates/ksx-studio/assets/
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/build-assets.ps1
```

The build.mjs comment covers the neighbouring case — do not park foreign files
in that directory, they vanish at the next build. This is the other half: the
directory's *own* contents can be missing too, and the recovery is one command.

**`STATUS_ACCESS_VIOLATION` (0xc0000005) from a compiler is this machine.**
`rustc` itself dying — not a compile error, a process crash — under peak memory
load is a known property of this hardware and is on file beside the 14900K/RAM
instability. It has taken out a release build in `ksx-studio` under LTO with
`codegen-units=1` and, separately, an asset build on the same day; the retry
succeeded both times, and debug builds plus the full test suite have never once
failed this way. **Retry once before concluding anything.** Concluding that a
change broke the build from a single 0xc0000005 is the failure mode `HANDOFF.md`
§9 names — reporting a result the run did not actually produce. If it
reproduces on a clean CI runner, then it is the tree.

**`LNK1104: cannot open file …\examples\macro_fixture.exe` means a lane is
running.** Not a corrupt PDB, not this machine's linker, not your change:
`cargo test --workspace` *builds* example targets even though it never runs
them, so it relinks `target/debug/examples/macro_fixture.exe` — the exact file
a live seeded or first-run studio-env lane is holding open. The symptom is that
the whole workspace test aborts on one crate that has nothing to do with what
you edited. Confirm it before doing anything else:

```powershell
Get-Process -Name macro_fixture -ErrorAction SilentlyContinue
```

If that names a process, either stop the lane
(`tools/studio-env/teardown.ps1 -Environment seeded`) or skip building examples
for the run — `cargo test --workspace --exclude vigem-client --lib --bins
--tests`. Note which one you want: the *gate* line `cargo test --workspace
--exclude vigem-client --examples` is unaffected either way, because `--examples`
emits a separate `macro_fixture-<hash>.exe` test harness and never writes the
file the lane holds.

## Adding a new input device

Written 2026-08-26 against the tree, because the seam a developer has to edit
was not named by any document in this repository. Every file and symbol below
was read before this section was written; nothing here is a proposal.

### Step 0 — find out whether you need to write any code at all

Usually you do not, and starting anywhere else wastes the day.

**ksx captures any HID keyboard interface.** Which backends can reach a devnode
is decided by `Reach::eligibility` in `crates/ksx-core/src/transport.rs` from
exactly three facts: the transport, whether the node carries keyboard reports,
and whether it is already bound to `winusb.sys`. There is no vendor id in that
function, no product table, and no list of supported boards. `ULTIMARC_VID` is
the only named vendor-id constant in the whole tree, and outside the display
table it is reached from exactly three sites, none of which decides anything.
`UsbCandidate::is_ultimarc`
(`crates/ksx-capture/src/winusb/enumerate.rs`) says so in its own doc comment —
*"**Cosmetic only** … No capture path, claim path or refusal may branch on it:
ksx works with any HID keyboard interface"* — and a grep shows its only callers
are that file's tests. The identically named method in
`crates/ksx-platform/src/winusb.rs` has no callers at all. The single production
read of the constant appends a sentence of board-specific advice to a
`NotAKeyboard` refusal that is already correct without it, and its comment
records why it is guarded: it "used to tell every user about I-PAC interface
numbers regardless of what they had plugged in".

So plug the device in and look, before touching a table:

```powershell
ksx device scan --all          # boards, grouped as physical devices
ksx device scan --all --json   # the whole DevicesView — the shape the UI reads
```

`--all` matters: boards with no keyboard interface are hidden by default
because they cannot be picked, but they are always counted, and `--all` is the
answer to "ksx cannot see my board". The command is read-only and daemon-free.

If the board comes back with a keyboard interface, **splitting its keys already
works** — bind it with `ksx device pick` and it is done. What the rest of this
section adds is *recognition*: a better name, and a role. Recognition is a
claim ksx makes about hardware, and claims are the expensive thing here.

### Step 1 — decide which of the three states this device is in

`BoardRole` (`crates/ksx-api/src/machine.rs`) is the backend-owned answer, and
its doc comment is the clearest statement of the rule in the tree: *"A board can
expose a boot-keyboard interface while physically being an arcade encoder, and
the distinction decides which first-run workflow a surface offers … an unknown
HID device remains a keyboard or other device until KSX has exact recognition
evidence."* Three variants, and all three matter:

| role | what it means | what it costs you to be wrong |
|---|---|---|
| `keyboard` | output is fixed in hardware — a key is that key | none; this is the safe default |
| `panel-encoder` | output is *programmable*, so a key's identity is a property of the board's chart, not of the switch | you have vouched for a board whose chart nothing in ksx can currently read |
| `other` | ksx knows nothing about this device | retiring its bindings destroys the user's work on a hunch; calling it verified is this project's signature bug |

The third row is load-bearing and it is the one that gets legislated away. An
unrecognised encoder still splits keys. It simply carries no claim. **Lock
nothing out.**

The assignment is one `if` in `board_row` (`crates/ksx-backend/src/device_scan.rs`)
and it reads exactly like the table:

```rust
let role = if <any interface's VID/PID is in panel_catalog::FAMILIES> {
    ksx_api::BoardRole::PanelEncoder
} else if board.looks_like_a_keyboard() {
    ksx_api::BoardRole::Keyboard
} else {
    ksx_api::BoardRole::Other
};
```

`looks_like_a_keyboard` is `any interface declares HID boot protocol, or ksx
already holds it` — and its own comment says it exists "to sort probable
keyboards to the top and to word the rest honestly, rather than to exclude
them". A board reporting protocol 0 can still be a perfectly good NKRO
keyboard.

### Step 2 — the two tables, and which one you actually want

They answer different questions and live in different crates. Editing the wrong
one is the most likely mistake in this whole workflow.

**`crates/ksx-core/src/vendors.rs` — display only.** One row is a vendor id, an
optional product id, and a name. Add here when all you want is for the row to
read `Ultimarc SpinTrak` instead of an instance path. The module is built so it
cannot become anything else: *"Everything here returns a `&str` or an
`Option<&str>`. Nothing returns a `bool`, and that is deliberate: `is_ipac()` is
the shape that invites a branch."* The device's own `iProduct` string wins when
it has one, so most hardware needs no row at all. It is not a USB ID database
and must not grow into one.

**`crates/ksx-backend/src/panel_catalog.rs` — operational.** Two tables, and the
module doc states the separation the 2026-08-26 decision restates:

- `FAMILIES` (7 rows today, all Ultimarc) — recognizes a physical encoder from
  an exact VID/PID pair. A match flips `BoardRole` to `panel-encoder` and
  supplies the board's label ahead of the display table. **It authorizes no
  report.**
- `PROFILES` (exactly 1 row today: I-PAC 4X, `bcdDevice` 0x0056) — admits one
  exact, measured firmware tuple. Only a profile may advertise chart reads or
  persistent writes, and only after somebody measured that firmware on that
  board.

Adding a recognized encoder is one `PanelFamily` struct literal. That is the
whole edit:

```rust
PanelFamily {
    id: "vendor-boardname",             // unique; PROFILES join on it
    label: "Vendor Board Name",         // beats the display table for this board
    vendor_id: 0xABCD,
    product_id: 0x1234,
},
```

Do **not** add a `PROFILES` row from a datasheet, a forum post, or another
board's packet format. The module exists precisely to stop that: *"Keeping those
questions separate lets KSX recognize useful hardware from public identity
evidence without silently borrowing another board's packet format."* The one
profile in the tree carries its own provenance in a field —
`firmware_detail: "Measured KSX I-PAC 4 release-0056 profile matched USB
bcdDevice 0x0056; firmware was not queried from the board."` Match that standard
or add nothing.

`panel_catalog` is `pub(crate)`. Nothing outside `ksx-backend` can reach these
tables, which is why the role arrives at every surface as `BoardRole` and never
as a VID/PID a page matched itself.

### Step 3 — know what `panel-encoder` currently buys, before you choose it

Promoting a board to `panel-encoder` today does two visible things, and the
second one is a caveat with nothing behind it yet.

`ksx-studio`'s `snapshot.rs` groups the roster three ways — `PanelEncoder` into
the encoder list, then `looks_like_a_keyboard` into the keyboard list, then
everything else into a fold headed *"Not keyboards — experimental"*. The unknown
device is **kept and shown**, which is the behaviour the decision requires; the
only thing that would change under the rule as written is the word
*experimental*, which reads as a judgement where *unverified* would be a
statement of what ksx knows.

It also changes the board's verdict line to `Connected · outputs not checked`.
The comment justifying that string still says *"The chart read in I-PAC Setup
owns that answer"* — and I-PAC Setup was extracted on 2026-08-25. So the
sentence promises a check no surface can currently perform. Under the decision
that is the correct posture for a programmable board (ksx cannot vouch for the
chart yet), but say it as something ksx does not know rather than as something
it is about to look up.

For the same reason: `PanelDriverCapabilities` (`can_identify`,
`can_report_mode`, `can_read_chart`, `can_write_chart`, `write_is_persistent`)
is still serialized on the wire and still set to `true` for the one measured
I-PAC 4 profile. **`can_read_chart` is now honoured** — `device_scan.rs` reads
it to serve `BoardRow.chart_readable`, which is what decides whether a surface
offers a read at all — but `can_write_chart` and `write_is_persistent` are still
branched on by nothing outside test assertions, and now never will be: ksx reads
encoder hardware and does not write to it (`ENHANCEMENTS.md` E10). Treat those
two as an unbacked published claim, and do not add a sixth capability field
expecting something to honour it.

### Step 4 — a capture backend, and when you genuinely need one

Only when the device is **not** a HID keyboard interface: a gamepad source, a
serial encoder, a network feed, a recorded file. An ordinary USB or Bluetooth
keyboard needs none of this — Interception and WinUSB already reach it.

The seam is `CaptureBackend` in `crates/ksx-capture/src/backend.rs`: five
methods, object-safe, `Send`, with a compile-time proof of object safety at the
bottom of the file. `crates/ksx-capture/src/mock.rs` and `replay.rs` are the two
implementations that touch no hardware and are the ones to read first.

What the trait will not let you skip:

- **`escapes()` has no default, deliberately.** *"Escape detection is the
  lockout escape hatch, so a new backend has to state what it does about it
  rather than silently inheriting 'never fires'."* A backend that cannot see
  strokes returns a fresh `EscapeHandle` — and then must not set a class filter
  either.
- **Start in passthrough.** Nothing is suppressed until the first
  `CaptureCtl::SetCaptured` arrives. This machine's keyboards are production
  hardware.
- **Crash-only.** Panic or normal exit both reset any OS-level filter through a
  Drop guard before the thread dies, and process death must need no cleanup.
- **The hot path allocates nothing and locks nothing.** Receive, evaluate
  escapes, decide pass/suppress from an arc-swap snapshot, re-send what must
  pass byte-for-byte, `try_send` into a bounded channel with drops counted.
- `presence()` defaults to `PresenceHandle::unsupported()` — a backend with no
  hotplug visibility reports `None` forever and supervisors degrade to never
  invalidating a slot, which is safer than guessing.

Several backends can add up to one session: `CompositeBackend` hands them shared
`Handles` so health and the escape latch merge instead of becoming three.

### Step 5 — which lane, and how to iterate without disturbing 4460

**Do the whole first pass with no hardware.** The seeded fixture carries its own
device roster: `crates/ksx-studio/examples/macro_fixture.rs` builds a
`DeviceScanView` with four `BoardRow` literals — an `Ultimarc I-PAC 4` with
`role: BoardRole::PanelEncoder`, a Bluetooth `Logitech G915 TKL`, an
`AURA LED Controller` that is pickable HID but `looks_like_a_keyboard: false`,
and a composite pointing device with no keyboard interface at all. Add a fifth
row for the device you are adding and every downstream decision — grouping,
verdict wording, pick, alias — is exercised on 4476 with nothing plugged in.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/watch.ps1 -Environment seeded
```

**4460 is the only lane that sees the real board**, because it is the only lane
reading the real USB inventory. Two rules for using it:

- If a session may be running, use `-Once` rather than a resident watcher. The
  launcher proves the daemon is stopped before replacing anything, and a running
  game becomes a visible deferred state rather than a surprise restart.
- Editing `tools/studio-env/*.ps1` marks **every** lane stale, not just the one
  you are working on: those files are inputs to the `Runtime` source graph in
  `tools/studio-env/source-graph.ps1`, alongside the whole `crates` tree. Doc
  edits under `docs/` are not in any graph and cost nothing.

Expect a *pure Rust* edit to rebuild the Studio assets as well, and do not read
that as a mistake. `source-graph.ps1` defines a third graph beside `Studio` and
`Runtime` — `ZoneProducers` — which is the entire `crates` tree, because an
`--ignored` Rust test is what emits `studio-ui/tokens/zones.json`. The watcher
decides whether to run `build-assets.ps1` by asking whether the recorded asset
receipt is current for the Studio **and** the ZoneProducer fingerprints, so
touching `panel_catalog.rs` invalidates the receipt and regenerates assets on
the way to the executable. That is also why the `rmSync` recovery above is
reachable from a change that never went near `studio-ui/`.

### Step 6 — the gates that must go green

In order, cheapest first:

1. **`panel_catalog`'s own two tests.**
   `family_and_profile_keys_are_unique_and_profiles_name_a_family` fails a
   duplicate VID/PID, a duplicate family id, a profile naming a family that does
   not exist, and a profile claiming `can_write_chart` without
   `can_read_chart`/`write_is_persistent`.
   `recognition_never_borrows_the_only_measured_protocol_profile` is the one
   that matters: it asserts that every *other* family, handed the I-PAC 4's
   measured `bcdDevice`, still resolves to **no** profile. A new family row is
   covered by it only if you add the pair to its list — do that.
2. **`device_scan`'s role tests.**
   `exact_catalogued_ipac_family_is_a_panel_encoder_not_a_keyboard` and
   `recognition_only_catalog_family_gets_the_encoder_role_without_a_chart_driver`
   are the copy-and-adapt targets: each builds a synthetic `DevicesView`,
   asserts the new board's role, asserts that an ordinary Logitech keyboard
   beside it stays `BoardRole::Keyboard`, and — for the encoder — asserts
   `looks_like_a_keyboard` is still true, because keyboard mode remains true.
3. **The workspace gate** in `PLAYBOOK.md`. `panel_catalog` and `device_scan`
   are both `ksx-backend`, so `cargo test --workspace --exclude vigem-client`
   runs them.
4. **The feature matrix.** `ksx-studio` itself has no features and is always
   built by `--workspace`, but the module that hands it the device roster —
   `ksx-backend`'s `sources.rs`, which carries the `MachineSource` impl — is
   gated behind `any(studio, cabinet)`. The default build compiles none of it,
   so a `MachineSource` change is invisible to step 3. CI runs clippy over all
   four combinations for `ksx-app` *and* `ksx-backend`, then executes the
   `studio,cabinet` union, which is the one that enables every gated module at
   once. Do not run the four-way matrix locally; push and let CI do it.
5. **The two lines the workspace gate cannot reach, which you *should* run
   locally.**
   ```
   cargo test --workspace --exclude vigem-client --examples
   cargo test -p ksx-platform --lib --features hidmaestro-fake-host-tests
   ```
   Both are seconds on a warm target directory and neither touches hardware.
   The first exists because **`cargo test` builds example targets and then does
   not run them**: `--examples` is the flag that turns an example into a test
   binary. `crates/ksx-studio/examples/macro_fixture.rs` — the fixture the
   browser suite below launches — carries eight tests that the workspace gate
   never executed. The second enables `ksx-platform`'s
   `hidmaestro-fake-host-tests`, which adds three assertions about the fixed
   SDK-free child's session and privilege inheritance (259 → 262); `--lib` is
   deliberate, because that crate's `live` and `wdi_provider` integration
   targets read the real device tree and the workspace gate already runs them.

   Both are also CI steps as of 2026-08-26. `PLAYBOOK.md` §4 carries the full
   measured table — 71 tests sat outside the local five — and the `ksx open`
   incident that is the argument for all of it: a shipping 404 with a green
   suite, because the file was behind `--features studio` and no local run
   compiled it.
6. **Studio assets plus the browser suite**, only if a rendered string changed:
   `tools/studio-env/build-assets.ps1`, then `cd studio-ui/pwtest && npm test`.
7. **Physical confirmation.** Nothing above proves recognition on real silicon.
   Plug the board in on 4460, run `ksx device scan --all`, and confirm the name,
   the role and the keyboard interface against what Windows reports. A green
   suite over synthetic `BoardRow` literals is evidence about the code, not
   about the hardware — that distinction is the whole of `GATES.md`.

### Step 7 — what not to build while doing this

**Do not rebuild hardware EPOCH reconciliation.** Nothing in `crates/` publishes
an epoch since the chart reader left; the only survivor is a `hardwareEpochs`
map in the Studio store that is written by the sanitizer and read by nothing.
The epoch returns later as an *exemption* that narrows the role rule — "keep
this one, I checked" — which is additive and needs the publisher to exist first.
Building it now is a lock with no key.

**Do not extract a second device in one pass.** The single-dump extraction is
what caused the damage this workflow is written in the aftermath of. One verb,
one device, one gate run.

## Clean CI and release promotion

Every branch and pull request runs `.github/workflows/ci.yml` on a clean
Windows runner. Superseded runs on the same branch are cancelled; release-tag
runs are never cancelled. The gate includes Rust format/lint/test matrices,
browser suites, deterministic Studio generation, PowerShell 5.1/7 environment
script parsing, a seed → verify → reseed → teardown fixture lifecycle, the
hardware-only output test's compile contract, HIDMaestro evidence, and a full
installer/portable build.

An ordinary branch run is integration evidence. It is not the file that will
later be published: packaging can be byte-different across two runs at the same
commit. Release promotion therefore uses this exact-bit sequence:

1. Merge the version commit to `main` and let its branch CI pass.
2. Push `v<major>.<minor>.<patch>` at the exact current `origin/main` HEAD.
3. The Release run executes the whole reusable CI and builds the candidate once.
4. Download `ksx-windows-installer`, `ksx-windows-portable`, and
   `ksx-windows-candidate-manifest` from that still-running Release workflow.
5. Verify the manifest hash, install that setup file, and run the supervised
   gates. Record the Release run id/attempt, manifest SHA, and installer SHA.
6. Approve the protected `production` environment only after the ledgers pass.
7. Publication downloads those same-run artifacts, rechecks every identity,
   filename, size, and SHA-256, uploads them into a private draft, verifies
   GitHub's digests, then publishes and confirms the release is immutable—all
   without rebuilding.

Reject a failed candidate. Release tags are immutable: fix the source,
increment the version, and cut a new candidate rather than deleting, moving,
or reusing the failed tag. Never substitute a local build or an ordinary
main-run artifact.

## Repository controls required before a release tag

- GitHub Environment `production` has at least one required reviewer and
  administrator bypass is disabled.
- Repository variable `KSX_PRODUCTION_APPROVAL_CONFIGURED` is exactly `true`.
  The workflow refuses publication without it, even if GitHub auto-created an
  unprotected environment.
- `main` blocks force-push and deletion and requires the CI checks named in the
  repository ruleset.
- Repository immutable releases lock the published tag and
  setup/ZIP/manifest assets and generate an attestation; Actions policy
  requires full-SHA action pins.
- The candidate's Gates ledger names its run id, manifest SHA, and installer
  SHA. A different hash is a different candidate.

The Release workflow runs `tools/release/assert-promotion-controls.ps1` before
candidate construction and again after installed QA approval. It verifies the
workflow-context approval sentinel, environment reviewer/no-bypass setting,
the `v*` **tag** deployment policy, main ruleset, required checks, and
immutable-tag ruleset. GitHub's built-in workflow token cannot API-read the
repository variable or administration endpoints and omits complete ruleset
bypass lists, so a maintainer also runs the administrative form before cutting
a release and after changing repository controls. That stronger audit verifies
the actual repository variable, every bypass list, immutable releases, and the
Actions full-SHA pin policy:

```powershell
tools/release/assert-promotion-controls.ps1 `
  -Repository Victor-Villacis/ksx `
  -ApprovalConfigured true `
  -RequireNoRulesetBypassActors `
  -RequireStudioPipelineChecks
```

That command requires the maintainer's authenticated `gh` session. It fails if
GitHub withholds the bypass list; it never turns missing visibility into a
successful audit. The workflow performs the independently useful structural
audit with its least-privileged built-in token, while GitHub itself enforces
the configured environment and rulesets.

These are release controls, not developer ceremony. Local branches remain
free to iterate; the boundary becomes strict only when bits can reach users.

### Required-check rollout order

Never require a new check before the default branch contains a job that emits
it, and never enable repository-wide action SHA enforcement while the default
branch still has version-tagged action references. For this pipeline's first
merge, `main` keeps enforcing its four existing checks and the SHA policy stays
off. Merge the workflow revision first, then activate `studio-browser`,
`studio-environments`, and full-SHA enforcement with the guarded maintainer
command:

```powershell
tools/release/activate-studio-promotion-checks.ps1 `
  -Repository Victor-Villacis/ksx `
  -Confirm:$false
```

The script reads every workflow from GitHub's actual default branch and refuses
the update until both jobs exist and every external action uses a 40-character
commit SHA. It preserves the no-bypass ruleset and then runs the full
administrative audit. This sequencing lets the pipeline branch merge without
making older concurrent agent branches impossible to merge.
