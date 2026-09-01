import test from "node:test";
import assert from "node:assert/strict";

import {
  controllerRemoveAccessibleName,
  parkedControllerDiscardAccessibleName,
} from "../src/controller-accessible-names.ts";

test("destructive controller names carry the exact visible identity", () => {
  assert.equal(
    controllerRemoveAccessibleName("Player 2 · PlayStation"),
    "Remove Player 2 · PlayStation from the draft",
  );
  assert.equal(
    parkedControllerDiscardAccessibleName("No player · Xbox 360", "Player 3"),
    "Discard No player · Xbox 360 · Player 3",
  );
  assert.notEqual(
    controllerRemoveAccessibleName("Player 1 · Xbox 360"),
    controllerRemoveAccessibleName("Player 2 · Xbox 360"),
    "two icon-only remove buttons must never expose the same accessible name",
  );
});
