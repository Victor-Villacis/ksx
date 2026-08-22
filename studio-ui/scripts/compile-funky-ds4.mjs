import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(HERE, "../src/ds4PremiumGeometry.ts");
const VARIANTS = [
  { slug: "jet-black", label: "Jet black", swatch: "#242428" },
  { slug: "glacier-white", label: "Glacier white", swatch: "#e4e4e6" },
  { slug: "magma-red", label: "Magma red", swatch: "#d42323" },
  { slug: "midnight-blue", label: "Midnight blue", swatch: "#223350" },
];
const OMITTED = new Set([14, 22, 24, 32, 34, 42, 49, 56, 63]);
const PAID_TRANSFORM = "matrix(0.1684210526 0 0 0.1684210526 0 105)";

if (process.argv.length !== 6) {
  throw new Error(
    "usage: node scripts/compile-funky-ds4.mjs JET.svg GLACIER.svg MAGMA.svg MIDNIGHT.svg",
  );
}

function attributes(text) {
  const out = {};
  for (const match of text.matchAll(/([:\w-]+)="([^"]*)"/g)) out[match[1]] = match[2];
  return out;
}

function parseSvg(text) {
  const shapes = [];
  for (const match of text.matchAll(/<(path|circle|rect)\b([^>]*)\/>/g)) {
    shapes.push({ tag: match[1], attrs: attributes(match[2]) });
  }
  return shapes;
}

function styleMap(style = "") {
  return Object.fromEntries(
    style.split(";").filter(Boolean).map((part) => {
      const cut = part.indexOf(":");
      return [part.slice(0, cut), part.slice(cut + 1)];
    }),
  );
}

function signature(shape) {
  const attrs = Object.entries(shape.attrs)
    .filter(([name]) => name !== "id" && name !== "serif:id" && name !== "style")
    .map(([name, value]) => `${name}=${value}`)
    .join("|");
  return `${shape.tag}|${attrs}`;
}

function q(value) {
  return JSON.stringify(value);
}

