import { createSignal, h } from "@getforma/core";
import { createCanvasItem, WidgetCanvas } from "./genui/canvas/index";

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

/** The payload the server embeds and /api/redesign serves — seeded into the
 *  signals by the entry BEFORE the island returns (ledger #5). */
export interface RedesignPayload {
  environment_label: string;
  environment_cls: string;
}

// ── SERVED signals — copiers, never derivers ────────────────────────────────

const [rdEnvLabel, setRdEnvLabel] = createSignal("");
const [rdEnvCls, setRdEnvCls] = createSignal("n-environment unknown");

export function applyRedesign(v: RedesignPayload): void {
  setRdEnvLabel(v.environment_label);
  setRdEnvCls(v.environment_cls);
}

// ── The canvas (lifted from NocturneIsland's canvas section) ────────────────

/** The lane's OWN store key — sharing /nocturne's would inherit and corrupt
 *  its camera and widget geometry. */
const CANVAS_STORE = "ksx-redesign-canvas";

/** One press of canvas zoom. The engine's own wheel step is finer; a button
 *  press should be a visible move, not a nudge. */
const CANVAS_ZOOM_STEP = 1.2;

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
}

let canvasPrefs: CanvasPrefs = { widgets: {} };
let nCanvas: WidgetCanvas | null = null;
let rdRoot: HTMLElement | null = null;

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
  const show = root?.querySelector<HTMLElement>(".n-mapshow");
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
function setZoomMenu(open: boolean): void {
  const menu = rdRoot?.querySelector<HTMLElement>(".rd-menu");
  if (!menu) return;
  menu.hidden = !open;
  rdRoot
    ?.querySelector<HTMLElement>('[data-nx="rd-zoom-menu"]')
    ?.setAttribute("aria-expanded", String(open));
}

function sheetOpen(): boolean {
  return rdRoot?.querySelector<HTMLElement>(".rd-sheet")?.hidden === false;
}
function setSheet(open: boolean): void {
  const sheet = rdRoot?.querySelector<HTMLElement>(".rd-sheet");
  if (sheet) sheet.hidden = !open;
}

interface PaletteCommand {
  name: string;
  hint: string;
  key: string;
  run: () => void;
}
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
function paletteOpen(): boolean {
  return rdRoot?.querySelector<HTMLElement>(".rd-palette")?.hidden === false;
}
function setPalette(open: boolean): void {
  const root = rdRoot;
  const overlay = root?.querySelector<HTMLElement>(".rd-palette");
  if (!root || !overlay) return;
  overlay.hidden = !open;
  if (!open) return;
  const input = overlay.querySelector<HTMLInputElement>(".rd-palette-input");
  if (input) {
    input.value = "";
    input.focus();
  }
  paletteIndex = 0;
  renderPalette("");
}

/** Fly the camera to one widget — the palette's landing. The design's rule:
 *  at least 90% zoom, centre it, pulse its outline so the eye finds it. */
function flyToWidget(item: HTMLElement): void {
  const canvas = nCanvas;
  if (!canvas) return;
  if (canvas.getCamera().zoom < 0.9) {
    canvas.setZoomTo(0.9, "before search jump");
  } else {
    canvas.pushCameraHistory("before search jump");
  }
  canvas.centerItem(item);
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
  const rows: { name: string; hint: string; key: string; run: () => void }[] = [
    ...widgets
      .map((item) => ({
        name: item.dataset.widgetName ?? "",
        hint: "widget on this canvas",
        key: "",
        run: () => flyToWidget(item),
      }))
      .filter((row) => row.name),
    ...paletteCommands(),
  ].filter((row) =>
    !needle ||
    row.name.toLowerCase().includes(needle) ||
    row.hint.toLowerCase().includes(needle)
  );
  if (paletteIndex >= rows.length) paletteIndex = Math.max(0, rows.length - 1);
  list.replaceChildren(
    ...rows.map((row, index) => {
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
    }),
  );
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

const INSPECTOR_WIDTH = 328;
let inspectorDismissed = false;

function inspectorEl(): HTMLElement | null {
  return rdRoot?.querySelector<HTMLElement>(".rd-inspector") ?? null;
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
      numberField("X", Math.round(state.x), (x) => canvas.moveItemTo(item, x, state.y)),
      numberField("Y", Math.round(state.y), (y) => canvas.moveItemTo(item, state.x, y)),
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
  canvas.setSafeInsetRight(open ? INSPECTOR_WIDTH : 0);
  if (open) {
    renderInspector();
    // The design's panel rule: zoom preserved, pan by exactly the overlap —
    // often zero — and only when the panel is NEWLY open.
    if (!wasOpen) canvas.keepActiveClear();
  }
  syncChips();
}

function syncInspectorToSelection(items: HTMLElement[]): void {
  if (items.length === 0) {
    inspectorDismissed = false;
    setInspector(false);
    return;
  }
  if (!inspectorDismissed) setInspector(true);
  else renderInspector();
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
  const inset = inspectorEl()?.hidden === false ? INSPECTOR_WIDTH : 0;
  const safeWidth = rect.width - inset;
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
      chip.addEventListener("click", () => {
        nCanvas?.pushCameraHistory(`before jump to ${name}`);
        nCanvas?.centerItem(item);
      });
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
    stage.classList.remove("rd-spotlighting");
    item.classList.remove("rd-spot");
  });
}

// ── The mock nodes: two disposable widgets to exercise the canvas ───────────
// Client-created (data-client-widget — parity rule 3e), so nothing about
// them is served. They exist so selection, marquee, drag, focus, fit and the
// semantic tiers have something real to act on while the first product
// pieces are still on the way; delete this block when a transplant lands.

