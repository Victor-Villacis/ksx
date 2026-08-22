import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(HERE, "../src/switchProPremiumGeometry.ts");
const SOURCE_VIEWBOX = "0 0 960 960";
const LIVE_VIEWBOX = "10 145 940 670";
const SOURCE_TRANSFORM = "matrix(1 0 0 1 0 0)";

const BASE_TONES = {
  "top-piece": "#2c2f31",
  "trigger-left": "#373b3e",
  "trigger-right": "#373b3e",
  bumper: "#373b3e",
  shell: "#52585c",
  "shell-top": "#44484c",
  seam: "#18191b",
  "grip-left": "#373b3e",
  "grip-right": "#373b3e",
  "grip-detail-left": "#484d51",
  "grip-detail-right": "#484d51",
  circuit: "#484d51",
  gap: "#000000",
  "dpad-cap": "#313133",
  "dpad-edge": "#28282a",
  mark: "#b8b8b8",
  "stick-well-right-outer": "#383c40",
  "stick-well-right-inner": "#3e4245",
  "stick-well-left-outer": "#3a3f42",
  "stick-well-left-inner": "#3f4347",
  "stick-cap": "#232324",
  "stick-face": "#2c2c2e",
  "stick-inner-ring": "#19191a",
  "stick-groove-0": "#3e3e41",
  "stick-groove-1": "#4b4b4e",
  "stick-groove-2": "#505053",
  "stick-groove-3": "#3f3f41",
  "stick-groove-4": "#313133",
  "stick-groove-5": "#2d2d2f",
  "stick-groove-6": "#28282a",
  "face-cap": "#323234",
  "home-well": "#3a3e41",
  "home-ring-soft": "#8282a8",
  accent: "#6161c7",
  "utility-well": "#383c40",
  "utility-cap": "#323234",
  "utility-mark": "#28282a",
  "utility-edge": "#1e1e1f",
};

function palette(overrides = {}) {
  return { ...BASE_TONES, ...overrides };
}

const VARIANTS = [
  {
    slug: "carbon-black",
    label: "Carbon black",
    swatch: "#41474d",
    tones: palette(),
  },
  {
    slug: "ink-pair",
    label: "Ink pair",
    swatch: "linear-gradient(90deg, #18b9ae 0 50%, #eb4a72 50%)",
    tones: palette({
      shell: "#46515a",
      "shell-top": "#59656f",
      "top-piece": "#30383e",
      circuit: "#778690",
      "trigger-left": "#11837e",
      "trigger-right": "#a62e4d",
      bumper: "#2f363c",
      "grip-left": "#18b9ae",
      "grip-right": "#eb4a72",
      "grip-detail-left": "#43d8ce",
      "grip-detail-right": "#ff7896",
      accent: "#58e8da",
      "home-ring-soft": "#a6fff5",
    }),
  },
  {
    slug: "crimson-red",
    label: "Crimson red",
    swatch: "#a82736",
    tones: palette({
      shell: "#464a50",
      "shell-top": "#555a61",
      "top-piece": "#322d31",
      circuit: "#764b52",
      "trigger-left": "#7e1f2b",
      "trigger-right": "#7e1f2b",
      bumper: "#7e1f2b",
      "grip-left": "#a82736",
      "grip-right": "#a82736",
      "grip-detail-left": "#d14a58",
      "grip-detail-right": "#d14a58",
      accent: "#e65a68",
      "home-ring-soft": "#ff9aa4",
    }),
  },
  {
    slug: "frost-white",
    label: "Frost white",
    swatch: "linear-gradient(90deg, #eceef0 0 58%, #292c31 58%)",
    tones: palette({
      shell: "#d6d9dc",
      "shell-top": "#f0f2f3",
      "top-piece": "#34383d",
      seam: "#777d83",
      circuit: "#9da5ad",
      "trigger-left": "#272a2f",
      "trigger-right": "#272a2f",
      bumper: "#2d3035",
      "grip-left": "#24272b",
      "grip-right": "#24272b",
      "grip-detail-left": "#44494f",
      "grip-detail-right": "#44494f",
      accent: "#5e7ed7",
      "home-ring-soft": "#a8b9ea",
    }),
  },
];

