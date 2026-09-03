import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { build } from "../node_modules/esbuild/lib/main.js";
import { chromium } from "playwright";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const bundle = await build({
  stdin: {
    contents: 'export { createCanvasItem } from "../src/genui/canvas/canvas-item.ts";',
    resolveDir: path.join(repoRoot, "studio-ui", "pwtest"),
    sourcefile: "canvas-item-semantics-entry.ts",
  },
  bundle: true,
  format: "iife",
  globalName: "KsxCanvasItemSemantics",
  platform: "browser",
  target: "es2022",
  write: false,
});

test("canvas instances expose valid list-item semantics without an article landmark", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: bundle.outputFiles[0].text });

    const semantics = await page.evaluate(() => {
      const item = window.KsxCanvasItemSemantics.createCanvasItem({
        instanceId: "keyboard_usb_03f0_034a_00",
        displayName: "HP Elite USB Keyboard",
        preferredWidth: 640,
        minHeight: 260,
        chrome: false,
        document,
      });
      document.body.append(item);
      return {
        tagName: item.tagName,
        role: item.getAttribute("role"),
        label: item.getAttribute("aria-label"),
        instanceId: item.dataset.instanceId,
        preferredWidth: item.dataset.canvasPreferredWidth,
      };
    });

    assert.deepEqual(semantics, {
      tagName: "DIV",
      role: "listitem",
      label: "HP Elite USB Keyboard",
      instanceId: "keyboard_usb_03f0_034a_00",
      preferredWidth: "640",
    });
  } finally {
    await browser.close();
  }
});
