# KSX Studio token system — design proposal

Status: **TK0 (single-source) implemented on `codex/studio-nocturne-workspace`, 2026-08-20 —
all gates green, token values verified identical; TK1–TK3 remain proposals.**
Measured against `codex/studio-nocturne-workspace`
on 2026-08-20 (studio.css @ 12,489 lines), then adversarially reviewed by three independent
passes (server seams / build+CI / completeness) against source; their confirmed findings are
folded in below. When implemented, the durable parts fold into `docs/DESIGN-SYSTEM.md` (M9
already schedules the token sections); the milestones slot into the plan ledger. Every
file:line here was read, not remembered.

## 1. What Victor asked for

A modern token design system for the Studio that:

1. makes **themes cheap** — Nocturne-style, Matrix-style, future palettes — switchable at
   runtime, not just by OS preference;
2. covers **component look and feel**, not just colors;
3. leaves **nothing hard-coded** — adding a palette later is data, not surgery;
4. **compiles ahead of time to plain CSS** with no runtime cost — the lightest thing that
   can work with Forma.

## 2. The decision in one paragraph

A **W3C-DTCG-flavored JSON token source** in `studio-ui/tokens/`, compiled by a **small
deterministic generator** (pure Node stdlib, ~250 lines, zero new dependencies) that
`build.mjs` runs before hashing. One source emits four artifacts: the token CSS (base theme
+ one `[data-theme]` block per theme, prepended into the hashed `studio.<hash>.css`), a
generated Rust module (theme registry + anti-flash CSS — kills three of the four palette
mirrors), the pad-sheet values inside `build.mjs` (kills the fourth), and a `themes.json`
manifest the browser suite reads. Theme switching is a server-stamped `data-theme`
attribute on `<html>`, persisted in `config.toml`, settable by a plain no-JS form POST.
Component CSS does not change: the 2,393 existing `var()` consumptions keep their names.

**Not Tailwind** (utility-class authoring model — a rewrite of 12.5k lines of CSS and every
class string in 17k+ lines of TS plus the Rust seams, for a theming mechanism that is CSS
variables anyway). **Not Sass** (adds a preprocessor but cannot emit the Rust/pad-sheet
mirrors, which are half the problem; native CSS custom properties already do the runtime
half). **Not Style Dictionary** (it is exactly this architecture as a dependency; our
output targets — a Rust const module, a `build.mjs` template, contrast-gate-parseable
CSS — would all be custom formats anyway, and the repo's dependency doctrine is three
`@getforma/*` packages and nothing else). Style Dictionary remains the documented
off-ramp: the DTCG source format is what it consumes, so migrating later is config, not
rewriting.

## 3. Where styling stands today (measured)

- `studio-ui/src/studio.css` is the only stylesheet: 455 custom-property definitions,
  2,393 `var()` uses, 47 `color-mix()` uses. Root-level tokens: 109 in §1 PRIMITIVES
  (lines 26–227), 40 tokens + `color-scheme` in the single
  `@media (prefers-color-scheme: light)` block (233–304), 13 role aliases in §2 (311–328).
- **The base app already obeys the token doctrine.** Outside the `.nocturne` §9 proof
  (6247–EOF, which "dies wholesale" at M5 per its own banner), exactly 2 hard-coded color
  literals exist in 6,200 lines: a `color-mix(... #000)` darkening at :1141 and a black
  shadow at :3064 — the mix-with-black class, effectively exempt. Every other literal
  occurrence (a couple hundred, by any counting rule) sits inside §9 and dies with it.
- `data-theme` appears **zero** times in the repo. Light is OS-preference only.
- The palette is mirrored in four places, all policed (unevenly) by
  `crates/ksx-studio/tests/contrast.rs`:
  1. `render.rs:285` `PERSONALITY_CSS` — the anti-flash `<style nonce>` (dark+light
     `--bg`/`--text`), used by 9 of 10 routes; a third `#120c1c` hides in a test literal
     at `render.rs:1215`.
  2. `render_map.rs:3301` — a byte-identical private copy for /map.
  3. `build.mjs:257` `PAD_SHEET` — 4 token values hand-mirrored into the `<img>` pad SVGs.
  4. `ksx-cabinet/src/theme.rs:117–170` — 13 byte-equal `Color32` constants + 2 deliberate
     divergences; **only `ACCENT` is cross-pinned** today, the other 12 can drift silently.
