/**
 * One reactive keyboard surface, hosted by one physical-device canvas item.
 *
 * The board in RedesignIsland is Forma-owned: its keyed rows and dynamic text
 * must be created exactly once. Device items, by contrast, are imperative
 * canvas nodes. This seam moves the existing surface between those nodes; it
 * never clones, re-renders, or takes ownership of the board's reactive tree.
 */

export const KEYBOARD_SURFACE_ATTRIBUTE = "data-rd-keyboard-surface";
export const KEYBOARD_SURFACE_DEPOT_ATTRIBUTE = "data-rd-keyboard-surface-depot";
export const KEYBOARD_SURFACE_HOST_ATTRIBUTE = "data-rd-keyboard-surface-host";
export const KEYBOARD_SURFACE_ACTIVE_ATTRIBUTE = "data-rd-keyboard-surface-active";

export const KEYBOARD_SURFACE_SELECTOR = `[${KEYBOARD_SURFACE_ATTRIBUTE}]`;
export const KEYBOARD_SURFACE_DEPOT_SELECTOR = `[${KEYBOARD_SURFACE_DEPOT_ATTRIBUTE}]`;
export const KEYBOARD_SURFACE_HOST_SELECTOR = `[${KEYBOARD_SURFACE_HOST_ATTRIBUTE}]`;
export const KEYBOARD_SURFACE_ACTIVE_SELECTOR =
  `[${KEYBOARD_SURFACE_ACTIVE_ATTRIBUTE}="true"]`;

interface StatePreservingParent extends HTMLElement {
  /** Chromium's atomic DOM move, which preserves focus and element state. */
  moveBefore?: (node: Node, child: Node | null) => void;
}

export interface StatePreservingMoveResult {
  moved: boolean;
  focusWasInside: boolean;
  focusPreserved: boolean;
  usedStatePreservingMove: boolean;
}

/** Move an already-live subtree without throwing away its browser state.
 * Chromium's atomic move keeps focus natively; the fallback repairs focus for
 * older engines and sends it to a durable owner when the destination is a
 * hidden/inert depot. */
export function moveElementPreservingFocus(
  element: HTMLElement,
  target: HTMLElement,
  fallback: HTMLElement | null = null,
): StatePreservingMoveResult {
  if (element.ownerDocument !== target.ownerDocument) {
    throw new Error("move document mismatch");
  }
  if (element.parentElement === target) {
    return {
      moved: false,
      focusWasInside: false,
      focusPreserved: false,
      usedStatePreservingMove: false,
    };
  }

  const active = element.ownerDocument.activeElement;
  const focused = active instanceof HTMLElement && element.contains(active) ? active : null;
  const focusWasInside = focused !== null;
  const destinationUnavailable = target.closest(
    '[hidden],[inert],[aria-hidden="true"]',
  ) !== null;
  const durableFallback = fallback?.isConnected && !element.contains(fallback)
    ? fallback
    : null;
  // `moveBefore` deliberately preserves focus. That is desirable between two
  // visible device hosts, but wrong when parking a surface in its inert depot:
  // Chromium would otherwise leave `activeElement` inside content assistive
  // technology and pointer routing can no longer reach.
  if (focused && destinationUnavailable) {
    durableFallback?.focus({ preventScroll: true });
  }
  const movableTarget = target as StatePreservingParent;
  let usedStatePreservingMove = false;
  if (
    element.isConnected &&
    target.isConnected &&
    typeof movableTarget.moveBefore === "function"
  ) {
    movableTarget.moveBefore(element, null);
    usedStatePreservingMove = true;
  } else {
    target.append(element);
  }

  if (
    focused && !destinationUnavailable && focused.isConnected &&
    element.ownerDocument.activeElement !== focused
  ) {
    focused.focus({ preventScroll: true });
  }
  if (
    focused &&
    (destinationUnavailable || element.ownerDocument.activeElement !== focused) &&
    durableFallback
  ) {
    durableFallback.focus({ preventScroll: true });
  }
  return {
    moved: true,
    focusWasInside,
    focusPreserved: focusWasInside && !destinationUnavailable &&
      element.ownerDocument.activeElement === focused,
    usedStatePreservingMove,
  };
}

export interface KeyboardSurfaceReconcileOptions {
  surface: HTMLElement;
  depot: HTMLElement;
  owner: HTMLElement | null;
  scope?: ParentNode;
}

export interface KeyboardSurfaceReconcileResult {
  moved: boolean;
  previousOwner: HTMLElement | null;
  owner: HTMLElement | null;
  focusWasInside: boolean;
  focusPreserved: boolean;
  usedStatePreservingMove: boolean;
}

/** The empty target placed inside each physical-keyboard canvas item. */
export function createKeyboardSurfaceHost(document: Document): HTMLElement {
  const host = document.createElement("div");
  host.className = "rd-keyboard-device-surface-host";
  host.setAttribute(KEYBOARD_SURFACE_HOST_ATTRIBUTE, "");
  return host;
}

/** The canvas item currently containing the singleton, if it has one. */
export function keyboardSurfaceOwner(surface: HTMLElement): HTMLElement | null {
  return surface.closest<HTMLElement>(
    `.widget-instance[${KEYBOARD_SURFACE_ACTIVE_ATTRIBUTE}="true"]`,
  );
}

/** Put the singleton board in `owner`, or park it in `depot`. */
export function reconcileKeyboardDeviceSurface(
  options: KeyboardSurfaceReconcileOptions,
): KeyboardSurfaceReconcileResult {
  const { surface, depot, owner } = options;
  if (
    surface.ownerDocument !== depot.ownerDocument ||
    (owner && surface.ownerDocument !== owner.ownerDocument)
  ) {
    throw new Error("keyboard document mismatch");
  }

  const target = owner?.querySelector<HTMLElement>(KEYBOARD_SURFACE_HOST_SELECTOR) ?? depot;
  if (owner && target === depot) {
    throw new Error("missing keyboard host");
  }

  const previousOwner = surface.closest<HTMLElement>(".widget-instance");
  const scope = options.scope ?? surface.ownerDocument;
  for (const marked of Array.from(
    scope.querySelectorAll<HTMLElement>(KEYBOARD_SURFACE_ACTIVE_SELECTOR),
  )) {
    if (marked !== owner) marked.removeAttribute(KEYBOARD_SURFACE_ACTIVE_ATTRIBUTE);
  }
  if (previousOwner && previousOwner !== owner) {
    previousOwner.removeAttribute(KEYBOARD_SURFACE_ACTIVE_ATTRIBUTE);
  }
  if (owner) owner.setAttribute(KEYBOARD_SURFACE_ACTIVE_ATTRIBUTE, "true");

  if (surface.parentElement === target) {
    return {
      moved: false,
      previousOwner,
      owner,
      focusWasInside: false,
      focusPreserved: false,
      usedStatePreservingMove: false,
    };
  }

  const moved = moveElementPreservingFocus(surface, target, owner ?? previousOwner);

  return {
    moved: moved.moved,
    previousOwner,
    owner,
    focusWasInside: moved.focusWasInside,
    focusPreserved: moved.focusPreserved,
    usedStatePreservingMove: moved.usedStatePreservingMove,
  };
}
