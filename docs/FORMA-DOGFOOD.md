# Forma dogfood ledger

ksx Studio is the first production consumer of Forma on Windows (E7's
deliberate bet). Every real-world finding lands here with its status, so
nothing discovered in the trenches evaporates. Rule: a finding is either
FIXED-ADOPTED, an OPEN ASK (waiting on upstream), or OURS-TO-SEND (we owe
upstream the report/PR).

**Version in use** (2026-08-09, re-checked 2026-08-26 and UNCHANGED):
`@getforma/compiler` 0.3.1, `@getforma/build` 0.2.0 and `@getforma/core` 2.0.0,
all consumed as published registry artifacts pinned by
`studio-ui/package-lock.json`; a clean `npm ci` needs no sibling Forma checkout.
The Rust crates `forma-ir`/`forma-server` are 0.2.0. Core 2.0.0 and
forma-server 0.2.0 close the two halves of #13, so both local workarounds have
been retired.

The re-check matters because of what landed on 2026-08-26. The `/nocturne`
cutover (2026-08-25) and the two days of fixes after it reproduced #22, put
#20(b) back on a shipping page, and turned up #23 — and **not one of them is a
regression**. The pinned versions did not move. They are the SAME compiler
behaving the SAME way, on a page this ledger had never mentioned, hit by an
author who did not know the entries existed. That is the argument for the asks
below: a residue nobody can see is a residue everybody re-finds.

**Upstream repo map** (file bugs here; verified 2026-08-05):
- `@getforma/compiler`, `@getforma/build` -> github.com/getforma-dev/forma-tools
- `@getforma/core` (FormaJS runtime) -> github.com/getforma-dev/formajs
- `forma-server` / `forma-ir` (Rust crates, 0.2.0) -> github.com/getforma-dev/forma
- `@getforma/create-app` -> github.com/getforma-dev/create-forma-app
- kmd (docs dashboard; not implicated in any finding) -> github.com/getforma-dev/kmd

