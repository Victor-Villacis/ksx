// Exact-source visual truth for persistent physical-keyboard canvas boards.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { chromium } from "playwright";
import { build } from "../node_modules/esbuild/lib/main.js";
import { keyboardSourceMappingRoutes } from "../src/redesign-keyboard-device.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = path.join(repoRoot, "studio-ui", "src", "redesign-keyboard-device.ts");
const stylesheet = path.join(repoRoot, "studio-ui", "src", "studio.css");

let browser;
let keyboardDeviceBundle;
let studioCss;

before(async () => {
  const built = await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    globalName: "KSXKeyboardDevice",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  keyboardDeviceBundle = built.outputFiles[0].text;
  studioCss = await readFile(stylesheet, "utf8");
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
});

describe("redesign keyboard exact-source legend", { concurrency: false }, () => {
  test("unrouted first-bind rows do not become visible source routes", () => {
    const controls = [{ function: "a", label: "A", keys: ["K"] }];
    const routes = keyboardSourceMappingRoutes([
      {
        slot: 1,
        sources: [{
          source_id: "usb:left",
          routed: true,
          mapping_available: true,
          controls,
          macros: [],
        }],
      },
      {
        slot: 2,
        sources: [{
          source_id: "usb:left",
          routed: false,
          mapping_available: true,
          controls,
          macros: [],
        }],
      },
      {
        slot: 3,
        sources: [{
          source_id: "usb:peer",
          routed: true,
          mapping_available: true,
          controls,
          macros: [],
        }],
      },
    ], "usb:left");

    assert.deepEqual(routes, [{ slot: 1, controls, macros: [] }]);
  });

  test("shows only this source's routed slots and computes its own stack badge", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <section id="surface">
          <div class="n-legend">
            ${[1, 2, 3, 4, 5, 6].map((slot) =>
              `<button data-slot="${slot}">P${slot}</button>`
            ).join("")}
            <span class="n-lgdmore"><span>5+</span></span>
          </div>
          <div class="n-kbcase">
            <button class="n-key" data-key="K">
              <span class="n-key-cap">K</span><span class="n-key-short"></span>
            </button>
          </div>
          <div class="n-kbtray none">
            <span class="n-kbtray-head"></span><div class="n-kbtray-row"></div>
          </div>
        </section>
      `);
      await page.addStyleTag({ content: studioCss });
      await page.addScriptTag({ content: keyboardDeviceBundle });

      const snapshots = await page.evaluate(() => {
        const surface = document.querySelector("#surface");
        const snapshot = () => ({
          legendHidden: surface.querySelector(".n-legend").hidden,
          legendDisplay: getComputedStyle(surface.querySelector(".n-legend")).display,
          visibleSlots: Array.from(surface.querySelectorAll("[data-slot]"))
            .filter((chip) =>
              !chip.hidden && getComputedStyle(chip).display !== "none" &&
              chip.getClientRects().length > 0
            )
            .map((chip) => Number(chip.dataset.slot)),
          hiddenSlotsAreAriaHidden: Array.from(surface.querySelectorAll("[data-slot]"))
            .filter((chip) => chip.hidden)
            .every((chip) => chip.getAttribute("aria-hidden") === "true"),
          moreHidden: surface.querySelector(".n-lgdmore").hidden,
          moreDisplay: getComputedStyle(surface.querySelector(".n-lgdmore")).display,
          moreClass: surface.querySelector(".n-lgdmore").className,
          keyClass: surface.querySelector('[data-key="K"]').className,
        });
        const route = (slot) => ({
          slot,
          controls: [{ function: "a", label: "A", keys: ["K"] }],
          macros: [],
        });
        const projection = (routes) => ({
          sourceLabel: "Exact test keyboard",
          selectedSlot: 1,
          routes,
        });

        KSXKeyboardDevice.syncKeyboardSourceMapping(surface, projection([]));
        const none = snapshot();
        KSXKeyboardDevice.syncKeyboardSourceMapping(surface, projection([route(2)]));
        const one = snapshot();
        KSXKeyboardDevice.syncKeyboardSourceMapping(
          surface,
          projection([1, 2, 3, 4, 5].map(route)),
        );
        const stacked = snapshot();
        KSXKeyboardDevice.syncKeyboardSourceMapping(surface, projection([route(6)]));
        const changed = snapshot();
        return { none, one, stacked, changed };
      });

      assert.deepEqual(snapshots.none, {
        legendHidden: true,
        legendDisplay: "none",
        visibleSlots: [],
        hiddenSlotsAreAriaHidden: true,
        moreHidden: true,
        moreDisplay: "none",
        moreClass: "n-lgdmore none",
        keyClass: "n-key",
      });
      assert.deepEqual(snapshots.one.visibleSlots, [2]);
      assert.equal(snapshots.one.legendHidden, false);
      assert.equal(snapshots.one.legendDisplay, "flex");
      assert.equal(snapshots.one.moreHidden, true);
      assert.equal(snapshots.one.moreDisplay, "none");
      assert.deepEqual(snapshots.stacked.visibleSlots, [1, 2, 3, 4, 5]);
      assert.equal(snapshots.stacked.moreHidden, false);
      assert.equal(snapshots.stacked.moreDisplay, "flex");
      assert.equal(snapshots.stacked.moreClass, "n-lgdmore");
      assert.match(snapshots.stacked.keyClass, /\bbstack\b/);
      assert.match(snapshots.stacked.keyClass, /\bbcount5\b/);
      assert.deepEqual(snapshots.changed.visibleSlots, [6]);
      assert.equal(snapshots.changed.moreHidden, true, "stale aggregate stack state is cleared");
      assert.equal(snapshots.changed.moreDisplay, "none");
      assert.doesNotMatch(snapshots.changed.keyClass, /\bbstack\b|\bbcount5\b/);
      assert.equal(await page.locator('[data-slot="1"]').isVisible(), false);
      assert.equal(await page.locator('[data-slot="6"]').isVisible(), true);
      assert.equal(await page.locator(".n-lgdmore").isVisible(), false);
    } finally {
      await page.close();
    }
  });
});
