/**
 * Widget infinite-canvas engine.
 *
 * This is a reusable adaptation of the camera, world-coordinate,
 * focus/fit, drag, interaction-shielding, and navigator patterns proven in
 * forma-builder's Infinite Canvas POC. It intentionally does not import or
 * mutate the builder product, iframe editor, page tree, templates, blueprint,
 * AI refactor pipeline, or stageframe streaming system.
 */

import { FALLBACK_CANVAS_CAPACITY } from "./canvas-capacity";
import {
  isWidgetCommandEdge,
  resolveWidgetCommandDockPlacement,
} from "./widget-chrome-placement";
import {
  eventOriginatesInInteractiveControl,
  hasPrimaryShortcutModifier,
} from "./keyboard-shortcuts";
import {
  NO_RUNTIME_ADAPTER,
  type CanvasRuntimeAdapter,
  type CanvasRuntimeHost,
} from "./runtime-adapter";

export interface WidgetCanvasCamera {
  panX: number;
  panY: number;
  zoom: number;
}

export interface WidgetCanvasItemState {
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  manualScale: number;
}

/** Screen-pixel space a focus operation must leave clear for fixed canvas
 * chrome. Insets are relative to the viewport's inner box, not world units. */
export interface WidgetCanvasViewportInsets {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

export interface WidgetCanvasFocusOptions {
  viewportInsets?: WidgetCanvasViewportInsets;
  /** Keep a long-form editor readable even when showing its whole height
   * would otherwise shrink it to a miniature. The focus session still
   * restores the exact entry camera when it ends. */
  minimumZoom?: number;
  /** When a readable minimum makes an item larger than the viewport, begin
   * at its top/left edge instead of dropping the user into its middle. */
  oversizedAlignment?: "center" | "start";
}

export interface WidgetCanvasElements {
  viewport: HTMLElement;
  stage: HTMLElement;
  zoomStatus: HTMLElement;
  navigator: HTMLElement;
  navigatorItems: HTMLElement;
  navigatorViewport: HTMLElement;
}

export interface WidgetCanvasOptions {
  onChange?: () => void;
  onCommit?: () => void;
  onActiveChange?: (item: HTMLElement | null) => void;
  onActiveItemStateChange?: (item: HTMLElement) => void;
  onActiveDragStateChange?: (item: HTMLElement, dragging: boolean) => void;
  onFocusModeChange?: (
    item: HTMLElement | null,
    focused: boolean,
    restoredCamera: boolean,
  ) => void;
  onOpenActiveControls?: (item: HTMLElement) => void;
  onEscapeActiveControls?: (item: HTMLElement) => boolean;
  onKeyboardNavigation?: (message: string) => void;
  onCapacityChange?: (snapshot: WidgetCanvasCapacitySnapshot) => void;
  canRaiseSelection?: () => boolean;
  maxItems?: number;
  maxActiveRuntimes?: number;
  runtimeAdapter?: CanvasRuntimeAdapter;
  interactionBlocked?: () => boolean;
  /** ksx: the world's fixed extent. Widgets and the camera stay inside it. */
  worldBounds?: WorldSize;
  /** ksx: the navigation model. "map" (the shipped default) pans on
   * empty-space drag; "design-tool" marquee-selects there instead, moves
   * panning to space/middle/right-drag and two-finger scroll, pans on plain
   * wheel, and zooms on ctrl/cmd+wheel (which is also how a trackpad pinch
   * arrives). Opt-in so the two canvases can differ without forking the
   * engine — /nocturne stays "map" and its whole suite stays byte-true. */
  navigationModel?: "map" | "design-tool";
  /** ksx: camera zoom limits; the design-tool lane runs 0.08–3. */
  zoomRange?: { min: number; max: number };
  /** ksx: select/hand tool changed (design-tool model only). */
  onToolModeChange?: (mode: "select" | "hand") => void;
  /** ksx: the multi-selection changed. Fires alongside onActiveChange —
   * the active item is always the selection's primary. */
  onSelectionChange?: (items: HTMLElement[]) => void;
  /** ksx: the zoom (and its semantic reading tier) changed. Fired once per
   * distinct zoom value from the camera render, so hosts stop deriving the
   * tier through getCamera() — which is masked during focus mode. */
  onZoomChange?: (zoom: number, tier: "overview" | "structure" | "editing") => void;
  /** ksx: the camera history stack changed; depth and the top label drive
   * a "Back view" control. */
  onCameraHistoryChange?: (depth: number, topLabel: string | null) => void;
}

export interface WidgetCanvasCapacitySnapshot {
  total: number;
  reserved: number;
  maxItems: number;
  runtimeActive: number;
  runtimeSuspended: number;
  maxActiveRuntimes: number;
}

export interface WidgetCanvasMountReservation {
  mountItem(
    item: HTMLElement,
    restored?: Partial<WidgetCanvasItemState>,
    options?: { focus?: boolean },
  ): void;
  release(): void;
}

export class WidgetCanvasCapacityError extends Error {
  constructor(
    readonly current: number,
    readonly requested: number,
    readonly limit: number,
  ) {
    super(`canvas capacity exceeded: ${current}+${requested}>${limit}`);
  }
}

interface WorldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface NavigatorProjection extends WorldRect {
  scale: number;
  visible: WorldRect;
}

/** ksx: how far a widget may travel (see DEFAULT_WORLD_BOUNDS). The ORIGIN
 *  matters as much as the size: a bound that starts at (0, 0) puts a wall
 *  just above whatever sits near the top of the arrangement, and walls you
 *  cannot see read as bugs. Defaults place it far to the negative side. */
export interface WorldSize {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

interface VirtualizedWidgetHost {
  descriptor: unknown;
  placeholder: HTMLElement;
}

interface WidgetFocusSession {
  itemId: string;
  entryCamera: WidgetCanvasCamera;
  entryViewportFrame: ViewportFrame;
  focusOptions: WidgetCanvasFocusOptions;
  /** The Focus transaction owns this exact history entry. Restoring Focus
   *  retires it and every camera detour made inside Focus, while preserving
   *  the stack that existed before the transaction began. */
  historyEntry: CameraHistoryEntry;
}

interface CameraHistoryEntry extends WidgetCanvasCamera {
  label: string;
}

interface ViewportFrame {
  width: number;
  height: number;
  safeWidth: number;
}

type CameraFramingMode = "center" | "focus-item" | "focus-mode" | "navigate";

type WidgetNavigationDirection = "left" | "right" | "up" | "down";

interface CameraFramingTarget {
  itemId: string;
  mode: CameraFramingMode;
  direction?: WidgetNavigationDirection;
  viewportInsets?: WidgetCanvasViewportInsets;
}

interface RuntimeAdmissionCandidate {
  id: string;
  item: HTMLElement;
  host?: CanvasRuntimeHost;
  attentionState: "visible" | "edge" | "parked";
  forced: boolean;
  selected: boolean;
  wasAdmitted: boolean;
  visibleRatio: number;
  distance: number;
  z: number;
}

interface WidgetNavigationCandidate {
  id: string;
  item: HTMLElement;
  rect: WorldRect;
}

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;
const DEFAULT_CAMERA: WidgetCanvasCamera = { panX: 48, panY: 64, zoom: 1 };
const WORLD_PADDING = 180;
// ksx: divergence from upstream c91d34c — WIDGETS ARE BOUNDED, THE VIEW IS
// NOT.
//
// The camera pans freely, the way every canvas tool in this shape works
// (Figma, Miro, tldraw, the node editors): you can go wherever you like and
// a Fit control brings you home. Caging the VIEW was tried here for exactly
// one commit and it reads as a broken app — you cannot centre what you are
// looking at, and the edges shove back.
//
// What IS bounded is where a widget can END UP, so nothing can be dragged
// somewhere unreachable. That is a placement rule, not a camera rule: it
// costs the user nothing and it means the map always has something to show.
// The size is a HOST decision (`worldBounds`), since only the host knows
// how many widgets it can have.
//
// The map's two real faults are fixed where they live, not by shrinking the
// canvas: its projection FREEZES for the length of a drag (see
// #navigatorBounds), and its camera rectangle is clamped to the box it is
// drawn on (see #renderNavigator).
// Deliberately enormous and centred well outside anything a person would
// arrange: this is a runaway rail, not a workspace edge. You should never
// meet it by dragging; if you do, the bound is wrong, because an invisible
// wall in the middle of an empty canvas is indistinguishable from a bug.
const DEFAULT_WORLD_BOUNDS: WorldSize = {
  x: -8000,
  y: -8000,
  width: 20000,
  height: 20000,
};
const KEYBOARD_MOVE_STEP = 16;
const KEYBOARD_CANVAS_PAN_STEP_PX = 64;
const KEYBOARD_CANVAS_PAN_LARGE_STEP_PX = 256;
const KEYBOARD_NAVIGATION_SAFE_INSET_PX = 32;
const VISIBILITY_WAKE_MARGIN_PX = 220;
const VISIBILITY_PARK_MARGIN_PX = 320;
const DISTANCE_SCALE_START = 0.35;
const DISTANCE_SCALE_END = 1.45;
const DISTANCE_SCALE_MIN = 0.64;
const DISTANCE_OPACITY_MIN = 0.78;
export const MIN_WIDGET_MANUAL_SCALE = 0.6;
export const MAX_WIDGET_MANUAL_SCALE = 1.6;
const MANUAL_SCALE_STEP = 0.1;
const WIDGET_CHROME_CONTROL_RADIUS_PX = 22;
const WIDGET_COMMAND_TANGENT_LENGTH_PX = 44;
const WIDGET_COMMAND_OUTWARD_EXTENT_PX = 24.5;
const WIDGET_COMMAND_EDGE_GAP_PX = 8;
const WIDGET_COMMAND_SAFE_INSET_PX = 8;
const WIDGET_CHROME_EDGE_HYSTERESIS_PX = 12;
const WIDGET_COMMAND_EDGE_HANDOFF_PX = 48;
const WIDGET_COMMAND_EDGE_HANDOFF_RATIO = 0.15;
const FOCUS_MAX_ZOOM = 1.35;
const DESIGN_TOOL_FOCUS_MIN_ZOOM = 0.9;
const DESIGN_TOOL_FOCUS_MAX_ZOOM = 1.2;
// ksx: semantic-zoom reading tiers (design handoff §4). The hysteresis is
// ±0.03 so a camera resting exactly on a boundary cannot flicker the tier.
const ZOOM_TIER_LOW = 0.5;
const ZOOM_TIER_HIGH = 0.9;
const ZOOM_TIER_HYSTERESIS = 0.03;
// ksx: the camera history ring (design handoff §3) — labelled views, capped.
const CAMERA_HISTORY_MAX = 24;
const CAMERA_ANIMATION_MS = 260;
const FOCUS_CAMERA_ANIMATION_MS = 300;
const PANEL_CAMERA_ANIMATION_MS = 200;
const CAMERA_ANIMATION_LANDING_PAD_MS = 70;
const MIN_EFFECTIVE_SCALE = MIN_WIDGET_MANUAL_SCALE * DISTANCE_SCALE_MIN;
const CAMERA_MOTION_SETTLE_MS = 120;
const DEFAULT_VIRTUALIZATION_DWELL_MS = 2_000;
const VIRTUALIZATION_DISTANCE_THRESHOLD = 1.75;
const KEYBOARD_MOVE_DELTAS: Readonly<Partial<Record<string, readonly [number, number]>>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

const KEYBOARD_NAVIGATION_DIRECTIONS: Readonly<
  Partial<Record<string, WidgetNavigationDirection>>
> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizedViewportInsets(
  insets?: WidgetCanvasViewportInsets,
): WidgetCanvasViewportInsets | undefined {
  if (!insets) return undefined;
  const finiteInset = (value: number | undefined): number =>
    Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
  const normalized = {
    top: finiteInset(insets.top),
    right: finiteInset(insets.right),
    bottom: finiteInset(insets.bottom),
    left: finiteInset(insets.left),
  };
  return normalized.top || normalized.right || normalized.bottom || normalized.left
    ? normalized
    : undefined;
}

function insetViewportFrame(
  viewport: DOMRectReadOnly,
  insets?: WidgetCanvasViewportInsets,
): WorldRect {
  const normalized = normalizedViewportInsets(insets);
  const left = clamp(normalized?.left ?? 0, 0, Math.max(0, viewport.width - 1));
  const right = clamp(
    normalized?.right ?? 0,
    0,
    Math.max(0, viewport.width - left - 1),
  );
  const top = clamp(normalized?.top ?? 0, 0, Math.max(0, viewport.height - 1));
  const bottom = clamp(
    normalized?.bottom ?? 0,
    0,
    Math.max(0, viewport.height - top - 1),
  );
  return {
    x: left,
    y: top,
    width: Math.max(1, viewport.width - left - right),
    height: Math.max(1, viewport.height - top - bottom),
  };
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isWidgetNavigationDirection(value: string): value is WidgetNavigationDirection {
  return value === "left" || value === "right" || value === "up" || value === "down";
}

function intervalOverlap(
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number,
): number {
  return Math.max(0, Math.min(firstEnd, secondEnd) - Math.max(firstStart, secondStart));
}

function intervalGap(
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number,
): number {
  if (firstEnd < secondStart) return secondStart - firstEnd;
  if (secondEnd < firstStart) return firstStart - secondEnd;
  return 0;
}

function revealAxisShift(
  start: number,
  end: number,
  safeStart: number,
  safeEnd: number,
  oversizedAlignment?: "negative" | "positive",
): number {
  const size = end - start;
  const available = safeEnd - safeStart;
  if (size > available) {
    return oversizedAlignment === "negative" ? safeEnd - end : safeStart - start;
  }
  if (start < safeStart) return safeStart - start;
  if (end > safeEnd) return safeEnd - end;
  return 0;
}

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function unionRects(rects: WorldRect[]): WorldRect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function intersectionRatio(first: WorldRect, second: WorldRect): number {
  const width = Math.max(
    0,
    Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x),
  );
  const height = Math.max(
    0,
    Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y),
  );
  return first.width > 0 && first.height > 0 ? (width * height) / (first.width * first.height) : 0;
}

function scaledRect(rect: WorldRect, scale: number): WorldRect {
  const width = rect.width * scale;
  const height = rect.height * scale;
  return {
    x: rect.x + (rect.width - width) / 2,
    y: rect.y + (rect.height - height) / 2,
    width,
    height,
  };
}

export class WidgetCanvas {
  readonly #document: Document;
  readonly #window: Window & typeof globalThis;
  readonly #viewport: HTMLElement;
  readonly #stage: HTMLElement;
  readonly #zoomStatus: HTMLElement;
  readonly #navigator: HTMLElement;
  readonly #navigatorItems: HTMLElement;
  readonly #navigatorViewport: HTMLElement;
  readonly #onChange: () => void;
  readonly #onCommit: () => void;
  readonly #onActiveChange: (item: HTMLElement | null) => void;
  readonly #onActiveItemStateChange: (item: HTMLElement) => void;
  readonly #onActiveDragStateChange: (item: HTMLElement, dragging: boolean) => void;
  readonly #onFocusModeChange: (
    item: HTMLElement | null,
    focused: boolean,
    restoredCamera: boolean,
  ) => void;
  readonly #onOpenActiveControls: (item: HTMLElement) => void;
  readonly #onEscapeActiveControls: (item: HTMLElement) => boolean;
  readonly #onKeyboardNavigation: (message: string) => void;
  readonly #onCapacityChange: (snapshot: WidgetCanvasCapacitySnapshot) => void;
  readonly #canRaiseSelection: () => boolean;
  readonly #interactionBlocked: () => boolean;
  readonly #items = new Map<string, HTMLElement>();
  // ksx: divergence from upstream c91d34c (review-caught). Item-scoped
  // listeners were registered on the canvas-lifetime #abort signal, so every
  // removeItem/remount cycle (ksx rebuilds pad widgets on each roster print)
  // stranded the old closures — and their captured detached DOM — until the
  // whole canvas was disposed. Each item gets its own controller, aborted on
  // removal; dispose() still wins through AbortSignal.any.
  readonly #itemAborts = new Map<string, AbortController>();
  readonly #navigatorMarkers = new Map<string, HTMLButtonElement>();
  readonly #runtimeHosts = new Map<string, CanvasRuntimeHost>();
  readonly #runtimeAdapter: CanvasRuntimeAdapter;
  /** ksx: where a widget is allowed to end up. Not a camera limit. */
  readonly #worldBounds: WorldSize;
  /** ksx: the map's projection, held still for the length of a drag on it.
   *  Carries its SCALE too — the mapping is the point of freezing it. */
  #navigatorGestureBounds: (WorldRect & { scale: number }) | null = null;
  readonly #virtualizedHosts = new Map<string, VirtualizedWidgetHost>();
  readonly #parkedAt = new Map<string, number>();
  readonly #scalingFrames = new Map<HTMLElement, number>();
  readonly #transientFrames = new Set<number>();
  readonly #transientTimers = new Set<number>();
  readonly #resizeObserver: ResizeObserver;
  readonly #abort: AbortController;
  #camera: WidgetCanvasCamera = { ...DEFAULT_CAMERA };
  #focusSession: WidgetFocusSession | null = null;
  #cameraFramingTarget: CameraFramingTarget | null = null;
  #activeId: string | null = null;
  #widgetDragPointerId: number | null = null;
  #cameraGesturePointerId: number | null = null;
  #pointerFocusRevealBlocked = false;
  #cancelWidgetDragGesture: (() => void) | null = null;
  #cancelCameraGesture: (() => void) | null = null;
  #topZ = 0;
  #spacePressed = false;
  // ksx: design-tool model state. The selection SET rides beside #activeId —
  // the active item is always the selection's primary member, so everything
  // keyed on a single active answer (selbar, inert, runtime admission, the
  // minimap marker) keeps a defined answer under multi-select.
  readonly #navigationModel: "map" | "design-tool";
  readonly #zoomMin: number;
  readonly #zoomMax: number;
  readonly #onToolModeChange: (mode: "select" | "hand") => void;
  readonly #onSelectionChange: (items: HTMLElement[]) => void;
  readonly #onZoomChange: (zoom: number, tier: "overview" | "structure" | "editing") => void;
  readonly #onCameraHistoryChange: (depth: number, topLabel: string | null) => void;
  #toolMode: "select" | "hand" = "select";
  #selectedIds = new Set<string>();
  /** ksx: chrome overlaying the canvas's right edge (the inspector). Every
   *  camera command computes against the SAFE viewport — the canvas minus
   *  this — so fit/centre land in the visible area, not under the panel. */
  #safeInsetRight = 0;
  readonly #cameraHistory: CameraHistoryEntry[] = [];
  #viewportFrame: ViewportFrame = { width: 0, height: 0, safeWidth: 0 };
  #zoomTier: "overview" | "structure" | "editing" | null = null;
  #animationEndListener: ((event: TransitionEvent) => void) | null = null;
  #changeFrame = 0;
  #cameraFrame = 0;
  #navigatorFrame = 0;
  #animationTimer = 0;
  #cameraMotionTimer = 0;
  #renderedZoom = Number.NaN;
  #deferredUpdates = 0;
  #navigatorDirty = false;
  #changeDirty = false;
  #visibilityDirty = false;
  #maxItems: number;
  #maxActiveRuntimes: number;
  #reservedItems = 0;
  #runtimeActiveCount = 0;
  #runtimeSuspendedCount = 0;
  #virtualizationTimer = 0;
  #lastCapacitySignature = "";
  #disposed = false;

