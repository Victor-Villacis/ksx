import { createShow, createSignal, h } from "@getforma/core";

// ── /nocturne — THE DESIGN PROOF ───────────────────────────────────────────
//
// The entire Nocturne prototype (docs/design/nocturne-prototype/) rebuilt as
// one Forma route: every region, every row, every string of the idle screen,
// pixel-faithful to shot 01 of the walkthrough — with PLACEHOLDER data and
// NO backend. Nothing here posts, polls, or reads a payload; the point is to
// prove the whole redesign renders under Forma's compiler + SSR before the
// real workspace adopts each piece.
//
// The compiler's static-unroll contract (enforced by build.mjs warnings, and
// hit while writing this file): `...CONST.map(item => h(...))` unrolls at
// build time ONLY over a FLAT module-level array of OBJECT literals, with the
// callback limited to member reads — a string array, a nested array, a
// nested map, or a bare ternary in an attribute silently degrades to an
// empty island shell or an omitted attribute. So every list below is flat,
// every object is a literal, and every conditional (bound-vs-not, chip-vs-
// Assign) is PRECOMPUTED into class fields; structure never varies per item.
//
// NO helper functions returning h() (each becomes its own island — M2c).
// Increment 2 adds the FIRST interactive states — the expanded-row editor
// (walkthrough shots 15-17) and the capture-armed variant (shot 12) — as
// island-local UI signals with one derivation point (applyNocturneUi) and a
// delegated click listener (nocturneWire, the map.ts idiom). Every signal
// default IS the idle state, so SSR still paints shot 01 exactly and parity
// holds. Every dynamic binding is an ARROW-WRAPPED getter (`() => sig()`) —
// the compiler treats a bare identifier as an un-evaluable child/attr and
// silently degrades it (build warning gate catches this); visibility inside
// the expander is class-driven (`… none`) rather than nested createShow. Styling is studio.css §9, scoped under `.nocturne`
// with `--n-*` properties carrying the prototype's exact palette — this
// route proves the DESIGN as designed; the production workspace keeps the
// KSX palette.

// ── UI state (increment 2): the expanded-row editor + capture-armed ────────
//
// One tiny model, one derivation point. Signal DEFAULTS are the idle screen;
// applyNocturneUi recomputes every dynamic slot from the model after each
// click. The strings are the prototype's own (extracted from the committed
// artifact bundle), including the composed explainer sentence.

const [nMetaHint, setNMetaHint] = createSignal("Click an input, then a key below");
const [nKbHint, setNKbHint] = createSignal("Click a bound key to inspect it");
const [nRowUpCls, setNRowUpCls] = createSignal("n-bind");
const [nRowLeftCls, setNRowLeftCls] = createSignal("n-bind on");
const [nWedgeUpCls, setNWedgeUpCls] = createSignal("np-zone");
const [nWedgeLeftCls, setNWedgeLeftCls] = createSignal("np-zone");
const [nHoldCls, setNHoldCls] = createSignal("nx-pill on");
const [nTogCls, setNTogCls] = createSignal("nx-pill");
const [nSwCls, setNSwCls] = createSignal("nx-sw");
const [nTogBadgeCls, setNTogBadgeCls] = createSignal("nx-badge none");
const [nRateBadgeCls, setNRateBadgeCls] = createSignal("nx-badge rate none");
const [nRatesCls, setNRatesCls] = createSignal("nx-rates none");
const [nxExplain, setNxExplain] = createSignal(
  "Fires while the key is held. Analog input — a key drives it to full travel.",
);
const [nxOpenLeft, setNxOpenLeft] = createSignal(false);
const [nxOpenUp, setNxOpenUp] = createSignal(false);

const ui: { sel: "left" | "up" | null; act: "hold" | "toggle"; turbo: boolean } = {
  sel: null,
  act: "hold",
  turbo: false,
};

function applyNocturneUi(): void {
  setNRowLeftCls(ui.sel === "left" ? "n-bind on sel" : "n-bind on");
  setNRowUpCls(ui.sel === "up" ? "n-bind sel" : "n-bind");
  setNWedgeLeftCls(ui.sel === "left" ? "np-zone lit" : "np-zone");
  setNWedgeUpCls(ui.sel === "up" ? "np-zone lit" : "np-zone");
  setNxOpenLeft(ui.sel === "left");
  setNxOpenUp(ui.sel === "up");
  setNMetaHint(
    ui.sel === "left"
      ? "Left stick — Left selected"
      : ui.sel === "up"
        ? "Left stick — Up selected"
        : "Click an input, then a key below",
  );
  setNKbHint(
    ui.sel === "left"
      ? "Click a key to bind it to Left stick — Left"
      : ui.sel === "up"
        ? "Click a key to bind it to Left stick — Up"
        : "Click a bound key to inspect it",
  );
  setNHoldCls(ui.act === "hold" ? "nx-pill on" : "nx-pill");
  setNTogCls(ui.act === "toggle" ? "nx-pill on" : "nx-pill");
  setNTogBadgeCls(ui.act === "toggle" ? "nx-badge" : "nx-badge none");
  setNSwCls(ui.turbo ? "nx-sw on" : "nx-sw");
  setNRatesCls(ui.turbo ? "nx-rates" : "nx-rates none");
  setNRateBadgeCls(ui.turbo ? "nx-badge rate" : "nx-badge rate none");
  setNxExplain(
    (ui.act === "toggle" ? "Latches on until pressed again. " : "Fires while the key is held. ") +
      (ui.turbo ? "Turbo repeats it 10/s — bounded ~15/s by the 60 Hz update loop. " : "") +
      "Analog input — a key drives it to full travel.",
  );
}

