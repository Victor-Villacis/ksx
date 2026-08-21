// The token compiler — studio-ui/tokens/ is the single source of the palette.
//
// Reads core.json + semantic.json + themes/*.json and emits, deterministically:
//
//   1. src/tokens.gen.css        — the token CSS prepended into the hashed
//                                  studio.<hash>.css (build.mjs cssEntries
//                                  array input; @getforma/build joins inputs
//                                  with "\n" before hashing);
//   2. crates/ksx-studio/src/theme_tokens.rs — the generated Rust module
//                                  (anti-flash PERSONALITY_CSS today; the
//                                  theme registry arrives with TK2);
//   3. an in-memory resolver build.mjs templates the pad-art sheet from.
//
// One source, so the four palette mirrors the contrast gate polices cannot
// drift — see docs/research/token-system-design.md (§4) for the design and
// the review-caught traps this file encodes:
//
//   - Comments in emitted CSS are `/* … */` ONLY. A `//` line is not a CSS
//     comment: per CSS error recovery it merges into the next selector and
//     the browser silently drops the entire following rule — the whole base
//     :root — while every gate stays green.
//   - Declarations are emitted single-line: crates/ksx-studio/tests/
//     contrast.rs parses `--name: value;` line by line.
//   - References to other SEMANTIC tokens stay `var()` chains, never
//     resolved — resolving one would disconnect every alias consumer from
//     theme overrides with no gate noticing.
//   - Determinism: source-order iteration over arrays (no object-key
//     ordering), LF-only output, no timestamps/locale/randomness. The CI
//     byte-diff over the committed outputs is the oracle.
//
// Validation failures THROW — a broken token source must stop the build
// (build.mjs treats that like a slot-name collision: fatal), not ship a
// sheet missing its palette.

import { readFileSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(join(HERE, p), "utf8"));

/** The light-theme media marker. contrast.rs's split_themes() finds this
 *  exact string; it must appear in the generated CSS and NOWHERE in the
 *  authored studio.css, or the gate silently measures the wrong block. */
const LIGHT_MARKER = "@media (prefers-color-scheme: light) {";

/** The base theme — the bare `:root` values themselves. Not a themes/*.json
 *  file: every theme is an overlay on it. Its id/label sit here so the theme
 *  roster has exactly one authoring point. */
const DEFAULT_THEME = { id: "dark", label: "Dark", scheme: "dark" };

