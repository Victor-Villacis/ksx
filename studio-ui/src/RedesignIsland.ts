import { createSignal, h } from "@getforma/core";
import { WidgetCanvas } from "./genui/canvas/index";

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
          ? { panX: cam.panX, panY: cam.panY, zoom: Math.min(2, Math.max(0.2, cam.zoom)) }
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

/** Read the camera (and, once widgets arrive, their geometry) back into the
 *  store — called from the engine's onCommit (its own durable boundary),
 *  from the debounced onChange trail (so a kill mid-arrangement loses at
 *  most the last second), and synchronously on pagehide. The per-widget
 *  bookkeeping joins this loop as widgets are transplanted in. */
function persistCanvas(): void {
  const canvas = nCanvas;
  if (!canvas) return;
  canvasPrefs = {
    camera: canvas.getCamera(),
    widgets: { ...canvasPrefs.widgets },
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

/** The selected widget's controls, retargeted instead of cloned — the
 *  upstream app's own shape (one contextual group, not four buttons on
 *  every card), and the reason the page can carry a live size readout and
 *  honest disabled states at the scale limits.
 *
 *  ⚠️PARITY: every write here is imperative, so what it writes for "nothing
 *  selected" must be EXACTLY what the server serves — see the markup's
 *  `data-nsel` group. Nothing is selected at first paint (mounting passes
 *  `focus: false`), so the two agree byte-for-byte with no exemption. */
function syncWidgetSelection(): void {
  const root = rdRoot;
  const canvas = nCanvas;
  if (!root) return;
  const group = root.querySelector<HTMLElement>(".n-selbar");
  if (!group) return;
  const item = canvas?.activeItem() ?? null;
  const name = item?.dataset.widgetName ?? "";
  const state = item && canvas ? canvas.getItemState(item) : null;
  const percent = state ? Math.round(state.manualScale * 100) : 100;
  const focused = Boolean(item && canvas?.isFocusModeActive(item));
  group.dataset.nselState = item ? "selected" : "none";
  const label = group.querySelector<HTMLElement>(".n-sel-name");
  if (label) label.textContent = item ? name : "Nothing selected";
  const size = group.querySelector<HTMLElement>('[data-nx="w-scale-reset"]');
  if (size) {
    size.textContent = percent + "%";
    size.title = item ? name + " is at " + percent + "% — click for 100%" : "Widget size";
    size.setAttribute(
      "aria-label",
      item ? name + " size " + percent + "%; reset to 100%" : "Widget size",
    );
  }
  for (const button of Array.from(group.querySelectorAll<HTMLButtonElement>("button[data-nx]"))) {
    const nx = button.dataset.nx ?? "";
    // The scale buttons also die at the engine's own clamp, so a press that
    // could not move anything never looks available.
    const atFloor = nx === "w-zoom-out" && state !== null && state.manualScale <= 0.6;
    const atCeiling = nx === "w-zoom-in" && state !== null && state.manualScale >= 1.6;
    button.disabled = item === null || atFloor || atCeiling;
    if (nx === "w-focus") {
      button.setAttribute("aria-pressed", String(focused));
      button.textContent = focused ? "Unfocus" : "Focus";
      button.setAttribute(
        "aria-label",
        focused ? "Leave focus and restore the previous view" : "Focus " + (name || "widget"),
      );
    }
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
      onCommit: persistCanvas,
      // The trail behind onCommit: pans and in-flight drags reach the store
      // within a second even if the tab dies before a durable boundary.
      onChange: () => {
        scheduleCanvasPersist();
      },
      // The selection group follows the canvas, never the other way round:
      // selecting, scaling and focusing all report here.
      onActiveChange: syncWidgetSelection,
      onActiveItemStateChange: syncWidgetSelection,
      onFocusModeChange: syncWidgetSelection,
      // The engine has no live region of its own; the meta bar's sr status
      // line is this page's.
      onKeyboardNavigation: (message) => {
        const sr = (rdRoot ?? scope).querySelector<HTMLElement>(".n-live-sr");
        if (sr) sr.textContent = message;
      },
      worldBounds: CANVAS_WORLD,
    },
  );
  setCanvasMap(canvasPrefs.mapHidden === true);
  if (canvasPrefs.camera) nCanvas.restoreCamera(canvasPrefs.camera);
  else window.requestAnimationFrame(() => nCanvas?.fitAll());
  window.addEventListener("pagehide", () => {
    // flushPendingChange only fires the onChange callback — whose debounce
    // timer will never tick in a dying page. The synchronous persist IS the
    // durability; the flush just settles the engine's pending rAF first.
    nCanvas?.flushPendingChange();
    persistCanvas();
  });
}

// ── Wire: root marker, camera verbs, focus-mode escape ──────────────────────

export function redesignWire(root: HTMLElement): void {
  rdRoot = root;
  // The wire's own "JavaScript is live" marker: scripting-only chrome (the
  // camera buttons) reveals off it, and the parity gate normalizes it.
  root.classList.add("js");
  root.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    const hit = target?.closest<HTMLElement>("[data-nx]")?.dataset.nx;
    if (!hit) return;
    if (hit === "canvas-fit") {
      nCanvas?.fitAll();
    } else if (hit === "canvas-zoom-reset") {
      nCanvas?.resetZoom();
    } else if (hit === "canvas-zoom-in") {
      nCanvas?.zoomBy(CANVAS_ZOOM_STEP);
    } else if (hit === "canvas-zoom-out") {
      nCanvas?.zoomBy(1 / CANVAS_ZOOM_STEP);
    } else if (hit === "canvas-map") {
      setCanvasMap(!(canvasPrefs.mapHidden === true));
    } else if (
      hit === "w-zoom-in" || hit === "w-zoom-out" || hit === "w-scale-reset" ||
      hit === "w-center" || hit === "w-focus"
    ) {
      // The selection group: the button says WHAT, the canvas says WHICH.
      const widget = nCanvas?.activeItem();
      if (widget && nCanvas) {
        if (hit === "w-zoom-in") nCanvas.adjustItemScale(widget, 1);
        else if (hit === "w-zoom-out") nCanvas.adjustItemScale(widget, -1);
        else if (hit === "w-scale-reset") nCanvas.resetItemScale(widget);
        else if (hit === "w-center") nCanvas.centerItem(widget);
        else nCanvas.toggleFocusMode(widget);
        syncWidgetSelection();
      }
    }
  });
  window.addEventListener("keydown", (ev) => {
    // Focus mode is a whole-canvas state, so leaving it must not depend on
    // which control the user last touched. (The engine binds Escape on the
    // widget shell alone — reachable only when the widget itself holds
    // focus, which it does not after a button press.)
    if (ev.key === "Escape" && nCanvas?.isFocusModeActive()) {
      ev.preventDefault();
      nCanvas.exitFocusMode();
      syncWidgetSelection();
    }
  });
}

