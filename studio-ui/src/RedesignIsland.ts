import { createList, createSignal, h } from "@getforma/core";
import { createCanvasItem, WidgetCanvas } from "./genui/canvas/index";
import {
  claimSavedDeviceGeometryKey,
  deviceInstanceId,
} from "./device-instance-id";
import {
  syncControllerWidgets,
  type ParkedController,
  type RdControllerCardView,
} from "./redesign-controllers";

// ─────────────────────────────────────────────────────────────────────────────
// /redesign — the transplant rebuild's blank workbench.
//
// The whole viewport is the pan/zoom canvas (the same vendored engine
// /nocturne's center uses), plus the minimap and the camera verbs, and
// deliberately nothing else: pieces of the existing product arrive here one
// by one, copied — never rewritten — from the living page, and are re-homed
// as encapsulated widgets. Every block below is lifted from NocturneIsland
// with only the product widgets trimmed away; the source line ranges are in
// the redesign lane's recon notes, and the copies keep their original
// comments because those carry the measured knowledge.
//
// The root keeps the `nocturne` class ON PURPOSE: all pages share one hashed
// stylesheet, so reusing the class names (`nocturne`, `n-main`, `n-center`,
// `n-canvas`, the meta-bar vocabulary) IS the copy — renaming the root would
// orphan every scoped rule including the `:not(.js)` no-JS relaxation.
// ─────────────────────────────────────────────────────────────────────────────

/** One theme-menu row — `NocturneChoiceRow` on the wire (snapshot.rs), the
 *  same shape /nocturne's pickers consume. */
export interface RdChoiceRowView {
  name: string;
  title: string;
  detail: string;
  cls: string;
  chosen: boolean;
}

/** The rendered twin keeps ARIA token semantics instead of handing a boolean
 * to an attribute setter (where `true` becomes the meaningless empty value). */
interface RdRenderedChoiceRow extends Omit<RdChoiceRowView, "chosen"> {
  chosen: "true" | "false";
}

/** One picker device row — `NocturneDeviceRow` on the wire (snapshot.rs),
 *  the shape /nocturne's roster consumes. `selector` is the RAW backend
 *  string — canonicalizing it is how twin boards collide (the I-PAC
 *  lesson), so it rides untouched into data-selector and the bench store. */
export interface RdDeviceRowView {
  cls: string;
  name: string;
  meta: string;
  role: string;
  selector: string;
  alias: string;
  label: string;
  aria_current: string;
  title: string;
  chart_readable: string;
}

/** A device the picker shows but cannot offer — no keyboard interface, or
 *  no selector to address it by. A name and a meta line and nothing else. */
export interface RdOtherRowView {
  name: string;
  meta: string;
}

/** The workbench picker's truth — `RedesignDeviceRows` on the wire. */
export interface RdDeviceRows {
  keyboards: RdDeviceRowView[];
  encoders: RdDeviceRowView[];
  experimental: RdDeviceRowView[];
  other: RdOtherRowView[];
  keyboards_head: string;
  keyboards_fold_cls: string;
  encoders_head: string;
  encoders_fold_cls: string;
  exp_head: string;
  exp_fold_cls: string;
  other_head: string;
  other_fold_cls: string;
  scan_line: string;
  scan_authoritative: boolean;
  staging_reachable: boolean;
  staging_line: string;
}

/** One persona the controller picker offers — `RedesignPersonaRow` on the
 *  wire (snapshot.rs). `usable` is a served word ("true"/"false"), so the
 *  island routes on a fact instead of parsing a class string. */
export interface RdPersonaRowView {
  name: string;
  label: string;
  api: string;
  note: string;
  cls: string;
  usable: string;
}

/** The controller picker's truth — `RedesignControllers` on the wire. The
 *  CARDS are daemon truth (the staged rack), reconciled onto the canvas by
 *  redesign-controllers.ts; the roster and every ceiling are served. */
export interface RdControllers {
  cards: RdControllerCardView[];
  personas: RdPersonaRowView[];
  add_preset: string;
  add_layout: string;
  add_note: string;
  counts_line: string;
  reachable: boolean;
  parked_held: string[];
}

/** The payload the server embeds and /api/redesign serves — seeded into the
 *  signals by the entry BEFORE the island returns (ledger #5). */
export interface RedesignPayload {
  environment_label: string;
  environment_cls: string;
  theme_rows: RdChoiceRowView[];
  devices: RdDeviceRows;
  controllers: RdControllers;
}

// ── SERVED signals — copiers, never derivers ────────────────────────────────

const [rdEnvLabel, setRdEnvLabel] = createSignal("");
const [rdEnvCls, setRdEnvCls] = createSignal("n-environment unknown");
const [rdThemeRows, setRdThemeRows] = createSignal<RdRenderedChoiceRow[]>([]);
const [rdDevKb, setRdDevKb] = createSignal<RdDeviceRowView[]>([]);
const [rdDevEnc, setRdDevEnc] = createSignal<RdDeviceRowView[]>([]);
const [rdDevExp, setRdDevExp] = createSignal<RdDeviceRowView[]>([]);
const [rdDevOther, setRdDevOther] = createSignal<RdOtherRowView[]>([]);
const [rdDevScanLine, setRdDevScanLine] = createSignal("");
const [rdDevKbHead, setRdDevKbHead] = createSignal("");
const [rdDevKbFoldCls, setRdDevKbFoldCls] = createSignal("n-devfold none");
const [rdDevEncHead, setRdDevEncHead] = createSignal("");
const [rdDevEncFoldCls, setRdDevEncFoldCls] = createSignal("n-devfold none");
const [rdDevExpHead, setRdDevExpHead] = createSignal("");
const [rdDevExpFoldCls, setRdDevExpFoldCls] = createSignal("n-devfold none");
const [rdDevOtherHead, setRdDevOtherHead] = createSignal("");
const [rdDevOtherFoldCls, setRdDevOtherFoldCls] = createSignal("n-devfold none");
const [rdCtrlPersonas, setRdCtrlPersonas] = createSignal<RdPersonaRowView[]>([]);
const [rdCtrlAddNote, setRdCtrlAddNote] = createSignal("");
const [rdCtrlCountsLine, setRdCtrlCountsLine] = createSignal("");
const [rdCtrlAddPreset, setRdCtrlAddPreset] = createSignal("");
const [rdCtrlAddLayout, setRdCtrlAddLayout] = createSignal("");
/** The served card list, held for the canvas reconciler — cards are canvas
 *  widgets, not a template list, so this is plain data, not a signal. */
let rdCtrlCards: RdControllerCardView[] = [];
/** The ghost ids the server still holds parked material for — plain data
 *  for the same reason. */
let rdCtrlParkedHeld: string[] = [];
let rdDeviceScanAuthoritative = false;
let rdStagingReachable = false;
let rdStagingLine = "";

// The action flash. The server fills these from the allowlisted query
// parameter on a full-page load; the fetch-submit layer applies the same
// copy here. A refresh is not an action and never touches them.
const [rdFlashLine, setRdFlashLine] = createSignal("");
const [rdFlashCls, setRdFlashCls] = createSignal("n-flash rd-flash none");

export function applyRedesign(v: RedesignPayload): void {
  const deviceFocus = captureDeviceRowFocus();
  setRdEnvLabel(v.environment_label);
  setRdEnvCls(v.environment_cls);
  const themeRows = v.theme_rows ?? [];
  setRdThemeRows(themeRows.map((row) => ({
    ...row,
    chosen: row.chosen ? "true" : "false",
  })));
  // The ONE verb whose effect lives outside this island's tree (the
  // nocturne lesson, carried over with the rows). Every other form's outcome
  // is repainted from this payload, but the theme is an attribute on <html>
  // that only a full server render used to stamp — so with scripting on
  // (the entry fetch-submits every POST and discards the redirect's page)
  // choosing a theme changed nothing on screen until a manual refresh. The
  // rows already carry the server's choice as DATA (`chosen`/`name`, never
  // prose), so the stamp converges here — including a change made from
  // /nocturne, another tab, or the CLI, which arrives on the next refresh.
  // `system` is the ABSENCE of a stamp: the tokens' `:root:not([data-theme])`
  // media guard needs the attribute GONE, not set to "".
  const chosen = themeRows.find((r) => r.chosen)?.name ?? "";
  const html = document.documentElement;
  if (chosen === "" || chosen === "system") {
    if (html.dataset.theme !== undefined) delete html.dataset.theme;
  } else if (html.dataset.theme !== chosen) {
    html.dataset.theme = chosen;
  }
  const d = v.devices;
  rdDeviceScanAuthoritative = d?.scan_authoritative === true;
  rdStagingReachable = d?.staging_reachable === true;
  rdStagingLine = d?.staging_line ?? "";
  setRdDevKb(d?.keyboards ?? []);
  setRdDevEnc(d?.encoders ?? []);
  setRdDevExp(d?.experimental ?? []);
  setRdDevOther(d?.other ?? []);
  setRdDevScanLine(d?.scan_line ?? "");
  setRdDevKbHead(d?.keyboards_head ?? "");
  setRdDevKbFoldCls(d?.keyboards_fold_cls ?? "n-devfold none");
  setRdDevEncHead(d?.encoders_head ?? "");
  setRdDevEncFoldCls(d?.encoders_fold_cls ?? "n-devfold none");
  setRdDevExpHead(d?.exp_head ?? "");
  setRdDevExpFoldCls(d?.exp_fold_cls ?? "n-devfold none");
  setRdDevOtherHead(d?.other_head ?? "");
  setRdDevOtherFoldCls(d?.other_fold_cls ?? "n-devfold none");
  const c = v.controllers;
  setRdCtrlPersonas(c?.personas ?? []);
  setRdCtrlAddNote(c?.add_note ?? "");
  setRdCtrlCountsLine(c?.counts_line ?? "");
  setRdCtrlAddPreset(c?.add_preset ?? "");
  setRdCtrlAddLayout(c?.add_layout ?? "");
  rdCtrlCards = c?.cards ?? [];
  rdCtrlParkedHeld = c?.parked_held ?? [];
  // Reconcile browser-owned membership with the freshly served roster: a
  // disconnected board leaves the canvas without losing its remembered
  // place, and a remembered board mounts as soon as the scan sees it again.
  reconcileBenchWithRoster();
  // The controller cards are DAEMON truth: the canvas mirrors the staged
  // rack exactly (redesign-controllers.ts owns the reconcile).
  syncCtrlBench();
  restoreDeviceRowFocus(deviceFocus);
}

/** Reconcile the canvas to the served controller cards and the parked
 *  ghosts. A no-op until the engine exists; the canvas init calls it again
 *  once it does. */
function syncCtrlBench(): void {
  const canvas = nCanvas;
  const root = rdRoot;
  if (!canvas || !root) return;
  syncControllerWidgets(rdCtrlCards, {
    canvas,
    root,
    parked: canvasPrefs.parked ?? [],
    parkedHeld: new Set(rdCtrlParkedHeld),
    addPreset: rdCtrlAddPreset(),
    addLayout: rdCtrlAddLayout(),
    savedGeometry: (id) => canvasPrefs.widgets[id],
    park: parkController,
    onMutation: () => {
      syncMapCount();
      scheduleChips();
    },
  });
}

/** Park one orphaned controller's display facts — called by the card the
 *  moment "No player" is chosen, BEFORE its remove posts, so the card's
 *  identity survives whatever the network does. */
function parkController(entry: ParkedController): void {
  canvasPrefs.parked = [...(canvasPrefs.parked ?? []), entry];
  saveCanvasPrefs();
  syncCtrlBench();
}

/** Discard one parked ghost (browser-only), or retire it after a
 *  successful re-slot. Exported for the entry's assign chain. */
export function unparkController(id: string): void {
  canvasPrefs.parked = (canvasPrefs.parked ?? []).filter((p) => p.id !== id);
  saveCanvasPrefs();
  syncCtrlBench();
}


/** Report one action outcome (the redirect's allowlisted ?flash= copy) —
 *  the server derivation in render_redesign.rs `scalar_slots`, mirrored:
 *  strip the marker for display, key the colour class off it. */
export function applyRedesignFlash(flash: string | null): void {
  if (!flash) {
    setRdFlashLine("");
    setRdFlashCls("n-flash rd-flash none");
    return;
  }
  setRdFlashLine(flash.replace(/^error: /, ""));
  setRdFlashCls(flash.startsWith("error") ? "n-flash rd-flash err" : "n-flash rd-flash ok");
}

// ── The canvas (lifted from NocturneIsland's canvas section) ────────────────

/** The lane's OWN store key — sharing /nocturne's would inherit and corrupt
 *  its camera and widget geometry. */