if (process.argv.length !== 3) {
  throw new Error(
    "usage: node scripts/compile-funky-switch-pro.mjs Switch_Pro_Controller_detail_small.svg",
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

/** Forma's SSR string table stores one attribute in a u16-sized slot. The
 * paid grip texture is a faithful compound path just over that limit, made of
 * hundreds of closed relative subpaths. Convert only each leading relative
 * moveto to its absolute equivalent, then pack whole subpaths into smaller
 * path attributes. The pixels and winding remain identical. */
function splitClosedCompoundPath(d, maxBytes = 48_000) {
  if (Buffer.byteLength(d, "utf8") <= maxBytes) return [d];
  const pieces = d.split(/(?=m[-+.\d])/g);
  const first = pieces[0].match(/^M([-+.\d]+)[, ]+([-+.\d]+)/);
  if (!first || pieces.length < 2) throw new Error("cannot split compound texture path safely");
  let x = Number(first[1]);
  let y = Number(first[2]);
  const absolute = [pieces[0]];
  const number = (value) => String(Number(value.toFixed(6)));
  for (let index = 1; index < pieces.length; index += 1) {
    if (!/[zZ]$/.test(pieces[index - 1])) {
      throw new Error(`texture subpath ${index - 1} is not closed`);
    }
    const move = pieces[index].match(/^m([-+.\d]+)[, ]+([-+.\d]+)/);
    if (!move) throw new Error(`texture subpath ${index} has no relative moveto`);
    x += Number(move[1]);
    y += Number(move[2]);
    absolute.push(`M${number(x)},${number(y)}${pieces[index].slice(move[0].length)}`);
  }
  const chunks = [];
  let chunk = "";
  for (const subpath of absolute) {
    if (chunk && Buffer.byteLength(chunk + subpath, "utf8") > maxBytes) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += subpath;
  }
  if (chunk) chunks.push(chunk);
  if (chunks.some((value) => Buffer.byteLength(value, "utf8") > maxBytes)) {
    throw new Error("compound texture split still exceeds the SSR string slot");
  }
  return chunks;
}

function styleMap(style = "") {
  return Object.fromEntries(
    style.split(";").filter(Boolean).map((part) => {
      const cut = part.indexOf(":");
      return [part.slice(0, cut), part.slice(cut + 1)];
    }),
  );
}

function q(value) {
  return JSON.stringify(value);
}

function semanticClasses(index) {
  if (index === 0) return "switchpro-premium-top-piece";
  if (index === 1) return "switchpro-premium-trigger switchpro-premium-trigger-left";
  if (index === 2) return "switchpro-premium-trigger switchpro-premium-trigger-right";
  if (index === 3) return "switchpro-premium-shell";
  if (index === 4) return "switchpro-premium-seam switchpro-premium-seam-right";
  if (index === 5) return "switchpro-premium-seam switchpro-premium-seam-left";
  if (index === 6) return "switchpro-premium-grip switchpro-premium-grip-right";
  if (index === 7) return "switchpro-premium-grip-texture switchpro-premium-grip-texture-right";
  if (index === 8) return "switchpro-premium-grip switchpro-premium-grip-left";
  if (index === 9) return "switchpro-premium-grip-texture switchpro-premium-grip-texture-left";
  if (index === 10) return "switchpro-premium-shell-top";
  if (index === 11) return "switchpro-premium-circuit";
  if (index >= 12 && index <= 15) {
    return [
      "switchpro-premium-dpad-gap",
      "switchpro-premium-dpad-cap",
      "switchpro-premium-dpad-edge",
      "switchpro-premium-dpad-mark",
    ][index - 12];
  }
  if (index >= 16 && index <= 28) {
    const part = index <= 21 ? ["well-outer", "well-inner", "gap", "cap", "face", "inner-ring"][index - 16] : `groove-${index - 22}`;
    return `switchpro-premium-stick switchpro-premium-stick-right switchpro-premium-stick-${part}`;
  }
  if (index >= 29 && index <= 41) {
    const part = index <= 34 ? ["well-outer", "well-inner", "gap", "cap", "face", "inner-ring"][index - 29] : `groove-${index - 35}`;
    return `switchpro-premium-stick switchpro-premium-stick-left switchpro-premium-stick-${part}`;
  }
  for (const [start, name] of [[42, "b"], [45, "y"], [48, "x"], [51, "a"]]) {
    if (index >= start && index <= start + 2) {
      const part = ["cap", "rim", "mark"][index - start];
      return `switchpro-premium-face switchpro-premium-face-${name} switchpro-premium-face-${part}`;
    }
  }
  if (index >= 54 && index <= 61) {
    return `switchpro-premium-home switchpro-premium-home-${["well", "ring-soft", "ring", "cap", "cap-inner", "rim", "mark", "edge"][index - 54]}`;
  }
  if (index >= 62 && index <= 66) {
    return `switchpro-premium-utility switchpro-premium-plus switchpro-premium-utility-${["well", "cap", "rim", "mark", "edge"][index - 62]}`;
  }
  if (index >= 67 && index <= 71) {
    return `switchpro-premium-utility switchpro-premium-minus switchpro-premium-utility-${["well", "cap", "rim", "mark", "edge"][index - 67]}`;
  }
  if (index >= 72 && index <= 75) {
    return `switchpro-premium-utility switchpro-premium-capture switchpro-premium-utility-${["cap", "rim", "mark", "edge"][index - 72]}`;
  }
  return "";
}

function toneRole(index) {
  if (index === 0) return "top-piece";
  if (index === 1) return "trigger-left";
  if (index === 2) return "trigger-right";
  if (index === 3) return "shell";
  if (index === 4 || index === 5) return "seam";
  if (index === 6) return "grip-right";
  if (index === 7) return "grip-detail-right";
  if (index === 8) return "grip-left";
  if (index === 9) return "grip-detail-left";
  if (index === 10) return "shell-top";
  if (index === 11) return "circuit";
  if (index === 12) return "gap";
  if (index === 13) return "dpad-cap";
  if (index === 14) return "dpad-edge";
  if (index === 15) return "mark";
  if (index === 16) return "stick-well-right-outer";
  if (index === 17) return "stick-well-right-inner";
  if (index === 18 || index === 31) return "gap";
  if (index === 19 || index === 32) return "stick-cap";
  if (index === 20 || index === 33) return "stick-face";
  if (index === 21 || index === 34) return "stick-inner-ring";
  if (index >= 22 && index <= 28) return `stick-groove-${index - 22}`;
  if (index === 29) return "stick-well-left-outer";
  if (index === 30) return "stick-well-left-inner";
  if (index >= 35 && index <= 41) return `stick-groove-${index - 35}`;
  if ([42, 45, 48, 51].includes(index)) return "face-cap";
  if ([43, 46, 49, 52].includes(index)) return "gap";
  if ([44, 47, 50, 53].includes(index)) return "mark";
  if (index === 54) return "home-well";
  if (index === 55) return "home-ring-soft";
  if (index === 56) return "accent";
  if (index === 57 || index === 58) return "utility-cap";
  if (index === 59) return "gap";
  if (index === 60) return "utility-mark";
  if (index === 61) return "utility-edge";
  if (index === 62 || index === 67) return "utility-well";
  if (index === 63 || index === 68 || index === 72) return "utility-cap";
  if (index === 64 || index === 69 || index === 73) return "gap";
  if (index === 65 || index === 70 || index === 74) return "utility-mark";
  if (index === 66 || index === 71 || index === 75) return "utility-edge";
  throw new Error(`missing tone role for source shape ${index}`);
}

const DEPTH_SHAPES = [
  { name: "body-ambient", index: 3, transform: "translate(0 16)", kind: "ambient body" },
  { name: "left-grip-contact", index: 8, transform: "translate(0 14)", kind: "contact grip" },
  { name: "right-grip-contact", index: 6, transform: "translate(0 14)", kind: "contact grip" },
  { name: "left-trigger-contact", index: 1, transform: "translate(0 7)", kind: "contact trigger" },
  { name: "right-trigger-contact", index: 2, transform: "translate(0 7)", kind: "contact trigger" },
  { name: "dpad-ambient", index: 12, transform: "translate(0 11)", kind: "ambient dpad" },
  { name: "dpad-contact", index: 12, transform: "translate(0 6)", kind: "contact dpad" },
  { name: "left-stick-contact", index: 31, transform: "translate(0 8)", kind: "contact stick" },
  { name: "right-stick-contact", index: 18, transform: "translate(0 8)", kind: "contact stick" },
  ...[42, 45, 48, 51].map((index, offset) => ({
    name: `${["b", "y", "x", "a"][offset]}-contact`,
    index,
    transform: "translate(0 8)",
    kind: "contact face",
  })),
  { name: "home-contact", index: 54, transform: "translate(0 6)", kind: "contact utility" },
  { name: "plus-contact", index: 62, transform: "translate(0 6)", kind: "contact utility" },
  { name: "capture-contact", index: 72, transform: "translate(0 6)", kind: "contact utility" },
];

const sourcePath = resolve(process.argv[2]);
const sourceText = await readFile(sourcePath, "utf8");
if (!/viewBox="0 0 960 960"/.test(sourceText)) {
  throw new Error("Switch Pro source viewBox drifted; expected 0 0 960 960");
}
if (/<(?:filter|mask|image|foreignObject)\b/i.test(sourceText)) {
  throw new Error("Switch Pro source unexpectedly contains a forbidden paint or raster element");
}

const shapes = parseSvg(sourceText);
if (shapes.length !== 76) {
  throw new Error(`Switch Pro source shape count drifted: expected 76, got ${shapes.length}`);
}
for (const [index, id] of [[0, "top-piece"], [3, "main-all"], [11, "controller-inside"], [12, "gap"], [42, "B"], [54, "home"], [72, "capture"]]) {
  if (shapes[index].attrs.id !== id) {
    throw new Error(`Switch Pro source order drifted at ${index}: expected ${id}, got ${shapes[index].attrs.id}`);
  }
}

const hash = createHash("sha256").update(Buffer.from(sourceText)).digest("hex").toUpperCase();
const lines = [
  "import { h } from \"@getforma/core\";",
  "",
  "// GENERATED by scripts/compile-funky-switch-pro.mjs from Funky Designs UK",
  "// CC0 detailed Switch Pro geometry. Do not hand-edit; see art/README.md + NOTICE.",
  `// carbon-black-source: ${hash}`,
  "",
  `export const SWITCH_PRO_PREMIUM_SOURCE_VIEWBOX = ${q(SOURCE_VIEWBOX)};`,
  `export const SWITCH_PRO_PREMIUM_VIEWBOX = ${q(LIVE_VIEWBOX)};`,
  `export const SWITCH_PRO_PREMIUM_TRANSFORM = ${q(SOURCE_TRANSFORM)};`,
  "",
  "export const SWITCH_PRO_PREMIUM_VARIANTS = [",
];

for (const variant of VARIANTS) {
  lines.push("  {");
  lines.push(`    slug: ${q(variant.slug)},`);
  lines.push(`    label: ${q(variant.label)},`);
  lines.push(`    swatch: ${q(variant.swatch)},`);
  lines.push(`    gradient: ${q(`nxg-switchpro-${variant.slug}`)},`);
  lines.push("    tones: {");
  for (const [name, value] of Object.entries(variant.tones)) {
    lines.push(`      ${q(`--switchp-tone-${name}`)}: ${q(value)},`);
  }
  lines.push("    },");
  lines.push("  },");
}
lines.push("] as const;");
lines.push("");
lines.push("export type SwitchProPremiumVariantSlug = (typeof SWITCH_PRO_PREMIUM_VARIANTS)[number][\"slug\"];");
lines.push("export const SWITCH_PRO_PREMIUM_SHELL_TONE = \"--switchp-tone-shell\";");
lines.push("");
lines.push("export function SwitchProPremiumGeometry() {");
lines.push("  return h(");
lines.push("    \"g\",");
lines.push("    { class: \"switchpro-premium-source\", transform: SWITCH_PRO_PREMIUM_TRANSFORM, \"fill-rule\": \"evenodd\", \"clip-rule\": \"evenodd\", \"stroke-linejoin\": \"round\", \"stroke-miterlimit\": \"2\" },");

for (let index = 0; index < shapes.length; index += 1) {
  const shape = shapes[index];
  const attrs = Object.fromEntries(
    Object.entries(shape.attrs).filter(([name]) =>
      name !== "id" && name !== "serif:id" && name !== "style"
    ),
  );
  const style = styleMap(shape.attrs.style);
  const unexpectedStyle = Object.keys(style).filter((name) => name !== "fill");
  if (unexpectedStyle.length > 0) {
    throw new Error(`unsupported source style on shape ${index}: ${unexpectedStyle.join(", ")}`);
  }
  const fallback = style.fill ?? "#000000";
  const role = toneRole(index);
  const classes = ["switchpro-premium-shape", semanticClasses(index)].filter(Boolean).join(" ");
  const pathChunks = shape.tag === "path" && attrs.d
    ? splitClosedCompoundPath(attrs.d)
    : null;
  if (pathChunks && pathChunks.length > 1) {
    const groupProps = {
      class: classes,
      "data-switchpro-source-index": String(index),
      fill: `var(--switchp-tone-${role}, ${fallback})`,
    };
    const renderedGroup = Object.entries(groupProps).map(([name, value]) => `${q(name)}: ${q(value)}`).join(", ");
    lines.push(`    h("g", { ${renderedGroup} },`);
    for (let chunk = 0; chunk < pathChunks.length; chunk += 1) {
      lines.push(`      h("path", { "data-switchpro-source-chunk": ${q(`${index}.${chunk}`)}, d: ${q(pathChunks[chunk])} }),`);
    }
    lines.push("    ),");
    continue;
  }
  const props = {
    class: classes,
    "data-switchpro-source-index": String(index),
    ...attrs,
    fill: `var(--switchp-tone-${role}, ${fallback})`,
  };
  const rendered = Object.entries(props).map(([name, value]) => `${q(name)}: ${q(value)}`).join(", ");
  lines.push(`    h(${q(shape.tag)}, { ${rendered} }),`);
}

// The source has one shoulder silhouette per side. These app-owned front
// bumper plates make L/R and ZL/ZR distinct without borrowing other geometry.
lines.push("    h(\"g\", { class: \"switchpro-premium-bumpers\", \"aria-hidden\": \"true\" },");
lines.push("      h(\"rect\", { class: \"switchpro-premium-bumper switchpro-premium-bumper-left\", x: \"132\", y: \"204\", width: \"205\", height: \"35\", rx: \"17.5\", fill: \"var(--switchp-tone-bumper, #373b3e)\" }),");
lines.push("      h(\"rect\", { class: \"switchpro-premium-bumper switchpro-premium-bumper-right\", x: \"623\", y: \"204\", width: \"205\", height: \"35\", rx: \"17.5\", fill: \"var(--switchp-tone-bumper, #373b3e)\" }),");
lines.push("    ),");
lines.push("  );");
lines.push("}");
lines.push("");
lines.push("export function SwitchProPremiumDepth() {");
lines.push("  return h(");
lines.push("    \"g\",");
lines.push("    { class: \"switchpro-premium-depth\", transform: SWITCH_PRO_PREMIUM_TRANSFORM, \"aria-hidden\": \"true\", \"fill-rule\": \"evenodd\", \"clip-rule\": \"evenodd\", \"stroke-linejoin\": \"round\" },");
for (const item of DEPTH_SHAPES) {
  const shape = shapes[item.index];
  const attrs = Object.fromEntries(
    Object.entries(shape.attrs).filter(([name]) =>
      name !== "id" && name !== "serif:id" && name !== "style" && name !== "transform"
    ),
  );
  const props = {
    class: `switchpro-premium-depth-shadow ${item.kind.split(" ").map((kind) => `switchpro-premium-depth-${kind}`).join(" ")}`,
    "data-switchpro-depth": item.name,
    ...attrs,
    transform: item.transform,
  };
  const rendered = Object.entries(props).map(([name, value]) => `${q(name)}: ${q(value)}`).join(", ");
  lines.push(`    h(${q(shape.tag)}, { ${rendered} }),`);
}
lines.push("  );");
lines.push("}");
lines.push("");
lines.push("export function SwitchProPremiumButtonHooks() {");
lines.push("  return h(");
lines.push("    \"g\",");
lines.push("    { class: \"switchpro-premium-paid-hooks\", transform: SWITCH_PRO_PREMIUM_TRANSFORM },");

const pathHooks = [
  ["lt", 1],
  ["rt", 2],
];
const rectHooks = [
  ["lb", "132", "204", "205", "35", "17.5"],
  ["rb", "623", "204", "205", "35", "17.5"],
  ["dpad.up", "313.2", "408.665", "51.987", "62.055", "7.45"],
  ["dpad.left", "266.847", "454.996", "58.078", "51.987", "7.45"],
  ["dpad.down", "313.2", "495.259", "51.987", "57.928", "7.45"],
  ["dpad.right", "353.463", "454.996", "58.056", "51.987", "7.45"],
  ["back", "396.534", "334.796", "37.663", "37.664", "8.026"],
];
const circleHooks = [
  ["a", "794.25", "353.648", "35.671"],
  ["b", "722.395", "415.851", "35.671"],
  ["x", "722.527", "292.11", "35.671"],
  ["y", "651.128", "353.721", "35.671"],
  ["start", "593.296", "284.533", "26.149"],
  ["guide", "545.199", "353.628", "28.025"],
  ["lthumb", "227.613", "353.335", "34"],
  ["ly.max", "227.613", "292.335", "24"],
  ["ly.min", "227.613", "414.335", "24"],
  ["lx.min", "166.613", "353.335", "24"],
  ["lx.max", "288.613", "353.335", "24"],
  ["rthumb", "601.154", "480", "34"],
  ["ry.max", "601.154", "419", "24"],
  ["ry.min", "601.154", "541", "24"],
  ["rx.min", "540.154", "480", "24"],
  ["rx.max", "662.154", "480", "24"],
];
if (pathHooks.length + rectHooks.length + circleHooks.length !== 25) {
  throw new Error("Switch Pro hook vocabulary must contain exactly 25 controls");
}
for (const [fn, index] of pathHooks) {
  lines.push(`    h(\"path\", { \"data-fn\": ${q(fn)}, class: \"switchpro-premium-hook\", d: ${q(shapes[index].attrs.d)}, fill: \"transparent\", \"vector-effect\": \"non-scaling-stroke\" }),`);
}
for (const [fn, x, y, width, height, rx] of rectHooks) {
  lines.push(`    h(\"rect\", { \"data-fn\": ${q(fn)}, class: \"switchpro-premium-hook\", x: ${q(x)}, y: ${q(y)}, width: ${q(width)}, height: ${q(height)}, rx: ${q(rx)}, fill: \"transparent\", \"vector-effect\": \"non-scaling-stroke\" }),`);
}
for (const [fn, cx, cy, r] of circleHooks) {
  lines.push(`    h(\"circle\", { \"data-fn\": ${q(fn)}, class: \"switchpro-premium-hook\", cx: ${q(cx)}, cy: ${q(cy)}, r: ${q(r)}, fill: \"transparent\", \"vector-effect\": \"non-scaling-stroke\" }),`);
}
lines.push("  );");
lines.push("}");
lines.push("");

await writeFile(OUTPUT, lines.join("\n"), "utf8");
console.log(`wrote ${OUTPUT} (${shapes.length} source shapes, ${DEPTH_SHAPES.length} depth shapes, 25 hooks)`);
