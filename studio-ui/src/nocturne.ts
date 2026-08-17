import { activateIslands } from "@getforma/core";

// The compiler's island-first entry pattern (parseEntryPoint): the imported
// `*Page` component NOT in the activateIslands registry is the SSR root.
// NocturnePage never runs in the browser — esbuild tree-shakes it — but this
// import is what anchors IR emission. Do not remove it.
import { NocturnePage } from "./NocturnePage";
import { NocturneIsland } from "./NocturneIsland";

void NocturnePage; // compile-time anchor only (see above)

// /nocturne is the design-proof route: placeholder data authored directly in
// the island, no payload script, no polling, no form wiring. Hydration still
// runs so the SSR/hydration parity gate exercises the tree.
activateIslands({
  NocturneIsland: () => NocturneIsland(),
});