- The `--n-*` Nocturne chrome palette: 17 definitions (css:6376–6396), 376 uses, scoped
  under `.nocturne`, dark-only, **unpoliced by the contrast gate** (which stops reading at
  line 304). §9 also carries the 16-slot player identity machinery — `--pal1..16` +
  `-ink`/`-key` triads (48 defs), the `--pcs` slot-wearing layer (48), and the derived
  `--kb`/`--band-*`/`--mine`/`--badge-ink` plumbing (~330 further uses) — plus 4 dead
  `--np1..4` definitions with zero uses. The fold for all of it is §10.

## 4. Architecture

### 4.1 Source of truth: `studio-ui/tokens/`

```
studio-ui/tokens/
  core.json          # primitives: raw scales (purple ramp, teal ramp, type px, 4pt space,
                     #   radii, durations, easings, z, shadow recipes, hw button colors)
  semantic.json      # roles: every token components consume, aliasing core —
                     #   --bg, --panel ladder, --text tiers, --accent family, --cool,
                     #   status triads, --focus, --e-*, --ground, --fs-*, --r-*, --dur-* …
  themes/
    light.json       # the KSX light theme (today's 40-token media block, verbatim)
    …                # future: nocturne.json, matrix.json — one file per theme
  build-tokens.mjs   # the generator, imported by ../build.mjs
```

Format is DTCG-flavored (`$value`, `$type`, `$description`, `{core.…}` aliases) with one
pragmatic extension: every token carries an explicit **`cssName`** so the existing names
(`--bg`, `--fs-micro`, `--e-1`, `--hw-xbox-a`…) are preserved exactly — this is a
formalization, not a rename, and it is why component CSS does not churn. Where strict DTCG
fights us (shadow stacks, gradient grounds, `rgba()` tints) the `$value` is the raw CSS
string; the win we are buying is the single source and the mental model, not spec purity.

Three tiers, one rule each:

- **core** — raw values only, never referenced by component CSS, never themeable.
  (TK0 deviation, recorded: `core.json` shipped **empty** — the semantic tier
  carries today's values verbatim, and raws graduate to core the first time two
  tokens or two themes need to share one. Until then §4.2's core-resolution rule
  is vacuous.)
- **semantic** — the only tier components consume. Each token is tagged:
  - `themeable: true` — the palette contract every theme must fully provide (the 40-token
    light set plus `color-scheme` and the base-only extras: neutral ramp, text tiers,
    accent family, cool, status triads, focus, scrim/sel-tint, shadows, ground — ~45
    values);
  - `themeable: "optional"` — look-and-feel a theme MAY override: `--font-sans`, `--mono`,
    `--r-*`, `--dur-*`, `--ease-*`, and the player identity ramp — with the rule that the
    ramp is all-or-nothing: overriding it owes all 16 `--pal` triads (fill + ink + key,
    48 values), because the ink pairs are contrast-gated per slot;
  - untagged — never themeable: geometry (`--sp-*`, `--ctl-h*`, layout vars), `--z-*`,
    and `--hw-*` (physical hardware marking colors are facts, not style).
- **theme** — a value map over the themeable set. Themes are **token-only**: no theme may
  ship selectors or geometry. This is a hard line with a reason: the touch-target lint
  compares identical selector strings, so a higher-specificity per-theme rule would escape
  it silently (measured blind spot, `touch_targets.rs:202–239`) — and a theme that cannot
  touch geometry can never break the overflow, touch, or parity gates.

**What token-only themes can and cannot change — honestly.** A Matrix theme changing only
tokens genuinely lands the big moves: phosphor palette, square corners (`--r-*: 0`,
including `--r-pill`), a mono UI stack, a scanline `--ground` gradient, harder `--e-*`
shadows, snappier `--dur-*`. What it can NOT touch today, because these are literals in
component rules (measured): the frosted-glass blurs (`backdrop-filter` at css:463, :1953),
1px hairline border widths, `text-transform: uppercase` eyebrows and their literal
letter-spacings, disabled opacity 0.42, spinner/pulse micro-timings. If a theme ever needs
those axes, the fix is the doctrine's usual one — promote the literal to a semantic token
(`--blur-overlay`, `--bw-hairline`, `--tt-eyebrow` via `text-transform: var(--tt-eyebrow,
uppercase)`, …) in a small deliberate pass — not to let themes ship rules. The boundary is
recorded here so requirement 2 has a definite edge instead of a vibe.