const CANVAS_STORE = "ksx-redesign-canvas";

/** One press of canvas zoom. The engine's own wheel step is finer; a button
 *  press should be a visible move, not a nudge. */
const CANVAS_ZOOM_STEP = 1.25;

/** The runaway rail for widgets — NOT a workspace edge, and not a camera
 *  limit (the view pans freely, the way every canvas tool in this shape
 *  works). It exists only so a widget cannot be flung somewhere nothing can
 *  reach; you should never meet it by dragging.
 *
 *  ⚠️Its ORIGIN is the part that matters. A bound starting at (0, 0) put a
 *  wall 140px above the tidied board — an invisible wall in the middle of an
 *  empty canvas, which is indistinguishable from a bug. It reaches far into
 *  the negative on both axes now, and Fit / the map are what actually bring
 *  a stray widget home. */
const CANVAS_WORLD = { x: -8000, y: -8000, width: 20000, height: 20000 };

interface CanvasItemGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  manualScale: number;
}
interface CanvasPrefs {
  camera?: { panX: number; panY: number; zoom: number };
  widgets: Record<string, CanvasItemGeometry>;
  /** The map is chrome, so it remembers like every other chrome preference.
   *  Absent means shown. */
  mapHidden?: boolean;
  /** The workbench: which devices are on the canvas, by RAW selector (the
   *  I-PAC lesson — canonicalizing a selector is how twin boards collide).
   *  Arrangement state like the camera, never a daemon claim; a remembered
   *  board whose device is gone simply does not mount until it returns. */
  bench?: string[];
  /** Parked controllers — cards orphaned off the draft ("No player") that
   *  wait on the canvas to be re-slotted. Display facts only: the slot
   *  itself left the daemon when it was parked. */
  parked?: ParkedController[];
}

let canvasPrefs: CanvasPrefs = { widgets: {} };
let nCanvas: WidgetCanvas | null = null;
let rdRoot: HTMLElement | null = null;

interface DeviceRowFocus {
  element: HTMLElement;
  selector: string;
}

/** Served list rows can be replaced when their staged marking changes. Keep
 * keyboard focus on the equivalent picker control across that repaint; if
 * the row authoritatively disappears, the modal close button is the stable
 * fallback. */
function captureDeviceRowFocus(): DeviceRowFocus | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !rdRoot?.contains(active)) return null;
  const row = active.closest<HTMLElement>('[data-nx="rd-dev-toggle"][data-selector]');
  const selector = row?.dataset.selector;
  return row && selector ? { element: row, selector } : null;
}

function restoreDeviceRowFocus(snapshot: DeviceRowFocus | null): void {
  if (
    !snapshot || snapshot.element.isConnected || document.activeElement !== document.body ||
    !devModalIsOpen()
  ) return;
  const replacement = Array.from(
    rdRoot?.querySelectorAll<HTMLElement>('[data-nx="rd-dev-toggle"][data-selector]') ?? [],
  ).find((row) => row.dataset.selector === snapshot.selector);
  (replacement ?? rdRoot?.querySelector<HTMLElement>('[data-nx="rd-devs-close"]'))?.focus({
    preventScroll: true,
  });
}

function isGeometry(g: unknown): g is CanvasItemGeometry {
  const v = g as CanvasItemGeometry;
  return (
    typeof v === "object" && v !== null &&
    [v.x, v.y, v.width, v.height, v.z, v.manualScale].every(
      (n) => typeof n === "number" && Number.isFinite(n),
    )
  );
}

function loadCanvasPrefs(): void {
  try {
    const raw = window.localStorage.getItem(CANVAS_STORE);
    if (!raw) return;
    const saved = JSON.parse(raw) as CanvasPrefs;
    const widgets: Record<string, CanvasItemGeometry> = {};
    for (const [key, g] of Object.entries(saved.widgets ?? {})) {
      if (isGeometry(g)) widgets[key] = g;
    }
    const cam = saved.camera;
    canvasPrefs = {
      widgets,
      mapHidden: saved.mapHidden === true,
      bench: Array.isArray(saved.bench)
        ? saved.bench.filter((s): s is string => typeof s === "string")
        : undefined,
      parked: Array.isArray(saved.parked)
        ? saved.parked.filter(
            (p): p is ParkedController =>
              typeof p === "object" && p !== null &&
              typeof p.id === "string" && typeof p.persona === "string" &&
              typeof p.persona_label === "string" && typeof p.preset === "string",
          )
        : undefined,
      camera:
        cam &&
        [cam.panX, cam.panY, cam.zoom].every(
          (n) => typeof n === "number" && Number.isFinite(n),
        )
          ? { panX: cam.panX, panY: cam.panY, zoom: Math.min(3, Math.max(0.08, cam.zoom)) }
          : undefined,
    };
  } catch {
    // A blocked or corrupt store reads as the defaults.
  }
}

function writeCanvasPrefs(next: CanvasPrefs): boolean {
  try {
    window.localStorage.setItem(CANVAS_STORE, JSON.stringify(next));
    return true;
  } catch {
    // The arrangement simply will not survive this session.
    return false;
  }
}

function saveCanvasPrefs(): boolean {
  return writeCanvasPrefs(canvasPrefs);
}

/** Read the camera and every mounted widget's geometry back into the store
 *  — called from the engine's onCommit (its own durable boundary), from the
 *  debounced onChange trail (so a kill mid-arrangement loses at most the
 *  last second), and synchronously on pagehide. */
function persistCanvas(): void {
  const canvas = nCanvas;
  const root = rdRoot;
  if (!canvas || !root) return;
  const widgets: Record<string, CanvasItemGeometry> = { ...canvasPrefs.widgets };
  for (const item of Array.from(
    root.querySelectorAll<HTMLElement>(".n-canvas [data-instance-id]"),
  )) {
    const id = item.dataset.instanceId;
    if (id && item.dataset.canvasX !== undefined) {
      widgets[id] = canvas.getItemState(item);
    }
  }
  canvasPrefs = {
    camera: canvas.getCamera(),
    widgets,
    mapHidden: canvasPrefs.mapHidden,
    bench: canvasPrefs.bench,
    parked: canvasPrefs.parked,
  };
  saveCanvasPrefs();
}

/** Show or hide the map, and swap in the small corner button that brings it
 *  back — the control for a thing in the corner belongs in that corner, not
 *  in a bar at the other end of the page.
 *  ⚠️The engine projects onto the map's MEASURED box, so a hidden one has no
 *  size to project onto: bringing it back has to re-render once it has been
 *  laid out again, or it returns blank. */
function setCanvasMap(hidden: boolean): void {
  const root = rdRoot;
  const map = root?.querySelector<HTMLElement>(".forma-canvas-navigator");
  const show = root?.querySelector<HTMLElement>(".rd-mapshow");
  if (!map) return;
  map.hidden = hidden;
  if (show) show.hidden = !hidden;
  canvasPrefs = { ...canvasPrefs, mapHidden: hidden };
  saveCanvasPrefs();
  if (!hidden) {
    window.requestAnimationFrame(() => {
      nCanvas?.refreshNavigator();
    });
  }
}

let canvasPersistTimer = 0;
function scheduleCanvasPersist(): void {
  window.clearTimeout(canvasPersistTimer);
  canvasPersistTimer = window.setTimeout(persistCanvas, 1000);
}

// ── Semantic-zoom tier readout (design handoff §4) ──────────────────────────

/** The three reading tiers, worded once. Zooming out is not shrinking: each
 *  tier says what a widget should show at this distance, and the readout in
 *  the corner names the tier the camera is in. The thresholds and their
 *  ±3% hysteresis live in the ENGINE now (it also stamps the tier onto the
 *  viewport as `data-canvas-zoom-tier`, which is what the mock nodes' CSS
 *  keys on) — this label can therefore never disagree with the attribute. */
const TIER_COPY: Record<string, string> = {
  overview: "Overview — colour, name, status",
  structure: "Structure — type, ports, one-line summary",
  editing: "Editing — full detail and controls",
};
function applyZoomTier(tier: string): void {
  const el = rdRoot?.querySelector<HTMLElement>(".rd-tier");
  if (el) el.textContent = TIER_COPY[tier] ?? tier;
}

// ── Chrome state the engine reports back ────────────────────────────────────

function syncToolRail(mode: "select" | "hand"): void {
  const root = rdRoot;
  if (!root) return;
  root.querySelector<HTMLElement>('[data-nx="rd-tool-select"]')
    ?.setAttribute("aria-pressed", String(mode === "select"));
  root.querySelector<HTMLElement>('[data-nx="rd-tool-hand"]')
    ?.setAttribute("aria-pressed", String(mode === "hand"));
}

function syncBackView(depth: number, topLabel: string | null): void {
  const button = rdRoot?.querySelector<HTMLButtonElement>('[data-nx="rd-back"]');
  if (!button) return;
  button.hidden = depth === 0;
  button.title = topLabel ? `Back view — ${topLabel}` : "Back view";
}

function syncMapCount(): void {
  const root = rdRoot;
  if (!root) return;
  const el = root.querySelector<HTMLElement>(".rd-map-count");
  if (!el) return;
  // Stage-scoped on purpose: the minimap's own markers carry
  // data-instance-id too and would double the count.
  const count = root.querySelectorAll(".forma-canvas-stage > [data-instance-id]").length;
  el.textContent = count === 1 ? "1 widget" : `${count} widgets`;
}

// ── The zoom menu, the command palette, and the shortcut sheet ──────────────
// All three are SERVED hidden as static markup (the mapshow precedent) and
// toggled client-side, so SSR parity holds with no exemption; the palette's
// result list is the one client-populated box, marked data-client-subtree.

function zoomMenuOpen(): boolean {
  return rdRoot?.querySelector<HTMLElement>(".rd-menu")?.hidden === false;
}
function zoomMenuTrigger(): HTMLButtonElement | null {
  return rdRoot?.querySelector<HTMLButtonElement>('[data-nx="rd-zoom-menu"]') ?? null;
}
function zoomMenuItems(): HTMLButtonElement[] {
  return Array.from(
    rdRoot?.querySelectorAll<HTMLButtonElement>('.rd-menu [role="menuitem"]') ?? [],
  );
}
function setZoomMenu(
  open: boolean,
  focusItem: "first" | "last" = "first",
  restoreFocus = true,
): void {
  const menu = rdRoot?.querySelector<HTMLElement>(".rd-menu");
  if (!menu) return;
  menu.hidden = !open;
  const trigger = zoomMenuTrigger();
  trigger?.setAttribute("aria-expanded", String(open));
  if (open) {
    const items = zoomMenuItems();
    items[focusItem === "last" ? items.length - 1 : 0]?.focus({ preventScroll: true });
  } else if (restoreFocus && menu.contains(document.activeElement)) {
    trigger?.focus({ preventScroll: true });
  }
}

function sheetOpen(): boolean {
  return rdRoot?.querySelector<HTMLElement>(".rd-sheet")?.hidden === false;
}
let sheetReturnFocus: HTMLElement | null = null;