export function buildTokens({ authoredCss }) {
  const core = readJson("core.json");
  const semantic = readJson("semantic.json");
  const themeFiles = readdirSync(join(HERE, "themes")).filter((f) => f.endsWith(".json"));
  themeFiles.sort(); // byte order — locale-free, stable across machines
  const themes = themeFiles.map((f) => readJson(join("themes", f)));

  // ── emission-safety validation ───────────────────────────────────────────
  // Everything here guards the "gate green, output wrong" class: the emitted
  // CSS is parsed line-by-line by two Rust tests and rule-by-rule by the
  // browser, so a value with a newline/brace, a note that is not one clean
  // /* */ block, or a description carrying `*/` would corrupt the sheet
  // while every line-based gate keeps reading the tokens around it.
  const validComment = (text, where) => {
    const t = text.trim();
    if (!t.startsWith("/*") || !t.endsWith("*/") || t.slice(2, -2).includes("*/")) {
      throw new Error(
        `tokens: ${where} must be exactly one /* … */ comment block ` +
          "(a '//' line is NOT a CSS comment — it merges into the next selector " +
          "and the browser silently drops the whole following rule)",
      );
    }
  };
  const validEntry = (e, where) => {
    if (e.comment !== undefined) {
      validComment(e.comment, `${where} comment`);
      return;
    }
    if (typeof e.$value !== "string" || /[\r\n]/.test(e.$value) || /[;{}]/.test(e.$value)) {
      throw new Error(
        `tokens: ${e.cssName} (${where}) must be a single-line value with no ';'/'{'/'}' ` +
          "— the contrast gate parses declarations line by line",
      );
    }
    if (e.$description && (/[\r\n]/.test(e.$description) || e.$description.includes("*/"))) {
      throw new Error(`tokens: ${e.cssName} (${where}) $description must be one line without '*/'`);
    }
    if (
      e.$type === "color" &&
      !/^(#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?|rgba?\([\d\s.,%]+\))$/.test(e.$value)
    ) {
      throw new Error(
        `tokens: ${e.cssName} (${where}) is typed 'color' but '${e.$value}' does not ` +
          "parse as hex/rgb()/rgba()",
      );
    }
  };

  // ── collect + validate the base tier ─────────────────────────────────────
  const base = new Map(); // cssName -> entry
  const blocks = [
    { name: "core", tokens: core.tokens },
    ...semantic.blocks.map((b) => ({ name: b.name, note: b.note, tokens: b.tokens })),
  ];
  for (const b of blocks) {
    if (b.note) validComment(b.note, `block '${b.name}' note`);
    for (const e of b.tokens) {
      validEntry(e, `block '${b.name}'`);
      if (!e.cssName) continue;
      if (base.has(e.cssName)) {
        throw new Error(`tokens: duplicate cssName ${e.cssName} (in block '${b.name}')`);
      }
      base.set(e.cssName, e);
    }
  }
  const assertRefsExist = (value, where) => {
    for (const m of value.matchAll(/var\((--[\w-]+)/g)) {
      if (!base.has(m[1])) {
        throw new Error(`tokens: ${where} references ${m[1]}, which is not defined`);
      }
    }
  };
  for (const [name, e] of base) assertRefsExist(e.$value, name);

  // ── validate themes: complete over themeable:true, nothing beyond ────────
  const required = [...base.values()].filter((e) => e.themeable === true).map((e) => e.cssName);
  for (const t of themes) {
    if (!t.id || !t.label || !["dark", "light"].includes(t.scheme)) {
      throw new Error(`theme '${t.id ?? "?"}': id, label and scheme (dark|light) are required`);
    }
    if (t.id === DEFAULT_THEME.id) {
      throw new Error(`theme id '${t.id}' is the base theme — overlays must use their own id`);
    }
    if (!/^[a-z][a-z0-9-]*$/.test(t.id)) {
      throw new Error(
        `theme id '${t.id}' must be a lowercase css-ident ([a-z][a-z0-9-]*) — it is ` +
          "stamped into a data-theme attribute selector",
      );
    }
    if (t.note) validComment(t.note, `theme '${t.id}' note`);
    const names = t.tokens.filter((e) => e.cssName).map((e) => e.cssName);
    for (const n of names.filter((n, i) => names.indexOf(n) !== i)) {
      throw new Error(`theme '${t.id}': duplicate cssName ${n} — last-wins would hide the first`);
    }
    const provided = new Set(names);
    const missing = required.filter((n) => !provided.has(n));
    if (missing.length) {
      throw new Error(
        `theme '${t.id}' is not a complete palette — missing ${missing.length} ` +
          `required token(s): ${missing.join(", ")}`,
      );
    }
    for (const e of t.tokens) {
      validEntry(e, `theme '${t.id}'`);
      if (!e.cssName) continue;
      const b = base.get(e.cssName);
      if (!b) throw new Error(`theme '${t.id}' overrides unknown token ${e.cssName}`);
      if (b.themeable !== true && b.themeable !== "optional") {
        throw new Error(
          `theme '${t.id}' overrides ${e.cssName}, which is not themeable ` +
            "(geometry, z-order and hardware marking colors are facts, not style)",
        );
      }
      assertRefsExist(e.$value, `theme '${t.id}' ${e.cssName}`);
    }
  }

  // ── validate the authored stylesheet stayed token-free ───────────────────
  // The "two light blocks" trap: a :root token block or a second
  // prefers-color-scheme query left in studio.css would sit later in the
  // cascade and shadow the generated tokens while contrast.rs (which reads
  // only the FIRST marker) stays green. Both checks run on a comment-stripped
  // copy and are shape-tolerant — the first cut of this tripwire matched only
  // the canonical marker string and column-0 `:root`, which an
  // `@media screen and (prefers-color-scheme…)` or an indented :root walked
  // straight past (review-caught).
  const strippedCss = authoredCss.replace(/\/\*[\s\S]*?\*\//g, "");
  if (strippedCss.includes("prefers-color-scheme")) {
    throw new Error(
      "src/studio.css contains a prefers-color-scheme media query — theme " +
        "blocks live only in the token source (studio-ui/tokens/); a leftover " +
        "would shadow the generated tokens with every gate green",
    );
  }
  // Every :root block, at any nesting: the only custom properties allowed in
  // the authored sheet are the coarse-pointer control re-ladder, which
  // touch_targets.rs requires on a bare :root inside @media (pointer: coarse)
  // and which is interaction geometry, not theme.
  const ROOT_ALLOWED = new Set(["--ctl-h", "--ctl-h-sm"]);
  let rootAt = 0;
  while ((rootAt = strippedCss.indexOf(":root", rootAt)) !== -1) {
    const open = strippedCss.indexOf("{", rootAt);
    if (open === -1) break;
    let depth = 1;
    let i = open + 1;
    while (i < strippedCss.length && depth > 0) {
      if (strippedCss[i] === "{") depth += 1;
      else if (strippedCss[i] === "}") depth -= 1;
      i += 1;
    }
    for (const m of strippedCss.slice(open + 1, i - 1).matchAll(/(--[\w-]+)\s*:/g)) {
      if (!ROOT_ALLOWED.has(m[1])) {
        throw new Error(
          `src/studio.css declares ${m[1]} on a :root block — token ` +
            "declarations live only in the token source (studio-ui/tokens/); " +
            "the sole exception is the coarse-pointer --ctl-h/--ctl-h-sm re-ladder",
        );
      }
    }
    rootAt = i;
  }

  // ── emit CSS ─────────────────────────────────────────────────────────────
  const emitEntry = (e, indent) => {
    if (e.comment !== undefined) return `${e.comment}\n`;
    const desc = e.$description ? ` /* ${e.$description} */` : "";
    return `${indent}${e.cssName}: ${e.$value};${desc}\n`;
  };
  let css =
    "/* Generated by studio-ui/tokens/build-tokens.mjs — DO NOT EDIT.\n" +
    "   Source of truth: studio-ui/tokens/ (core.json, semantic.json, themes/).\n" +
    "   Regenerate: cd studio-ui && node build.mjs — CI pins this file to a\n" +
    "   fresh build alongside crates/ksx-studio/assets. Prepended to studio.css\n" +
    "   at build time; design record: docs/research/token-system-design.md */\n";
  for (const b of semantic.blocks) {
    css += "\n";
    if (b.note) css += `${b.note}\n`;
    css += ":root {\n";
    for (const e of b.tokens) css += emitEntry(e, "  ");
    css += "}\n";
    // The system-follow light theme rides directly after the base theme
    // block, exactly where studio.css carried it: guarded to un-stamped
    // pages so an explicit data-theme choice (TK2) wins in both OS schemes.
    if (b.name === "theme-base") {
      for (const t of themes.filter((x) => x.scheme === "light")) {
        css += "\n";
        if (t.note) css += `${t.note}\n`;
        css += `${LIGHT_MARKER}\n  :root:not([data-theme]) {\n`;
        for (const e of t.tokens) css += emitEntry(e, "    ");
        css += "  }\n}\n";
      }
    }
  }
  if (css.indexOf(LIGHT_MARKER) !== css.lastIndexOf(LIGHT_MARKER)) {
    throw new Error("tokens.gen.css must carry exactly one light media block until TK1");
  }
  // Self-check the alias-emission rule: a semantic-to-semantic reference must
  // reach the sheet as its var() chain, never resolved — resolving one would
  // disconnect every alias consumer from theme overrides with no gate
  // noticing. Trivially true of today's verbatim emission; this pin is the
  // tripwire against a future refactor that starts resolving.
  for (const [name, e] of base) {
    if (e.$value.includes("var(") && !css.includes(`${name}: ${e.$value};`)) {
      throw new Error(
        `tokens: ${name} is a var() alias but its chain was not emitted verbatim — ` +
          "semantic-to-semantic references must never be resolved",
      );
    }
  }

  // ── the resolver (base + per-theme overlay), for the pad sheet + Rust ────
  const resolved = new Map([["dark", new Map([...base].map(([n, e]) => [n, e.$value]))]]);
  for (const t of themes) {
    const m = new Map(resolved.get("dark"));
    for (const e of t.tokens) if (e.cssName) m.set(e.cssName, e.$value);
    resolved.set(t.id, m);
  }
  const resolve = (theme, name) => {
    const m = resolved.get(theme);
    if (!m) throw new Error(`unknown theme '${theme}'`);
    if (!m.has(name)) throw new Error(`unknown token '${name}'`);
    return m.get(name);
  };

  // ── emit the Rust module ─────────────────────────────────────────────────
  // Also exported as resolveHex for the pad sheet: an <img> SVG resolves no
  // custom properties, so a value that is legally a var() chain elsewhere
  // would ship inert there — consumers that need a literal must say so.
  const hex = (theme, name) => {
    const v = resolve(theme, name);
    if (!/^#[0-9a-f]{6}$/.test(v)) {
      throw new Error(`${theme} ${name} must resolve to a 6-digit hex literal, got '${v}'`);
    }
    return v;
  };
  // One unbroken string literal per rule: tests/contrast.rs pins this by
  // whitespace-stripped substring over THIS FILE's source, so a concat seam
  // or line-continuation inside a rule would defeat the match.
  const personality =
    `body{background:${hex("dark", "--bg")};color:${hex("dark", "--text")};margin:0}` +
    `@media (prefers-color-scheme:light){body{background:${hex("light", "--bg")};color:${hex("light", "--text")}}}`;
  const rustModule =
    "// Generated by studio-ui/tokens/build-tokens.mjs — DO NOT EDIT.\n" +
    "// Source of truth: studio-ui/tokens/; regenerate: cd studio-ui && node build.mjs\n" +
    "// CI pins this file to a fresh build alongside crates/ksx-studio/assets\n" +
    "// (ci.yml \"Studio assets reproduce from registry dependencies\").\n" +
    "//\n" +
    "// lib.rs declares this module `#[rustfmt::skip]` (an INNER #![rustfmt::skip]\n" +
    "// here would be cleaner but custom inner attributes are unstable, rust\n" +
    "// #54726); the emitted code is kept rustfmt-clean anyway, so the byte-diff\n" +
    "// gate and `cargo fmt --check` cannot wedge against each other.\n" +
    "\n" +
    "/// Inline `<style nonce>` CSS applied before the stylesheet arrives (the\n" +
    "/// anti-flash trick): the body first-paints on the studio ground instead of\n" +
    "/// flashing white. Derived from the `--bg`/`--text` tokens in\n" +
    "/// `studio-ui/tokens/`, both schemes — the same source `tokens.gen.css` is\n" +
    "/// compiled from, so the copy CANNOT drift; `tests/contrast.rs` cross-pins\n" +
    "/// it anyway (a wrong anti-flash color looks exactly like the flash it\n" +
    "/// exists to prevent, so it gets a loud gate rather than trust).\n" +
    "pub(crate) const PERSONALITY_CSS: &str =\n" +
    `    "${personality}";\n`;

  // ── the theme roster, for the browser suite (and later the picker) ───────
  // Written into assets/ by build.mjs (unhashed — hashAssets touches only
  // .js/.css/.wasm/.ir — and auto-covered by the CI byte-diff). Each entry
  // carries the resolved ground/text anchors so a test can assert the PAINTED
  // theme instead of trusting a media-query emulation.
  const roster = [DEFAULT_THEME, ...themes.map((t) => ({ id: t.id, label: t.label, scheme: t.scheme }))];
  const themesJson =
    JSON.stringify(
      {
        themes: roster.map((t) => ({
          ...t,
          bg: hex(t.id, "--bg"),
          text: hex(t.id, "--text"),
        })),
      },
      null,
      2,
    ) + "\n";

  return { css, rustModule, themesJson, resolve, resolveHex: hex };
}
