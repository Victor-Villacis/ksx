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
| ksx-backend | 55,433 | 52 | 35% |
| ksx-studio | 24,578 | 15 | 15% |
| ksx-platform | 18,483 | 23 | 12% |
| ksx-core | 11,666 | 18 | 7% |
| ksx-api | 11,644 | 11 | 7% |
| ksx-capture | 10,443 | 26 | 7% |
| everything else | 27,599 | 44 | 17% |

`ksx-backend` being a third of the codebase is partly by design — it holds the
logic so the surfaces can stay thin, and that trade is *why* the boundary
above holds. But 52 files is where a convention has to carry the weight, which
is what the suffix rule in `CLAUDE.md` now exists to do.

## Done in this pass

**`server.rs` split by page.** It carried 72 routes and 62 handlers in 4,241
lines — the size at which two handlers quietly grow two different opinions
about the same thing. Now one module per page, mirroring `render_*.rs`:

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