  constructor(elements: WidgetCanvasElements, options: WidgetCanvasOptions = {}) {
    this.#document = elements.viewport.ownerDocument;
    const window_ = this.#document.defaultView;
    if (!window_) throw new Error("canvas viewport is not attached to a browser document");
    this.#window = window_ as Window & typeof globalThis;
    this.#abort = new this.#window.AbortController();
    this.#viewport = elements.viewport;
    this.#stage = elements.stage;
    this.#zoomStatus = elements.zoomStatus;
    this.#navigator = elements.navigator;
    this.#navigatorItems = elements.navigatorItems;
    this.#navigatorViewport = elements.navigatorViewport;
    this.#runtimeAdapter = options.runtimeAdapter ?? NO_RUNTIME_ADAPTER;
    this.#onChange = options.onChange ?? (() => undefined);
    this.#onCommit = options.onCommit ?? (() => undefined);
    this.#worldBounds = options.worldBounds ?? DEFAULT_WORLD_BOUNDS;
    this.#navigationModel = options.navigationModel ?? "map";
    this.#zoomMin = options.zoomRange?.min ?? MIN_ZOOM;
    this.#zoomMax = options.zoomRange?.max ?? MAX_ZOOM;
    this.#onToolModeChange = options.onToolModeChange ?? (() => undefined);
    this.#onSelectionChange = options.onSelectionChange ?? (() => undefined);
    this.#onZoomChange = options.onZoomChange ?? (() => undefined);
    this.#onCameraHistoryChange = options.onCameraHistoryChange ?? (() => undefined);
    this.#onActiveChange = options.onActiveChange ?? (() => undefined);
    this.#onActiveItemStateChange = options.onActiveItemStateChange ?? (() => undefined);
    this.#onActiveDragStateChange = options.onActiveDragStateChange ?? (() => undefined);
    this.#onFocusModeChange = options.onFocusModeChange ?? (() => undefined);
    this.#onOpenActiveControls = options.onOpenActiveControls ?? (() => undefined);
    this.#onEscapeActiveControls = options.onEscapeActiveControls ?? (() => false);
    this.#onKeyboardNavigation = options.onKeyboardNavigation ?? (() => undefined);
    this.#onCapacityChange = options.onCapacityChange ?? (() => undefined);
    this.#canRaiseSelection = options.canRaiseSelection ?? (() => true);
    this.#interactionBlocked = options.interactionBlocked ?? (() =>
      Boolean(this.#document.querySelector("dialog[open]"))
    );
    this.#maxItems = positiveInteger(options.maxItems, FALLBACK_CANVAS_CAPACITY.max_widgets);
    this.#maxActiveRuntimes = positiveInteger(
      options.maxActiveRuntimes,
      FALLBACK_CANVAS_CAPACITY.max_active_runtimes,
    );
    this.#resizeObserver = new this.#window.ResizeObserver((entries) => {
      let changed = false;
      let framedItemChanged = false;
      let viewportChanged = false;
      for (const entry of entries) {
        if (!(entry.target instanceof this.#window.HTMLElement)) continue;
        if (entry.target === this.#viewport) {
          viewportChanged = true;
          continue;
        }
        const borderSize = entry.borderBoxSize[0];
        const width = borderSize?.inlineSize ?? entry.contentRect.width;
        const height = borderSize?.blockSize ?? entry.contentRect.height;
        const nextWidth = String(Math.round(width));
        const nextHeight = String(Math.round(height));
        const item = entry.target.classList.contains("widget-instance")
          ? entry.target
          : this.#runtimeAdapter.ownsEventTarget(entry.target) &&
              entry.target.parentElement?.classList.contains("widget-instance")
            ? entry.target.parentElement
            : null;
        if (!item) continue;
        let itemChanged = false;

        if (entry.target === item && width > 0 && item.dataset.canvasWidth !== nextWidth) {
          item.dataset.canvasWidth = nextWidth;
          changed = itemChanged = true;
        }

        // ksx: divergence from upstream c91d34c (review-caught). An
        // adapter-less item (plain `content` widgets — /nocturne's adopted
        // keyboard) has NO runtime host, so upstream's adapter-owned height
        // source never fires and the recorded height stays the mount-time
        // guess forever — which mis-frames fitAll and, worse, "parks" a
        // widget whose real content is still on screen (inert +
        // content-visibility: hidden on visible keys). When no runtime host
        // is registered for the item, its own border box is the truth.
        const heightSource = item.dataset.canvasResizable === "true" ||
            !this.#runtimeHosts.has(item.dataset.instanceId ?? "")
          ? entry.target === item
          : this.#runtimeAdapter.ownsEventTarget(entry.target);
        if (heightSource && height > 0 && item.dataset.canvasHeight !== nextHeight) {
          item.dataset.canvasHeight = nextHeight;
          item.style.minHeight = `${height}px`;
          changed = itemChanged = true;
        }
        if (itemChanged && item.dataset.instanceId === this.#cameraFramingTarget?.itemId) {
          framedItemChanged = true;
        }
      }
      if (viewportChanged) this.#preserveViewportCenter();
      if (!changed) return;
      if (framedItemChanged) this.#retargetCameraFraming();
      this.#requestNavigatorRender();
      this.#requestVisibilityUpdate();
      this.#scheduleChange();
    });

    this.#resizeObserver.observe(this.#viewport);