function mockNodeContent(summary: string, detail: string[]): HTMLElement {
  const body = document.createElement("div");
  body.className = "rd-mock";
  const sum = document.createElement("p");
  sum.className = "rd-mock-sum";
  sum.textContent = summary;
  body.append(sum);
  const block = document.createElement("dl");
  block.className = "rd-mock-detail";
  for (const line of detail) {
    const [term, value] = line.split(": ");
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value ?? "";
    block.append(dt, dd);
  }
  body.append(block);
  return body;
}

function mountMockNodes(): void {
  const canvas = nCanvas;
  if (!canvas) return;
  const mocks: [string, string, string, string[], CanvasItemGeometry][] = [
    [
      "mock-a",
      "Mock node A",
      "trigger · always fires",
      ["kind: trigger", "wired to: nothing yet", "state: healthy"],
      { x: 120, y: 140, width: 260, height: 150, z: 1, manualScale: 1 },
    ],
    [
      "mock-b",
      "Mock node B",
      "transform · echoes its input",
      ["kind: transform", "wired to: nothing yet", "state: healthy"],
      { x: 470, y: 300, width: 260, height: 150, z: 2, manualScale: 1 },
    ],
  ];
  for (const [id, name, summary, detail, home] of mocks) {
    const item = createCanvasItem({
      instanceId: id,
      displayName: name,
      preferredWidth: 260,
      minHeight: 150,
      content: mockNodeContent(summary, detail),
      document,
    });
    item.dataset.clientWidget = "";
    item.classList.add("rd-mock-node");
    canvas.mountItem(item, canvasPrefs.widgets[id] ?? home, { focus: false });
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
  // (it only excuses its own markers), so the hide button has to stop the
  // press from reaching it — otherwise putting the map away jumps the view
  // on the way out. Click still bubbles to the delegated handler.
  navigator
    .querySelector<HTMLElement>(".n-mapclose")
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
          inspectorDismissed = false;
          setInspector(true);
        }
        syncChips();
      },
    },
  );
  setCanvasMap(canvasPrefs.mapHidden === true);
  mountMockNodes();
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
      inspectorDismissed = true;
      setInspector(false);
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

  window.addEventListener("keydown", (ev) => {
    // ⌘K / ⌘F open the palette from ANYWHERE, a text field included —
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
    if (ev.key === "Escape") {
      // The escape ladder (design handoff §2), one rung per press:
      // sheet → palette → menu → focus mode → back view → clear selection.
      if (sheetOpen()) setSheet(false);
      else if (paletteOpen()) setPalette(false);
      else if (zoomMenuOpen()) setZoomMenu(false);
      else if (nCanvas?.isFocusModeActive()) {
        nCanvas.exitFocusMode();
      } else if (!nCanvas?.backView()) {
        nCanvas?.clearActive();
      }
      ev.preventDefault();
      return;
    }
    if (typingIntoSomething(ev)) return;
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
          h("span", { class: "rd-spring" }),
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
            h("kbd", { class: "rd-kbd" }, "⌘K"),
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
          h("span", { role: "status", class: "n-live-sr" }),
        ),
        h(
          "section",
          { class: "forma-canvas n-canvas", "data-forma-canvas": "", "data-client-canvas": "" },
          // ── The tool cluster (design handoff §7): select and hand ───────
          // Off-screen proximity chips: client-populated, camera-settle paced.
          h("div", { class: "rd-chips", "data-client-subtree": "", "aria-hidden": "true" }),
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
                  "data-nx": "rd-zoom-menu",
                  title: "Zoom and camera commands",
                  class: "n-autobtn n-zoomread",
                  "aria-haspopup": "menu",
                  "aria-expanded": "false",
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
                  class: "n-autobtn n-zbtn n-mapshow",
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
                { class: "rd-menu", role: "menu", hidden: "" },
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", "data-nx": "rd-z-25" },
                  h("span", {}, "25%"),
                ),
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", "data-nx": "rd-z-50" },
                  h("span", {}, "50%"),
                ),
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", "data-nx": "rd-z-75" },
                  h("span", {}, "75%"),
                ),
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", "data-nx": "rd-z-100" },
                  h("span", {}, "100%"),
                  h("kbd", { class: "rd-kbd" }, "0"),
                ),
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", "data-nx": "rd-z-150" },
                  h("span", {}, "150%"),
                ),
                h("div", { class: "rd-menu-sep", "aria-hidden": "true" }),
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", "data-nx": "canvas-fit" },
                  h("span", {}, "Fit workflow"),
                  h("kbd", { class: "rd-kbd" }, "1"),
                ),
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", "data-nx": "rd-fit-sel" },
                  h("span", {}, "Fit selection"),
                  h("kbd", { class: "rd-kbd" }, "2"),
                ),
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", "data-nx": "rd-center-sel" },
                  h("span", {}, "Center selection"),
                  h("kbd", { class: "rd-kbd" }, "C"),
                ),
                h(
                  "button",
                  { type: "button", class: "rd-menu-row", role: "menuitem", "data-nx": "rd-focus-sel" },
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
        { class: "rd-palette-card", role: "dialog", "aria-label": "Search" },
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
        { class: "rd-sheet-card", role: "dialog", "aria-label": "Canvas control" },
        h(
          "p",
          { class: "rd-sheet-lede" },
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
            h("dt", {}, "pinch · ⌘ wheel"), h("dd", {}, "zoom at the pointer"),
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
            h("dt", {}, "⌘K / ⌘F"), h("dd", {}, "search and fly to a widget"),
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