// ── The island ──────────────────────────────────────────────────────────────

export function RedesignIsland() {
  return h(
    "div",
    { class: "nocturne" },
    h(
      "main",
      { class: "n-main" },
      h(
        "section",
        { class: "n-center" },
        h(
          "div",
          { class: "n-meta" },
          // Which machine answers this lane — the fixture badge, so the
          // redesign workbench can never be mistaken for the cabinet.
          h("span", { class: () => rdEnvCls() }, () => rdEnvLabel()),
          // The canvas camera's verbs, scripting-only — wheel, Space-drag
          // and the arrow keys carry the same moves for anyone who would
          // rather not aim at a button.
          h(
            "button",
            {
              type: "button",
              "data-nx": "canvas-fit",
              title: "Fit every widget on screen",
              class: "n-autobtn",
            },
            "Fit",
          ),
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
          // The engine writes the LIVE zoom into the SPAN, not the button,
          // and clicking the button resets to 100%.
          // ⚠️The span on purpose: handed a BUTTON the engine also rewrites
          // its aria-label with the live number, and `data-live-chatter`
          // exempts an element's TEXT, never its attributes — which the
          // parity gate caught the moment this was wired the obvious way.
          // With no aria-label at all, the button's accessible name is its
          // own content ("Canvas zoom 84%") and follows the number for free.
          h(
            "button",
            {
              type: "button",
              "data-nx": "canvas-zoom-reset",
              title: "Canvas zoom — click for 100%",
              class: "n-autobtn n-zoomread",
            },
            h("span", { class: "sr-head" }, "Canvas zoom "),
            h("span", { class: "n-zoomval", "data-live-chatter": "" }, "100%"),
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
          // ── The selected widget's own controls ──────────────────────────
          // One group that retargets (the upstream app's shape), not four
          // buttons on every card. Served in its RESTING state — nothing is
          // selected at first paint — and `syncWidgetSelection` writes
          // exactly these strings back when the selection clears, so the
          // parity gate sees no drift with no exemption to hide behind.
          h(
            "div",
            {
              class: "n-selbar",
              role: "group",
              "aria-label": "Selected widget",
              "data-nsel-state": "none",
            },
            h("span", { class: "n-sel-name" }, "Nothing selected"),
            h(
              "button",
              {
                type: "button",
                class: "n-autobtn n-zbtn",
                "data-nx": "w-zoom-out",
                "aria-label": "Make the selected widget smaller",
                title: "Smaller",
                disabled: "",
              },
              "−",
            ),
            h(
              "button",
              {
                type: "button",
                class: "n-autobtn n-selsize",
                "data-nx": "w-scale-reset",
                "aria-label": "Widget size",
                title: "Widget size",
                disabled: "",
              },
              "100%",
            ),
            h(
              "button",
              {
                type: "button",
                class: "n-autobtn n-zbtn",
                "data-nx": "w-zoom-in",
                "aria-label": "Make the selected widget bigger",
                title: "Bigger",
                disabled: "",
              },
              "+",
            ),
            h(
              "button",
              {
                type: "button",
                class: "n-autobtn",
                "data-nx": "w-center",
                title: "Bring the selected widget to the middle of the view",
                disabled: "",
              },
              "Center",
            ),
            h(
              "button",
              {
                type: "button",
                class: "n-autobtn",
                "data-nx": "w-focus",
                "aria-pressed": "false",
                "aria-label": "Focus widget",
                title: "Spotlight it alone — Esc restores the view",
                disabled: "",
              },
              "Focus",
            ),
          ),
          h("span", { role: "status", class: "n-live-sr" }),
        ),
        h(
          "section",
          { class: "forma-canvas n-canvas", "data-forma-canvas": "", "data-client-canvas": "" },
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
              // The map's own hide button. The meta bar's toggle would do
              // the same thing, but nobody looks there to put away the
              // thing in the corner — the corner is where you reach for it.
              h(
                "button",
                {
                  type: "button",
                  class: "n-mapclose",
                  "data-nx": "canvas-map",
                  "aria-label": "Hide the canvas map",
                  title: "Hide the canvas map",
                },
                "×",
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
            // What brings the map back, in the corner the map lives in.
            // Served hidden: the map starts shown, and this is its stand-in.
            h(
              "button",
              {
                type: "button",
                class: "n-mapshow",
                "data-nx": "canvas-map",
                "aria-label": "Show the canvas map",
                title: "Show the canvas map",
                hidden: "",
              },
              "▦",
            ),
          ),
        ),
      ),
    ),
  );
}
