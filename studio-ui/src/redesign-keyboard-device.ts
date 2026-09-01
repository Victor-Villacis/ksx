/**
 * Physical-keyboard canvas surfaces.
 *
 * Every intentionally added keyboard owns one persistent DOM subtree. The
 * reactive island keeps a hidden blueprint because device canvas items are
 * client-authored, but a live surface is cloned only once and is never moved
 * between devices. Subsequent payloads reconcile attributes and text in
 * place, preserving focus, element identity, and browser state on peer
 * refresh/removal.
 */

export const KEYBOARD_SURFACE_ATTRIBUTE = "data-rd-keyboard-surface";
export const KEYBOARD_SURFACE_TEMPLATE_ATTRIBUTE = "data-rd-keyboard-surface-template";
export const KEYBOARD_SURFACE_TEMPLATE_BODY_ATTRIBUTE =
  "data-rd-keyboard-surface-template-body";
export const KEYBOARD_SURFACE_HOST_ATTRIBUTE = "data-rd-keyboard-surface-host";

export const KEYBOARD_SURFACE_SELECTOR = `[${KEYBOARD_SURFACE_ATTRIBUTE}]`;
export const KEYBOARD_SURFACE_TEMPLATE_BODY_SELECTOR =
  `[${KEYBOARD_SURFACE_TEMPLATE_BODY_ATTRIBUTE}]`;

export interface KeyboardSurfaceInstanceOptions {
  /** Exact backend selector. Never slug or canonicalize source identity. */
  sourceId: string;
  /** Collision-safe canvas instance id, used only to namespace DOM ids. */
  instanceId: string;
  sourceLabel: string;
  /** Temporary compatibility gate until bindings carry source identity. */
  mappingAvailable: boolean;
}

/** The persistent target placed inside each physical-keyboard canvas item. */
export function createKeyboardSurfaceHost(document: Document): HTMLElement {
  const host = document.createElement("div");
  host.className = "rd-keyboard-device-surface-host";
  host.setAttribute(KEYBOARD_SURFACE_HOST_ATTRIBUTE, "");
  return host;
}

const ID_REFERENCE_ATTRIBUTES = ["aria-controls", "aria-describedby", "aria-labelledby"];

function namespaceDomIds(root: HTMLElement, namespace: string): void {
  const ids = new Map<string, string>();
  for (const element of [root, ...Array.from(root.querySelectorAll<HTMLElement>("[id]"))]) {
    const previous = element.id;
    if (!previous) continue;
    const next = `${previous}--${namespace}`;
    ids.set(previous, next);
    element.id = next;
  }
  if (ids.size === 0) return;
  for (const element of [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]) {
    for (const attribute of ID_REFERENCE_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const rewritten = value
        .split(/\s+/)
        .map((token) => ids.get(token) ?? token)
        .join(" ");
      if (rewritten !== value) element.setAttribute(attribute, rewritten);
    }
  }
}

function mappingNeutralClassName(className: string): string {
  return className.replace(
    /\s+(?:bound|shared|bstack|bn\d+|bcount\d+|b[abcd]\d+)/g,
    "",
  );
}

function replaceNamespacedChildren(
  target: HTMLElement,
  source: HTMLElement,
  namespace: string,
): void {
  const clone = source.cloneNode(true) as HTMLElement;
  namespaceDomIds(clone, namespace);
  target.replaceChildren(...Array.from(clone.childNodes));
}

function syncKeyboardRows(
  surface: HTMLElement,
  template: HTMLElement,
  options: KeyboardSurfaceInstanceOptions,
): void {
  const sourceKeys = template.querySelectorAll<HTMLButtonElement>(".n-kbcase button[data-key]");
  const targetKeys = surface.querySelectorAll<HTMLButtonElement>(".n-kbcase button[data-key]");
  for (let index = 0; index < Math.min(sourceKeys.length, targetKeys.length); index += 1) {
    const source = sourceKeys[index];
    const target = targetKeys[index];
    const cap = target.querySelector<HTMLElement>(".n-key-cap")?.textContent ??
      target.dataset.key ?? "Key";
    target.className = options.mappingAvailable
      ? source.className
      : mappingNeutralClassName(source.className);
    const short = target.querySelector<HTMLElement>(".n-key-short");
    if (short) {
      short.textContent = options.mappingAvailable
        ? source.querySelector<HTMLElement>(".n-key-short")?.textContent ?? ""
        : "";
    }
    if (options.mappingAvailable) {
      target.title = source.title;
      target.setAttribute("aria-label", source.getAttribute("aria-label") ?? cap);
      target.removeAttribute("aria-disabled");
    } else {
      target.title = `${cap} on ${options.sourceLabel} — mapping is not available for this device yet`;
      target.setAttribute("aria-label", `${cap} on ${options.sourceLabel}`);
      target.setAttribute("aria-disabled", "true");
    }
  }
}

/** Create one independent surface. It is cloned once and remains owned by the
 * same device until that device is explicitly removed from the canvas. */
export function createKeyboardSurfaceInstance(
  template: HTMLElement,
  options: KeyboardSurfaceInstanceOptions,
): HTMLElement {
  const surface = template.cloneNode(true) as HTMLElement;
  surface.removeAttribute(KEYBOARD_SURFACE_TEMPLATE_BODY_ATTRIBUTE);
  surface.setAttribute(KEYBOARD_SURFACE_ATTRIBUTE, "");
  namespaceDomIds(surface, options.instanceId);
  syncKeyboardSurfaceInstance(surface, template, options);
  return surface;
}

/** Reconcile served presentation onto an existing device-owned surface.
 * Native key nodes are updated, never replaced, so focus cannot jump to a
 * peer when the server refreshes. */
export function syncKeyboardSurfaceInstance(
  surface: HTMLElement,
  template: HTMLElement,
  options: KeyboardSurfaceInstanceOptions,
): void {
  surface.dataset.sourceId = options.sourceId;
  surface.dataset.mappingAvailable = options.mappingAvailable ? "true" : "false";
  surface.setAttribute("role", "region");
  surface.setAttribute("aria-label", `${options.sourceLabel} keyboard`);
  const title = surface.querySelector<HTMLElement>(".n-kbhead > .n-kick");
  if (title) title.textContent = options.sourceLabel;
  syncKeyboardRows(surface, template, options);

  const tray = surface.querySelector<HTMLElement>(".n-kbtray");
  if (tray) tray.hidden = !options.mappingAvailable;
  const legend = surface.querySelector<HTMLElement>(".n-legend");
  const colors = surface.querySelector<HTMLElement>(".n-kbcolors");
  if (options.mappingAvailable) {
    const active = surface.ownerDocument.activeElement;
    if (legend) legend.hidden = false;
    if (colors) colors.hidden = false;
    const sourceLegend = template.querySelector<HTMLElement>(".n-legend");
    if (
      sourceLegend && legend && sourceLegend.textContent !== legend.textContent &&
      !legend.contains(active)
    ) {
      replaceNamespacedChildren(legend, sourceLegend, options.instanceId);
    }
    const sourceTray = template.querySelector<HTMLElement>(".n-kbtray");
    if (sourceTray && tray && !tray.contains(active)) {
      tray.className = sourceTray.className;
      replaceNamespacedChildren(tray, sourceTray, options.instanceId);
    }
  } else {
    if (legend) legend.hidden = true;
    if (colors) colors.hidden = true;
    surface.querySelector<HTMLElement>(".rd-keycue")?.classList.add("none");
  }
}