function activeControl(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

function focusCanvasContext(): void {
  const item = nCanvas?.activeItem();
  if (item?.isConnected && !item.inert) item.focus({ preventScroll: true });
  else nCanvas?.focusViewport();
}

function restoreOverlayFocus(target: HTMLElement | null): void {
  if (target?.isConnected && !target.closest("[hidden]")) {
    target.focus({ preventScroll: true });
  } else {
    focusCanvasContext();
  }
}

/** Close the native theme disclosure before a modal surface takes focus.
 *  When the disclosure itself owned focus, its summary is the durable return
 *  point — controls inside a closed details are no longer focusable. */
function closeThemeMenu(restoreFocus = false): boolean {
  const menu = rdRoot?.querySelector<HTMLDetailsElement>(".rd-themed[open]");
  if (!menu) return false;
  menu.open = false;
  if (restoreFocus) {
    menu.querySelector<HTMLElement>(".rd-theme-sum")?.focus({ preventScroll: true });
  }
  return true;
}

function setSheet(open: boolean): void {
  const sheet = rdRoot?.querySelector<HTMLElement>(".rd-sheet");
  if (!sheet || sheet.hidden === !open) return;
  if (open) {
    // Close peers only through their close paths; none of those paths opens a
    // replacement, so modal coordination cannot recurse.
    if (devModalIsOpen()) setDevModal(false);
    if (ctrlModalIsOpen()) setCtrlModal(false);
    if (paletteOpen()) setPalette(false);
    closeThemeMenu(true);
    setZoomMenu(false);
    sheetReturnFocus = activeControl();
    sheet.hidden = false;
    // The bottom Close button can be below a short phone viewport. Land on
    // the visible introduction instead; Tab still reaches the dialog's
    // controls in their natural order.
    sheet.querySelector<HTMLElement>(".rd-sheet-lede")?.focus({ preventScroll: true });
  } else {
    sheet.hidden = true;
    const target = sheetReturnFocus;
    sheetReturnFocus = null;
    restoreOverlayFocus(target);
  }
}

interface PaletteCommand {
  name: string;
  hint: string;
  key: string;
  run: () => void;
}
const PALETTE_DEFAULT_WIDGET_LIMIT = 6;
const PALETTE_DEFAULT_COMMAND_LIMIT = 4;
const PALETTE_RESULT_LIMIT = 10;

function paletteCommands(): PaletteCommand[] {
  return [
    { name: "Fit workflow", hint: "frame every widget on the canvas", key: "1", run: () => nCanvas?.fitAll() },
    { name: "Fit selection", hint: "frame the selected widgets", key: "2", run: () => nCanvas?.fitSelection() },
    { name: "Zoom 100%", hint: "true size, keeps the centre point", key: "0", run: () => nCanvas?.resetZoom() },
    { name: "Center selection", hint: "pan without changing zoom", key: "C", run: () => nCanvas?.centerSelection() },
    {
      name: "Focus selected widget",
      hint: "spotlight it alone — Esc restores the view",
      key: "F",
      run: () => {
        const item = nCanvas?.activeItem();
        if (item) nCanvas?.toggleFocusMode(item);
      },
    },
    { name: "Select tool", hint: "left-drag marquee-selects", key: "V", run: () => nCanvas?.setToolMode("select") },
    { name: "Hand tool", hint: "left-drag pans", key: "H", run: () => nCanvas?.setToolMode("hand") },
    {
      name: "Toggle minimap",
      hint: "the map in the corner",
      key: "M",
      run: () => setCanvasMap(!(canvasPrefs.mapHidden === true)),
    },
  ];
}

let paletteIndex = 0;
let paletteReturnFocus: HTMLElement | null = null;
function paletteOpen(): boolean {
  return rdRoot?.querySelector<HTMLElement>(".rd-palette")?.hidden === false;
}
function setPalette(open: boolean): void {
  const root = rdRoot;
  const overlay = root?.querySelector<HTMLElement>(".rd-palette");
  if (!root || !overlay) return;
  if (overlay.hidden === !open) return;
  if (open) {
    // Only one modal surface owns focus at a time. In particular, Ctrl/Cmd+K
    // replaces an open device picker or shortcut sheet instead of focusing a
    // palette hidden behind it.
    if (devModalIsOpen()) setDevModal(false);
    if (ctrlModalIsOpen()) setCtrlModal(false);
    if (sheetOpen()) setSheet(false);
    closeThemeMenu(true);
    setZoomMenu(false);
    paletteReturnFocus = activeControl();
  }
  overlay.hidden = !open;
  if (!open) {
    const target = paletteReturnFocus;
    paletteReturnFocus = null;
    restoreOverlayFocus(target);
    return;
  }
  const input = overlay.querySelector<HTMLInputElement>(".rd-palette-input");
  if (input) {
    input.value = "";
    input.focus();
  }
  paletteIndex = 0;
  renderPalette("");
}

function trapDialogTab(event: KeyboardEvent): void {
  if (event.key !== "Tab") return;
  const card = event.currentTarget as HTMLElement;
  const controls = Array.from(
    card.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((control) => !control.hidden && !control.closest("[hidden]"));
  if (controls.length === 0) return;
  const first = controls[0];
  const last = controls[controls.length - 1];
  const active = document.activeElement;
  if (!card.contains(active)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

/** Fly the camera to one widget — the palette's landing. The design's rule:
 *  at least 90% zoom, centre it, pulse its outline so the eye finds it. */
function flyToWidget(item: HTMLElement): void {
  const canvas = nCanvas;
  if (!canvas) return;
  if (canvas.isFocusModeActive()) canvas.exitFocusMode();
  canvas.pushCameraHistory("before search jump");
  // Zoom and pan share one camera transaction; splitting them would snap to
  // 90% before the centre tween begins under normal-motion preferences.
  canvas.centerItem(item, { minimumZoom: 0.9 });
  const panel = inspectorEl();
  if (panel && !panel.hidden && inspectorInset() === 0) {
    panel.querySelector<HTMLButtonElement>('[data-nx="rd-insp-close"]')
      ?.focus({ preventScroll: true });
  } else {
    item.focus({ preventScroll: true });
  }
  item.classList.add("rd-pulse");
  window.setTimeout(() => item.classList.remove("rd-pulse"), 1500);
}

function renderPalette(query: string): void {
  const root = rdRoot;
  const list = root?.querySelector<HTMLElement>(".rd-palette-list");
  if (!root || !list) return;
  const needle = query.trim().toLowerCase();
  const widgets = Array.from(
    root.querySelectorAll<HTMLElement>(".n-canvas [data-instance-id][data-widget-name]"),
  );
  const widgetRows = widgets
    .map((item) => ({
      name: item.dataset.widgetName ?? "",
      hint: "widget on this canvas",
      key: "",
      run: () => flyToWidget(item),
    }))
    .filter((row) => row.name);
  const commandRows = paletteCommands();
  const rows = needle
    ? [...widgetRows, ...commandRows]
      .filter((row) =>
        row.name.toLowerCase().includes(needle) ||
        row.hint.toLowerCase().includes(needle)
      )
      .slice(0, PALETTE_RESULT_LIMIT)
    : [
      ...widgetRows.slice(0, PALETTE_DEFAULT_WIDGET_LIMIT),
      ...commandRows.slice(0, PALETTE_DEFAULT_COMMAND_LIMIT),
    ];
  if (paletteIndex >= rows.length) paletteIndex = Math.max(0, rows.length - 1);
  const renderedRows = rows.map((row, index) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "rd-palette-row";
    if (index === paletteIndex) button.setAttribute("aria-current", "true");
    const name = document.createElement("span");
    name.className = "rd-palette-name";
    name.textContent = row.name;
    const hint = document.createElement("span");
    hint.className = "rd-palette-hint";
    hint.textContent = row.hint;
    button.append(name, hint);
    if (row.key) {
      const key = document.createElement("kbd");
      key.className = "rd-palette-key";
      key.textContent = row.key;
      button.append(key);
    }
    button.addEventListener("click", () => {
      setPalette(false);
      row.run();
    });
    li.append(button);
    return li;
  });
  if (renderedRows.length === 0) {
    const empty = document.createElement("li");
    empty.className = "rd-palette-empty";
    empty.setAttribute("role", "status");
    empty.textContent = `Nothing matches “${query.trim()}”`;
    renderedRows.push(empty);
  }
  list.replaceChildren(...renderedRows);
  list.dataset.rowCount = String(rows.length);
}

function paletteKeydown(event: KeyboardEvent): void {
  const list = rdRoot?.querySelector<HTMLElement>(".rd-palette-list");
  const count = Number(list?.dataset.rowCount ?? "0");
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (count === 0) return;
    paletteIndex = event.key === "ArrowDown"
      ? (paletteIndex + 1) % count
      : (paletteIndex - 1 + count) % count;
    const input = rdRoot?.querySelector<HTMLInputElement>(".rd-palette-input");
    renderPalette(input?.value ?? "");
  } else if (event.key === "Enter") {
    event.preventDefault();
    list
      ?.querySelectorAll<HTMLButtonElement>(".rd-palette-row")
      [paletteIndex]?.click();
  }
}

// ── The inspector (design handoff §7): overlay, never reflow ────────────────
// Served hidden; everything dynamic lives in one data-client-subtree box.
// Opening declares its width to the engine as the safe-viewport inset and
// pans by exactly the overlap needed to keep the active widget clear.

function inspectorEl(): HTMLElement | null {
  return rdRoot?.querySelector<HTMLElement>(".rd-inspector") ?? null;
}

function inspectorInset(): number {
  const panel = inspectorEl();
  if (!panel || panel.hidden) return 0;
  const panelRect = panel.getBoundingClientRect();
  const viewportRect = rdRoot
    ?.querySelector<HTMLElement>(".forma-canvas-viewport")
    ?.getBoundingClientRect();
  // At the mobile breakpoint the Inspector is a full-screen drawer, not a
  // right-side obstruction. Feeding its 100vw width into the safe-inset
  // camera math leaves no usable canvas and produces a large hidden pan.
  if (viewportRect && panelRect.width >= viewportRect.width - 1) return 0;
  return Math.min(panelRect.width, viewportRect?.width ?? panelRect.width);
}

function numberField(
  label: string,
  value: number,
  onCommit: (next: number) => void,
): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "rd-insp-field";
  const caption = document.createElement("span");
  caption.textContent = label;
  const input = document.createElement("input");
  input.type = "number";
  input.value = String(value);
  input.addEventListener("change", () => {
    const next = Number(input.value);
    if (Number.isFinite(next)) onCommit(next);
  });
  wrap.append(caption, input);
  return wrap;
}

function inspectorButton(label: string, nx: string, title: string): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "n-autobtn";
  button.dataset.nx = nx;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.textContent = label;
  return button;
}

/** Repaint the inspector's body from the live selection. Called on every
 *  selection or item-state change while open. */
function renderInspector(): void {
  const canvas = nCanvas;
  const body = inspectorEl()?.querySelector<HTMLElement>(".rd-insp-body");
  if (!canvas || !body) return;
  const selected = canvas.selectedItems();
  const rows: (HTMLElement | null)[] = [];
  if (selected.length === 1) {
    const item = selected[0];
    const state = canvas.getItemState(item);
    const title = document.createElement("h2");
    title.className = "rd-insp-name";
    title.textContent = item.dataset.widgetName ?? item.dataset.instanceId ?? "Widget";
    const kind = document.createElement("p");
    kind.className = "rd-insp-kind";
    kind.textContent = `widget · ${Math.round(state.width)} × ${Math.round(state.height)}`;
    const scale = document.createElement("div");
    scale.className = "rd-insp-row";
    const scaleLabel = document.createElement("span");
    scaleLabel.className = "rd-insp-cap";
    scaleLabel.textContent = "Size";
    const smaller = inspectorButton("−", "rd-w-smaller", "Smaller");
    const pct = document.createElement("span");
    pct.className = "rd-insp-pct";
    pct.textContent = `${Math.round(state.manualScale * 100)}%`;
    const bigger = inspectorButton("+", "rd-w-bigger", "Bigger");
    const reset = inspectorButton("100%", "rd-w-reset", "Reset size");
    scale.append(scaleLabel, smaller, pct, bigger, reset);
    const position = document.createElement("div");
    position.className = "rd-insp-row";
    position.append(
      numberField("X", Math.round(state.x), (x) => {
        const current = canvas.getItemState(item);
        canvas.moveItemTo(item, x, current.y);
        renderInspector();
      }),
      numberField("Y", Math.round(state.y), (y) => {
        const current = canvas.getItemState(item);
        canvas.moveItemTo(item, current.x, y);
        renderInspector();
      }),
    );
    const verbs = document.createElement("div");
    verbs.className = "rd-insp-row";
    verbs.append(
      inspectorButton("Focus", "rd-focus-sel", "Spotlight it alone — Esc restores (F)"),
      inspectorButton("Fit", "rd-fit-sel", "Frame it (2)"),
      inspectorButton("Center", "rd-center-sel", "Pan it to the middle (C)"),
    );
    rows.push(title, kind, scale, position, verbs);
  } else if (selected.length > 1) {
    // The multi-selection rules (design handoff §7): no empty sections —
    // only what applies to many. Selection origin moves the whole group by
    // the delta as ONE step.
    const bounds = selected.map((item) => canvas.getItemState(item));
    const minX = Math.min(...bounds.map((s) => s.x));
    const minY = Math.min(...bounds.map((s) => s.y));
    const maxX = Math.max(...bounds.map((s) => s.x + s.width));
    const maxY = Math.max(...bounds.map((s) => s.y + s.height));
    const title = document.createElement("h2");
    title.className = "rd-insp-name";
    title.textContent = `${selected.length} widgets selected`;
    const kind = document.createElement("p");
    kind.className = "rd-insp-kind";
    kind.textContent = `${Math.round(maxX - minX)} × ${Math.round(maxY - minY)} box`;
    const origin = document.createElement("div");
    origin.className = "rd-insp-row";
    origin.append(
      numberField("Origin X", Math.round(minX), (x) => {
        nCanvas?.moveSelectionBy(Math.round(x - minX), 0);
        renderInspector();
      }),
      numberField("Origin Y", Math.round(minY), (y) => {
        nCanvas?.moveSelectionBy(0, Math.round(y - minY));
        renderInspector();
      }),
    );
    const verbs = document.createElement("div");
    verbs.className = "rd-insp-row";
    verbs.append(
      inspectorButton("Fit", "rd-fit-sel", "Frame the selection (2)"),
      inspectorButton("Center", "rd-center-sel", "Pan the selection to the middle (C)"),
    );
    rows.push(title, kind, origin, verbs);
  }
  body.replaceChildren(...rows.filter((row): row is HTMLElement => Boolean(row)));
}

