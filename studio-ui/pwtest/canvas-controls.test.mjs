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

  test("every marker says which seat it is", async () => {
    const page = await openCanvas();
    try {
      const markers = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".forma-canvas-navigator .navigator-item")).map(
          (el) => ({
            id: el.dataset.instanceId,
            text: (el.textContent ?? "").trim(),
            title: el.getAttribute("title") ?? "",
            seatColoured: /\bnp\d+\b/.test(el.className),
          }),
        ),
      );
      assert.ok(markers.length >= 3, "the fixture stages a board and two controllers");
      const board = markers.find((marker) => marker.id === "keyboard");
      assert.equal(board?.text, "KB", "the board names itself on the map");
      for (const marker of markers.filter((m) => m.id !== "keyboard")) {
        assert.match(
          marker.text,
          /^P\d+$/,
          `a controller marker carries its seat (${marker.id} said "${marker.text}")`,
        );
        assert.ok(
          marker.seatColoured,
          `${marker.id} wears its seat colour, the same one the rack and badge use`,
        );
        assert.match(
          marker.title,
          /^P\d+ · /,
          `${marker.id}'s tooltip carries the full name the box has no room for`,
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
      assert.equal(
        await page.evaluate(() => document.querySelector(".n-mapshow").hidden),
        true,
        "and its stand-in stays out of the way while it is shown",
      );

      // The map's own × puts it away…
      await page.click(".n-mapclose");
      assert.equal(await page.evaluate(() => document.querySelector(".forma-canvas-navigator").hidden), true);
      // …and what brings it back is in the same corner, not in a bar at the
      // other end of the page.
      const corner = await page.evaluate(() => {
        const button = document.querySelector(".n-mapshow");
        const canvas = document.querySelector(".n-canvas");
        const b = button.getBoundingClientRect();
        const c = canvas.getBoundingClientRect();
        return {
          hidden: button.hidden,
          nearRight: c.right - b.right < 40,
          nearBottom: c.bottom - b.bottom < 40,
        };
      });
      assert.equal(corner.hidden, false, "the stand-in appears when the map goes away");
      assert.ok(corner.nearRight && corner.nearBottom, "and it sits in the bottom-right corner");

      await page.click(".n-mapshow");
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

  test("a ViGEm PlayStation seat wears hybrid DualShock 4 art and remembers its color", async () => {
    const page = await openCanvas();
    try {
      const readArt = () => page.evaluate(() => {
        const stage = document.querySelector(".forma-canvas-stage");
        const widgets = Array.from(stage?.querySelectorAll(".widget-instance") ?? []);
        const widget = widgets.find((el) => el.querySelector("svg.ds4premium"));
        if (!widget) return { found: false };
        const svg = widget.querySelector("svg.ds4premium");
        const shell = svg?.querySelector(".ds4premium-shell");
        const body = svg?.querySelector(".ds4premium-body");
        const depth = svg?.querySelector(".ds4premium-depth");
        const hooks = svg?.querySelector(".ds4premium-hooks");
        const group = widget.querySelector(
          '.n-ds4-variants[role="group"][aria-label="DualShock 4 color"]',
        );
        const buttons = Array.from(
          group?.querySelectorAll('button.n-ds4-variant[data-nx="ds4-variant"]') ?? [],
        );
        const hookShapes = Array.from(hooks?.querySelectorAll(".ds4premium-hook[data-fn]") ?? []);
        const depthShapes = Array.from(
          depth?.querySelectorAll(".ds4premium-depth-shadow[data-ds4-depth]") ?? [],
        );
        const geometryAttrs = [
          "d", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
          "width", "height", "points", "transform",
        ];
        const shapeGeometry = (el) => [
          el.tagName,
          ...geometryAttrs.map((name) => el.getAttribute(name) ?? ""),
        ].join("|");
        const allGroups = Array.from(
          stage?.querySelectorAll(
            '.n-ds4-variants[role="group"][aria-label="DualShock 4 color"]',
          ) ?? [],
        );
        const ds4Widgets = widgets.filter((el) => el.querySelector("svg.ds4premium"));
        const storeRaw = localStorage.getItem("ksx-nocturne-ds4-variants1");
        return {
          found: true,
          tag: svg?.tagName ?? null,
          hasImage: widget.querySelector("img") !== null,
          sourceIds: svg?.querySelectorAll("[id]").length ?? -1,
          privateEffects: svg?.querySelectorAll("defs, filter, mask, foreignObject, image").length ?? -1,
          effectReferences: svg?.querySelectorAll("[filter], [mask]").length ?? -1,
          variant: svg?.getAttribute("data-ds4-variant") ?? null,
          shellFill: shell ? getComputedStyle(shell).fill : "",
          viewBox: svg?.getAttribute("viewBox") ?? null,
          bodyPresent: !!body,
          depthInsideBody: !!body && !!depth && body.contains(depth),
          bodyBeforeHooks: !!body && !!hooks && Boolean(
            body.compareDocumentPosition(hooks) & Node.DOCUMENT_POSITION_FOLLOWING,
          ),
          hooksInsideArt: !!svg && !!hooks && svg.contains(hooks),
          hookLayerTag: hooks?.tagName ?? null,
          hooks: hookShapes.map((el) => el.getAttribute("data-fn")),
          hookGeometry: hookShapes.map((el) => [
            el.getAttribute("data-fn") ?? "",
            shapeGeometry(el),
          ].join("|")),
          nonEmptyHookCount: hookShapes.filter((el) => {
            const box = el.getBBox();
            return box.width > 0 && box.height > 0 && getComputedStyle(el).pointerEvents !== "none";
          }).length,
          depthShapeCount: depthShapes.length,
          depthNames: depthShapes.map((el) => el.getAttribute("data-ds4-depth")),
          depthGeometry: depthShapes.map(shapeGeometry),
          nonEmptyDepthCount: depthShapes.filter((el) => {
            const box = el.getBBox();
            return box.width > 0 && box.height > 0;
          }).length,
          interactiveDepthCount: depthShapes.filter(
            (el) => getComputedStyle(el).pointerEvents !== "none",
          ).length,
          depthFnCount: depth?.querySelectorAll("[data-fn]").length ?? -1,
          depthPrivateCount: depth?.querySelectorAll(
            "svg, defs, filter, mask, image, foreignObject, use, [id]",
          ).length ?? -1,
          filteredDescendantCount: Array.from(svg?.querySelectorAll("*") ?? []).filter(
            (el) => getComputedStyle(el).filter !== "none",
          ).length,
          dpadCapCount: svg?.querySelectorAll(".ds4premium-dpad-cap").length ?? -1,
          dpadSheenCount: svg?.querySelectorAll(".ds4premium-dpad-sheen").length ?? -1,
          faceRimCount: svg?.querySelectorAll(".ds4premium-face-rim").length ?? -1,
          stickRimCount: svg?.querySelectorAll(".ds4premium-stick-rim").length ?? -1,
          geometry: Array.from(
            svg?.querySelectorAll("g, path, circle, rect, ellipse, line, polyline, polygon") ?? [],
            shapeGeometry,
          ),
          groupCount: allGroups.length,
          ds4WidgetCount: ds4Widgets.length,
          misplacedGroupCount: allGroups.filter(
            (el) => !el.closest(".widget-instance")?.querySelector("svg.ds4premium"),
          ).length,
          buttonSlugs: buttons.map((el) => el.getAttribute("data-ds4-variant")),
          buttonLabels: buttons.map((el) => el.getAttribute("aria-label")),
          buttonTypes: buttons.map((el) => el.type),
          buttonPressed: buttons.map((el) => el.getAttribute("aria-pressed")),
          nativeButtonCount: buttons.filter((el) => el instanceof HTMLButtonElement).length,
          pressed: buttons.filter((el) => el.getAttribute("aria-pressed") === "true")
            .map((el) => el.getAttribute("data-ds4-variant")),
          widgetPosition: {
            x: widget.getAttribute("data-canvas-x"),
            y: widget.getAttribute("data-canvas-y"),
            transform: widget.style.transform,
          },
          storeRaw,
        };
      });

      const expectedSlugs = ["jet-black", "glacier-white", "magma-red", "midnight-blue"];
      const expectedHooks = [
        "a", "b", "x", "y",
        "dpad.up", "dpad.down", "dpad.left", "dpad.right",
        "lb", "rb", "lt", "rt",
        "back", "start", "guide",
        "lthumb", "rthumb",
        "lx.min", "lx.max", "ly.min", "ly.max",
        "rx.min", "rx.max", "ry.min", "ry.max",
      ];
      const initial = await readArt();

      assert.ok(initial.found, "the fixture's ViGEm PlayStation seat gets the hybrid DS4 master");
      assert.equal(initial.tag, "svg", "the controller is inline vector geometry");
      assert.equal(initial.hasImage, false, "no flat controller image is pasted into the canvas");
      assert.equal(initial.sourceIds, 0, "cloned source IDs cannot collide between controller widgets");
      assert.equal(initial.privateEffects, 0, "the clone carries no private defs, effects or images");
      assert.equal(initial.effectReferences, 0, "the clone carries no dangling filter or mask references");
      assert.ok(initial.bodyPresent, "the detailed source geometry remains a distinct body layer");
      assert.ok(initial.depthInsideBody, "the authored depth layer lives inside the pointerless body");
      assert.ok(initial.bodyBeforeHooks, "visual depth paints before the mapper hook overlay");
      assert.equal(initial.depthShapeCount, 18, "the depth pass keeps its exact authored shadow set");
      assert.equal(initial.nonEmptyDepthCount, 18, "every depth shape has visible geometry");
      assert.equal(initial.interactiveDepthCount, 0, "visual depth can never intercept mapping input");
      assert.equal(initial.depthFnCount, 0, "depth shapes never impersonate mapper controls");
      assert.equal(initial.depthPrivateCount, 0, "depth stays clone-safe inline vector geometry");
      assert.equal(initial.filteredDescendantCount, 0, "depth is explicit geometry, not a clipped filter");
      assert.equal(
        initial.depthNames.filter((name) => name?.startsWith("dpad-")).length,
        8,
        "all four D-pad petals receive contact and ambient shadows",
      );
      assert.equal(new Set(
        initial.depthNames.filter((name) => name?.startsWith("dpad-")),
      ).size, 8, "no D-pad shadow layer is duplicated");
      assert.equal(initial.dpadCapCount, 4, "every D-pad petal keeps its cap layer");
      assert.equal(initial.dpadSheenCount, 4, "every D-pad petal keeps its local sheen");
      assert.equal(initial.faceRimCount, 4, "every face button keeps its raised rim");
      assert.equal(initial.stickRimCount, 2, "both sticks keep their sculpted rim");
      assert.ok(initial.hooksInsideArt, "art and the interactive overlay share one SVG coordinate space");
      assert.equal(initial.hookLayerTag, "g", "hooks are an overlay group, not a second SVG");
      assert.equal(initial.hooks.length, 25, "the DS4 exposes exactly the mapper's 25 controls");
      assert.equal(new Set(initial.hooks).size, 25, "no mapping control is duplicated");
      assert.deepEqual([...initial.hooks].sort(), [...expectedHooks].sort());
      assert.equal(initial.nonEmptyHookCount, 25, "every hook has a real, interactive button-sized zone");

      assert.equal(initial.groupCount, initial.ds4WidgetCount, "each DS4 widget gets one color picker");
      assert.equal(initial.misplacedGroupCount, 0, "Xbox and DualSense widgets get no DS4 color picker");
      assert.deepEqual(initial.buttonSlugs, expectedSlugs, "all four authored finishes are available");
      assert.equal(initial.nativeButtonCount, 4, "the finish swatches are native keyboard-operable buttons");
      assert.ok(initial.buttonTypes.every((type) => type === "button"));
      assert.equal(initial.buttonPressed.filter((pressed) => pressed === "true").length, 1);
      assert.equal(initial.buttonPressed.filter((pressed) => pressed === "false").length, 3);
      assert.equal(new Set(initial.buttonLabels).size, 4, "every finish has its own accessible name");
      assert.ok(initial.buttonLabels.every(Boolean), "no color button is unnamed");
      assert.equal(initial.pressed.length, 1, "exactly one finish reports itself selected");
      assert.equal(initial.pressed[0], initial.variant, "the selected button and painted SVG agree");
      assert.ok(expectedSlugs.includes(initial.variant), "the initial finish is one of the four choices");
      assert.ok(
        initial.widgetPosition.x !== null && initial.widgetPosition.y !== null,
        "the mounted widget exposes a real canvas position before color changes",
      );

      const [clickedSlug, keyboardSlug] = expectedSlugs.filter((slug) => slug !== initial.variant);
      await page.click(
        `.n-ds4-variants button[data-ds4-variant="${clickedSlug}"]`,
      );
      await page.waitForFunction(
        (slug) => document.querySelector(
          ".forma-canvas-stage .widget-instance svg.ds4premium",
        )?.getAttribute("data-ds4-variant") === slug,
        clickedSlug,
      );
      const clicked = await readArt();
      assert.equal(clicked.variant, clickedSlug, "pointer selection repaints the controller");
      assert.deepEqual(clicked.pressed, [clickedSlug], "pointer selection updates aria-pressed");
      assert.notEqual(clicked.shellFill, initial.shellFill, "pointer selection changes computed shell paint");
      assert.deepEqual(clicked.geometry, initial.geometry, "a finish change cannot rewrite source geometry");
      assert.deepEqual(clicked.depthGeometry, initial.depthGeometry, "a finish change cannot move depth layers");
      assert.deepEqual(clicked.hookGeometry, initial.hookGeometry, "a finish change cannot move mapping zones");
      assert.deepEqual(clicked.widgetPosition, initial.widgetPosition, "a finish change cannot move the widget");
      assert.ok(clicked.storeRaw, "the selected finish is written to its own localStorage record");
      assert.ok(
        clicked.storeRaw.includes(JSON.stringify(clickedSlug)),
        "the DS4 finish record stores the pointer-selected slug",
      );

      const keyboardButton = page.locator(
        `.n-ds4-variants button[data-ds4-variant="${keyboardSlug}"]`,
      );
      await keyboardButton.focus();
      await page.keyboard.press("Space");
      await page.waitForFunction(
        (slug) => document.querySelector(
          ".forma-canvas-stage .widget-instance svg.ds4premium",
        )?.getAttribute("data-ds4-variant") === slug,
        keyboardSlug,
      );
      const keyboard = await readArt();
      assert.equal(keyboard.variant, keyboardSlug, "Space activates a focused finish button");
      assert.deepEqual(keyboard.pressed, [keyboardSlug], "keyboard selection updates aria-pressed");
      assert.notEqual(keyboard.shellFill, clicked.shellFill, "keyboard selection changes computed shell paint");
      assert.deepEqual(keyboard.geometry, initial.geometry, "keyboard selection leaves geometry untouched");
      assert.deepEqual(keyboard.depthGeometry, initial.depthGeometry, "keyboard selection leaves depth aligned");
      assert.deepEqual(keyboard.hookGeometry, initial.hookGeometry, "keyboard selection leaves hooks aligned");
      assert.deepEqual(keyboard.widgetPosition, initial.widgetPosition, "keyboard selection leaves the widget put");
      assert.ok(keyboard.storeRaw?.includes(JSON.stringify(keyboardSlug)));

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        (slug) => document.querySelector(
          ".forma-canvas-stage .widget-instance svg.ds4premium",
        )?.getAttribute("data-ds4-variant") === slug,
        keyboardSlug,
        { timeout: 20_000 },
      );
      await settle(page);
      const restored = await readArt();
      assert.equal(restored.variant, keyboardSlug, "the selected finish returns after reload");
      assert.deepEqual(restored.pressed, [keyboardSlug], "the restored button exposes selected state");
      assert.equal(restored.shellFill, keyboard.shellFill, "reload restores the same computed shell paint");
      assert.deepEqual(restored.geometry, initial.geometry, "restoring paint does not replace the SVG");
      assert.deepEqual(restored.depthGeometry, initial.depthGeometry, "restoring paint preserves vector depth");
      assert.deepEqual(restored.hookGeometry, initial.hookGeometry, "restored mapping zones stay aligned");
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      await page.close();
    }
  });

  test("a DualSense wears its own body, with its hooks on its buttons", async () => {
    // The fixture's roster is Xbox + PlayStation; stage a PS5 pad to see the
    // third art. (A DualSense drew a DualShock 4 until the family rule
    // stopped keying on `is_xinput`.)
    const staged = await fetch(`${BASE}/nocturne/controller`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "persona=dualsense&preset=Player%203",
      redirect: "manual",
    });
    assert.ok(staged.status >= 200 && staged.status < 400, `staging answered ${staged.status}`);

    const page = await openCanvas();
    try {
      const art = await page.evaluate(() => {
        const widget = Array.from(
          document.querySelectorAll(".forma-canvas-stage .widget-instance"),
        ).find((el) => el.querySelector(".ps5a"));
        if (!widget) return { found: false };
        const svg = widget.querySelector("svg.ps5a");
        const hooks = svg?.querySelector(".ps5a-hooks");
        const shell = svg?.querySelector(".ps5a-shell");
        const hookShapes = Array.from(svg?.querySelectorAll(".ps5a-hook") ?? []);
        return {
          found: true,
          tag: svg?.tagName ?? null,
          hasImage: widget.querySelector("img") !== null,
          viewBox: svg?.getAttribute("viewBox") ?? null,
          hooksInsideArt: !!svg && !!hooks && svg.contains(hooks),
          hookLayerTag: hooks?.tagName ?? null,
          transparentHookCount: hookShapes.filter(
            (el) => el.getAttribute("fill") === "transparent",
          ).length,
          bodyPaths: svg?.querySelectorAll(".ps5a-body path").length ?? 0,
          shellFill: shell ? getComputedStyle(shell).fill : "",
          hooks: Array.from(widget.querySelectorAll(".ps5a-hooks [data-fn]")).map(
            (el) => el.getAttribute("data-fn"),
          ),
        };
      });

      assert.ok(art.found, "a DualSense seat gets the PS5 art, not the DualShock");
      assert.equal(art.tag, "svg", "the controller is inline vector geometry");
      assert.equal(art.hasImage, false, "no product-shot image is pasted into the canvas");
      assert.equal(
        art.viewBox,
        "70 216 940 640",
        "art and hooks occupy one source-derived coordinate space",
      );
      assert.ok(art.hooksInsideArt, "the transparent hooks live inside the art SVG");
      assert.equal(art.hookLayerTag, "g", "hooks are an overlay group, not a second SVG box");
      assert.equal(art.transparentHookCount, 25, "every interactive hook starts transparent");
      assert.ok(art.bodyPaths >= 15, "the inline body carries source geometry, not a flat stand-in");
      assert.match(art.shellFill, /nxg-shell/, "the shell draws through the shared carbon paint");
      // Every control the mapper can actually drive has a hook. The
      // touchpad, the mic button and adaptive-trigger force are NOT here on
      // purpose: the binding vocabulary has no way to express them, and a
      // hook that binds to nothing is a promise the page cannot keep.
      for (const fn of [
        "a", "b", "x", "y",
        "dpad.up", "dpad.down", "dpad.left", "dpad.right",
        "lb", "rb", "lt", "rt",
        "back", "start", "guide",
        "lthumb", "rthumb",
        "lx.min", "lx.max", "ly.min", "ly.max",
        "rx.min", "rx.max", "ry.min", "ry.max",
      ]) {
        assert.ok(art.hooks.includes(fn), `the DualSense art hooks ${fn}`);
      }
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