### 4.2 The generator: deterministic by construction

`build-tokens.mjs` — pure stdlib, no deps, imported by `build.mjs`. Rules (the
byte-reproducibility gate is the oracle):

- **Determinism:** iterate source order; LF-only; trailing newline; no timestamps, no
  `Math.random`, no `Intl`/locale formatting. One JS subtlety, handled by convention:
  integer-like JSON keys iterate in ascending numeric order regardless of source order —
  so ramp steps use non-numeric keys (`p100`, not `100`).
- **Alias emission:** references to **core** resolve to literal values;
  **semantic-to-semantic** references (the §2 aliases — `--surface: var(--bg)`,
  `--radius: var(--r-lg)`, …) MUST emit as `var()` chains, never resolved — otherwise a
  theme overriding `--bg` silently stops reaching every `--surface` consumer while all
  gates stay green. A generator self-check asserts the emitted form per reference kind.
- **Syntax:** comments are `/* … */` only — a `//` line is not a CSS comment; per CSS
  error-recovery it merges into the next selector and the browser silently drops the
  entire following rule (i.e. the whole base `:root` block) while every gate stays green.
  Single-line `--name: value;` declarations throughout (the contrast gate's parser is
  line-based).
- **Validation, FATAL** exactly like `build.mjs`'s slot-collision class (all implemented
  at TK0, review-hardened): unknown alias, duplicate `cssName` (base tier AND within a
  theme file), a theme missing any required themeable token, a theme overriding an
  un-themeable token, a color-typed value that does not parse as hex/rgb(a),
  emission-safety (values single-line with no `;`/`{`/`}`, every comment/note exactly one
  clean `/* … */` block, descriptions without `*/`), the emitted-alias self-check
  (`var()` chains reach the sheet verbatim), and the authored-css scan — run on a
  comment-stripped copy, banning any `prefers-color-scheme` occurrence and any custom
  property in any `:root` block at any nesting, with exactly one allowlisted exception:
  the coarse-pointer `--ctl-h`/`--ctl-h-sm` re-ladder that `touch_targets.rs` requires on
  a bare `:root` (the first cut matched only column-0 `:root` and the canonical marker
  string; the review walked an indented `:root` and an `@media screen and (…)` variant
  straight past it).

### 4.3 Generated artifacts (one source, four outputs)

**(a) `studio-ui/src/tokens.gen.css`** — committed, `/* generated — do not edit */`
header, and prepended into the hashed sheet via the measured zero-patch mechanism:
`@getforma/build`'s `generateCss` natively accepts an array input joined with `\n`
(`index.js:48,53` — inputs are never validated/minified/watched, so the compose is clean),
so `build.mjs` changes to `cssEntries: [{ input: [tokensTmp, studioTmp], outfile:
"studio.css" }]`, both staged through the existing LF-normalizing mkdtemp block
(`build.mjs:80–86`). Contents, in order:

```css
:root { /* base theme (KSX dark) — full §1 primitives + §2 aliases */ }
@media (prefers-color-scheme: light) {
  :root:not([data-theme]) { /* system-follow light, only when no explicit theme */ }
}
:root[data-theme="dark"]  { /* explicit pin of the base values */ }
:root[data-theme="light"] { /* the 40 tokens + color-scheme — same source as the media
                               block above, so the two copies cannot drift */ }
/* future: :root[data-theme="nocturne"] { … }  :root[data-theme="matrix"] { … } */
```

§1, **the light media block**, and §2 are all deleted from studio.css, which then starts
at §3 BASE and must retain zero `:root`-level token declarations (generator-asserted);
the component-scoped definitions (`--page`, `--btn-h`, the coarse `:root` re-ladder at
:1308 that `touch_targets.rs` requires on bare `:root`) stay authored where they are —
interaction geometry, not theme.