function setInspector(open: boolean): void {
  const panel = inspectorEl();
  const canvas = nCanvas;
  if (!panel || !canvas) return;
  const wasOpen = !panel.hidden;
  panel.hidden = !open;
  rdRoot?.classList.toggle("is-inspector-open", open);
  const inset = inspectorInset();
  canvas.setSafeInsetRight(inset);
  if (open) {
    renderInspector();
    // The design's panel rule: zoom preserved, pan by exactly the overlap —
    // often zero — and only when the panel is NEWLY open.
    if (!wasOpen && inset > 0) canvas.keepActiveClear();
  }
  syncChips();
}

function syncInspectorToSelection(items: HTMLElement[]): void {
  if (items.length === 0) {
    setInspector(false);
    return;
  }
  // Dismissal belongs to the selection that was on screen when X was
  // pressed. A later selection is a new editing intent and reopens the
  // inspector — otherwise its body silently updates while the panel stays
  // closed, with no visible way back in.
  setInspector(true);
}

// ── Off-screen proximity chips (design handoff §6.5) ────────────────────────
// Recomputed on camera SETTLE (150ms debounce), never per frame — arrows
// that jitter during a pan are worse than arrows that appear when you stop.

let chipsTimer = 0;
function scheduleChips(): void {
  window.clearTimeout(chipsTimer);
  chipsTimer = window.setTimeout(syncChips, 150);
}

function syncChips(): void {
  const root = rdRoot;
  const canvas = nCanvas;
  const rail = root?.querySelector<HTMLElement>(".rd-chips");
  if (!root || !canvas || !rail) return;
  // Focus mode masks getCamera() to the entry camera; screen-space chrome
  // cannot be computed there, and focus dims the world anyway.
  if (canvas.isFocusModeActive()) {
    rail.replaceChildren();
    return;
  }
  const viewport = root.querySelector<HTMLElement>(".forma-canvas-viewport");
  const rect = viewport?.getBoundingClientRect();
  if (!rect) return;
  const camera = canvas.getCamera();
  const inset = inspectorInset();
  const safeWidth = rect.width - inset;
  if (safeWidth <= 80) {
    rail.replaceChildren();
    return;
  }
  const centerWorldX = (safeWidth / 2 - camera.panX) / camera.zoom;
  const centerWorldY = (rect.height / 2 - camera.panY) / camera.zoom;
  const offscreen: { item: HTMLElement; name: string; sx: number; sy: number; dist: number }[] = [];
  for (const item of Array.from(
    root.querySelectorAll<HTMLElement>(".forma-canvas-stage > [data-instance-id]"),
  )) {
    if (item.dataset.canvasX === undefined) continue;
    const state = canvas.getItemState(item);
    const cx = state.x + state.width / 2;
    const cy = state.y + state.height / 2;
    const sx = cx * camera.zoom + camera.panX;
    const sy = cy * camera.zoom + camera.panY;
    const right = (state.x + state.width) * camera.zoom + camera.panX;
    const left = state.x * camera.zoom + camera.panX;
    const top = state.y * camera.zoom + camera.panY;
    const bottom = (state.y + state.height) * camera.zoom + camera.panY;
    // The inspector counts as off-screen: a widget behind the panel
    // announces itself.
    const visible = right > 0 && left < safeWidth && bottom > 0 && top < rect.height;
    if (visible) continue;
    offscreen.push({
      item,
      name: item.dataset.widgetName ?? item.dataset.instanceId ?? "widget",
      sx,
      sy,
      dist: Math.round(Math.hypot(cx - centerWorldX, cy - centerWorldY)),
    });
  }
  offscreen.sort((a, b) => a.dist - b.dist);
  const placed: { x: number; y: number }[] = [];
  rail.replaceChildren(
    ...offscreen.slice(0, 4).map(({ item, name, sx, sy, dist }) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "rd-chip";
      // Clamped clear of the lane's own corners (the tool rail, the map
      // panel, the zoom pill) — a chip under other chrome is a control that
      // cannot be pressed — and SPREAD when several widgets sit off in the
      // same direction, or the nearer chip buries the rest.
      let x = Math.min(Math.max(sx, 96), safeWidth - 20);
      let y = Math.min(Math.max(sy, 56), rect.height - 72);
      while (placed.some((p) => Math.abs(p.x - x) < 90 && Math.abs(p.y - y) < 30)) {
        y = Math.min(y + 34, rect.height - 72);
        if (y >= rect.height - 72) x += 120;
      }
      placed.push({ x, y });
      chip.style.left = `${x}px`;
      chip.style.top = `${y}px`;
      const angle = Math.atan2(
        sy - rect.height / 2,
        sx - safeWidth / 2,
      );
      const caret = document.createElement("span");
      caret.className = "rd-chip-caret";
      caret.style.transform = `rotate(${Math.round((angle * 180) / Math.PI)}deg)`;
      caret.textContent = "➤";
      const label = document.createElement("span");
      label.textContent = `${name} · ${dist}px`;
      chip.append(caret, label);
      chip.addEventListener("click", () => flyToWidget(item));
      return chip;
    }),
  );
}

// ── Hover spotlight v0 (design handoff §6.5) ────────────────────────────────
// Hover a widget, dim the rest. Suppressed while a gesture or focus mode is
// active. Becomes the SIGNAL TRACE when binding edges transplant in.

function wireSpotlight(stage: HTMLElement, viewport: HTMLElement): void {
  stage.addEventListener("pointerover", (event) => {
    const item = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      ".forma-canvas-stage > [data-instance-id]",
    );
    if (!item) return;
    if (
      viewport.classList.contains("is-panning") ||
      viewport.classList.contains("is-dragging-widget") ||
      nCanvas?.isFocusModeActive()
    ) return;
    stage.classList.add("rd-spotlighting");
    item.classList.add("rd-spot");
  });
  stage.addEventListener("pointerout", (event) => {
    const item = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      ".forma-canvas-stage > [data-instance-id]",
    );
    if (!item) return;
    // pointerout bubbles for every child boundary. Moving from a summary into
    // its detail rows is still hovering the same widget and must not flash the
    // rest of the canvas off and back on.
    if (event.relatedTarget instanceof Node && item.contains(event.relatedTarget)) return;
    stage.classList.remove("rd-spotlighting");
    item.classList.remove("rd-spot");
  });
}

// The mock nodes lived here until 2026-08-28 — two disposable widgets that
// gave selection, marquee, drag, focus, fit and the semantic tiers something
// to act on. The first product transplant (the device workbench) landed, so
// they are gone, exactly as their own comment promised. The workbench starts
// EMPTY on purpose: boards arrive through the picker.

// ── The device workbench (the lane's thesis made real) ──────────────────────
// The canvas is a WORKBENCH: the picker adds boards to it — several at once —
// and each lands as a widget. Membership is the browser's arrangement state
// (canvasPrefs, beside the camera and the widget geometry), never a daemon
// claim; every fact ON a widget is served. Widgets are client-created
// (`data-client-widget` — parity rule 3e); they are the real product surface
// that replaced the disposable mock nodes.

function benchSelectors(): string[] {
  return canvasPrefs.bench ?? [];
}

/** Ownership for the old lossy storage keys during this canvas lifetime.
 * Twin selectors may share a legacy key, but never its coordinates. */
const legacyGeometryOwners = new Map<string, string>();

function deviceRowFor(selector: string): RdDeviceRowView | undefined {
  return [...rdDevKb(), ...rdDevEnc(), ...rdDevExp()].find((r) => r.selector === selector);
}

const DEVICE_ROLE_BADGE: Record<string, string> = {
  "panel-encoder": "Panel encoder",
  keyboard: "Keyboard",
};
const STAGED_DEVICE_TITLE =
  "This board is the background helper's staged choice. Staging it again changes nothing — " +
  "a keyboard prepared for play keeps its preparation.";

function deviceCardContent(row: RdDeviceRowView): HTMLElement {
  const body = document.createElement("div");
  body.className = "rd-devcard";
  const badge = document.createElement("p");
  badge.className = "rd-devcard-badge";
  badge.dataset.role = row.role;
  badge.textContent = DEVICE_ROLE_BADGE[row.role] ?? "Experimental";
  const name = document.createElement("p");
  name.className = "rd-devcard-name";
  name.textContent = row.name;
  const meta = document.createElement("p");
  meta.className = "rd-devcard-meta";
  meta.textContent = row.meta;
  // The daemon chip and the daemon verb. `data-staged` on the ITEM decides
  // which shows (syncBenchCards keeps it true to the served rows): a staged
  // board wears the chip; every other pickable board offers the act. The
  // form is a REAL POST — the entry's fetch-submit layer carries it, the
  // flash speaks, and the refresh moves the marking wherever it now belongs.
  const staged = document.createElement("p");
  staged.className = "rd-devcard-staged";
  staged.textContent = "Staged — the board ksx splits";
  staged.title = STAGED_DEVICE_TITLE;
  const form = document.createElement("form");
  form.className = "rd-stageform";
  form.method = "post";
  form.action = "/redesign/device";
  form.dataset.rdForm = "device";
  for (const [fieldName, value] of [
    ["selector", row.selector],
    ["alias", row.alias],
    ["label", row.label],
  ]) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = fieldName;
    input.value = value;
    form.append(input);
  }
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "rd-stagebtn";
  submit.textContent = "Stage this board";
  submit.title =
    "Make this the board ksx splits — replaces the daemon's current choice. " +
    "Nothing is saved or started, and a board already prepared keeps its preparation.";
  form.append(submit);
  body.append(badge, name, meta, staged, form);
  return body;
}

/** Mount one board onto the workbench: the saved spot if this board has been
 *  here before (removal keeps geometry), otherwise a staggered open spot. */
function mountDeviceWidget(row: RdDeviceRowView, index: number): void {
  const canvas = nCanvas;
  if (!canvas) return;
  const slug = deviceInstanceId(row.selector);
  const savedGeometryKey = claimSavedDeviceGeometryKey(
    row.selector,
    new Set(Object.keys(canvasPrefs.widgets)),
    legacyGeometryOwners,
  );
  const item = createCanvasItem({
    instanceId: slug,
    displayName: row.name,
    preferredWidth: 300,
    minHeight: 150,
    content: deviceCardContent(row),
    document,
  });
  item.dataset.clientWidget = "";
  item.dataset.selector = row.selector;
  item.dataset.staged = row.aria_current === "true" ? "true" : "false";
  item.classList.add("rd-dev-node");
  const home: CanvasItemGeometry = {
    x: 140 + (index % 3) * 340,
    y: 160 + Math.floor(index / 3) * 200,
    width: 300,
    height: 150,
    z: 3 + index,
    manualScale: 1,
  };
  canvas.mountItem(
    item,
    (savedGeometryKey ? canvasPrefs.widgets[savedGeometryKey] : undefined) ?? home,
    { focus: false },
  );
}

function benchItemEl(selector: string): HTMLElement | null {
  return (
    rdRoot?.querySelector<HTMLElement>(
      `.forma-canvas-stage > [data-instance-id="${deviceInstanceId(selector)}"]`,
    ) ?? null
  );
}

function rememberDeviceGeometry(item: HTMLElement): void {
  const canvas = nCanvas;
  const id = item.dataset.instanceId;
  if (!canvas || !id || item.dataset.canvasX === undefined) return;
  canvasPrefs.widgets = {
    ...canvasPrefs.widgets,
    [id]: canvas.getItemState(item),
  };
}

/** Add or remove one board. Removal keeps the saved geometry, so a board
 *  that returns lands where it lived. */
function toggleBenchDevice(selector: string): void {
  const bench = benchSelectors();
  if (bench.includes(selector)) {
    const item = benchItemEl(selector);
    if (item) {
      rememberDeviceGeometry(item);
      nCanvas?.removeItem(item, { selectFallback: false });
    }
    canvasPrefs.bench = bench.filter((s) => s !== selector);
  } else {
    const row = deviceRowFor(selector);
    if (!row) return;
    mountDeviceWidget(row, bench.length);
    canvasPrefs.bench = [...bench, selector];
  }
  saveCanvasPrefs();
  syncMapCount();
  syncDeviceRows();
  // A card added while a mutation is pending or either provider is
  // unavailable must inherit that state immediately; the mount defaults are
  // only a structural fallback until served truth is applied.
  syncBenchCards();
}

