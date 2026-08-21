// The canvas's navigation controls, in a real browser.
//
// WHY THIS LEVEL: none of this exists server-side. The camera, the selection,
// a widget's manual scale and the map's markers are all browser state written
// by the vendored genui engine (studio-ui/src/genui/), and the only honest way
// to know a button still does what it claims is to press it and read the
// engine's own attributes back. The Rust tests can pin that the CONTROLS are
// served; only this can pin that they WORK.
//
// What each test here would have caught while it was being written:
//  - "Tidy up" silently doing nothing (an engine with no public placement API)
//  - the size readout drifting from the widget's real scale
//  - Escape not leaving focus mode unless the widget itself held focus, which
//    it never does right after you press a button
//  - the map rendering into detached nodes: markers exist, and clicking one
//    still selects, so the corner is not decoration
//
// Run: cargo build -p ksx-studio --example macro_fixture && npm test

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { chromium } from "playwright";
import { stopFixtureProcess } from "./fixture-process.mjs";

/** OUR port: never 4460 (a real `ksx studio`), and never another suite's. */
const PORT = Number(process.env.KSX_PWTEST_CANVAS_PORT ?? 4479);
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(repoRoot, "target");

let server;
let browser;

async function waitForServer(deadlineMs = 120_000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/map`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error(`fixture server never answered on ${BASE}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

before(async () => {
  const squatter = await fetch(`${BASE}/api/map`).then(
    () => true,
    () => false,
  );
  assert.equal(squatter, false, `something is already listening on ${BASE} — stop it first`);

  const built = spawnSync(
    "cargo",
    ["build", "--quiet", "-p", "ksx-studio", "--example", "macro_fixture"],
    { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
  );
  assert.equal(built.status, 0, "could not build the ksx-studio canvas fixture");
  const exe = path.join(
    targetDir,
    "debug",
    "examples",
    process.platform === "win32" ? "macro_fixture.exe" : "macro_fixture",
  );
  server = spawn(exe, [String(PORT)], { cwd: repoRoot, stdio: "ignore" });
  await waitForServer();
  browser = await chromium.launch();
});

after(async () => {
  try {
    await browser?.close();
  } finally {
    await stopFixtureProcess(server, "canvas fixture");
  }
});

/** A page whose canvas has finished adopting AND finished its opening camera
 *  move. Adoption lands in the island's post-mount frame — not a fixed
 *  distance behind hydration — so this waits for the engine's own geometry
 *  write rather than a delay, then lets the fit animation settle. */
async function openCanvas() {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    colorScheme: "dark",
  });
  const noise = [];
  page.on("pageerror", (error) => noise.push(`pageerror: ${error.stack ?? error}`));
  page.on("console", (message) => {
    if (message.type() === "error") noise.push(`console: ${message.text()}`);
  });
  page.ksxNoise = noise;
  await page.goto(`${BASE}/nocturne`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      document.querySelector('.n-canvas [data-instance-id="keyboard"]')?.dataset.canvasX !==
        undefined,
    null,
    { timeout: 20_000 },
  );
  await settle(page);
  return page;
}

/** The camera is still: no animation running, and none scheduled for the next
 *  frame either (fitAll arms its animation one frame after it is asked). */
async function settle(page) {
  for (let pass = 0; pass < 2; pass++) {
    await page.waitForFunction(() => !document.querySelector(".is-camera-animating"), null, {
      timeout: 20_000,
    });
    await page.waitForTimeout(250);
  }
}

const scaleOf = (page, id) =>
  page.evaluate(
    (instance) =>
      Number(document.querySelector(`[data-instance-id="${instance}"]`)?.dataset.canvasManualScale ?? 1),
    id,
  );

