import { activateIslands } from "@getforma/core";

// The compiler's island-first entry pattern (parseEntryPoint): the imported
// `*Page` component NOT in the activateIslands registry is the SSR root.
// RedesignPage never runs in the browser — esbuild tree-shakes it — but this
// import is what anchors IR emission. Do not remove it.
import { RedesignPage } from "./RedesignPage";
import {
  applyRedesign,
  initRedesignCanvas,
  RedesignIsland,
  redesignWire,
  type RedesignPayload,
} from "./RedesignIsland";

void RedesignPage; // compile-time anchor only (see above)

/** The SOURCE payload the server embedded (render.rs `PAYLOAD_SCRIPT_ID`) —
 *  not the island's `props` argument, which carries the RENDERED SLOT
 *  VALUES. See status.ts for the longer note (dogfood ledger #8/#19). */
function embeddedPayload<T>(): T | null {
  const el = document.getElementById("__ksx-payload");
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent) as T;
  } catch {
    return null;
  }
}

// Ledger #5 order: the served signals hold the server's values BEFORE the
// island tree builds, or adoption clobbers SSR. The canvas adopts on the
// next frame — the served skeleton exists only after the island mounts.
activateIslands({
  RedesignIsland: (el) => {
    const seed = embeddedPayload<RedesignPayload>();
    if (seed) applyRedesign(seed);
    redesignWire(el);
    window.requestAnimationFrame(() => {
      initRedesignCanvas(el);
    });
    return RedesignIsland();
  },
});
