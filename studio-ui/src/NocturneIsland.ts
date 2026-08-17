import { createList, createShow, createSignal, h } from "@getforma/core";

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
// silently degrades it (build warning gate catches this) — and every dynamic
// attribute is the LAST prop on its element: hydration re-applies the binding
// by removing and re-appending the attribute, so SSR's source-order paint
// only matches the adopted DOM when the dynamic attr already serializes last
// (the parity gate caught this on the schematic wedges). Visibility inside
// the expander is class-driven (`… none`) rather than nested createShow.
// Styling is studio.css §9, scoped under `.nocturne`
// with `--n-*` properties carrying the prototype's exact palette — this
// route proves the DESIGN as designed; the production workspace keeps the
// KSX palette.

// ── SERVED state (migration pass 1, 2026-08-17): the keyboard section ──────
//
// The left pane's device list, the split-or-freeze roster, the keyboard
// header and the prepared-for-play control are REAL now: composed in
// snapshot.rs (NocturneDerived), injected by render_nocturne.rs, seeded here
// from the embedded payload before the tree builds (ledger #5), refreshed by
// the 2 s poll. These signals are COPIERS, never derivers.

export interface NocturneDeviceRowView {
  cls: string;
  name: string;
  meta: string;
  selector: string;
  alias: string;
  label: string;
}

export interface NocturneOtherRowView {
  name: string;
  meta: string;
}

export interface NocturneChoiceRowView {
  name: string;
  title: string;
  detail: string;
  cls: string;
}

export interface NocturneView {
  dev_count: string;
  dev_note: string;
  kb_title: string;
  dev_rows: NocturneDeviceRowView[];
  dev_other: NocturneOtherRowView[];
  mode_rows: NocturneChoiceRowView[];
  mode_note: string;
  cap_line: string;
  capd_cls: string;
  cap_sw_cls: string;
  cap_selector: string;
  cap_instance: string;
  cap_prepare: boolean;
  cap_release: boolean;
}

export interface NocturnePayload {
  unavailable: string;
  view: NocturneView;
}

const [nDevCount, setNDevCount] = createSignal("");
const [nModeNote, setNModeNote] = createSignal("");
const [nDevNote, setNDevNote] = createSignal("");
const [nDevRows, setNDevRows] = createSignal<NocturneDeviceRowView[]>([]);
const [nDevOther, setNDevOther] = createSignal<NocturneOtherRowView[]>([]);
const [nModeRows, setNModeRows] = createSignal<NocturneChoiceRowView[]>([]);
const [nCapLine, setNCapLine] = createSignal("");
const [nCapdCls, setNCapdCls] = createSignal("n-capd none");
const [nCapSwCls, setNCapSwCls] = createSignal("n-capsw");
const [nCapSelector, setNCapSelector] = createSignal("");
const [nCapInstance, setNCapInstance] = createSignal("");
const [nCapPrep, setNCapPrep] = createSignal(false);
const [nCapRel, setNCapRel] = createSignal(false);

// The action flash. The server fills these from the allowlisted query
// parameter on a full-page load; with JavaScript on, the fetch-submit layer
// reads the redirect's ?flash= and applies the same copy here. A poll is not
// an action and never touches them.
const [nFlashLine, setNFlashLine] = createSignal("");
const [nFlashCls, setNFlashCls] = createSignal("n-flash none");

/** Report one action outcome (the redirect's allowlisted ?flash= copy), and
 *  settle any in-flight identify banner. */
export function applyFlash(flash: string | null): void {
  ui.identify = false;
  applyNocturneUi();
  if (!flash || !flash.trim()) return;
  const err = flash.startsWith("error");
  setNFlashLine(flash.replace(/^error:\s*/, ""));
  setNFlashCls(err ? "n-flash err" : "n-flash ok");
}

/** Copy one served payload into the signals. */
export function applyNocturne(p: NocturnePayload): void {
  const v = p.view;
  setNDevCount(v.dev_count);
  setNModeNote(v.mode_note);
  setNDevNote(v.dev_note);
  setNKbTitle(v.kb_title);
  setNDevRows(v.dev_rows);
  setNDevOther(v.dev_other);
  setNModeRows(v.mode_rows);
  setNCapLine(v.cap_line);
  setNCapdCls(v.capd_cls);
  setNCapSwCls(v.cap_sw_cls);
  setNCapSelector(v.cap_selector);
  setNCapInstance(v.cap_instance);
  setNCapPrep(v.cap_prepare);
  setNCapRel(v.cap_release);
}

/** The poll could not reach the server: say so, change nothing else. */
export function applyNocturneUnreachable(): void {
  setNDevCount("unavailable");
  setNDevNote("ksx could not be reached — this list may be stale. Reopen ksx.");
}

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
const [nMenuOpen, setNMenuOpen] = createSignal(false);
const [nAutoCls, setNAutoCls] = createSignal("nx-sw");
const [nDlgOpen, setNDlgOpen] = createSignal(false);
const [nConflictOpen, setNConflictOpen] = createSignal(false);
const [nMacroOpen, setNMacroOpen] = createSignal(false);
const [nPlayCls, setNPlayCls] = createSignal("n-play");
const [nStatsCls, setNStatsCls] = createSignal("n-stats none");
const [nPauseCls, setNPauseCls] = createSignal("n-pause none");
const [nStopCls, setNStopCls] = createSignal("n-stop none");
const [nTickCls, setNTickCls] = createSignal("n-tickrow none");
const [nStageCls, setNStageCls] = createSignal("n-stage");
const [nRtCls, setNRtCls] = createSignal("np-zone");
const [nSlotMeta, setNSlotMeta] = createSignal("16 bound · XInput 1/4");
const [nIdLinkCls, setNIdLinkCls] = createSignal("n-link");
const [nIdBoxCls, setNIdBoxCls] = createSignal("n-idbox none");
const [nIdText, setNIdText] = createSignal("Press a key on the keyboard you want to use");
const [nSavedText, setNSavedText] = createSignal("Saved 2 days ago");
const [nLeftCls, setNLeftCls] = createSignal("n-left");
const [nRightCls, setNRightCls] = createSignal("n-right");
const [nKbTitle, setNKbTitle] = createSignal("");