function semanticClasses(index) {
  return {
    0: "ds4premium-trackpad-shadow",
    1: "ds4premium-left-bumper",
    3: "ds4premium-right-bumper",
    9: "ds4premium-shell",
    10: "ds4premium-grip ds4premium-grip-right",
    11: "ds4premium-grip ds4premium-grip-left",
    12: "ds4premium-touchpad",
    13: "ds4premium-touchpad-edge",
    14: "ds4premium-touch-texture",
    15: "ds4premium-stick-deck ds4premium-stick-deck-left",
    16: "ds4premium-stick-well ds4premium-stick-well-left",
    17: "ds4premium-stick-underskirt ds4premium-stick-underskirt-left",
    18: "ds4premium-stick-rim ds4premium-stick-rim-left",
    19: "ds4premium-stick-cap ds4premium-stick-cap-left",
    20: "ds4premium-stick-face ds4premium-stick-face-left",
    21: "ds4premium-stick-sheen ds4premium-stick-sheen-left",
    23: "ds4premium-stick-sheen ds4premium-stick-sheen-left",
    25: "ds4premium-stick-deck ds4premium-stick-deck-right",
    26: "ds4premium-stick-well ds4premium-stick-well-right",
    27: "ds4premium-stick-underskirt ds4premium-stick-underskirt-right",
    28: "ds4premium-stick-rim ds4premium-stick-rim-right",
    29: "ds4premium-stick-cap ds4premium-stick-cap-right",
    30: "ds4premium-stick-face ds4premium-stick-face-right",
    31: "ds4premium-stick-sheen ds4premium-stick-sheen-right",
    33: "ds4premium-stick-sheen ds4premium-stick-sheen-right",
    35: "ds4premium-control-well ds4premium-dpad-well",
    36: "ds4premium-control-well ds4premium-face-well",
    37: "ds4premium-dpad-base ds4premium-dpad-base-right",
    38: "ds4premium-dpad-lip ds4premium-dpad-lip-right",
    39: "ds4premium-dpad-cap ds4premium-dpad-cap-right",
    40: "ds4premium-dpad-bevel ds4premium-dpad-bevel-right",
    41: "ds4premium-dpad-sheen ds4premium-dpad-sheen-right",
    43: "ds4premium-dpad-mark ds4premium-dpad-mark-right",
    44: "ds4premium-dpad-base ds4premium-dpad-base-left",
    45: "ds4premium-dpad-lip ds4premium-dpad-lip-left",
    46: "ds4premium-dpad-cap ds4premium-dpad-cap-left",
    47: "ds4premium-dpad-bevel ds4premium-dpad-bevel-left",
    48: "ds4premium-dpad-sheen ds4premium-dpad-sheen-left",
    50: "ds4premium-dpad-mark ds4premium-dpad-mark-left",
    51: "ds4premium-dpad-base ds4premium-dpad-base-down",
    52: "ds4premium-dpad-lip ds4premium-dpad-lip-down",
    53: "ds4premium-dpad-cap ds4premium-dpad-cap-down",
    54: "ds4premium-dpad-bevel ds4premium-dpad-bevel-down",
    55: "ds4premium-dpad-sheen ds4premium-dpad-sheen-down",
    57: "ds4premium-dpad-mark ds4premium-dpad-mark-down",
    58: "ds4premium-dpad-base ds4premium-dpad-base-up",
    59: "ds4premium-dpad-lip ds4premium-dpad-lip-up",
    60: "ds4premium-dpad-cap ds4premium-dpad-cap-up",
    61: "ds4premium-dpad-bevel ds4premium-dpad-bevel-up",
    62: "ds4premium-dpad-sheen ds4premium-dpad-sheen-up",
    64: "ds4premium-dpad-mark ds4premium-dpad-mark-up",
    65: "ds4premium-face-shadow ds4premium-face-shadow-square",
    66: "ds4premium-face-rim ds4premium-face-rim-square",
    67: "ds4premium-face-cap ds4premium-face-cap-square",
    68: "ds4premium-face-glyph ds4premium-face-glyph-square",
    69: "ds4premium-face-shadow ds4premium-face-shadow-circle",
    70: "ds4premium-face-rim ds4premium-face-rim-circle",
    71: "ds4premium-face-cap ds4premium-face-cap-circle",
    72: "ds4premium-face-glyph ds4premium-face-glyph-circle",
    73: "ds4premium-face-shadow ds4premium-face-shadow-triangle",
    74: "ds4premium-face-rim ds4premium-face-rim-triangle",
    75: "ds4premium-face-cap ds4premium-face-cap-triangle",
    76: "ds4premium-face-glyph ds4premium-face-glyph-triangle",
    77: "ds4premium-face-shadow ds4premium-face-shadow-cross",
    78: "ds4premium-face-rim ds4premium-face-rim-cross",
    79: "ds4premium-face-cap ds4premium-face-cap-cross",
    80: "ds4premium-face-glyph ds4premium-face-glyph-cross",
    81: "ds4premium-guide",
    83: "ds4premium-guide-cap",
    86: "ds4premium-guide-sheen",
    87: "ds4premium-speaker-hole",
    88: "ds4premium-speaker-hole",
    89: "ds4premium-speaker-hole",
    90: "ds4premium-speaker-hole",
    91: "ds4premium-speaker-hole",
    92: "ds4premium-speaker-hole",
    93: "ds4premium-speaker-hole",
    94: "ds4premium-speaker-hole",
    95: "ds4premium-speaker-hole",
    96: "ds4premium-speaker-hole",
    97: "ds4premium-speaker-hole",
    98: "ds4premium-speaker-hole",
    99: "ds4premium-utility-shadow ds4premium-share-shadow",
    100: "ds4premium-utility-cap ds4premium-share-cap",
    101: "ds4premium-utility-sheen ds4premium-share-sheen",
    107: "ds4premium-utility-shadow ds4premium-options-shadow",
    108: "ds4premium-utility-cap ds4premium-options-cap",
    109: "ds4premium-utility-sheen ds4premium-options-sheen",
    117: "ds4premium-input-shell",
    118: "ds4premium-input-aperture",
    119: "ds4premium-input-aperture",
    120: "ds4premium-input-aperture ds4premium-input-jack",
    121: "ds4premium-input-mark",
    122: "ds4premium-input-mark",
    123: "ds4premium-input-mark",
    124: "ds4premium-mic-mark",
    125: "ds4premium-mic-mark",
    126: "ds4premium-mic-mark",
    127: "ds4premium-mic-mark",
    128: "ds4premium-mic-mark",
    129: "ds4premium-lightbar",
  }[index] ?? "";
}