/** Re-mount every remembered board whose device is still in the served
 *  roster. One that vanished stays remembered but not mounted — honestly
 *  absent, back the moment the scan offers it again. */
function restoreBench(): void {
  reconcileBenchWithRoster();
}

/** Reconcile browser-owned bench membership against current served truth.
 * Missing devices unmount but stay in `canvasPrefs.bench`; their exact
 * geometry is retained. Reappearing devices remount at that same geometry. */
function reconcileBenchWithRoster(): void {
  const canvas = nCanvas;
  if (!canvas) {
    syncDeviceRows();
    return;
  }

  const bench = new Set(benchSelectors());
  let changed = false;
  for (const item of Array.from(
    rdRoot?.querySelectorAll<HTMLElement>(".rd-dev-node[data-selector]") ?? [],
  )) {
    const selector = item.dataset.selector ?? "";
    // A refused scan is UNKNOWN, not an authoritative empty roster. Keep the
    // remembered card mounted and let syncBenchCards mark its status unknown.
    if (
      bench.has(selector) &&
      (deviceRowFor(selector) || !rdDeviceScanAuthoritative)
    ) continue;
    rememberDeviceGeometry(item);
    canvas.removeItem(item, { selectFallback: false });
    changed = true;
  }

  benchSelectors().forEach((selector, index) => {
    const row = deviceRowFor(selector);
    if (row && !benchItemEl(selector)) {
      mountDeviceWidget(row, index);
      changed = true;
    }
  });

  syncDeviceRows();
  syncBenchCards();
  // Names and roles can change without membership changing. Keep the
  // selection surface and proximity labels on the same served repaint.
  renderInspector();
  scheduleChips();
  if (changed) {
    saveCanvasPrefs();
    syncMapCount();
  }
}

/** Repaint every served fact on mounted cards, including the daemon's staged
 * choice. Membership and geometry remain browser-owned and untouched. */
function syncBenchCards(): void {
  for (const item of Array.from(
    rdRoot?.querySelectorAll<HTMLElement>(".rd-dev-node[data-selector]") ?? [],
  )) {
    const row = deviceRowFor(item.dataset.selector ?? "");
    const status = item.querySelector<HTMLElement>(".rd-devcard-staged");
    const meta = item.querySelector<HTMLElement>(".rd-devcard-meta");
    const stageButton = item.querySelector<HTMLButtonElement>(".rd-stagebtn");
    const actionAvailable = rdDeviceScanAuthoritative && rdStagingReachable && Boolean(row);
    item.dataset.scanAuthoritative = rdDeviceScanAuthoritative ? "true" : "false";
    item.dataset.stagingReachable = rdStagingReachable ? "true" : "false";
    item.dataset.staged = actionAvailable
      ? (row!.aria_current === "true" ? "true" : "false")
      : "unknown";
    if (stageButton) {
      stageButton.dataset.rdProductDisabled = actionAvailable ? "false" : "true";
      stageButton.disabled = !actionAvailable || rdRoot?.dataset.rdMutationPending === "true";
    }

    if (!rdDeviceScanAuthoritative) {
      if (meta) meta.textContent = `Status unavailable — ${rdDevScanLine()}`;
      if (status) {
        status.textContent = "Device status unavailable — latest scan did not answer";
        status.title = rdDevScanLine();
      }
      continue;
    }
    if (!row) continue;

    if (!rdStagingReachable) {
      if (status) {
        status.textContent = rdStagingLine || "Staging unavailable";
        status.title = rdStagingLine || "Staging unavailable";
      }
    } else if (status) {
      status.textContent = "Staged — the board ksx splits";
      status.title = STAGED_DEVICE_TITLE;
    }
    item.dataset.widgetName = row.name;
    item.setAttribute("aria-label", row.name);
    item.querySelector<HTMLElement>(".rd-devcard-badge")!.dataset.role = row.role;
    item.querySelector<HTMLElement>(".rd-devcard-badge")!.textContent =
      DEVICE_ROLE_BADGE[row.role] ?? "Experimental";
    item.querySelector<HTMLElement>(".rd-devcard-name")!.textContent = row.name;
    if (meta) meta.textContent = row.meta;
    item.querySelector<HTMLElement>(".widget-drag-handle")?.setAttribute(
      "aria-label",
      `Move ${row.name}`,
    );
    for (const [fieldName, value] of [
      ["selector", row.selector],
      ["alias", row.alias],
      ["label", row.label],
    ]) {
      const input = item.querySelector<HTMLInputElement>(
        `.rd-stageform input[name="${fieldName}"]`,
      );
      if (input) input.value = value;
    }
    const id = item.dataset.instanceId;
    const marker = id
      ? rdRoot?.querySelector<HTMLElement>(`.navigator-item[data-instance-id="${id}"]`)
      : null;
    marker?.setAttribute("aria-label", `Focus ${row.name}`);
    if (marker) marker.title = row.name;
  }
}

/** Decorate the picker rows with CLIENT truth — membership — after any
 *  render: aria-pressed, the `.on` marking, the verb word. Imperative like
 *  the map-marker labeller, because the rows re-render from SERVER data and
 *  membership is not server data. */
function syncDeviceRows(): void {
  const bench = benchSelectors();
  for (const btn of Array.from(
    rdRoot?.querySelectorAll<HTMLElement>('[data-nx="rd-dev-toggle"]') ?? [],
  )) {
    const on = bench.includes(btn.dataset.selector ?? "");
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.classList.toggle("on", on);
    const word = btn.querySelector<HTMLElement>(".rd-dev-word");
    if (word) {
      word.textContent = on ? "On the workbench — press to remove" : "Add to workbench";
    }
  }
}

// ── The device picker modal ─────────────────────────────────────────────────

function devModalEl(): HTMLElement | null {
  return rdRoot?.querySelector<HTMLElement>(".rd-devmodal") ?? null;
}

function devModalIsOpen(): boolean {
  const el = devModalEl();
  return Boolean(el && !el.hidden);
}

let devModalReturnFocus: HTMLElement | null = null;
function setDevModal(open: boolean): void {
  const el = devModalEl();
  if (!el || el.hidden === !open) return;
  if (open) {
    // Opening paths close peers; closing paths only restore focus. Keeping
    // that direction one-way prevents modal hand-offs from recursing.
    if (ctrlModalIsOpen()) setCtrlModal(false);
    if (sheetOpen()) setSheet(false);
    if (paletteOpen()) setPalette(false);
    closeThemeMenu(true);
    setZoomMenu(false);
    devModalReturnFocus = activeControl();
    syncDeviceRows();
    el.hidden = false;
    el.querySelector<HTMLButtonElement>(
      '.rd-devmodal-head button[data-nx="rd-devs-close"]',
    )?.focus({ preventScroll: true });
  } else {
    el.hidden = true;
    const target = devModalReturnFocus;
    devModalReturnFocus = null;
    restoreOverlayFocus(target);
  }
}

// ── The controller picker modal — the device picker's twin, one per truth ──

function ctrlModalEl(): HTMLElement | null {
  return rdRoot?.querySelector<HTMLElement>(".rd-ctrlmodal") ?? null;
}

function ctrlModalIsOpen(): boolean {
  const el = ctrlModalEl();
  return Boolean(el && !el.hidden);
}

let ctrlModalReturnFocus: HTMLElement | null = null;
function setCtrlModal(open: boolean): void {
  const el = ctrlModalEl();
  if (!el || el.hidden === !open) return;
  if (open) {
    if (devModalIsOpen()) setDevModal(false);
    if (sheetOpen()) setSheet(false);
    if (paletteOpen()) setPalette(false);
    closeThemeMenu(true);
    setZoomMenu(false);
    ctrlModalReturnFocus = activeControl();
    el.hidden = false;
    el.querySelector<HTMLButtonElement>(
      '.rd-ctrlmodal-head button[data-nx="rd-ctrls-close"]',
    )?.focus({ preventScroll: true });
  } else {
    el.hidden = true;
    const target = ctrlModalReturnFocus;
    ctrlModalReturnFocus = null;
    restoreOverlayFocus(target);
  }
}


/** Adopt the served canvas skeleton. Runs once, strictly AFTER adoption (the
 *  entry's post-mount frame): the engine annotates the served nodes, and
 *  every one of its writes rides the parity contract's client-canvas
 *  exemption.
 *
 *  ⚠️It WAITS for the skeleton instead of assuming one frame is enough.
 *  Adoption rebuilds the island subtree, so the queries can legitimately
 *  miss on the frame this first runs — and a bare early return would leave a
 *  canvas that never comes alive: no error, no console line, just a dead
 *  surface every gate but a dead-canvas assert reads as healthy. Re-asking
 *  each frame costs nothing; the budget stops a page that legitimately has
 *  no canvas from asking forever. */
const CANVAS_ADOPT_FRAMES = 60;
export function initRedesignCanvas(root: HTMLElement, attempt = 0): void {
  if (nCanvas) return;
  // The island root itself can be replaced by adoption; a detached one would
  // hand the engine a tree nobody sees.
  const scope = root.isConnected ? root : (rdRoot?.isConnected ? rdRoot : document.body);
  const surface = scope.querySelector<HTMLElement>(".n-canvas");
  const viewport = surface?.querySelector<HTMLElement>(".forma-canvas-viewport");
  const stage = surface?.querySelector<HTMLElement>(".forma-canvas-stage");
  // The zoom readout IS the 100% button in the meta bar: the engine writes
  // the live percentage into whatever element it is handed, and a button
  // that reads the zoom and resets it on click is one control instead of a
  // static label beside a number somewhere else.
  const zoomStatus = scope.querySelector<HTMLElement>(".n-zoomval");
  if (!surface || !viewport || !stage || !zoomStatus || !surface.isConnected) {
    if (attempt < CANVAS_ADOPT_FRAMES) {
      window.requestAnimationFrame(() => initRedesignCanvas(root, attempt + 1));
    }
    return;
  }
  // The minimap navigator: served skeleton, engine-filled. Its markers are
  // one button per widget (click jumps to it) and the pale rectangle is the
  // camera — dragging inside the map pans. Both are the engine's own; this
  // only hands it the served nodes. A page missing the skeleton falls back
  // to DETACHED nodes so the canvas still runs with no map.
  const navigator = surface.querySelector<HTMLElement>(".forma-canvas-navigator") ??
    document.createElement("aside");
  const navigatorItems = navigator.querySelector<HTMLElement>(".forma-canvas-navigator-items") ??
    document.createElement("div");
  const navigatorViewport = navigator
    .querySelector<HTMLElement>(".forma-canvas-navigator-viewport") ??
    document.createElement("div");
  if (!navigatorItems.isConnected) navigator.append(navigatorItems, navigatorViewport);
  // The engine reads pointerdown ANYWHERE in the map as "navigate to here"
  // (it only excuses its own markers), so the whole header has to stop the
  // press from reaching it. Otherwise clicking the title or putting the map
  // away jumps the camera. Click still bubbles to the delegated handler.
  navigator
    .querySelector<HTMLElement>(".rd-map-head")
    ?.addEventListener("pointerdown", (event) => event.stopPropagation());
  loadCanvasPrefs();
  nCanvas = new WidgetCanvas(
    { viewport, stage, zoomStatus, navigator, navigatorItems, navigatorViewport },
    {
      onCommit: () => {
        persistCanvas();
        scheduleChips();
      },
      // The trail behind onCommit: pans and in-flight drags reach the store
      // within a second even if the tab dies before a durable boundary.
      onChange: () => {
        scheduleCanvasPersist();
        scheduleChips();
      },
      // The engine has no live region of its own; the meta bar's sr status
      // line is this page's.
      onKeyboardNavigation: (message) => {
        const sr = (rdRoot ?? scope).querySelector<HTMLElement>(".n-live-sr");
        if (sr) sr.textContent = message;
      },
      worldBounds: CANVAS_WORLD,
      // The design-tool model (design handoff §2): empty-drag marquees,
      // panning belongs to space/middle/right/two-finger/hand, plain wheel
      // pans and ctrl/cmd+wheel (= pinch) zooms at the pointer.
      navigationModel: "design-tool",
      zoomRange: { min: 0.08, max: 3 },
      onToolModeChange: syncToolRail,
      onZoomChange: (_zoom, tier) => applyZoomTier(tier),
      onCameraHistoryChange: syncBackView,
      onSelectionChange: syncInspectorToSelection,
      onActiveItemStateChange: () => renderInspector(),
      // Focus opens the inspector (design handoff §3) and hides the chips.
      onFocusModeChange: (_item, focused) => {
        if (focused) {
          setInspector(true);
        }
        syncChips();
      },
    },
  );
  setCanvasMap(canvasPrefs.mapHidden === true);
  restoreBench();
  syncCtrlBench();
  syncMapCount();
  syncToolRail(nCanvas.toolMode());
  wireSpotlight(stage, viewport);
  scheduleChips();
  // The automatic first-open fit never pushes history — only USER camera
  // verbs mint Back-view entries.
  if (canvasPrefs.camera) nCanvas.restoreCamera(canvasPrefs.camera);
  else window.requestAnimationFrame(() => nCanvas?.fitAll(false));
  window.addEventListener("pagehide", () => {
    // flushPendingChange only fires the onChange callback — whose debounce
    // timer will never tick in a dying page. The synchronous persist IS the
    // durability; the flush just settles the engine's pending rAF first.
    nCanvas?.flushPendingChange();
    persistCanvas();
  });
}