**(b) `crates/ksx-studio/src/theme_tokens.rs`** — committed, generated. The freshness
oracle is the CI byte-diff (§4.4), not fmt: the `mod` declaration in lib.rs carries
`#[rustfmt::skip]` (an inner `#![rustfmt::skip]` in the file itself would be cleaner, but
custom inner attributes are unstable — rust #54726, measured on 1.97.1 during TK0) and
the generator emits rustfmt-clean, clippy-clean
code, because ksx-studio is inside `cargo fmt --check` and `clippy -D warnings`
(ci.yml:79–94) — note the icongen "committed generated output" precedent is binary
assets with no fmt exposure, so this contract is new and stated here. Exports:

- `pub(crate) const PERSONALITY_CSS: &str` — the anti-flash CSS: the dark base rules,
  the media-scoped light rules now guarded to un-stamped pages, then one
  `html[data-theme=X] body{…}` rule per theme (specificity 0,1,2 beats the media-scoped
  0,0,1 regardless of order — a stamped theme wins first paint even against the opposing
  OS scheme, the flash today's copy would show), **and `color-scheme` at every step**
  (`html{color-scheme:dark}`, the media/un-stamped counterpart, one
  `html[data-theme=X]{color-scheme:…}` per theme from the theme's `scheme` metadata) —
  otherwise scrollbars and form controls first-paint in the OS scheme while the sheet is
  pending, the same flash class at smaller scale. `render.rs` re-exports it;
  `render_map.rs`'s private byte-copy is deleted. Because `contrast.rs` is an integration
  test that cannot see a `pub(crate)` const, its anti-flash pin retargets to
  `include_str!("../src/theme_tokens.rs")` with the same whitespace-stripped substring
  match — which obliges the generator to emit each pinned rule as an unbroken string
  literal (no concat seams or line-continuations mid-rule).
- `pub(crate) struct ThemeMeta { id, label, scheme }` and
  `pub(crate) const THEMES: &[ThemeMeta]` — the registry. The server validates the
  settings POST against it, `/setup` renders the picker from it, the render path stamps
  from it. Adding a theme never touches hand-written Rust.

**(c) PAD_SHEET values** — `build.mjs` templates the four hand-mirrored values
(`--text-3` ×2, `--panel-2`, `--text-2`) from the in-memory token object into the sheet
it injects into the vendored SVGs (the four bespoke art colors stay literal on purpose —
the contrast test deliberately does not pin them, contrast.rs:763–766). This removes the
hex literals from `build.mjs` source, so the pad-art test **cannot** keep parsing
`build.mjs` (and its unanchored `find('#')` grab would mis-read silently rather than
panic): the test evolves to parse the **committed emitted assets** instead —
`include_str!("../assets/pad-xbox.svg")`'s injected `<style>` block — which cross-verifies
the whole chain generator → build.mjs → shipped SVG and is already freshness-gated by the
CI assets diff.

**(d) `assets/themes.json`** — id/label/scheme plus each theme's resolved `--bg`/`--text`,
written by `build.mjs` alongside the pad SVGs (unhashed — `hashAssets` filters to
.js/.css/.wasm/.ir — and auto-covered by the CI byte-diff). The visual suite reads it to
assert the **painted** theme, not just the media emulation.

### 4.4 Freshness gates for the committed generated files

Extend the two existing CI reproducibility steps (`ci.yml:62–77, 173–188`) — the
`git diff --exit-code` / untracked-files pair, which are the complete set (the release job
never rebuilds studio assets) — to also cover `studio-ui/src/tokens.gen.css` and
`crates/ksx-studio/src/theme_tokens.rs`. Same invariant, same fix command
(`cd studio-ui && node build.mjs`, commit), same CLAUDE.md rule that already exists for
assets — extended at TK0 to name both new paths. `.gitattributes` covered
`studio-ui/src/**` already; the `theme_tokens.rs` and `studio-ui/tokens/**` `eol=lf`
rules were **added at TK0** (the file had only `* text=auto`, so Windows checkouts would
have materialized it CRLF). Nothing in the repo globs `src/*.css`, so the committed copy
is inert until explicitly wired.

## 5. Theme switching at runtime

### 5.1 The stamp: `data-theme` on `<html>`, server-side

forma-server 0.2.0 hardcodes `<html lang="en">` in both render phases (template.rs:261,
:315 — byte-identical, every phase-2 failure arm falls back to phase 1, and no other
`<html` producer exists anywhere in crates/: guard bodies are plain text, flash flows are
bodyless 303s). `PageConfig` has no root hook (full field list, `render.rs:827–844`). Two
options, both sanctioned:

- **Now:** a `with_icon_links`-style post-render splice (the crate's established seam,
  `render.rs:152–158`): find `<html lang="en">`, insert ` data-theme="…"` when the
  preference is a named theme. All 10 routes funnel through
  `with_icon_links(render_page(…))` (verified at all 10 call sites), so one shared wrapper
  covers every page — guarded by a new `assert_complete_head`-style oracle asserting the
  stamp on every route.
- **Later:** add `html_attrs` to `PageConfig` upstream — the Forma breaking-change policy
  allows it (ksx is the only consumer) and `render.rs:131–139` already says splices
  migrate upstream the moment a real hook exists.

Why `<html>` rather than the already-templated `body_class`: not impossibility (body-side
`color-scheme` could be made to work via used-value propagation or `:root:has(…)`, which
the sheet already uses elsewhere) but composition — all 455 token definitions and the
system-follow guard `:root:not([data-theme])` live on `:root`, so the attribute belongs on
the element the selectors already target, and the pinned-block/media-guard structure of
§4.3a falls out with no selector rewrites.

**The plumbing the wrapper needs (new, and honestly the bulk of TK2):** no render site
reads settings today — `with_icon_links` takes only a `PageOutput`, the page handlers
never touch config.toml, and `SetupView`/`MachineCache` carry no theme. TK2 threads a
per-request theme value to the wrapper: a cheap config read per page GET (navigation-rate,
not poll-rate; `/api/*` JSON needs none) or a theme slot on `AppState` invalidated by the
existing non-GET layer. All 10 call sites change signature; the route oracle is the guard
against missing one. `/setup` additionally surfaces the current value + roster for the
picker.

**Stamp-time sanitization:** the POST validates against `THEMES`, but `/setup/import`
writes `Settings` wholesale and config.toml is hand-editable — and an unknown stamped id
would defeat the `:root:not([data-theme])` guard (a light-OS user silently gets base
dark, and no anti-flash rule matches). So the wrapper stamps only ids found in `THEMES`;
anything else renders as System, with a warning (import may also flash it).

"System" = no attribute → the media block decides, exactly today's behavior. Explicit
theme = attribute present → that theme's block wins in both OS schemes.

### 5.2 Persistence: `config.toml`, like every other setting

A `theme: Option<String>` field on `Settings` (`ksx-config/src/config.rs:32–67`,
`#[serde(default)]`). `None`/absent = System. Verified compatible both ways with one
caveat: no `deny_unknown_fields` on `ConfigFile`/`Settings` and both TOML and JSON loads
are lenient, so an older binary reads past the field (UnknownKey warning) — but an older
binary that *saves* drops the key, so a version rollback quietly forgets the theme
choice; acceptable, recorded. Export/import shares the exact serde types
(interop.rs:168–180), so the field flows through `/setup` export/import with zero interop
code. Flow is the house pattern: plain form POST `/setup/theme` → registered with its
siblings before the two `.layer()` calls, so the global Origin-check CSRF guard
(`guard.rs`) and cache-invalidation cover it automatically → 303 with `?flash=` → next
render stamps the new theme. **Works with JavaScript disabled**, which is the Studio's
doctrine; the island may progressively enhance by also flipping the attribute live.
No cookies (the server reads none today — keep it that way), no localStorage-first flash,
no nonce-less boot script (the CSP would block it silently — measured trap,
`http.rs:2217–2237`).

### 5.3 The picker

`/setup` grows a theme control rendered from `THEMES` (radio: System, then each label) —
it is the settings surface. The workspace header's Tools menu can carry a shortcut later;
that is polish, not architecture.

## 6. What each theme costs

A new theme is: **one JSON file** (~45 required values + optional look-and-feel
overrides; overriding the player ramp adds the full 48-value triad set) **+ its contrast
entries** (pass the floors or record pinned exemptions — DESIGN-SYSTEM §13 rule 7 already
governs this; exemptions are rows in the test-side pin table, so "no code" precisely
means no *shipped* Rust/TS/CSS edits) **+ one rebuild commit**. Weight: each compiled
theme block is ~1.5–2 KB raw, brotli'd inside the one hashed sheet (the framework already
emits `.br`/`.gz`); zero runtime JS; zero request cost. The sheet stays a single static
asset under the same nonce-CSP.

## 7. Gate evolution (every gate measured, every change named)

| Gate | Today | Change required |
|---|---|---|
| Byte-reproducibility (ci.yml ×2) | diff on `assets/` | extend paths to the two committed generated files (§4.4); otherwise just the usual rebuild-and-commit on token edits |
| Contrast `contrast.rs` | hardcodes 2 themes; `split_themes` cuts at the first light-media marker; blind after css:304 | **TK0 repoints, TK1 rewrites.** TK0: the CSS input becomes `concat!(include_str!(tokens.gen.css), include_str!(studio.css))` — under the first-marker split the dark scan region becomes the generated base `:root` and everything else stays outside, so the v1 parser's semantics survive unchanged (verified against the parser). TK1: `themes()` learns to enumerate base + media block + every `:root[data-theme=X]` block; all pair checks run per theme; pinned exemptions become a per-theme table; a new theme passes floors or records its pins. This finally polices every theme, where today anything after css:304 ships unmeasured |
| Anti-flash pin (contrast.rs:653) | substring-matches render.rs AND render_map.rs source | TK0: retarget to `include_str!` of generated `theme_tokens.rs` (render_map entry dropped with its copy); TK1: derive per-theme expected strings **including the `color-scheme` rules** — a cross-check that generated Rust agrees with generated CSS |
| Pad-art pin (contrast.rs:692) | parses `build.mjs` source hex by occurrence | TK0: reparse from the committed emitted SVGs' injected `<style>` (§4.3c — the source literals vanish and the old grab mis-reads silently, so this is forced, not optional); separation floors unchanged. **Honest limit:** the pad SVGs render in `<img>` — their own documents — so they can never see `data-theme`; whether the embedding element's used `color-scheme` propagates into the image's `prefers-color-scheme` (the CSSWG-resolved behavior) must be **measured in TK2** — if it propagates, scheme-correct art falls out of the stamp; if not, per-scheme art variants or inlining, decided then |
| Touch targets | coarse ladder must sit on bare `:root`; lint compares identical selectors | nothing — token-only themes are inert to both tests, and the geometry ban (§4.1) keeps it that way permanently |
| Cabinet accent pin | first `--accent:` line in studio.css wins | TK0 (forced — after the move studio.css has no `--accent:` line and the pin panics loud): point at `tokens.gen.css`'s base block by name, and extend the cross-pin from 1 constant to all 13 byte-equal roles, closing the measured drift hole; the cabinet keeps mirroring the default theme — deliberately not theme-aware |
| SSR/hydration parity | serializes island subtree only | nothing — the `<html>` stamp is outside the comparison (measured: no client code writes root attributes; @getforma/core's documentElement touches are observe/closest reads) |
| Visual smoke | theme via `colorScheme` emulation; asserts the emulation, not the paint | fixture grows a theme env knob (the `KSX_FIXTURE_SESSION` precedent — the fixture fabricates state and reads no config.toml); contexts gain a stamped-theme cell per shipped theme asserting `getComputedStyle(body).backgroundColor` equals `themes.json`'s `--bg` **and the `html[data-theme]` attribute itself** (the dark cell's pinned values are byte-identical to base, so the paint alone cannot detect a missing stamp) |
| CSP / head oracle | style-src nonce-locked; head splice pinned | new oracle pins the `data-theme` splice on all routes; no CSP change of any kind |

## 8. Migration milestones

Ordering: **TK0 lands before the M5 cutover** — no visual change, and it hands M5 a
formal token source to cut onto (it also shrinks M5's "extraction before deletion" step by
deleting the render_map mirror early). TK1 can ride with M5. TK2/TK3 follow.

- **TK0 — single-source (M, ~2 days).** Token JSON capturing today's exact values;
  generator; `cssEntries` array prepend; **§1 + the light media block + §2** move out of
  studio.css (zero `:root`-level tokens remain, generator-asserted). The forced test
  repoints land here, not TK1: contrast's CSS input → the two-file concat; anti-flash pin
  → `theme_tokens.rs`; pad-art pin → the emitted SVGs; cabinet pin → named base block,
  extended 1→13. `theme_tokens.rs` generated (PERSONALITY_CSS, rustfmt-skipped at the
  mod declaration,
  render_map copy deleted, `render.rs:1215` test literal repointed); PAD_SHEET templated;
  ci.yml paths extended; the two stray literals adjudicated (mix-with-black — keep, with
  a comment) and `css:9791`'s `accent-color: #968ae0` → `var(--n-accent)` (or dies at
  M5); the dead `--np1..4` deleted. Acceptance: identical token set and values —
  contrast green with zero ratio changes, visual suite green, one asset-hash churn, fresh
  rebuild byte-identical twice.
- **TK1 — contrast gate v2 (S, well under a day now that TK0 carries the repoints).**
  Multi-theme enumeration + per-theme pin table; `themes.json` emitted; still exactly the
  two shipped themes, now enumerated instead of hardcoded.
- **TK2 — the switch (M, ~2 days).** `Settings.theme` + POST `/setup/theme` + picker;
  the per-request theme read threaded to the wrapper (all 10 call sites — §5.1) + the
  `<html>` splice with stamp-time sanitization + route oracle; light becomes
  `themes/light.json` emitting both the `[data-theme=light]` block and the media fallback
  from one source; per-theme anti-flash **with `color-scheme`**; visual-smoke theme axis;
  the pad-art `color-scheme` propagation measurement (§7). Acceptance: switching works
  no-JS; with the stylesheet request blocked, first paint matches the stamped theme in
  background, text, **and color-scheme**; all gates green.
- **TK3 — the proof theme (S per theme).** Ship `matrix.json` (or `nocturne.json`, §10):
  one JSON file + contrast entries, zero component edits. This milestone existing is the
  point of the whole system.

## 9. Risks and standing traps

- **"Gate green, output wrong" class — three specific instances found in review, now
  designed out but worth keeping named:** a `//` header in generated CSS silently drops
  the whole base `:root` in every browser (no gate catches it — hence §4.2's `/* */`
  rule); a light media block accidentally left in studio.css would sit later in the
  cascade and pin ~40 tokens to stale values while the v1 parser reads only the first
  marker (hence the zero-`:root`-tokens assertion); the pad test's unanchored `find('#')`
  grab mis-reads a neighboring color rather than failing (hence reparsing the emitted
  SVG).
- **The contrast parser's assumptions are load-bearing** (first-marker split, line-based
  tokens, whitespace-stripped substring pins — which additionally require the generator to
  emit pinned rules as unbroken string literals). TK0/TK1 change it deliberately and
  loudly; the concat keeps v1 semantics intact in between.