/** Delegated clicks on the island root (the map.ts idiom): every interactive
 *  placeholder carries `data-nx`; everything else is inert. */
export function nocturneWire(root: HTMLElement): void {
  root.addEventListener("click", (ev) => {
    const hit = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-nx]")?.dataset.nx;
    if (!hit) return;
    ev.preventDefault();
    if (hit === "row-left") ui.sel = ui.sel === "left" ? null : "left";
    else if (hit === "row-up") ui.sel = ui.sel === "up" ? null : "up";
    else if (hit === "act-hold") ui.act = "hold";
    else if (hit === "act-toggle") ui.act = "toggle";
    else if (hit === "turbo") ui.turbo = !ui.turbo;
    applyNocturneUi();
  });
}

// ── Placeholder data — the walkthrough's exact idle state ──────────────────

const DEVICES = [
  { name: "K70 RGB MK.2", meta: "USB · 104 keys", cls: "n-dev on" },
  { name: "G915 TKL", meta: "Wireless · 87 keys", cls: "n-dev" },
  { name: "Magic Keyboard", meta: "Bluetooth · 78 keys", cls: "n-dev" },
  { name: "Huntsman Mini", meta: "Offline · last seen 3 days ago", cls: "n-dev off" },
];

const BEHAVIOURS = [
  {
    cls: "n-radio",
    title: "Whole keyboard — Freeze",
    detail: "This keyboard is devoted to play. All input captured; typing suppressed.",
  },
  {
    cls: "n-radio on",
    title: "Bound keys only — Split",
    detail: "Mapped keys drive the pad; every other key keeps typing normally.",
  },
  {
    cls: "n-radio",
    title: "Capture off",
    detail: "Keyboard behaves normally; mapped keys also drive the pad.",
  },
];

const EMPTY_SLOTS = [{ p: "P2" }, { p: "P3" }, { p: "P4" }];

// Right pane, one const per group (nested maps do not unroll). `on` rows get
// a lit dot + a key chip; the rest show the Assign button (`none` hides the
// unused half — structure must not vary per item).
// Left stick — Up and — Left are bespoke dynamic rows (the capture-armed and
// expanded-row demos); only the inert rows stay in const arrays.
const BIND_LS_DOWN = [
  { cls: "n-bind", label: "Left stick — Down", chip: "", chip_cls: "n-keychip none", asn_cls: "n-assign" },
];
const BIND_LS_TAIL = [
  { cls: "n-bind on", label: "Left stick — Right", chip: "D", chip_cls: "n-keychip", asn_cls: "n-assign none" },
  { cls: "n-bind", label: "Left stick — Click (L3)", chip: "", chip_cls: "n-keychip none", asn_cls: "n-assign" },
];
const BIND_FACE = [
  { cls: "n-bind on", label: "A", chip: "Space", chip_cls: "n-keychip", asn_cls: "n-assign none" },
  { cls: "n-bind on", label: "B", chip: "R", chip_cls: "n-keychip", asn_cls: "n-assign none" },
  { cls: "n-bind on", label: "X", chip: "E", chip_cls: "n-keychip", asn_cls: "n-assign none" },
  { cls: "n-bind on", label: "Y", chip: "Q", chip_cls: "n-keychip", asn_cls: "n-assign none" },
];
const BIND_SHOULDER = [
  { cls: "n-bind on", label: "Left bumper (LB)", chip: "Z", chip_cls: "n-keychip", asn_cls: "n-assign none" },
  { cls: "n-bind on", label: "Right bumper (RB)", chip: "X", chip_cls: "n-keychip", asn_cls: "n-assign none" },
  { cls: "n-bind on", label: "Left trigger (LT)", chip: "S", chip_cls: "n-keychip", asn_cls: "n-assign none" },
  { cls: "n-bind on", label: "Right trigger (RT)", chip: "W", chip_cls: "n-keychip", asn_cls: "n-assign none" },
];
const BIND_RSTICK = [
  { cls: "n-bind", label: "Right stick — Up", chip: "", chip_cls: "n-keychip none", asn_cls: "n-assign" },
  { cls: "n-bind", label: "Right stick — Down", chip: "", chip_cls: "n-keychip none", asn_cls: "n-assign" },
  { cls: "n-bind", label: "Right stick — Left", chip: "", chip_cls: "n-keychip none", asn_cls: "n-assign" },
  { cls: "n-bind", label: "Right stick — Right", chip: "", chip_cls: "n-keychip none", asn_cls: "n-assign" },
  { cls: "n-bind", label: "Right stick — Click (R3)", chip: "", chip_cls: "n-keychip none", asn_cls: "n-assign" },
];
const BIND_DPAD = [
  { cls: "n-bind on", label: "D-pad Up", chip: "↑", chip_cls: "n-keychip", asn_cls: "n-assign none" },
  { cls: "n-bind on", label: "D-pad Down", chip: "↓", chip_cls: "n-keychip", asn_cls: "n-assign none" },
  { cls: "n-bind on", label: "D-pad Left", chip: "←", chip_cls: "n-keychip", asn_cls: "n-assign none" },
  { cls: "n-bind on", label: "D-pad Right", chip: "→", chip_cls: "n-keychip", asn_cls: "n-assign none" },
];
const BIND_SYSTEM = [
  { cls: "n-bind on", label: "View", chip: "Tab", chip_cls: "n-keychip", asn_cls: "n-assign none" },
  { cls: "n-bind on", label: "Menu", chip: "Esc", chip_cls: "n-keychip", asn_cls: "n-assign none" },
];