    this.#bindCameraInteractions();
    this.#bindNavigatorInteractions();
    this.#viewport.dataset.widgetNavigationSurface = "";
    this.#viewport.dataset.widgetNavigationReveal = "idle";
    this.#syncNavigationFocusTargets();
    this.#window.addEventListener("resize", () => {
      this.#preserveViewportCenter();
    }, { signal: this.#abort.signal });
    this.#syncFocusPresentation();
    this.#renderCameraNow();
    this.#viewportFrame = this.#measureViewportFrame();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelWidgetDragGesture?.();
    this.#cancelCameraGesture?.();
    this.#cancelLostInputState();
    this.#abort.abort();
    this.#resizeObserver.disconnect();
    this.#window.cancelAnimationFrame(this.#changeFrame);
    this.#window.cancelAnimationFrame(this.#cameraFrame);
    this.#window.cancelAnimationFrame(this.#navigatorFrame);
    for (const frame of this.#transientFrames) this.#window.cancelAnimationFrame(frame);
    this.#window.clearTimeout(this.#animationTimer);
    this.#window.clearTimeout(this.#cameraMotionTimer);
    this.#window.clearTimeout(this.#virtualizationTimer);
    for (const timer of this.#transientTimers) this.#window.clearTimeout(timer);
    if (this.#animationEndListener) {
      this.#stage.removeEventListener("transitionend", this.#animationEndListener);
      this.#animationEndListener = null;
    }
    for (const host of this.#runtimeHosts.values()) host.setViewportActive(false);
    this.#runtimeHosts.clear();
    this.#virtualizedHosts.clear();
    this.#parkedAt.clear();
    this.#items.clear();
    this.#navigatorMarkers.clear();
    this.#scalingFrames.clear();
    this.#transientFrames.clear();
    this.#transientTimers.clear();
    this.#changeFrame = 0;
    this.#cameraFrame = 0;
    this.#navigatorFrame = 0;
    this.#animationTimer = 0;
    this.#cameraMotionTimer = 0;
    this.#virtualizationTimer = 0;
  }

  mountItem(
    item: HTMLElement,
    restored?: Partial<WidgetCanvasItemState>,
    options: { focus?: boolean } = {},
  ): void {
    if (this.#items.size + this.#reservedItems >= this.#maxItems) {
      throw new WidgetCanvasCapacityError(this.#items.size + this.#reservedItems, 1, this.#maxItems);
    }
    this.#mountItem(item, restored, options);
  }

  reserveItems(count: number): WidgetCanvasMountReservation {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error("invalid widget reservation count");
    }
    const current = this.#items.size + this.#reservedItems;
    if (current + count > this.#maxItems) {
      throw new WidgetCanvasCapacityError(current, count, this.#maxItems);
    }
    this.#reservedItems += count;
    this.#notifyCapacityChange();
    let remaining = count;
    let released = false;
    return {
      mountItem: (item, restored, options = {}) => {
        if (released || remaining < 1) throw new Error("widget reservation is exhausted");
        remaining -= 1;
        this.#reservedItems -= 1;
        try {
          this.#mountItem(item, restored, options);
        } catch (error) {
          remaining += 1;
          this.#reservedItems += 1;
          throw error;
        }
      },
      release: () => {
        if (released) return;
        released = true;
        this.#reservedItems = Math.max(0, this.#reservedItems - remaining);
        remaining = 0;
        this.#notifyCapacityChange();
      },
    };
  }

  setCapacityLimits(maxItems: number, maxActiveRuntimes: number): void {
    const nextMaxItems = positiveInteger(maxItems, this.#maxItems);
    const nextMaxActive = positiveInteger(maxActiveRuntimes, this.#maxActiveRuntimes);
    const current = this.#items.size + this.#reservedItems;
    if (current > nextMaxItems) {
      throw new WidgetCanvasCapacityError(current, 0, nextMaxItems);
    }
    this.#maxItems = nextMaxItems;
    this.#maxActiveRuntimes = nextMaxActive;
    this.#updateItemVisibility();
    this.#notifyCapacityChange();
  }

  capacitySnapshot(): WidgetCanvasCapacitySnapshot {
    return {
      total: this.#items.size,
      reserved: this.#reservedItems,
      maxItems: this.#maxItems,
      runtimeActive: this.#runtimeActiveCount,
      runtimeSuspended: this.#runtimeSuspendedCount,
      maxActiveRuntimes: this.#maxActiveRuntimes,
    };
  }

  #mountItem(
    item: HTMLElement,
    restored: Partial<WidgetCanvasItemState> | undefined,
    options: { focus?: boolean },
  ): void {
    const id = this.#itemId(item);
    if (this.#items.has(id)) throw new Error(`duplicate canvas item ${id}`);

    item.dataset.widgetNavigationItem = "";
    item.setAttribute(
      "aria-keyshortcuts",
      "ArrowLeft ArrowRight ArrowUp ArrowDown Home End Enter F2 M Meta+Enter Control+Enter",
    );
    item.tabIndex = -1;
    this.#stage.append(item);
    this.#items.set(id, item);
    const runtimeHost = this.#runtimeAdapter.findHost(item);
    if (runtimeHost) {
      this.#runtimeHosts.set(id, runtimeHost);
      item.dataset.virtualizationState = runtimeHost.virtualizationPolicy() ===
          "restart_from_arguments"
        ? "staged"
        : "retained";
    }
    const placement = this.#normalizedPlacement(item, restored);
    this.#positionItem(item, placement);
    const hasExplicitSize = Number.isFinite(restored?.width) && Number.isFinite(restored?.height);
    if (!hasExplicitSize) {
      // New widgets may need one measurement after their CSS is connected. Restored and
      // benchmarked widgets already carry trusted dimensions, so reading layout here would
      // force a full synchronous reflow for every item in a large batch.
      this.#positionItem(item, {
        ...placement,
        width: Math.max(280, item.offsetWidth || placement.width),
        height: Math.max(220, item.offsetHeight || placement.height),
      });
    }
    this.#topZ = Math.max(this.#topZ, placement.z);
    // ksx: divergence — item-scoped listeners live on a per-item signal (see
    // #itemAborts). AbortSignal.any keeps dispose() authoritative.
    const itemAbort = new this.#window.AbortController();
    this.#itemAborts.set(id, itemAbort);
    const itemSignal = AbortSignal.any([this.#abort.signal, itemAbort.signal]);
    this.#bindItemDrag(item, itemSignal);
    this.#bindItemKeyboardNavigation(item, itemSignal);
    item.addEventListener("pointerdown", (event) => {
      // Middle-button and Space gestures belong exclusively to canvas pan; they
      // must not select/raise the widget underneath before bubbling to viewport.
      if (
        event.button !== 0 ||
        this.#spacePressed ||
        this.#widgetDragPointerId !== null ||
        this.#cameraGesturePointerId !== null ||
        (event.pointerType !== "" && !event.isPrimary)
      ) return;
      // ksx: shift/cmd-click TOGGLES membership in the design-tool model —
      // and deliberately does not start a drag or steal focus, so building
      // a selection cannot scatter the widgets being gathered.
      if (
        this.#navigationModel === "design-tool" &&
        (event.shiftKey || event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        this.toggleInSelection(item);
        return;
      }
      this.setActive(item);
      if (!eventOriginatesInInteractiveControl(event)) {
        item.focus({ preventScroll: true });
      }
    }, { signal: itemSignal });
    this.#createNavigatorMarker(item);
    this.#resizeObserver.observe(item);
    if (runtimeHost) this.#resizeObserver.observe(runtimeHost);
    this.#requestNavigatorRender();

    if (options.focus !== false) this.focusItem(item);
    else {
      this.#requestVisibilityUpdate();
      this.#scheduleChange();
    }
    this.#notifyCapacityChange();
  }

  /**
   * Defers navigator and change renders while a caller mounts or restores many items.
   * Geometry and lifecycle registration still happen immediately. The returned release
   * function is idempotent; restore callers may discard their derived persistence change.
   */
  deferDerivedUpdates(notifyChange = true): () => void {
    this.#deferredUpdates += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#deferredUpdates = Math.max(0, this.#deferredUpdates - 1);
      if (this.#deferredUpdates > 0) return;
      if (this.#navigatorDirty) {
        this.#navigatorDirty = false;
        this.#requestNavigatorRender();
      }
      if (this.#changeDirty) {
        this.#changeDirty = false;
        if (notifyChange) this.#scheduleChange();
      }
      if (this.#visibilityDirty) {
        this.#visibilityDirty = false;
        this.#updateItemVisibility();
      }
    };
  }

  /** Flushes a coalesced change notification before a page lifecycle boundary. */
  flushPendingChange(): void {
    // A page lifecycle boundary can arrive before pointerup. Settle captured
    // gestures first so their last rendered coordinates/camera reach the snapshot.
    this.#cancelWidgetDragGesture?.();
    this.#cancelCameraGesture?.();
    if (!this.#changeFrame || this.#deferredUpdates > 0) return;
    this.#window.cancelAnimationFrame(this.#changeFrame);
    this.#changeFrame = 0;
    this.#onChange();
  }

  removeItem(item: HTMLElement, options: { selectFallback?: boolean } = {}): void {
    // Removal can race an armed or captured Move gesture (for example, an async
    // command submitted before the drag began). End that gesture while the item
    // is still registered so its terminal callbacks cannot revive detached UI.
    this.#cancelWidgetDragGesture?.();
    const id = item.dataset.instanceId;
    const removedItemOwnedFocus = item === this.#document.activeElement || item.contains(this.#document.activeElement);
    if (id && this.#focusSession?.itemId === id) this.#endFocusMode(true, true);
    const runtimeHost = id ? this.#runtimeHosts.get(id) : undefined;
    if (id) this.#items.delete(id);
    if (id) {
      this.#itemAborts.get(id)?.abort();
      this.#itemAborts.delete(id);
    }
    if (id) this.#runtimeHosts.delete(id);
    if (id) this.#virtualizedHosts.delete(id);
    if (id) this.#parkedAt.delete(id);
    if (id) {
      this.#navigatorMarkers.get(id)?.remove();
      this.#navigatorMarkers.delete(id);
    }
    this.#resizeObserver.unobserve(item);
    if (runtimeHost) this.#resizeObserver.unobserve(runtimeHost);
    item.remove();
    if (id === this.#activeId) {
      this.#activeId = null;
      const remaining = Array.from(this.#items.values());
      const fallback = remaining.at(-1) ?? null;
      if (fallback && options.selectFallback !== false) this.setActive(fallback);
      else {
        this.#syncNavigationFocusTargets();
        this.#onActiveChange(null);
        if (removedItemOwnedFocus) this.focusViewport();
      }
    }
    this.#requestNavigatorRender();
    this.#scheduleChange();
    this.#requestVisibilityUpdate();
    this.#notifyCapacityChange();
  }

  clearItems(): void {
    this.#cancelWidgetDragGesture?.();
    this.#cancelCameraGesture?.();
    const canvasItemOwnedFocus = this.#stage.contains(this.#document.activeElement);
    this.#endFocusMode(true, false);
    for (const item of this.#items.values()) this.#resizeObserver.unobserve(item);
    for (const host of this.#runtimeHosts.values()) this.#resizeObserver.unobserve(host);
    this.#items.clear();
    for (const abort of this.#itemAborts.values()) abort.abort();
    this.#itemAborts.clear();
    this.#runtimeHosts.clear();
    this.#virtualizedHosts.clear();
    this.#parkedAt.clear();
    this.#window.clearTimeout(this.#virtualizationTimer);
    this.#virtualizationTimer = 0;
    this.#navigatorMarkers.clear();
    this.#stage.replaceChildren();
    this.#navigatorItems.replaceChildren();
    this.#activeId = null;
    this.#topZ = 0;
    this.#syncNavigationFocusTargets();
    this.#onActiveChange(null);
    this.#requestNavigatorRender();
    this.#scheduleChange();
    this.#requestVisibilityUpdate();
    this.#notifyCapacityChange();
    if (canvasItemOwnedFocus) this.focusViewport();
  }

  setActive(item: HTMLElement): void {
    const id = this.#itemId(item);
    if (!this.#items.has(id)) return;
    if (id === this.#activeId) {
      // Re-selecting the primary item is still a fresh editing intent. Hosts
      // with dismissible selection chrome (the redesign Inspector) need this
      // signal to reopen it when the same item is clicked again.
      this.#onSelectionChange(this.selectedItems());
      return;
    }
    const retargetFocus = this.#focusSession !== null;
    if (this.#focusSession) this.#focusSession.itemId = id;
    this.#selectItem(item, this.#canRaiseSelection());
    if (retargetFocus) {
      this.#syncFocusPresentation();
      this.#frameFocusModeItem(item);
      this.#onFocusModeChange(item, true, false);
    }
    this.#updateItemVisibility();
    this.#requestNavigatorRender();
    this.#scheduleChange();
  }

  #selectItem(item: HTMLElement, raise = true): void {
    const id = this.#itemId(item);
    this.#activeId = id;
    // ksx: a single select collapses the multi-selection to that item —
    // the set and the active item can never disagree.
    this.#selectedIds = new Set([id]);
    if (raise) {
      this.#topZ += 1;
      const state = this.getItemState(item);
      state.z = this.#topZ;
      this.#positionItem(item, state);
    }
    this.#applySelectionClasses();
    this.#syncNavigationFocusTargets();
    this.#onActiveChange(item);
    this.#onSelectionChange(this.selectedItems());
  }

  /** ksx: paint membership. `is-active` marks every selected member;
   *  `aria-current` names only the PRIMARY (the active item), so assistive
   *  tech keeps one answer to "which one am I on". */
  #applySelectionClasses(): void {
    for (const [id, candidate] of this.#items) {
      const selected = this.#selectedIds.has(id);
      candidate.classList.toggle("is-active", selected);
      if (selected && id === this.#activeId) candidate.setAttribute("aria-current", "true");
      else candidate.removeAttribute("aria-current");
    }
  }

  /** ksx: replace the whole selection (the marquee's verb). The LAST member
   *  becomes the primary; an empty list clears. No z-raise — a marquee that
   *  reshuffled the stack would make selection destructive. */
  setSelection(items: HTMLElement[]): void {
    const ids = items
      .map((item) => this.#itemId(item))
      .filter((id) => this.#items.has(id));
    if (ids.length === 0) {
      this.clearActive();
      return;
    }
    this.#selectedIds = new Set(ids);
    this.#activeId = ids[ids.length - 1];
    this.#applySelectionClasses();
    this.#syncNavigationFocusTargets();
    this.#onActiveChange(this.activeItem());
    this.#onSelectionChange(this.selectedItems());
    this.#updateItemVisibility();
    this.#requestNavigatorRender();
    this.#scheduleChange();
  }

  /** ksx: shift/cmd-click — toggle one item's membership. Removing the
   *  primary promotes the most recently added remaining member. */
  toggleInSelection(item: HTMLElement): void {
    const id = this.#itemId(item);
    if (!this.#items.has(id)) return;
    const ids = new Set(this.#selectedIds);
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    const ordered = Array.from(ids, (memberId) => this.#items.get(memberId))
      .filter((member): member is HTMLElement => Boolean(member));
    this.setSelection(ordered);
  }

  selectedItems(): HTMLElement[] {
    const items: HTMLElement[] = [];
    for (const id of this.#selectedIds) {
      const item = this.#items.get(id);
      if (item) items.push(item);
    }
    return items;
  }

  activeItem(): HTMLElement | null {
    return this.#activeId ? this.#items.get(this.#activeId) ?? null : null;
  }

  clearActive(): void {
    if (!this.#activeId && this.#selectedIds.size === 0) {
      this.focusViewport();
      return;
    }
    this.#endFocusMode(true, true);
    this.#activeId = null;
    this.#selectedIds = new Set();
    for (const item of this.#items.values()) {
      item.classList.remove("is-active");
      item.removeAttribute("aria-current");
    }
    this.#syncNavigationFocusTargets();
    this.#onActiveChange(null);
    this.#onSelectionChange([]);
    this.#updateItemVisibility();
    this.#requestNavigatorRender();
    this.#scheduleChange();
    this.focusViewport();
  }

  focusViewport(): void {
    if (this.#activeNavigationProxyAvailable()) return;
    this.#viewport.focus({ preventScroll: true });
  }

  /** Reconciles the roving focus entry after an ancestor becomes inert/interactive. */
  refreshNavigationFocusTargets(focusViewport = false): void {
    this.#syncNavigationFocusTargets();
    if (focusViewport && this.#viewport.tabIndex === 0) {
      this.#viewport.focus({ preventScroll: true });
    }
  }

  focusItem(item: HTMLElement, options: WidgetCanvasFocusOptions = {}): void {
    const viewportInsets = normalizedViewportInsets(options.viewportInsets);
    if (this.#focusSession) {
      const alreadyFocused = this.#focusSession.itemId === this.#itemId(item);
      this.setActive(item);
      if (alreadyFocused) {
        this.#focusSession.focusOptions = {
          ...this.#focusSession.focusOptions,
          ...options,
          viewportInsets: options.viewportInsets ?? this.#focusSession.focusOptions.viewportInsets,
        };
        this.#frameFocusModeItem(item);
      }
      return;
    }
    this.setActive(item);
    this.#applyOneShotFocusCamera(item, viewportInsets);
    this.#animateCamera({
      itemId: this.#itemId(item),
      mode: "focus-item",
      viewportInsets,
    });
  }

  centerItem(item: HTMLElement, options: { minimumZoom?: number } = {}): void {
    this.setActive(item);
    if (options.minimumZoom !== undefined) {
      this.#camera.zoom = clamp(
        Math.max(this.#camera.zoom, finiteNumber(options.minimumZoom, this.#zoomMin)),
        this.#zoomMin,
        this.#zoomMax,
      );
    }
    this.#applyCenterCamera(item);
    this.#animateCamera({ itemId: this.#itemId(item), mode: "center" });
  }

  toggleFocusMode(item: HTMLElement, options: WidgetCanvasFocusOptions = {}): boolean {
    const id = this.#itemId(item);
    if (!this.#items.has(id)) return false;
    if (this.#focusSession?.itemId === id) {
      this.#endFocusMode(true, true);
      return false;
    }
    if (this.#focusSession) {
      this.setActive(item);
      return true;
    }

    this.setActive(item);
    this.#stopCameraAnimation();
    this.#renderCameraNow();
    // ksx: Focus owns a history transaction. Escape and Back both restore
    // the bit-identical entry camera and retire this marker plus any camera
    // detours made while Focus was active.
    const historyEntry = this.#recordCameraHistory(
      `before Focus ${item.dataset.widgetName ?? "widget"}`,
    );
    this.#focusSession = {
      itemId: id,
      entryCamera: { ...this.#camera },
      entryViewportFrame: this.#measureViewportFrame(),
      historyEntry,
      focusOptions: {
        ...options,
        viewportInsets: options.viewportInsets ? { ...options.viewportInsets } : undefined,
      },
    };
    this.#syncFocusPresentation();
    this.#onFocusModeChange(item, true, false);
    // Persist the exact entry camera before the transient presentation changes.
    // getCamera() continues to expose this snapshot until Focus ends.
    this.#onCommit();
    this.#frameFocusModeItem(item);
    return true;
  }

  exitFocusMode(): boolean {
    return this.#endFocusMode(true, true);
  }

  isFocusModeActive(item?: HTMLElement | null): boolean {
    if (!this.#focusSession) return false;
    return !item || item.dataset.instanceId === this.#focusSession.itemId;
  }

  #frameFocusModeItem(
    item: HTMLElement,
  ): void {
    const session = this.#focusSession;
    if (!session || session.itemId !== item.dataset.instanceId) return;
    this.#applyFocusModeCamera(item, session);
    this.#animateCamera({
      itemId: session.itemId,
      mode: "focus-mode",
      viewportInsets: session.focusOptions.viewportInsets,
    });
  }

  #safeViewportWidth(width: number): number {
    return Math.max(80, width - this.#safeInsetRight);
  }

  #safeViewportFrame(
    viewport: DOMRectReadOnly,
    insets?: WidgetCanvasViewportInsets,
  ): WorldRect {
    const normalized = normalizedViewportInsets(insets);
    return insetViewportFrame(viewport, {
      top: normalized?.top ?? 0,
      right: Math.max(normalized?.right ?? 0, this.#safeInsetRight),
      bottom: normalized?.bottom ?? 0,
      left: normalized?.left ?? 0,
    });
  }

  #applyCenterCamera(item: HTMLElement): void {
    item.dataset.widgetCommandResetEdge = "true";
    const state = this.getItemState(item);
    const visual = scaledRect(state, state.manualScale);
    const viewport = this.#viewport.getBoundingClientRect();
    const zoom = this.#camera.zoom;
    const safeWidth = this.#safeViewportWidth(viewport.width);
    this.#camera.panX = safeWidth / 2 - (visual.x + visual.width / 2) * zoom;
    this.#camera.panY = viewport.height / 2 - (visual.y + visual.height / 2) * zoom;
  }

  #applyOneShotFocusCamera(
    item: HTMLElement,
    viewportInsets?: WidgetCanvasViewportInsets,
  ): void {
    item.dataset.widgetCommandResetEdge = "true";
    const state = this.getItemState(item);
    const visual = scaledRect(state, state.manualScale);
    const viewport = this.#viewport.getBoundingClientRect();
    const frame = this.#safeViewportFrame(viewport, viewportInsets);
    const focusGutter = clamp(Math.min(frame.width, frame.height) * 0.06, 24, 72);
    const availableWidth = Math.max(viewportInsets ? 1 : 240, frame.width - focusGutter * 2);
    const availableHeight = Math.max(viewportInsets ? 1 : 220, frame.height - focusGutter * 2);
    const targetZoom = clamp(
      Math.min(availableWidth / visual.width, availableHeight / visual.height, 1.1),
      this.#zoomMin,
      this.#zoomMax,
    );
    this.#camera.zoom = targetZoom;
    this.#camera.panX = frame.x + frame.width / 2 -
      (visual.x + visual.width / 2) * targetZoom;
    this.#camera.panY = frame.y + frame.height / 2 -
      (visual.y + visual.height / 2) * targetZoom;
  }

  #applyFocusModeCamera(
    item: HTMLElement,
    session: WidgetFocusSession,
  ): void {
    item.dataset.widgetCommandResetEdge = "true";
    const state = this.getItemState(item);
    const visual = scaledRect(state, state.manualScale);
    const viewport = this.#viewport.getBoundingClientRect();
    const frame = this.#safeViewportFrame(viewport, session.focusOptions.viewportInsets);
    const gutter = clamp(Math.min(frame.width, frame.height) * 0.08, 32, 72);
    const availableWidth = Math.max(1, frame.width - gutter * 2);
    const availableHeight = Math.max(1, frame.height - gutter * 2);
    const desiredZoom = Math.min(
      availableWidth / Math.max(1, visual.width),
      availableHeight / Math.max(1, visual.height),
      FOCUS_MAX_ZOOM,
    );
    const requestedMinimum = finiteNumber(session.focusOptions.minimumZoom, this.#zoomMin);
    const designToolFocusMax = Math.min(this.#zoomMax, DESIGN_TOOL_FOCUS_MAX_ZOOM);
    const designToolFocusMin = Math.min(
      designToolFocusMax,
      Math.max(this.#zoomMin, DESIGN_TOOL_FOCUS_MIN_ZOOM, requestedMinimum),
    );
    const targetZoom = this.#navigationModel === "design-tool"
      ? clamp(desiredZoom, designToolFocusMin, designToolFocusMax)
      : clamp(
        Math.max(session.entryCamera.zoom, desiredZoom, requestedMinimum),
        this.#zoomMin,
        this.#zoomMax,
      );
    this.#camera.zoom = targetZoom;
    const startOversized = session.focusOptions.oversizedAlignment === "start";
    this.#camera.panX = startOversized && visual.width * targetZoom > availableWidth
      ? frame.x + gutter - visual.x * targetZoom
      : frame.x + frame.width / 2 - (visual.x + visual.width / 2) * targetZoom;
    this.#camera.panY = startOversized && visual.height * targetZoom > availableHeight
      ? frame.y + gutter - visual.y * targetZoom
      : frame.y + frame.height / 2 - (visual.y + visual.height / 2) * targetZoom;
  }

  /** A focused long-form widget may intentionally be larger than the
   * viewport. Keyboard focus is authoritative: whenever Tab (or script on
   * behalf of an accessible control) moves inside that form, pan just enough
   * to keep the focused control visible without changing zoom or the entry
   * camera that Focus will restore. */
  #revealFocusModeDescendant(target: HTMLElement): void {
    const session = this.#focusSession;
    if (!session) return;
    const item = this.#items.get(session.itemId);
    if (!item?.contains(target)) return;
    const targetRect = target.getBoundingClientRect();
    if (targetRect.width <= 0 || targetRect.height <= 0) return;
    const viewport = this.#viewport.getBoundingClientRect();
    const frame = this.#safeViewportFrame(viewport, session.focusOptions.viewportInsets);
    const margin = clamp(Math.min(frame.width, frame.height) * 0.04, 18, 32);
    // insetViewportFrame is viewport-local; DOMRects are page-relative.
    const safeLeft = viewport.left + frame.x + margin;
    const safeRight = viewport.left + frame.x + frame.width - margin;
    const safeTop = viewport.top + frame.y + margin;
    const safeBottom = viewport.top + frame.y + frame.height - margin;
    let deltaX = 0;
    let deltaY = 0;
    if (targetRect.width > safeRight - safeLeft) deltaX = safeLeft - targetRect.left;
    else if (targetRect.left < safeLeft) deltaX = safeLeft - targetRect.left;
    else if (targetRect.right > safeRight) deltaX = safeRight - targetRect.right;
    if (targetRect.height > safeBottom - safeTop) deltaY = safeTop - targetRect.top;
    else if (targetRect.top < safeTop) deltaY = safeTop - targetRect.top;
    else if (targetRect.bottom > safeBottom) deltaY = safeBottom - targetRect.bottom;
    if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) return;
    this.#stopCameraAnimation();
    this.#camera.panX += deltaX;
    this.#camera.panY += deltaY;
    this.#renderCameraNow();
    this.#scheduleChange();
  }

  #retargetCameraFraming(): void {
    const target = this.#cameraFramingTarget;
    // Keep the framing intent alive for the short landing window after the
    // CSS transition ends. Newly mounted runtimes can report their final
    // height a frame or two late; dropping the target at transitionend would
    // leave an arriving widget visibly off-centre by half that size delta.
    if (!target) return;
    const item = this.#items.get(target.itemId);
    if (!item) return;
    if (target.mode === "center") this.#applyCenterCamera(item);
    else if (target.mode === "focus-item") {
      this.#applyOneShotFocusCamera(item, target.viewportInsets);
    }
    else if (target.mode === "navigate") this.#applyNavigationReveal(item, target.direction);
    else {
      const session = this.#focusSession;
      if (!session || session.itemId !== target.itemId) return;
      this.#applyFocusModeCamera(item, session);
    }
    this.#renderCameraNow();
  }

  #syncFocusPresentation(): void {
    const session = this.#focusSession;
    this.#viewport.classList.toggle("is-widget-focus-mode", session !== null);
    this.#viewport.dataset.widgetFocusMode = session ? "active" : "inactive";
    if (session) this.#viewport.dataset.widgetFocusInstanceId = session.itemId;
    else delete this.#viewport.dataset.widgetFocusInstanceId;

    for (const [id, item] of this.#items) {
      const focused = session?.itemId === id;
      item.classList.toggle("is-focus-mode", focused);
      if (focused) item.dataset.widgetFocusState = "focused";
      else delete item.dataset.widgetFocusState;
      const host = this.#runtimeHosts.get(id);
      const focusInert = Boolean(session && !focused);
      if (host && host.inert !== focusInert) host.inert = focusInert;
    }
  }

  #endFocusMode(restoreCamera: boolean, animate: boolean): boolean {
    const session = this.#focusSession;
    if (!session) return false;
    const focusedItem = this.#items.get(session.itemId) ?? null;
    this.#stopCameraAnimation();
    this.#focusSession = null;
    this.#syncFocusPresentation();
    this.#onFocusModeChange(focusedItem, false, restoreCamera);

    if (restoreCamera) {
      const historyIndex = this.#cameraHistory.indexOf(session.historyEntry);
      // If the marker fell off the 24-entry ring, every surviving entry was
      // created after Focus began and belongs to that transient transaction.
      if (historyIndex === -1) this.#cameraHistory.length = 0;
      else this.#cameraHistory.splice(historyIndex);
      this.#notifyCameraHistoryChange();
      const viewportFrame = this.#measureViewportFrame();
      this.#camera = {
        panX: session.entryCamera.panX +
          (viewportFrame.safeWidth - session.entryViewportFrame.safeWidth) / 2,
        panY: session.entryCamera.panY +
          (viewportFrame.height - session.entryViewportFrame.height) / 2,
        zoom: session.entryCamera.zoom,
      };
      if (animate) this.#animateCamera();
      else this.#renderCameraNow();
    } else {
      this.#updateItemVisibility();
      this.#requestNavigatorRender();
    }
    return true;
  }

  focusActive(): void {
    const item = this.activeItem();
    if (item) this.focusItem(item);
    else this.fitAll();
  }

  /** `pushHistory: false` is for the AUTOMATIC first-open fit — the design's
   *  rule is that fit runs on first open and never again on its own, and an
   *  automatic move must not mint a history entry (it also un-hid the
   *  Back-view button in the served-vs-hydrated parity capture). */
  fitAll(pushHistory = true): void {
    if (pushHistory) this.pushCameraHistory("before Fit workflow");
    this.#endFocusMode(false, false);
    const bounds = unionRects(Array.from(this.#items.values(), (item) => {
      const state = this.getItemState(item);
      return scaledRect(state, state.manualScale);
    }));
    if (!bounds) {
      this.#camera = { ...DEFAULT_CAMERA };
      this.#animateCamera();
      return;
    }
    if (this.#navigationModel === "design-tool") {
      // ksx: SCREEN-pixel padding (design handoff §3 — 68px per side)
      // rather than a world-unit pad whose on-screen size varies with the
      // resulting zoom; and the cap is 1.1 — a two-widget canvas must not
      // fill the screen.
      this.#fitWorldRect(bounds, 68, 1.1);
      return;
    }
    // The map model keeps the shipped math exactly — /nocturne's suite pins
    // these numbers.
    const viewport = this.#viewport.getBoundingClientRect();
    const padded = {
      x: bounds.x - 60,
      y: bounds.y - 60,
      width: bounds.width + 120,
      height: bounds.height + 120,
    };
    const targetZoom = clamp(
      Math.min(viewport.width / padded.width, viewport.height / padded.height, 1),
      this.#zoomMin,
      this.#zoomMax,
    );
    this.#camera.zoom = targetZoom;
    this.#camera.panX = viewport.width / 2 - (padded.x + padded.width / 2) * targetZoom;
    this.#camera.panY = viewport.height / 2 - (padded.y + padded.height / 2) * targetZoom;
    this.#animateCamera();
  }

  /** ksx: fit the SELECTED widgets only (design handoff §3 — pad 90px,
   *  cap 1.3). How you read one section of a large canvas. Falls back to
   *  fitAll when nothing is selected. */
  fitSelection(): void {
    const selected = this.selectedItems();
    if (selected.length === 0) {
      this.fitAll();
      return;
    }
    this.pushCameraHistory("before Fit selection");
    this.#endFocusMode(false, false);
    const bounds = unionRects(selected.map((item) => {
      const state = this.getItemState(item);
      return scaledRect(state, state.manualScale);
    }));
    if (!bounds) return;
    this.#fitWorldRect(bounds, 90, 1.3);
  }

  /** ksx: pan so the selection's bounding-box centre sits at the viewport
   *  centre. Zoom untouched — that is the whole verb (design handoff §3). */
  centerSelection(): void {
    const selected = this.selectedItems();
    if (selected.length === 0) return;
    this.pushCameraHistory("before Centre selection");
    const bounds = unionRects(selected.map((item) => {
      const state = this.getItemState(item);
      return scaledRect(state, state.manualScale);
    }));
    if (!bounds) return;
    const viewport = this.#viewport.getBoundingClientRect();
    const zoom = this.#camera.zoom;
    const safeWidth = Math.max(80, viewport.width - this.#safeInsetRight);
    this.#camera.panX = safeWidth / 2 - (bounds.x + bounds.width / 2) * zoom;
    this.#camera.panY = viewport.height / 2 - (bounds.y + bounds.height / 2) * zoom;
    this.#animateCamera();
  }

  #fitWorldRect(bounds: WorldRect, screenPadding: number, zoomCap: number): void {
    const viewport = this.#viewport.getBoundingClientRect();
    const safeWidth = Math.max(80, viewport.width - this.#safeInsetRight);
    const availableWidth = Math.max(80, safeWidth - screenPadding * 2);
    const availableHeight = Math.max(80, viewport.height - screenPadding * 2);
    const targetZoom = clamp(
      Math.min(availableWidth / bounds.width, availableHeight / bounds.height, zoomCap),
      this.#zoomMin,
      this.#zoomMax,
    );
    this.#camera.zoom = targetZoom;
    this.#camera.panX = safeWidth / 2 - (bounds.x + bounds.width / 2) * targetZoom;
    this.#camera.panY = viewport.height / 2 - (bounds.y + bounds.height / 2) * targetZoom;
    this.#animateCamera();
  }

  /** ksx: declare how much of the canvas's right edge is covered by chrome.
   *  Fit, centre and the safe-centre zoom anchors compute against what is
   *  left. The inspector calls this as it opens and closes. */
  setSafeInsetRight(px: number, preserveCenter = false): void {
    const next = Math.max(0, px);
    const changed = next !== this.#safeInsetRight;
    this.#safeInsetRight = next;
    if (preserveCenter) {
      this.#preserveViewportCenter();
    } else {
      // Inspector open/close has its own overlap-only camera rule. Adopt the
      // new safe frame as the resize baseline without moving the camera.
      this.#viewportFrame = this.#measureViewportFrame();
      if (changed) this.#requestNavigatorRender();
    }
  }

  #measureViewportFrame(): ViewportFrame {
    const viewport = this.#viewport.getBoundingClientRect();
    return {
      width: viewport.width,
      height: viewport.height,
      safeWidth: this.#safeViewportWidth(viewport.width),
    };
  }

  /** Window resizing is a camera translation, never an implicit Fit. Keep
   *  the world point under the old safe centre under the new safe centre,
   *  and translate stored views by the same screen-space delta so Back and
   *  Focus restoration remain truthful after the viewport changes. */
  #preserveViewportCenter(): void {
    const previous = this.#viewportFrame;
    const next = this.#measureViewportFrame();
    this.#viewportFrame = next;
    if (previous.width <= 0 || previous.height <= 0) {
      this.#renderCameraNow();
      this.#requestNavigatorRender();
      return;
    }
    const deltaX = (next.safeWidth - previous.safeWidth) / 2;
    const deltaY = (next.height - previous.height) / 2;
    if (Math.abs(deltaX) < 0.01 && Math.abs(deltaY) < 0.01) {
      // ResizeObserver may coalesce a brief layout squeeze and its recovery.
      // Reframe against the settled box even when its final size equals the
      // previous baseline; the camera may have been aimed during the squeeze.
      if (this.#cameraFramingTarget) this.#retargetCameraFraming();
      this.#requestNavigatorRender();
      return;
    }
    for (const entry of this.#cameraHistory) {
      entry.panX += deltaX;
      entry.panY += deltaY;
    }
    if (this.#cameraFramingTarget) {
      // A named landing (new widget, Focus, keyboard reveal) owns the current
      // camera until it settles. Recompute that landing for the new frame;
      // translating it as an ordinary view would leave the target off-centre.
      this.#retargetCameraFraming();
    } else {
      this.#stopCameraAnimation();
      this.#camera.panX += deltaX;
      this.#camera.panY += deltaY;
      this.#renderCameraNow();
    }
    this.#requestNavigatorRender();
    this.#scheduleChange();
  }

  /** ksx: the design's panel rule — opening chrome preserves zoom and pans
   *  by EXACTLY the overlap needed to keep the active item clear of it,
   *  often zero. */
  keepActiveClear(margin = 20): void {
    const item = this.activeItem();
    if (!item) return;
    const state = this.getItemState(item);
    const visual = scaledRect(state, state.manualScale);
    const viewport = this.#viewport.getBoundingClientRect();
    const safeRight = viewport.width - this.#safeInsetRight - margin;
    const screenLeft = visual.x * this.#camera.zoom + this.#camera.panX;
    const screenRight = (visual.x + visual.width) * this.#camera.zoom + this.#camera.panX;
    let deltaX = 0;
    if (screenRight > safeRight) deltaX = safeRight - screenRight;
    if (screenLeft + deltaX < margin) deltaX = margin - screenLeft;
    if (deltaX === 0) return;
    this.#camera.panX += deltaX;
    this.#animateCamera(null, PANEL_CAMERA_ANIMATION_MS);
  }

  /** ksx: place one widget at exact world coordinates — the inspector's
   *  numeric X/Y fields (the no-drag a11y contract). One committed change. */
  moveItemTo(item: HTMLElement, x: number, y: number): void {
    if (!this.#items.has(this.#itemId(item))) return;
    this.#moveItem(item, Math.round(x), Math.round(y));
    this.#requestNavigatorRender();
    this.#commitChange();
  }

  zoomBy(factor: number): void {
    const rect = this.#viewport.getBoundingClientRect();
    this.#zoomAtPoint(
      this.#camera.zoom * factor,
      rect.left + (rect.width - this.#safeInsetRight) / 2,
      rect.top + rect.height / 2,
    );
  }

  /** ksx: jump to an absolute zoom, centre-anchored — the zoom menu's
   *  percentage rows. History is pushed only when something will move. */
  setZoomTo(zoom: number, label = "before zoom change"): void {
    const clamped = clamp(zoom, this.#zoomMin, this.#zoomMax);
    if (clamped === this.#camera.zoom) return;
    this.pushCameraHistory(label);
    const rect = this.#viewport.getBoundingClientRect();
    this.#zoomAtPoint(
      clamped,
      rect.left + (rect.width - this.#safeInsetRight) / 2,
      rect.top + rect.height / 2,
      true,
    );
  }

  resetZoom(): void {
    if (this.#camera.zoom !== 1) this.pushCameraHistory("before Zoom 100%");
    const rect = this.#viewport.getBoundingClientRect();
    this.#zoomAtPoint(
      1,
      rect.left + (rect.width - this.#safeInsetRight) / 2,
      rect.top + rect.height / 2,
      true,
    );
  }

  /** ksx: the camera history (design handoff §3) — a labelled ring, capped,
   *  pushed BEFORE every camera verb, its own stack, never content undo.
   *  Captures the LIVE camera on purpose: during focus mode getCamera()
   *  is masked to the entry camera, which is the wrong thing to remember. */
  pushCameraHistory(label: string): void {
    this.#recordCameraHistory(label);
  }

  #recordCameraHistory(label: string): CameraHistoryEntry {
    const entry = { ...this.#camera, label };
    this.#cameraHistory.push(entry);
    if (this.#cameraHistory.length > CAMERA_HISTORY_MAX) this.#cameraHistory.shift();
    this.#notifyCameraHistoryChange();
    return entry;
  }

  #notifyCameraHistoryChange(): void {
    const top = this.#cameraHistory[this.#cameraHistory.length - 1];
    this.#onCameraHistoryChange(this.#cameraHistory.length, top?.label ?? null);
  }

  /** ksx: pop back to the previous view. Returns whether anything moved. */
  backView(): boolean {
    // Focus is a camera transaction with its own exact entry snapshot. One
    // Back press must close that transaction, not expose a redundant second
    // Back press to the same camera.
    if (this.#focusSession) return this.#endFocusMode(true, true);
    const entry = this.#cameraHistory.pop();
    this.#notifyCameraHistoryChange();
    if (!entry) return false;
    this.#endFocusMode(false, false);
    this.#camera = { panX: entry.panX, panY: entry.panY, zoom: entry.zoom };
    this.#animateCamera();
    return true;
  }

  cameraHistoryDepth(): number {
    return this.#cameraHistory.length;
  }

  getCamera(): WidgetCanvasCamera {
    return { ...(this.#focusSession?.entryCamera ?? this.#camera) };
  }

  refreshNavigator(): void {
    this.#requestNavigatorRender();
  }

  restoreCamera(camera: Partial<WidgetCanvasCamera> | undefined, activeId?: string): void {
    this.#endFocusMode(false, false);
    if (camera) {
      this.#camera = {
        panX: finiteNumber(camera.panX, DEFAULT_CAMERA.panX),
        panY: finiteNumber(camera.panY, DEFAULT_CAMERA.panY),
        zoom: clamp(finiteNumber(camera.zoom, DEFAULT_CAMERA.zoom), this.#zoomMin, this.#zoomMax),
      };
    }
    const active = activeId ? this.#items.get(activeId) : undefined;
    // Restoring selection is not a user interaction. Preserve the saved stack
    // exactly so repeated reloads cannot ratchet the active item's z-order.
    if (active) this.#selectItem(active, false);
    this.#renderCameraNow();
    this.#requestNavigatorRender();
    this.#scheduleChange();
  }

  getItemState(item: HTMLElement): WidgetCanvasItemState {
    return {
      x: finiteNumber(Number(item.dataset.canvasX), 0),
      y: finiteNumber(Number(item.dataset.canvasY), 0),
      width: Math.max(280, finiteNumber(Number(item.dataset.canvasWidth), 420)),
      height: Math.max(220, finiteNumber(Number(item.dataset.canvasHeight), 300)),
      z: Math.max(1, finiteNumber(Number(item.dataset.canvasZ), 1)),
      manualScale: clamp(
        finiteNumber(Number(item.dataset.canvasManualScale), 1),
        MIN_WIDGET_MANUAL_SCALE,
        MAX_WIDGET_MANUAL_SCALE,
      ),
    };
  }

  // ksx: divergence from upstream c91d34c. The engine can move an item by
  // drag and by keyboard nudge, but exposes no way for a HOST to place one —
  // so an app-level "arrange everything tidily" command had no door in.
  // Placement is exactly what #moveItem already does for those two paths;
  // this only opens it, keeping the same derived updates a nudge performs.
  // Worth upstreaming: any host with an auto-layout needs it.
  placeItem(item: HTMLElement, x: number, y: number): void {
    if (!this.#items.has(this.#itemId(item))) return;
    this.#moveItem(item, x, y);
    this.#requestNavigatorRender();
    this.#scheduleChange();
  }

  // ksx: a host may temporarily present one mounted item with different
  // dimensions (for example, a parked/collapsed widget). Restoring only its
  // width and height leaves any interim move, raise, or manual scale in the
  // live DOM even when the durable state correctly kept the full geometry.
  // Reuse the engine's own normalization/positioning boundary so all six
  // fields return atomically and the resulting state is committed once.
  restoreItemState(
    item: HTMLElement,
    restored: Partial<WidgetCanvasItemState>,
  ): WidgetCanvasItemState | null {
    if (!this.#items.has(this.#itemId(item))) return null;
    const current = this.getItemState(item);
    const state = this.#normalizedPlacement(item, restored);
    if (state.manualScale !== current.manualScale) this.#suppressItemScaleTransition(item);
    this.#positionItem(item, state);
    this.#updateItemVisibility();
    this.#requestNavigatorRender();
    this.#commitChange();
    return this.getItemState(item);
  }

  adjustItemScale(item: HTMLElement, direction: -1 | 1): number {
    if (!this.#items.has(this.#itemId(item))) return 1;
    const current = this.getItemState(item).manualScale;
    return this.#setItemScale(item, clamp(
      Math.round((current + direction * MANUAL_SCALE_STEP) * 100) / 100,
      MIN_WIDGET_MANUAL_SCALE,
      MAX_WIDGET_MANUAL_SCALE,
    ));
  }

  resetItemScale(item: HTMLElement): number {
    if (!this.#items.has(this.#itemId(item))) return 1;
    return this.#setItemScale(item, 1);
  }

  #setItemScale(item: HTMLElement, manualScale: number): number {
    const state = this.getItemState(item);
    if (manualScale === state.manualScale) return manualScale;

    this.#suppressItemScaleTransition(item);
    this.#positionItem(item, { ...state, manualScale });
    this.#updateItemVisibility();
    this.#requestNavigatorRender();
    this.#commitChange();
    return manualScale;
  }

  #suppressItemScaleTransition(item: HTMLElement): void {
    const pending = this.#scalingFrames.get(item);
    if (pending) {
      this.#window.cancelAnimationFrame(pending);
      this.#transientFrames.delete(pending);
    }
    item.classList.add("is-scaling");
    const firstFrame = this.#queueTransientFrame(() => {
      const secondFrame = this.#queueTransientFrame(() => {
        if (this.#scalingFrames.get(item) !== secondFrame) return;
        this.#scalingFrames.delete(item);
        item.classList.remove("is-scaling");
      });
      this.#scalingFrames.set(item, secondFrame);
    });
    this.#scalingFrames.set(item, firstFrame);
  }

  activeId(): string | null {
    return this.#activeId;
  }

  #syncNavigationFocusTargets(): void {
    const activeProxyAvailable = this.#activeNavigationProxyAvailable();
    this.#viewport.tabIndex = activeProxyAvailable ? -1 : 0;
    for (const [id, candidate] of this.#items) {
      candidate.tabIndex = activeProxyAvailable && id === this.#activeId ? 0 : -1;
    }
  }

  #activeNavigationProxyAvailable(): boolean {
    const active = this.activeItem();
    return Boolean(
      active &&
      !active.inert &&
      !this.#stage.inert &&
      !active.closest("[inert]"),
    );
  }

  #focusItemProxy(item: HTMLElement): void {
    if (this.activeItem() !== item || item.inert || !item.isConnected) return;
    item.focus({ preventScroll: true });
  }

  #bindItemKeyboardNavigation(item: HTMLElement, signal: AbortSignal): void {
    item.addEventListener("focus", () => {
      if (
        this.activeItem() !== item ||
        !item.matches(":focus-visible") ||
        item.inert
      ) {
        return;
      }
      if (this.#focusSession?.itemId === this.#itemId(item)) {
        this.#frameFocusModeItem(item);
      } else if (this.#applyNavigationReveal(item)) {
        this.#animateCamera({ itemId: this.#itemId(item), mode: "navigate" });
      }
    }, { signal });
    item.addEventListener("keydown", (event) => {
      const origin = event.composedPath()[0];
      if (origin !== item) {
        if (
          event.key === "Escape" &&
          !event.defaultPrevented &&
          event.composedPath().some((candidate) => this.#runtimeAdapter.ownsEventTarget(candidate))
        ) {
          event.stopPropagation();
          this.#queueTransientTimeout(() => this.#focusItemProxy(item), 0);
        }
        return;
      }
      if (event.defaultPrevented || event.isComposing) return;

      if (
        event.key === "Enter" &&
        hasPrimaryShortcutModifier(event) &&
        !event.shiftKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        this.setActive(item);
        this.#onOpenActiveControls(item);
        return;
      }
      if (
        (event.key === "Enter" || event.key === "F2") &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        this.setActive(item);
        if (this.#navigationModel === "design-tool" && event.key === "Enter") {
          if (!event.repeat) this.toggleFocusMode(item);
          return;
        }
        const host = this.#runtimeHosts.get(this.#itemId(item));
        if (!host?.focusFirstInteractive()) {
          this.#onKeyboardNavigation(
            `${item.dataset.widgetName ?? "Widget"} has no available interactive controls.`,
          );
        }
        return;
      }
      if (
        event.key.toLowerCase() === "m" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        // In a design-tool canvas M belongs to the canvas minimap. Let the
        // owning surface's shortcut handler receive it; the map-model canvas
        // keeps its established "focus Move" command.
        if (this.#navigationModel === "design-tool") return;
        event.preventDefault();
        event.stopPropagation();
        const moveHandle = item.querySelector<HTMLButtonElement>(".widget-drag-handle");
        if (!moveHandle) {
          this.#onKeyboardNavigation("Move is unavailable for this widget.");
          return;
        }
        if (item.dataset.widgetCommandState === "dormant") {
          if (this.#focusSession?.itemId === this.#itemId(item)) {
            this.#frameFocusModeItem(item);
          } else if (this.#applyNavigationReveal(item)) {
            this.#animateCamera({ itemId: this.#itemId(item), mode: "navigate" });
          }
          this.#queueTransientTimeout(() => {
            if (
              this.activeItem() === item &&
              item.dataset.widgetCommandState !== "dormant"
            ) {
              moveHandle.focus({ preventScroll: true });
            }
          }, 220);
        } else {
          moveHandle.focus({ preventScroll: true });
        }
        return;
      }
      if (event.key === "Escape") {
        // The design-tool surface owns a page-wide escape ladder (overlays,
        // focus mode, camera history, selection). Consuming Escape here would
        // skip its earlier rungs and clear the item underneath an open sheet.
        if (this.#navigationModel === "design-tool") return;
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        if (!this.#onEscapeActiveControls(item)) {
          if (!this.exitFocusMode()) this.clearActive();
        }
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        event.preventDefault();
        event.stopPropagation();
        const endpoint = this.#spatialEndpoint(event.key === "Home" ? "first" : "last");
        if (endpoint) this.#selectNavigationTarget(endpoint, event.key === "Home" ? "home" : "end");
        return;
      }
      const direction = KEYBOARD_NAVIGATION_DIRECTIONS[event.key];
      if (!direction) return;
      // Design-tool arrows nudge the selection (12px, Shift 1px); the owning
      // surface applies that contract after this event bubbles. Map-model
      // arrows retain spatial selection navigation.
      if (this.#navigationModel === "design-tool") return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      const neighbor = this.#spatialNeighbor(item, direction);
      if (neighbor) this.#selectNavigationTarget(neighbor, direction);
      else this.#onKeyboardNavigation(`No widget ${direction} of the current selection.`);
    }, { signal });
  }

  #navigationCandidates(): WidgetNavigationCandidate[] {
    return Array.from(this.#items, ([id, item]) => {
      const state = this.getItemState(item);
      return {
        id,
        item,
        rect: scaledRect(state, state.manualScale),
      };
    });
  }

  #spatialEndpoint(endpoint: "first" | "last"): HTMLElement | null {
    const candidates = this.#navigationCandidates().sort((left, right) =>
      left.rect.y - right.rect.y ||
      left.rect.x - right.rect.x ||
      left.id.localeCompare(right.id)
    );
    const candidate = endpoint === "first" ? candidates[0] : candidates.at(-1);
    return candidate?.item ?? null;
  }

  #nearestWidgetToViewportCenter(): HTMLElement | null {
    const candidates = this.#navigationCandidates();
    if (candidates.length === 0) return null;
    const safeInset = KEYBOARD_NAVIGATION_SAFE_INSET_PX / this.#camera.zoom;
    const visible: WorldRect = {
      x: (-this.#camera.panX + KEYBOARD_NAVIGATION_SAFE_INSET_PX) / this.#camera.zoom,
      y: (-this.#camera.panY + KEYBOARD_NAVIGATION_SAFE_INSET_PX) / this.#camera.zoom,
      width: Math.max(1, this.#viewport.clientWidth / this.#camera.zoom - safeInset * 2),
      height: Math.max(1, this.#viewport.clientHeight / this.#camera.zoom - safeInset * 2),
    };
    const visibleCandidates = candidates.filter(
      (candidate) => intersectionRatio(candidate.rect, visible) > 0,
    );
    const pool = visibleCandidates.length > 0 ? visibleCandidates : candidates;
    const centerX = visible.x + visible.width / 2;
    const centerY = visible.y + visible.height / 2;
    pool.sort((left, right) => {
      const leftDistance = Math.hypot(
        left.rect.x + left.rect.width / 2 - centerX,
        left.rect.y + left.rect.height / 2 - centerY,
      );
      const rightDistance = Math.hypot(
        right.rect.x + right.rect.width / 2 - centerX,
        right.rect.y + right.rect.height / 2 - centerY,
      );
      return leftDistance - rightDistance || left.id.localeCompare(right.id);
    });
    return pool[0]?.item ?? null;
  }

  #spatialNeighbor(
    sourceItem: HTMLElement,
    direction: WidgetNavigationDirection,
  ): HTMLElement | null {
    const sourceState = this.getItemState(sourceItem);
    const source = scaledRect(sourceState, sourceState.manualScale);
    const sourceCenterX = source.x + source.width / 2;
    const sourceCenterY = source.y + source.height / 2;
    const horizontal = direction === "left" || direction === "right";
    const positive = direction === "right" || direction === "down";
    const ranked = this.#navigationCandidates()
      .filter((candidate) => candidate.item !== sourceItem)
      .map((candidate) => {
        const centerX = candidate.rect.x + candidate.rect.width / 2;
        const centerY = candidate.rect.y + candidate.rect.height / 2;
        const primaryCenterDelta = horizontal
          ? centerX - sourceCenterX
          : centerY - sourceCenterY;
        if ((positive && primaryCenterDelta <= 0) || (!positive && primaryCenterDelta >= 0)) {
          return null;
        }
        const crossOverlap = horizontal
          ? intervalOverlap(
              source.y,
              source.y + source.height,
              candidate.rect.y,
              candidate.rect.y + candidate.rect.height,
            )
          : intervalOverlap(
              source.x,
              source.x + source.width,
              candidate.rect.x,
              candidate.rect.x + candidate.rect.width,
            );
        const crossMinimum = horizontal
          ? Math.min(source.height, candidate.rect.height)
          : Math.min(source.width, candidate.rect.width);
        const beamRank = crossOverlap / Math.max(1, crossMinimum) >= 0.2 ? 0 : 1;
        const primaryGap = direction === "right"
          ? Math.max(0, candidate.rect.x - (source.x + source.width))
          : direction === "left"
            ? Math.max(0, source.x - (candidate.rect.x + candidate.rect.width))
            : direction === "down"
              ? Math.max(0, candidate.rect.y - (source.y + source.height))
              : Math.max(0, source.y - (candidate.rect.y + candidate.rect.height));
        const crossGap = horizontal
          ? intervalGap(
              source.y,
              source.y + source.height,
              candidate.rect.y,
              candidate.rect.y + candidate.rect.height,
            )
          : intervalGap(
              source.x,
              source.x + source.width,
              candidate.rect.x,
              candidate.rect.x + candidate.rect.width,
            );
        return {
          ...candidate,
          beamRank,
          primaryGap,
          crossGap,
          euclidean: Math.hypot(centerX - sourceCenterX, centerY - sourceCenterY),
        };
      })
      .filter((candidate) => candidate !== null)
      .sort((left, right) =>
        left.beamRank - right.beamRank ||
        left.primaryGap - right.primaryGap ||
        left.crossGap - right.crossGap ||
        left.euclidean - right.euclidean ||
        left.id.localeCompare(right.id)
      );
    return ranked[0]?.item ?? null;
  }

  #selectNavigationTarget(
    item: HTMLElement,
    label: WidgetNavigationDirection | "home" | "end" | "nearest",
  ): void {
    if (this.#focusSession) {
      const alreadyActive = this.activeItem() === item;
      this.setActive(item);
      if (alreadyActive) this.#frameFocusModeItem(item);
    } else {
      this.setActive(item);
      const direction = isWidgetNavigationDirection(label) ? label : undefined;
      if (this.#applyNavigationReveal(item, direction)) {
        this.#animateCamera({
          itemId: this.#itemId(item),
          mode: "navigate",
          direction,
        });
      }
    }
    this.#queueTransientFrame(() => this.#focusItemProxy(item));
    this.#onKeyboardNavigation(`Selected ${item.dataset.widgetName ?? "widget"}.`);
  }

  #applyNavigationReveal(
    item: HTMLElement,
    direction?: WidgetNavigationDirection,
  ): boolean {
    const state = this.getItemState(item);
    const visual = scaledRect(state, state.manualScale);
    const zoom = this.#camera.zoom;
    const left = visual.x * zoom + this.#camera.panX;
    const top = visual.y * zoom + this.#camera.panY;
    const width = visual.width * zoom;
    const height = visual.height * zoom;
    const right = left + width;
    const bottom = top + height;
    const safeLeft = KEYBOARD_NAVIGATION_SAFE_INSET_PX;
    const safeTop = KEYBOARD_NAVIGATION_SAFE_INSET_PX;
    const safeRight = Math.max(safeLeft, this.#viewport.clientWidth - KEYBOARD_NAVIGATION_SAFE_INSET_PX);
    const safeBottom = Math.max(safeTop, this.#viewport.clientHeight - KEYBOARD_NAVIGATION_SAFE_INSET_PX);
    const horizontalDirection = direction === "left" || direction === "right" ? direction : undefined;
    const verticalDirection = direction === "up" || direction === "down" ? direction : undefined;
    const shiftX = revealAxisShift(
      left,
      right,
      safeLeft,
      safeRight,
      horizontalDirection === "right" ? "positive" : horizontalDirection === "left" ? "negative" : undefined,
    );
    const shiftY = revealAxisShift(
      top,
      bottom,
      safeTop,
      safeBottom,
      verticalDirection === "down" ? "positive" : verticalDirection === "up" ? "negative" : undefined,
    );
    if (Math.abs(shiftX) < 0.5 && Math.abs(shiftY) < 0.5) return false;
    this.#camera.panX += shiftX;
    this.#camera.panY += shiftY;
    return true;
  }

  #normalizedPlacement(
    item: HTMLElement,
    restored?: Partial<WidgetCanvasItemState>,
  ): WidgetCanvasItemState {
    const index = this.#items.size - 1;
    // ksx: divergence from upstream c91d34c (review-caught): the 720px
    // preferred-width ceiling silently discarded the keyboard widget's
    // declared 980px (clamp(980,300,720)=720), cropping the board into its
    // own scrollbar. The declared attribute is the widget author's own
    // claim; the ceiling only needs to stop nonsense. Same for the
    // resizable-restore ceiling below.
    const preferredWidth = clamp(
      finiteNumber(Number(item.dataset.canvasPreferredWidth), 440),
      300,
      1600,
    );
    const minHeight = clamp(
      finiteNumber(Number(item.dataset.canvasMinHeight), 300),
      220,
      1200,
    );
    const resizable = item.dataset.canvasResizable === "true";
    return {
      x: finiteNumber(restored?.x, 110 + (index % 3) * 520),
      y: finiteNumber(restored?.y, 100 + Math.floor(index / 3) * 440 + (index % 2) * 36),
      width: resizable
        ? clamp(finiteNumber(restored?.width, preferredWidth), 280, 1600)
        : preferredWidth,
      height: resizable
        ? clamp(finiteNumber(restored?.height, minHeight), 220, 920)
        : clamp(finiteNumber(restored?.height, minHeight), minHeight, 1600),
      z: Math.max(1, finiteNumber(restored?.z, this.#topZ + 1)),
      manualScale: clamp(
        finiteNumber(restored?.manualScale, 1),
        MIN_WIDGET_MANUAL_SCALE,
        MAX_WIDGET_MANUAL_SCALE,
      ),
    };
  }

  #positionItem(item: HTMLElement, state: WidgetCanvasItemState): void {
    // ksx: mounting is the other way a position arrives — a restored one
    // from a store written before the world was bounded, or a spawn cascade
    // that ran past its edge. Both land inside it.
    const inside = this.#clampToWorld(state, state.x, state.y);
    const x = Math.round(inside.x * 1000) / 1000;
    const y = Math.round(inside.y * 1000) / 1000;
    item.dataset.canvasX = String(x);
    item.dataset.canvasY = String(y);
    item.dataset.canvasWidth = String(Math.round(state.width));
    item.dataset.canvasHeight = String(Math.round(state.height));
    item.dataset.canvasZ = String(Math.round(state.z));
    item.dataset.canvasManualScale = String(state.manualScale);
    item.style.left = `${x}px`;
    item.style.top = `${y}px`;
    item.style.width = `${state.width}px`;
    item.style.minHeight = `${state.height}px`;
    item.style.zIndex = String(state.z);
  }

  #moveItem(item: HTMLElement, x: number, y: number): void {
    // ksx: every move — drag, keyboard nudge, host placement — lands inside
    // the world. A widget that leaves it is unreachable by any control.
    const inside = this.#clampToWorld(this.getItemState(item), x, y);
    item.dataset.canvasX = String(Math.round(inside.x));
    item.dataset.canvasY = String(Math.round(inside.y));
    item.style.left = `${inside.x}px`;
    item.style.top = `${inside.y}px`;
    this.#updateItemVisibility();
  }

  #updateItemChromePlacement(
    item: HTMLElement,
    state: WidgetCanvasItemState,
    visible: WorldRect,
    effectiveScale: number,
  ): void {
    const visual = scaledRect({
      x: state.x,
      y: state.y,
      width: state.width,
      height: state.height,
    }, effectiveScale);
    const resetEdgeMemory = item.dataset.widgetCommandResetEdge === "true";
    const previousEdge = !resetEdgeMemory && isWidgetCommandEdge(item.dataset.widgetCommandEdge)
      ? item.dataset.widgetCommandEdge
      : undefined;
    const worldPerScreenPixel = 1 / this.#camera.zoom;
    const placement = resolveWidgetCommandDockPlacement(
      visual,
      visible,
      {
        horizontalLength: WIDGET_COMMAND_TANGENT_LENGTH_PX * worldPerScreenPixel,
        horizontalThickness: WIDGET_COMMAND_OUTWARD_EXTENT_PX * worldPerScreenPixel,
        sideLength: WIDGET_COMMAND_TANGENT_LENGTH_PX * worldPerScreenPixel,
        sideThickness: WIDGET_COMMAND_OUTWARD_EXTENT_PX * worldPerScreenPixel,
        gap: WIDGET_COMMAND_EDGE_GAP_PX * worldPerScreenPixel,
        safeInset: WIDGET_COMMAND_SAFE_INSET_PX * worldPerScreenPixel,
        hysteresis: WIDGET_CHROME_EDGE_HYSTERESIS_PX * worldPerScreenPixel,
        handoff: WIDGET_COMMAND_EDGE_HANDOFF_PX * worldPerScreenPixel,
        handoffRatio: WIDGET_COMMAND_EDGE_HANDOFF_RATIO,
        gripRadius: WIDGET_CHROME_CONTROL_RADIUS_PX * worldPerScreenPixel,
      },
      previousEdge,
    );
    if (resetEdgeMemory) delete item.dataset.widgetCommandResetEdge;
    const roundedScale = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
    const netScreenScale = this.#camera.zoom * effectiveScale;
    const controlScale = roundedScale(1 / netScreenScale);
    const railVisualScale = roundedScale(clamp(netScreenScale, 0.5, 1));
    const railHalfThickness = roundedScale(Math.max(3, 5 * railVisualScale) / 2);
    const dragLift = roundedScale(-2 * controlScale);
    const dragOutlineWidth = roundedScale(2 * controlScale);
    const dragOutlineOffset = roundedScale(5 * controlScale);
    const previousState = item.dataset.widgetCommandState;
    if (!placement) {
      const signature = `dormant:${controlScale}:${railVisualScale}`;
      if (item.dataset.widgetChromePlacement === signature) return;
      item.dataset.widgetChromePlacement = signature;
      item.dataset.widgetCommandState = "dormant";
      delete item.dataset.widgetCommandEdge;
      delete item.dataset.widgetCommandDensity;
      delete item.dataset.widgetCommandRevealed;
      delete item.dataset.widgetCommandLatched;
      delete item.dataset.widgetCommandRevealLength;
      delete item.dataset.widgetChromeAnchorX;
      delete item.dataset.widgetChromeAnchorY;
      item.style.setProperty("--widget-chrome-control-scale", String(controlScale));
      item.style.setProperty("--widget-command-rail-visual-scale", String(railVisualScale));
      item.style.setProperty("--widget-command-rail-half-thickness", `${railHalfThickness}px`);
      item.style.setProperty("--widget-drag-lift", `${dragLift}px`);
      item.style.setProperty("--widget-drag-outline-width", `${dragOutlineWidth}px`);
      item.style.setProperty("--widget-drag-outline-offset", `${dragOutlineOffset}px`);
      if (previousState !== "dormant" && item.classList.contains("is-active")) {
        this.#onActiveItemStateChange(item);
      }
      return;
    }

    const centerX = state.x + state.width / 2;
    const centerY = state.y + state.height / 2;
    const toLocalX = (worldX: number): number =>
      state.width / 2 + (worldX - centerX) / effectiveScale;
    const toLocalY = (worldY: number): number =>
      state.height / 2 + (worldY - centerY) / effectiveScale;
    const rounded = (value: number): number => Math.round(value * 100) / 100;
    const edge = placement.edge;
    const commandState = placement.state;
    const attachmentX = rounded(toLocalX(placement.attachmentX));
    const attachmentY = rounded(toLocalY(placement.attachmentY));
    const signature = [
      commandState,
      edge,
      attachmentX,
      attachmentY,
      controlScale,
      railVisualScale,
    ].join(":");
    if (item.dataset.widgetChromePlacement === signature) return;

    item.dataset.widgetChromePlacement = signature;
    item.dataset.widgetCommandState = commandState;
    item.dataset.widgetCommandEdge = edge;
    item.dataset.widgetChromeAnchorX = String(attachmentX);
    item.dataset.widgetChromeAnchorY = String(attachmentY);
    delete item.dataset.widgetCommandDensity;
    delete item.dataset.widgetCommandRevealed;
    delete item.dataset.widgetCommandLatched;
    delete item.dataset.widgetCommandRevealLength;
    item.style.setProperty("--widget-command-attachment-x", `${attachmentX}px`);
    item.style.setProperty("--widget-command-attachment-y", `${attachmentY}px`);
    item.style.setProperty("--widget-chrome-control-scale", String(controlScale));
    item.style.setProperty("--widget-command-rail-visual-scale", String(railVisualScale));
    item.style.setProperty("--widget-command-rail-half-thickness", `${railHalfThickness}px`);
    item.style.setProperty("--widget-drag-lift", `${dragLift}px`);
    item.style.setProperty("--widget-drag-outline-width", `${dragOutlineWidth}px`);
    item.style.setProperty("--widget-drag-outline-offset", `${dragOutlineOffset}px`);
    delete item.dataset.widgetChromeCorner;
    delete item.dataset.widgetChromeRemoveVisible;
    delete item.dataset.widgetChromeRescue;
    delete item.dataset.widgetCommandDock;
    delete item.dataset.widgetCommandDockFlow;
    if (previousState !== commandState && item.classList.contains("is-active")) {
      this.#onActiveItemStateChange(item);
    }
  }

  #bindItemDrag(item: HTMLElement, signal: AbortSignal): void {
    const handle = item.querySelector<HTMLElement>(".widget-drag-handle");
    if (!handle) return;
    handle.addEventListener("pointerdown", (event) => {
      if (
        this.#spacePressed ||
        event.button !== 0 ||
        (event.pointerType !== "" && !event.isPrimary) ||
        this.#widgetDragPointerId !== null ||
        this.#cameraGesturePointerId !== null ||
        item.classList.contains("is-dragging")
      ) return;
      event.preventDefault();
      event.stopPropagation();
      this.#stopCameraAnimation();
      this.setActive(item);
      const original = this.getItemState(item);
      const pointerId = event.pointerId;
      this.#widgetDragPointerId = pointerId;
      const startClientX = event.clientX;
      const startClientY = event.clientY;
      const startZoom = this.#camera.zoom;
      let nextX = original.x;
      let nextY = original.y;
      let moveFrame = 0;
      let moved = false;
      let ended = false;
      let usesWindowFallback = false;

      const renderMove = (): void => {
        moveFrame = 0;
        if (!moved) return;
        this.#moveItem(item, nextX, nextY);
        this.#requestNavigatorRender();
      };
      const onMove = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== pointerId) return;
        const deltaX = moveEvent.clientX - startClientX;
        const deltaY = moveEvent.clientY - startClientY;
        if (!moved && Math.hypot(deltaX, deltaY) <= 5) return;
        if (!moved) {
          moved = true;
          this.#viewport.classList.add("is-dragging-widget");
          item.classList.add("is-dragging");
          this.#onActiveDragStateChange(item, true);
        }
        nextX = Math.round(original.x + deltaX / startZoom);
        nextY = Math.round(original.y + deltaY / startZoom);
        if (!moveFrame) moveFrame = this.#window.requestAnimationFrame(renderMove);
      };
      const finish = (endEvent: PointerEvent | null): void => {
        if ((endEvent && endEvent.pointerId !== pointerId) || ended) return;
        ended = true;
        this.#cancelWidgetDragGesture = null;
        if (moved && endEvent?.type === "pointerup") {
          nextX = Math.round(original.x + (endEvent.clientX - startClientX) / startZoom);
          nextY = Math.round(original.y + (endEvent.clientY - startClientY) / startZoom);
        }
        if (moveFrame) this.#window.cancelAnimationFrame(moveFrame);
        if (moved) renderMove();
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onEnd);
        handle.removeEventListener("pointercancel", onEnd);
        handle.removeEventListener("lostpointercapture", onEnd);
        if (usesWindowFallback) {
          this.#window.removeEventListener("pointermove", onMove);
          this.#window.removeEventListener("pointerup", onEnd);
          this.#window.removeEventListener("pointercancel", onEnd);
        }
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
        if (moved) {
          // The final coordinates are already rendered. Mark them durable now; only the
          // visual lift waits a frame so a pagehide between pointerup and rAF cannot lose them.
          this.#commitChange();
          const itemId = this.#itemId(item);
          this.#queueTransientFrame(() => {
            this.#viewport.classList.remove("is-dragging-widget");
            item.classList.remove("is-dragging");
            if (this.#widgetDragPointerId === pointerId) this.#widgetDragPointerId = null;
            if (item.isConnected && this.#items.get(itemId) === item) {
              this.#updateItemVisibility();
              this.#onActiveDragStateChange(item, false);
            }
          });
        } else {
          if (this.#widgetDragPointerId === pointerId) this.#widgetDragPointerId = null;
          this.#updateItemVisibility();
        }
      };
      const onEnd = (endEvent: PointerEvent): void => finish(endEvent);
      this.#cancelWidgetDragGesture = () => finish(null);
      try {
        handle.setPointerCapture(pointerId);
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onEnd);
        handle.addEventListener("pointercancel", onEnd);
        handle.addEventListener("lostpointercapture", onEnd);
      } catch {
        // Synthetic events and older pointer implementations need a window fallback.
        usesWindowFallback = true;
        this.#window.addEventListener("pointermove", onMove);
        this.#window.addEventListener("pointerup", onEnd);
        this.#window.addEventListener("pointercancel", onEnd);
      }
    }, { signal });

    handle.addEventListener("keydown", (event) => {
      if (
        (event.key === "Enter" || event.key === " ") &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        this.setActive(item);
        this.#onOpenActiveControls(item);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        this.#focusItemProxy(item);
        return;
      }
      const direction = KEYBOARD_MOVE_DELTAS[event.key];
      if (!direction) return;
      // The redesign's move handle is an alternative focus target, not an
      // alternative movement scale. Let its canvas-level 12px/1px nudge own
      // the key so shell focus and handle focus cannot move different amounts.
      if (this.#navigationModel === "design-tool") return;
      const navigationDirection = KEYBOARD_NAVIGATION_DIRECTIONS[event.key];
      if (navigationDirection && hasPrimaryShortcutModifier(event)) {
        event.preventDefault();
        event.stopPropagation();
        const neighbor = this.#spatialNeighbor(item, navigationDirection);
        if (neighbor) this.#selectNavigationTarget(neighbor, navigationDirection);
        else this.#onKeyboardNavigation(
          `No widget ${navigationDirection} of the current selection.`,
        );
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      this.#stopCameraAnimation();
      if (this.activeItem() !== item) this.setActive(item);
      const state = this.getItemState(item);
      const step = event.shiftKey ? KEYBOARD_MOVE_STEP * 4 : KEYBOARD_MOVE_STEP;
      this.#moveItem(item, state.x + direction[0] * step, state.y + direction[1] * step);
      this.#requestNavigatorRender();
      this.#scheduleChange();
    }, { signal });
  }

  #bindCameraInteractions(): void {
    // Pointer focus must not move its target between pointerdown and pointerup
    // or the browser can cancel the click. Pointer users already aim at a
    // visible control; the focus-driven reveal is for Tab/script focus that
    // can legitimately land beyond the clipped viewport.
    this.#viewport.addEventListener("pointerdown", () => {
      this.#pointerFocusRevealBlocked = true;
    }, { capture: true, signal: this.#abort.signal });
    const releasePointerFocusBlock = (): void => {
      this.#pointerFocusRevealBlocked = false;
    };
    this.#window.addEventListener("pointerup", releasePointerFocusBlock, {
      capture: true,
      signal: this.#abort.signal,
    });
    this.#window.addEventListener("pointercancel", releasePointerFocusBlock, {
      capture: true,
      signal: this.#abort.signal,
    });
    this.#viewport.addEventListener("focusin", (event) => {
      const target = event.target;
      if (
        !this.#pointerFocusRevealBlocked &&
        target instanceof this.#window.HTMLElement &&
        target !== this.#viewport
      ) {
        this.#revealFocusModeDescendant(target);
      }
    }, { signal: this.#abort.signal });

    this.#viewport.addEventListener("keydown", (event) => {
      if (
        event.composedPath()[0] !== this.#viewport ||
        event.defaultPrevented ||
        event.isComposing
      ) {
        return;
      }
      if (
        event.key === "Enter" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        const nearest = this.#nearestWidgetToViewportCenter();
        if (nearest) this.#selectNavigationTarget(nearest, "nearest");
        else this.#onKeyboardNavigation("There are no widgets on the canvas.");
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const direction = KEYBOARD_NAVIGATION_DIRECTIONS[event.key];
      if (!direction) return;
      event.preventDefault();
      // ksx: in the design-tool model arrows move the SELECTION when one
      // exists (12px, shift 1px — the design's numbers); the camera pan is
      // what arrows mean only on an empty selection.
      if (this.#navigationModel === "design-tool" && this.#selectedIds.size > 0) {
        const nudge = event.shiftKey ? 1 : 12;
        this.moveSelectionBy(
          direction === "left" ? -nudge : direction === "right" ? nudge : 0,
          direction === "up" ? -nudge : direction === "down" ? nudge : 0,
        );
        return;
      }
      this.#stopCameraAnimation();
      const step = event.shiftKey
        ? KEYBOARD_CANVAS_PAN_LARGE_STEP_PX
        : KEYBOARD_CANVAS_PAN_STEP_PX;
      if (direction === "left") this.#camera.panX += step;
      else if (direction === "right") this.#camera.panX -= step;
      else if (direction === "up") this.#camera.panY += step;
      else this.#camera.panY -= step;
      this.#requestCameraRender();
      this.#scheduleChange();
    }, { signal: this.#abort.signal });

    this.#document.addEventListener("keydown", (event) => {
      const activeElement = this.#document.activeElement;
      const canvasOwnsFocus = activeElement === this.#viewport ||
        (activeElement !== null && this.#viewport.contains(activeElement));
      if (
        canvasOwnsFocus &&
        event.code === "Space" &&
        !event.repeat &&
        !event.defaultPrevented &&
        !event.isComposing &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !this.#interactionBlocked() &&
        !eventOriginatesInInteractiveControl(event)
      ) {
        event.preventDefault();
        this.#spacePressed = true;
        this.#viewport.classList.add("is-pan-ready");
      }
    }, { signal: this.#abort.signal });
    this.#document.addEventListener("keyup", (event) => {
      if (event.code === "Space") this.#clearSpacePanState();
    }, { signal: this.#abort.signal });
    this.#window.addEventListener("blur", () => this.#cancelLostInputState(), {
      signal: this.#abort.signal,
    });
    this.#document.addEventListener("visibilitychange", () => {
      if (this.#document.hidden) this.#cancelLostInputState();
    }, { signal: this.#abort.signal });

    this.#viewport.addEventListener("pointerdown", (event) => {
      const target = event.target as HTMLElement;
      const onBackground = target === this.#viewport || target === this.#stage;
      // ksx: two navigation models share this press. In "map" a plain
      // left-drag on empty space pans (the shipped default). In
      // "design-tool" that same drag marquee-selects, and panning belongs
      // to space, middle, right and the hand tool — the map model is easier
      // in the first five minutes and worse from the second hour, once
      // people select groups and organise sections.
      const designTool = this.#navigationModel === "design-tool";
      const shouldPan = event.button === 1 ||
        (designTool && event.button === 2) ||
        this.#spacePressed ||
        (event.button === 0 && onBackground &&
          (!designTool || this.#toolMode === "hand"));
      const shouldMarquee = !shouldPan && designTool &&
        event.button === 0 && onBackground && this.#toolMode === "select";
      if (
        (!shouldPan && !shouldMarquee) ||
        (event.pointerType !== "" && !event.isPrimary) ||
        this.#cameraGesturePointerId !== null ||
        this.#widgetDragPointerId !== null
      ) return;
      event.preventDefault();
      const pointerId = event.pointerId;
      this.#cameraGesturePointerId = pointerId;
      const startX = event.clientX;
      const startY = event.clientY;

      if (shouldMarquee) {
        // ksx: the marquee is TRANSIENT interaction state — the rectangle
        // element exists only between the 5px threshold and pointerup, so a
        // settled page can never carry it (SSR parity rule 3e). It shares
        // the camera gesture slot so every mutual-exclusion guard and
        // teardown path covers it unchanged — but it is deliberately NOT
        // camera motion: no pan class, no admission freeze.
        const additive = event.shiftKey || event.metaKey || event.ctrlKey;
        const viewportRect = this.#viewport.getBoundingClientRect();
        let marquee: HTMLElement | null = null;
        let marqueeMoved = false;
        const onMarqueeMove = (moveEvent: PointerEvent): void => {
          if (moveEvent.pointerId !== pointerId) return;
          const deltaX = moveEvent.clientX - startX;
          const deltaY = moveEvent.clientY - startY;
          if (!marqueeMoved && Math.hypot(deltaX, deltaY) <= 5) return;
          if (!marqueeMoved) {
            marqueeMoved = true;
            marquee = this.#document.createElement("div");
            marquee.className = "canvas-marquee";
            marquee.setAttribute("aria-hidden", "true");
            this.#viewport.append(marquee);
          }
          const box = marquee as HTMLElement;
          box.style.left = `${Math.min(startX, moveEvent.clientX) - viewportRect.left}px`;
          box.style.top = `${Math.min(startY, moveEvent.clientY) - viewportRect.top}px`;
          box.style.width = `${Math.abs(moveEvent.clientX - startX)}px`;
          box.style.height = `${Math.abs(moveEvent.clientY - startY)}px`;
        };
        const finishMarquee = (endEvent: PointerEvent | null): void => {
          if (endEvent && endEvent.pointerId !== pointerId) return;
          this.#cancelCameraGesture = null;
          this.#window.removeEventListener("pointermove", onMarqueeMove);
          this.#window.removeEventListener("pointerup", onMarqueeEnd);
          this.#window.removeEventListener("pointercancel", onMarqueeEnd);
          marquee?.remove();
          if (this.#cameraGesturePointerId === pointerId) this.#cameraGesturePointerId = null;
          if (endEvent?.type !== "pointerup") return;
          if (!marqueeMoved) {
            // A tap on empty space clears — unless the press was additive.
            if (!additive) this.clearActive();
            return;
          }
          const { panX, panY, zoom } = this.#camera;
          const minX = (Math.min(startX, endEvent.clientX) - viewportRect.left - panX) / zoom;
          const maxX = (Math.max(startX, endEvent.clientX) - viewportRect.left - panX) / zoom;
          const minY = (Math.min(startY, endEvent.clientY) - viewportRect.top - panY) / zoom;
          const maxY = (Math.max(startY, endEvent.clientY) - viewportRect.top - panY) / zoom;
          // Intersects, not contains — the design's own rule; candidates
          // carry world-space visual rects, virtualized widgets included.
          const hits = this.#navigationCandidates()
            .filter(({ rect }) =>
              rect.x < maxX && rect.x + rect.width > minX &&
              rect.y < maxY && rect.y + rect.height > minY
            )
            .map(({ item }) => item);
          if (additive) {
            const merged = this.selectedItems();
            for (const item of hits) if (!merged.includes(item)) merged.push(item);
            this.setSelection(merged);
          } else {
            this.setSelection(hits);
          }
        };
        const onMarqueeEnd = (endEvent: PointerEvent): void => finishMarquee(endEvent);
        this.#cancelCameraGesture = () => finishMarquee(null);
        this.#window.addEventListener("pointermove", onMarqueeMove);
        this.#window.addEventListener("pointerup", onMarqueeEnd);
        this.#window.addEventListener("pointercancel", onMarqueeEnd);
        return;
      }

      const origin = { ...this.#camera };
      const clearsSelection = event.button === 0 && onBackground && !this.#spacePressed &&
        !(designTool && this.#toolMode === "hand");
      let moved = false;

      const onMove = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== pointerId) return;
        const deltaX = moveEvent.clientX - startX;
        const deltaY = moveEvent.clientY - startY;
        if (!moved && Math.hypot(deltaX, deltaY) <= 5) return;
        if (!moved) {
          moved = true;
          this.#cameraFramingTarget = null;
          this.#viewport.classList.add("is-panning");
        }
        this.#camera.panX = origin.panX + deltaX;
        this.#camera.panY = origin.panY + deltaY;
        this.#requestCameraRender();
      };
      const finish = (endEvent: PointerEvent | null): void => {
        if (endEvent && endEvent.pointerId !== pointerId) return;
        this.#cancelCameraGesture = null;
        this.#window.removeEventListener("pointermove", onMove);
        this.#window.removeEventListener("pointerup", onEnd);
        this.#window.removeEventListener("pointercancel", onEnd);
        this.#viewport.classList.remove("is-panning");
        if (this.#cameraGesturePointerId === pointerId) this.#cameraGesturePointerId = null;
        if (clearsSelection && !moved && endEvent?.type === "pointerup") {
          this.clearActive();
        } else if (moved) {
          this.#commitChange();
        }
      };
      const onEnd = (endEvent: PointerEvent): void => finish(endEvent);
      this.#cancelCameraGesture = () => finish(null);
      this.#window.addEventListener("pointermove", onMove);
      this.#window.addEventListener("pointerup", onEnd);
      this.#window.addEventListener("pointercancel", onEnd);
    }, { signal: this.#abort.signal });

    this.#viewport.addEventListener("wheel", (event) => {
      const target = event.target as HTMLElement;
      const overWidget = Boolean(target.closest(".widget-instance"));
      if (overWidget && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      if (this.#navigationModel === "design-tool") {
        if (event.ctrlKey || event.metaKey) {
          // A trackpad pinch arrives as a wheel event with ctrlKey — the
          // same branch serves pinch and ctrl/cmd+wheel, continuously,
          // anchored on the pointer. The factor is the design's own number.
          const factor = Math.pow(0.9985, event.deltaY * 1.6);
          this.#zoomAtPoint(this.#camera.zoom * factor, event.clientX, event.clientY);
          return;
        }
        // Plain wheel pans (two-finger trackpad drag IS a wheel event);
        // shift turns a mouse's vertical wheel sideways.
        this.#stopCameraAnimation();
        this.#cameraFramingTarget = null;
        const sideways = event.shiftKey && event.deltaX === 0;
        this.#camera.panX -= sideways ? event.deltaY : event.deltaX;
        this.#camera.panY -= sideways ? 0 : event.deltaY;
        this.#requestCameraRender();
        this.#scheduleChange();
        return;
      }
      const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
      this.#zoomAtPoint(this.#camera.zoom * factor, event.clientX, event.clientY);
    }, { passive: false, signal: this.#abort.signal });

    // ksx: in the design-tool model right-drag pans, so the canvas
    // suppresses its context menu (the design's own rule).
    this.#viewport.addEventListener("contextmenu", (event) => {
      if (this.#navigationModel !== "design-tool") return;
      event.preventDefault();
    }, { signal: this.#abort.signal });

    // ksx: design-tool double-click — a widget enters focus; empty space
    // fits the workflow.
    this.#viewport.addEventListener("dblclick", (event) => {
      if (this.#navigationModel !== "design-tool") return;
      const target = event.target as HTMLElement;
      const widget = target.closest<HTMLElement>(".widget-instance");
      if (widget && this.#items.get(this.#itemId(widget)) === widget) {
        event.preventDefault();
        this.toggleFocusMode(widget);
        return;
      }
      if (target === this.#viewport || target === this.#stage) {
        event.preventDefault();
        this.fitAll();
      }
    }, { signal: this.#abort.signal });
  }

  #clearSpacePanState(): void {
    this.#spacePressed = false;
    this.#viewport.classList.remove("is-pan-ready", "is-panning");
    // The hand tool's persistent cursor comes back after a Space override.
    this.#viewport.classList.toggle("is-hand-tool", this.#toolMode === "hand");
  }

  /** ksx: which reading tier a zoom is in, with ±3% hysteresis keyed on the
   *  CURRENT tier so a camera resting on a boundary cannot flicker. */
  #tierFor(zoom: number): "overview" | "structure" | "editing" {
    const current = this.#zoomTier;
    const low = current === "overview"
      ? ZOOM_TIER_LOW + ZOOM_TIER_HYSTERESIS
      : ZOOM_TIER_LOW - ZOOM_TIER_HYSTERESIS;
    const high = current === "editing"
      ? ZOOM_TIER_HIGH - ZOOM_TIER_HYSTERESIS
      : ZOOM_TIER_HIGH + ZOOM_TIER_HYSTERESIS;
    if (zoom < low) return "overview";
    if (zoom < high) return "structure";
    return "editing";
  }

  /** ksx: the select/hand tool (design-tool model). A mode, not a held key
   *  — it survives blur, unlike Space. */
  setToolMode(mode: "select" | "hand"): void {
    if (this.#toolMode === mode) return;
    this.#toolMode = mode;
    this.#viewport.classList.toggle("is-hand-tool", mode === "hand");
    this.#onToolModeChange(mode);
  }

  toolMode(): "select" | "hand" {
    return this.#toolMode;
  }

  /** ksx: nudge every selected widget (design handoff — arrows move the
   *  selection 12px, shift-arrows 1px). One committed change per call. */
  moveSelectionBy(deltaX: number, deltaY: number): boolean {
    const selected = this.selectedItems();
    if (selected.length === 0) return false;
    for (const item of selected) {
      const state = this.getItemState(item);
      this.#moveItem(item, state.x + deltaX, state.y + deltaY);
    }
    this.#requestNavigatorRender();
    this.#commitChange();
    return true;
  }

  #cancelLostInputState(): void {
    this.#pointerFocusRevealBlocked = false;
    this.#clearSpacePanState();
    this.#cancelWidgetDragGesture?.();
    this.#cancelCameraGesture?.();
  }

  #bindNavigatorInteractions(): void {
    this.#navigatorItems.addEventListener("click", (event) => {
      const marker = event.target instanceof this.#window.Element
        ? event.target.closest<HTMLButtonElement>(".navigator-item")
        : null;
      const id = marker?.dataset.instanceId;
      const item = id ? this.#items.get(id) : undefined;
      if (!item) return;
      event.stopPropagation();
      this.focusItem(item);
    }, { signal: this.#abort.signal });
    this.#navigator.addEventListener("pointerdown", (event) => {
      if (
        event.button !== 0 ||
        (event.pointerType !== "" && !event.isPrimary) ||
        this.#cameraGesturePointerId !== null ||
        this.#widgetDragPointerId !== null ||
        (event.target as HTMLElement).closest(".navigator-item")
      ) return;
      event.preventDefault();
      const pointerId = event.pointerId;
      this.#cameraGesturePointerId = pointerId;
      this.#cameraFramingTarget = null;
      this.#viewport.classList.add("is-navigating");
      // The visible drawing area can sit below product chrome such as the
      // redesign's map header. Projection, hit-testing, markers, and the
      // camera rectangle must all use this same rectangle.
      const navigatorRect = this.#navigatorItems.getBoundingClientRect();
      const viewportRect = this.#viewport.getBoundingClientRect();
      // ksx: freeze the mapping for this gesture (see #navigatorBounds).
      const frozen = this.#navigatorBounds(viewportRect, navigatorRect);
      this.#navigatorGestureBounds = frozen
        ? {
          x: frozen.x,
          y: frozen.y,
          width: frozen.width,
          height: frozen.height,
          scale: frozen.scale,
        }
        : null;
      const panTo = (clientX: number, clientY: number): void => {
        const bounds = this.#navigatorBounds(viewportRect, navigatorRect);
        if (!bounds) return;
        const x = clamp(clientX - navigatorRect.left, 0, navigatorRect.width);
        const y = clamp(clientY - navigatorRect.top, 0, navigatorRect.height);
        const worldX = bounds.x + x / bounds.scale;
        const worldY = bounds.y + y / bounds.scale;
        this.#camera.panX = this.#safeViewportWidth(viewportRect.width) / 2 -
          worldX * this.#camera.zoom;
        this.#camera.panY = viewportRect.height / 2 - worldY * this.#camera.zoom;
        this.#requestCameraRender();
      };
      panTo(event.clientX, event.clientY);
      const onMove = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId === pointerId) panTo(moveEvent.clientX, moveEvent.clientY);
      };
      const finish = (endEvent: PointerEvent | null): void => {
        if (endEvent && endEvent.pointerId !== pointerId) return;
        this.#cancelCameraGesture = null;
        this.#window.removeEventListener("pointermove", onMove);
        this.#window.removeEventListener("pointerup", onEnd);
        this.#window.removeEventListener("pointercancel", onEnd);
        this.#viewport.classList.remove("is-navigating");
        if (this.#cameraGesturePointerId === pointerId) this.#cameraGesturePointerId = null;
        // ksx: the hand is off the map; let the bounds follow the canvas again.
        this.#navigatorGestureBounds = null;
        this.#requestNavigatorRender();
        this.#commitChange();
      };
      const onEnd = (endEvent: PointerEvent): void => finish(endEvent);
      this.#cancelCameraGesture = () => finish(null);
      this.#window.addEventListener("pointermove", onMove);
      this.#window.addEventListener("pointerup", onEnd);
      this.#window.addEventListener("pointercancel", onEnd);
    }, { signal: this.#abort.signal });
  }

  #zoomAtPoint(
    nextZoom: number,
    clientX: number,
    clientY: number,
    animate = false,
  ): void {
    this.#cameraFramingTarget = null;
    const rect = this.#viewport.getBoundingClientRect();
    const oldZoom = this.#camera.zoom;
    const zoom = clamp(nextZoom, this.#zoomMin, this.#zoomMax);
    if (zoom === oldZoom) return;
    const worldX = (clientX - rect.left - this.#camera.panX) / oldZoom;
    const worldY = (clientY - rect.top - this.#camera.panY) / oldZoom;
    this.#camera.zoom = zoom;
    this.#camera.panX = clientX - rect.left - worldX * zoom;
    this.#camera.panY = clientY - rect.top - worldY * zoom;
    if (animate) this.#animateCamera();
    else {
      this.#requestCameraRender();
      this.#scheduleChange();
    }
  }

  #animateCamera(
    framingTarget: CameraFramingTarget | null = null,
    requestedDuration?: number,
  ): void {
    this.#stopCameraAnimation();
    this.#cameraFramingTarget = framingTarget;
    this.#viewport.dataset.widgetNavigationReveal = framingTarget?.mode === "navigate"
      ? "active"
      : "idle";
    const reducedMotion = typeof this.#window.matchMedia === "function" &&
      this.#window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = requestedDuration ?? (
      framingTarget?.mode === "focus-item" || framingTarget?.mode === "focus-mode"
        ? FOCUS_CAMERA_ANIMATION_MS
        : CAMERA_ANIMATION_MS
    );
    this.#viewport.style.setProperty("--canvas-camera-duration", `${duration}ms`);

    const releaseVisualMotion = (): void => {
      this.#viewport.classList.remove("is-camera-animating");
      this.#updateItemVisibility();
      this.#requestNavigatorRender();
    };
    const finish = (): void => {
      this.#window.clearTimeout(this.#animationTimer);
      this.#animationTimer = 0;
      if (this.#animationEndListener) {
        this.#stage.removeEventListener("transitionend", this.#animationEndListener);
        this.#animationEndListener = null;
      }
      this.#cameraFramingTarget = null;
      this.#viewport.dataset.widgetNavigationReveal = "idle";
      releaseVisualMotion();
      this.#onCommit();
    };

    // The target camera is written before any visual tween. That is the
    // background-tab landing guarantee: even if the browser delivers no
    // animation frames, the inline transform is already exact. Reduced
    // motion skips the CSS state entirely, but a semantic framing target
    // remains alive through the same stabilization window so late runtime
    // measurements cannot change where the widget lands.
    if (reducedMotion) {
      this.#renderCameraNow();
      releaseVisualMotion();
      this.#scheduleChange();
      if (framingTarget) {
        this.#animationTimer = this.#window.setTimeout(
          finish,
          duration + CAMERA_ANIMATION_LANDING_PAD_MS,
        );
      } else {
        finish();
      }
      return;
    }
    this.#viewport.classList.add("is-camera-animating");
    this.#renderCameraNow();
    this.#animationEndListener = (event) => {
      if (event.target !== this.#stage || event.propertyName !== "transform") return;
      this.#stage.removeEventListener("transitionend", this.#animationEndListener!);
      this.#animationEndListener = null;
      // The interaction surface is live again exactly when the visible tween
      // lands. Framing metadata survives only through the 70ms stabilization
      // pad so late widget measurements can still correct the final camera.
      releaseVisualMotion();
    };
    this.#stage.addEventListener("transitionend", this.#animationEndListener);
    // Hidden/background documents may deliver no transition event. The
    // internal camera and inline transform are already exact; this fallback
    // releases transient interaction state even when rendering was throttled.
    this.#animationTimer = this.#window.setTimeout(
      finish,
      duration + CAMERA_ANIMATION_LANDING_PAD_MS,
    );
    this.#scheduleChange();
  }

  #stopCameraAnimation(): void {
    const wasAnimating = this.#viewport.classList.contains("is-camera-animating");
    this.#window.clearTimeout(this.#animationTimer);
    this.#animationTimer = 0;
    if (this.#animationEndListener) {
      this.#stage.removeEventListener("transitionend", this.#animationEndListener);
      this.#animationEndListener = null;
    }
    this.#cameraFramingTarget = null;
    this.#viewport.dataset.widgetNavigationReveal = "idle";
    this.#viewport.classList.remove("is-camera-animating");
    if (wasAnimating) {
      this.#updateItemVisibility();
      this.#requestNavigatorRender();
    }
  }

  #requestCameraRender(): void {
    this.#markCameraMoving();
    if (this.#cameraFrame) return;
    this.#cameraFrame = this.#window.requestAnimationFrame(() => {
      this.#cameraFrame = 0;
      this.#renderCamera();
    });
  }

  #renderCameraNow(): void {
    if (this.#cameraFrame) {
      this.#window.cancelAnimationFrame(this.#cameraFrame);
      this.#cameraFrame = 0;
    }
    this.#renderCamera();
  }

  #renderCamera(): void {
    this.#stage.style.transform =
      `translate(${this.#camera.panX}px, ${this.#camera.panY}px) scale(${this.#camera.zoom})`;
    if (this.#camera.zoom !== this.#renderedZoom) {
      this.#renderedZoom = this.#camera.zoom;
      this.#viewport.style.setProperty("--canvas-grid-size", `${28 * this.#camera.zoom}px`);
      const zoomPercentage = Math.round(this.#camera.zoom * 100);
      this.#zoomStatus.textContent = `${zoomPercentage}%`;
      if (this.#zoomStatus instanceof this.#window.HTMLButtonElement) {
        this.#zoomStatus.setAttribute(
          "aria-label",
          `Canvas zoom ${zoomPercentage}%; reset to 100%`,
        );
      }
      // ksx: the semantic-zoom channel (design handoff §4). Inline style
      // and a data-canvas-* attribute on the client-canvas viewport, so
      // both ride the SSR-parity exemption; the hysteresis lives HERE so
      // the attribute and any host label can never disagree at a boundary.
      this.#viewport.style.setProperty("--canvas-zoom", String(this.#camera.zoom));
      const tier = this.#tierFor(this.#camera.zoom);
      if (tier !== this.#zoomTier) {
        this.#zoomTier = tier;
        this.#viewport.dataset.canvasZoomTier = tier;
      }
      this.#onZoomChange(this.#camera.zoom, tier);
    }
    this.#viewport.style.setProperty("--canvas-grid-x", `${this.#camera.panX}px`);
    this.#viewport.style.setProperty("--canvas-grid-y", `${this.#camera.panY}px`);
    this.#updateItemVisibility();
    this.#requestNavigatorRender();
  }

  #markCameraMoving(): void {
    this.#viewport.classList.add("is-camera-moving");
    this.#window.clearTimeout(this.#cameraMotionTimer);
    this.#cameraMotionTimer = this.#window.setTimeout(() => {
      this.#cameraMotionTimer = 0;
      this.#viewport.classList.remove("is-camera-moving");
      this.#updateItemVisibility();
      this.#requestNavigatorRender();
    }, CAMERA_MOTION_SETTLE_MS);
  }

  #updateItemVisibility(): void {
    const viewportWidth = this.#viewport.clientWidth;
    const viewportHeight = this.#viewport.clientHeight;
    if (viewportWidth <= 0 || viewportHeight <= 0) return;

    const visible: WorldRect = {
      x: -this.#camera.panX / this.#camera.zoom,
      y: -this.#camera.panY / this.#camera.zoom,
      width: viewportWidth / this.#camera.zoom,
      height: viewportHeight / this.#camera.zoom,
    };
    const visibleCenterX = visible.x + visible.width / 2;
    const visibleCenterY = visible.y + visible.height / 2;
    const visibleHalfWidth = visible.width / 2;
    const visibleHalfHeight = visible.height / 2;
    const wakeMargin = VISIBILITY_WAKE_MARGIN_PX / this.#camera.zoom;
    const wakeZone: WorldRect = {
      x: visible.x - wakeMargin,
      y: visible.y - wakeMargin,
      width: visible.width + wakeMargin * 2,
      height: visible.height + wakeMargin * 2,
    };
    const parkMargin = VISIBILITY_PARK_MARGIN_PX / this.#camera.zoom;
    const parkZone: WorldRect = {
      x: visible.x - parkMargin,
      y: visible.y - parkMargin,
      width: visible.width + parkMargin * 2,
      height: visible.height + parkMargin * 2,
    };
    const deferNewParking = this.#viewport.classList.contains("is-camera-animating");
    const runtimeCandidates: RuntimeAdmissionCandidate[] = [];

    for (const [id, item] of this.#items) {
      const state = this.getItemState(item);
      const itemRect = scaledRect({
        x: state.x,
        y: state.y,
        width: state.width,
        height: state.height,
      }, state.manualScale);
      const visibleRatio = intersectionRatio(itemRect, visible);
      const insideWakeZone = intersectionRatio(itemRect, wakeZone) > 0;
      const insideParkZone = intersectionRatio(itemRect, parkZone) > 0;
      const wasParked = item.dataset.attentionState === "parked";
      const isDragging = item.classList.contains("is-dragging");
      const preserveAttention = item.classList.contains("is-active") || isDragging;
      let attentionState: RuntimeAdmissionCandidate["attentionState"] = visibleRatio >= 0.45
        ? "visible"
        : (wasParked ? insideWakeZone : insideParkZone)
          ? "edge"
          : "parked";
      if (deferNewParking && attentionState === "parked" && !wasParked) {
        attentionState = "edge";
      }
      if (isDragging && attentionState === "parked") attentionState = "edge";
      const normalizedX = Math.abs(itemRect.x + itemRect.width / 2 - visibleCenterX) /
        Math.max(1, visibleHalfWidth + itemRect.width / 2);
      const normalizedY = Math.abs(itemRect.y + itemRect.height / 2 - visibleCenterY) /
        Math.max(1, visibleHalfHeight + itemRect.height / 2);
      const distance = Math.hypot(normalizedX, normalizedY);
      const progress = clamp(
        (distance - DISTANCE_SCALE_START) / (DISTANCE_SCALE_END - DISTANCE_SCALE_START),
        0,
        1,
      );
      const eased = progress * progress * (3 - 2 * progress);
      const automaticScale = preserveAttention
        ? 1
        : 1 - (1 - DISTANCE_SCALE_MIN) * eased;
      const automaticOpacity = preserveAttention
        ? 1
        : 1 - (1 - DISTANCE_OPACITY_MIN) * eased;
      const scale = String(
        Math.round(
          clamp(state.manualScale * automaticScale, MIN_EFFECTIVE_SCALE, MAX_WIDGET_MANUAL_SCALE) *
            1000,
        ) / 1000,
      );
      const opacity = automaticOpacity.toFixed(3);
      const effectiveScale = Number(scale);
      if (!isDragging && !this.#viewport.classList.contains("is-camera-animating")) {
        this.#updateItemChromePlacement(item, state, visible, effectiveScale);
      }
      if (item.dataset.attentionState !== attentionState) {
        item.dataset.attentionState = attentionState;
      }
      const itemInert = attentionState === "parked" && id !== this.#activeId;
      if (item.inert !== itemInert) {
        item.inert = itemInert;
        if (id === this.#activeId) this.#syncNavigationFocusTargets();
      }
      if (item.dataset.attentionScale !== scale) {
        item.dataset.attentionScale = scale;
        item.style.setProperty("--widget-attention-scale", scale);
      }
      if (item.dataset.attentionOpacity !== opacity) {
        item.dataset.attentionOpacity = opacity;
        item.style.setProperty("--widget-attention-opacity", opacity);
      }
      let host = this.#runtimeHosts.get(id);
      if (attentionState !== "parked" && !host) {
        host = this.#restoreVirtualizedHost(id, item);
      }
      const focusInert = attentionState === "parked" ||
        Boolean(this.#focusSession && this.#focusSession.itemId !== id);
      if (host && host.inert !== focusInert) host.inert = focusInert;
      runtimeCandidates.push({
        id,
        item,
        host,
        attentionState,
        forced: isDragging,
        selected: item.classList.contains("is-active"),
        wasAdmitted: item.dataset.runtimeAdmission === "active",
        visibleRatio,
        distance,
        z: state.z,
      });
    }

    const cameraMoving = this.#viewport.classList.contains("is-camera-moving") ||
      this.#viewport.classList.contains("is-camera-animating") ||
      this.#viewport.classList.contains("is-panning") ||
      this.#viewport.classList.contains("is-navigating");
    const eligible = runtimeCandidates
      .filter((candidate) =>
        candidate.attentionState !== "parked" &&
        (
          !cameraMoving ||
          candidate.forced ||
          candidate.selected ||
          candidate.wasAdmitted ||
          candidate.host?.dataset.hydrationState === "hydrated"
        )
      )
      .sort(compareRuntimeAdmission);
    const admittedIds = new Set(
      eligible.slice(0, this.#maxActiveRuntimes).map((candidate) => candidate.id),
    );
    const now = this.#window.performance.now();
    let nextVirtualizationDelay = Number.POSITIVE_INFINITY;
    let activeCount = 0;
    let suspendedCount = 0;
    for (const candidate of runtimeCandidates) {
      const admitted = admittedIds.has(candidate.id);
      const admission = admitted ? "active" : "suspended";
      if (candidate.item.dataset.runtimeAdmission !== admission) {
        candidate.item.dataset.runtimeAdmission = admission;
        candidate.host?.setViewportActive(admitted);
      }

      let host = this.#runtimeHosts.get(candidate.id);
      if (!host || host.virtualizationPolicy() !== "restart_from_arguments") {
        if (!this.#virtualizedHosts.has(candidate.id)) {
          candidate.item.dataset.virtualizationState = "retained";
        }
        this.#parkedAt.delete(candidate.id);
      } else {
        candidate.item.dataset.virtualizationState = host.dataset.hydrationState === "hydrated"
          ? "resident"
          : "staged";
        const mayVirtualize = !admitted &&
          candidate.attentionState === "parked" &&
          !candidate.forced &&
          !candidate.selected &&
          candidate.distance >= VIRTUALIZATION_DISTANCE_THRESHOLD &&
          candidate.item.getAttribute("aria-busy") !== "true" &&
          host.dataset.hydrationState !== "empty";
        if (!mayVirtualize) {
          this.#parkedAt.delete(candidate.id);
        } else {
          const parkedAt = this.#parkedAt.get(candidate.id) ?? now;
          this.#parkedAt.set(candidate.id, parkedAt);
          const remaining = DEFAULT_VIRTUALIZATION_DWELL_MS - (now - parkedAt);
          if (!cameraMoving && remaining <= 0) {
            if (this.#virtualizeHost(candidate.id, candidate.item, host)) host = undefined;
            else this.#parkedAt.delete(candidate.id);
          } else {
            nextVirtualizationDelay = Math.min(
              nextVirtualizationDelay,
              cameraMoving && remaining <= 0 ? CAMERA_MOTION_SETTLE_MS : remaining,
            );
          }
        }
      }

      if (this.#virtualizedHosts.has(candidate.id)) {
        candidate.item.dataset.virtualizationState = "virtualized";
      }
      if (admitted) activeCount += 1;
      else if (host) suspendedCount += 1;
    }
    this.#armVirtualizationTimer(nextVirtualizationDelay);
    this.#runtimeActiveCount = activeCount;
    this.#runtimeSuspendedCount = suspendedCount;
    this.#viewport.dataset.runtimeActiveCount = String(activeCount);
    this.#viewport.dataset.runtimeSuspendedCount = String(suspendedCount);
    this.#viewport.dataset.runtimeVirtualizedCount = String(this.#virtualizedHosts.size);
    this.#notifyCapacityChange();
  }

  #virtualizeHost(id: string, item: HTMLElement, host: CanvasRuntimeHost): boolean {
    const descriptor = host.captureRestartDescriptor();
    if (!descriptor || host.parentElement !== item) return false;
    const placeholder = this.#document.createElement("div");
    placeholder.className = "forma-virtualized-placeholder";
    placeholder.setAttribute("aria-hidden", "true");
    this.#resizeObserver.unobserve(host);
    host.clear();
    host.replaceWith(placeholder);
    this.#runtimeHosts.delete(id);
    this.#virtualizedHosts.set(id, { descriptor, placeholder });
    this.#parkedAt.delete(id);
    item.dataset.virtualizationState = "virtualized";
    return true;
  }

  #restoreVirtualizedHost(id: string, item: HTMLElement): CanvasRuntimeHost | undefined {
    const virtualized = this.#virtualizedHosts.get(id);
    if (!virtualized) return undefined;
    const host = this.#runtimeAdapter.restoreHost(virtualized.descriptor, this.#document);
    if (virtualized.placeholder.parentElement === item) {
      virtualized.placeholder.replaceWith(host);
    } else {
      item.append(host);
    }
    this.#virtualizedHosts.delete(id);
    this.#parkedAt.delete(id);
    this.#runtimeHosts.set(id, host);
    this.#resizeObserver.observe(host);
    item.dataset.virtualizationState = "staged";
    return host;
  }

  #armVirtualizationTimer(delayMs: number): void {
    this.#window.clearTimeout(this.#virtualizationTimer);
    this.#virtualizationTimer = 0;
    if (!Number.isFinite(delayMs)) return;
    this.#virtualizationTimer = this.#window.setTimeout(() => {
      this.#virtualizationTimer = 0;
      this.#updateItemVisibility();
    }, Math.max(0, delayMs));
  }

  #requestVisibilityUpdate(): void {
    if (this.#deferredUpdates > 0) {
      this.#visibilityDirty = true;
      return;
    }
    this.#updateItemVisibility();
  }

  #queueTransientFrame(callback: () => void): number {
    let frame = 0;
    frame = this.#window.requestAnimationFrame(() => {
      this.#transientFrames.delete(frame);
      if (!this.#disposed) callback();
    });
    this.#transientFrames.add(frame);
    return frame;
  }

  #queueTransientTimeout(callback: () => void, delayMs: number): number {
    let timer = 0;
    timer = this.#window.setTimeout(() => {
      this.#transientTimers.delete(timer);
      if (!this.#disposed) callback();
    }, delayMs);
    this.#transientTimers.add(timer);
    return timer;
  }

  #navigatorBounds(
    viewport: DOMRectReadOnly = this.#viewport.getBoundingClientRect(),
    map: DOMRectReadOnly = this.#navigatorItems.getBoundingClientRect(),
  ): NavigatorProjection | null {
    const visible: WorldRect = {
      x: -this.#camera.panX / this.#camera.zoom,
      y: -this.#camera.panY / this.#camera.zoom,
      width: this.#safeViewportWidth(viewport.width) / this.#camera.zoom,
      height: viewport.height / this.#camera.zoom,
    };
    // ksx: the projection is FROZEN for the length of a navigator drag.
    // Upstream recomputes it every frame from the items unioned with the
    // live view — so dragging the map moved the view, which moved the
    // bounds, which moved the mapping the drag was being measured against.
    // That feedback is what made navigating by the map feel wild. The
    // bounds still follow the canvas everywhere else; they just hold still
    // while a hand is on them.
    if (this.#navigatorGestureBounds) {
      return { ...this.#navigatorGestureBounds, visible };
    }
    const itemBounds = unionRects(Array.from(this.#items.values(), (item) => {
      const state = this.getItemState(item);
      return scaledRect(state, state.manualScale);
    }));
    const combined = unionRects(itemBounds ? [itemBounds, visible] : [visible]);
    if (!combined) return null;
    const padded = {
      x: combined.x - WORLD_PADDING,
      y: combined.y - WORLD_PADDING,
      width: combined.width + WORLD_PADDING * 2,
      height: combined.height + WORLD_PADDING * 2,
    };
    const scale = Math.min(map.width / padded.width, map.height / padded.height);
    return { ...padded, scale: Math.max(scale, 0.0001), visible };
  }

  #createNavigatorMarker(item: HTMLElement): void {
    const id = this.#itemId(item);
    const marker = this.#document.createElement("button");
    marker.type = "button";
    marker.className = "navigator-item";
    marker.dataset.instanceId = id;
    marker.setAttribute("aria-label", `Focus ${item.dataset.widgetName ?? "widget"}`);
    marker.title = item.dataset.widgetName ?? "Widget";
    this.#navigatorMarkers.set(id, marker);
    this.#navigatorItems.append(marker);
  }

  #requestNavigatorRender(): void {
    if (this.#deferredUpdates > 0) {
      this.#navigatorDirty = true;
      return;
    }
    if (this.#navigatorFrame) return;
    this.#navigatorFrame = this.#window.requestAnimationFrame(() => {
      this.#navigatorFrame = 0;
      this.#renderNavigator();
    });
  }

  #renderNavigator(): void {
    const bounds = this.#navigatorBounds();
    if (!bounds) return;
    for (const item of this.#items.values()) {
      const state = this.getItemState(item);
      const effectiveScale = clamp(
        finiteNumber(Number(item.dataset.attentionScale), state.manualScale),
        MIN_EFFECTIVE_SCALE,
        MAX_WIDGET_MANUAL_SCALE,
      );
      const visual = scaledRect(state, effectiveScale);
      const marker = this.#navigatorMarkers.get(this.#itemId(item));
      if (!marker) continue;
      marker.classList.toggle("is-active", item.dataset.instanceId === this.#activeId);
      marker.dataset.attentionState = item.dataset.attentionState ?? "visible";
      marker.style.opacity = item.dataset.attentionOpacity ?? "1";
      marker.style.left = `${(visual.x - bounds.x) * bounds.scale}px`;
      marker.style.top = `${(visual.y - bounds.y) * bounds.scale}px`;
      marker.style.width = `${Math.max(5, visual.width * bounds.scale)}px`;
      marker.style.height = `${Math.max(4, visual.height * bounds.scale)}px`;
    }

    // ksx: the camera rectangle is CLAMPED to the map it is drawn on. The
    // projection letterboxes (one axis fits, the other has slack), and a view
    // wider than the world would otherwise paint a rectangle larger than the
    // box containing it — which reads as a rendering fault, not as "you are
    // seeing everything".
    const map = this.#navigatorItems.getBoundingClientRect();
    const navigator = this.#navigator.getBoundingClientRect();
    const offsetLeft = map.left - navigator.left;
    const offsetTop = map.top - navigator.top;
    const visible = bounds.visible;
    const left = clamp((visible.x - bounds.x) * bounds.scale, 0, Math.max(0, map.width));
    const top = clamp((visible.y - bounds.y) * bounds.scale, 0, Math.max(0, map.height));
    const width = clamp(visible.width * bounds.scale, 8, Math.max(8, map.width - left));
    const height = clamp(visible.height * bounds.scale, 6, Math.max(6, map.height - top));
    this.#navigatorViewport.style.left = `${offsetLeft + left}px`;
    this.#navigatorViewport.style.top = `${offsetTop + top}px`;
    this.#navigatorViewport.style.width = `${width}px`;
    this.#navigatorViewport.style.height = `${height}px`;
  }

  /** ksx: the bounded world, as a rect. */
  #worldRect(): WorldRect {
    return {
      x: this.#worldBounds.x ?? 0,
      y: this.#worldBounds.y ?? 0,
      width: this.#worldBounds.width,
      height: this.#worldBounds.height,
    };
  }

  /** ksx: a widget stays inside the world, whatever moved it. Its manual
   *  scale grows it around its own centre, so the room it needs is the
   *  SCALED box, not the declared one. The size comes in as an argument
   *  rather than off the element: at mount time the element carries no
   *  geometry yet, and reading it back would clamp against a default. */
  #clampToWorld(
    state: { width: number; height: number; manualScale: number },
    x: number,
    y: number,
  ): { x: number; y: number } {
    const world = this.#worldRect();
    const overhangX = (state.width * state.manualScale - state.width) / 2;
    const overhangY = (state.height * state.manualScale - state.height) / 2;
    // The rail is a RECT, not a size: its origin is usually far negative, so
    // the near edges sit nowhere near the arrangement.
    const minX = world.x + overhangX;
    const minY = world.y + overhangY;
    const maxX = world.x + world.width - state.width - overhangX;
    const maxY = world.y + world.height - state.height - overhangY;
    return {
      x: clamp(x, minX, Math.max(minX, maxX)),
      y: clamp(y, minY, Math.max(minY, maxY)),
    };
  }

  #scheduleChange(): void {
    if (this.#deferredUpdates > 0) {
      this.#changeDirty = true;
      return;
    }
    if (this.#changeFrame) return;
    this.#changeFrame = this.#window.requestAnimationFrame(() => {
      this.#changeFrame = 0;
      this.#onChange();
    });
  }

  /** Emits one durable boundary without leaving a second debounced save behind. */
  #commitChange(): void {
    if (this.#deferredUpdates > 0) {
      this.#changeDirty = true;
      return;
    }
    if (this.#changeFrame) {
      this.#window.cancelAnimationFrame(this.#changeFrame);
      this.#changeFrame = 0;
    }
    this.#changeDirty = false;
    this.#onCommit();
  }

  #notifyCapacityChange(): void {
    const snapshot = this.capacitySnapshot();
    const signature = [
      snapshot.total,
      snapshot.reserved,
      snapshot.maxItems,
      snapshot.runtimeActive,
      snapshot.runtimeSuspended,
      snapshot.maxActiveRuntimes,
    ].join(":");
    if (signature === this.#lastCapacitySignature) return;
    this.#lastCapacitySignature = signature;
    this.#onCapacityChange(snapshot);
  }

  #itemId(item: HTMLElement): string {
    const id = item.dataset.instanceId;
    if (!id) throw new Error("canvas item lacks data-instance-id");
    return id;
  }
}

function compareRuntimeAdmission(
  left: RuntimeAdmissionCandidate,
  right: RuntimeAdmissionCandidate,
): number {
  const attentionRank = (state: RuntimeAdmissionCandidate["attentionState"]): number =>
    state === "visible" ? 2 : state === "edge" ? 1 : 0;
  return Number(right.forced) - Number(left.forced) ||
    Number(right.selected) - Number(left.selected) ||
    attentionRank(right.attentionState) - attentionRank(left.attentionState) ||
    Number(right.wasAdmitted) - Number(left.wasAdmitted) ||
    right.visibleRatio - left.visibleRatio ||
    right.z - left.z ||
    left.distance - right.distance ||
    left.id.localeCompare(right.id);
}