// ── Wire: root marker, camera verbs, focus-mode escape ──────────────────────

/** Single keys must never fire while someone is typing (design handoff §2);
 *  cmd-combinations are checked BEFORE this guard so ⌘K works from a field. */
function typingIntoSomething(event: KeyboardEvent): boolean {
  const target = event.target;
  return target instanceof HTMLElement &&
    Boolean(target.closest("input, textarea, select, [contenteditable]"));
}

function canvasOwnsKeyboardFocus(): boolean {
  const canvas = rdRoot?.querySelector<HTMLElement>(".n-canvas");
  const active = document.activeElement;
  return Boolean(canvas && active instanceof HTMLElement && canvas.contains(active));
}

export function redesignWire(root: HTMLElement): void {
  rdRoot = root;
  // The wire's own "JavaScript is live" marker: scripting-only chrome (the
  // camera buttons) reveals off it, and the parity gate normalizes it.
  root.classList.add("js");
  root.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    const hit = target?.closest<HTMLElement>("[data-nx]")?.dataset.nx;
    // Any un-annotated click puts the zoom menu away (the nocturne
    // configuration menu's own convention).
    if (
      zoomMenuOpen() && hit !== "rd-zoom-menu" &&
      !target?.closest(".rd-menu")
    ) {
      setZoomMenu(false);
    }
    // The theme menu (a native details): an outside click puts it away —
    // the nocturne configuration menu's own convention. Closing after an
    // action belongs to the fetch-submit layer, not here.
    const themeMenu = rdRoot?.querySelector<HTMLElement>(".rd-themed[open]");
    if (themeMenu && !target?.closest(".rd-themed")) {
      closeThemeMenu();
    }
    if (!hit) return;
    const closeMenuAfter = Boolean(target?.closest(".rd-menu"));
    if (hit === "canvas-fit") {
      nCanvas?.fitAll();
    } else if (hit === "rd-fit-sel") {
      nCanvas?.fitSelection();
    } else if (hit === "rd-center-sel") {
      nCanvas?.centerSelection();
    } else if (hit === "rd-focus-sel") {
      const item = nCanvas?.activeItem();
      if (item) nCanvas?.toggleFocusMode(item);
    } else if (hit === "rd-devs-open") {
      setDevModal(true);
      return;
    } else if (hit === "rd-devs-close") {
      setDevModal(false);
      return;
    } else if (hit === "rd-dev-toggle") {
      const selector = target?.closest<HTMLElement>('[data-nx="rd-dev-toggle"]')?.dataset
        .selector;
      if (selector) toggleBenchDevice(selector);
      return;
    } else if (hit === "rd-ctrls-open") {
      setCtrlModal(true);
      return;
    } else if (hit === "rd-ctrls-close") {
      setCtrlModal(false);
      return;
    } else if (hit === "rd-ctrl-discard") {
      const ghost = target?.closest<HTMLElement>('[data-nx="rd-ctrl-discard"]')?.dataset
        .ghost;
      if (ghost) unparkController(ghost);
      return;
    } else if (hit === "rd-zoom-menu") {
      setZoomMenu(!zoomMenuOpen());
      return;
    } else if (hit === "rd-z-25") {
      nCanvas?.setZoomTo(0.25, "before zoom menu pick");
    } else if (hit === "rd-z-50") {
      nCanvas?.setZoomTo(0.5, "before zoom menu pick");
    } else if (hit === "rd-z-75") {
      nCanvas?.setZoomTo(0.75, "before zoom menu pick");
    } else if (hit === "rd-z-100") {
      nCanvas?.resetZoom();
    } else if (hit === "rd-z-150") {
      nCanvas?.setZoomTo(1.5, "before zoom menu pick");
    } else if (hit === "canvas-zoom-in") {
      nCanvas?.zoomBy(CANVAS_ZOOM_STEP);
    } else if (hit === "canvas-zoom-out") {
      nCanvas?.zoomBy(1 / CANVAS_ZOOM_STEP);
    } else if (hit === "canvas-map") {
      setCanvasMap(!(canvasPrefs.mapHidden === true));
    } else if (hit === "rd-tool-select") {
      nCanvas?.setToolMode("select");
    } else if (hit === "rd-tool-hand") {
      nCanvas?.setToolMode("hand");
    } else if (hit === "rd-back") {
      nCanvas?.backView();
    } else if (hit === "rd-insp-close") {
      // The inspector is Focus mode's editing surface. Closing it must leave
      // that mode too, or the rest of the canvas remains inert behind a panel
      // that is no longer visible.
      nCanvas?.exitFocusMode();
      setInspector(false);
      focusCanvasContext();
    } else if (hit === "rd-w-smaller" || hit === "rd-w-bigger" || hit === "rd-w-reset") {
      const widget = nCanvas?.activeItem();
      if (widget && nCanvas) {
        if (hit === "rd-w-smaller") nCanvas.adjustItemScale(widget, -1);
        else if (hit === "rd-w-bigger") nCanvas.adjustItemScale(widget, 1);
        else nCanvas.resetItemScale(widget);
        renderInspector();
      }
    } else if (hit === "rd-search") {
      setPalette(true);
    } else if (hit === "rd-keys") {
      setSheet(true);
    } else if (hit === "rd-sheet-close") {
      setSheet(false);
    } else if (hit === "rd-palette-close") {
      setPalette(false);
    }
    if (closeMenuAfter) setZoomMenu(false);
  });

  const paletteInput = root.querySelector<HTMLInputElement>(".rd-palette-input");
  paletteInput?.addEventListener("input", () => {
    paletteIndex = 0;
    renderPalette(paletteInput.value);
  });
  paletteInput?.addEventListener("keydown", paletteKeydown);
  root.querySelector<HTMLElement>(".rd-palette-card")
    ?.addEventListener("keydown", trapDialogTab);
  root.querySelector<HTMLElement>(".rd-sheet-card")
    ?.addEventListener("keydown", trapDialogTab);
  root.querySelector<HTMLElement>(".rd-devmodal-panel")
    ?.addEventListener("keydown", trapDialogTab);
  root.querySelector<HTMLElement>(".rd-ctrlmodal-panel")
    ?.addEventListener("keydown", trapDialogTab);

  const zoomTrigger = zoomMenuTrigger();
  const zoomMenu = root.querySelector<HTMLElement>(".rd-menu");
  zoomTrigger?.addEventListener("keydown", (event) => {
    if (
      event.key !== "Enter" && event.key !== " " &&
      event.key !== "ArrowDown" && event.key !== "ArrowUp"
    ) return;
    event.preventDefault();
    event.stopPropagation();
    setZoomMenu(true, event.key === "ArrowUp" ? "last" : "first");
  });
  zoomMenu?.addEventListener("keydown", (event) => {
    const items = zoomMenuItems();
    if (items.length === 0) return;
    const activeIndex = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = (activeIndex + 1) % items.length;
    else if (event.key === "ArrowUp") nextIndex = (activeIndex - 1 + items.length) % items.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex !== null) {
      event.preventDefault();
      event.stopPropagation();
      items[nextIndex]?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setZoomMenu(false);
    } else if (event.key === "Tab") {
      // A menu is not a focus trap. Move to the adjacent zoom-cluster
      // control explicitly so hiding the focused popup cannot strand focus.
      event.preventDefault();
      event.stopPropagation();
      const destination = event.shiftKey
        ? zoomTrigger
        : root.querySelector<HTMLButtonElement>('[data-nx="canvas-zoom-in"]');
      setZoomMenu(false, "first", false);
      destination?.focus({ preventScroll: true });
    }
  });
  window.addEventListener("resize", () => {
    nCanvas?.setSafeInsetRight(inspectorInset(), true);
    scheduleChips();
  });

  window.addEventListener("keydown", (ev) => {
    // Ctrl/Cmd+K / F open the palette from ANYWHERE, a text field included —
    // the one binding checked before the typing guard.
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === "k" || ev.key === "f")) {
      ev.preventDefault();
      setPalette(!paletteOpen());
      return;
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // The engine's own targeted handlers (viewport arrows, the widget
    // shell's Escape/Enter) run before this window listener and
    // preventDefault when they act — never double-handle their keys.
    if (ev.defaultPrevented) return;
    if (ev.repeat && (
      ev.key === "Escape" || ev.key === "f" || ev.key === "F" ||
      ev.key === "m" || ev.key === "M" || ev.key === "?"
    )) {
      ev.preventDefault();
      return;
    }
    if (ev.key === "Escape") {
      // The escape ladder (design handoff §2), one rung per press: theme
      // menu → device picker → sheet → palette → camera menu → focus mode →
      // back view → clear selection. A closed disclosure returns focus to
      // its trigger instead of letting the same key reach the canvas below.
      if (closeThemeMenu(true)) {
        ev.preventDefault();
        return;
      }
      if (ctrlModalIsOpen()) setCtrlModal(false);
      else if (devModalIsOpen()) setDevModal(false);
      else if (sheetOpen()) setSheet(false);
      else if (paletteOpen()) setPalette(false);
      else if (zoomMenuOpen()) setZoomMenu(false);
      // Escape in an Inspector field belongs to that field; it must never
      // pop camera history or clear the selection being edited.
      else if (typingIntoSomething(ev)) return;
      else if (nCanvas?.isFocusModeActive()) {
        nCanvas.exitFocusMode();
      } else if (!nCanvas?.backView()) {
        nCanvas?.clearActive();
      }
      ev.preventDefault();
      return;
    }
    if (typingIntoSomething(ev)) return;
    // Unmodified design-tool shortcuts belong to the canvas. Keep them from
    // firing while focus is in the title bar or Inspector; Cmd/Ctrl+K and the
    // Escape ladder above remain intentionally global.
    if (!canvasOwnsKeyboardFocus()) return;
    const key = ev.key;
    if (key === "+" || key === "=") {
      ev.preventDefault();
      nCanvas?.zoomBy(CANVAS_ZOOM_STEP);
    } else if (key === "-") {
      ev.preventDefault();
      nCanvas?.zoomBy(1 / CANVAS_ZOOM_STEP);
    } else if (key === "0") {
      ev.preventDefault();
      nCanvas?.resetZoom();
    } else if (key === "1") {
      ev.preventDefault();
      nCanvas?.fitAll();
    } else if (key === "2") {
      ev.preventDefault();
      nCanvas?.fitSelection();
    } else if (key === "c" || key === "C") {
      ev.preventDefault();
      nCanvas?.centerSelection();
    } else if (key === "f" || key === "F") {
      const item = nCanvas?.activeItem();
      if (item) {
        ev.preventDefault();
        nCanvas?.toggleFocusMode(item);
      }
    } else if (key === "m" || key === "M") {
      ev.preventDefault();
      setCanvasMap(!(canvasPrefs.mapHidden === true));
    } else if (key === "v" || key === "V") {
      ev.preventDefault();
      nCanvas?.setToolMode("select");
    } else if (key === "h" || key === "H") {
      ev.preventDefault();
      nCanvas?.setToolMode("hand");
    } else if (key === "?") {
      ev.preventDefault();
      setSheet(!sheetOpen());
    } else if (
      key === "ArrowLeft" || key === "ArrowRight" ||
      key === "ArrowUp" || key === "ArrowDown"
    ) {
      // Arrows move the SELECTION (12px, shift 1px) when one exists; with
      // nothing selected the engine's own viewport arrows pan the camera.
      const step = ev.shiftKey ? 1 : 12;
      const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
      const dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
      if (nCanvas?.moveSelectionBy(dx, dy)) ev.preventDefault();
    }
  });
}

// ── The island ──────────────────────────────────────────────────────────────