- **Generated committed Rust is a new contract:** it must simultaneously satisfy the CI
  byte-diff, `cargo fmt --check`, and `clippy -D warnings` — `#[rustfmt::skip]` on the
  mod declaration (the inner form is unstable, rust #54726) + rustfmt-clean emission +
  clippy-clean emission, with the byte-diff as the one oracle. (The icongen precedent is
  binary assets; it never faced fmt.)
- **Node determinism**: the pin (20.19.0) lives only in ci.yml; the generator avoids
  ICU/locale/time and uses non-numeric ramp keys (integer-like JSON keys reorder). The
  git-diff gate is the backstop.
- **CRLF**: generated files are born LF; `studio-ui/src/**` was already `eol=lf` and
  TK0 added the `crates/ksx-studio/src/theme_tokens.rs` + `studio-ui/tokens/**` rules;
  the include_str! parsers trim lines. (CI was once red 57 runs over a CRLF assumption.)
- **The `--n-panel-3` fourth elevation step** (zebra/hover ground) has no KSX equivalent —
  the base ladder tops out one step short. M5 either reuses `--panel-3` or the semantic
  tier grows a step; decide once, in the token source, and note the ladder-direction trap:
  Nocturne ascends panel→panel-2→panel-3 while KSX's `--panel-2` is the *recessed* step.
- **Service worker / caching**: nothing to do — verified: the cache name derives from the
  build hash, HTML is no-store, hashed sheet URLs roll automatically.

## 10. The §9 fold, and Nocturne-as-a-theme (open decision)

**The 17 `--n-*` chrome tokens** map onto KSX roles (all values verified):
`--n-bg→--bg`, `--n-panel→--panel`, `--n-panel-2→--panel-3` (raised step; ladder trap
above), `--n-panel-3→` (new step or reuse), `--n-line→--line`/`--line-soft`,
`--n-line-2→--line-strong`, `--n-text/-2/-3→--text/-2/-3`, `--n-accent→--accent` (teal)
for interaction / `--cool` for identity per the doctrine, `--n-accent-2→--accent-strong`,
`--n-accent-tint→--accent-dim`, `--n-accent-dim→--accent-dim-2`,
`--n-accent-line→--cool-line` (value) / `--accent-line` (role), `--n-warn→--warn`
(byte-identical already), `--n-danger→--danger` (largest visual delta — a real change),
`--n-danger-line→--danger-line`.

**The identity machinery is a second, larger fold the chrome table does not cover:** at
M5 the 16-slot system — `--pal1..16` fill/ink/key triads and the `--pcs` slot-wearing
layer — graduates into the semantic tier (the token source gets a `player` group; the
`--kb`/`--band-*`/`--mine`/`--badge-ink` plumbing stays authored component CSS consuming
it). Two deliberate boundaries: the `-key` lift values are theme data, not derived (they
were hand-calibrated per color); and the runtime user color pick — which overrides
`--pcs{N}` on the island root from browser-kept state (css:6266–6267) — is **out of theme
by design**: a user's chosen slot colors survive a theme switch. Say so in the picker UI
docs when we get there.

**TS-side art:** the workspace schematics are in-document SVG (unlike the `<img>` pads),
so they can consume `var()` directly. The nxg-lamp gradient stops
(`NocturneIsland.ts:4082–4084` — the blurple accent baked in) and the face-button fills
that duplicate the `--hw-xbox-*` roles with different values fold onto tokens at TK0 or
with M4's schematic port; the ~35 vendored carbon silhouette greys stay literal like the
pad art's bespoke colors, as a recorded exemption. (No other src/*.ts file carries color
literals — verified.)