const ui: {
  sel: "left" | "up" | null;
  act: "hold" | "toggle";
  turbo: boolean;
  menu: boolean;
  auto: boolean;
  dlg: boolean;
  conflict: boolean;
  macro: boolean;
  live: boolean;
  identify: boolean;
  saved: boolean;
  leftRail: boolean;
  rightRail: boolean;
} = {
  sel: null,
  act: "hold",
  turbo: false,
  menu: false,
  auto: false,
  dlg: false,
  conflict: false,
  macro: false,
  live: false,
  identify: false,
  saved: false,
  leftRail: false,
  rightRail: false,
};

function applyNocturneUi(): void {
  setNMenuOpen(ui.menu);
  setNAutoCls(ui.auto ? "nx-sw on" : "nx-sw");
  setNDlgOpen(ui.dlg);
  setNConflictOpen(ui.conflict);
  setNMacroOpen(ui.macro);
  setNPlayCls(ui.live ? "n-play none" : "n-play");
  setNStatsCls(ui.live ? "n-stats" : "n-stats none");
  setNPauseCls(ui.live ? "n-pause" : "n-pause none");
  setNStopCls(ui.live ? "n-stop" : "n-stop none");
  setNTickCls(ui.live ? "n-tickrow" : "n-tickrow none");
  setNStageCls(ui.live ? "n-stage live" : "n-stage");
  setNRtCls(ui.live ? "np-zone lit" : "np-zone");
  setNSlotMeta(ui.live ? "live · 16 bound · XInput 1/4" : "16 bound · XInput 1/4");
  setNIdLinkCls(ui.identify ? "n-link on" : "n-link");
  setNIdBoxCls(ui.identify ? "n-idbox listen" : "n-idbox none");
  setNIdText("Press a key on the keyboard you want to use");
  setNSavedText(ui.saved ? "Saved just now" : "Saved 2 days ago");
  setNLeftCls(ui.leftRail ? "n-left rail" : "n-left");
  setNRightCls(ui.rightRail ? "n-right rail" : "n-right");
  setNRowLeftCls(ui.sel === "left" ? "n-bind on sel" : "n-bind on");
  setNRowUpCls(ui.sel === "up" ? "n-bind sel" : "n-bind");
  setNWedgeLeftCls(ui.live || ui.sel === "left" ? "np-zone lit" : "np-zone");
  setNWedgeUpCls(ui.sel === "up" ? "np-zone lit" : "np-zone");
  setNxOpenLeft(ui.sel === "left");
  setNxOpenUp(ui.sel === "up");
  setNMetaHint(
    ui.live
      ? "Live — lit inputs are firing"
      : ui.sel === "left"
        ? "Left stick — Left selected"
        : ui.sel === "up"
          ? "Left stick — Up selected"
          : "Click an input, then a key below",
  );
  setNKbHint(
    ui.live
      ? "Bound keys drive pads · other keys type"
      : ui.sel === "left"
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

/** The filter demo (shot 21): IMPERATIVE hide/show over the static rows —
 *  the map.ts live-lighting idiom, legitimate for client-only chrome that no
 *  slot carries. A row matches on its own label or its group name; a group
 *  head survives while any of its rows do; an open expander follows its row. */
function applyNocturneFilter(root: HTMLElement, q: string): void {
  const pane = root.querySelector(".n-right");
  if (!pane) return;
  const query = q.trim().toLowerCase();
  let head: HTMLElement | null = null;
  let groupName = "";
  let groupAny = false;
  let lastRowHidden = false;
  const settleHead = () => {
    if (head) head.classList.toggle("hide", query !== "" && !groupAny);
  };
  for (const el of Array.from(pane.children) as HTMLElement[]) {
    if (el.classList.contains("n-group-head")) {
      settleHead();
      head = el;
      groupAny = false;
      groupName = (el.querySelector(".n-kick")?.textContent ?? "").toLowerCase();
    } else if (el.classList.contains("n-bind")) {
      const label = (el.querySelector(".n-bind-label")?.textContent ?? "").toLowerCase();
      const show = query === "" || label.includes(query) || groupName.includes(query);
      el.classList.toggle("hide", !show);
      lastRowHidden = !show;
      if (show) groupAny = true;
    } else if (el.classList.contains("nx-x")) {
      el.classList.toggle("hide", lastRowHidden);
    }
  }
  settleHead();
}

/** Delegated clicks on the island root (the map.ts idiom): every interactive
 *  placeholder carries `data-nx`; everything else is inert. */
export function nocturneWire(root: HTMLElement): void {
  // Identify-by-key is a REAL verb now: the form posts and the server
  // listens for one keypress (up to 11 s), then redirects with the outcome
  // flash. The submit hook only shows the listening banner while the
  // round-trip is in flight.
  root.addEventListener("submit", (ev) => {
    const form = ev.target as HTMLElement | null;
    if (form && form.classList.contains("n-idform")) {
      ui.identify = true;
      applyNocturneUi();
    }
  });
  root.addEventListener("input", (ev) => {
    const t = ev.target as HTMLElement | null;
    if (t instanceof HTMLInputElement && t.classList.contains("n-filter-in")) {
      applyNocturneFilter(root, t.value);
    }
  });
  root.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    const hit = target?.closest<HTMLElement>("[data-nx]")?.dataset.nx;
    if (!hit) {
      // The conflict demo: with a control armed, clicking the bound W keycap
      // is the taken-key case — the dialog the walkthrough could never
      // screenshot because the prototype resolved it under the driver.
      const key = target?.closest<HTMLElement>(".n-key.bound");
      if (key && ui.sel && key.querySelector(".n-key-cap")?.textContent === "W") {
        ui.conflict = true;
        applyNocturneUi();
        return;
      }
      // Any un-annotated click closes an open dropdown (menus dismiss on
      // outside clicks; menu rows are placeholder actions that also close —
      // they carry no data-nx, so they land here via the chip ancestor).
      if (ui.menu) {
        ui.menu = false;
        applyNocturneUi();
      }
      return;
    }
    ev.preventDefault();
    if (hit === "row-left") ui.sel = ui.sel === "left" ? null : "left";
    else if (hit === "row-up") ui.sel = ui.sel === "up" ? null : "up";
    else if (hit === "act-hold") ui.act = "hold";
    else if (hit === "act-toggle") ui.act = "toggle";
    else if (hit === "turbo") ui.turbo = !ui.turbo;
    else if (hit === "menu") ui.menu = !ui.menu;
    else if (hit === "auto") ui.auto = !ui.auto;
    else if (hit === "slot-new") ui.dlg = true;
    else if (hit === "dlg-close") ui.dlg = false;
    else if (hit === "conflict-close") ui.conflict = false;
    else if (hit === "macro-open") ui.macro = true;
    else if (hit === "macro-close") ui.macro = false;
    else if (hit === "play" || hit === "stop") {
      ui.live = hit === "play";
      ui.sel = null;
      // The frozen live moment (shot 23): W (RT) and A (Left) held. Keycap
      // lighting is IMPERATIVE classList - per-key signals cannot exist on
      // const-unrolled rows, and this is exactly the live-echo idiom the
      // real workspace will use.
      for (const cap of Array.from(root.querySelectorAll<HTMLElement>(".n-key.bound"))) {
        const t = cap.querySelector(".n-key-cap")?.textContent;
        cap.classList.toggle("lit", ui.live && (t === "W" || t === "A"));
      }
    }
    else if (hit === "pane-left") ui.leftRail = !ui.leftRail;
    else if (hit === "pane-right") ui.rightRail = !ui.rightRail;
    else if (hit === "save") ui.saved = true;
    else if (hit === "filter-reset") {
      const inp = root.querySelector<HTMLInputElement>(".n-filter-in");
      if (inp) inp.value = "";
      applyNocturneFilter(root, "");
    }
    // "dlg-noop" (the dialog panel itself) falls through: it exists so panel
    // clicks stop at the panel instead of reaching the backdrop's dlg-close.
    applyNocturneUi();
  });
}

