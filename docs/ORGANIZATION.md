# How the code is laid out, and what is deliberately not tidy

Measured 12 August 2026 at v0.3.1. Numbers are `wc -l` over
`crates/*/src/**.rs`; the code/test split is measured from each file's own
`mod tests` line, not from its first `#[cfg(test)]` — see the trap below.

A readable version of this audit is published as an artifact; this file is the
one that shows up in diffs when the numbers move.

## Verified sound — do not "fix" these

**The surface boundary holds.** `ksx-studio` and `ksx-cabinet` depend on
**only** `ksx-api` at runtime. That is the rule keeping a browser page from
reaching into capture, output or a live session, and it is the expensive one to
lose. Checked by parsing `[dependencies]` separately from
`[dev-dependencies]` in each `Cargo.toml`: `ksx-core` and `ksx-config` appear
only in the latter, test-only, and say so in a comment.

**Inline tests at roughly half a file are the house style.** `mapping.rs` is
2,124 lines of code and 2,196 of tests; `daemon/mod.rs` is 1,716 and 1,612.
That reads as bloat in a line count and is the opposite — the tests sit beside
the rules they pin. A cleanup that "shrinks the big files" would delete the
better half of them.

> **The measuring trap.** Keying the split on the first `#[cfg(test)]` in a
> file is wrong: in `render_map.rs` that is a test-only *constant* on line 99,
> which makes the file look like 98 lines of code and 6,223 of tests. It is
> 3,198 and 3,123. Measure from `mod tests`.

## The shape

| crate | lines | files | share |
|---|---:|---:|---:|
| ksx-backend | 68,272 | 60 | 35% |
| ksx-studio | 34,507 | 32 | 18% |
| ksx-platform | 22,625 | 26 | 12% |
| ksx-api | 13,799 | 11 | 7% |
| ksx-core | 12,236 | 19 | 6% |
| ksx-capture | 9,716 | 26 | 5% |
| everything else | 31,293 | 63 | 16% |

**Measured 2026-08-25 by the command below**; 192,448 lines total. These are a snapshot, not a
contract — nothing verifies them, and the previous figures had drifted by a
third before anyone noticed. Re-measure rather than trust them:

```powershell
Get-ChildItem crates\*\src -Recurse -Filter *.rs |
  Group-Object { $_.FullName -replace '.*\crates\([^\]+)\.*','$1' } |
  ForEach-Object { [pscustomobject]@{
    crate = $_.Name
    files = $_.Count
    lines = ($_.Group | Get-Content | Measure-Object -Line).Lines } } |
  Sort-Object lines -Descending
```

`ksx-backend` being a third of the codebase is partly by design — it holds the
logic so the surfaces can stay thin, and that trade is *why* the boundary
above holds. But 60 files is where a convention has to carry the weight, which
is what the suffix rule in `CLAUDE.md` now exists to do.

## Done in this pass

**`server.rs` split by page.** It carried 72 routes and 62 handlers in 4,241
lines — the size at which two handlers quietly grow two different opinions
about the same thing. It became one module per page, mirroring `render_*.rs`:

```
server/mod.rs      838   AppState, the router, flash_of, act, urlencode, session verbs
server/map.rs     1090
server/start.rs    958
server/setup.rs    429
server/profiles.rs 410
server/devices.rs  217
server/pads.rs     200
server/status.rs   101
server/check.rs     79
server/session.rs   78
```

Every item moved verbatim. No route changed, no test changed, and the 89 HTTP
integration tests pass unmodified — which is the evidence that it was a move
and not a rewrite.

**Where that left the tree after the single-page cutover (measured 2026-08-25).**
Five of those modules were deleted with their pages and their verbs moved onto
one:

```
server/mod.rs      796   AppState, the router, flash_of, act, urlencode
server/nocturne.rs 2856  the product page: reads plus ~40 verbs
server/devices.rs   315
server/pads.rs      204
server/check.rs      81
server/session.rs     4  ← a doc comment and nothing else
```

Two things in that listing are worth reading as findings rather than as sizes.

`server/nocturne.rs` at 2,856 lines is more than a third of the way back to the
4,241-line file this split existed to break up, and it got there in one commit.
The split's premise was that a module boundary per page keeps handlers from
growing two opinions about the same thing; with one page, that boundary is gone
and nothing has replaced it. Whether it needs to be re-cut along some other seam
— by verb family, say — is an open question, and the honest answer today is that
nobody has decided.

`server/session.rs` is four lines: a module doc comment reading *"The session
JSON verbs: start, stop and resume"* over an empty file. Those verbs are on
`/nocturne` now (`play`, `stop`) except `resume`, which has no Studio caller at
all (`SURFACES.md` §3, the Resume row in `CONTROL-SURFACE.md`).

**The `render_*.rs` mirror no longer holds either, and it is the more
interesting half.** `render_map.rs` is still 1,782 lines and `render_check.rs`,
`render_pads.rs` and `render_devices.rs` are 1,001 / 1,094 / 1,732 — but there
is no `server/map.rs` for `render_map.rs` to mirror. The renderers outlived the
page modules because a renderer is about a VIEW and a server module was about a
URL, and only the URLs were merged. `render_nocturne.rs` (1,359) is the new
product page's renderer and sits beside `render_map.rs` rather than replacing
it: the mapper's server-side rendering is still its own file, still cited by
`crates/ksx-app/tests/docs.rs`, and still the thing that makes the no-JS mapper
work.

**Orphaned WinUSB certificates now have a narrow cleaner.** The read-only
machine view classifies KSX certificates against the signer reported by every
installed KSX package. `ksx winusb sweep-certificates` reports without
elevation; `--yes` crosses the fixed installed-helper boundary and removes only
exact thumbprint/DER identities no package uses. An unattributed package or a
subject identity mismatch blocks the whole sweep. The command removes no
driver and changes no keyboard binding.

The split was done by script with a **hard coverage gate**: it refuses to write
anything unless every non-blank line of the original lands in exactly one
output file. That gate earned its place immediately. The first attempt dropped
40 lines — the body of `api_preset_restore` — because its doc comment contains
`{ok, message}`, and the parser counted that brace as the start of the function
body. A split that silently loses code is worse than no split.

## Left large on purpose

`ksx-platform/src/winusb_transaction.rs`, 3,809 lines of code. It is one
transaction with one lock and one journal, and its guards refuse in each
other's terms — the DER check, the thumbprint check and the private-key check
are one argument, not three. Splitting it would put that argument in three
files.

## Known and not fixed

- **Five settings no surface can reach**: `block_mice`, `mouse_move_deadzone`,
  `starting_user_index`, `slot.mouse`, and the per-slot `macros` switch. Held
  in `CONFIG_SURFACES` in `crates/ksx-app/tests/parity.rs`, which asserts the
  set has not grown. `starting_user_index` is the one to do first: it decides
  which XInput slot player 1 lands on.
- **§3 cell cross-references are never validated.** `classify` reads only the
  first word of a cell, so `**primary** (§3a)` passes with the parenthetical
  unchecked — and the pads row points at §3a, which is about WinUSB.
- **`native_fixture_drives_all_four_pads` is flaky on CI**, never locally.
  Three hypotheses are recorded as dead in the task notes; the contradiction
  that remains is that every event reached the engine, nothing was coalesced or
  dropped, and the live engine still emitted half the deltas.