**Nocturne-as-a-theme.** The plan's doctrine is "recolor, not retheme" and the prototype
palette "dies wholesale" at M5. This design keeps that as the default path — and opens a
door the plan could not: the prototype's blue-slate/blurple look could survive as an
optional `themes/nocturne.json` instead of being deleted, since after M5 the components
consume only semantic tokens. Cost of taking the door: the prototype palette is currently
unpoliced by any contrast gate and would need value nudges to pass v2 (e.g.
`--n-danger #e79aa6` was never measured). It is Victor's call at M5; the token system
makes both outcomes one JSON file apart, which is precisely the property he asked for.

## 11. Decisions Victor owns

1. Theme ids and the default's name (`dark`/`light` + named skins is the proposal).
2. Nocturne-as-a-theme (keep the prototype palette alive, contrast-fixed) vs.
   plan-of-record deletion at M5 — §10.
3. The fourth elevation step: new semantic token vs. `--panel-3` reuse — §9.
4. **Theme fonts.** The CSP already permits self-hosted fonts (`font-src 'self'`, and
   `@getforma/build` has fontDir/copyFonts support) — but the token-only rule means a
   theme cannot ship `@font-face`. Either themes stay system-stack-only (reordering
   `--font-sans`/`--mono` — a real limit, stated), or the generator grows a per-theme
   `fonts` field that emits `@font-face` into the base sheet and copies the files through
   the build's font path. Ties into the earlier self-hosted-Inter discussion; decide when
   a theme first wants a face.
5. Whether the look-and-feel token growth set (§4.1: `--blur-*`, `--bw-hairline`,
   `--tt-eyebrow`, tracking/weight) lands with TK3's first theme or waits for a theme
   that needs it.
6. Whether TK2's picker also gets a header shortcut now or at M6–M8 polish.
7. Timing: TK0 before M5 (recommended) vs. after.