| # | Finding | Status | Where |
|---|---------|--------|-------|
| 1 | `@getforma/build` tailwind step spawned `npx` via `execFileSync` without `shell:true` → ENOENT on Windows (`npx` is `npx.cmd`) | **FIXED upstream** (build 0.1.9, 2026-08-05) — adopted same day; we still use plain-CSS entries by choice | `studio-ui/build.mjs` note |
| 2 | Compiler named every `createList` slot literally `list:array` — multi-list pages could not inject by name; we shipped a positional workaround | **FIXED upstream** (compiler 0.2.0, 2026-08-05) — adopted, workaround deleted | `crates/ksx-studio/src/render.rs` history note |
| 3 | 0.2.0's list names are document-order indexed (`list:#N:array`), not binding-derived (`list:<source>:array`) as the release notes suggested — reordering lists in the page still shifts names | **MOSTLY RESOLVED for us (v4, 2026-08-05)**: binding-derived names DO exist when the list source is a derivable binding — `() => padTiles()` compiles to `list:padTiles:array` (occurrence-suffixed `#N` on reuse); v4's signal-backed lists get named slots for free. **Narrowed 2026-08-26 by reading the shipped 0.3.1**: the fallback is `deriveBindingName(source) ?? (paramName !== "_" ? paramName : null)` (`index.js:3141`), so `createList(() => [], (row) => …)` is named `list:row:array` from the MAP PARAMETER and positional `#N` happens only when that parameter is literally `_`. Residual ask restated against that. And binding-derived naming does **not** imply one-binding-one-slot — see **#23** | `render.rs` seam constants doc |
| 4 | `createShow` slots were all named `show:createShow` — Bool show/hide state could not be injected by name; a SHOW_ORDER positional seam (17 status + 19 mapper entries) was the workaround | **FIXED upstream** (compiler 0.3.1, 2026-08-06) — **ADOPTED same day**: slots are named after the condition getter (`show:canStart`), `show_values()` yields `(name, bool)` pairs, both `*_SHOW_ORDER` arrays deleted, and the layout tests now assert the NAME SET instead of a count | `render.rs` / `render_map.rs` `show_values` |
| 5 | Plain hydration clobbers server-rendered values: `adoptNode` binds text to client signal state (first effect run overwrites SSR text with signal defaults) and list adoption removes SSR rows absent from the client array. The sanctioned path is the islands protocol (`data-forma-props` initializing signals BEFORE adoption) — discoverable only by reading `@getforma/core` internals | **ADOPTED in production (v4, 2026-08-05)**: Studio is now one island whose signals seed from props before adoption, then a 2 s `/api/status` poller — live updates, zero clobber. The docs ask ("SSR with server data" recipe) is still **OURS-TO-SEND** | `render.rs` module docs; `studio-ui/src/status.ts` |
| 6 | `create-forma-app` dashboard template binds `0.0.0.0` with no auth and no warning (its own sibling, the minimal template, computes a CSP then discards it — earlier E7 finding) | **OURS-TO-SEND**: security nudge — default to `127.0.0.1`, make LAN opt-in | E7; canon study |
| 7 | Good news worth telling upstream: FMIR format v2 held across five months of npm-side drift (core 1.5.0 vs Rust crates 0.1.4) — the binary contract is stable; `AssetManifest` deserialized byte-for-byte | evidence for a compat-guarantee doc | `docs/research/forma-spike-1-fmir-compat.md` |
| 8 | Compiler 0.2.0 registered every island with EMPTY `slot_ids`, so `forma-ir`'s walker — fully wired to emit `data-forma-props` from `build_island_props(slot_ids)` — never fired; server-side island props needed a hand-emitted `__forma_islands` script block | **FIXED upstream** (compiler 0.3.1, 2026-08-06) — **ADOPTED same day**: 45 slot_ids on `/`, 186 on `/map`; `island_props_json` and the `__forma_islands` impersonation are deleted and the tripwire now asserts `!slot_ids.is_empty()` PLUS that every server-injected slot is in there. What it does NOT solve is in **#19** | `render.rs` `payload_json` / layout tests |
| 9 | Signal slot-table extraction read ONLY the root `*Page` component function, so signals declared in island files got anonymous `text:N` slots. Forced the twin-file split: `*Page.ts` re-declared every signal purely to mint slots while `*Island.ts` owned the runtime copies | **FIXED upstream** (compiler 0.3.1 walk-driven signal scopes, 2026-08-06) — **ADOPTED same day**: 29 twins deleted from StatusPage.ts, 67 from MapPage.ts; both files are now four lines plus (for MapPage) the #17 const tables. After 0.3.1 the twins were actively HARMFUL — see the adoption note below. **Hardened the same day**: a resurrected twin passed the entire 97-test gate, so the guard is no longer the build log — `build.mjs` throws on the collision and `assert_island_slot_contract` requires every injected name to be one the ISLAND RENDERS | `StatusPage.ts`, `MapPage.ts`, `render.rs` `assert_island_slot_contract` |
| 10 | An identifier as a static attr value (`d: SIL_BODY`, a module `const` string) compiled to an empty SOURCE_CLIENT slot — SSR rendered the element with the attribute MISSING, no warning. Studio v1–v3 shipped pad silhouettes with no body path for four versions | **FIXED upstream** (compiler 0.3.1, 2026-08-06) — **VERIFIED HERE** with a throwaway probe: `h("path", { d: PROBE_D })` now folds the const into a static attribute (string table holds the literal, no slot, no island). Nothing in ksx still needs the inlining workaround; the vendored art replaced the silhouettes in v5 | probe recorded below |
| 11 | Good news, load-bearing for v5: **member-expression attribute values in `createList` item bodies compile to per-item dyn-attr slots** (`h("img", { src: p.art })`, `style: z.style`, `"data-fn": z.fn`) — SSR emits the attribute from the injected array, the client runtime re-derives it per item. The whole mapper zone layer (25 positioned buttons × style/class/data-fn/title) and the status tiles' per-persona art ride this; without it every zone would have needed its own named signal. Constraint held from #9's world: the member read must be a bare `param.field` (or `String(param.field)`) — computed/derived expressions still get anonymous slots | worth documenting upstream as a SUPPORTED pattern (it is compiler 0.2.0's `listItemBindings` path) | `MapIsland.ts` zone list; `render_map.rs` `zone_rows` |
| 12 | Two-route builds work end to end (entryPoints + routes + per-route `ssrEntryPoints`) — but the island BYPRODUCT cleanup (`*.islands.js`) had to be repeated **per entry**, and the second occurrence of a reused list binding gets the `#N` suffix across a page, not across the build | **HALF FIXED** (build 0.2.0 no longer emits the byproducts; scrub deleted 2026-08-06, replaced by a build-time assertion that they stay gone). The `#N`-is-per-page fact stands, and the twin-file half is void now that #9 is fixed. **The `#N` tail clause grew teeth on 2026-08-26** — it is not a naming curiosity, it is a silent second list with its own field set: see **#23** | `build.mjs`; `render_nocturne.rs` `list:nGameRows#2:array` |
| 13 | TWO core/server findings behind the mapper learn-flow bugs (2026-08-05): **(a)** forma-server's CSP nonce-locks `style-src`, and per spec a nonce there makes browsers ignore inline-style semantics — every `style=""` ATTRIBUTE dies, including the ones forma's own compiled list bindings emit (#11!): all 25 zone hit-areas collapsed into a 2 px pile at the stage's top-left (the "corrupted glyph"), and the countdown bar's width never moved. **(b)** `@getforma/core`'s ADOPTION-path show effect (`setupShowEffect` in hydrate.ts) materializes re-toggled branches inside its own `internalEffect` run with no `createRoot`/`untrack` — every binding created there is owned by that run and disposed on the next re-run: stale modal prompts on reopen, empty flash boxes, a conflict dialog that never renders (the reported frozen-modal repro). The runtime-path `createShow` already does it right | **FIXED upstream, ADOPTED 2026-08-09**: forma-server 0.2.0 adds `style-src-attr 'unsafe-inline'` while keeping `style-src` nonce-locked; core 2.0.0 creates adopted show branches under `createRoot` + `untrack`. `relax_style_src`, the bundle rewrite and both `__ksxShowBranch` installers are deleted; tests pin the upstream contracts | `crates/ksx-studio/src/server.rs` closure note/test; `studio-ui/build.mjs`; `map.ts`/`status.ts` closure notes |
| 14 | **CLOSED WITH #4** (2026-08-06); kept because the measurement is the argument that closed it. The `show:createShow` positional seam did not just risk drift — it **priced** UI work. The v6 pass added 6 shows to the mapper (18) and 1 to the status page (17); each one is a four-file edit (island tree, twin Page declaration, `*_SHOW_ORDER` label, boolean position in `show_values`) whose only guard is our own count assertion, and an insertion in the MIDDLE of the document silently shifts every show after it. Named show slots would make all four edits one. **v7 update**: the whole multi-select feature cost exactly ONE new show (19) — because it was APPENDED as the last element of the document rather than placed where it belongs visually (it is `position: fixed`, so it could be). That is the seam shaping the markup: a bar that renders at the bottom of the page is written at the bottom of the tree to avoid renumbering 15 booleans | reinforces the **OPEN ASK** in #4 with a cost measurement: 3 pages of seam is no longer hypothetical, and it now influences where elements are authored | `render_map.rs` MAP_SHOW_ORDER (19); `render.rs` SHOW_ORDER (17) |
| 15 | Good news, and the pattern that made the v6 mapper affordable: **a per-item member read can carry a whole interaction**, not just presentation. The legend's ✕ clear accelerator is `h("span", { class: "lclear", "data-clear": l.fn, title: l.cleartitle }, l.clear)` — a bare `param.field` per #11, so SSR emits it and the client re-derives it per poll, and `map.ts` reads `data-clear` by delegation. Empty string = CSS-hidden, which is how "only offer the ✕ where clearing does something" costs zero shows. Same trick disables controls: `cls` carries `z-dead`/`l-dead` instead of a `disabled` attribute (which would swallow the click that owes the user an explanation) | confirms #11's contract holds for interaction attrs too — worth including in the upstream ask | `MapIsland.ts` legend list; `render_map.rs` `legend_rows` |
| 16 | Ledger #13(b)'s patched show seam held under a much heavier load: the v6 mapper nests shows THREE deep inside a re-toggled branch (`modalOpen` → `modalListening` / `modalBound` / `modalConflict`) and re-toggles them dozens of times per session with no stale prompts or empty boxes. The `__ksxShowBranch` unowned-root rewrite is the reason; without it this design would have been unbuildable | **CLOSED with #13(b)**: this was the evidence for the fix now shipped by core 2.0.0; the local rewrite has been removed | `build.mjs` ledger-#13 closure note |
| 17 | Good news with a catch, and what made v9's no-JavaScript mapper buildable: **`...CONST.map((x) => h(…))` spreads are EXPANDED AT COMPILE TIME** into static markup (`extractFileConstants` → `emitSpreadChild` → `substituteProperties`), so a 122-option `<select>` can be authored once and rendered on all 25 legend rows without a nested list (which the item-body seam does not offer) and without 122 literals per select. Three constraints, all silent when broken: (a) the constants are read from the **root `*Page` file only** — the same blind spot as #9 — and from plain top-level `const` declarations, so `export const` is invisible (declare bare, `export { … }` separately, import back from the island: single-sourced, unlike the signals); (b) substitution reaches **children only, not attribute values** — `h("option", { value: x.k }, x.t)` compiles the text but leaves `value` as an EMPTY dyn-attr slot, i.e. `<option value="">` on every option, which for a form is silently wrong data rather than missing decoration (we render `h("option", null, x.k)` and lean on HTML's option-text-is-the-value rule); (c) an unexpandable spread falls back to an ISLAND placeholder — the tell is the build line, `24 islands` where the page has one | **EDGES 1 AND 2 FIXED upstream** (compiler 0.3.1, 2026-08-06 — verified here by probe): constants declared in an ISLAND file now expand, and member reads now substitute into ATTRIBUTE values, so `h("option", { value: x.k }, x.t)` finally emits the value. Edge 3 (an unexpandable spread degrades to an island placeholder with no warning) is still **OURS-TO-SEND**. ksx keeps the tables in MapPage.ts for now — they work, and moving 250 lines buys nothing | `studio-ui/src/MapPage.ts` key tables; `MapIsland.ts` legend row form |
| 18 | Good news, and the reason v16's diagonal grid cost nothing structurally: **a list can grow a NEW SIBLING list without touching the show seam at all.** The macro grid's group band is a fourth `createList` inside `.macscroll` (`list:macroGroups:array`), and because 0.2.0 names lists from their binding (#3), adding it in the middle of the document renamed nothing — the only edit was one constant and one line in the seam-order assertion, versus #14's four-file cost for a single `createShow`. It also confirms #11/#15 one more time under a 37-column grid: `{ class: g.cls }` spans the band by CLASS (`macgrp g9`) rather than an inline `grid-column`, which #13(a) would have eaten anyway | reinforces #4's ask by CONTRAST: named list slots are already what named show slots should be | `render_map.rs` `LIST_SLOT_MACRO_GROUPS`; `MapIsland.ts` `.macgrps` |
| 19 | **The gap native island props leave.** With #8 fixed, `data-forma-props` carries the RENDERED SLOT VALUES (`vigemLine`, `show:canStart`, `list:padTiles:array`). ksx's clients own a MODEL over the SOURCE payload — `map.ts` keeps `lastPayload` and derives conflicts, macro drafts, undo and the learn flow from it — and no slot carries that, so a data block is still needed. Second half: inline props are not optional and not small. The walker emits them whenever `slot_ids` is non-empty and the compiler always picks `propsMode=Inline`, so `/map` gained a **106 557-character** attribute on a 320 397-character page (33%) — an escaped duplicate of markup already on the page, which this app cannot use and cannot turn off | **(b) FIXED UPSTREAM, ADOPTED — verified by measurement 2026-08-12.** forma-ir 0.2.0 added `INLINE_PROPS_MAX_BYTES = 1024`: props whose JSON exceeds 1 KiB spill from the attribute into the shared `__forma_islands` block, and `loadIslandProps` already read the block as a fallback, so it needed no client change. **`/map` went from 320,397 bytes to 44,409** and carries NO `data-forma-props` at all. The 106,557-character attribute is gone. **(a) is still OURS-TO-SEND. Re-measured 2026-08-26 on the post-cutover pages** (all four routes, live daemon): the spill fix scales to 479 `slot_ids` and still emits no `data-forma-props` anywhere, but half (a)'s headline moved — `__ksx-payload` is **11.8% of `/nocturne`** and the dominant cost there is 570 KB of MARKUP, which is ksx's problem, not Forma's. `/devices` at 49.5% is the last page with the old shape | `render.rs` `PAYLOAD_SCRIPT_ID`; `nocturne.ts` `embeddedPayload()` |
| 21 | **The two derivations of every page have no gate.** #5's design emits the same data twice — SSR slots and `__ksx-payload` — so every sentence is derived once in Rust and once in TypeScript with nothing checking that they match. Verified drift: with a session RUNNING, `/map` painted `Use "Pause emulation & map" above` and hydration replaced it with `Use the Pause button above` — a visible flash whose surviving copy named a control that is not on the page | **OURS — FOUND AND FIXED 2026-08-06**: client wording corrected to the server's; `pwtest/ssr-hydration-parity.test.mjs` diffs SSR against post-hydration DOM on every served path across 3 session states — nine variants and 27 checks when written, **five and 15 since the 2026-08-25 cutover** (see the parity-check paragraph below for why fewer variants is not less coverage). Upstream half is #19's: a channel for server→island state would delete the second derivation | `NocturneIsland.ts`; `render_nocturne.rs` |
| 22 | The #20 fix folds a literal concatenation into an **anonymous slot's default** (`attr:title#2`, `text:0`) rather than into static markup the way a module const now does (#10) — so `/map` carried 5 extra slots, all inside the 106 KB props attribute, under positional names; and a concatenation with a non-literal operand still lands there with an EMPTY default, which is #20(a) unchanged | **STILL OURS-TO-SEND, and REPRODUCED on `/nocturne` 2026-08-26** by an author who had never read this entry: three `"literal " + "literal"` text children minted `text:0`/`text:0#2`/`text:0#3`, each default holding the whole folded sentence (101/196/137 bytes, read out of the committed IR). **The page rendered correctly** — the cost was 474 bytes of props on every response and a slot nobody could classify, not wrong output. Three corrections in the detail section: the names are NOT document-order, half the ask is already shipped for attributes, and the ask now has a line number (`index.js:2911–2924`). Splitting them by hand moved **464 bytes out of the slot table and 420 into the string table** — this entry's ask, performed at the call site and measured, with the file's whole −30-byte delta reconciling to the byte | `render_nocturne.rs` `nocturne_slots_are_classified_exactly`; `ANONYMOUS_SLOTS` in `render_check.rs`/`render_devices.rs`/`render_pads.rs` |
| 20 | Two string-concatenation defects, reported 2026-08-05 and fixed overnight. **(a) attribute position**: `title: "a" + "b"` compiled to an empty slot — the attribute was emitted **with no value at all**, silently. Both 360 motion buttons and the macro Enable switch shipped with no tooltip until a pwtest case read the titles back and found `null`. **(b) child position**: `h("span", null, "a" + "b")` was a BinaryExpression the h-tree walker could not fold, so it emitted an anonymous SECOND ISLAND — caught only because our layout test asserts "exactly one island" | **(a) FIXED upstream** (compiler 0.3.1) — ADOPTED 2026-08-06; **(b) SCOPED AND REOPENED 2026-08-26**: 0.3.1 fixed the child position only for a concatenation whose operands are ALL literals (and it fixes it into a slot, which is #22). **Any non-literal operand still emits the empty island shell**, unchanged — `h("summary", …, "Edit " + r.title + "…")` on `/nocturne` hit it exactly. The guard this row named — `concatenated_strings_render_in_attributes_and_children` — was deleted with `/map` in `fcf71d0` and does not exist anywhere in the tree; what caught the recurrence was `studio-ui/build.mjs`'s fatal-warning gate | `studio-ui/build.mjs:315-350` (the gate); `NocturneIsland.ts` |
| 23 | **A reused list binding is TWO lists, and the compiler says nothing.** Two `createList(() => nGameRows(), …)` calls on `/nocturne` mint `list:nGameRows:*` and `list:nGameRows#2:*` — **14 slots, every one `SOURCE_SERVER`** — and the member field sets are collected PER OCCURRENCE, so the second list's are `revision`/`path`/`arguments`/`slots`/`preset` and the two overlap only on `title`. Serve the unsuffixed name and the suffixed list renders ZERO ROWS server-side, filling only after adoption: a flash for everyone, permanently empty for a no-JS user. There is no build-time signal at all — the only tell is forma-ir's per-render `warn!` in the daemon log | **OURS-TO-SEND, and it is a three-line fix.** The compiler ALREADY warns for the identical collision on the signal path (`index.js:2118-2124`, *"is also declared in another scope on this page, so this one gets the slot name '…' — inject it under that exact name"*) and calls the SAME `uniqueName` for lists at `index.js:3142` in silence. Ask: warn when `base !== derivedName` — but in a sentence that names `createList` rather than reusing the signal one, because ksx's own gate matches that sentence and answers it with "delete the twin", the exact opposite of the fix. Strictly more urgent than the signal case — signal slots are `SOURCE_CLIENT` and render a default; list slots are `SOURCE_SERVER` and render nothing | `render_nocturne.rs` `LIST_SLOT_GAMES_EDIT` + `SERVED_LIST_PREFIXES`; `game_row` (the UNION of both field sets) |

## Details for filing — mechanism, upstream location, local repro

### #1 — build <=0.1.8: Windows tailwind ENOENT
**Upstream**: forma-tools -> `@getforma/build`, the tailwind cssEntries step.
**Error**: `spawnSync npx ENOENT` the moment a build has `tailwind: true`.
Root cause: `execFileSync("npx", ...)` without `shell: true`; on Windows
`npx` is `npx.cmd` (a cmd script, not a PE image), so CreateProcess cannot
exec it. **Repro**: any Windows box, any tailwind entry. **Fixed** in 0.1.9
(resolves local `@tailwindcss/cli`, runs it via node directly; npx fallback
shell-spawned with quoted args). Local note: `studio-ui/build.mjs`.

### #2 — compiler <=0.1.8: all list slots named `list:array`
**Upstream**: forma-tools -> compiler slot-table emission for `createList`.
**Error mode**: silent — with two lists on a page, name-keyed injection
(`SlotData::from_json`) addresses only "the" `list:array` slot; every other
list renders its compile-time default (usually empty). No warning anywhere.
**Repro**: page with two createLists, inject both by name, observe one
blank. **Fixed** in 0.2.0. History note: `crates/ksx-studio/src/render.rs`.

### #3 — compiler 0.2.0: literal-source lists still positional
**Upstream**: same emission path as #2. **Detail**: a derivable binding
source (`() => padTiles()`) earns `list:padTiles:array` (+`#N` on reuse);
a literal source (`() => []`) falls back to `list:#N:array` where N is
document order — reordering the page silently renames the slot and
injection misses. **Ask**: document both behaviors; stabler naming for
literals. Local guard: layout tests pin exact names (`render.rs`,
`render_map.rs`).

### #4 — compiler: every `createShow` slot was `show:createShow`
**FIXED upstream (compiler 0.3.1) and ADOPTED 2026-08-06.** Show slots are now
named after the condition binding, so the whole positional apparatus below is
history. Kept because #14 and #18 priced it, and that measurement is what made
the ask land. What replaced it: `show_values()` returns `[(slot name, bool)]`,
`build_slots` looks each name up, and the layout tests assert the NAME SET on
both sides plus "no name occurs twice".
**Upstream**: forma-tools -> show/Bool slot emission. **Error mode**:
silent — show/hide state cannot be injected by name at all; N shows on a
page = N identically-named slots. **Cost here**: 17 Bool slots on the
status page + 18 on the mapper after the v6 pass, all injected positionally
via SHOW_ORDER arrays that must mirror compile order exactly (drift = wrong
pills/panels showing, caught only by our pinning tests). **Ask**: mirror the
#2 fix for shows. Our single biggest remaining seam fragility — and #14
prices it: every new show is a FOUR-file edit, and inserting one in the middle
of the document shifts every show after it. Local: `render.rs` SHOW_ORDER,
`render_map.rs` MAP_SHOW_ORDER.

### #5 — core: plain hydration clobbers server-rendered values
**Upstream**: `@getforma/core` -> `mount()` -> `hydrateIsland()` ->
`adoptNode()`. **Mechanism** (from reading core internals):
`setHydrating(true)` makes `h()` return descriptors; `adoptNode` attaches
bindings to the SSR DOM without creating elements — but bindings attach to
CLIENT signal state: text bindings are
`internalEffect(() => textNode.data = String(child()))` whose FIRST run
overwrites SSR text with the signal default, and list adoption reads
`untrack(() => child.items())` then REMOVES SSR rows absent from the
client array (console: "removing extra SSR list item"). Net: any
server-data SSR page visibly reverts to defaults on mount. **Sanctioned
path** (undocumented): the islands protocol — props via `data-forma-props`
or the `__forma_islands` JSON script block -> `activateIslands` hands
props to the hydrate fn BEFORE adoption -> signals seed from server
values. **Ask**: document the recipe; ideally let hydrate() adopt DOM
state as initial signal values. Local: `studio-ui/src/status.ts`,
`render.rs` module docs.

### #6 — create-app templates: insecure defaults
**Upstream**: create-forma-app -> dashboard template `src/main.rs` (binds
`0.0.0.0`, no auth, no warning) and the minimal template (computes a CSP
then discards it). **Ask**: default `127.0.0.1`; LAN as explicit opt-in;
apply the computed CSP. Contrast: our `server.rs` refuses non-loopback
binds in code and test.

### #7 — FMIR v2 stability (good news)
Compiler (npm, Jul 2026) emits magic `FMIR` + u16 LE version `2`;
`forma-ir` 0.1.4 (Mar 2026) expects exactly `IR_VERSION: u16 = 2`. Parse,
`check_ir_compatibility`, `render_page`, `AssetManifest` all clean across
the five-month gap (`docs/research/forma-spike-1-fmir-compat.md`); our
build asserts the magic+version bytes on every regen. Worth a published
compat guarantee.

### #8 — compiler: islands registered with EMPTY slot_ids
**FIXED upstream (compiler 0.3.1) and ADOPTED 2026-08-06** — 45 slot_ids on
`/`, 186 on `/map`, and forma-ir's walker now emits `data-forma-props` itself.
`island_props_json` and the `__forma_islands` block are deleted. The tripwire
flipped exactly as designed and became the opposite assertion. Read **#19** for
what the fix does NOT cover.
**Upstream**: forma-tools -> compiler emits
`addIsland(name, trigger=load, propsMode=inline, [], offset)` — the
slot_ids array is ALWAYS empty. The downstream half already exists:
`forma-ir`'s walker is fully wired to emit `data-forma-props` from
`build_island_props(slot_ids)` — dead code in practice. **Consequence**:
server-side island props require hand-emitting the `__forma_islands`
script block (`loadIslandProps`' shared-props path; non-executing JSON,
CSP-exempt, needs `<`-escaping against breakout). **Ask**: populate
slot_ids from the island span. Local tripwire: our layout test asserts
`slot_ids.is_empty()` — a fixed compiler flips the test and we adopt the
native path. Local: `render.rs` `island_props_json`.

### #9 — compiler: signal extraction read only the root `*Page` fn
**FIXED upstream (compiler 0.3.1, walk-driven signal scopes) and ADOPTED
2026-08-06.** 29 twin declarations deleted from `StatusPage.ts`, 67 from
`MapPage.ts`; both are now an import plus `return <Island>()`. Note the sting
in the tail: after 0.3.1 the twins were not merely redundant, they were WRONG
— see the adoption-pass table above.
**Upstream**: forma-tools -> `extractSignalDefaults`. **Mechanism**: named
signal slots come ONLY from the root Page component's body; `createSignal`
in island component files -> anonymous `text:N` slots -> name-keyed
injection impossible where the signal naturally lives. **Cost**: the
twin-file pattern — StatusPage.ts/MapPage.ts re-declare 27/22 signals as
compile-time slot declarations while the Island files own runtime twins;
same names, two files, drift caught only by our tests. **Ask**: extract
from island files, or document a single-source pattern. Local:
`StatusPage.ts` header comment.

### #10 — compiler: identifier attr values silently dropped the attribute
**FIXED upstream (compiler 0.3.1), VERIFIED HERE 2026-08-06** by probe: a
module-level `const` string used as `h("path", { d: PROBE_D })` now folds into
a static attribute. ksx has no live workaround left for this one (v5 replaced
the silhouettes with vendored art), so nothing to revert — but the mechanism
below is still the best write-up of why it was the highest-severity finding in
this ledger.
**Upstream**: forma-tools -> static-attribute evaluation (`evalNode`,
which already folds `+` concatenations but not identifier references).
**Mechanism**: `h('path', { d: SIL_BODY })` with SIL_BODY a module const
string compiles to an empty SOURCE_CLIENT slot -> SSR renders the element
with the attribute MISSING. No build warning, no runtime error — silent
wrong output. **Real cost**: Studio v1-v3 shipped pad silhouettes whose
`<path>` had no `d` for four versions before the v4 canon study caught
it. Highest-severity report in this ledger. **Ask**: resolve module-level
consts or at minimum warn. History: `StatusIsland.ts` (v4).

### #11 — member-expression attrs in list items (supported-pattern ask)
**Upstream**: forma-tools -> compiler 0.2.0 `listItemBindings` path.
**Behavior** (good, load-bearing): bare `param.field` reads as attr values
inside createList item bodies (`style: z.style`, `"data-fn": z.fn`,
`src: p.art`) compile to per-item dyn-attr slots — SSR emits from the
injected array, client re-derives per item. The whole mapper zone layer
(25 buttons x 4 attrs) rides this. Constraint: BARE member reads only;
computed expressions get anonymous slots (#9's world). **Ask**: confirm as
contract, not accident. Local: `MapIsland.ts`, `render_map.rs` zone_rows.

### #12 — build: multi-route facts (docs note)
Two-route builds work (entryPoints + routes + per-route ssrEntryPoints); list
`#N` occurrence suffixes are per-page, not per-build. No bug — upstream docs
material. The island byproduct cleanup (`*.islands.js`, once needed PER ENTRY)
**stopped being necessary in build 0.2.0**: the files are not emitted at all.
The scrub came out on 2026-08-06 and left a one-line assertion in `build.mjs`
that fails the build if anything named `*.islands.*` reappears in the manifest
— cheaper than the scrub and louder than silence. Local: `build.mjs`.

### #13 — CSP kills style attributes; adopted shows dispose their branches
Diagnosed 2026-08-05 (Playwright repro against a mocked /api backend —
`learn-repro.mjs` / `conflict-repro.mjs` patterns; the daemon-side learn
state machine was verified INNOCENT: generations supersede correctly and a
second learn after a hit listens again, now pinned by
`a_second_learn_after_a_hit_listens_and_hits_again`).

**(a) forma-server CSP**: `PageOutput.csp` emits `style-src 'nonce-…'
'self'`. The CSP spec says a nonce/hash in a directive disables
`'unsafe-inline'` behavior — and inline `style=""` ATTRIBUTES can never
carry a nonce, so they are ALL dropped. But the compiler's own
`listItemBindings` path (#11) renders per-item `style:` attributes — the
mapper's entire zone geometry — and `MapIsland`'s countdown bar drives
`style: () => barStyle()`. Under the stock CSP the page quietly renders
every zone as a 2 px pile at the stage's top-left corner. **Ask**: either
stop nonce-locking style-src by default, or document that compiled style
bindings require `style-src 'unsafe-inline'`. Local fix:
`relax_style_src` in `server.rs` (scripts stay nonce-locked).

**(b) core hydrate.ts `setupShowEffect`**: the adoption-path show
materializes a branch inside its own `internalEffect` run —
`desc.whenTrue()` / `ensureNode(branch)` with no `createRoot`/`untrack` —
so the branch's reactive text, nested shows and lists are owned by that
effect run and are DISPOSED when it re-runs (the very next toggle). The
runtime-path `createShow` wraps branches in `createRoot(() =>
untrack(branchFn))`; the adoption path must do the same. Symptoms shipped:
modal reopens with the previous prompt, repeat flashes render an empty
box, a conflict dialog appearing on a reopened modal never renders (the
user-visible "second learn freezes" wedge). **Ask**: wrap adoption-path
branch creation in an unowned root. Local fix: `build.mjs` rewrites the
compiled seam (two anchored regex replacements, exactly-once enforced) to
call `globalThis.__ksxShowBranch` = `createUnownedRoot(() =>
untrack(make))`, installed by `map.ts`/`status.ts` before activation.
Trade-off documented: branches created this way are never disposed —
matching the seam's existing keep-the-fragment behavior, bounded by the
page's small show count.

**Adopted 2026-08-09.** forma-server 0.2.0 fixes (a) with the narrower
`style-src-attr 'unsafe-inline'` directive while retaining the nonce on
`style-src`; ksx now ships the upstream CSP verbatim and `relax_style_src` is
deleted. `@getforma/core` 2.0.0 fixes (b) by wrapping adopted branch creation
in `createRoot(...)` + `untrack(...)`; the bundle rewrite and the
`__ksxShowBranch` entry helpers are deleted. The former local fixes above are
kept as the dated diagnosis, not as current setup instructions.

### #14 — the show seam has a measured price now (v6, 2026-08-05)
The mapper's v6 pass (loud no-daemon banner, pause/resume for mapping, a third
restore destination, clear-one-in-modal) needed **6 new shows** on `/map` and
**1** on `/`. Each one costs four coordinated edits — the island's `h()` tree,
the twin `*Page.ts` compile-time declaration, the `*_SHOW_ORDER` label array,
and the boolean's POSITION in `show_values` — and an insertion in the middle of
the document (which is where a banner goes: first child of `<main>`) shifts
every show after it. Nothing but our own count assertion catches a mismatch,
and a mismatch is a wrong panel rendering, not an error. This is the same ask
as #4; what is new is the evidence that it is a recurring tax on UI work, not a
one-time setup annoyance.

### #15 — per-item member attrs carry INTERACTION, not just style (good news)
#11 established that bare `param.field` reads work as attribute values inside
`createList` item bodies. v6 leaned on that for behavior: the legend's clear
accelerator is `h("span", { class: "lclear", "data-clear": l.fn, title:
l.cleartitle }, l.clear)` — SSR emits the whole affordance, the client
re-derives it per poll, and `map.ts` picks it up by event delegation. Two
patterns fall out that cost ZERO extra shows: an empty string for the content
means "hide this per-row control" (CSS `:empty`), and a class-string field
(`z-dead` / `l-dead`) is how a control is rendered visibly disabled WITHOUT the
`disabled` attribute — which matters because a disabled button swallows its own
click, and a click on an unmappable control is exactly the click that owes the
user an explanation. Worth folding into the #11 upstream ask as the reason the
contract matters.

### #17 — compile-time spread expansion (and its three sharp edges)
Discovered building v9's no-JS mapper (2026-08-05). **Upstream**: forma-tools
→ `emitSpreadChild` / `extractFileConstants` / `substituteInExpr`.

**The good part**: `...KEYS.map((k) => h("option", null, k.k))` where `KEYS` is
a top-level array of object literals is unrolled INTO THE IR at build time —
static markup, no slots, no islands, and the identical source still runs in
the browser for the client re-render. That is the only reason a full 122-key
picker on 25 legend rows is affordable: the alternative was a nested
`createList` (the item-body seam has no such thing) or 3 000 hand-written
literals.

**Edge 1 — root-file only.** `extractFileConstants(componentSource)` is called
with the entry's resolved `*Page` file, and the island's walk context inherits
it unchanged (`islandWalkCtx = { ...walkCtx }`). Constants declared beside the
markup in `MapIsland.ts` are invisible; the spread silently degrades to an
island. It also scans `program.body` for `VariableDeclaration`, and an
`export const` is an `ExportNamedDeclaration`, so exporting the constant hides
it too. Local shape: declare bare in `MapPage.ts`, `export { … }` in a separate
statement, `import` back into `MapIsland.ts`. The resulting MapPage → MapIsland
→ MapPage cycle is inert (nothing reads the arrays before `MapIsland()` runs)
and, unlike #9's signals, this is SINGLE-SOURCED.

**Edge 2 — children only.** `substituteInCallExpr` walks the h() call's
arguments and substitutes bare member reads, but an ObjectExpression argument
(the props) is returned untouched. So `h("option", { value: k.k }, k.t)`
emits the text and then an `attr:value` slot with nothing in it: every option
renders `value=""`. For decoration that is invisible; for a FORM it is wrong
data submitted silently — the worst failure mode in this ledger after #10.
Local shape: no `value` attribute at all, and HTML's rule that an option's
trimmed text IS its value. (Which turned out to be the honest design anyway:
what you pick is character-for-character what the preset file will hold.)

**Edge 3 — the tell.** An unexpandable spread emits an island placeholder, so
the build's own line gives it away: `IR emitted (real): map.ir (13362 bytes,
24 islands)` for a page with exactly one island was the first symptom. Worth
a warning upstream; the byte count and island count are the only signal.

### #18 — a new sibling list is free; a new show is not (v16, 2026-08-06)
Diagonals-as-presentation replaced the macro grid's 25 columns with 37 (every
direction group is now its whole `↑ ↖ ← ↙ ↓ ↘ → ↗` ring) and added a group band
above the glyph row. The band is a fourth `createList` inserted in the MIDDLE of
`.macscroll`'s children.

Under #4's positional show seam that insertion would have renumbered every show
after it. Under 0.2.0's binding-derived list names (#3) it cost exactly two
lines: one `LIST_SLOT_MACRO_GROUPS` constant and one entry in the order the
layout test asserts. The lists around it — `macroCols`, `macroCells` — kept
their names because those names come from `() => macroCols()`, not from where
they sit.

That is the same feature, priced twice, in the same file: **#14 measured what a
show costs; this measures what a NAMED slot costs.** It is the strongest
argument we have for #4, because it is not hypothetical — it is the identical
edit in the identical page with the identical author.

Second confirmation, for #11/#15: the band spans its columns by CLASS
(`macgrp g9`, with `.macgrp.g9 { grid-column: span 9 }` in the stylesheet)
rather than an inline `grid-column`. That was not a style choice — #13(a) means
an inline `style` attribute would simply not survive the CSP — so per-item
member reads carrying LAYOUT, not just interaction, is now load-bearing too.

### #16 — the #13(b) patch held under three-deep nested shows
The v6 learn modal nests shows three levels inside a re-toggled branch
(`modalOpen` → `modalListening` / `modalBound` / `modalConflict`) and toggles
them dozens of times per mapping session. With upstream's adoption-path
`setupShowEffect` this would reproduce every symptom in #13(b) at once (stale
prompts, empty boxes, a dialog that never renders); with the `__ksxShowBranch`
unowned-root rewrite it is simply correct. Recorded because it strengthens the
upstream report: the bug is not an edge case, it is load-bearing for any modal.

### The 2026-08-06 adoption pass — measured, not assumed

`@getforma/compiler` 0.3.1 + `@getforma/build` 0.2.0, consumed from
a sibling local checkout as `file:` deps because npm publishing was down
(only build 0.2.0 made it out). `studio-ui/package.json` carries the note that
says when to swap back to `^0.3.1` / `^0.2.0`. **`@getforma/core` was not part
of this wave and stays at 1.5.0** — which is why #13(b) is still patched.

**Slot counts, before and after (real, from the emitted IR):**

| | compiler 0.2.0 (HEAD) | 0.3.1, twins still present | 0.3.1, twins deleted |
|---|---|---|---|
| `/` slots | 67 | **96** (29 dead) | **67** |
| `/map` slots | 216 | **283** (67 dead) | **216** |
| collision warnings | 0 | **96** | **0** |
| show slot names | `show:createShow` ×17 / ×19 | named | named |
| island `slot_ids` | 0 / 0 | 45 / 186 | 45 / 186 |

**Correction, same day** (measured off the committed `.ir` files, not the
build log): the right-hand column describes the tree *before* #20's
workarounds were reverted. Reverting them puts five ANONYMOUS slots back on
the mapper — four concatenated `title` attributes and one concatenated text
child, see #21 — so **the committed tree is `/map` 221 slots / 191 `slot_ids`**,
not 216 / 186. `/` is 67 / 45 either way. The 216 number is still the useful
one for the twin arithmetic (283 − 67); it just is not what ships.

The middle column is why deleting the twins was MANDATORY rather than tidy:
with 0.3.1 walking island files, each twin declaration minted the unsuffixed
slot and pushed the island's real one to `#2` (`generatedAt` vs
`generatedAt#2`), so every name-keyed injection would have filled a slot
nothing renders.

**And that guard was not the guard we thought it was.** This entry originally
said the compiler's per-collision warning made the failure self-diagnosing —
"a clean build has zero of those lines, which is a better guard than any
assertion we could write". Verified 2026-08-06 by resurrecting ONE twin
(`presetLine` in `MapPage.ts`), rebuilding, and running the whole gate:

- the compiler does warn, in `signal-scope.ts`, and the wording is good:
  *"signal 'presetLine' is also declared in another scope on this page, so this
  one gets the slot name 'presetLine#2' — inject it under that exact name"*;
- but it is **one `console.warn` line among the thirteen benign
  ArrayExpression notes this very document tells you not to chase**, `node
  build.mjs` exited 0, and **all 97 Rust tests passed**. The mapper rendered
  `(no preset)` for its preset name, forever, with a green gate.

`embedded_ir_slot_layout_matches_the_seam` could not catch it because it
asserted that the injected NAME EXISTS — and it does exist; it is the dead
one. Two guards were added instead (both verified to fail on the probe and
pass on the real tree):

1. `build.mjs` now **throws** on that warning rather than printing it;
2. `render::assert_island_slot_contract`, shared by both layout tests, checks
   the invariant that actually matters — **every name the seam injects must
   resolve to a slot the ISLAND RENDERS** (`slot_ids` membership), and every
   bare-named slot the island renders must be injected or listed as a
   documented client-only exception. Existence was never the contract.

**The real show names**, enumerated from the IR (this is the list the seam now
injects by name; document order shown, but nothing depends on it any more):

- `/` (17): `pillRunning pillIdle pillDown noDaemon flashOk flashError
  canStart canStop daemonDown rowsLive rowsPlain vigemOk vigemWarn
  icptBorrowed icptAbsent autostartOn autostartOff`
- `/map` (19): `pillRunning pillIdle pillDown pillPaused noDaemon
  sessionRunning pausedBar readOnly canLearn artXbox artDs4 hasBackup savedOk
  savedErr modalOpen modalListening modalBound modalConflict selBar`

Each is `show:` + the condition getter, so they are the signal names in
`*Island.ts`. The old positional order matched the new named mapping one for
one — checked before the swap — so this adoption changed no behaviour.

**What the handoff got wrong** (recorded because "verify every number" is the
rule that caught it):

- "~32 signal declarations in StatusPage.ts, ~68 in MapPage.ts" — really **29**
  and **67**.
- "roughly status 67, map 205" after the deletion — status 67 is right, map is
  **216**, exactly the 0.2.0 count.
- "~76 pre-existing `IR: signal …` warnings" — really **13**, all of them the
  ArrayExpression note on the nine list signals plus four more. The 0.3.1 build
  with twins present emits **109** lines, but 96 of those are the duplicate
  warnings the deletion removes.
- "the map route's 34 phantom islands should vanish on rebuild" — there were
  **none**. `/map` compiled to exactly 1 island before this pass and 1 after.
  The phantom islands were the shape of the #20(b) bug, and ksx's source had
  already been written around it (separate string children), so there was
  nothing to vanish. Reverting the workaround is what actually tested the fix.
- The show-name list was corrupted, as warned. `autostart…` is two names
  (`autostartOn`/`autostartOff`), and the map list omitted `pillPaused`.

**Probes run to settle the rest** (throwaway code in `StatusIsland.ts`, built,
IR inspected, reverted):

- #10: `const PROBE_D = "M20 7 L40 7 L40 27 Z"` used as `h("path", { d:
  PROBE_D })` — the literal lands in the string table beside the `d` key, no
  slot, no island. **Fixed.**
- #17 edge 1: the probe constants were declared in `StatusIsland.ts`, an
  ISLAND file, and the spread still expanded. **Fixed** — file constants are
  no longer root-`*Page`-only.
- #17 edge 2: `h("option", { value: o.v }, o.k)` emitted `AV`/`BV` as real
  static attribute values. **Fixed** — the silent-wrong-data edge is gone.
- #13(b): read `@getforma/core`'s `dist/chunk-3U2IQIKB.js`. `setupShowEffect`
  still materializes branches inside `internalEffect` with no
  `createRoot`/`untrack`, and both `build.mjs` patch anchors still match
  exactly once. **Not fixed — the `__ksxShowBranch` rewrite stays**, with a
  dated note saying why.

**Parity check** (Playwright, against the macro fixture): every served path
loads twice, once with the app bundle blocked and once with it live, and their
DOMs are diffed after hydration in all three fixture session states. That was
nine path variants and 27 checks when this was written; since the 2026-08-25
cutover it is **five variants and 15 checks** — `/nocturne`,
`/nocturne?slot=1&macro=hadouken`, `/check`, `/pads`, `/devices`, each × idle /
running / down. Fewer checks is not less coverage here: the four deleted pages
were four separate islands and their states now have to be expressed on one. They are identical apart from four by-design
differences — forma's own `data-forma-status` lifecycle attribute
(`pending`→`active`), the client's `js` marker class, forma-ir's `U+200B`
placeholders for empty dynamic text slots, and `map.ts` writing `value=""` into
the form controls it owns. First paint matches what the client renders, which
was the risk in giving shows real SSR defaults.

**That check is a suite now, and its first real run found a flash** — see
**#21**. The manual pass above only ever ran the fixture's default state
(reachable + idle), and the disagreement lives in the RUNNING one.

### #19 — native island props carry slot values, not the domain payload
Adopting #8's fix answered the question we asked and raised a different one.
`build_island_props` maps `slot_ids` → slot names → current `SlotData`, so the
props object is `{"vigemLine": "…", "show:canStart": true,
"list:padTiles:array": […], "list:padTiles:art": …}` — the page's rendered
output, replayed. That is exactly right for seeding a presentational island and
exactly wrong for `/map`, whose client owns an editing MODEL: `lastPayload`
feeds conflict detection, the macro draft, undo, the learn state machine and
every "what would this write" preview. None of it is a slot.

So the `__forma_islands` impersonation died and a `__ksx-payload` block took
its place — same escaping, same parity tests, ksx's own name, and no pretence
that it is part of the islands protocol. `loadIslandProps` prefers the inline
attribute anyway, so the entries read their block directly by id rather than
through the `props` argument (which now arrives full of slot names).

The second half is cost. Inline props are emitted whenever `slot_ids` is
non-empty, and the compiler always writes `propsMode=Inline`; there is no
opt-out from the page's side. On `/map` that is a **106 557-character**
`data-forma-props` attribute — 33% of a 320 397-character response, an
HTML-escaped duplicate of markup already in the document, that this app never
reads. forma-ir already implements `PropsMode::ScriptTag` and already skips
emission for empty `slot_ids`; letting the author choose would cost upstream
almost nothing.

### #19 update — the props channel is fixed; OUR payload is now the big one (2026-08-12)

Measured against a running 0.3.1 Studio, not reasoned about. Every page fetched
and split into its three parts:

| page | total | markup | `__forma_islands` (forma) | `__ksx-payload` (ours) |
|---|---:|---:|---:|---:|
| `/start` | 129,534 | 33,785 | 22,457 | **73,292 (57%)** |
| `/devices` | 96,966 | 30,200 | 16,554 | **50,212 (52%)** |
| `/map` | 44,409 | 31,782 | 12,055 | 572 |
| `/` | 9,156 | 6,298 | 2,007 | 851 |

**Half (b) is closed.** `data-forma-props` does not appear on any page. forma-ir
0.2.0's `INLINE_PROPS_MAX_BYTES = 1024` spills oversize props into the shared
block, and the walker emits exactly one channel per island so precedence never
has two answers. `/map` fell from the 320,397 bytes recorded above to 44,409 —
the 106,557-character attribute is gone, and no local change was needed.

**Half (a) is now the larger cost, and it is OURS.** `__ksx-payload` is 57% of
`/start` and 52% of `/devices`. That block exists because the clients own a
model over the SOURCE payload that no slot carries (#19's original point) — and
it is the same second derivation #21 is about. Two observations worth keeping:

- The cost is not uniform. `/map` needs almost none of it (572 bytes) because
  the mapper's model is rebuilt from its own poll; `/start` and `/devices` ship
  the whole `StartPayload` / `DevicesPayload` a second time.
- So the ask upstream is narrower than it was: not "a channel for server→island
  data" in general, but a way for an island to receive the payload it already
  renders from without a second copy on the wire. The first fetch is the only
  one that needs it; every poll after replaces it.

Not acted on here beyond the measurement. Shrinking it means deciding, per
page, whether the client can rebuild its model from slot values plus one poll
rather than from an embedded copy — a real design question, not a tidy-up.

### #19 re-measured after the cutover — (b) scales, (a)'s headline moved (2026-08-26)

The table above is entirely stale: every route in it except `/devices` 404s
today. Re-measured with four read-only `GET`s against the **live `real=4460`
lane** (the one with hardware attached; nothing stopped, started or restarted,
and `status.ps1` still reported `real` as `managed / running` afterwards). All
four returned HTTP 200. Byte counts are of the response body; each JSON block is
measured between its `<script id="…" type="application/json">` and `</script>`:

| page | total | markup | `__forma_islands` (forma) | `__ksx-payload` (ours) | `data-forma-props` |
|---|---:|---:|---:|---:|---:|
| `/nocturne` | 679,028 | 569,975 (83.9%) | 28,639 (4.2%) | 80,414 (**11.8%**) | 0 |
| `/devices` | 103,134 | 34,483 (33.4%) | 17,556 (17.0%) | 51,095 (**49.5%**) | 0 |
| `/pads` | 22,497 | 12,706 (56.5%) | 5,593 (24.9%) | 4,198 (18.7%) | 0 |
| `/check` | 12,910 | 9,552 (74.0%) | 2,468 (19.1%) | 890 (6.9%) | 0 |

Three things worth recording, and one caveat the 2026-08-12 table should have
carried:

- **(b) holds on a far bigger page.** Parsing `/nocturne`'s served
  `__forma_islands` block gives its single island **479 prop entries** — one per
  registered `slot_id`, since `build_island_props` keys by slot name — in a
  28,639-byte block, i.e. 28× `INLINE_PROPS_MAX_BYTES` (1,024). It spilled,
  exactly as designed, and `data-forma-props` appears NOWHERE on any of the four
  routes. The spill fix scales past a page with 479 slots on it, which is more
  than double the `/map` it was measured on.
- **(a)'s headline moved.** This section said our payload was "57% of `/start`,
  52% of `/devices`" and was "now the larger half". On the page that is now the
  product it is **11.8%**, and the dominant cost is **markup — 570 KB of it**,
  which is a ksx problem and not a Forma one. `/devices` at 49.5% is the sole
  surviving instance of the old shape. The ask does not change; the claim that
  it is the biggest remaining cost does, and this document should not keep
  implying otherwise.
- **The props channel is clean.** Of the 479 prop entries, **zero** are
  anonymous (`text:` / `attr:`) — #22's three are gone — and both
  `list:nGameRows:array` and `list:nGameRows#2:array` are present and served
  (`[]` on this daemon, which has no saved games). That is #23's fix, observed
  on the wire.