// The keyboard, exactly as the design draws the K70: main block + nav block +
// numpad, unit widths (u × 30px + gaps) as class modifiers, cap top-left,
// bound short bottom-right. One flat const per row (nested arrays do not
// unroll); `sp` opens a cluster gap; `ghost` cells are invisible placeholders
// keeping the nav column aligned on rows without nav keys.
const KB_ROW1 = [
  { cls: "n-key bound", cap: "Esc", short: "Mn" },
  { cls: "n-key sp", cap: "F1", short: "" }, { cls: "n-key", cap: "F2", short: "" },
  { cls: "n-key", cap: "F3", short: "" }, { cls: "n-key", cap: "F4", short: "" },
  { cls: "n-key sp", cap: "F5", short: "" }, { cls: "n-key", cap: "F6", short: "" },
  { cls: "n-key", cap: "F7", short: "" }, { cls: "n-key", cap: "F8", short: "" },
  { cls: "n-key sp", cap: "F9", short: "" }, { cls: "n-key", cap: "F10", short: "" },
  { cls: "n-key", cap: "F11", short: "" }, { cls: "n-key", cap: "F12", short: "" },
  { cls: "n-key sp", cap: "Prt", short: "" }, { cls: "n-key", cap: "Scr", short: "" },
  { cls: "n-key", cap: "Pse", short: "" },
];
const KB_ROW2 = [
  { cls: "n-key", cap: "`", short: "" }, { cls: "n-key", cap: "1", short: "" },
  { cls: "n-key", cap: "2", short: "" }, { cls: "n-key", cap: "3", short: "" },
  { cls: "n-key", cap: "4", short: "" }, { cls: "n-key", cap: "5", short: "" },
  { cls: "n-key", cap: "6", short: "" }, { cls: "n-key", cap: "7", short: "" },
  { cls: "n-key", cap: "8", short: "" }, { cls: "n-key", cap: "9", short: "" },
  { cls: "n-key", cap: "0", short: "" }, { cls: "n-key", cap: "−", short: "" },
  { cls: "n-key", cap: "=", short: "" }, { cls: "n-key u2", cap: "⌫", short: "" },
  { cls: "n-key sp", cap: "Ins", short: "" }, { cls: "n-key", cap: "Hm", short: "" },
  { cls: "n-key", cap: "PgU", short: "" },
  { cls: "n-key sp", cap: "Num", short: "" }, { cls: "n-key", cap: "/", short: "" },
  { cls: "n-key", cap: "*", short: "" }, { cls: "n-key", cap: "−", short: "" },
];
const KB_ROW3 = [
  { cls: "n-key bound u1_5", cap: "Tab", short: "Vw" },
  { cls: "n-key bound", cap: "Q", short: "Y" }, { cls: "n-key bound", cap: "W", short: "RT" },
  { cls: "n-key bound", cap: "E", short: "X" }, { cls: "n-key bound", cap: "R", short: "B" },
  { cls: "n-key", cap: "T", short: "" }, { cls: "n-key", cap: "Y", short: "" },
  { cls: "n-key", cap: "U", short: "" }, { cls: "n-key", cap: "I", short: "" },
  { cls: "n-key", cap: "O", short: "" }, { cls: "n-key", cap: "P", short: "" },
  { cls: "n-key", cap: "[", short: "" }, { cls: "n-key", cap: "]", short: "" },
  { cls: "n-key u1_5", cap: "\\", short: "" },
  { cls: "n-key sp", cap: "Del", short: "" }, { cls: "n-key", cap: "End", short: "" },
  { cls: "n-key", cap: "PgD", short: "" },
  { cls: "n-key sp", cap: "7", short: "" }, { cls: "n-key", cap: "8", short: "" },
  { cls: "n-key", cap: "9", short: "" }, { cls: "n-key", cap: "+", short: "" },
];
const KB_ROW4 = [
  { cls: "n-key u1_75", cap: "Caps", short: "" },
  { cls: "n-key bound", cap: "A", short: "L←" }, { cls: "n-key bound", cap: "S", short: "LT" },
  { cls: "n-key bound", cap: "D", short: "L→" },
  { cls: "n-key", cap: "F", short: "" }, { cls: "n-key", cap: "G", short: "" },
  { cls: "n-key", cap: "H", short: "" }, { cls: "n-key", cap: "J", short: "" },
  { cls: "n-key", cap: "K", short: "" }, { cls: "n-key", cap: "L", short: "" },
  { cls: "n-key", cap: ";", short: "" }, { cls: "n-key", cap: "'", short: "" },
  { cls: "n-key u2_25", cap: "Enter", short: "" },
  { cls: "n-key sp ghost", cap: "", short: "" }, { cls: "n-key ghost", cap: "", short: "" },
  { cls: "n-key ghost", cap: "", short: "" },
  { cls: "n-key sp", cap: "4", short: "" }, { cls: "n-key", cap: "5", short: "" },
  { cls: "n-key", cap: "6", short: "" },
];
const KB_ROW5 = [
  { cls: "n-key u2_25", cap: "Shift", short: "" },
  { cls: "n-key bound", cap: "Z", short: "LB" }, { cls: "n-key bound", cap: "X", short: "RB" },
  { cls: "n-key", cap: "C", short: "" }, { cls: "n-key", cap: "V", short: "" },
  { cls: "n-key", cap: "B", short: "" }, { cls: "n-key", cap: "N", short: "" },
  { cls: "n-key", cap: "M", short: "" }, { cls: "n-key", cap: ",", short: "" },
  { cls: "n-key", cap: ".", short: "" }, { cls: "n-key", cap: "/", short: "" },
  { cls: "n-key u2_75", cap: "Shift", short: "" },
  { cls: "n-key sp ghost", cap: "", short: "" },
  { cls: "n-key bound", cap: "↑", short: "D↑" },
  { cls: "n-key ghost", cap: "", short: "" },
  { cls: "n-key sp", cap: "1", short: "" }, { cls: "n-key", cap: "2", short: "" },
  { cls: "n-key", cap: "3", short: "" },
];
const KB_ROW6 = [
  { cls: "n-key u1_25", cap: "Ctrl", short: "" }, { cls: "n-key u1_25", cap: "Win", short: "" },
  { cls: "n-key u1_25", cap: "Alt", short: "" },
  { cls: "n-key bound u6_25", cap: "Space", short: "A" },
  { cls: "n-key u1_25", cap: "Alt", short: "" }, { cls: "n-key u1_25", cap: "Win", short: "" },
  { cls: "n-key u1_25", cap: "Menu", short: "" }, { cls: "n-key u1_25", cap: "Ctrl", short: "" },
  { cls: "n-key bound sp", cap: "←", short: "D←" },
  { cls: "n-key bound", cap: "↓", short: "D↓" },
  { cls: "n-key bound", cap: "→", short: "D→" },
  { cls: "n-key sp u2", cap: "0", short: "" }, { cls: "n-key", cap: ".", short: "" },
];

