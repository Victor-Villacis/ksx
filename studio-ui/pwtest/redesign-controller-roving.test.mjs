// Focused browser contract for the controller SVG composite. The full
// controller suite proves selection and mapper integration; this harness keeps
// spatial keyboard navigation deterministic and independent of canvas zoom.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { chromium } from "playwright";
import { build } from "../node_modules/esbuild/lib/main.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = path.join(repoRoot, "studio-ui", "src", "redesign-controllers.ts");

let browser;
let controllerBundle;

before(async () => {
  const built = await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    globalName: "KSXControllers",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  controllerBundle = built.outputFiles[0].text;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
});

test("each controller SVG is one roving Tab stop with contained spatial arrows", async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  try {
    await page.setContent(`
      <button id="before">Before</button>
      <div id="canvas">
        <svg id="one" viewBox="0 0 220 140" width="440" height="280" role="group">
          <rect data-rd-pad-action data-fn="left" x="10" y="10" width="40" height="40"></rect>
          <rect data-rd-pad-action data-fn="right" x="150" y="10" width="40" height="40"></rect>
          <rect data-rd-pad-action data-fn="down" x="150" y="90" width="40" height="40"></rect>
        </svg>
        <svg id="two" viewBox="0 0 220 140" width="440" height="280" role="group">
          <rect data-rd-pad-action data-fn="a" x="10" y="10" width="40" height="40"></rect>
          <rect data-rd-pad-action data-fn="b" x="150" y="10" width="40" height="40"></rect>
        </svg>
      </div>
      <button id="after">After</button>
    `);
    await page.addScriptTag({ content: controllerBundle });
    await page.evaluate(() => {
      for (const svg of document.querySelectorAll("svg")) {
        const controls = Array.from(svg.querySelectorAll("[data-rd-pad-action]"));
        for (const control of controls) control.setAttribute("role", "button");
        KSXControllers.installControllerRovingFocus(svg, controls);
      }
      window.__controllerArrowLeaks = 0;
      window.__controllerClick = null;
      document.querySelector("#canvas").addEventListener("keydown", (event) => {
        if (event.key.startsWith("Arrow")) window.__controllerArrowLeaks += 1;
      });
      document.addEventListener("click", (event) => {
        const control = event.target.closest?.("[data-rd-pad-action]");
        if (control) {
          window.__controllerClick = {
            fn: control.getAttribute("data-fn"),
            shift: event.shiftKey,
            detail: event.detail,
          };
        }
      });
    });

    for (const id of ["one", "two"]) {
      assert.equal(
        await page.locator(`#${id} [data-rd-pad-action][tabindex="0"]`).count(),
        1,
        `${id} contributes one sequential focus stop`,
      );
    }
    await page.locator("#before").focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-fn")), "left");
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("data-fn")),
      "a",
      "Tab leaves the first composite and enters the next controller once",
    );

    await page.locator('#one [data-fn="left"]').focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-fn")), "right");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-fn")), "down");
    await page.keyboard.press("ArrowRight");
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("data-fn")),
      "down",
      "an edge arrow stays inside the composite",
    );
    assert.equal(await page.evaluate(() => window.__controllerArrowLeaks), 0);
    assert.equal(await page.locator('#one [data-rd-pad-action][tabindex="0"]').count(), 1);
    assert.equal(
      await page.locator('#one [data-rd-pad-action][tabindex="0"]').getAttribute("data-fn"),
      "down",
    );

    await page.keyboard.press("Home");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-fn")), "left");
    await page.keyboard.press("End");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-fn")), "down");
    await page.locator('#one [data-fn="right"]').focus();
    assert.equal(
      await page.locator('#one [data-rd-pad-action][tabindex="0"]').getAttribute("data-fn"),
      "right",
      "programmatic focus becomes the composite return point",
    );
    await page.keyboard.press("Shift+Enter");
    assert.deepEqual(await page.evaluate(() => window.__controllerClick), {
      fn: "right",
      shift: true,
      detail: 0,
    });
  } finally {
    await page.close();
  }
});