const DEPTH_SHAPES = [
  { name: "touchpad-contact", index: 12, transform: "translate(0 15)", kind: "contact" },
  { name: "left-stick-contact", index: 17, transform: "translate(0 13)", kind: "contact" },
  { name: "right-stick-contact", index: 27, transform: "translate(0 13)", kind: "contact" },
  ...[
    ["right", 37], ["left", 44], ["down", 51], ["up", 58],
  ].flatMap(([direction, index]) => [
    { name: `dpad-${direction}-ambient`, index, transform: "translate(0 22)", kind: "ambient dpad" },
    { name: `dpad-${direction}-contact`, index, transform: "translate(0 9)", kind: "contact dpad" },
  ]),
  { name: "square-contact", index: 65, transform: "translate(0 13)", kind: "contact face" },
  { name: "circle-contact", index: 69, transform: "translate(0 13)", kind: "contact face" },
  { name: "triangle-contact", index: 73, transform: "translate(0 13)", kind: "contact face" },
  { name: "cross-contact", index: 77, transform: "translate(0 13)", kind: "contact face" },
  { name: "guide-contact", index: 81, transform: "translate(0 11)", kind: "contact guide" },
  { name: "share-contact", index: 99, transform: "translate(0 9)", kind: "contact utility" },
  { name: "options-contact", index: 107, transform: "translate(0 9)", kind: "contact utility" },
];

const sourcePaths = process.argv.slice(2).map((path) => resolve(path));
const sourceTexts = await Promise.all(sourcePaths.map((path) => readFile(path, "utf8")));
const lists = sourceTexts.map(parseSvg);
if (lists[0].length !== 130) {
  throw new Error(`Jet Black source shape count drifted: expected 130, got ${lists[0].length}`);
}

const maps = lists.map((list) => new Map(list.map((shape) => [signature(shape), shape])));
const tones = new Map();
const shapeTone = [];
for (let index = 0; index < lists[0].length; index += 1) {
  const jet = lists[0][index];
  const jetFill = styleMap(jet.attrs.style).fill;
  if (jetFill === undefined) {
    shapeTone.push(null);
    continue;
  }
  const sig = signature(jet);
  const fills = maps.map((map) => styleMap(map.get(sig)?.attrs.style).fill ?? jetFill);
  if (fills.every((fill) => fill === fills[0])) {
    shapeTone.push(null);
    continue;
  }
  const key = fills.join("|");
  if (!tones.has(key)) tones.set(key, { index: tones.size, fills });
  shapeTone.push(tones.get(key).index);
}

const toneList = [...tones.values()];
const shellTone = shapeTone[9];
if (shellTone === null) throw new Error("shell palette was not detected");

const hashes = sourceTexts.map((text) =>
  createHash("sha256").update(Buffer.from(text)).digest("hex").toUpperCase(),
);
const lines = [
  "import { h } from \"@getforma/core\";",
  "",
  "// GENERATED by scripts/compile-funky-ds4.mjs from the four Funky Designs",
  "// CC0 small SVGs. Do not hand-edit geometry; see art/README.md + NOTICE.",
  ...hashes.map((hash, index) => `// ${VARIANTS[index].slug}: ${hash}`),
  "",
  "export const DS4_PREMIUM_VARIANTS = [",
];

for (let variant = 0; variant < VARIANTS.length; variant += 1) {
  const item = VARIANTS[variant];
  lines.push("  {");
  lines.push(`    slug: ${q(item.slug)},`);
  lines.push(`    label: ${q(item.label)},`);
  lines.push(`    swatch: ${q(item.swatch)},`);
  lines.push(`    gradient: ${q(`nxg-ds4-${item.slug}`)},`);
  lines.push("    tones: {");
  for (const tone of toneList) {
    lines.push(`      ${q(`--ds4p-tone-${tone.index}`)}: ${q(tone.fills[variant])},`);
  }
  lines.push("    },");
  lines.push("  },");
}
lines.push("] as const;");
lines.push("");
lines.push("export type Ds4PremiumVariantSlug = (typeof DS4_PREMIUM_VARIANTS)[number][\"slug\"];");
lines.push(`export const DS4_PREMIUM_SHELL_TONE = ${q(`--ds4p-tone-${shellTone}`)};`);
lines.push("");
lines.push("export function Ds4PremiumGeometry() {");
lines.push("  return h(");
lines.push("    \"g\",");
lines.push("    { class: \"ds4premium-source\", \"fill-rule\": \"evenodd\", \"clip-rule\": \"evenodd\", \"stroke-linejoin\": \"round\", \"stroke-miterlimit\": \"2\" },");