export function NocturneIsland() {
  return h(
    "div",
    { class: "nocturne" },
    // ═══ Title bar ════════════════════════════════════════════════════════
    h(
      "header",
      { class: "n-tbar" },
      h("div", { class: "n-logo" }),
      h("span", { class: "n-brand" }, "KSX Studio"),
      h("span", { class: "n-ver" }, "v0.4.1"),
      h(
        "div",
        { class: "n-chip" },
        h("span", { class: "n-chip-ico" }, "▣"),
        h("span", null, "Apex Legends — WASD"),
        h("span", { class: "n-chip-caret" }, "▾"),
      ),
      h("span", { class: "n-save" }, "Save"),
      h("span", { class: "n-saved" }, "Saved 2 days ago"),
      h("div", { class: "n-spring" }),
      h("span", { class: "n-hint" }, "L-Ctrl ×5 pauses capture"),
      h("button", { class: "n-play", type: "button" }, "▷ Play"),
    ),
    // ═══ Three panes ══════════════════════════════════════════════════════
    h(
      "main",
      { class: "n-main" },
      // ── Left pane ────────────────────────────────────────────────────────
      h(
        "aside",
        { class: "n-left" },
        h(
          "div",
          { class: "n-kick-row" },
          h("span", { class: "n-kick" }, "Keyboard"),
          h("span", { class: "n-kick-n" }, "4 found"),
          h("button", { class: "n-collapse", type: "button" }, "‹"),
        ),
        ...DEVICES.map((d) =>
          h(
            "div",
            { class: d.cls },
            h("span", { class: "n-dev-ico" }, "⌨"),
            h(
              "div",
              { class: "n-dev-txt" },
              h("div", { class: "n-dev-name" }, d.name),
              h("div", { class: "n-dev-meta" }, d.meta),
            ),
            h("span", { class: "n-dev-dot" }),
          ),
        ),
        h(
          "div",
          { class: "n-linkrow" },
          h("button", { class: "n-link", type: "button" }, "Rescan"),
          h("button", { class: "n-link", type: "button" }, "Identify by key"),
        ),
        h("div", { class: "n-kick-row" }, h("span", { class: "n-kick" }, "Keyboard behaviour")),
        ...BEHAVIOURS.map((b) =>
          h(
            "div",
            { class: b.cls },
            h("span", { class: "n-radio-dot" }),
            h(
              "div",
              { class: "n-radio-txt" },
              h("div", { class: "n-radio-title" }, b.title),
              h("div", { class: "n-radio-detail" }, b.detail),
            ),
          ),
        ),
        h(
          "div",
          { class: "n-kick-row" },
          h("span", { class: "n-kick" }, "Virtual controllers"),
          h("span", { class: "n-kick-n" }, "1/4 XInput · 1/16 slots"),
        ),
        h(
          "div",
          { class: "n-slot on" },
          h("span", { class: "n-pbadge" }, "P1"),
          h(
            "div",
            { class: "n-slot-txt" },
            h("div", { class: "n-slot-name" }, "Xbox 360"),
            h("div", { class: "n-slot-meta" }, "16 bound · XInput 1/4"),
          ),
          h("button", { class: "n-slot-act", type: "button", title: "Duplicate" }, "⧉"),
          h("button", { class: "n-slot-act", type: "button", title: "Remove" }, "✕"),
        ),
        ...EMPTY_SLOTS.map((s) =>
          h(
            "div",
            { class: "n-slot empty" },
            h("span", { class: "n-pbadge dim" }, s.p),
            h(
              "div",
              { class: "n-slot-txt" },
              h("div", { class: "n-slot-name" }, "empty slot"),
              h("div", { class: "n-slot-meta" }, "any persona"),
            ),
          ),
        ),
        h(
          "p",
          { class: "n-foot" },
          "Drag rows to reorder players. Any persona can sit in any slot — XInput personas cap at 4 in total (Windows) · 8 players is a realistic emulator target · 16 slots is the KSX ceiling.",
        ),
      ),
      // ── Center ───────────────────────────────────────────────────────────
      h(
        "section",
        { class: "n-center" },
        h(
          "div",
          { class: "n-meta" },
          h("span", { class: "n-pbadge" }, "P1"),
          h("span", { class: "n-meta-name" }, "Xbox 360"),
          h("span", { class: "n-meta-sub" }, "ViGEmBus · XInput · SOCD Neutral"),
          h("div", { class: "n-spring" }),
          h("span", { class: "n-meta-hint" }, () => nMetaHint()),
        ),
        h(
          "div",
          { class: "n-stage" },
          // The prototype's own 640×400 schematic, exact geometry and colors.
          h(
            "svg",
            { class: "n-pad", viewBox: "0 0 640 400", "aria-hidden": "true", focusable: "false" },
            h("rect", { class: "np-zone", x: "150", y: "18", width: "80", height: "27", rx: "11" }),
            h("rect", { class: "np-zone", x: "410", y: "18", width: "80", height: "27", rx: "11" }),
            h("text", { class: "np-lab", x: "190", y: "36", "text-anchor": "middle" }, "LT"),
            h("text", { class: "np-lab", x: "450", y: "36", "text-anchor": "middle" }, "RT"),
            h("rect", { class: "np-zone", x: "130", y: "54", width: "112", height: "24", rx: "12" }),
            h("rect", { class: "np-zone", x: "398", y: "54", width: "112", height: "24", rx: "12" }),
            h("text", { class: "np-lab", x: "186", y: "70", "text-anchor": "middle" }, "LB"),
            h("text", { class: "np-lab", x: "454", y: "70", "text-anchor": "middle" }, "RB"),
            h("rect", { class: "np-body", x: "110", y: "196", width: "98", height: "176", rx: "49", transform: "rotate(19 159 284)" }),
            h("rect", { class: "np-body", x: "432", y: "196", width: "98", height: "176", rx: "49", transform: "rotate(-19 481 284)" }),
            h("rect", { class: "np-body", x: "95", y: "85", width: "450", height: "176", rx: "74" }),
            h("circle", { class: "np-well", cx: "175", cy: "141", r: "40" }),
            h("path", { class: () => nWedgeUpCls(), d: "M175 93 l9 13 h-18 z" }),
            h("path", { class: "np-zone", d: "M175 189 l9 -13 h-18 z" }),
            h("path", { class: () => nWedgeLeftCls(), d: "M127 141 l13 -9 v18 z" }),
            h("path", { class: "np-zone", d: "M223 141 l-13 -9 v18 z" }),
            h("circle", { class: "np-stick", cx: "175", cy: "141", r: "25" }),
            h("circle", { class: "np-well", cx: "390", cy: "213", r: "40" }),
            h("path", { class: "np-zone", d: "M390 165 l9 13 h-18 z" }),
            h("path", { class: "np-zone", d: "M390 261 l9 -13 h-18 z" }),
            h("path", { class: "np-zone", d: "M342 213 l13 -9 v18 z" }),
            h("path", { class: "np-zone", d: "M438 213 l-13 -9 v18 z" }),
            h("circle", { class: "np-stick", cx: "390", cy: "213", r: "25" }),
            h("rect", { class: "np-zone", x: "244", y: "177", width: "24", height: "30", rx: "6" }),
            h("rect", { class: "np-zone", x: "244", y: "223", width: "24", height: "30", rx: "6" }),
            h("rect", { class: "np-zone", x: "211", y: "203", width: "30", height: "24", rx: "6" }),
            h("rect", { class: "np-zone", x: "271", y: "203", width: "30", height: "24", rx: "6" }),
            h("circle", { class: "np-hub", cx: "256", cy: "215", r: "9" }),
            h("circle", { class: "np-zone", cx: "465", cy: "106", r: "20" }),
            h("circle", { class: "np-zone", cx: "501", cy: "142", r: "20" }),
            h("circle", { class: "np-zone", cx: "465", cy: "178", r: "20" }),
            h("circle", { class: "np-zone", cx: "429", cy: "142", r: "20" }),
            h("text", { class: "np-face", x: "465", y: "111", "text-anchor": "middle" }, "Y"),
            h("text", { class: "np-face", x: "501", y: "147", "text-anchor": "middle" }, "B"),
            h("text", { class: "np-face", x: "465", y: "183", "text-anchor": "middle" }, "A"),
            h("text", { class: "np-face", x: "429", y: "147", "text-anchor": "middle" }, "X"),
            h("rect", { class: "np-zone", x: "286", y: "132", width: "26", height: "18", rx: "7" }),
            h("rect", { class: "np-zone", x: "328", y: "132", width: "26", height: "18", rx: "7" }),
            h("circle", { class: "np-hub", cx: "320", cy: "103", r: "17" }),
            h("circle", { class: "np-guide", cx: "320", cy: "103", r: "7" }),
            h("text", { class: "np-sys", x: "299", y: "168", "text-anchor": "middle" }, "View"),
            h("text", { class: "np-sys", x: "341", y: "168", "text-anchor": "middle" }, "Menu"),
          ),
        ),
        h(
          "div",
          { class: "n-kbhead" },
          h("span", { class: "n-kick" }, "Corsair K70 RGB MK.2 · USB · 104 keys"),
          h("div", { class: "n-spring" }),
          h("span", { class: "n-meta-hint" }, () => nKbHint()),
        ),
        h(
          "div",
          { class: "n-kb" },
          h(
            "div",
            { class: "n-kbrow" },
            ...KB_ROW1.map((k) =>
              h(
                "div",
                { class: k.cls },
                h("span", { class: "n-key-cap" }, k.cap),
                h("span", { class: "n-key-short" }, k.short),
              ),
            ),
          ),
          h(
            "div",
            { class: "n-kbrow" },
            ...KB_ROW2.map((k) =>
              h(
                "div",
                { class: k.cls },
                h("span", { class: "n-key-cap" }, k.cap),
                h("span", { class: "n-key-short" }, k.short),
              ),
            ),
          ),
          h(
            "div",
            { class: "n-kbrow" },
            ...KB_ROW3.map((k) =>
              h(
                "div",
                { class: k.cls },
                h("span", { class: "n-key-cap" }, k.cap),
                h("span", { class: "n-key-short" }, k.short),
              ),
            ),
          ),
          h(
            "div",
            { class: "n-kbrow" },
            ...KB_ROW4.map((k) =>
              h(
                "div",
                { class: k.cls },
                h("span", { class: "n-key-cap" }, k.cap),
                h("span", { class: "n-key-short" }, k.short),
              ),
            ),
          ),
          h(
            "div",
            { class: "n-kbrow" },
            ...KB_ROW5.map((k) =>
              h(
                "div",
                { class: k.cls },
                h("span", { class: "n-key-cap" }, k.cap),
                h("span", { class: "n-key-short" }, k.short),
              ),
            ),
          ),
          h(
            "div",
            { class: "n-kbrow" },
            ...KB_ROW6.map((k) =>
              h(
                "div",
                { class: k.cls },
                h("span", { class: "n-key-cap" }, k.cap),
                h("span", { class: "n-key-short" }, k.short),
              ),
            ),
          ),
        ),
      ),
      // ── Right pane ───────────────────────────────────────────────────────
      h(
        "aside",
        { class: "n-right" },
        h(
          "div",
          { class: "n-filter-row" },
          h("button", { class: "n-collapse", type: "button" }, "›"),
          h(
            "div",
            { class: "n-filter" },
            h("span", { class: "n-filter-ico" }, "⌕"),
            h("input", { class: "n-filter-in", type: "text", placeholder: "Filter inputs" }),
          ),
          h("button", { class: "n-reset", type: "button" }, "Reset"),
        ),
        h(
          "div",
          { class: "n-group-head" },
          h("span", { class: "n-kick" }, "Left stick"),
          h("span", { class: "n-kick-n" }, "2/5"),
        ),
        // Left stick — Up: the capture-armed demo (shot 12). Clicking the row
        // (or its Assign chip) opens the armed editor: Key = the light
        // "Press or click a key" button, everything else at its defaults.
        h(
          "div",
          { class: () => nRowUpCls(), "data-nx": "row-up" },
          h("span", { class: "n-bind-dot" }),
          h("span", { class: "n-bind-label" }, "Left stick — Up"),
          h("span", { class: "n-keychip none" }, ""),
          h("button", { class: "n-assign", type: "button" }, "Assign"),
        ),
        createShow(() => nxOpenUp(), () =>
          h(
            "div",
            { class: "nx-x" },
            h(
              "div",
              { class: "nx-row" },
              h("span", { class: "nx-lab" }, "Key"),
              h("button", { class: "nx-keybtn armed", type: "button" }, "Press or click a key"),
              h("button", { class: "nx-ghost", type: "button" }, "Clear"),
            ),
            h(
              "div",
              { class: "nx-row" },
              h("span", { class: "nx-lab" }, "Activation"),
              h(
                "div",
                { class: "nx-pills" },
                h("button", { class: "nx-pill on", type: "button" }, "Hold"),
                h("button", { class: "nx-pill", type: "button" }, "Toggle"),
              ),
            ),
            h(
              "div",
              { class: "nx-row" },
              h("span", { class: "nx-lab" }, "Turbo"),
              h("div", { class: "nx-sw" }, h("span", { class: "nx-knob" })),
            ),
            h(
              "div",
              { class: "nx-row" },
              h("span", { class: "nx-lab" }, "Macro"),
              h(
                "div",
                { class: "nx-macro" },
                h("button", { class: "nx-ghost", type: "button" }, "● Record"),
                h("button", { class: "nx-ghost", type: "button" }, "Steps…"),
              ),
            ),
            h(
              "div",
              { class: "nx-explain" },
              "Fires while the key is held. Analog input — a key drives it to full travel.",
            ),
          ),
        ),
        ...BIND_LS_DOWN.map((r) =>
          h(
            "div",
            { class: r.cls },
            h("span", { class: "n-bind-dot" }),
            h("span", { class: "n-bind-label" }, r.label),
            h("span", { class: r.chip_cls }, r.chip),
            h("button", { class: r.asn_cls, type: "button" }, "Assign"),
          ),
        ),
        // Left stick — Left: the expanded-row demo (shots 15-17). The header
        // grows the Toggle / 10-per-second badges as the editor's state
        // changes; the editor's pills, switch, rates strip and explainer are
        // all signal-driven off applyNocturneUi.
        h(
          "div",
          { class: () => nRowLeftCls(), "data-nx": "row-left" },
          h("span", { class: "n-bind-dot" }),
          h("span", { class: "n-bind-label" }, "Left stick — Left"),
          h("span", { class: () => nTogBadgeCls() }, "Toggle"),
          h("span", { class: () => nRateBadgeCls() }, "10/s"),
          h("span", { class: "n-keychip" }, "A"),
          h("button", { class: "n-assign none", type: "button" }, "Assign"),
        ),
        createShow(() => nxOpenLeft(), () =>
          h(
            "div",
            { class: "nx-x" },
            h(
              "div",
              { class: "nx-row" },
              h("span", { class: "nx-lab" }, "Key"),
              h("button", { class: "nx-keybtn", type: "button" }, "Rebind — A"),
              h("button", { class: "nx-ghost", type: "button" }, "Clear"),
            ),
            h(
              "div",
              { class: "nx-row" },
              h("span", { class: "nx-lab" }, "Activation"),
              h(
                "div",
                { class: "nx-pills" },
                h("button", { class: () => nHoldCls(), type: "button", "data-nx": "act-hold" }, "Hold"),
                h("button", { class: () => nTogCls(), type: "button", "data-nx": "act-toggle" }, "Toggle"),
              ),
            ),
            h(
              "div",
              { class: "nx-row" },
              h("span", { class: "nx-lab" }, "Turbo"),
              h("div", { class: () => nSwCls(), "data-nx": "turbo" }, h("span", { class: "nx-knob" })),
              h(
                "div",
                { class: () => nRatesCls() },
                h("span", { class: "nx-rate" }, "5/s"),
                h("span", { class: "nx-rate on" }, "10/s"),
                h("span", { class: "nx-rate" }, "15/s"),
                h("span", { class: "nx-dot" }),
              ),
            ),
            h(
              "div",
              { class: "nx-row" },
              h("span", { class: "nx-lab" }, "Macro"),
              h(
                "div",
                { class: "nx-macro" },
                h("button", { class: "nx-ghost", type: "button" }, "● Record"),
                h("button", { class: "nx-ghost", type: "button" }, "Steps…"),
              ),
            ),
            h("div", { class: "nx-explain" }, () => nxExplain()),
          ),
        ),
        ...BIND_LS_TAIL.map((r) =>
          h(
            "div",
            { class: r.cls },
            h("span", { class: "n-bind-dot" }),
            h("span", { class: "n-bind-label" }, r.label),
            h("span", { class: r.chip_cls }, r.chip),
            h("button", { class: r.asn_cls, type: "button" }, "Assign"),
          ),
        ),
        h(
          "div",
          { class: "n-group-head" },
          h("span", { class: "n-kick" }, "Face buttons"),
          h("span", { class: "n-kick-n" }, "4/4"),
        ),
        ...BIND_FACE.map((r) =>
          h(
            "div",
            { class: r.cls },
            h("span", { class: "n-bind-dot" }),
            h("span", { class: "n-bind-label" }, r.label),
            h("span", { class: r.chip_cls }, r.chip),
            h("button", { class: r.asn_cls, type: "button" }, "Assign"),
          ),
        ),
        h(
          "div",
          { class: "n-group-head" },
          h("span", { class: "n-kick" }, "Shoulders & triggers"),
          h("span", { class: "n-kick-n" }, "4/4"),
        ),
        ...BIND_SHOULDER.map((r) =>
          h(
            "div",
            { class: r.cls },
            h("span", { class: "n-bind-dot" }),
            h("span", { class: "n-bind-label" }, r.label),
            h("span", { class: r.chip_cls }, r.chip),
            h("button", { class: r.asn_cls, type: "button" }, "Assign"),
          ),
        ),
        h(
          "div",
          { class: "n-group-head" },
          h("span", { class: "n-kick" }, "Right stick"),
          h("span", { class: "n-kick-n" }, "0/5"),
        ),
        ...BIND_RSTICK.map((r) =>
          h(
            "div",
            { class: r.cls },
            h("span", { class: "n-bind-dot" }),
            h("span", { class: "n-bind-label" }, r.label),
            h("span", { class: r.chip_cls }, r.chip),
            h("button", { class: r.asn_cls, type: "button" }, "Assign"),
          ),
        ),
        h(
          "div",
          { class: "n-group-head" },
          h("span", { class: "n-kick" }, "D-pad"),
          h("span", { class: "n-kick-n" }, "4/4"),
        ),
        ...BIND_DPAD.map((r) =>
          h(
            "div",
            { class: r.cls },
            h("span", { class: "n-bind-dot" }),
            h("span", { class: "n-bind-label" }, r.label),
            h("span", { class: r.chip_cls }, r.chip),
            h("button", { class: r.asn_cls, type: "button" }, "Assign"),
          ),
        ),
        h(
          "div",
          { class: "n-group-head" },
          h("span", { class: "n-kick" }, "System"),
          h("span", { class: "n-kick-n" }, "2/2"),
        ),
        ...BIND_SYSTEM.map((r) =>
          h(
            "div",
            { class: r.cls },
            h("span", { class: "n-bind-dot" }),
            h("span", { class: "n-bind-label" }, r.label),
            h("span", { class: r.chip_cls }, r.chip),
            h("button", { class: r.asn_cls, type: "button" }, "Assign"),
          ),
        ),
        h("div", { class: "n-right-foot" }, "16 of 24 inputs bound"),
      ),
    ),
  );
}
