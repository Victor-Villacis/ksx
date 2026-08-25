import { NocturneIsland } from "./NocturneIsland";

// SSR anchor for /nocturne. DO NOT add createSignal calls here: a second
// declaration of an island signal renames the rendered slot to `#2` and the
// build fails on the collision. The island file owns all state.
export function NocturnePage() {
  return NocturneIsland();
}