for (let index = 0; index < lists[0].length; index += 1) {
  if (OMITTED.has(index)) continue;
  const shape = lists[0][index];
  const attrs = Object.fromEntries(
    Object.entries(shape.attrs).filter(([name]) =>
      name !== "id" && name !== "serif:id" && name !== "style"
    ),
  );
  const style = styleMap(shape.attrs.style);
  const classes = ["ds4premium-shape", semanticClasses(index)].filter(Boolean).join(" ");
  const props = { class: classes, "data-ds4-source-index": String(index), ...attrs };
  if (style.fill !== undefined) {
    const tone = shapeTone[index];
    props.fill = tone === null ? style.fill : `var(--ds4p-tone-${tone}, ${style.fill})`;
  }
  for (const [name, value] of Object.entries(style)) {
    if (name !== "fill") props[name] = value;
  }
  const rendered = Object.entries(props).map(([name, value]) => `${q(name)}: ${q(value)}`).join(", ");
  lines.push(`    h(${q(shape.tag)}, { ${rendered} }),`);
}

lines.push("  );");
lines.push("}");
lines.push("");
lines.push("export function Ds4PremiumDepth() {");
lines.push("  return h(");
lines.push("    \"g\",");
lines.push("    { class: \"ds4premium-depth\", \"aria-hidden\": \"true\", \"fill-rule\": \"evenodd\", \"clip-rule\": \"evenodd\", \"stroke-linejoin\": \"round\" },");
for (const item of DEPTH_SHAPES) {
  const shape = lists[0][item.index];
  const attrs = Object.fromEntries(
    Object.entries(shape.attrs).filter(([name]) =>
      name !== "id" && name !== "serif:id" && name !== "style" && name !== "transform"
    ),
  );
  const props = {
    class: `ds4premium-depth-shadow ${item.kind.split(" ").map((kind) => `ds4premium-depth-${kind}`).join(" ")}`,
    "data-ds4-depth": item.name,
    ...attrs,
    transform: item.transform,
  };
  const rendered = Object.entries(props).map(([name, value]) => `${q(name)}: ${q(value)}`).join(", ");
  lines.push(`    h(${q(shape.tag)}, { ${rendered} }),`);
}
lines.push("  );");
lines.push("}");
lines.push("");
lines.push("export function Ds4PremiumButtonHooks() {");
lines.push("  return h(");
lines.push("    \"g\",");
lines.push(`    { class: \"ds4premium-paid-hooks\", transform: ${q(PAID_TRANSFORM)} },`);
const pathHooks = [
  ["lb", 1], ["rb", 3], ["back", 99], ["start", 107],
  ["dpad.right", 37], ["dpad.left", 44], ["dpad.down", 51], ["dpad.up", 58],
  ["y", 73], ["a", 77],
];
for (const [fn, index] of pathHooks) {
  lines.push(
    `    h(\"path\", { \"data-fn\": ${q(fn)}, class: \"ds4premium-hook\", d: ${q(lists[0][index].attrs.d)}, fill: \"transparent\", \"vector-effect\": \"non-scaling-stroke\" }),`,
  );
}
const circleHooks = [
  ["x", 2806.43, 713.665, 136.504],
  ["b", 3373.68, 713.665, 136.504],
  ["guide", 1900, 1255.48, 104.343],
  ["lthumb", 1287.69, 1240.95, 137.53],
  ["ly.max", 1287.69, 1076, 82],
  ["ly.min", 1287.69, 1406, 82],
  ["lx.min", 1123, 1240.95, 82],
  ["lx.max", 1452, 1240.95, 82],
  ["rthumb", 2512.31, 1240.95, 137.53],
  ["ry.max", 2512.31, 1076, 82],
  ["ry.min", 2512.31, 1406, 82],
  ["rx.min", 2348, 1240.95, 82],
  ["rx.max", 2677, 1240.95, 82],
];
for (const [fn, cx, cy, r] of circleHooks) {
  lines.push(
    `    h(\"circle\", { \"data-fn\": ${q(fn)}, class: \"ds4premium-hook\", cx: ${q(String(cx))}, cy: ${q(String(cy))}, r: ${q(String(r))}, fill: \"transparent\", \"vector-effect\": \"non-scaling-stroke\" }),`,
  );
}
lines.push("  );");
lines.push("}");
lines.push("");

await writeFile(OUTPUT, lines.join("\n"), "utf8");
console.log(
  `wrote ${OUTPUT} (${lists[0].length - OMITTED.size} visible shapes, ${toneList.length} color tones)`,
);