// ── Placeholder data — the walkthrough's exact idle state ──────────────────

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

// The macro editor's step-panel chips and direction grids (shot 32): the
// open step holds nothing, so every chip is off and each grid's centre
// (neutral) cell is the lit one.
const MB_CHIPS = [
  { cls: "nmc", label: "A" }, { cls: "nmc", label: "B" }, { cls: "nmc", label: "X" },
  { cls: "nmc", label: "Y" }, { cls: "nmc", label: "LB" }, { cls: "nmc", label: "RB" },
  { cls: "nmc", label: "LT" }, { cls: "nmc", label: "RT" }, { cls: "nmc", label: "L3" },
  { cls: "nmc", label: "R3" }, { cls: "nmc", label: "Vw" }, { cls: "nmc", label: "Mn" },
];
const MG_CELLS = [
  { cls: "nmg-cell", label: "↖" }, { cls: "nmg-cell", label: "↑" }, { cls: "nmg-cell", label: "↗" },
  { cls: "nmg-cell", label: "←" }, { cls: "nmg-cell on", label: "·" }, { cls: "nmg-cell", label: "→" },
  { cls: "nmg-cell", label: "↙" }, { cls: "nmg-cell", label: "↓" }, { cls: "nmg-cell", label: "↘" },
];
const M_MOTIONS = [
  { label: "¼→ 236" }, { label: "¼← 214" }, { label: "½→ 41236" },
  { label: "½← 63214" }, { label: "DP→ 623" }, { label: "DP← 421" }, { label: "360→" },
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
        { class: "n-chip", "data-nx": "menu" },
        h("span", { class: "n-chip-ico" }, "▣"),
        h("span", null, "Apex Legends — WASD"),
        h("span", { class: "n-chip-caret" }, "▾"),
        // The config dropdown (shot 02): saved configurations, the four
        // actions, saved games (one broken), autostart. Placeholder rows —
        // clicking any of them just dismisses the menu; only the autostart
        // switch holds state.
        createShow(
          () => nMenuOpen(),
          () =>
            h(
              "div",
              { class: "nm" },
              h("div", { class: "nm-kick" }, "Saved configurations"),
              h(
                "div",
                { class: "nm-cfg on" },
                h(
                  "div",
                  { class: "nm-cfg-txt" },
                  h("div", { class: "nm-cfg-t" }, "Apex Legends — WASD"),
                  h("div", { class: "nm-cfg-m" }, "Updated 2 days ago"),
                ),
                h("span", { class: "nm-check" }, "✓"),
              ),
              h(
                "div",
                { class: "nm-cfg" },
                h(
                  "div",
                  { class: "nm-cfg-txt" },
                  h("div", { class: "nm-cfg-t" }, "Forza — analog triggers"),
                  h("div", { class: "nm-cfg-m" }, "Updated last week"),
                ),
              ),
              h(
                "div",
                { class: "nm-cfg" },
                h(
                  "div",
                  { class: "nm-cfg-txt" },
                  h("div", { class: "nm-cfg-t" }, "Couch co-op — 2 players"),
                  h("div", { class: "nm-cfg-m" }, "Updated 3 weeks ago"),
                ),
              ),
              h("div", { class: "nm-div" }),
              h("div", { class: "nm-item" }, "Start over — discard draft"),
              h("div", { class: "nm-item" }, "Save as new…"),
              h("div", { class: "nm-item" }, "Import from file…"),
              h("div", { class: "nm-item" }, "Export “Apex Legends — WASD”…"),
              h("div", { class: "nm-div" }),
              h("div", { class: "nm-kick games" }, "Saved games"),
              h(
                "div",
                { class: "nm-game" },
                h("span", { class: "nm-gico" }, "▶"),
                h(
                  "div",
                  { class: "nm-cfg-txt" },
                  h("div", { class: "nm-game-t" }, "Street Fighter 6 — cabinet"),
                  h("div", { class: "nm-cfg-m" }, "2P · Couch co-op — 2 players"),
                ),
              ),
              h(
                "div",
                { class: "nm-game broken" },
                h("span", { class: "nm-gico broken" }, "!"),
                h(
                  "div",
                  { class: "nm-cfg-txt" },
                  h("div", { class: "nm-game-t" }, "MAME — Galaga"),
                  h("div", { class: "nm-cfg-m" }, "1P · Apex Legends — WASD · launch path missing"),
                ),
              ),
              h("div", { class: "nm-item" }, "Save current setup as a game…"),
              h("div", { class: "nm-div" }),
              h(
                "div",
                { class: "nm-auto" },
                h("div", { "data-nx": "auto", class: () => nAutoCls() }, h("span", { class: "nx-knob" })),
                h(
                  "div",
                  { class: "nm-cfg-txt" },
                  h("div", { class: "nm-auto-t" }, "Start KSX when I sign in"),
                  h(
                    "div",
                    { class: "nm-auto-note" },
                    "KSX never starts itself — after a restart someone must open it before the pads work. On, the cabinet comes up ready on its own.",
                  ),
                ),
              ),
            ),
        ),
      ),
      h("button", { type: "button", "data-nx": "save", class: "n-save" }, "Save"),
      h("span", { class: "n-saved" }, () => nSavedText()),
      h("div", { class: "n-spring" }),
      h(
        "div",
        { class: () => nStatsCls() },
        h("span", null, "0:02"),
        h("span", null, "1.4 ms"),
        h("span", null, "4 ev"),
      ),
      h("span", { class: "n-hint" }, "L-Ctrl ×5 pauses capture"),
      h("button", { type: "button", "data-nx": "play", class: () => nPlayCls() }, "▷ Play"),
      h("button", { type: "button", class: () => nPauseCls() }, "⏸ Pause & edit"),
      h("button", { type: "button", "data-nx": "stop", class: () => nStopCls() }, "⏹ Stop"),
    ),
    // The action flash (SSR-only: filled from the allowlisted query).
    h("div", { role: "status", class: () => nFlashCls() }, () => nFlashLine()),
    // ═══ Three panes ══════════════════════════════════════════════════════
    h(
      "main",
      { class: "n-main" },
      // ── Left pane ────────────────────────────────────────────────────────
      h(
        "aside",
        { class: () => nLeftCls() },
        // Collapsed 52px rail (shot 27): expand, the staged players, add.
        h(
          "div",
          { class: "n-rail" },
          h("button", { class: "n-collapse", type: "button", "data-nx": "pane-left" }, "›"),
          h("span", { class: "n-pbadge" }, "P1"),
          h("button", { class: "n-pbadge plus", type: "button", "data-nx": "slot-new" }, "+"),
        ),
        h(
          "div",
          { class: "n-kick-row" },
          h("span", { class: "n-kick" }, "Keyboard"),
          h("span", { class: "n-kick-n" }, () => nDevCount()),
          h("button", { class: "n-collapse", type: "button", "data-nx": "pane-left" }, "‹"),
        ),
        // Device rows — SERVED (migration pass 1): every row is the
        // /nocturne/device form's button, carrying its served selector,
        // alias, and label. Clicking a row IS "Use this device".
        createList(
          () => nDevRows(),
          (r) => r.selector + "|" + r.alias + "|" + r.label + "|" + r.cls + "|" + r.name + "|" + r.meta,
          (r) =>
            h(
              "form",
              { class: "n-devform", method: "post", action: "/nocturne/device" },
              h("input", { type: "hidden", name: "selector", value: r.selector }),
              h("input", { type: "hidden", name: "alias", value: r.alias }),
              h("input", { type: "hidden", name: "label", value: r.label }),
              h(
                "button",
                { type: "submit", class: r.cls },
                h("span", { class: "n-dev-ico" }, "⌨"),
                h(
                  "span",
                  { class: "n-dev-txt" },
                  h("span", { class: "n-dev-name" }, r.name),
                  h("span", { class: "n-dev-meta" }, r.meta),
                ),
                h("span", { class: "n-dev-dot" }),
              ),
            ),
        ),
        // Boards that cannot be picked, and why — visible, never hidden.
        createList(
          () => nDevOther(),
          (r) => r.name + "|" + r.meta,
          (r) =>
            h(
              "div",
              { class: "n-dev off" },
              h("span", { class: "n-dev-ico" }, "⌨"),
              h(
                "div",
                { class: "n-dev-txt" },
                h("div", { class: "n-dev-name" }, r.name),
                h("div", { class: "n-dev-meta" }, r.meta),
              ),
              h("span", { class: "n-dev-dot" }),
            ),
        ),
        h("p", { class: "n-devnote" }, () => nDevNote()),
        h(
          "div",
          { class: "n-linkrow" },
          // Rescan is a fresh GET: the collector re-reads the machine on
          // every request, so reloading IS the scan (FIRST-RUN §5).
          h(
            "form",
            { method: "get", action: "/nocturne" },
            h("button", { class: "n-link", type: "submit" }, "Rescan"),
          ),
          h(
            "form",
            { class: "n-idform", method: "post", action: "/nocturne/device/identify" },
            h("button", { type: "submit", class: () => nIdLinkCls() }, "Identify by key"),
          ),
        ),
        // Identify states (shots 04/05): the pulsing listen card, then the
        // plain accent resolved line the next keypress produces.
        h(
          "div",
          { class: () => nIdBoxCls() },
          h("span", { class: "n-idot" }),
          h("span", { class: "n-idtxt" }, () => nIdText()),
        ),
        h("div", { class: "n-kick-row" }, h("span", { class: "n-kick" }, "Keyboard behaviour")),
        h("p", { class: "n-devnote" }, () => nModeNote()),
        // The split-or-freeze answer — SERVED: BlockingOption::roster's own
        // words, the staged answer marked, each row a /nocturne/blocking form.
        createList(
          () => nModeRows(),
          (r) => r.name + "|" + r.title + "|" + r.detail + "|" + r.cls,
          (r) =>
            h(
              "form",
              { class: "n-modeform", method: "post", action: "/nocturne/blocking" },
              h("input", { type: "hidden", name: "blocking", value: r.name }),
              h(
                "button",
                { type: "submit", class: r.cls },
                h("span", { class: "n-radio-dot" }),
                h(
                  "span",
                  { class: "n-radio-txt" },
                  h("span", { class: "n-radio-title" }, r.title),
                  h("span", { class: "n-radio-detail" }, r.detail),
                ),
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
            h("div", { class: "n-slot-meta" }, () => nSlotMeta()),
          ),
          h("button", { class: "n-slot-act", type: "button", title: "Duplicate" }, "⧉"),
          h("button", { class: "n-slot-act", type: "button", title: "Remove" }, "✕"),
        ),
        ...EMPTY_SLOTS.map((s) =>
          h(
            "div",
            { class: "n-slot empty", "data-nx": "slot-new" },
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
          { class: () => nTickCls() },
          h(
            "span",
            { class: "n-tick" },
            h("span", { class: "n-tick-dot" }),
            h("span", null, "P1 L←"),
          ),
          h(
            "span",
            { class: "n-tick on" },
            h("span", { class: "n-tick-dot" }),
            h("span", null, "P1 RT"),
          ),
        ),
        h(
          "div",
          { class: () => nStageCls() },
          // The prototype's own 640×400 schematic, exact geometry and colors.
          h(
            "svg",
            { class: "n-pad", viewBox: "0 0 640 400", "aria-hidden": "true", focusable: "false" },
            h("rect", { class: "np-zone", x: "150", y: "18", width: "80", height: "27", rx: "11" }),
            h("rect", { x: "410", y: "18", width: "80", height: "27", rx: "11", class: () => nRtCls() }),
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
            h("path", { d: "M175 93 l9 13 h-18 z", class: () => nWedgeUpCls() }),
            h("path", { class: "np-zone", d: "M175 189 l9 -13 h-18 z" }),
            h("path", { d: "M127 141 l13 -9 v18 z", class: () => nWedgeLeftCls() }),
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
          h("span", { class: "n-kick" }, () => nKbTitle()),
          h("div", { class: "n-spring" }),
          h("span", { class: "n-meta-hint" }, () => nKbHint()),
        ),
        // ── Prepared-for-play (migrated from /start's capture card) ────────
        //
        // The whole ceremony folds into one line + switch beside the board it
        // is about. The switch does not mutate anything by itself: opening it
        // reveals the SAME consent form the old card carried — three
        // checkboxes to prepare, one to release, every sentence verbatim,
        // server-validated — because taking a keyboard off the Windows stack
        // and installing a certificate stays a consented act, however small
        // the control that starts it. `details` keeps the fold native, so the
        // form exists in SSR and works without JavaScript.
        h(
          "div",
          { class: () => nCapdCls() },
          h(
            "details",
            { class: "n-capdet" },
            h(
              "summary",
              { class: "n-capsum" },
              h("span", { class: () => nCapSwCls() }, h("span", { class: "nx-knob" })),
              h("span", { class: "n-capline" }, () => nCapLine()),
            ),
            h(
              "div",
              { class: "n-capbody" },
              createShow(
                () => nCapPrep(),
                () =>
                  h(
                    "form",
                    { class: "n-capform", method: "post", action: "/nocturne/capture/prepare" },
                    h("input", { type: "hidden", name: "expected_selector", value: () => nCapSelector() }),
                    h("input", { type: "hidden", name: "instance_id", value: () => nCapInstance() }),
                    h(
                      "p",
                      { class: "n-capnote" },
                      "Windows prepares only the keyboard you selected. It stops ordinary typing until you release it here.",
                    ),
                    h(
                      "label",
                      { class: "n-capconsent" },
                      h("input", { type: "checkbox", name: "confirm_spare_keyboard", value: "yes", required: "" }),
                      h("span", null, "I connected and tested a different keyboard that can still type."),
                    ),
                    h(
                      "label",
                      { class: "n-capconsent" },
                      h("input", { type: "checkbox", name: "confirm_rebind", value: "yes", required: "" }),
                      h(
                        "span",
                        null,
                        "I understand this selected keyboard will stop ordinary typing until I release it here, and I will release it before connecting another identical keyboard.",
                      ),
                    ),
                    h(
                      "label",
                      { class: "n-capconsent" },
                      h("input", { type: "checkbox", name: "confirm_machine_certificate", value: "yes", required: "" }),
                      h(
                        "span",
                        null,
                        "I allow ksx to install a machine-local signing certificate for this computer's generated device package.",
                      ),
                    ),
                    h(
                      "div",
                      { class: "n-caprow-act" },
                      h("button", { class: "nd-btn primary", type: "submit" }, "Prepare selected keyboard"),
                    ),
                    h(
                      "p",
                      { class: "n-capnote" },
                      "Windows will show a permission prompt. The app stays open and does not show a command window.",
                    ),
                  ),
              ),
              createShow(
                () => nCapRel(),
                () =>
                  h(
                    "form",
                    { class: "n-capform", method: "post", action: "/nocturne/capture/release" },
                    h("input", { type: "hidden", name: "expected_selector", value: () => nCapSelector() }),
                    h("input", { type: "hidden", name: "instance_id", value: () => nCapInstance() }),
                    h(
                      "p",
                      { class: "n-capnote" },
                      "Release removes the Windows package and returns this keyboard to ordinary typing. Your unsaved choices stay on this screen.",
                    ),
                    h(
                      "label",
                      { class: "n-capconsent" },
                      h("input", { type: "checkbox", name: "confirm_release", value: "yes", required: "" }),
                      h("span", null, "I want to return this selected keyboard to ordinary typing."),
                    ),
                    h(
                      "div",
                      { class: "n-caprow-act" },
                      h("button", { class: "nd-btn primary", type: "submit" }, "Release selected keyboard"),
                    ),
                  ),
              ),
            ),
          ),
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
        { class: () => nRightCls() },
        // Collapsed 48px rail (shot 36): expand, the vertical label, count.
        h(
          "div",
          { class: "n-rail" },
          h("button", { class: "n-collapse", type: "button", "data-nx": "pane-right" }, "‹"),
          h("span", { class: "n-rail-vlab" }, "Bindings"),
          h("span", { class: "n-rail-n" }, "16"),
        ),
        h(
          "div",
          { class: "n-filter-row" },
          h("button", { class: "n-collapse", type: "button", "data-nx": "pane-right" }, "›"),
          h(
            "div",
            { class: "n-filter" },
            h("span", { class: "n-filter-ico" }, "⌕"),
            h("input", { class: "n-filter-in", type: "text", placeholder: "Filter inputs" }),
          ),
          h("button", { class: "n-reset", type: "button", "data-nx": "filter-reset" }, "Reset"),
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
          { "data-nx": "row-up", class: () => nRowUpCls() },
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
                h("button", { class: "nx-ghost", type: "button", "data-nx": "macro-open" }, "Steps…"),
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
          { "data-nx": "row-left", class: () => nRowLeftCls() },
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
                h("button", { type: "button", "data-nx": "act-hold", class: () => nHoldCls() }, "Hold"),
                h("button", { type: "button", "data-nx": "act-toggle", class: () => nTogCls() }, "Toggle"),
              ),
            ),
            h(
              "div",
              { class: "nx-row" },
              h("span", { class: "nx-lab" }, "Turbo"),
              h("div", { "data-nx": "turbo", class: () => nSwCls() }, h("span", { class: "nx-knob" })),
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
                h("button", { class: "nx-ghost", type: "button", "data-nx": "macro-open" }, "Steps…"),
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
    // ═══ Macro editor (shots 31/32) ═══════════════════════════════════════
    // Opened by either expander's Steps… button; Done and the backdrop close
    // it. Static: one 80 ms step, expanded, holding nothing — the exact
    // state of shot 32 — with the motion writer, the three grids, and the
    // On-release / After-it-ends / Short-steps footer verbatim.
    createShow(
      () => nMacroOpen(),
      () =>
        h(
          "div",
          { class: "nd-back", "data-nx": "macro-close" },
          h(
            "div",
            { class: "nd nm-dlg", "data-nx": "dlg-noop", role: "dialog", "aria-label": "Macro editor" },
            h(
              "div",
              null,
              h("div", { class: "nd-kick" }, "Macro editor"),
              h("div", { class: "nd-title sm" }, "Left stick — Left — Xbox 360 · P1"),
              h(
                "div",
                { class: "nm-lede" },
                "Each step holds everything ticked in it at once, for its duration, before the next begins — a diagonal is ONE step holding two directions, so ¼→ is three steps: ↓, then ↘, then →.",
              ),
            ),
            h(
              "div",
              { class: "nmo-row" },
              h("span", { class: "nmo-kick" }, "Write a motion"),
              h("span", { class: "nx-pill" }, "D-pad"),
              h("span", { class: "nx-pill on" }, "Left stick"),
              h("span", { class: "nx-pill" }, "Right stick"),
              h("span", { class: "nmo-vsep" }),
              ...M_MOTIONS.map((m) => h("span", { class: "nmo-motion" }, m.label)),
            ),
            h(
              "div",
              { class: "nms-area" },
              h(
                "div",
                { class: "nms-wrap open" },
                h(
                  "div",
                  { class: "nms-row" },
                  h("span", { class: "nms-idx" }, "1"),
                  h("span", { class: "nms-dur" }, "80 ms"),
                  h("span", { class: "nms-holds" }, "holds nothing"),
                  h("span", { class: "nms-edit on" }, "Close"),
                  h("span", { class: "nms-mini" }, "＋"),
                  h("span", { class: "nms-mini" }, "✕"),
                ),
                h(
                  "div",
                  { class: "nms-panel" },
                  h("div", { class: "nms-chips" }, ...MB_CHIPS.map((c) => h("span", { class: c.cls }, c.label))),
                  h(
                    "div",
                    { class: "nms-grids" },
                    h(
                      "div",
                      { class: "nmg" },
                      h("span", { class: "nmg-name" }, "D-pad"),
                      h("div", { class: "nmg-grid" }, ...MG_CELLS.map((c) => h("span", { class: c.cls }, c.label))),
                    ),
                    h(
                      "div",
                      { class: "nmg" },
                      h("span", { class: "nmg-name" }, "Left stick"),
                      h("div", { class: "nmg-grid" }, ...MG_CELLS.map((c) => h("span", { class: c.cls }, c.label))),
                    ),
                    h(
                      "div",
                      { class: "nmg" },
                      h("span", { class: "nmg-name" }, "Right stick"),
                      h("div", { class: "nmg-grid" }, ...MG_CELLS.map((c) => h("span", { class: c.cls }, c.label))),
                    ),
                  ),
                ),
              ),
              h("button", { class: "nx-ghost nms-add", type: "button" }, "＋ Add step"),
            ),
            h(
              "div",
              { class: "nm-foot" },
              h(
                "div",
                { class: "nm-frow first" },
                h("span", { class: "nm-flab" }, "On release"),
                h("span", { class: "nx-pill on" }, "Finish the sequence"),
                h("span", { class: "nx-pill" }, "Stop at once"),
                h(
                  "span",
                  { class: "nm-fnote" },
                  "Finishing lets it run out — tap the trigger and the quarter-circle comes out whole.",
                ),
              ),
              h(
                "div",
                { class: "nm-frow" },
                h("span", { class: "nm-flab" }, "After it ends"),
                h("span", { class: "nx-pill on" }, "Run once per press"),
                h("span", { class: "nx-pill" }, "Repeat while held"),
              ),
              h(
                "div",
                { class: "nm-frow" },
                h("span", { class: "nm-flab" }, "Short steps"),
                h("div", { class: "nx-sw" }, h("span", { class: "nx-knob" })),
                h(
                  "span",
                  { class: "nm-fnote" },
                  "60 Hz — steps under 33 ms (2 frames) show red and are raised to land, unless allowed to run as written.",
                ),
              ),
              h(
                "div",
                { class: "nm-trig" },
                "Trigger — A starts this macro. It is the ordinary binding on Left stick — Left; rebind the key there and the macro follows it.",
              ),
              h(
                "div",
                { class: "nd-actions" },
                h("button", { class: "nd-btn", type: "button" }, "▶ Test on the pad"),
                h("button", { class: "nd-btn primary", type: "button", "data-nx": "macro-close" }, "Done"),
              ),
            ),
          ),
        ),
    ),
    // ═══ Key-conflict dialog (bundle template; the shots never caught it —
    // the prototype resolved conflicts before the walkthrough's screenshot).
    // Same-pad variant with all three consequence cards; every action is a
    // placeholder that just dismisses.
    createShow(
      () => nConflictOpen(),
      () =>
        h(
          "div",
          { class: "nd-back", "data-nx": "conflict-close" },
          h(
            "div",
            { class: "nd nd-conflict", "data-nx": "dlg-noop", role: "dialog", "aria-label": "Key conflict" },
            h(
              "div",
              null,
              h("div", { class: "nd-kick" }, "Key conflict"),
              h("div", { class: "nd-title sm" }, "W is already bound"),
              h("div", { class: "nd-body" }, "W currently drives Right trigger (RT)."),
            ),
            h(
              "div",
              { class: "nc-cards" },
              h(
                "div",
                { class: "nc-card", "data-nx": "conflict-close" },
                h("div", { class: "nc-name" }, "Swap keys"),
                h("div", { class: "nc-desc" }, "Left stick — Left takes W · Right trigger (RT) takes A"),
              ),
              h(
                "div",
                { class: "nc-card", "data-nx": "conflict-close" },
                h("div", { class: "nc-name" }, "Move here"),
                h("div", { class: "nc-desc" }, "Unbind Right trigger (RT) and give W to Left stick — Left"),
              ),
              h(
                "div",
                { class: "nc-card", "data-nx": "conflict-close" },
                h("div", { class: "nc-name" }, "Keep both"),
                h("div", { class: "nc-desc" }, "One key fires both inputs on this pad"),
              ),
            ),
            h(
              "div",
              { class: "nd-actions" },
              h("button", { class: "nd-btn", type: "button", "data-nx": "conflict-close" }, "Cancel"),
            ),
          ),
        ),
    ),
    // ═══ Create-controller dialog (shot 07) ═══════════════════════════════
    // Opened by any empty rack slot; Cancel, Create, or the backdrop close
    // it. Static content matching the shot: Xbox 360 selected, Numpad player
    // and Neutral pills active, both future personas blocked.
    createShow(
      () => nDlgOpen(),
      () =>
        h(
          "div",
          { class: "nd-back", "data-nx": "dlg-close" },
          h(
            "div",
            { class: "nd", "data-nx": "dlg-noop", role: "dialog", "aria-label": "Create a virtual controller" },
            h(
              "div",
              null,
              h("div", { class: "nd-kick" }, "New device"),
              h("div", { class: "nd-title" }, "Create a virtual controller"),
              h("div", { class: "nd-lede" }, "Games will see Player 2, driven by Corsair K70 RGB MK.2."),
            ),
            h(
              "div",
              null,
              h("div", { class: "nd-lab" }, "Controller persona — what games will see"),
              h(
                "div",
                { class: "nd-grid" },
                h(
                  "div",
                  { class: "nd-card on" },
                  h("div", { class: "nd-card-t" }, "Xbox 360"),
                  h("div", { class: "nd-card-api" }, "ViGEmBus · XInput"),
                ),
                h(
                  "div",
                  { class: "nd-card" },
                  h("div", { class: "nd-card-t" }, "PlayStation — DualShock 4"),
                  h("div", { class: "nd-card-api" }, "ViGEmBus"),
                ),
                h(
                  "div",
                  { class: "nd-card" },
                  h("div", { class: "nd-card-t" }, "DualSense"),
                  h("div", { class: "nd-card-api" }, "HIDMaestro · plain USB"),
                  h("div", { class: "nd-card-note" }, "HIDMaestro — endpoint created on Play"),
                ),
                h(
                  "div",
                  { class: "nd-card off" },
                  h("div", { class: "nd-card-t" }, "Switch Pro"),
                  h("div", { class: "nd-card-api" }, "Future gated capability"),
                  h("div", { class: "nd-card-note dim" }, "Not selectable in v0.4.1"),
                ),
                h(
                  "div",
                  { class: "nd-card off" },
                  h("div", { class: "nd-card-t" }, "Xbox Series"),
                  h("div", { class: "nd-card-api" }, "Future gated capability"),
                  h("div", { class: "nd-card-note dim" }, "Not selectable in v0.4.1"),
                ),
              ),
              h(
                "div",
                { class: "nd-note" },
                "Mix personas freely — P1 Xbox, P2 DualSense, and so on. XInput personas cap at 4 in total (Windows); 8 players is a realistic emulator target; 16 slots is the KSX ceiling.",
              ),
            ),
            h(
              "div",
              { class: "nd-cols" },
              h(
                "div",
                { class: "nd-col" },
                h("div", { class: "nd-lab" }, "Starting bindings"),
                h(
                  "div",
                  { class: "nd-pills" },
                  h("span", { class: "nx-pill" }, "FPS — WASD"),
                  h("span", { class: "nx-pill" }, "Racing"),
                  h("span", { class: "nx-pill on" }, "Numpad player"),
                  h("span", { class: "nx-pill" }, "Empty"),
                ),
                h("div", { class: "nd-colnote" }, "Whole pad on the numpad — good for a second player."),
              ),
              h(
                "div",
                { class: "nd-col" },
                h("div", { class: "nd-lab" }, "SOCD cleaning"),
                h(
                  "div",
                  { class: "nd-pills" },
                  h("span", { class: "nx-pill on" }, "Neutral"),
                  h("span", { class: "nx-pill" }, "Last input"),
                  h("span", { class: "nx-pill" }, "First input"),
                  h("span", { class: "nx-pill" }, "Off"),
                ),
                h(
                  "div",
                  { class: "nd-colnote" },
                  "Resolves simultaneous opposite directions before the pad sees them.",
                ),
              ),
            ),
            h(
              "div",
              { class: "nd-actions" },
              h("button", { class: "nd-btn", type: "button", "data-nx": "dlg-close" }, "Cancel"),
              h(
                "button",
                { class: "nd-btn primary", type: "button", "data-nx": "dlg-close" },
                "Create controller",
              ),
            ),
          ),
        ),
    ),
  );
}