describe("the canvas navigation controls", () => {
  test("the selection group is empty-handed until something is selected", async () => {
    const page = await openCanvas();
    try {
      assert.equal((await page.textContent(".n-sel-name")).trim(), "Nothing selected");
      const allDisabled = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".n-selbar button")).every((b) => b.disabled),
      );
      assert.ok(allDisabled, "every control must be dead while nothing is selected");

      await page.click('[data-instance-id="pad-1"] .n-mini-head', { force: true });
      const name = (await page.textContent(".n-sel-name")).trim();
      assert.notEqual(name, "Nothing selected");
      assert.match(name, /P1/, "the group must name the widget it now points at");
      assert.equal(
        await page.evaluate(() => document.querySelector('.n-selbar [data-nx="w-zoom-in"]').disabled),
        false,
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("a widget grows, shrinks and resets, and the readout tells the truth", async () => {
    const page = await openCanvas();
    try {
      await page.click('[data-instance-id="pad-1"] .n-mini-head', { force: true });
      const start = await scaleOf(page, "pad-1");

      await page.click('.n-selbar [data-nx="w-zoom-in"]');
      const bigger = await scaleOf(page, "pad-1");
      assert.ok(bigger > start, `zoom in must grow the widget (${start} -> ${bigger})`);
      assert.equal(
        (await page.textContent(".n-selsize")).trim(),
        `${Math.round(bigger * 100)}%`,
        "the readout must be the widget's real scale, not a counter of its own",
      );

      await page.click('.n-selbar [data-nx="w-zoom-out"]');
      assert.ok(
        (await scaleOf(page, "pad-1")) < bigger,
        "zoom out must shrink what zoom in grew",
      );

      await page.click('.n-selbar [data-nx="w-zoom-in"]');
      await page.click('.n-selbar [data-nx="w-scale-reset"]');
      assert.equal(await scaleOf(page, "pad-1"), 1, "the readout button resets to 100%");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("focus mode spotlights one widget, and Escape leaves it from anywhere", async () => {
    const page = await openCanvas();
    try {
      await page.click('[data-instance-id="pad-1"] .n-mini-head', { force: true });
      await page.click('.n-selbar [data-nx="w-focus"]');
      await settle(page);
      assert.equal(
        await page.getAttribute('.n-selbar [data-nx="w-focus"]', "aria-pressed"),
        "true",
      );

      // Focus was entered by pressing a BUTTON, so the widget shell does not
      // hold focus — which is exactly the case the engine's own Escape
      // binding cannot serve.
      await page.keyboard.press("Escape");
      await settle(page);
      assert.equal(
        await page.getAttribute('.n-selbar [data-nx="w-focus"]', "aria-pressed"),
        "false",
        "Escape must leave focus mode no matter what holds keyboard focus",
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("the camera's own controls move it", async () => {
    const page = await openCanvas();
    try {
      // The readout IS the reset button: one control that says where the
      // zoom is and puts it back.
      const readout = () => page.textContent(".n-zoomval");
      const opening = await readout();

      await page.click('[data-nx="canvas-zoom-in"]');
      await settle(page);
      const zoomedIn = await readout();
      assert.notEqual(zoomedIn, opening, "zoom in must change the zoom");

      await page.click('[data-nx="canvas-zoom-reset"]');
      await settle(page);
      assert.equal((await readout()).trim(), "100%", "the 100% button is an absolute reset");

      await page.click('[data-nx="canvas-zoom-out"]');
      await settle(page);
      assert.notEqual((await readout()).trim(), "100%", "zoom out must move off 100%");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("Tidy up puts the board on top, the controllers in seat order, all in view", async () => {
    const page = await openCanvas();
    try {
      // Scatter first: a "tidy" that already matched the resting arrangement
      // would pass without doing anything at all.
      await page.evaluate(() => {
        document.querySelectorAll(".forma-canvas-stage .widget-instance").forEach((el, index) => {
          const x = 900 + index * 37;
          const y = 1200 - index * 53;
          el.style.left = `${x}px`;
          el.style.top = `${y}px`;
          el.dataset.canvasX = String(x);
          el.dataset.canvasY = String(y);
        });
      });

      await page.click('[data-nx="canvas-tidy"]');
      await settle(page);

      const layout = await page.evaluate(() => {
        const items = Array.from(
          document.querySelectorAll(".forma-canvas-stage .widget-instance"),
        ).map((el) => ({
          id: el.dataset.instanceId,
          x: Number(el.dataset.canvasX),
          y: Number(el.dataset.canvasY),
        }));
        const viewport = document.querySelector(".forma-canvas-viewport").getBoundingClientRect();
        const offscreen = Array.from(
          document.querySelectorAll(".forma-canvas-stage .widget-instance"),
        )
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            return (
              rect.left < viewport.left - 2 ||
              rect.right > viewport.right + 2 ||
              rect.top < viewport.top - 2 ||
              rect.bottom > viewport.bottom + 2
            );
          })
          .map((el) => el.dataset.instanceId);
        return {
          keyboard: items.find((item) => item.id === "keyboard"),
          pads: items.filter((item) => item.id !== "keyboard").sort((a, b) => a.x - b.x),
          offscreen,
        };
      });

      assert.ok(layout.keyboard, "the board is one of the widgets being arranged");
      assert.ok(
        layout.pads.every((pad) => pad.y > layout.keyboard.y),
        `the board sits above every controller (board ${layout.keyboard.y}, pads ${
          layout.pads.map((p) => p.y).join(", ")
        })`,
      );
      assert.equal(
        new Set(layout.pads.map((pad) => pad.y)).size,
        1,
        "two controllers that fit side by side share a row",
      );
      assert.deepEqual(
        layout.pads.map((pad) => pad.id),
        ["pad-1", "pad-2"],
        "controllers read left to right in seat order",
      );
      assert.deepEqual(layout.offscreen, [], "tidying also brings everything into view");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("Tidy up puts every widget back to 100%", async () => {
    const page = await openCanvas();
    try {
      await page.click('[data-instance-id="pad-1"] .n-mini-head', { force: true });
      await page.click('.n-selbar [data-nx="w-zoom-in"]');
      await page.click('.n-selbar [data-nx="w-zoom-in"]');
      assert.ok(
        (await scaleOf(page, "pad-1")) > 1,
        "the widget has to be off 100% for this test to mean anything",
      );

      await page.click('[data-nx="canvas-tidy"]');
      await settle(page);
      const scales = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".forma-canvas-stage .widget-instance")).map((el) =>
          Number(el.dataset.canvasManualScale ?? 1),
        ),
      );
      assert.deepEqual(
        scales.filter((scale) => scale !== 1),
        [],
        "tidying is a reset: an odd size in an even row is the untidiness it ends",
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("the canvas is bounded: a widget cannot be pushed out of the world", async () => {
    const page = await openCanvas();
    try {
      // Ask for a position far outside the world, the way a long drag or a
      // store written before the bound existed would.
      const landed = await page.evaluate(() => {
        const item = document.querySelector('[data-instance-id="pad-1"]');
        const handle = item.querySelector(".widget-drag-handle");
        const rect = handle.getBoundingClientRect();
        const down = (type, x, y) =>
          handle.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              pointerId: 1,
              isPrimary: true,
              button: 0,
              clientX: x,
              clientY: y,
            }),
          );
        down("pointerdown", rect.x + 8, rect.y + 8);
        down("pointermove", rect.x + 40_000, rect.y + 40_000);
        down("pointerup", rect.x + 40_000, rect.y + 40_000);
        return {
          x: Number(item.dataset.canvasX),
          y: Number(item.dataset.canvasY),
          width: Number(item.dataset.canvasWidth),
          height: Number(item.dataset.canvasHeight),
        };
      });
      // CANVAS_WORLD in NocturneIsland.ts: a runaway rail at -8000 spanning
      // 20 000, NOT a workspace edge. Widgets are bounded; the CAMERA
      // deliberately is not — see "you can look anywhere" below.
      assert.ok(
        landed.x + landed.width <= 12_000 + 1 && landed.y + landed.height <= 12_000 + 1,
        `a widget dragged 40 000px away is still on the rail (landed at ${landed.x}, ${landed.y})`,
      );
      // And the near edges are nowhere near the arrangement. A bound
      // anchored at (0, 0) put a wall 140px above the tidied board, which
      // is an invisible wall in the middle of an empty canvas — the exact
      // thing this rail must never feel like. Dragging up and left has to
      // sail through zero into negative coordinates.
      const upLeft = await page.evaluate(() => {
        const item = document.querySelector('[data-instance-id="pad-2"]');
        const handle = item.querySelector(".widget-drag-handle");
        const rect = handle.getBoundingClientRect();
        const send = (type, x, y) =>
          handle.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              pointerId: 2,
              isPrimary: true,
              button: 0,
              clientX: x,
              clientY: y,
            }),
          );
        send("pointerdown", rect.x + 8, rect.y + 8);
        send("pointermove", rect.x - 3000, rect.y - 3000);
        send("pointerup", rect.x - 3000, rect.y - 3000);
        return { x: Number(item.dataset.canvasX), y: Number(item.dataset.canvasY) };
      });
      assert.ok(
        upLeft.y < -500 && upLeft.x < -500,
        `a widget dragged up and left goes past zero, not into a wall (${
          JSON.stringify(upLeft)
        })`,
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("you can look anywhere: the view is never caged", async () => {
    const page = await openCanvas();
    try {
      const camera = () =>
        page.evaluate(() => {
          const parsed =
            /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(
              document.querySelector(".forma-canvas-stage").style.transform,
            ) ?? [];
          return { panX: Number(parsed[1] ?? 0), panY: Number(parsed[2] ?? 0) };
        });

      // Pan hard past the top-left of everything, the way you would to put
      // the arrangement in the middle of the screen. Caging the camera made
      // exactly this impossible, and it read as a broken app.
      const before = await camera();
      await page.keyboard.press("Tab");
      await page.evaluate(() => document.querySelector(".forma-canvas-viewport").focus());
      for (let press = 0; press < 25; press++) {
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowDown");
      }
      await settle(page);
      const after = await camera();
      assert.ok(
        after.panX < before.panX - 500 && after.panY < before.panY - 500,
        `panning keeps going past the content (${JSON.stringify(before)} -> ${
          JSON.stringify(after)
        })`,
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("dragging the map moves the view with it, without fighting back", async () => {
    const page = await openCanvas();
    try {
      const map = await page.locator(".forma-canvas-navigator").boundingBox();
      const readRect = () =>
        page.evaluate(() => {
          const rect = document
            .querySelector(".forma-canvas-navigator-viewport")
            .getBoundingClientRect();
          const parsed =
            /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(
              document.querySelector(".forma-canvas-stage").style.transform,
            ) ?? [];
          return { x: Math.round(rect.x), panX: Number(parsed[1] ?? 0) };
        });

      // Drag across the map toward its bottom-right corner, sampling as we
      // go. What this catches: the camera and the rectangle disagreeing —
      // the rectangle sliding on while the view has stopped, which is what
      // a clamped camera under an unclamped map looked like, and it read as
      // stuttering. Starts in empty map space: pressing a MARKER is a jump
      // to that widget, which is a different gesture entirely.
      // The map redraws on the next frame, so each sample waits for one —
      // otherwise this measures rAF scheduling, not whether the two agree.
      const frame = () =>
        page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
      const startX = map.x + 10;
      const startY = map.y + 10;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await frame();
      const samples = [await readRect()];
      for (let step = 1; step <= 10; step++) {
        await page.mouse.move(
          startX + (map.width - 20) * (step / 10),
          startY + (map.height - 20) * (step / 10),
        );
        await frame();
        samples.push(await readRect());
      }
      await page.mouse.up();

      await settle(page);
      const ended = await readRect();
      const first = samples[0];

      // Dragging right and down moves the view right and down (pan goes
      // more negative as the world slides left under a view moving right).
      assert.ok(
        ended.panX < first.panX,
        `the drag moved the view (${first.panX} -> ${ended.panX})`,
      );
      // And the rectangle went WITH it. The pathology this guards is the
      // two disagreeing — a rectangle that slides on while the view has
      // stopped, which is what a caged camera under an uncaged map did, and
      // which read as stuttering.
      assert.ok(
        ended.x > first.x,
        `the rectangle followed the view (${first.x} -> ${ended.x})`,
      );
      // Every sample was taken mid-drag with the mapping FROZEN, so the
      // rectangle only ever advanced — a mapping that re-scaled under the
      // gesture would have walked it backwards somewhere along the way.
      for (let index = 1; index < samples.length; index++) {
        assert.ok(
          samples[index].x >= samples[index - 1].x - 1,
          `the rectangle never doubles back mid-drag (step ${index}: ${
            JSON.stringify(samples[index - 1])
          } -> ${JSON.stringify(samples[index])})`,
        );
      }
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("the map hides and comes back, and comes back drawn", async () => {
    const page = await openCanvas();
    try {
      const markerCount = () =>
        page.evaluate(
          () => document.querySelectorAll(".forma-canvas-navigator .navigator-item").length,
        );
      assert.ok((await markerCount()) > 0, "the map starts shown");

      await page.click('[data-nx="canvas-map"]');
      assert.equal(await page.evaluate(() => document.querySelector(".forma-canvas-navigator").hidden), true);
      assert.equal(await page.getAttribute('[data-nx="canvas-map"]', "aria-pressed"), "false");

      await page.click('[data-nx="canvas-map"]');
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => document.querySelector(".forma-canvas-navigator").hidden), false);
      // A hidden map has no box to project onto, so this is the assertion
      // that catches it coming back blank.
      const drawn = await page.evaluate(() => {
        const rect = document.querySelector(".forma-canvas-navigator-viewport").getBoundingClientRect();
        const map = document.querySelector(".forma-canvas-navigator").getBoundingClientRect();
        return { rectW: rect.width, rectH: rect.height, mapW: map.width, mapH: map.height };
      });
      assert.ok(drawn.rectW > 0 && drawn.rectH > 0, "the camera rectangle is drawn again");
      assert.ok(
        drawn.rectW <= drawn.mapW + 1 && drawn.rectH <= drawn.mapH + 1,
        `the camera rectangle fits its map (${drawn.rectW}x${drawn.rectH} in ${drawn.mapW}x${drawn.mapH})`,
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("the camera rectangle never outgrows the map, even zoomed all the way out", async () => {
    const page = await openCanvas();
    try {
      for (let press = 0; press < 12; press++) {
        await page.click('[data-nx="canvas-zoom-out"]');
      }
      await settle(page);
      const fit = await page.evaluate(() => {
        const rect = document.querySelector(".forma-canvas-navigator-viewport").getBoundingClientRect();
        const map = document.querySelector(".forma-canvas-navigator").getBoundingClientRect();
        return {
          overflowX: Math.round(rect.right - map.right),
          overflowY: Math.round(rect.bottom - map.bottom),
          underflowX: Math.round(map.left - rect.left),
          underflowY: Math.round(map.top - rect.top),
        };
      });
      assert.ok(
        fit.overflowX <= 1 && fit.overflowY <= 1 && fit.underflowX <= 1 && fit.underflowY <= 1,
        `the rectangle stays inside the box it is drawn on (${JSON.stringify(fit)})`,
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("the map carries one marker per widget, and a marker selects it", async () => {
    const page = await openCanvas();
    try {
      const markers = await page.evaluate(
        () => document.querySelectorAll(".forma-canvas-navigator .navigator-item").length,
      );
      assert.equal(
        markers,
        await page.evaluate(
          () => document.querySelectorAll(".forma-canvas-stage .widget-instance").length,
        ),
        "the map must render into the DOCUMENT — a detached map has no markers",
      );

      const labels = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".forma-canvas-navigator .navigator-item")).map((el) =>
          el.getAttribute("aria-label"),
        ),
      );
      assert.ok(
        labels.every((label) => label && label.trim() !== ""),
        "every marker names the widget it stands for",
      );

      await page.click(".forma-canvas-navigator .navigator-item");
      await settle(page);
      assert.notEqual(
        (await page.textContent(".n-sel-name")).trim(),
        "Nothing selected",
        "clicking a marker jumps to that widget and selects it",
      );
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("an arrangement survives a reload", async () => {
    const page = await openCanvas();
    try {
      await page.click('[data-nx="canvas-tidy"]');
      await settle(page);
      const before = await page.evaluate(() => ({
        x: document.querySelector('[data-instance-id="keyboard"]').dataset.canvasX,
        y: document.querySelector('[data-instance-id="keyboard"]').dataset.canvasY,
        stored: JSON.parse(localStorage.getItem("ksx-nocturne-canvas") ?? "{}").widgets?.kb ?? null,
      }));
      assert.ok(before.stored, "the tidy must reach the store, not just the screen");

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () =>
          document.querySelector('.n-canvas [data-instance-id="keyboard"]')?.dataset.canvasX !==
            undefined,
        null,
        { timeout: 20_000 },
      );
      const after = await page.evaluate(() => ({
        x: document.querySelector('[data-instance-id="keyboard"]').dataset.canvasX,
        y: document.querySelector('[data-instance-id="keyboard"]').dataset.canvasY,
      }));
      assert.deepEqual(after, { x: before.x, y: before.y }, "the board came back where it was left");
    } finally {
      await page.close();
    }
  });
});
