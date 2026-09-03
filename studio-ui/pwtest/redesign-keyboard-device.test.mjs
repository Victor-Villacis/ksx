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

  test("each physical board is one roving Tab stop and keeps its logical key through tray repaint", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <style>
          .n-kbrow, .n-kbtray-row { display: flex; gap: 8px; }
          button { width: 40px; height: 40px; }
        </style>
        <section id="template" data-rd-keyboard-surface-template-body>
          <div class="n-kbhead"><span class="n-kick">Template</span></div>
          <div class="n-kbcase">
            <div class="n-kbrow">
              <button class="n-key" data-key="Q" tabindex="0"><span class="n-key-cap">Q</span><span class="n-key-short"></span></button>
              <button class="n-key" data-key="W" tabindex="0"><span class="n-key-cap">W</span><span class="n-key-short"></span></button>
              <button class="n-key" data-key="E" tabindex="0"><span class="n-key-cap">E</span><span class="n-key-short"></span></button>
            </div>
            <div class="n-kbrow">
              <button class="n-key" data-key="A" tabindex="0"><span class="n-key-cap">A</span><span class="n-key-short"></span></button>
              <button class="n-key" data-key="S" tabindex="0"><span class="n-key-cap">S</span><span class="n-key-short"></span></button>
              <button class="n-key" data-key="D" tabindex="0"><span class="n-key-cap">D</span><span class="n-key-short"></span></button>
            </div>
          </div>
          <div class="n-kbtray none" hidden>
            <span class="n-kbtray-head"></span><div class="n-kbtray-row"></div>
          </div>
        </section>
        <div id="host"></div>
      `);
      await page.addScriptTag({ content: keyboardDeviceBundle });
      await page.evaluate(() => {
        const template = document.querySelector("#template");
        const surface = KSXKeyboardDevice.createKeyboardSurfaceInstance(template, {
          sourceId: "usb:test:one",
          instanceId: "keyboard-one",
          sourceLabel: "Test keyboard",
          mappingAvailable: true,
        });
        document.querySelector("#host").append(surface);
      });

      const surface = page.locator("[data-rd-keyboard-surface]");
      const roving = () => surface.locator('button[data-key][tabindex="0"]');
      assert.equal(await roving().count(), 1, "one key represents the board in sequential focus");
      assert.equal(await roving().getAttribute("data-key"), "Q");

      await surface.locator('[data-key="Q"]').focus();
      await page.keyboard.press("ArrowRight");
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("data-key")),
        "W",
        "horizontal arrows move within the physical row",
      );
      await page.keyboard.press("ArrowDown");
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("data-key")),
        "S",
        "vertical arrows choose the nearest key in the next row",
      );
      await page.keyboard.press("End");
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-key")), "D");
      await page.keyboard.press("Control+Home");
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-key")), "Q");
      assert.equal(await roving().count(), 1, "navigation never creates a second Tab stop");

      await page.evaluate(() => {
        const surface = document.querySelector("[data-rd-keyboard-surface]");
        KSXKeyboardDevice.syncKeyboardSourceMapping(surface, {
          sourceLabel: "Test keyboard",
          selectedSlot: 1,
          routes: [{
            slot: 1,
            controls: [{ function: "guide", label: "Guide", keys: ["F13"] }],
            macros: [],
          }],
        });
      });
      const firstTrayKey = surface.locator('.n-kbtray-row [data-key="F13"]');
      await firstTrayKey.focus();
      const oldTrayKey = await firstTrayKey.elementHandle();
      await page.evaluate(() => {
        const surface = document.querySelector("[data-rd-keyboard-surface]");
        KSXKeyboardDevice.syncKeyboardSourceMapping(surface, {
          sourceLabel: "Test keyboard",
          selectedSlot: 1,
          routes: [{
            slot: 1,
            controls: [{ function: "guide", label: "Guide", keys: ["F13"] }],
            macros: [],
          }],
        });
      });
      assert.equal(await oldTrayKey.evaluate((key) => key.isConnected), false, "the tray really repainted");
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("data-key")),
        "F13",
        "focus returns to the equivalent dynamic key",
      );
      assert.equal(await roving().count(), 1);
      assert.equal(await roving().getAttribute("data-key"), "F13");
    } finally {
      await page.close();
    }
  });
});
