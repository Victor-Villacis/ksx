import { h } from "@getforma/core";

interface WorkbenchToolLink {
  href: string;
  icon: string;
  title: string;
  detail: string;
}

interface WorkbenchCanvasAction {
  nx: "rd-back" | "rd-search" | "rd-keys";
  icon: string;
  title: string;
  detail: string;
}

export const REDESIGN_RAIL_PREFERENCES_MEDIA = "(width < 1440px)";

const WORKBENCH_CANVAS_ACTIONS: readonly WorkbenchCanvasAction[] = [
  {
    nx: "rd-search",
    icon: "⌕",
    title: "Search workbench",
    detail: "Find a widget or run a canvas command.",
  },
  {
    nx: "rd-keys",
    icon: "⌨",
    title: "Canvas shortcuts",
    detail: "Review navigation and editing keys.",
  },
];

const WORKBENCH_TOOLS: readonly WorkbenchToolLink[] = [
  {
    href: "/check",
    icon: "✓",
    title: "Input check",
    detail: "Verify saved bindings and live button input.",
  },
  {
    href: "/pads",
    icon: "◉",
    title: "Virtual pads",
    detail: "Inspect, test and recover controller outputs.",
  },
  {
    href: "/devices",
    icon: "⌁",
    title: "Device maintenance",
    detail: "Manage saved devices, claims and certificates.",
  },
  {
    href: "ms-settings:gaming-gamebar",
    icon: "⊞",
    title: "Windows capture recovery",
    detail: "Open Game Bar settings if Windows still owns a captured shortcut.",
  },
];

/**
 * The operational routes are deliberately separate from the workbench: each
 * can recover a broken machine even when the draft cannot load. This native
 * disclosure gives them one supported home without turning them into canvas
 * modes or requiring JavaScript just to reach them.
 */
export function redesignToolsDisclosure() {
  return h(
    "details",
    {
      class: "rd-utilityd",
      "data-rd-tools-menu": "",
    },
    h(
      "summary",
      {
        class: "rd-utility-sum",
        title: "Open verification and maintenance tools",
        "aria-label": "Open Studio tools",
      },
      h("span", { class: "rd-utility-icon", "aria-hidden": "true" }, "•••"),
      h("span", { class: "rd-utility-label" }, "Tools"),
    ),
    h(
      "nav",
      { class: "rd-utility-menu", "aria-label": "Studio tools" },
      h(
        "p",
        { class: "rd-utility-intro" },
        "Canvas commands, focused checks and machine recovery.",
      ),
      h("p", { class: "rd-utility-section rd-utility-canvas-section" }, "Canvas"),
      h(
        "button",
        {
          type: "button",
          class: "rd-utility-link rd-utility-action n-autobtn",
          "data-nx": "rd-back",
          hidden: "",
        },
        h("span", { class: "rd-utility-link-icon", "aria-hidden": "true" }, "↩"),
        h(
          "span",
          { class: "rd-utility-link-copy" },
          h("strong", null, "Back view"),
          h("span", null, "Return to the previous canvas view."),
        ),
        h("span", { class: "rd-utility-arrow", "aria-hidden": "true" }, "→"),
      ),
      ...WORKBENCH_CANVAS_ACTIONS.map((tool) =>
        h(
          "button",
          {
            type: "button",
            class: "rd-utility-link rd-utility-action n-autobtn",
            "data-nx": tool.nx,
          },
          h("span", { class: "rd-utility-link-icon", "aria-hidden": "true" }, tool.icon),
          h(
            "span",
            { class: "rd-utility-link-copy" },
            h("strong", null, tool.title),
            h("span", null, tool.detail),
          ),
          h("span", { class: "rd-utility-arrow", "aria-hidden": "true" }, "→"),
        ),
      ),
      h("p", { class: "rd-utility-section" }, "Diagnostics"),
      ...WORKBENCH_TOOLS.map((tool) =>
        h(
          "a",
          { class: "rd-utility-link", href: tool.href },
          h("span", { class: "rd-utility-link-icon", "aria-hidden": "true" }, tool.icon),
          h(
            "span",
            { class: "rd-utility-link-copy" },
            h("strong", null, tool.title),
            h("span", null, tool.detail),
          ),
          h("span", { class: "rd-utility-arrow", "aria-hidden": "true" }, "↗"),
        ),
      ),
    ),
  );
}

/** The compact copy is intentionally a separate literal template. Forma's
 * SSR compiler cannot prove a component argument is constant, and omitting
 * this class until hydration would leave the no-script breakpoint broken. */
