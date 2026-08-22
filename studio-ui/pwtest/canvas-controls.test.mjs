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

  test("mapping paths project direct bindings, follow geometry, and remember their scope", async () => {
    const page = await openCanvas();
    try {
      const select = '[data-nx="mapping-paths"]';
      const lines = "#n-mapping-paths";
      const ports = "#n-mapping-ports";
      assert.equal(await page.inputValue(select), "off", "a fresh canvas stays quiet");
      assert.equal(await page.isHidden(lines), true, "the off lens draws no canvas layer");
      assert.equal(await page.getAttribute(lines, "aria-hidden"), "true");
      assert.equal(await page.getAttribute(lines, "focusable"), "false");
      assert.equal(await page.getAttribute(select, "id"), "n-mapping-path-scope");
      assert.equal(
        await page.getAttribute('label[for="n-mapping-path-scope"]', "class"),
        "n-pathctl-label",
        "the select has one explicit label rather than a wrapper shared with output",
      );

      const selectedSlot = await page.inputValue('input[name="slot"]');
      await page.selectOption(select, "selected");
      await page.waitForFunction(
        ({ lines, selectedSlot }) => {
          const edges = Array.from(document.querySelectorAll(`${lines} .n-flow-edge`));
          return edges.length === 14 &&
            edges.every((edge) => edge.dataset.flowSlot === selectedSlot) &&
            document.querySelector(lines)?.dataset.flowCount === "14";
        },
        { lines, selectedSlot },
      );
      await page.waitForFunction(
        (selectedSlot) =>
          document.querySelector(".n-live-sr")?.textContent ===
            `14 direct mapping paths shown for Player ${selectedSlot}.`,
        selectedSlot,
      );

      const truth = await page.evaluate(({ lines, ports, selectedSlot }) => {
        const edges = Array.from(document.querySelectorAll(`${lines} .n-flow-edge`));
        const gFanout = edges
          .filter((edge) => edge.dataset.flowKey === "G")
          .map((edge) => edge.dataset.flowFn)
          .sort();
        const badPaths = Array.from(document.querySelectorAll(`${lines} path`))
          .filter((path) => /NaN|Infinity/.test(path.getAttribute("d") ?? ""));
        const layer = document.querySelector(lines);
        const stage = document.querySelector(".forma-canvas-stage");
        return {
          gFanout,
          badPaths: badPaths.length,
          unresolved: document.querySelectorAll(`${lines} .is-unresolved`).length,
          pointerEvents: getComputedStyle(document.querySelector(ports)).pointerEvents,
          transformsMatch: layer.style.transform === stage.style.transform,
          selectedOnly: edges.every((edge) => edge.dataset.flowSlot === selectedSlot),
        };
      }, { lines, ports, selectedSlot });
      assert.deepEqual(truth.gFanout, ["a", "b"], "one physical G key truthfully fans out");
      assert.equal(truth.badPaths, 0);
      assert.equal(truth.unresolved, 0, "every fixture binding finds one visible endpoint");
      assert.equal(truth.pointerEvents, "none", "the lens never steals mapping gestures");
      assert.equal(truth.transformsMatch, true, "paths share the exact canvas camera");
      assert.equal(truth.selectedOnly, true);

      const minRestingContrast = await page.evaluate(() => {
        const root = document.querySelector(".nocturne");
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        const rgb = (color) => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = "#000";
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
        };
        const luminance = ([red, green, blue]) => {
          const channel = (value) => {
            const normalized = value / 255;
            return normalized <= 0.04045
              ? normalized / 12.92
              : ((normalized + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
        };
        const background = rgb("#191b28");
        const backgroundLuminance = luminance(background);
        for (let slot = 1; slot <= 16; slot += 1) {
          const edge = document.createElementNS("http://www.w3.org/2000/svg", "g");
          edge.classList.add("n-flow-edge");
          edge.style.setProperty("--n-flow-color", `var(--pcs${slot})`);
          const core = document.createElementNS("http://www.w3.org/2000/svg", "path");
          core.classList.add("n-flow-core");
          edge.append(core);
          svg.append(edge);
        }
        root.append(svg);
        // Re-read after connection so inherited player palette variables and
        // color-mix() are resolved in the same tree as the real canvas.
        const connectedContrasts = Array.from(svg.children).map((edge) => {
          const opacity = Number(getComputedStyle(edge).opacity);
          const stroke = rgb(getComputedStyle(edge.firstElementChild).stroke);
          const painted = stroke.map((channel, index) =>
            channel * opacity + background[index] * (1 - opacity));
          const foregroundLuminance = luminance(painted);
          return (Math.max(backgroundLuminance, foregroundLuminance) + 0.05) /
            (Math.min(backgroundLuminance, foregroundLuminance) + 0.05);
        });
        svg.remove();
        return Math.min(...connectedContrasts);
      });
      assert.ok(
        minRestingContrast >= 3,
        `all sixteen resting player cords must clear 3:1 (${minRestingContrast})`,
      );

      const source = `.n-widget-kb [data-key="G"]`;
      await page.hover(source);
      await page.waitForFunction(
        (lines) => document.querySelectorAll(`${lines} .n-flow-edge.is-related`).length === 2,
        lines,
      );
      assert.deepEqual(
        await page.evaluate((lines) =>
          Array.from(document.querySelectorAll(`${lines} .n-flow-edge.is-related`))
            .map((edge) => edge.dataset.flowFn)
            .sort(), lines),
        ["a", "b"],
        "endpoint inspection isolates every branch of the physical key",
      );

      const focusedTarget = 'details[data-fn="A"] > summary';
      await page.focus(focusedTarget);
      await page.hover('.n-widget-kb [data-key="W"]');
      await page.waitForFunction(
        (lines) => {
          const related = Array.from(document.querySelectorAll(`${lines} .n-flow-edge.is-related`));
          return related.length === 1 && related[0].dataset.flowKey === "W";
        },
        lines,
      );
      await page.hover(select);
      await page.waitForFunction(
        (lines) => {
          const related = Array.from(document.querySelectorAll(`${lines} .n-flow-edge.is-related`));
          return related.length === 2 && related.every((edge) => edge.dataset.flowFn === "a");
        },
        lines,
      );
      assert.equal(
        await page.evaluate(() => document.activeElement?.closest("[data-fn]")?.getAttribute("data-fn")),
        "A",
        "pointer inspection falls back to the still-focused endpoint",
      );

      const beforeMove = await page.getAttribute(
        `${lines} [data-flow-key="G"][data-flow-fn="a"] .n-flow-core`,
        "d",
      );
      await page.click(`[data-instance-id="pad-${selectedSlot}"] .n-mini-head`, { force: true });
      await page.focus(`[data-instance-id="pad-${selectedSlot}"] .widget-drag-handle`);
      assert.equal(
        await page.getAttribute(":focus", "class"),
        "widget-drag-handle",
        "the movement command owns focus before the keyboard nudge",
      );
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(
        ({ selector, beforeMove }) => document.querySelector(selector)?.getAttribute("d") !== beforeMove,
        {
          selector: `${lines} [data-flow-key="G"][data-flow-fn="a"] .n-flow-core`,
          beforeMove,
        },
      );
      assert.equal(
        await page.evaluate((lines) =>
          Array.from(document.querySelectorAll(`${lines} path`))
            .some((path) => /NaN|Infinity/.test(path.getAttribute("d") ?? "")), lines),
        false,
        "moving a controller leaves every curve finite",
      );

      await page.selectOption(select, "all");
      await page.waitForFunction(
        (lines) => document.querySelectorAll(`${lines} .n-flow-edge`).length === 28,
        lines,
      );
      assert.equal(
        await page.evaluate((lines) =>
          new Set(Array.from(document.querySelectorAll(`${lines} .n-flow-edge`))
            .map((edge) => edge.dataset.flowSlot)).size, lines),
        2,
        "the explicit all-player scope carries both staged players",
      );

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        (select) => document.querySelector(select)?.value === "all",
        select,
      );
      assert.equal(await page.inputValue(select), "all", "scope persists with canvas chrome");
      assert.equal(
        await page.evaluate((selector) => document.querySelector(selector)?.tabIndex, lines),
        -1,
        "the visual-only layer never enters tab order",
      );
      await page.selectOption(select, "off");
      await page.waitForFunction(
        ({ lines, ports }) =>
          document.querySelector(lines)?.hasAttribute("hidden") === true &&
          document.querySelector(ports)?.hasAttribute("hidden") === true &&
          document.querySelector(lines)?.dataset.flowCount === "0" &&
          document.querySelector(ports)?.dataset.flowCount === "0" &&
          (document.querySelector(".n-pathcount")?.textContent ?? "") === "",
        { lines, ports },
      );
      assert.equal(
        await page.getAttribute(".n-pathcount", "title"),
        "Mapping paths are off",
        "off mode clears the prior count and its stale tooltip",
      );

      await page.evaluate(() => {
        for (const selector of [".n-widget-kb", ".n-widget-keylab"]) {
          const item = document.querySelector(selector);
          if (item) item.style.visibility = "hidden";
        }
      });
      await page.selectOption(select, "selected");
      await page.waitForFunction(
        ({ lines, selectedSlot }) =>
          document.querySelector(lines)?.dataset.flowCount === "0" &&
          document.querySelector(lines)?.dataset.flowUnresolved === "14" &&
          document.querySelector(".n-live-sr")?.textContent ===
            `0 direct mapping paths shown for Player ${selectedSlot}; 14 paths have endpoints that are not visible.`,
        { lines, selectedSlot },
      );
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

  test("a newly added controller is selected, centered, and impossible to lose", async () => {
    const page = await openCanvas();
    let arrivingSlot = "";
    let beforeSlots = [];
    let cleaned = false;
    try {
      const beforeIds = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".n-widget-pad[data-instance-id]"), (item) =>
          item.getAttribute("data-instance-id")
        ).filter(Boolean)
      );
      beforeSlots = await page.evaluate(() =>
        Array.from(document.querySelectorAll("[data-slot-row]"), (row) =>
          row.getAttribute("data-slot-row")
        ).filter(Boolean)
      );

      // Leave the whole arrangement far behind first. A passing result must
      // be the arrival behavior, not a pad that happened to spawn on screen.
      await page.evaluate(() => document.querySelector(".forma-canvas-viewport").focus());
      for (let press = 0; press < 70; press++) {
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowDown");
      }
      await settle(page);
      const cameraBefore = await page.evaluate(() =>
        document.querySelector(".forma-canvas-stage").style.transform
      );

      // Duplicate is the shortest real add flow: the same POST, response,
      // poll and roster reconciliation as Create, with no test-only hook.
      await page.hover('[data-slot-row="1"]');
      await page.click(
        '[data-slot-row="1"] form[action="/nocturne/controller/duplicate"] button[type="submit"]',
      );
      await page.waitForFunction(
        (count) => document.querySelectorAll(".n-widget-pad[data-instance-id]").length === count + 1,
        beforeIds.length,
        { timeout: 20_000 },
      );
      await settle(page);

      const arrival = await page.evaluate(({ beforeIds, beforeSlots }) => {
        const priorIds = new Set(beforeIds);
        const priorSlots = new Set(beforeSlots);
        const item = Array.from(
          document.querySelectorAll(".n-widget-pad[data-instance-id]"),
        ).find((candidate) => !priorIds.has(candidate.getAttribute("data-instance-id")));
        const row = Array.from(document.querySelectorAll("[data-slot-row]")).find(
          (candidate) => !priorSlots.has(candidate.getAttribute("data-slot-row")),
        );
        const viewport = document.querySelector(".forma-canvas-viewport").getBoundingClientRect();
        const rect = item?.getBoundingClientRect();
        return {
          id: item?.getAttribute("data-instance-id") ?? "",
          slot: row?.getAttribute("data-slot-row") ?? "",
          active: item?.classList.contains("is-active") ?? false,
          current: item?.getAttribute("aria-current") ?? "",
          selection: document.querySelector(".n-sel-name")?.textContent?.trim() ?? "",
          camera: document.querySelector(".forma-canvas-stage")?.style.transform ?? "",
          inset: rect
            ? {
              left: rect.left - viewport.left,
              top: rect.top - viewport.top,
              right: viewport.right - rect.right,
              bottom: viewport.bottom - rect.bottom,
            }
            : null,
          centerDelta: rect
            ? {
              x: Math.abs((rect.left + rect.right) / 2 - (viewport.left + viewport.right) / 2),
              y: Math.abs((rect.top + rect.bottom) / 2 - (viewport.top + viewport.bottom) / 2),
            }
            : null,
        };
      }, { beforeIds, beforeSlots });
      arrivingSlot = arrival.slot;

      assert.ok(arrival.id, "the duplicate produces one new canvas widget");
      assert.ok(arrivingSlot, "the duplicate produces one new controller slot");
      assert.equal(arrival.active, true, "the arriving controller becomes the selected widget");
      assert.equal(arrival.current, "true", "the selected state is exposed accessibly");
      assert.match(arrival.selection, new RegExp(`P${arrivingSlot}\\b`));
      assert.notEqual(arrival.camera, cameraBefore, "the camera travels to the arriving controller");
      assert.ok(arrival.inset, "the arriving controller has measurable geometry");
      for (const [edge, inset] of Object.entries(arrival.inset)) {
        assert.ok(inset >= 20, `${edge} keeps a comfortable viewport gutter (${inset}px)`);
      }
      assert.ok(
        arrival.centerDelta.x <= 2 && arrival.centerDelta.y <= 2,
        `the arrival is centered (${JSON.stringify(arrival.centerDelta)})`,
      );

      await page.hover(`[data-slot-row="${arrivingSlot}"]`);
      await page.click(
        `[data-slot-row="${arrivingSlot}"] form[action="/nocturne/controller/remove"] button[type="submit"]`,
      );
      await page.waitForFunction(
        (count) => document.querySelectorAll(".n-widget-pad[data-instance-id]").length === count,
        beforeIds.length,
        { timeout: 20_000 },
      );
      cleaned = true;
      await page.click('[data-nx="canvas-fit"]');
      await settle(page);
      assert.deepEqual(page.ksxNoise, []);
    } finally {
      if (!cleaned) {
        const fallbackSlot = arrivingSlot || await page.evaluate((beforeSlots) => {
          const prior = new Set(beforeSlots);
          return Array.from(document.querySelectorAll("[data-slot-row]"), (row) =>
            row.getAttribute("data-slot-row")
          ).find((slot) => slot && !prior.has(slot)) ?? "";
        }, beforeSlots);
        if (fallbackSlot) {
          await fetch(`${BASE}/nocturne/controller/remove`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: `number=${encodeURIComponent(fallbackSlot)}`,
            redirect: "manual",
          });
        }
      }
      await page.close();
    }
  });

  test("keyboard finishes preserve ownership while Key Workbench builds a persistent leverless deck", async () => {
    const page = await openCanvas();
    const bindingPosts = [];
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      const pathname = new URL(request.url()).pathname;
      if (/\/(?:bind|learn)(?:\/|$)/.test(pathname)) bindingPosts.push(pathname);
    });

    const sourceSelector = ".n-widget-kb .n-kbcase .n-key[data-key]";
    const ownerClasses = (className) => className
      .split(/\s+/)
      .filter((name) =>
        name === "bound" ||
        name === "shared" ||
        name === "bstack" ||
        /^(?:bn|ba|bb|bc|bd|bcount)\d+$/.test(name)
      )
      .sort();
    const readKeyboard = () => page.evaluate((selector) => {
      const widget = document.querySelector(".n-widget-kb");
      const keyboardCase = widget?.querySelector(".n-kbcase");
      const sampleCap = widget?.querySelector('.n-key[data-key="Q"]');
      const caseRect = keyboardCase?.getBoundingClientRect();
      const scaleX = keyboardCase && caseRect ? caseRect.width / keyboardCase.offsetWidth : 1;
      const scaleY = keyboardCase && caseRect ? caseRect.height / keyboardCase.offsetHeight : 1;
      // Normalize through the canvas scale, then ignore sub-hundredth pixel
      // transform noise while still pinning every authored cap dimension.
      const round = (value) => Math.round(value * 100) / 100;
      const keys = Array.from(document.querySelectorAll(selector));
      const buttons = Array.from(document.querySelectorAll(".n-kbtheme"));
      return {
        theme: widget?.getAttribute("data-keyboard-theme") ?? null,
        paint: keyboardCase ? getComputedStyle(keyboardCase).backgroundImage : "",
        capPaint: sampleCap ? getComputedStyle(sampleCap, "::before").backgroundImage : "",
        source: keys.map((key) => {
          const rect = key.getBoundingClientRect();
          return {
            key: key.getAttribute("data-key") ?? "",
            className: key.className,
            rect: caseRect
              ? [
                  round((rect.left - caseRect.left) / scaleX),
                  round((rect.top - caseRect.top) / scaleY),
                  round(rect.width / scaleX),
                  round(rect.height / scaleY),
                ]
              : [],
          };
        }),
        buttons: buttons.map((button) => ({
          native: button instanceof HTMLButtonElement,
          type: button.type,
          label: button.getAttribute("aria-label") ?? "",
          slug: button.getAttribute("data-keyboard-theme") ?? "",
          pressed: button.getAttribute("aria-pressed"),
        })),
      };
    }, sourceSelector);
    const readDeck = () => page.evaluate(() => {
      const deck = document.querySelector(".n-widget-keylab .n-keylab-deck");
      const keys = Array.from(deck?.querySelectorAll(".n-deck-key[data-keylab-key]") ?? []);
      return {
        widgetCount: document.querySelectorAll(".n-widget-keylab").length,
        renderMode: deck?.getAttribute("data-render-mode") ?? null,
        layoutMode: deck?.getAttribute("data-layout-mode") ?? null,
        keycapProfile: deck?.getAttribute("data-keycap-profile") ?? null,
        keys: keys.map((key) => {
          const rect = key.getBoundingClientRect();
          const style = getComputedStyle(key);
          return {
            key: key.getAttribute("data-keylab-key") ?? "",
            canonicalKey: key.getAttribute("data-key") ?? "",
            token: key.getAttribute("data-keylab-token") ?? "",
            playerSlot: key.getAttribute("data-player-slot"),
            ownerSlots: key.getAttribute("data-owner-slots") ?? "",
            ownerBadges: Array.from(key.querySelectorAll(".n-keylab-owner")).map(
              (badge) => badge.getAttribute("data-owner-slot") ?? "",
            ),
            className: key.className,
            left: key.style.left,
            top: key.style.top,
            width: rect.width,
            height: rect.height,
            radius: style.borderTopLeftRadius,
            paint: style.backgroundImage,
          };
        }),
      };
    });
    const readSourceSemantics = () => page.evaluate(() => {
      const caps = Array.from(
        document.querySelectorAll(".n-widget-kb [data-key]:not(.ghost)"),
      );
      return {
        count: caps.length,
        roles: caps.map((cap) => cap.getAttribute("role")),
        tabStops: caps.filter((cap) => cap.tabIndex === 0)
          .map((cap) => cap.getAttribute("data-key")),
        negativeTabs: caps.filter((cap) => cap.tabIndex === -1).length,
        pressed: caps.filter((cap) => cap.getAttribute("aria-pressed") === "true")
          .map((cap) => cap.getAttribute("data-key")),
        invalidPressed: caps.filter((cap) => !["true", "false"].includes(
          cap.getAttribute("aria-pressed") ?? "",
        )).length,
      };
    });
    const persistedWorkbench = () => page.evaluate(() => {
      const raw = localStorage.getItem("ksx-nocturne-keyboard-workbench1");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return Object.values(parsed.devices ?? {})[0] ?? null;
    });

    try {
      const themeSlugs = [
        "carbon-forge",
        "lunar-shell",
        "violet-circuit",
        "glacier-current",
        "ghost-mint",
        "retro-terminal",
      ];
      const initial = await readKeyboard();
      assert.equal(initial.source.length, 108, "the standard board starts with all 108 served cells");
      assert.equal(initial.buttons.length, 6, "the keyboard exposes six restrained finish dashes");
      assert.ok(initial.buttons.every((button) => button.native), "every finish is a native button");
      assert.ok(initial.buttons.every((button) => button.type === "button"));
      assert.deepEqual(
        initial.buttons.map((button) => button.slug),
        themeSlugs,
        "the finish rail exposes the exact six app-owned materials",
      );
      assert.equal(new Set(initial.buttons.map((button) => button.label)).size, 6);
      assert.ok(initial.buttons.every((button) => button.label), "every finish has a unique name");
      assert.equal(
        initial.buttons.filter((button) => button.pressed === "true").length,
        1,
        "exactly one keyboard finish exposes selected state",
      );

      const themePaints = [];
      for (const slug of [
        "lunar-shell",
        "violet-circuit",
        "glacier-current",
        "ghost-mint",
        "retro-terminal",
        "carbon-forge",
      ]) {
        await page.click(`.n-kbtheme[data-keyboard-theme="${slug}"]`);
        await page.waitForFunction(
          (theme) => document.querySelector(".n-widget-kb")?.getAttribute(
            "data-keyboard-theme",
          ) === theme,
          slug,
        );
        await page.waitForTimeout(200);
        const themed = await readKeyboard();
        assert.deepEqual(
          themed.buttons
            .filter((button) => button.pressed === "true")
            .map((button) => button.slug),
          [slug],
          `${slug} is the sole selected finish`,
        );
        assert.deepEqual(
          themed.source.map((key) => key.key),
          initial.source.map((key) => key.key),
          `${slug} preserves canonical key order`,
        );
        assert.deepEqual(
          themed.source.map((key) => key.rect),
          initial.source.map((key) => key.rect),
          `${slug} cannot move or resize a source key`,
        );
        assert.deepEqual(
          themed.source.map((key) => ownerClasses(key.className)),
          initial.source.map((key) => ownerClasses(key.className)),
          `${slug} remains separate from every controller ownership band`,
        );
        themePaints.push({ slug, casePaint: themed.paint, capPaint: themed.capPaint });
      }
      assert.equal(
        new Set(themePaints.map((theme) => theme.casePaint)).size,
        themeSlugs.length,
        "all six materials have distinct case paint",
      );
      assert.equal(
        new Set(themePaints.map((theme) => theme.capPaint)).size,
        themeSlugs.length,
        "all six materials have distinct keycap paint",
      );

      await page.click('.n-kbtheme[data-keyboard-theme="lunar-shell"]');
      await page.waitForFunction(
        () => document.querySelector(".n-widget-kb")?.getAttribute("data-keyboard-theme") ===
          "lunar-shell",
      );
      await page.waitForTimeout(200);
      const lunar = await readKeyboard();

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.querySelector(".n-widget-kb")?.getAttribute("data-keyboard-theme") ===
          "lunar-shell",
        null,
        { timeout: 20_000 },
      );
      await settle(page);
      const restoredTheme = await readKeyboard();
      assert.equal(restoredTheme.paint, lunar.paint, "the selected material survives reload");
      assert.deepEqual(
        restoredTheme.buttons
          .filter((button) => button.pressed === "true")
          .map((button) => button.slug),
        ["lunar-shell"],
      );
      const legacyIdentity = await page.evaluate(() => {
        const storageKey = "ksx-nocturne-keyboard-workbench1";
        const current = JSON.parse(localStorage.getItem(storageKey) ?? "null");
        const identity = Object.keys(current?.devices ?? {})[0] ?? "";
        if (!identity) throw new Error("the fresh finish preference did not identify its keyboard");
        localStorage.setItem(storageKey, JSON.stringify({
          version: 1,
          devices: {
            [identity]: {
              open: false,
              sourceHidden: true,
              theme: "lunar-shell",
              capProfile: "typewriter",
              selectedKeys: [],
              layoutMode: "compact",
              renderMode: "arcade",
              positions: {},
            },
          },
        }));
        return identity;
      });
      assert.ok(legacyIdentity, "the legacy fixture targets the selected physical keyboard");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.querySelector(".n-widget-kb")?.getAttribute("data-keyboard-theme") ===
          "lunar-shell",
        null,
        { timeout: 20_000 },
      );
      await settle(page);
      assert.equal(
        await page.locator(".n-widget-keylab").count(),
        0,
        "the closed legacy board remains closed until Build board is requested",
      );
      await page.evaluate((selector) => {
        window.__ksxKeyboardSourceAudit = Array.from(document.querySelectorAll(selector)).map(
          (node) => ({ node, parent: node.parentElement, key: node.getAttribute("data-key") ?? "" }),
        );
      }, sourceSelector);

      await page.locator(".n-kbbuild").evaluate((button) => button.click());
      await page.waitForSelector(".n-widget-keylab");
      await settle(page);
      assert.equal(
        await page.locator(".n-widget-keylab").count(),
        1,
        "Build board mounts exactly one client-owned workbench widget",
      );
      assert.equal(
        await page.locator(sourceSelector).count(),
        108,
        "opening the workbench never reparents or removes source cells",
      );
      const migratedDeck = await readDeck();
      assert.equal(migratedDeck.renderMode, "keycap");
      assert.equal(migratedDeck.layoutMode, "compact");
      assert.equal(migratedDeck.keycapProfile, "sculpted");
      assert.deepEqual(
        await page.locator(
          '.n-widget-keylab [data-nx="keylab-render-keycap"], .n-widget-keylab [data-nx="keylab-render-arcade"]',
        ).evaluateAll((buttons) => buttons.map((button) => ({
          native: button instanceof HTMLButtonElement,
          type: button.type,
          mode: button.getAttribute("data-mode"),
          pressed: button.getAttribute("aria-pressed"),
        }))),
        [
          { native: true, type: "button", mode: "keycap", pressed: "true" },
          { native: true, type: "button", mode: "arcade", pressed: "false" },
        ],
        "a legacy Arcade preference opens on truthful Mechanical keycaps",
      );
      const capProfileSlugs = ["sculpted", "low-profile", "pudding", "typewriter"];
      const profileButtons = page.locator(
        '.n-widget-keylab [data-nx="keylab-cap-profile"][data-keycap-profile]',
      );
      assert.deepEqual(
        await profileButtons.evaluateAll((buttons) => buttons.map((button) => ({
          native: button instanceof HTMLButtonElement,
          type: button.type,
          slug: button.getAttribute("data-keycap-profile"),
          pressed: button.getAttribute("aria-pressed"),
        }))),
        capProfileSlugs.map((slug) => ({
          native: true,
          type: "button",
          slug,
          pressed: String(slug === "sculpted"),
        })),
        "fresh v2 defaults expose four native cap profiles with Sculpted selected",
      );
      assert.equal(
        await page.evaluate(() => JSON.parse(
          localStorage.getItem("ksx-nocturne-keyboard-workbench1") ?? "null",
        )?.version),
        2,
        "opening the migrated board rewrites it through the v2 store",
      );
      const propagatedTheme = await page.evaluate(() => {
        const keyboard = document.querySelector(".n-widget-kb");
        const workbench = document.querySelector(".n-widget-keylab");
        return {
          keyboardTheme: keyboard?.getAttribute("data-keyboard-theme"),
          workbenchTheme: workbench?.getAttribute("data-keyboard-theme"),
          keyboardCap: keyboard
            ? getComputedStyle(keyboard).getPropertyValue("--n-kb-key-face-top").trim()
            : "",
          workbenchCap: workbench
            ? getComputedStyle(workbench).getPropertyValue("--n-kb-key-face-top").trim()
            : "",
        };
      });
      assert.deepEqual(
        [propagatedTheme.keyboardTheme, propagatedTheme.workbenchTheme],
        ["lunar-shell", "lunar-shell"],
        "the physical keyboard and linked workbench share the selected material",
      );
      assert.equal(
        propagatedTheme.workbenchCap,
        propagatedTheme.keyboardCap,
        "the workbench inherits the same keycap paint variables",
      );
      const openSemantics = await readSourceSemantics();
      assert.ok(
        openSemantics.roles.every((role) => role === "button"),
        "build mode exposes every physical cap as a button",
      );
      assert.equal(openSemantics.tabStops.length, 1, "the source board has one roving tab stop");
      assert.equal(openSemantics.negativeTabs, openSemantics.count - 1);
      assert.deepEqual(openSemantics.pressed, []);
      assert.equal(openSemantics.invalidPressed, 0, "every source cap exposes pressed state");

      const liftedKeys = ["W", "A", "S", "D"];
      for (const key of liftedKeys) {
        const cap = page.locator(`.n-widget-kb .n-key[data-key="${key}"]`);
        await cap.focus();
        await page.keyboard.press("Enter");
      }
      await page.waitForFunction(
        () => document.querySelectorAll(".n-widget-keylab .n-deck-key").length === 4,
      );
      assert.equal(
        await page.locator(".n-widget-kb .n-key.extracted").count(),
        4,
        "four lifted caps leave four source sockets",
      );
      assert.equal(await page.locator(sourceSelector).count(), 108, "sockets retain the full layout");
      const extractedKeyboard = await readKeyboard();
      assert.deepEqual(
        extractedKeyboard.source.map((key) => key.key),
        restoredTheme.source.map((key) => key.key),
        "extraction preserves the source DOM order",
      );
      const maxSocketGeometryDrift = Math.max(...extractedKeyboard.source.flatMap(
        (key, index) => key.rect.map(
          (value, coordinate) => Math.abs(
            value - restoredTheme.source[index].rect[coordinate],
          ),
        ),
      ));
      assert.ok(
        maxSocketGeometryDrift <= 0.02,
        `a socket occupies its lifted keycap geometry (max drift ${maxSocketGeometryDrift}px)`,
      );
      const sourceIdentity = await page.evaluate((selector) => {
        const baseline = window.__ksxKeyboardSourceAudit ?? [];
        const current = Array.from(document.querySelectorAll(selector));
        return {
          sameLength: current.length === baseline.length,
          sameNodes: current.every((node, index) => node === baseline[index]?.node),
          sameParents: current.every(
            (node, index) => node.parentElement === baseline[index]?.parent,
          ),
          sameKeys: current.every(
            (node, index) => (node.getAttribute("data-key") ?? "") === baseline[index]?.key,
          ),
        };
      }, sourceSelector);
      assert.deepEqual(
        sourceIdentity,
        { sameLength: true, sameNodes: true, sameParents: true, sameKeys: true },
        "lifting caps mutates the served nodes in place without reparenting or replacing them",
      );
      const extractedSemantics = await readSourceSemantics();
      assert.equal(extractedSemantics.tabStops.length, 1, "roving focus remains singular");
      assert.equal(extractedSemantics.negativeTabs, extractedSemantics.count - 1);
      assert.deepEqual(extractedSemantics.pressed.sort(), [...liftedKeys].sort());
      assert.equal(extractedSemantics.invalidPressed, 0);

      const linked = await page.evaluate((keys) => {
        const ownership = (element) => Array.from(element.classList)
          .filter((name) =>
            name === "bound" ||
            name === "shared" ||
            name === "bstack" ||
            /^(?:bn|ba|bb|bc|bd|bcount)\d+$/.test(name)
          )
          .sort();
        return keys.map((key) => {
          const source = document.querySelector(`.n-widget-kb .n-key[data-key="${key}"]`);
          const clone = document.querySelector(`.n-widget-keylab .n-deck-key[data-keylab-key="${key}"]`);
          return {
            key,
            sourcePresent: Boolean(source),
            sourceExtracted: source?.classList.contains("extracted") ?? false,
            cloneCanonicalKey: clone?.getAttribute("data-key") ?? null,
            sourceOwnership: source ? ownership(source) : [],
            cloneOwnership: clone ? ownership(clone) : [],
          };
        });
      }, liftedKeys);
      assert.ok(linked.every((entry) => entry.sourcePresent && entry.sourceExtracted));
      assert.deepEqual(linked.map((entry) => entry.cloneCanonicalKey), liftedKeys);
      for (const entry of linked) {
        assert.deepEqual(
          entry.cloneOwnership,
          entry.sourceOwnership,
          `${entry.key} carries its controller ownership onto the deck clone`,
        );
      }

      const compact = await readDeck();
      assert.equal(compact.renderMode, "keycap");
      assert.equal(compact.layoutMode, "compact");
      assert.equal(compact.keycapProfile, "sculpted");
      assert.deepEqual(
        compact.keys.map((key) => key.token).sort(),
        liftedKeys.map((key) => `k:${key}`).sort(),
        "ordinary layouts use one stable k:key token per physical key",
      );
      assert.ok(
        compact.keys.every((key) => key.radius !== "50%"),
        "a freshly migrated workbench presents mechanical keycaps, not circles",
      );
      const compactIdentityAndPosition = compact.keys
        .map((key) => ({
          key: key.key,
          canonicalKey: key.canonicalKey,
          token: key.token,
          left: key.left,
          top: key.top,
        }))
        .sort((a, b) => a.token.localeCompare(b.token));
      for (const profile of ["low-profile", "pudding", "typewriter", "sculpted"]) {
        await page.click(
          `.n-widget-keylab [data-nx="keylab-cap-profile"][data-keycap-profile="${profile}"]`,
        );
        await page.waitForFunction(
          (slug) => document.querySelector(".n-widget-keylab .n-keylab-deck")?.getAttribute(
            "data-keycap-profile",
          ) === slug,
          profile,
        );
        const profiled = await readDeck();
        assert.equal(profiled.renderMode, "keycap");
        assert.equal(profiled.keycapProfile, profile);
        assert.deepEqual(
          profiled.keys
            .map((key) => ({
              key: key.key,
              canonicalKey: key.canonicalKey,
              token: key.token,
              left: key.left,
              top: key.top,
            }))
            .sort((a, b) => a.token.localeCompare(b.token)),
          compactIdentityAndPosition,
          `${profile} changes only cap presentation, never canonical keys or positions`,
        );
        assert.deepEqual(
          await profileButtons.evaluateAll((buttons) => buttons
            .filter((button) => button.getAttribute("aria-pressed") === "true")
            .map((button) => button.getAttribute("data-keycap-profile"))),
          [profile],
          `${profile} is the sole selected cap profile`,
        );
      }

      const sourceBeforeHide = await page.evaluate((selector) => {
        const widget = document.querySelector(".n-widget-kb");
        const keys = Array.from(document.querySelectorAll(selector));
        const geometry = widget
          ? {
              x: widget.getAttribute("data-canvas-x"),
              y: widget.getAttribute("data-canvas-y"),
              width: widget.getAttribute("data-canvas-width"),
              height: widget.getAttribute("data-canvas-height"),
              z: widget.getAttribute("data-canvas-z"),
              manualScale: widget.getAttribute("data-canvas-manual-scale"),
              styleWidth: widget.style.width,
              styleMinHeight: widget.style.minHeight,
            }
          : null;
        window.__ksxKeyboardHiddenAudit = {
          widget,
          keys,
          parents: keys.map((key) => key.parentElement),
          geometry,
        };
        return { geometry, keyCount: keys.length };
      }, sourceSelector);
      assert.equal(sourceBeforeHide.keyCount, 108);
      assert.deepEqual(
        await page.locator('.n-widget-keylab [data-nx="keylab-source-toggle"]').evaluate(
          (button) => ({
            pressed: button.getAttribute("aria-pressed"),
            expanded: button.getAttribute("aria-expanded"),
          }),
        ),
        { pressed: null, expanded: "true" },
        "the changing source action uses expansion semantics, not an inverted pressed state",
      );
      await page.click('.n-widget-keylab [data-nx="keylab-source-toggle"]');
      await page.waitForFunction(
        () => document.querySelector(".n-widget-kb")?.getAttribute("data-source-hidden") === "true",
      );
      const hiddenSource = await page.evaluate((selector) => {
        const audit = window.__ksxKeyboardHiddenAudit;
        const widget = document.querySelector(".n-widget-kb");
        const keys = Array.from(document.querySelectorAll(selector));
        const body = widget?.querySelector(".n-widget-body");
        return {
          sameWidget: widget === audit?.widget,
          widgetConnected: audit?.widget?.isConnected ?? false,
          sameKeyCount: keys.length === audit?.keys.length,
          sameKeyNodes: keys.every((key, index) => key === audit?.keys[index]),
          sameParents: keys.every((key, index) => key.parentElement === audit?.parents[index]),
          keysConnected: audit?.keys.every((key) => key.isConnected) ?? false,
          bodyInert: body?.inert ?? false,
          bodyAriaHidden: body?.getAttribute("aria-hidden") ?? null,
        };
      }, sourceSelector);
      assert.deepEqual(
        hiddenSource,
        {
          sameWidget: true,
          widgetConnected: true,
          sameKeyCount: true,
          sameKeyNodes: true,
          sameParents: true,
          keysConnected: true,
          bodyInert: true,
          bodyAriaHidden: "true",
        },
        "Hide source parks the exact served widget and key nodes instead of destroying them",
      );
      assert.equal(
        await page.locator('.n-widget-kb [data-nx="keylab-source-show"]').count(),
        1,
        "the parked source exposes one explicit restore action",
      );
      await page.locator(
        '.forma-canvas-navigator .navigator-item[aria-label="Focus Keyboard"]',
      ).click();
      await settle(page);
      await page.locator(".n-widget-kb .widget-drag-handle").focus();
      await page.keyboard.press("ArrowRight");
      await page.click('[data-nx="w-zoom-in"]');
      await page.click('.n-widget-kb [data-nx="keylab-source-show"]');
      await page.waitForFunction(
        () => document.querySelector(".n-widget-kb")?.getAttribute("data-source-hidden") === "false",
      );
      await settle(page);
      const restoredSource = await page.evaluate((selector) => {
        const audit = window.__ksxKeyboardHiddenAudit;
        const widget = document.querySelector(".n-widget-kb");
        const keys = Array.from(document.querySelectorAll(selector));
        const body = widget?.querySelector(".n-widget-body");
        const geometry = widget
          ? {
              x: widget.getAttribute("data-canvas-x"),
              y: widget.getAttribute("data-canvas-y"),
              width: widget.getAttribute("data-canvas-width"),
              height: widget.getAttribute("data-canvas-height"),
              z: widget.getAttribute("data-canvas-z"),
              manualScale: widget.getAttribute("data-canvas-manual-scale"),
              styleWidth: widget.style.width,
              styleMinHeight: widget.style.minHeight,
            }
          : null;
        return {
          sameWidget: widget === audit?.widget,
          widgetConnected: audit?.widget?.isConnected ?? false,
          sameKeyCount: keys.length === audit?.keys.length,
          sameKeyNodes: keys.every((key, index) => key === audit?.keys[index]),
          sameParents: keys.every((key, index) => key.parentElement === audit?.parents[index]),
          keysConnected: audit?.keys.every((key) => key.isConnected) ?? false,
          bodyInert: body?.inert ?? false,
          bodyAriaHidden: body?.getAttribute("aria-hidden") ?? null,
          geometry,
        };
      }, sourceSelector);
      assert.deepEqual(
        restoredSource,
        {
          sameWidget: true,
          widgetConnected: true,
          sameKeyCount: true,
          sameKeyNodes: true,
          sameParents: true,
          keysConnected: true,
          bodyInert: false,
          bodyAriaHidden: "false",
          geometry: sourceBeforeHide.geometry,
        },
        "Show keyboard restores all six original geometry fields on the exact same served nodes",
      );
      assert.deepEqual(
        (await readDeck()).keys
          .map((key) => ({
            key: key.key,
            canonicalKey: key.canonicalKey,
            token: key.token,
            left: key.left,
            top: key.top,
          }))
          .sort((a, b) => a.token.localeCompare(b.token)),
        compactIdentityAndPosition,
        "parking the source cannot disturb its linked workbench keys",
      );

      // Restoring the much larger source widget can put the workbench under
      // the navigator at the old camera position. Follow the user-facing LAB
      // marker back to the builder before exercising its pointer surface.
      await page.locator(
        '.forma-canvas-navigator .navigator-item[aria-label="Focus Key Workbench"]',
      ).click();
      await settle(page);

      await page.click('.n-widget-keylab [data-nx="keylab-layout-leverless"]');
      await page.waitForFunction(
        () => document.querySelector(
          '.n-widget-keylab [data-mode="leverless"]',
        )?.getAttribute("aria-pressed") === "true",
      );
      const leverless = await readDeck();
      assert.equal(leverless.layoutMode, "leverless");
      assert.deepEqual(
        leverless.keys.map((key) => key.key).sort(),
        [...liftedKeys].sort(),
        "leverless arrangement changes placement, not the selected set",
      );
      assert.notDeepEqual(
        leverless.keys.map((key) => [key.key, key.left, key.top]),
        compact.keys.map((key) => [key.key, key.left, key.top]),
        "leverless gives WASD its movement-cluster positions",
      );
      assert.equal(
        new Set(leverless.keys.map((key) => `${key.left}|${key.top}`)).size,
        4,
        "every leverless token receives a distinct position",
      );

      await page.click(
        '.n-widget-keylab [data-nx="keylab-cap-profile"][data-keycap-profile="pudding"]',
      );
      await page.waitForFunction(
        () => document.querySelector(".n-widget-keylab .n-keylab-deck")?.getAttribute(
          "data-keycap-profile",
        ) === "pudding",
      );
      await page.click('.n-widget-keylab [data-nx="keylab-render-arcade"]');
      await page.waitForFunction(
        () => document.querySelector(".n-widget-keylab .n-keylab-deck")?.getAttribute(
          "data-render-mode",
        ) === "arcade",
      );
      const puddingArcadePaint = (await readDeck()).keys.map((key) => key.paint);
      await page.locator(
        '.n-widget-keylab [data-nx="keylab-cap-profile"][data-keycap-profile="sculpted"]',
      ).evaluate((button) => button.click());
      await page.waitForFunction(
        () => document.querySelector(".n-widget-keylab .n-keylab-deck")?.getAttribute(
          "data-keycap-profile",
        ) === "sculpted",
      );
      const arcade = await readDeck();
      assert.equal(arcade.renderMode, "arcade");
      assert.deepEqual(
        arcade.keys.map((key) => key.paint),
        puddingArcadePaint,
        "a hidden mechanical profile cannot leak its sidewall paint into Arcade mode",
      );
      assert.deepEqual(
        arcade.keys.map((key) => key.key).sort(),
        [...liftedKeys].sort(),
        "arcade rendering changes silhouette, not key identity",
      );
      assert.ok(
        arcade.keys.every((key) => key.radius === "50%"),
        "every extracted key wears a round arcade rim",
      );
      assert.ok(
        arcade.keys.every((key) => Math.abs(key.width - key.height) <= 2),
        "arcade tokens render as circles rather than rounded keycaps",
      );
      assert.ok(
        arcade.keys.every((key) => key.paint !== "none"),
        "the arcade silhouette retains the themed physical paint",
      );

      const aButton = page.locator('.n-deck-key[data-keylab-key="A"]');
      const beforeDragA = await aButton.evaluate((button) => ({
        left: button.style.left,
        top: button.style.top,
      }));
      const workbenchBeforeDrag = await page.locator(".n-widget-keylab").evaluate((widget) => ({
        x: widget.getAttribute("data-canvas-x"),
        y: widget.getAttribute("data-canvas-y"),
      }));
      const aBox = await aButton.boundingBox();
      assert.ok(aBox, "the focused workbench exposes a real draggable A button");
      await page.mouse.move(aBox.x + aBox.width / 2, aBox.y + aBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        aBox.x + aBox.width / 2 + 48,
        aBox.y + aBox.height / 2 + 28,
        { steps: 5 },
      );
      await page.mouse.up();
      await page.waitForFunction(
        ({ left, top }) => {
          const key = document.querySelector('.n-deck-key[data-keylab-key="A"]');
          return key?.style.left !== left && key?.style.top !== top;
        },
        beforeDragA,
      );
      const afterDragA = await aButton.evaluate((button) => ({
        left: button.style.left,
        top: button.style.top,
      }));
      assert.notDeepEqual(afterDragA, beforeDragA, "pointer drag moves the loose arcade token");
      assert.deepEqual(
        await page.locator(".n-widget-keylab").evaluate((widget) => ({
          x: widget.getAttribute("data-canvas-x"),
          y: widget.getAttribute("data-canvas-y"),
        })),
        workbenchBeforeDrag,
        "dragging a token never drags its canvas widget",
      );
      const draggedState = await persistedWorkbench();
      assert.equal(draggedState?.layoutMode, "free", "pointerup commits a custom layout");
      assert.ok(
        draggedState?.positions?.["k:A"],
        "pointerup persists A under its v2 visual instance token",
      );

      const wButton = page.locator('.n-deck-key[data-keylab-key="W"]');
      await wButton.focus();
      const beforeNudge = await wButton.evaluate((button) => ({
        left: button.style.left,
        top: button.style.top,
      }));
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(
        (left) => document.querySelector('.n-deck-key[data-keylab-key="W"]')?.style.left !== left,
        beforeNudge.left,
      );
      const afterNudge = await page.locator('.n-deck-key[data-keylab-key="W"]').evaluate(
        (button) => ({ left: button.style.left, top: button.style.top }),
      );
      assert.notEqual(afterNudge.left, beforeNudge.left, "arrow keys nudge a focused deck token");
      assert.equal(afterNudge.top, beforeNudge.top, "a horizontal nudge leaves its row untouched");
      assert.ok(
        (await persistedWorkbench())?.positions?.["k:W"],
        "keyboard nudging persists W under its v2 visual instance token",
      );

      const dButton = page.locator('.n-deck-key[data-keylab-key="D"]');
      await dButton.focus();
      await page.keyboard.press("Delete");
      await page.waitForFunction(
        () => document.querySelectorAll(".n-widget-keylab .n-deck-key").length === 3,
      );
      await page.waitForFunction(() => {
        const active = document.activeElement;
        return Boolean(active?.matches(".n-widget-keylab .n-deck-key, .n-widget-keylab button"));
      });
      const focusAfterDelete = await page.evaluate(() => ({
        inWorkbench: Boolean(document.activeElement?.closest(".n-widget-keylab")),
        isControl: Boolean(document.activeElement?.matches(".n-deck-key, button")),
        key: document.activeElement?.getAttribute("data-keylab-key"),
      }));
      assert.equal(focusAfterDelete.inWorkbench, true, "Delete keeps keyboard focus in the workbench");
      assert.equal(focusAfterDelete.isControl, true, "focus lands on another usable control");
      assert.notEqual(focusAfterDelete.key, "D", "focus never points at the removed token");
      assert.equal(
        await page.locator('.n-widget-kb .n-key[data-key="D"].extracted').count(),
        0,
        "Delete returns the focused token to its source socket",
      );
      assert.deepEqual(
        (await readDeck()).keys.map((key) => key.key).sort(),
        ["A", "S", "W"],
      );
      assert.deepEqual(bindingPosts, [], "workbench gestures never post a binding or learner write");

      const saved = await persistedWorkbench();
      assert.equal(saved?.theme, "lunar-shell");
      assert.equal(saved?.open, true);
      assert.equal(saved?.sourceHidden, false);
      assert.equal(saved?.layoutMode, "free", "manual nudging persists a custom layout");
      assert.equal(saved?.renderMode, "arcade");
      assert.equal(saved?.capProfile, "sculpted");
      assert.deepEqual([...saved.selectedKeys].sort(), ["A", "S", "W"]);
      assert.ok(saved?.positions?.["k:A"]);
      assert.ok(saved?.positions?.["k:W"]);
      assert.equal(saved?.positions?.A, undefined, "new writes do not regress to legacy key ids");
      assert.equal(saved?.positions?.W, undefined, "new writes keep every position instance-scoped");

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.querySelectorAll(".n-widget-keylab .n-deck-key").length === 3,
        null,
        { timeout: 20_000 },
      );
      await settle(page);
      const restoredDeck = await readDeck();
      assert.equal(restoredDeck.widgetCount, 1);
      assert.equal(restoredDeck.renderMode, "arcade");
      assert.equal(restoredDeck.layoutMode, "free");
      assert.equal(restoredDeck.keycapProfile, "sculpted");
      assert.deepEqual(restoredDeck.keys.map((key) => key.key).sort(), ["A", "S", "W"]);
      assert.deepEqual(
        restoredDeck.keys.find((key) => key.key === "W") && {
          left: restoredDeck.keys.find((key) => key.key === "W").left,
          top: restoredDeck.keys.find((key) => key.key === "W").top,
        },
        afterNudge,
        "the custom W position survives reload",
      );
      assert.deepEqual(
        restoredDeck.keys.find((key) => key.key === "A") && {
          left: restoredDeck.keys.find((key) => key.key === "A").left,
          top: restoredDeck.keys.find((key) => key.key === "A").top,
        },
        afterDragA,
        "the pointer-dragged A position survives reload",
      );
      assert.equal(await page.locator(".n-widget-kb .n-key.extracted").count(), 3);

      const beforeClose = restoredDeck.keys.map((key) => [key.key, key.left, key.top]);
      await page.locator('.n-widget-keylab [data-nx="kb-workbench"]').evaluate(
        (button) => button.click(),
      );
      await page.waitForFunction(() => !document.querySelector(".n-widget-keylab"));
      assert.equal(
        await page.locator(".n-widget-kb .n-key.extracted").count(),
        0,
        "closing the editor shows the complete physical keyboard again",
      );
      await page.locator(".n-kbbuild").evaluate((button) => button.click());
      await page.waitForFunction(
        () => document.querySelectorAll(".n-widget-keylab .n-deck-key").length === 3,
      );
      const reopened = await readDeck();
      assert.deepEqual(
        reopened.keys.map((key) => [key.key, key.left, key.top]),
        beforeClose,
        "closing and reopening retains the exact custom control surface",
      );
      assert.equal(reopened.renderMode, "arcade");
      assert.equal(reopened.layoutMode, "free");
      assert.equal(reopened.keycapProfile, "sculpted");
      assert.deepEqual(bindingPosts, []);

      await page.locator('.n-widget-keylab [data-nx="keylab-build-players"]').evaluate(
        (button) => button.click(),
      );
      await page.waitForFunction(
        () => {
          const deck = document.querySelector(".n-widget-keylab .n-keylab-deck");
          return deck?.getAttribute("data-layout-mode") === "players" &&
            deck.querySelector('[data-keylab-token="p:1:G"]') &&
            deck.querySelector('[data-keylab-token="p:2:G"]');
        },
      );
      await page.locator(
        '.forma-canvas-navigator .navigator-item[aria-label="Focus Key Workbench"]',
      ).click();
      await settle(page);
      const playerDeck = await readDeck();
      assert.equal(playerDeck.layoutMode, "players");
      assert.equal(
        new Set(playerDeck.keys.map((key) => key.token)).size,
        playerDeck.keys.length,
        "every panel control has a unique visual instance token",
      );
      assert.ok(
        playerDeck.keys.every(
          (key) => key.token === `p:${key.playerSlot}:${key.canonicalKey}`,
        ),
        "the fixture's mapped controls use canonical p:slot:key mirror tokens",
      );
      const sharedGMirrors = playerDeck.keys
        .filter((key) => key.canonicalKey === "G")
        .sort((a, b) => a.token.localeCompare(b.token));
      assert.deepEqual(
        sharedGMirrors.map((key) => ({
          key: key.key,
          canonicalKey: key.canonicalKey,
          token: key.token,
          playerSlot: key.playerSlot,
          ownerSlots: key.ownerSlots,
          ownerBadges: key.ownerBadges,
        })),
        [
          {
            key: "G",
            canonicalKey: "G",
            token: "p:1:G",
            playerSlot: "1",
            ownerSlots: "1,2",
            ownerBadges: ["1", "2"],
          },
          {
            key: "G",
            canonicalKey: "G",
            token: "p:2:G",
            playerSlot: "2",
            ownerSlots: "1,2",
            ownerBadges: ["1", "2"],
          },
        ],
        "P1 and P2 receive linked visual mirrors, shared-owner badges, and one canonical G",
      );
      assert.equal(
        new Set(sharedGMirrors.map((key) => key.canonicalKey)).size,
        1,
        "duplicate panel views still describe one physical key",
      );
      assert.equal(
        await page.locator('.n-widget-kb .n-key[data-key="G"].extracted').count(),
        1,
        "both G mirrors lift exactly one source key",
      );
      await page.evaluate(() => {
        window.__ksxSharedGSource = document.querySelector('.n-widget-kb .n-key[data-key="G"]');
      });

      const p1GBefore = {
        left: sharedGMirrors[0].left,
        top: sharedGMirrors[0].top,
      };
      const p2GBefore = {
        left: sharedGMirrors[1].left,
        top: sharedGMirrors[1].top,
      };
      const p2GButton = page.locator('.n-deck-key[data-keylab-token="p:2:G"]');
      const p2GBox = await p2GButton.boundingBox();
      assert.ok(p2GBox, "the P2 G mirror is independently draggable");
      await page.mouse.move(p2GBox.x + p2GBox.width / 2, p2GBox.y + p2GBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        p2GBox.x + p2GBox.width / 2 + 42,
        p2GBox.y + p2GBox.height / 2 + 24,
        { steps: 5 },
      );
      await page.mouse.up();
      await page.waitForFunction(
        ({ left, top }) => {
          const mirror = document.querySelector('.n-deck-key[data-keylab-token="p:2:G"]');
          return mirror?.style.left !== left && mirror?.style.top !== top;
        },
        p2GBefore,
      );
      const draggedPlayerDeck = await readDeck();
      const p1GAfter = draggedPlayerDeck.keys.find((key) => key.token === "p:1:G");
      const p2GAfter = draggedPlayerDeck.keys.find((key) => key.token === "p:2:G");
      assert.equal(
        draggedPlayerDeck.layoutMode,
        "players",
        "customizing one mirror retains the four-player panel arrangement",
      );
      assert.deepEqual(
        p1GAfter && { left: p1GAfter.left, top: p1GAfter.top },
        p1GBefore,
        "dragging P2's linked view leaves P1's mirror in place",
      );
      assert.notDeepEqual(
        p2GAfter && { left: p2GAfter.left, top: p2GAfter.top },
        p2GBefore,
        "only the chosen player mirror receives the custom position",
      );
      const draggedMirrorState = await persistedWorkbench();
      assert.equal(draggedMirrorState?.layoutMode, "players");
      assert.ok(
        draggedMirrorState?.positions?.["p:2:G"],
        "the moved mirror persists by its player-scoped instance token",
      );
      assert.equal(draggedMirrorState?.positions?.G, undefined);
      assert.deepEqual(bindingPosts, [], "building and arranging panels performs no binding POSTs");

      await p2GButton.focus();
      await page.keyboard.press("Delete");
      await page.waitForFunction(
        () => document.querySelectorAll(
          '.n-widget-keylab .n-deck-key[data-keylab-key="G"]',
        ).length === 0,
      );
      const restoredGSocket = await page.evaluate(() => {
        const sources = Array.from(
          document.querySelectorAll('.n-widget-kb .n-key[data-key="G"]'),
        );
        return {
          count: sources.length,
          sameNode: sources[0] === window.__ksxSharedGSource,
          connected: sources[0]?.isConnected ?? false,
          extracted: sources[0]?.classList.contains("extracted") ?? false,
        };
      });
      assert.deepEqual(
        restoredGSocket,
        { count: 1, sameNode: true, connected: true, extracted: false },
        "deleting either linked mirror removes every G view and restores one source socket",
      );
      assert.equal(
        (await readDeck()).keys.some((key) => key.token === "p:1:G" || key.token === "p:2:G"),
        false,
      );
      assert.equal((await persistedWorkbench())?.selectedKeys.includes("G"), false);
      assert.deepEqual(bindingPosts, [], "linked-view deletion remains a presentation-only edit");
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
        ).find((el) => el.querySelector("svg.dualsensepremium"));
        if (!widget) return { found: false };
        const svg = widget.querySelector("svg.dualsensepremium");
        const hooks = svg?.querySelector(".dualsensepremium-hooks");
        const shell = svg?.querySelector(".dualsensepremium-shell");
        const hookShapes = Array.from(svg?.querySelectorAll(".dualsensepremium-hook") ?? []);
        const sourceIndexes = new Set(Array.from(
          svg?.querySelectorAll("[data-dualsense-source-index]") ?? [],
          (el) => el.getAttribute("data-dualsense-source-index"),
        ));
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
          sourceShapeCount: sourceIndexes.size,
          depthShapeCount: svg?.querySelectorAll(".dualsensepremium-depth-shadow").length ?? 0,
          privateEffects: svg?.querySelectorAll("defs, filter, mask, foreignObject, image, use, [id]").length ?? -1,
          calloutCount: svg?.querySelectorAll(".dualsensepremium-callouts text.n-fnkey[data-fn]").length ?? 0,
          variantCount: widget.querySelectorAll(
            '.n-controller-variants[aria-label="DualSense color"] button.n-controller-variant',
          ).length,
          shellFill: shell ? getComputedStyle(shell).fill : "",
          hooks: Array.from(widget.querySelectorAll(".dualsensepremium-hooks [data-fn]")).map(
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
      assert.equal(art.sourceShapeCount, 89, "the complete paid CC0 geometry survives inline");
      assert.equal(art.depthShapeCount, 20, "physical contact shadows sit beneath the controls");
      assert.equal(art.privateEffects, 0, "the clone contains no raster or private paint server");
      assert.equal(art.calloutCount, 25, "every mapper hook has one matching callout");
      assert.equal(art.variantCount, 6, "all six DualSense finishes are available in the widget header");
      assert.match(art.shellFill, /nxg-dualsense-white/, "the shell draws through the shared satin finish");
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

  test("Switch Pro and Xbox Series keep native geometry, exact zones, and selectable finishes", async () => {
    for (const [persona, preset] of [
      ["switchpro", "Player 4"],
      ["xboxseries", "Player 5"],
    ]) {
      const staged = await fetch(`${BASE}/nocturne/controller`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `persona=${persona}&preset=${encodeURIComponent(preset)}`,
        redirect: "manual",
      });
      assert.ok(staged.status >= 200 && staged.status < 400, `staging ${persona} answered ${staged.status}`);
    }

    const page = await openCanvas();
    try {
      const specs = [
        {
          family: "switchpro",
          svg: "svg.switchpropremium",
          source: "[data-switchpro-source-index]",
          sourceCount: 76,
          depth: ".switchpro-premium-depth-shadow",
          depthCount: 16,
          hook: ".switchpro-premium-hook[data-fn]",
          callout: ".switchpro-premium-callouts text.n-fnkey[data-fn]",
          shell: ".switchpro-premium-shell",
          viewBox: "10 145 940 670",
          variants: ["carbon-black", "ink-pair", "crimson-red", "frost-white"],
        },
        {
          family: "xboxseries",
          svg: "svg.xboxseriespremium",
          source: "[data-xbox-series-source-index]",
          sourceCount: 80,
          depth: ".xboxseriespremium-depth-shadow",
          depthCount: 23,
          hook: ".xboxseriespremium-hook[data-fn]",
          callout: ".xboxseriespremium-callouts text.n-fnkey[data-fn]",
          shell: ".xboxseriespremium-shell",
          viewBox: "0 0 3800 2647",
          variants: ["black", "white", "blue", "red", "green"],
        },
      ];

      const inspect = (spec) => page.evaluate((entry) => {
        const stage = document.querySelector(".forma-canvas-stage");
        const widget = Array.from(stage?.querySelectorAll(".widget-instance") ?? [])
          .find((el) => el.querySelector(entry.svg));
        if (!widget) return { found: false };
        const svg = widget.querySelector(entry.svg);
        const hooks = Array.from(svg.querySelectorAll(entry.hook));
        const callouts = Array.from(svg.querySelectorAll(entry.callout));
        const geometryAttrs = [
          "d", "x", "y", "cx", "cy", "r", "rx", "ry", "width", "height", "points", "transform",
        ];
        const geometry = Array.from(
          svg.querySelectorAll("g, path, circle, rect, ellipse, line, polyline, polygon"),
          (el) => [el.tagName, ...geometryAttrs.map((name) => el.getAttribute(name) ?? "")].join("|"),
        );
        const sourceIndexes = new Set(Array.from(
          svg.querySelectorAll(entry.source),
          (el) => el.getAttribute(entry.family === "switchpro"
            ? "data-switchpro-source-index"
            : "data-xbox-series-source-index"),
        ));
        const buttons = Array.from(widget.querySelectorAll(
          '.n-controller-variants button.n-controller-variant[data-controller-variant]',
        ));
        return {
          found: true,
          viewBox: svg.getAttribute("viewBox"),
          variant: svg.getAttribute("data-controller-variant"),
          sourceCount: sourceIndexes.size,
          depthCount: svg.querySelectorAll(entry.depth).length,
          hookCount: hooks.length,
          uniqueHookCount: new Set(hooks.map((el) => el.getAttribute("data-fn"))).size,
          calloutCount: callouts.length,
          uniqueCalloutCount: new Set(callouts.map((el) => el.getAttribute("data-fn"))).size,
          transparentHookCount: hooks.filter((el) => el.getAttribute("fill") === "transparent").length,
          forbiddenCount: svg.querySelectorAll("defs, filter, mask, foreignObject, image, use, [id]").length,
          buttonSlugs: buttons.map((el) => el.getAttribute("data-controller-variant")),
          pressed: buttons.filter((el) => el.getAttribute("aria-pressed") === "true")
            .map((el) => el.getAttribute("data-controller-variant")),
          shellFill: getComputedStyle(svg.querySelector(entry.shell)).fill,
          geometry,
        };
      }, spec);

      for (const spec of specs) {
        const initial = await inspect(spec);
        assert.ok(initial.found, `${spec.family} gets its own inline master`);
        assert.equal(initial.viewBox, spec.viewBox, `${spec.family} keeps its native crop`);
        assert.equal(initial.sourceCount, spec.sourceCount, `${spec.family} keeps every authored source shape`);
        assert.equal(initial.depthCount, spec.depthCount, `${spec.family} has explicit physical depth vectors`);
        assert.equal(initial.hookCount, 25, `${spec.family} exposes exactly 25 mapper hooks`);
        assert.equal(initial.uniqueHookCount, 25, `${spec.family} hooks are unique whole controls`);
        assert.equal(initial.calloutCount, 25, `${spec.family} has a callout for every hook`);
        assert.equal(initial.uniqueCalloutCount, 25, `${spec.family} callouts match the hook vocabulary`);
        assert.equal(initial.transparentHookCount, 25, `${spec.family} hooks are invisible at rest`);
        assert.equal(initial.forbiddenCount, 0, `${spec.family} contains no raster or private paint server`);
        assert.deepEqual(initial.buttonSlugs, spec.variants, `${spec.family} exposes every finish`);
        assert.deepEqual(initial.pressed, [spec.variants[0]], `${spec.family} starts on its canonical finish`);

        const next = spec.variants[1];
        await page.locator(
          `.forma-canvas-stage .widget-instance:has(${spec.svg}) ` +
          `button[data-controller-variant="${next}"]`,
        ).click();
        await page.waitForFunction(
          ({ svgSelector, slug }) => document.querySelector(
            `.forma-canvas-stage .widget-instance ${svgSelector}`,
          )?.getAttribute("data-controller-variant") === slug,
          { svgSelector: spec.svg, slug: next },
        );
        const changed = await inspect(spec);
        assert.equal(changed.variant, next, `${spec.family} finish button repaints the clone`);
        assert.deepEqual(changed.pressed, [next], `${spec.family} exposes selected state`);
        assert.notEqual(changed.shellFill, initial.shellFill, `${spec.family} changes material paint`);
        assert.deepEqual(changed.geometry, initial.geometry, `${spec.family} finish cannot move geometry or hooks`);
      }
      const storedFinishes = await page.evaluate(() =>
        localStorage.getItem("ksx-nocturne-controller-finishes1") ?? ""
      );
      assert.match(storedFinishes, /switchpro:/, "Switch Pro finish persists by family and preset");
      assert.match(storedFinishes, /xboxseries:/, "Xbox Series finish persists by family and preset");
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
