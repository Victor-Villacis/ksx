import { activateIslands } from "@getforma/core";
import { fetchJSON } from "@getforma/core/http";

// The compiler's island-first entry pattern (parseEntryPoint): the imported
// `*Page` component NOT in the activateIslands registry is the SSR root.
// WorkspacePage never runs in the browser — esbuild tree-shakes it — but this
// import is what anchors IR emission. Do not remove it.
import { WorkspacePage } from "./WorkspacePage";
import {
  WorkspaceIsland,
  applyWorkspace,
  applyWorkspaceUnreachable,
  type WorkspacePayload,
} from "./WorkspaceIsland";

void WorkspacePage; // compile-time anchor only (see above)

/** Same cadence as every structure poller (status.ts): the draft and the
 *  session change on human actions, not at display rate. */
const POLL_MS = 2000;

async function poll(): Promise<void> {
  try {
    applyWorkspace(await fetchJSON<WorkspacePayload>("/api/workspace"));
  } catch {
    applyWorkspaceUnreachable();
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

activateIslands({
  // One island: the whole screen, seeded from the same WorkspacePayload JSON
  // that /api/workspace serves.
  //
  // Order matters (docs/FORMA-DOGFOOD.md finding #5): the signals MUST hold
  // the server's values BEFORE WorkspaceIsland() builds the descriptor tree —
  // adoption binds effects that immediately write signal state into the DOM,
  // so seeding after adoption would clobber the SSR text with defaults.
  WorkspaceIsland: () => {
    const seed = embeddedPayload<WorkspacePayload>();
    if (seed) applyWorkspace(seed);
    window.setInterval(() => void poll(), POLL_MS);
    return WorkspaceIsland();
  },
});
