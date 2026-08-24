# Development and delivery pipeline

Last verified: **2026-08-24 14:52 EDT**. This is the operational contract for
agents and people changing KSX. It complements `STUDIO-ENVIRONMENTS.md`, which
owns the localhost ports and process-safety details.

KSX is a Windows desktop/hardware product, so its promotion lanes are artifacts
and machines rather than four permanently deployed web servers. The equivalent
of a SaaS dev → stage → QA → production flow is:

| Lane | What runs | State/hardware | Restart or promotion rule | Evidence |
|---|---|---|---|---|
| **DEV · SYNTHETIC** | Current source on 4476, 4520, or 4521 | Disposable fixtures only | Watched rebuild/reseed | Exact fixture id, process generation, healthy status |
| **DEV BUILD · REAL HARDWARE** | Matched local daemon + Studio on 4460 | Real `%APPDATA%\ksx`, USB devices, and I-PAC | Watched rebuild; swap only while Play is stopped and no panel transaction owns the hardware lease | Executable hash, source/asset graph hashes, exact PIDs/pipes, real banner |
| **CI CANDIDATE** | Clean Windows runner | No physical cabinet | Every branch/PR runs the full matrix and produces immutable artifacts | Commit, run id, installer/ZIP hashes, candidate manifest |
| **INSTALLED QA** | Exact tag-run installer | A real Windows machine and cabinet | Human installs and exercises the candidate while publication waits | Candidate manifest hash plus Gates 1–4 ledger bound to the installer SHA |
| **PRODUCTION** | The approved tag-run files | Customer machines | A required reviewer releases the exact QA-tested files; there is no rebuild | Same run id, names, sizes, and SHA-256 values on the GitHub Release |

Do not call a lane “stage”: KSX already uses *staged setup* for an unsaved
controller configuration. `CI CANDIDATE` is the product-delivery equivalent.

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
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/watch.ps1 -Environment blank-encoder
```

The watcher debounces an editor save, fingerprints file contents as the source
of truth, orders Studio generation before Cargo, and runs one build at a time.
It also reconciles process health: if a managed fixture or Studio process dies,
the same proven graph is restarted without requiring a fake source edit.
Transient save/rename observation errors are retried without touching the
running process. A permanent compile/generation failure is attempted once for
that exact content graph and then waits for another edit; hardware/session and
machine-lock deferrals keep retrying because the source itself is not broken.
On 4460 the launcher acquires the I-PAC/Play transition lease and proves the
daemon is stopped before replacing anything; a running game or hardware write
becomes a visible deferred state. `Ctrl+C` stops only the watcher. Refresh the
browser after a healthy replacement.

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