- **Caveat:** this is the real lane, with hardware attached and a live session
  state. The 2026-08-12 table never named WHICH lane it measured, and page size
  moves with session state. Both tables should say; this one does.

### #20 — the two concatenation defects (reported 2026-08-05, fixed overnight)
**(a) attribute position.** `title: "a" + "b"` compiled to an empty slot and
the attribute was emitted with NO VALUE. Silent: no warning, no error, just a
control with no tooltip — which is how both 360 motion buttons and the macro
Enable switch shipped without one. The tell was a pwtest case that read
`getAttribute("title")` back and got `null`.

**(b) child position.** `h("span", null, "a" + "b")` was a BinaryExpression the
h-tree walker could not fold, so it fell back to an anonymous ISLAND
placeholder — the same degradation as #17 edge 3. Only caught because
`embedded_map_ir_slot_layout_matches_the_seam` asserts "exactly one island";
without that assertion the page would have shipped with a second island whose
component nothing registers.

Both fixed in 0.3.1 and both workarounds reverted here, deliberately, as the
test: the motion titles are wrapped concatenations again and `.macstephint` is
one concatenated child. `concatenated_strings_render_in_attributes_and_children`
asserted the folded text reaches the SSR markup and that no `title=""` exists
anywhere on the page, because "the attribute is missing" is not something a
human notices in review.