export function RedesignIsland() {
  return h(
    "div",
    { class: "nocturne rd" },
    h(
      "main",
      { class: "n-main" },
      h(
        "section",
        { class: "n-center" },
        h(
          "div",
          { class: "n-meta rd-top" },
          // The lane's identity, quiet: the product name and where you are.
          h("span", { class: "rd-brand" }, "ksx Studio"),
          h("span", { class: "rd-crumb" }, "Redesign"),
          // Which machine answers this lane — the fixture badge, so the
          // redesign workbench can never be mistaken for the cabinet.
          h("span", { class: () => rdEnvCls() }, () => rdEnvLabel()),
          // The workbench feed: open the device picker. Scripting-only
          // chrome (`.n-autobtn`), rightly — the canvas it feeds is too.
          h(
            "button",
            {
              type: "button",
              class: "n-autobtn rd-adddev",
              "data-nx": "rd-devs-open",
              title: "Add devices to the workbench",
            },
            "＋ Devices",
          ),
          // The other half of the workbench: stage virtual controllers. The
          // daemon owns every consequence — numbering, the XInput ceiling,
          // persona availability — and the cards mirror its slots exactly.
          h(
            "button",
            {
              type: "button",
              class: "n-autobtn rd-addctrl",
              "data-nx": "rd-ctrls-open",
              title: "Stage virtual controllers on the workbench",
            },
            "＋ Controllers",
          ),
          h("span", { class: "rd-spring" }),
          // The action flash — the one place a verb's outcome lands. Served
          // from the allowlisted ?flash= on a full load; the entry's
          // fetch-submit layer applies the same copy without one.
          h("span", { role: "status", class: () => rdFlashCls() }, () => rdFlashLine()),
          // Back view: appears the moment the camera history is non-empty;
          // its title carries the top entry's label.
          h(
            "button",
            {
              type: "button",
              class: "n-autobtn rd-back",
              "data-nx": "rd-back",
              title: "Back view",
              hidden: "",
            },
            "↩ Back view",
          ),
          h(
            "button",
            {
              type: "button",
              class: "n-autobtn rd-search",
              "data-nx": "rd-search",
              title: "Search widgets and commands",
            },
            "Search",
            h("kbd", { class: "rd-kbd" }, "Ctrl K"),
          ),
          h(
            "button",
            {
              type: "button",
              class: "n-autobtn n-zbtn",
              "data-nx": "rd-keys",
              "aria-label": "Canvas control — the shortcut sheet",
              title: "Canvas control (?)",
            },
            "⌨",
          ),
          // The Studio theme menu: the nocturne picker's rows, re-homed into
          // the topbar as a NATIVE details — every row is a plain form POST,
          // so the choice works with scripting off and the served facts
          // paint on the SSR pass (which is why the summary is NOT an
          // `.n-autobtn`: that class is scripting-only chrome). JS adds only
          // outside-click dismissal and the fetch-submit upgrade; the fold
          // closes itself after acting.
          h(
            "details",
            { class: "rd-themed" },
            h(
              "summary",
              { class: "rd-theme-sum", title: "How the Studio looks" },
              "◐ Theme",
            ),
            h(
              "div",
              { class: "rd-thememenu" },
              h(
                "div",
                { class: "n-kick-row" },
                h("span", { class: "n-kick" }, "How the Studio looks"),
              ),
              h(
                "p",
                { class: "n-devnote" },
                "Pages follow the operating system's light or dark choice unless you pick one here.",
              ),
              createList(
                () => rdThemeRows(),
                (r) => r.name + "|" + r.title + "|" + r.detail + "|" + r.cls + "|" + r.chosen,
                (r) =>
                  h(
                    "form",
                    {
                      class: "n-modeform",
                      method: "post",
                      action: "/redesign/theme",
                      "data-rd-form": "theme",
                    },
                    h("input", { type: "hidden", name: "theme", value: r.name }),
                    h(
                      "button",
                      // `aria-current` is the only part of "this is the one
                      // you are on" a screen reader can reach: `.n-radio.on`
                      // paints a dot and announces nothing at all. Explicit
                      // string tokens avoid boolean-attribute serialization's
                      // empty `aria-current` value for the selected row.
                      {
                        type: "submit",
                        class: r.cls,
                        "aria-current": r.chosen,
                      },
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
            ),
          ),
          h("span", { role: "status", class: "n-live-sr" }),
        ),
        // ── The device picker (the workbench feed): near-full-page modal ──
        // SERVED — shell, scan line, all four tiers, every row — and hidden
        // until opened. Membership decoration (aria-pressed, the `.on`
        // marking, the verb word) is client state painted by syncDeviceRows.
        // No verb posts from here: adding to the workbench arranges the
        // browser; it changes no config and stages nothing.
        h(
          "div",
          {
            class: "rd-devmodal",
            hidden: "",
            role: "dialog",
            "aria-modal": "true",
            "aria-label": "Devices on this machine",
          },
          h("div", { class: "rd-devmodal-back", "data-nx": "rd-devs-close" }),
          h(
            "div",
            { class: "rd-devmodal-panel", tabindex: "-1" },
            h(
              "div",
              { class: "rd-devmodal-head" },
              h("span", { class: "n-kick" }, "Devices on this machine"),
              h("span", { class: "rd-spring" }),
              h(
                "button",
                {
                  type: "button",
                  class: "n-mapclose",
                  "data-nx": "rd-devs-close",
                  "aria-label": "Close the device picker",
                  title: "Close (Esc)",
                },
                "×",
              ),
            ),
            h("p", { class: "n-devnote" }, () => rdDevScanLine()),
            h(
              "div",
              { class: () => rdDevKbFoldCls() },
              h("h3", { class: "rd-devhead" }, () => rdDevKbHead()),
              createList(
                () => rdDevKb(),
                (r) =>
                  r.selector + "|" + r.name + "|" + r.meta + "|" + r.cls + "|" + r.title +
                  "|" + r.aria_current,
                (r) =>
                  h(
                    "button",
                    {
                      type: "button",
                      class: r.cls,
                      "data-nx": "rd-dev-toggle",
                      "data-selector": r.selector,
                      "data-role": r.role,
                      title: r.title,
                      "aria-pressed": "false",
                      // The DAEMON fact, served: this board is the staged
                      // one. A different channel from aria-pressed (client
                      // bench membership) on purpose — different answers.
                      "aria-current": r.aria_current,
                    },
                    h(
                      "span",
                      { class: "n-dev-txt" },
                      h("span", { class: "n-dev-name" }, r.name),
                      // Its OWN node, never a sibling beside the bound text
                      // above — the compiler drops an element that shares a
                      // parent with a dynamic text, and the parity gate is
                      // what caught the chip existing only after hydration.
                      h("span", { class: "rd-dev-stagedchip" }, "staged"),
                      h("span", { class: "n-dev-meta" }, r.meta),
                      h("span", { class: "n-dev-meta rd-dev-word" }, "Add to workbench"),
                    ),
                    h("span", { class: "n-dev-dot" }),
                  ),
              ),
            ),
            h(
              "div",
              { class: () => rdDevEncFoldCls() },
              h("h3", { class: "rd-devhead" }, () => rdDevEncHead()),
              createList(
                () => rdDevEnc(),
                (r) =>
                  r.selector + "|" + r.name + "|" + r.meta + "|" + r.cls + "|" + r.title +
                  "|" + r.aria_current,
                (r) =>
                  h(
                    "button",
                    {
                      type: "button",
                      class: r.cls,
                      "data-nx": "rd-dev-toggle",
                      "data-selector": r.selector,
                      "data-role": r.role,
                      title: r.title,
                      "aria-pressed": "false",
                      // The DAEMON fact, served: this board is the staged
                      // one. A different channel from aria-pressed (client
                      // bench membership) on purpose — different answers.
                      "aria-current": r.aria_current,
                    },
                    h(
                      "span",
                      { class: "n-dev-txt" },
                      h("span", { class: "n-dev-name" }, r.name),
                      // Its OWN node, never a sibling beside the bound text
                      // above — the compiler drops an element that shares a
                      // parent with a dynamic text, and the parity gate is
                      // what caught the chip existing only after hydration.
                      h("span", { class: "rd-dev-stagedchip" }, "staged"),
                      h("span", { class: "n-dev-meta" }, r.meta),
                      h("span", { class: "n-dev-meta rd-dev-word" }, "Add to workbench"),
                    ),
                    h("span", { class: "n-dev-dot" }),
                  ),
              ),
            ),
            h(
              "div",
              { class: () => rdDevExpFoldCls() },
              h("h3", { class: "rd-devhead" }, () => rdDevExpHead()),
              createList(
                () => rdDevExp(),
                (r) =>
                  r.selector + "|" + r.name + "|" + r.meta + "|" + r.cls + "|" + r.title +
                  "|" + r.aria_current,
                (r) =>
                  h(
                    "button",
                    {
                      type: "button",
                      class: r.cls,
                      "data-nx": "rd-dev-toggle",
                      "data-selector": r.selector,
                      "data-role": r.role,
                      title: r.title,
                      "aria-pressed": "false",
                      // The DAEMON fact, served: this board is the staged
                      // one. A different channel from aria-pressed (client
                      // bench membership) on purpose — different answers.
                      "aria-current": r.aria_current,
                    },
                    h(
                      "span",
                      { class: "n-dev-txt" },
                      h("span", { class: "n-dev-name" }, r.name),
                      // Its OWN node, never a sibling beside the bound text
                      // above — the compiler drops an element that shares a
                      // parent with a dynamic text, and the parity gate is
                      // what caught the chip existing only after hydration.
                      h("span", { class: "rd-dev-stagedchip" }, "staged"),
                      h("span", { class: "n-dev-meta" }, r.meta),
                      h("span", { class: "n-dev-meta rd-dev-word" }, "Add to workbench"),
                    ),
                    h("span", { class: "n-dev-dot" }),
                  ),
              ),
            ),
            // The unavailable tier: shown so nobody hunts for a board the
            // machine can see but ksx cannot offer — visibly inert, with the
            // reason in the meta. Not a control.
            h(
              "div",
              { class: () => rdDevOtherFoldCls() },
              h("h3", { class: "rd-devhead" }, () => rdDevOtherHead()),
              createList(
                () => rdDevOther(),
                (r) => r.name + "|" + r.meta,
                (r) =>
                  h(
                    "div",
                    { class: "n-dev off" },
                    h(
                      "span",
                      { class: "n-dev-txt" },
                      h("span", { class: "n-dev-name" }, r.name),
                      h("span", { class: "n-dev-meta" }, r.meta),
                    ),
                  ),
              ),
            ),
          ),
        ),
        // ── The controller picker: stage virtual controllers ──────────────
        // SERVED — shell, lede, counts, every persona row — hidden until
        // opened. Rows the daemon cannot offer stay listed (`n-dev off`,
        // reason in the note): a menu that silently drops choices teaches a
        // user the product has fewer. The add form's preset and layout are
        // SERVED values (a future file name; the layout that makes a fresh
        // slot playable). The daemon enforces every ceiling — an add the
        // roster disallows is refused with a sentence, so the row's disabled
        // look is presentation, never the guard.
        h(
          "div",
          {
            class: "rd-ctrlmodal",
            hidden: "",
            role: "dialog",
            "aria-modal": "true",
            "aria-label": "Stage virtual controllers",
          },
          h("div", { class: "rd-ctrlmodal-back", "data-nx": "rd-ctrls-close" }),
          h(
            "div",
            { class: "rd-ctrlmodal-panel", tabindex: "-1" },
            h(
              "div",
              { class: "rd-ctrlmodal-head" },
              h("span", { class: "n-kick" }, "Virtual controllers"),
              h("span", { class: "rd-spring" }),
              h(
                "button",
                {
                  type: "button",
                  class: "n-mapclose",
                  "data-nx": "rd-ctrls-close",
                  "aria-label": "Close the controller picker",
                  title: "Close (Esc)",
                },
                "×",
              ),
            ),
            h("p", { class: "n-devnote" }, () => rdCtrlAddNote()),
            h("p", { class: "n-devnote rd-ctrl-counts" }, () => rdCtrlCountsLine()),
            h("h3", { class: "rd-devhead" }, "Pick what the next slot presents as"),
            createList(
              () => rdCtrlPersonas(),
              (r) =>
                r.name + "|" + r.label + "|" + r.api + "|" + r.note + "|" + r.cls +
                "|" + r.usable,
              (r) =>
                h(
                  "form",
                  {
                    class: "rd-ctrladd-form",
                    method: "post",
                    action: "/redesign/controller",
                    "data-rd-form": "controller-add",
                    "data-usable": r.usable,
                  },
                  h("input", { type: "hidden", name: "persona", value: r.name }),
                  h("input", { type: "hidden", name: "preset", value: () => rdCtrlAddPreset() }),
                  h("input", { type: "hidden", name: "layout", value: () => rdCtrlAddLayout() }),
                  h(
                    "button",
                    { type: "submit", class: r.cls, title: r.note },
                    h(
                      "span",
                      { class: "n-dev-txt" },
                      h("span", { class: "n-dev-name" }, r.label),
                      h("span", { class: "n-dev-meta" }, r.api),
                      h("span", { class: "n-dev-meta rd-ctrl-note" }, r.note),
                    ),
                    h("span", { class: "n-dev-dot" }),
                  ),
                ),
            ),
          ),
        ),
        h(
          "section",
          { class: "forma-canvas n-canvas", "data-forma-canvas": "", "data-client-canvas": "" },
          // ── The tool cluster (design handoff §7): select and hand ───────
          // Off-screen proximity chips: client-populated, camera-settle paced.
          h("div", { class: "rd-chips", "data-client-subtree": "" }),
          h(
            "div",
            { class: "rd-tools", role: "group", "aria-label": "Canvas tools" },
            h(
              "button",
              {
                type: "button",
                class: "rd-tool",
                "data-nx": "rd-tool-select",
                "aria-pressed": "true",
                "aria-label": "Select tool — left-drag marquee-selects",
                title: "Select tool (V)",
              },
              "➤",
            ),
            h(
              "button",
              {
                type: "button",
                class: "rd-tool",
                "data-nx": "rd-tool-hand",
                "aria-pressed": "false",
                "aria-label": "Hand tool — left-drag pans",
                title: "Hand tool (H)",
              },
              "✋",
            ),
          ),
          h(
            "div",
            {
              class: "forma-canvas-viewport",
              "data-forma-canvas-viewport": "",
              "data-client-canvas": "",
              tabindex: "0",
              "aria-label": "Redesign canvas",
            },
            h("div", { class: "forma-canvas-grid", "aria-hidden": "true" }),
            h("div", {
              class: "forma-canvas-stage",
              "data-forma-canvas-stage": "",
              "data-client-canvas": "",
              role: "list",
            }),
            // The map in the corner: a button per widget (click to jump) and
            // a pale rectangle for the camera (drag inside to pan). Both are
            // filled by the engine — the ITEMS box is client-populated by
            // contract (parity rule 3f), the camera rectangle rides the
            // client-canvas exemption for its inline geometry.
            h(
              "aside",
              {
                class: "forma-canvas-navigator n-navigator",
                "data-forma-canvas-navigator": "",
                "aria-label": "Canvas map",
                "data-client-canvas": "",
              },
              // The map panel's header (the design's framed-panel shape): a
              // quiet label and the collapse control, in the corner the map
              // lives in — nobody looks to a bar at the other end of the
              // page to put away the thing in this corner. The button keeps
              // the n-mapclose class: the engine treats any pointerdown in
              // the map as "navigate to here", and init's shield stops the
              // press from reaching it by that class.
              h(
                "div",
                { class: "rd-map-head" },
                h("span", { class: "rd-map-title" }, "Canvas"),
                h("span", { class: "rd-map-count", "data-live-chatter": "" }, "0 widgets"),
                h(
                  "button",
                  {
                    type: "button",
                    class: "n-mapclose",
                    "data-nx": "canvas-map",
                    "aria-label": "Hide the canvas map",
                    title: "Hide the canvas map",
                  },
                  "−",
                ),
              ),
              h("div", {
                class: "forma-canvas-navigator-items",
                "data-client-subtree": "",
              }),
              h("div", {
                class: "forma-canvas-navigator-viewport",
                "aria-hidden": "true",
                "data-client-canvas": "",
              }),
            ),
            // ── The zoom cluster (design handoff §7): [−][%⌃][+] | [Fit][▦]
            // The camera's verbs, scripting-only — wheel, Space-drag and the
            // arrow keys carry the same moves for anyone who would rather
            // not aim at a button. The percentage opens the camera menu; the
            // map icon is the collapsed minimap's stand-in, living in the
            // cluster the design says it belongs to.
            h(
              "div",
              { class: "rd-zoom", role: "group", "aria-label": "Canvas zoom" },
              h(
                "button",
                {
                  type: "button",
                  "data-nx": "canvas-zoom-out",
                  "aria-label": "Zoom out",
                  title: "Zoom out",
                  class: "n-autobtn n-zbtn",
                },
                "−",
              ),
              // The engine writes the LIVE zoom into the SPAN, not the
              // button.
              // ⚠️The span on purpose: handed a BUTTON the engine also
              // rewrites its aria-label with the live number, and
              // `data-live-chatter` exempts an element's TEXT, never its
              // attributes — which the parity gate caught the moment this
              // was wired the obvious way.
              h(
                "button",
                {
                  type: "button",
                  id: "rd-zoom-menu-button",
                  "data-nx": "rd-zoom-menu",
                  title: "Zoom and camera commands",
                  class: "n-autobtn n-zoomread",
                  "aria-haspopup": "menu",
                  "aria-expanded": "false",
                  "aria-controls": "rd-zoom-menu-popup",
                },
                h("span", { class: "sr-head" }, "Canvas zoom "),
                h("span", { class: "n-zoomval", "data-live-chatter": "" }, "100%"),
                h("span", { class: "rd-caret", "aria-hidden": "true" }, "⌃"),
              ),
              h(
                "button",
                {
                  type: "button",
                  "data-nx": "canvas-zoom-in",
                  "aria-label": "Zoom in",
                  title: "Zoom in",
                  class: "n-autobtn n-zbtn",
                },
                "+",
              ),
              h(
                "button",
                {
                  type: "button",
                  "data-nx": "canvas-fit",
                  title: "Fit every widget on screen (1)",
                  class: "n-autobtn",
                },
                "Fit",
              ),
              // The collapsed map's stand-in. Served hidden — the map
              // starts shown; setCanvasMap swaps the two.
              h(
                "button",
                {
                  type: "button",
                  class: "n-autobtn n-zbtn rd-mapshow",
                  "data-nx": "canvas-map",
                  "aria-label": "Show the canvas map",
                  title: "Show the canvas map (M)",
                  hidden: "",
                },
                "▦",
              ),
              // ── The camera menu, opening upward ───────────────────────
              h(
                "div",
                {
                  id: "rd-zoom-menu-popup",
                  class: "rd-menu",
                  role: "menu",
                  "aria-labelledby": "rd-zoom-menu-button",
                  hidden: "",
                },
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", tabindex: "-1", "data-nx": "rd-z-25" },
                  h("span", {}, "25%"),
                ),
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", tabindex: "-1", "data-nx": "rd-z-50" },
                  h("span", {}, "50%"),
                ),
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", tabindex: "-1", "data-nx": "rd-z-75" },
                  h("span", {}, "75%"),
                ),
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", tabindex: "-1", "data-nx": "rd-z-100" },
                  h("span", {}, "100%"),
                  h("kbd", { class: "rd-kbd" }, "0"),
                ),
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", tabindex: "-1", "data-nx": "rd-z-150" },
                  h("span", {}, "150%"),
                ),
                h("div", { class: "rd-menu-sep", "aria-hidden": "true" }),
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", tabindex: "-1", "data-nx": "canvas-fit" },
                  h("span", {}, "Fit workflow"),
                  h("kbd", { class: "rd-kbd" }, "1"),
                ),
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", tabindex: "-1", "data-nx": "rd-fit-sel" },
                  h("span", {}, "Fit selection"),
                  h("kbd", { class: "rd-kbd" }, "2"),
                ),
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", tabindex: "-1", "data-nx": "rd-center-sel" },
                  h("span", {}, "Center selection"),
                  h("kbd", { class: "rd-kbd" }, "C"),
                ),
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", tabindex: "-1", "data-nx": "rd-focus-sel" },
                  h("span", {}, "Focus selected widget"),
                  h("kbd", { class: "rd-kbd" }, "F"),
                ),
              ),
            ),
            // ── The reading-tier line (design handoff §4) ─────────────────
            // Which semantic tier the camera is in. Client-written at zoom
            // speed, so its text is chatter; served at the 100% tier the
            // camera starts on.
            h(
              "span",
              { class: "rd-tier", "aria-hidden": "true", "data-live-chatter": "" },
              "Editing — full detail and controls",
            ),
          ),
        ),
      ),
    ),
    // ── The inspector (design handoff §7): 328px, right, OVERLAY ──────────
    // It overlays the canvas — it does not reflow it, which would move
    // widget positions. Served hidden; the body is client-populated.
    h(
      "aside",
      { class: "rd-inspector", "aria-label": "Inspector", hidden: "" },
      h(
        "div",
        { class: "rd-insp-head" },
        h("span", { class: "rd-map-title" }, "Inspector"),
        h(
          "button",
          {
            type: "button",
            class: "n-mapclose",
            "data-nx": "rd-insp-close",
            "aria-label": "Close the inspector",
            title: "Close",
          },
          "×",
        ),
      ),
      h("div", { class: "rd-insp-body", "data-client-subtree": "" }),
    ),
    // ── The command palette (⌘K / ⌘F) ─────────────────────────────────────
    // Served hidden; the result list is the one client-populated box.
    h(
      "div",
      { class: "rd-palette", hidden: "" },
      h("div", { class: "rd-scrim", "data-nx": "rd-palette-close" }),
      h(
        "div",
        {
          class: "rd-palette-card",
          role: "dialog",
          "aria-label": "Search",
          "aria-modal": "true",
        },
        h("input", {
          class: "rd-palette-input",
          type: "text",
          placeholder: "Find a widget — or run a command",
          "aria-label": "Find a widget or run a command",
        }),
        h("ol", { class: "rd-palette-list", "data-client-subtree": "" }),
      ),
    ),
    // ── The shortcut sheet (?) — Canvas control ───────────────────────────
    h(
      "div",
      { class: "rd-sheet", hidden: "" },
      h("div", { class: "rd-scrim", "data-nx": "rd-sheet-close" }),
      h(
        "div",
        {
          class: "rd-sheet-card",
          role: "dialog",
          "aria-label": "Canvas control",
          "aria-modal": "true",
        },
        h(
          "p",
          { class: "rd-sheet-lede", tabindex: "-1" },
          h("strong", {}, "Canvas control"),
          " Single-key shortcuts fire only when the canvas has focus — never while you are typing in a field.",
        ),
        h(
          "div",
          { class: "rd-sheet-cols" },
          h(
            "dl",
            { class: "rd-sheet-col" },
            h("dt", { class: "rd-sheet-kick" }, "Camera"),
            h("dt", {}, "+ / −"), h("dd", {}, "zoom in / out"),
            h("dt", {}, "0"), h("dd", {}, "100%, centre kept"),
            h("dt", {}, "1"), h("dd", {}, "fit workflow"),
            h("dt", {}, "2"), h("dd", {}, "fit selection"),
            h("dt", {}, "C"), h("dd", {}, "centre selection"),
            h("dt", {}, "Esc"), h("dd", {}, "back to previous view"),
          ),
          h(
            "dl",
            { class: "rd-sheet-col" },
            h("dt", { class: "rd-sheet-kick" }, "Pointer"),
            h("dt", {}, "two-finger drag"), h("dd", {}, "pan"),
            h("dt", {}, "pinch · Ctrl wheel"), h("dd", {}, "zoom at the pointer"),
            h("dt", {}, "wheel / ⇧ wheel"), h("dd", {}, "pan vertically / sideways"),
            h("dt", {}, "space · middle · right drag"), h("dd", {}, "pan"),
            h("dt", {}, "left drag on empty"), h("dd", {}, "marquee select"),
          ),
          h(
            "dl",
            { class: "rd-sheet-col" },
            h("dt", { class: "rd-sheet-kick" }, "Items"),
            h("dt", {}, "click / ⇧ click"), h("dd", {}, "select / add to selection"),
            h("dt", {}, "double-click"), h("dd", {}, "focus the widget"),
            h("dt", {}, "F"), h("dd", {}, "focus selected widget"),
            h("dt", {}, "arrows / ⇧ arrows"), h("dd", {}, "move by 12 / 1 px"),
            h("dt", {}, "drag the header"), h("dd", {}, "move the widget"),
          ),
          h(
            "dl",
            { class: "rd-sheet-col" },
            h("dt", { class: "rd-sheet-kick" }, "Chrome"),
            h("dt", {}, "Ctrl K / Ctrl F"), h("dd", {}, "search and fly to a widget"),
            h("dt", {}, "M"), h("dd", {}, "minimap"),
            h("dt", {}, "V / H"), h("dd", {}, "select / hand tool"),
            h("dt", {}, "?"), h("dd", {}, "this sheet"),
          ),
        ),
        h(
          "button",
          { type: "button", class: "n-autobtn rd-sheet-dismiss", "data-nx": "rd-sheet-close" },
          "Close",
        ),
      ),
    ),
  );
}
