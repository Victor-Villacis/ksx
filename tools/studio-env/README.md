# `tools/studio-env` — the lane scripts

Written 2026-08-26. Nine scripts: five you run, three that are libraries, and
one that builds the front end. This file says which is which, because the
directory previously said nothing and `Get-Help` returned only a `param` block.

The contracts live elsewhere and this file does not restate them:
`docs/DEVELOPMENT-PIPELINE.md` owns the promotion lanes and the daily loop;
`docs/STUDIO-ENVIRONMENTS.md` owns the ports, the provenance banners and the
process-safety rules.

## The five you run

| script | owns | one-line job |
|---|---|---|
| `watch.ps1` | one lane | resident supervisor: rebuild on save, restart what died |
| `start-real.ps1` | 4460 only | build and start the real-hardware lane once |
| `seed.ps1` | 4476, 4520 | build and start a disposable fixture lane once |
| `teardown.ps1` | any lane | **stop** a lane — the thing `Ctrl+C` does not do |
| `status.ps1` | reads all | what is running, is it healthy, is it current |

`build-assets.ps1` is the sixth: the lock-owning wrapper around
`studio-ui/build.mjs`. Never call `node build.mjs` directly in a shared
checkout.

`build-graph.ps1`, `source-graph.ps1` and `runtime-probe.ps1` are dot-sourced
libraries. They are not entry points and take no arguments; their file headers
explain what they guard, and the header in `status.ps1`'s environment table is
worth reading before adding a lane.

## Start, iterate, stop

```powershell
# Start a watched lane. `real` is the default and the normal hardware loop.
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/watch.ps1 -Environment real
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/watch.ps1 -Environment seeded
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/watch.ps1 -Environment first-run

# One deterministic refresh, no resident watcher. Use this when a session may
# be running: the launcher proves the daemon is stopped before replacing
# anything, and a running game becomes a visible deferred state.
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/watch.ps1 -Environment real -Once

# Look, without changing anything.
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/status.ps1

# STOP. Ctrl+C stops the watcher and deliberately leaves the lane running.
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/teardown.ps1 -Environment real
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/teardown.ps1 -All
```

The `Ctrl+C` asymmetry is a design choice, not an oversight: the watcher is a
supervisor over a process it did not have to own, so killing the supervisor must
not kill a healthy artifact somebody is looking at. Teardown is the verb that
ends a lane, and it validates each exact recorded process generation before
stopping anything — it will not kill an unrecorded process merely because that
process owns a known port.

## Rules that are enforced in code, and are written here anyway

**Never seed onto 4460.** It is the only lane wired to the real USB inventory,
the real `%APPDATA%\ksx`, the real backups and a physical encoder. `seed.ps1`
accepts only `seeded|first-run` and refuses a second time if a definition's port
is 4460 or one of the ten test ports; `start-real.ps1` holds the complementary
reserved list. Both refusals say *"Correct the environment roster instead of
starting it"* — the guard is deliberately not a silent fallback.

**The ten test ports belong to Playwright.** 4478, 4479, 4488–4490, 4496, 4500,
4510–4512. `status.ps1` lists them so a stray process is visible, not so a
person starts one.

**`-SkipBuild` does not exist for 4460.** `start-real.ps1` throws on it by
design: the disposable runtime must be rebuilt so it is guaranteed to carry the
current machine-lifecycle safety fences. Fixtures may skip a build; real
hardware may not.

**One build at a time, machine-wide.** `Global\KSXStudioBuildGraph-v1` covers
the Node asset build and the Cargo build together, because Studio embeds
`crates/ksx-studio/assets` at compile time and they are one graph even though
they are two processes. Per-lane transitions take
`Global\KSXStudioEnvironment-<lane>-transition` on top of that.

## Two failures that are not your change

**A failed or interrupted asset build leaves 24 tracked files deleted.**
`studio-ui/build.mjs` `rmSync`s `crates/ksx-studio/assets/` before it emits
anything. If the generator dies in that window the checkout is missing tracked
files and the `assets.dirty` sentinel correctly refuses every launcher.
Recover, then rebuild:

```powershell
git checkout -- crates/ksx-studio/assets/
powershell -NoProfile -ExecutionPolicy Bypass -File tools/studio-env/build-assets.ps1
```

This is reachable from a pure-Rust edit. `source-graph.ps1` defines a
`ZoneProducers` graph that is the whole `crates` tree — an `--ignored` Rust test
emits `studio-ui/tokens/zones.json` — so any change under `crates/`
invalidates the asset receipt and re-runs the generator.

**`STATUS_ACCESS_VIOLATION` (0xc0000005) from a compiler is this machine.**
`rustc` dying as a process, rather than reporting an error, under peak memory
load is a known property of this hardware. Retry once before concluding
anything about the tree.

## Editing these scripts

`tools/studio-env/*.ps1` are inputs to the `Runtime` source graph, so editing
one marks **every** lane stale, not only the one you are working on. Check
`status.ps1` for a running watcher before you start — a resident watcher will
rebuild and swap on your save. Editing this README costs nothing: only `.ps1`
files in this directory are in the graph.

CI parses every script under both PowerShell 5.1 and 7
(`.github/workflows/ci.yml`), so a construct that only parses on one host fails
the branch.