#### #20(b) update — the fix is narrower than this entry claimed (2026-08-26)

**"Fixed" meant "fixed when every operand is a literal."** Read `emitChild` in
the shipped compiler and the boundary is explicit. A `StringLiteral` child emits
`OP_TEXT` + `ctx.addString` (`index.js:2871-2873`). A foldable expression is
evaluated by `evalNode` and, if it folds, put in an anonymous slot
(`index.js:2911-2924` — that branch is #22). Everything else falls through to
`index.js:2978`:

```js
warnDegraded(walkCtx, `child ${describeNode(child)}`,
  ISLAND_CONSEQUENCE + " — wrap it in a function (`() => …`) …");
emitIsland(ctx);
```

with `ISLAND_CONSEQUENCE` (`index.js:2241`) reading *"emitted as an empty island
shell, so it renders nothing server-side and only appears once the client bundle
hydrates"* and `describeNode` (`index.js:2233`) rendering a `BinaryExpression`
as *"a bare '+' expression (not wrapped in a function)"*. `evalNode` cannot fold
`"Edit " + r.title + "…"`, so **that is the 2026-08-05 mechanism, intact, on the
2026-08-26 product page.** `dcfc794` wrote exactly that expression into a
`<summary>` and it degraded exactly as described.

So the status is scoped, not reopened wholesale: 0.3.1 moved the literal-only
case from an island to a slot, and left the non-literal case where it was. The
honest upstream ask for (b) is now the same one as #22's second half — **warn
loudly, or better, keep the static prefix as `OP_TEXT` and slot only the dynamic
operand**, which is what an author writing `"Edit " + r.title` obviously means.

**What caught it, and what did not.** This entry named
`concatenated_strings_render_in_attributes_and_children` as the guard that made
the silent failure mode uncomeback-able. That test was deleted with `/map` in
`fcf71d0` on 2026-08-25; `grep` over the whole tree finds the name only inside
this document. The failure mode returned the next day. What actually stopped it
is `studio-ui/build.mjs:315-350`, added in `ff16a9e` for an unrelated reason:
**every compiler warning that is not one recognised benign class throws.** The
one benign class is `is initialized with a \w+ the compiler cannot evaluate`
(the ArrayExpression note on list signals), and it is COUNTED into a single
summary line rather than printed, precisely so that warning number twenty-one
cannot arrive invisible.

Read exactly, the fatal set at `build.mjs:339-343` excludes **two** patterns,
not one: that benign class, and `is also declared in another scope on this page`
— the second only because a dedicated check just above it (`build.mjs:302-313`,
the #9 hardening) has already thrown on that sentence with a better message. So
nothing escapes; the gate simply has two doors. The second door turns out to be
load-bearing in a direction nobody designed for, because it matches on the
SENTENCE rather than on what the sentence is about — see the refined ask in
**#23**.

The gate is the direct institutionalisation of this ledger's closing lesson, it
had never been written down here, and it is now the only thing between an
unfoldable concatenation and a shipped empty island.

**And there is a gap under it.** `/nocturne` asserts nothing about island count.
`assert_eq!(islands.len(), 1, "expected exactly one island")` lives in
`render.rs:441` inside `assert_island_slot_contract`, and in the layout tests of
`render_check.rs`, `render_devices.rs` and `render_pads.rs` — the three TOOL
pages. The product page calls none of them. The tripwire that originally caught
#20(b) does not exist on the page that now IS the product; the build gate is
standing in for it, and a build gate can only see what the compiler chooses to
warn about.

### #21 — the mirror seam has no gate, and it had drifted (2026-08-06)
**OURS, not upstream's — and the most expensive shape left in this design.**

Every page here emits the same data twice on purpose (#5): slots for the SSR
paint, `__ksx-payload` for the client. That means two derivations of the same
sentence, in two languages, with nothing checking that they agree — `reason_line`
in `render_map.rs` against `reason()` in `MapIsland.ts`, `show_values` against
`applyMap`, and so on for every string on the page. A Rust test cannot see the
TypeScript; the compiler cannot see the Rust. Between them the disagreement is
invisible until it paints.

**What it had already cost.** With a session RUNNING, the mapper's read-only
banner painted

> read-only while emulation runs … Use **"Pause emulation & map"** above …

and then, on adoption, replaced it with

> read-only while emulation runs … Use **the Pause button** above …

A visible flash, and the surviving sentence was the wrong one: the button is
labelled "Pause emulation & map", so the hydrated copy named a control that
does not exist on the page. Fixed in `MapIsland.ts` (the server's wording won).

**The guard.** `studio-ui/pwtest/ssr-hydration-parity.test.mjs`: every served
path is loaded twice — once with the app bundle blocked at the network layer, so
the island never hydrates, once normally — and the island subtrees are diffed
after normalizing exactly four by-design differences (`data-forma-status`, the
`js` class, `U+200B` text placeholders, and the client's own empty `value=""`).
It runs in all three session states (`KSX_FIXTURE_SESSION=idle|running|down` —
the fixture grew the switch for this), because the drift was in the state nobody
had loaded. When this was written that was nine path variants — `/`, `/start`,
`/map`, `/check`, `/pads`, `/devices`, `/profiles`, `/setup` and `/map?slot=1` —
× three states, 27 checks. **Today the list is five and the arithmetic is 15**:
`/nocturne`, `/nocturne?slot=1&macro=hadouken`, `/check`, `/pads`, `/devices`.
The second entry is the direct descendant of `/map?slot=1` and earns its place
the same way: it is the only variant that reaches an open editor, and an editor
is where SSR and hydration are most likely to disagree. GitHub Actions installs the pinned
Playwright Chromium runtime and runs this suite with the Studio visual-smoke
capture in the `studio-browser` job. It always publishes the
`studio-browser-screenshots` artifact for review; local browser execution is
not release evidence.

`modal open` is deliberately not among them: every modal show is injected
`false` unconditionally, so the modal cannot be part of a first paint and has
no SSR side to disagree with.

**The blind spot the guard still has, found the same day by driving a
TWO-SLOT cabinet** (the parity fixture has one slot, and one slot cannot
express this): the harness diffs the SSR paint against the HYDRATION seed, and
the seed is the payload the server embedded — so anything that only goes wrong
on the first POLL is invisible to it. `poll()` fetched `/api/map` (the poll is
`/api/nocturne` now, and the blind spot is the same shape) with no `slot=`, and
the collector falls back to the FIRST slot when the query omits one. On `/map?slot=2` the SSR paint, the payload and the hydrated DOM all
agreed and were all correct; two seconds later the macro card silently swapped
to slot 1's macro table while the rail, the stage and the legend still said P2
— and `saveMacro` resolves the preset from the CLIENT's selection, so Save
would have written P1's steps into P2's preset. Fixed in `map.ts` (the poll
carries the selected slot). A parity test proves the first paint is honest; it
says nothing about the second one.

**Why it belongs in a Forma ledger even though the bug was ours**: the
duplicate derivation is not a ksx choice, it is what #5 leaves you with. A
framework that let the server hand its RENDERED state to the island (rather
than its slot values — #19) would delete the second derivation and this whole
class with it.

### #22 — the concat fix folds into a SLOT, not into markup
Reverting #20's workarounds (the whole point of the exercise: revert, and see
whether it still renders) shows what compiler 0.3.1 actually does with
`"a" + "b"`. It does not fold it into static markup the way #10's module const
now folds. It emits an **anonymous slot** whose DEFAULT holds the folded
string: `attr:title`, `attr:title#2`, `attr:title#3`, `attr:title#4` and
`text:0` on `/map` — the two 360 motion buttons, the reverse 360, the macro
Enable switch, and `.macstephint`.

That renders correctly, which is the fix. Three residues:

1. **They are the +5 in the count correction above** — 221 slots, and all five
   are in the island's `slot_ids`, so they are also five more entries in the
   106 KB `data-forma-props` attribute #19 is about. A page pays slot-table and
   props cost for a string that is constant at build time.
2. **The names are positional-looking** (`attr:title#3`). Harmless only because
   nothing can inject them. What "positional" actually means is corrected below
   — this entry originally called it "#3's complaint in a new place", and it is
   a different mechanism.
3. **The silent-empty shape survives one step over.** The default is the folded
   text only while every operand is a literal. `title: "a" + someSignal()` lands
   in the same anonymous slot with an EMPTY default — an attribute with no
   value — which is #20(a) exactly. Locally pinned: `render.rs`'s
   `assert_island_slot_contract` fails if the anonymous set changes, or if any
   anonymous slot's default is empty.

**Ask**: fold a wholly-literal concatenation into the string table like any
other literal (no slot, no props weight), and warn when a concatenation is
kept as a slot with nothing in its default.

#### #22 reproduced on `/nocturne` — and three of its four sentences were wrong (2026-08-26)

The entry above was written against `/map`. `/map` is gone. The residue is not,
and the way it came back is the argument for the ask: an author who had never
read this entry wrote three ordinary `"literal " + "literal"` paragraph texts on
the new product page and got three anonymous slots, on the same pinned compiler,
with no signal of any kind. Then `898ad32` split them into adjacent literal
children — which is this entry's ask, hand-performed at the call site.

**The measurement.** Both sides of `898ad32` read out of the committed IR blobs
with a hand-written FMIR v2 parser — sections are `0=Bytecode 1=Strings 2=Slots
3=Islands`, a slot entry is `slot_id u16, name_str_idx u32, type u8, source u8,
default_len u16, default_bytes` — not out of the build log:

| | `898ad32^` (`nocturne.f6f48b3b.ir`) | `898ad32` (`nocturne.87ef78fd.ir`) | delta |
|---|---:|---:|---:|
| anonymous text slots | `text:0`, `text:0#2`, `text:0#3` | **none** | −3 |
| slots | 536 | 533 | −3 |
| island `slot_ids` | 482 | 479 | −3 |
| strings | 3,422 | 3,426 | +4 |
| **slot section, bytes** | **6,631** | **6,167** | **−464** |
| **string section, bytes** | **398,809** | **399,229** | **+420** |
| bytecode section, bytes | 91,518 | 91,538 | +20 |
| whole file, bytes | 497,986 | 497,956 | −30 |

**The two bolded rows are the ask, hand-performed at the call site**, and the
arithmetic closes exactly — nothing here is estimated or rounded:

- **−464 from the slot table** = three entries × 10 bytes of fixed header, plus
  the 434 bytes of default text they carried (101 + 196 + 137).
- **+420 into the string table** = seven literal fragments totalling those same
  434 bytes plus 7 × 2-byte length prefixes (448), less the three slot NAMES
  that stopped being needed (`text:0`, `text:0#2`, `text:0#3` — 22 bytes plus
  3 × 2-byte prefixes, 28).
- **+20 bytecode** = three `OP_DYN_TEXT` (opcode + slot u16 + marker u16 = 5 B)
  replaced by seven `OP_TEXT` (opcode + string-index u32 = 5 B): 35 − 15.
- **−6 island table** = three fewer `slot_id` u16s.

−464 + 420 + 20 − 6 = **−30**, which is precisely what the file moved. The
strings count rising by only +4 while seven fragments were added says the same
thing from the other side: seven fragment strings arrived and three now-unused
slot names left. (Seven, because the three `+` chains were 2, 3 and 2 operands —
`898ad32`'s diff to `NocturneIsland.ts` is fourteen lines and nothing else.)

Verified unchanged at HEAD (`nocturne.288c1416.ir`, a later rebuild at 498,829
bytes): **533 slots, 479 `slot_ids`, zero anonymous slots.** The residue has not
crept back.

The defaults themselves, with their `default_len` u16 read straight out of the
slot table and a `source` byte of `0x01` — `SlotSource::Client`
(`forma-ir-0.2.0/src/format.rs:597-604`), which is why SSR renders the default
and the output was never wrong:

- `text:0` — 101 bytes — *"A saved game remembers what to launch, how many
  players it has, and which controller layout they use."*
- `text:0#2` — 196 bytes — *"Renaming repoints every controller that uses the
  layout, so nothing is left naming a layout that is not there. …"*
- `text:0#3` — 137 bytes — *"Paste a configuration ksx exported. Leave the box
  below unticked and nothing is written — you get a report of exactly what it
  would do."*

**The default held the complete folded string in all three cases, so the page
rendered correctly with scripting on AND off.** That is the finding, and it is
worth stating plainly because `898ad32`'s own commit message reads like a
wrong-output bug and it was not one. The cost was structural: **474 bytes on
every `/nocturne` response** — 31 B of keys and colons, 440 B of quoted values,
3 commas — an escaped duplicate, inside `__forma_islands`, of three sentences
that are constant at build time. `SlotData::new_from_defaults`
(`forma-ir-0.2.0/src/slot.rs:392`) seeds client defaults into the runtime
`SlotData` and `build_island_props` (`walker.rs:1158`) reads
`slots.get(slot_id).to_json()`, so an anonymous slot's default is GUARANTEED to
ride the props channel. There is no way to author around it and no way to
opt out.

**What caught it** was `nocturne_slots_are_classified_exactly`
(`render_nocturne.rs:848`) — specifically its catch-all arm, *"unclassified
named slot {name:?} — decide whether the seam serves it or the island owns it,
then pin it"*. `text:0` matches no `SERVED_LIST_PREFIXES` entry and is in
neither `SERVED_SLOTS` nor `CLIENT_ONLY_SLOTS`, so the test fails on the name
alone. Verified 2026-08-26 against the current tree: `cargo test -p ksx-studio
--lib nocturne_slots_are_classified_exactly` → `ok. 1 passed; 0 failed; 104
filtered out; finished in 0.01s`.

Note for anyone filing this: **`/nocturne` has no `ANONYMOUS_SLOTS` array and
never calls `assert_island_slot_contract`.** Those `const ANONYMOUS_SLOTS: [&str;
0] = []` pins live at `render_check.rs:66`, `render_devices.rs:77` and
`render_pads.rs:69`. #22 is now pinned two different ways on two different kinds
of surface, and the `Where` column named neither correctly until today.

**Correction (i): the names are not document-order.** From the shipped compiler,
`index.js:2472`:

```js
function textSlotName(childIndex, walkCtx) {
  return uniqueName(walkCtx.textNames, `text:${childIndex - 2}`);
}
```

`childIndex` is the `h()` argument index and children start at argument 2, so
**the digit is the child's position within its own parent element**; page-wide
uniqueness comes from `uniqueName` (`index.js:34`) appending `#N` on the second
and later occurrence. The data proves it: three paragraphs in three unrelated
sections of `/nocturne` all minted `text:0`. Under document-order naming they
would have been `text:0`, `text:1`, `text:2`. By the same rule `attr:title#3`
above was the third slot for the KEY `title`, not the third slot on the page.
This entry should stop borrowing #3's framing — #3 is about which BINDING a name
derives from; this is about a name that derives from nothing at all.

**Correction (ii): "no warning" is wrong for the attribute half.** Against the
pinned 0.3.1 the attribute path does warn (`index.js:2635-2638`):

> attribute '\<key\>' on \<tag\> is a bare '+' expression (not wrapped in a
> function), which the compiler cannot evaluate — the attribute is OMITTED from
> the server-rendered HTML and hydration does not re-apply a non-function prop,
> so it never appears — inline the literal, use a module-level const, or wrap it
> in a function

So **half of this entry's ask is already satisfied**: "warn when one is kept as a
slot with nothing in its default" ships for attributes; only "fold a wholly
literal concatenation into the string table" is outstanding, and the child
position still has no equivalent warning for the folded case. Worth saying in
the filing that this entry was written against 0.3.1 consumed as a `file:` dep
while npm publishing was down, rather than calling the old line a mistake.

**Correction (iii): the ask has a line number now.** `emitChild` already folds;
it just files the result in the wrong place. `index.js:2911-2924`:

```js
const folded = evalNode(child, evalEnv(walkCtx));
if (folded !== void 0) {
  if (folded !== null && typeof folded !== "boolean") {
    const slotId = ctx.addSlot(textSlotName(childIndex, walkCtx), TYPE_TEXT,
                               SOURCE_CLIENT, defaultBytesFor(folded));
    const markerId = ctx.nextMarker();
    ctx.emit(OP_DYN_TEXT);
```

Forty lines earlier, in the same function, the string-literal arm does the right
thing already (`index.js:2871-2873`:
`ctx.emit(OP_TEXT); ctx.emitU32(ctx.addString(child.value))`).
A wholly-folded value is a string literal that arrived by a different route.
One branch.

**Good news worth filing alongside, because it de-risks the workaround.**
Splitting a concatenation into adjacent literal children makes SSR emit ONE
merged text node while the client renders N string children. That is safe:
`@getforma/core@2.0.0`'s `adoptNode` tail (`dist/chunk-WMFMCSOW.js:1192`) is

```js
} else (typeof child == "string" || typeof child == "number") &&
       cursor && cursor.nodeType === 3 && (cursor = cursor.nextSibling);
```

— a static string child advances the cursor and never writes, so the extra
children are inert. In all three `/nocturne` cases the literals are the entire
child list of their `<p>`, so the second and third advances find no text sibling
and no-op. **The constraint, read off that same line and not yet exercised
here:** each extra literal DOES consume a text-node cursor position when one is
available, so adjacent literals followed by a DYNAMIC text child in the same
parent would advance past the placeholder the dynamic binding wants. Keep the
split literals last, or separated by an element. Recorded as a supported pattern
beside #11/#15 because it is now the standing workaround for both #20(b) and
#22 — and a workaround with a sharp edge should be documented before it is
recommended.

### #23 — a reused list binding is TWO lists, and the seam must serve BOTH (2026-08-26)

**Upstream**: forma-tools → compiler `emitCreateList`. **Not a naming
curiosity.** #12's tail clause has said since 2026-08-05 that "the second
occurrence of a reused list binding gets the `#N` suffix across a page". What
that sentence does not say is that the suffixed name is a whole second list,
`SOURCE_SERVER`, with its OWN member field set, and that nothing anywhere tells
you it exists.

**Mechanism.** `emitCreateList` (`index.js:3139-3150`):

```js
const registry = walkCtx.listNames;
registry.total += 1;
const derivedName = deriveBindingName(node.arguments[0]) ?? (paramName !== "_" ? paramName : null);
const base = derivedName === null ? `#${registry.total}` : uniqueName(registry.counts, derivedName);
const arraySlotId = ctx.addSlot(`list:${base}:array`, TYPE_ARRAY, SOURCE_SERVER);
const itemSlotId  = ctx.addSlot(`list:${base}:item`,  TYPE_OBJECT, SOURCE_SERVER);
const propNames = new Set();
collectMemberProps(bodyExpr, paramName, propNames);
for (const propName of Array.from(propNames))
  ctx.addSlot(`list:${base}:${propName}`, TYPE_TEXT, SOURCE_SERVER);
```

Two `createList(() => nGameRows(), …)` calls in `NocturneIsland.ts` — the
load-this-game buttons and the edit/delete disclosures — therefore mint
**fourteen slots, every one `SOURCE_SERVER`**, read out of the committed IR
(`crates/ksx-studio/assets/nocturne.288c1416.ir`; re-parsed 2026-08-26, and the
`source` byte is `0x00` on all fourteen — `SlotSource::Server`,
`forma-ir-0.2.0/src/format.rs:597-604`):

```
list:nGameRows:array      list:nGameRows#2:array
list:nGameRows:item       list:nGameRows#2:item
list:nGameRows:title      list:nGameRows#2:title
list:nGameRows:cls        list:nGameRows#2:revision
list:nGameRows:ico_cls    list:nGameRows#2:path
list:nGameRows:meta       list:nGameRows#2:arguments
                          list:nGameRows#2:slots
                          list:nGameRows#2:preset
```

**The field sets are collected PER OCCURRENCE** by `collectMemberProps(bodyExpr,
paramName)` — they overlap only on `title`. So "serve the suffixed name too" is
necessary and not sufficient: the row object the seam builds has to be the
UNION of what both item bodies read. `dcfc794` grew `render_nocturne.rs`'s
`game_row` from four fields to nine (`revision`, `path`, `arguments`, `slots`,
`preset` added for the second occurrence alone) and `list_values` from 44
entries to 45. That authoring cost has been unrecorded anywhere until now.

**The failure mode, and why it is worse than #3's.** The array slot is
`SOURCE_SERVER`. Unserved, `SlotData` leaves it `Null` and forma-ir's
`check_slot_source` (`walker.rs:184-193`, called from the LIST arm at
`walker.rs:959`) logs

> Server-sourced slot has no value at render time — handler may have a bug

**once per page render, at warn level, in the daemon's log** — measured by the
author at 13 occurrences in a session that had none the day before. The list
then renders ZERO ROWS server-side and fills only after adoption. For this list
that is every **Save changes** and **Remove this saved game** form absent from
the server-rendered page: a flash for everyone, and permanently missing for a
no-JS user, which is exactly the promise
`nocturne_renders_the_served_configuration_menu`
(`render_nocturne.rs:1231`) exists to pin.

Contrast #22's anonymous slots, which are the same "compiler minted a name you
did not ask for" shape with the opposite severity: those are `SOURCE_CLIENT`
with a default, so they render SOMETHING. A `SOURCE_SERVER` list slot that
nobody fills renders NOTHING — silently, at run time, with no build-time signal
at all.

**Ask, pinpointed — and it is three lines.** The compiler already warns for the
identical collision on the signal path (`index.js:2118-2124`):

```js
const slotName = uniqueName(registry.names, name);
if (slotName !== name) {
  warnSignal(..., `signal '${name}' is also declared in another scope on this page, so this
    one gets the slot name '${slotName}' — inject it under that exact name. …`);
}
```

`emitCreateList` calls **the same `uniqueName`** at `index.js:3142` and says
nothing. Emit that existing wording when `base !== derivedName`. It is strictly
more urgent than the signal case it is copied from: signal slots are
`SOURCE_CLIENT` and render their default, list slots are `SOURCE_SERVER` and
render an empty list.

**But not that wording verbatim — checked by asking what would happen if this
ask were granted as written, and the answer is that THIS repo's build gate would
fire and give the exact opposite advice.** `studio-ui/build.mjs:302-313` filters
every compiler warning matching `/is also declared in another scope on this
page/` and throws:

> N slot-name collision(s) — the renamed slot is the one the page RENDERS, so
> the seam's injection would fill a dead slot and the page would show
> compile-time defaults. **Declare the signal once (in the `*Island.ts` file)
> and delete the twin**

That is the right remedy for #9's twin signals, where the second declaration is
an accident and deleting it IS the fix. It is the wrong remedy for a reused list
binding, where the second occurrence is deliberate markup and the fix is to SERVE
the suffixed name — `LIST_SLOT_GAMES_EDIT`, added in `dcfc794`, which grew
`list_values` from 44 entries to 45. Deleting anything here would delete the
edit/delete disclosures. The same sentence is ALSO excluded from the fatal
`unknown` set at `build.mjs:339-343`, precisely because that earlier throw is
supposed to own it — so one regex, matching on wording alone, routes two
opposite defects to one signal-specific message.

**Refined ask**, and it costs upstream nothing extra: warn from `emitCreateList`
when `uniqueName` renames the base, but give it a sentence that names
`createList` — something like *"createList source '…' is used by more than one
list on this page, so this one gets the slot name '…' — serve it under that exact
name"*. A consumer can then tell a duplicate DECLARATION from a duplicate USE and
route each to its own remediation. A warning that cannot be distinguished from
another warning is a warning that gets somebody else's fix.

The local half of this is ours: `build.mjs`'s collision filter should
discriminate on the rest of the sentence before upstream ships anything, or the
first list collision after that release arrives wearing #9's clothes. Recorded
here rather than fixed because the file is outside this pass's area, and because
the ordering matters — the gate has to learn the difference BEFORE the compiler
starts making it.

**Guard history — one more instance of this ledger's own closing lesson.**
Caught by a daemon log line that somebody happened to be watching on a live
lane. The durable guard came five hours later in `898ad32`: the prefix
`"list:nGameRows#2:"` pinned in `SERVED_LIST_PREFIXES`
(`render_nocturne.rs:872-877`), carrying its own explanatory comment, so the
classifier test fails if it is ever dropped. A log line is not a guard.

### Ledger integrity — pins that had evaporated (2026-08-26)

Two of this document's `Where` columns pointed at code deleted in the cutover,
and both belonged to OPEN findings, which is the ledger failing at its one job:

- **#22 → `render_map.rs` `MAP_ANONYMOUS_SLOTS`** — removed in `898ad32`;
  `grep` finds the symbol nowhere under `crates/`. Re-pointed at
  `nocturne_slots_are_classified_exactly` and the three `ANONYMOUS_SLOTS` pins.
- **#20 → `concatenated_strings_render_in_attributes_and_children`** — deleted
  with `/map` in `fcf71d0`; the name now appears only inside this file.
  Re-pointed at `studio-ui/build.mjs`'s fatal-warning gate, which is what
  actually caught the recurrence.

#4, #14 and #18 also name `render_map.rs` symbols (`MAP_SHOW_ORDER`,
`zone_rows`, `LIST_SLOT_MACRO_GROUPS`). `render_map.rs` survives as a shared
library — `zones_for`, the macro tables — but `/map`'s seam and its layout test
are gone. Those three findings are CLOSED, so this note is enough: their
evidence lives in git history, at and before `fcf71d0`.

There is a story in that rather than a bullet. **The guard #20 named as the
reason "the silent failure mode cannot come back" was deleted on 2026-08-25,
and the failure mode came back on 2026-08-26 — twice, in both of its shapes.**
Neither recurrence was caught by anything #20 or #22 names. One was caught by a
build gate added for an unrelated reason, the other by a slot classifier written
for the cutover, and #23 was caught by a log line nobody was required to read.

---
Process note: findings 1+2 were reported through the product owner and fixed upstream
overnight — found in production Tuesday, fixed and adopted Wednesday. The
second wave was bigger and the same shape: #4, #8, #9, #10, #17(edges 1+2) and
both halves of #20 were reported on the 5th and adopted on the 6th.

**A third batch is queued and NOT yet sent** (2026-08-26): #23, #22's three
corrections, and #20(b)'s scoping. All three are one-branch or three-line
changes in `@getforma/compiler`, all three have a mechanism, a line number and a
measured local repro above, and none of them is a regression — the pinned
versions have not moved since 2026-08-09.

One of the three carries an amendment worth sending WITH it rather than after:
#23's warning must not reuse the signal path's sentence, because dry-running that
implementation against this repo's own build gate showed it would be answered
with the opposite remediation. The dry run cost ten minutes and is the difference
between a fix and a fix that has to be fixed.

Still open, in the order they cost us (reordered 2026-08-26 — the top of this
list is no longer where it was):

- **#23** — a reused list binding silently mints a second `SOURCE_SERVER` list
  with its own field set. Newly first because it is the only open finding whose
  failure mode is *nothing renders*, with no build-time signal of any kind, on
  the page that is now the product. Three lines upstream: warn from
  `emitCreateList` when `uniqueName` renamed the base — but in wording that names
  `createList`, NOT `warnSignal`'s sentence verbatim, because this repo's own
  build gate already matches that sentence and routes it to the opposite
  remediation ("delete the twin", when the fix is "serve the suffix").
- **#19**+**#21** — no channel for server→island data that is not a slot value;
  inline props cannot be turned off (half (b) fixed and now proven at 479
  `slot_ids`); and the duplicate derivation that leaves is a measured flash
  rather than a theory. Still structural, still the deepest, but on `/nocturne`
  it is no longer the biggest number on the wire — see the 2026-08-26 table.
- **#22**+**#20(b)** — one family, not two entries. A wholly-literal
  concatenation becomes an anonymous slot instead of markup (#22, reproduced on
  a page that had never heard of it); a concatenation with any non-literal
  operand still becomes an empty island shell (#20(b), scoped and reopened).
  The ask for both is the same branch in `emitChild`.
- **#17 edge 3** — an unexpandable spread degrades to an island placeholder
  with no warning. Note that this is the SAME degradation as #20(b), reached by
  a different path, and the same build gate is the only thing catching it.
- **#3** — list names fall back to the map parameter and only reach positional
  `#N` when that parameter is `_`; document the real chain.
- **#5**/**#11**/**#15**/**#18** — docs asks: the SSR-with-server-data recipe,
  the per-item member-read contract, and now (from #22) adjacent literal
  children as a supported pattern, with its cursor-advance constraint.
- **#6** — create-app's `0.0.0.0` default.

The lesson from the 0.3.1 verification pass, worth more than any single
finding: **every guard in this ledger that was a build-log line turned out not
to be a guard.** The collision warning was real, correctly worded, and
completely ineffective, because it printed next to thirteen warnings this file
told the reader to ignore. What holds is an assertion that fails the gate — and
the assertion has to test the thing that matters (does the island RENDER this
slot?), not the thing that is easy to test (does the name exist?). The loop
works; keep feeding it.

**A second clause, earned the hard way on 2026-08-26: a guard that lives on a
page can be deleted with the page.** `/map` carried the assertions for #20 and
#22. `/map` was deleted on the 25th for good reasons that had nothing to do with
either finding, and on the 26th both failure modes reappeared on `/nocturne`
within hours of each other. The assertions did not fail — they were not there to
fail. So the invariant has to be **re-homed with the markup**: when a surface
moves, the guards that describe what the compiler does to that markup move with
it, and the ledger row's `Where` column has to move too or it becomes a
confident pointer at nothing. `/nocturne` still has the hole this argues about:
it asserts its slot classification, and it does not assert its island count.

**And the corollary for the ask list above.** #22 and #23 were both re-found by
an author who had never read this file, on a pinned toolchain that had not
moved. Every open entry here is therefore costed twice: once when it was found,
and again every time the surface is rewritten by someone who does not know it is
a known residue. That recurrence cost is the strongest part of the case
upstream, and it is the reason these asks are worth a three-line warning even
where the output is correct.
