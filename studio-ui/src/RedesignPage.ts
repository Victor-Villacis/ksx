import { RedesignIsland } from "./RedesignIsland";

// SSR anchor for /redesign. DO NOT add createSignal calls here: a second
// declaration of an island signal renames the rendered slot to `#2` and the
// build fails on the collision. The island file owns all state.
export function RedesignPage() {
  return RedesignIsland();
}
