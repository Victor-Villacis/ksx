# How the code is laid out, and what is deliberately not tidy

Measured 26 August 2026 at v0.4.1. Numbers are raw line counts (`wc -l`) over
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

**The three device tables are three tables on purpose.** A tidy-up would merge
them; each merge would lose a different guarantee.
`crates/ksx-core/src/vendors.rs` maps a VID/PID to a *name* and returns only
`&str` — never a `bool`, because `is_ipac()` is the shape that invites a branch,
and three copies of exactly that branch once labelled a SpinTrak trackball
`[I-PAC]`. `crates/ksx-backend/src/panel_catalog.rs` then splits recognition
from capability twice over: `FAMILIES` recognizes an encoder from an exact
VID/PID and authorizes no report, while `PROFILES` admits one measured firmware
tuple and is the only thing allowed to advertise a chart read or a persistent
write. Seven families, one profile, and the gap between those two numbers is the
design working. `docs/DEVELOPMENT-PIPELINE.md`'s "Adding a new input device"
says which one a given change belongs in.

**Inline tests at roughly half a file are the house style.** `mapping.rs` is
2,173 lines of code and 2,366 of tests; `daemon/mod.rs` is 2,024 and 1,865.
That reads as bloat in a line count and is the opposite — the tests sit beside
the rules they pin. A cleanup that "shrinks the big files" would delete the
better half of them.

> **The measuring trap.** Keying the split on the first `#[cfg(test)]` in a
> file is wrong, and `render_map.rs` has now demonstrated it twice with two
> different mechanisms. It used to be a test-only *constant* near the top of
> the file. Today the first match at line 74 is not code at all — it is the
> string `` `#[cfg(test)]` `` inside a doc comment explaining why the zone
> generator is test-gated — so a naive first-match split reads the file as 73
> lines of code and 1,709 of tests. Its real `mod tests` is at line 1,618:
> **1,618 code, 164 tests**. Measure from `mod tests`.
>
> Note also that `render_map.rs` is the exception the house-style paragraph
> above does not cover. At 9% tests it is nothing like `mapping.rs`, because
> most of what it asserts is checked by the Studio HTTP and browser suites
> instead.

## The shape

| crate | lines | files | share |
|---|---:|---:|---:|
| ksx-backend | 72,753 | 60 | 38.8% |
| ksx-platform | 24,149 | 26 | 12.9% |
| ksx-studio | 18,996 | 22 | 10.1% |
| ksx-api | 14,605 | 11 | 7.8% |
| ksx-core | 13,028 | 19 | 6.9% |
| ksx-capture | 10,581 | 26 | 5.6% |
| everything else | 33,493 | 63 | 17.9% |

**Measured 2026-08-26 by the command below**; 187,605 lines across 227 files.
These are a snapshot, not a contract — nothing verifies them, and the previous
figures had drifted by a third before anyone noticed. Re-measure rather than
trust them:

```powershell
Get-ChildItem crates\*\src -Recurse -Filter *.rs |
  Group-Object { $_.FullName -replace '.*\\crates\\([^\\]+)\\.*', '$1' } |
  ForEach-Object { [pscustomobject]@{
    crate = $_.Name
    files = $_.Count
    lines = @($_.Group | Get-Content).Count } } |
  Sort-Object lines -Descending
```

> **Two ways this command has been wrong, both fixed above; check yours before
> quoting a number from it.**
>
> The regex lost its backslashes to a markdown paste, leaving
> `.*\crates\([^\]+)\.*`. `\c` is not a valid escape and `[^\]` is an
> unterminated class, so PowerShell threw `The regular expression pattern … is
> not valid` once per file and grouped nothing — while the paragraph above it
> claimed the table had been measured by it.
>
> The line counter was `Measure-Object -Line`, which **skips blank lines**. It
> is a defensible number, just not the one the header promises: it reports
> ksx-backend at 68,274 where `wc -l` reports 72,753, and the gap is 6% of the
> tree. `@(… | Get-Content).Count` matches `wc -l` exactly on all sixteen
> crates. If you re-measure with a different tool, say which one.

Re-measured the *old* way — `Measure-Object -Line`, so the comparison is
like-for-like with the table this replaces — only two rows have moved at all
since the previous count. `ksx-backend` grew by 2 lines. `ksx-studio` went from
34,507 to 18,096 across 32 files down to 22: **10 files and 48% of the crate**,
which is the whole story of the 2026-08-25 single-page cutover. Every other row,
including `everything else` at 31,293, comes back identical. The table above is
therefore not evidence of general drift; it is one deletion plus a change of
counting tool.

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

**Where that left the tree after the single-page cutover (measured 2026-08-26).**
Five of those modules were deleted with their pages and their verbs moved onto
one:

```
server/mod.rs      782   AppState, the router, flash_of, act, urlencode
server/nocturne.rs 3235  the product page: reads plus ~40 verbs
server/devices.rs   315
server/pads.rs      204
server/check.rs      81
server/session.rs     4  ← a doc comment and nothing else
```

Two things in that listing are worth reading as findings rather than as sizes.

`server/nocturne.rs` at 3,235 lines is **76% of the way back** to the
4,241-line file this split existed to break up, and the rate is the finding, not
the size. `git` puts it at 2,576 → 2,599 → 2,744 (the cutover commit) → 2,792 →
2,856 → 3,235 over six commits, the last of which added 379 lines by itself.
Nothing objects at any step, because there is no longer a boundary for a step to
cross. The split's premise was that a module boundary per page keeps handlers
from growing two opinions about the same thing; with one page, that boundary is
gone and nothing has replaced it. Whether it needs to be re-cut along some other
seam — by verb family, say — is an open question, and the honest answer today is
that nobody has decided.

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