export function redesignCompactToolsDisclosure() {
  return h(
    "details",
    {
      class: "rd-utilityd compact",
      "data-rd-tools-menu": "",
    },
    h(
      "summary",
      {
        class: "rd-utility-sum",
        title: "Open verification and maintenance tools",
        "aria-label": "Open Studio tools",
      },
      h("span", { class: "rd-utility-icon", "aria-hidden": "true" }, "•••"),
      h("span", { class: "rd-utility-label" }, "Tools"),
    ),
    h(
      "nav",
      { class: "rd-utility-menu", "aria-label": "Studio tools" },
      h(
        "p",
        { class: "rd-utility-intro" },
        "Canvas commands, focused checks and machine recovery.",
      ),
      h("p", { class: "rd-utility-section rd-utility-canvas-section" }, "Canvas"),
      h(
        "button",
        {
          type: "button",
          class: "rd-utility-link rd-utility-action n-autobtn",
          "data-nx": "rd-back",
          hidden: "",
        },
        h("span", { class: "rd-utility-link-icon", "aria-hidden": "true" }, "↩"),
        h(
          "span",
          { class: "rd-utility-link-copy" },
          h("strong", null, "Back view"),
          h("span", null, "Return to the previous canvas view."),
        ),
        h("span", { class: "rd-utility-arrow", "aria-hidden": "true" }, "→"),
      ),
      ...WORKBENCH_CANVAS_ACTIONS.map((tool) =>
        h(
          "button",
          {
            type: "button",
            class: "rd-utility-link rd-utility-action n-autobtn",
            "data-nx": tool.nx,
          },
          h("span", { class: "rd-utility-link-icon", "aria-hidden": "true" }, tool.icon),
          h(
            "span",
            { class: "rd-utility-link-copy" },
            h("strong", null, tool.title),
            h("span", null, tool.detail),
          ),
          h("span", { class: "rd-utility-arrow", "aria-hidden": "true" }, "→"),
        ),
      ),
      h("p", { class: "rd-utility-section" }, "Diagnostics"),
      ...WORKBENCH_TOOLS.map((tool) =>
        h(
          "a",
          { class: "rd-utility-link", href: tool.href },
          h("span", { class: "rd-utility-link-icon", "aria-hidden": "true" }, tool.icon),
          h(
            "span",
            { class: "rd-utility-link-copy" },
            h("strong", null, tool.title),
            h("span", null, tool.detail),
          ),
          h("span", { class: "rd-utility-arrow", "aria-hidden": "true" }, "↗"),
        ),
      ),
    ),
  );
}

function isRendered(element: HTMLElement): boolean {
  return element.getClientRects().length > 0;
}

/** Close both responsive copies and optionally restore the currently visible
 * entry point. Both copies coexist in the DOM so native no-JS navigation
 * survives; treating only the first match as state left a hidden disclosure
 * open when the viewport crossed the compact breakpoint. */
export function closeRedesignToolsDisclosure(root: HTMLElement, restoreFocus = false): boolean {
  const open = Array.from(
    root.querySelectorAll<HTMLDetailsElement>("[data-rd-tools-menu][open]"),
  );
  if (open.length === 0) return false;
  open.forEach((details) => {
    details.open = false;
  });
  if (restoreFocus) {
    const summaries = Array.from(
      root.querySelectorAll<HTMLElement>("[data-rd-tools-menu] > summary"),
    );
    const target = summaries.find(isRendered) ??
      Array.from(root.querySelectorAll<HTMLElement>(".rd-profile-sum")).find(isRendered);
    target?.focus({ preventScroll: true });
  }
  return true;
}

const wiredRoots = new WeakSet<HTMLElement>();

/** Keep the desktop and compact native disclosures one logical control. */
export function wireRedesignToolsDisclosures(root: HTMLElement): void {
  if (wiredRoots.has(root)) return;
  wiredRoots.add(root);
  let lastFocusedDisclosure: HTMLDetailsElement | null = null;
  root.ownerDocument.addEventListener(
    "focusin",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const owner = target.closest<HTMLDetailsElement>("[data-rd-tools-menu]");
      if (owner) {
        lastFocusedDisclosure = owner;
      } else if (target !== root.ownerDocument.body &&
                 target !== root.ownerDocument.documentElement) {
        // CSS can focus <body> just before the responsive change event. Keep
        // the outgoing owner through that transient state only.
        lastFocusedDisclosure = null;
      }
    },
    true,
  );
  root.ownerDocument.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest("[data-rd-tools-menu]")) {
        lastFocusedDisclosure = null;
      }
    },
    true,
  );
  root.addEventListener(
    "toggle",
    (event) => {
      const opened = event.target;
      if (!(opened instanceof HTMLDetailsElement) ||
          !opened.matches("[data-rd-tools-menu]") || !opened.open) return;
      root.querySelectorAll<HTMLDetailsElement>("[data-rd-tools-menu][open]").forEach(
        (peer) => {
          if (peer !== opened) peer.open = false;
        },
      );
    },
    true,
  );
  const compact = window.matchMedia(REDESIGN_RAIL_PREFERENCES_MEDIA);
  compact.addEventListener("change", (event) => {
    // Chromium moves focus to <body> as soon as CSS hides the outgoing
    // summary, before MediaQueryList dispatches `change`. The still-open
    // disclosure is therefore the durable proof that this breakpoint owns
    // the handoff; reading activeElement alone is already one event too late.
    const hadOpenDisclosure = Boolean(
      root.querySelector("[data-rd-tools-menu][open]"),
    );
    const active = document.activeElement;
    const ownedFocus = active instanceof Element && Boolean(active.closest("[data-rd-tools-menu]"));
    const rememberedFocus = Boolean(lastFocusedDisclosure?.isConnected);
    lastFocusedDisclosure = null;
    if (hadOpenDisclosure) closeRedesignToolsDisclosure(root);
    if (!ownedFocus && !rememberedFocus) return;

    // A media-query change is already observing the destination layout, but
    // `getClientRects()` can still report the outgoing copy for this event's
    // first style read. Choosing by the authoritative breakpoint prevents
    // focus from remaining on a disclosure that is about to become hidden.
    const target = event.matches
      ? root.querySelector<HTMLElement>(
          ".rd-utility-compact-home [data-rd-tools-menu] > .rd-utility-sum",
        )
      : root.querySelector<HTMLElement>(
          ".rd-utility-rail-home [data-rd-tools-menu] > .rd-utility-sum",
        );
    target?.focus({ preventScroll: true });
  });
}
