import { activateIslands } from "@getforma/core";
import { fetchJSON } from "@getforma/core/http";

// The compiler's island-first entry pattern (parseEntryPoint): the imported
// `*Page` component NOT in the activateIslands registry is the SSR root.
// NocturnePage never runs in the browser — esbuild tree-shakes it — but this
// import is what anchors IR emission. Do not remove it.
import { NocturnePage } from "./NocturnePage";
import {
  applyNocturne,
  applyNocturneUnreachable,
  NocturneIsland,
  nocturneWire,
  type NocturnePayload,
} from "./NocturneIsland";

void NocturnePage; // compile-time anchor only (see above)

/** Same cadence as every structure poller: the draft and the machine change
 *  on human actions, not at display rate. */
const POLL_MS = 2000;

async function poll(): Promise<void> {
  try {
    applyNocturne(await fetchJSON<NocturnePayload>("/api/nocturne"));
  } catch {
    applyNocturneUnreachable();
  }
}

/** The SOURCE payload the server embedded (render.rs `PAYLOAD_SCRIPT_ID`) —
 *  not the island's `props` argument, which carries the RENDERED SLOT VALUES.
 *  See status.ts for the longer note (dogfood ledger #8/#19). */
function embeddedPayload<T>(): T | null {
  const el = document.getElementById("__ksx-payload");
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent) as T;
  } catch {
    return null;
  }
}

// /nocturne carries one migrated REAL section (the keyboard pane — device
// pick, identify, split-or-freeze, prepared-for-play) beside the design
// proof's placeholder demos. Ledger #5 order: the served signals hold the
// server's values BEFORE the island tree builds, or adoption clobbers SSR.
activateIslands({
  NocturneIsland: (el) => {
    const seed = embeddedPayload<NocturnePayload>();
    if (seed) applyNocturne(seed);
    nocturneWire(el);
    window.setInterval(() => void poll(), POLL_MS);
    return NocturneIsland();
  },
});
