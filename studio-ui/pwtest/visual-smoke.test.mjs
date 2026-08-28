// Deterministic browser/layout smoke for every Studio route.
//
// This is intentionally an artifact-producing STRUCTURAL gate, not a pixel
// baseline. Studio uses system fonts, so exact image diffs would turn Windows
// image/font rasterization drift into noise. The screenshots let a reviewer
// see the real dark-desktop, light-mobile and coarse cabinet paints while the
// assertions catch runtime errors, escaped layouts and failed hydration.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { chromium } from "playwright";
import { stopFixtureProcess } from "./fixture-process.mjs";

const PORT = Number(process.env.KSX_PWTEST_VISUAL_PORT ?? 4500);
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(repoRoot, "target");
const exe = path.join(
  targetDir,
  "debug",
  "examples",
  process.platform === "win32" ? "macro_fixture.exe" : "macro_fixture",
);
const screenshotDir = path.resolve(
  process.env.KSX_PWTEST_SCREENSHOT_DIR ?? path.join(tmpdir(), "ksx-studio-browser-screenshots"),
);

const ROUTES = [
  { path: "/nocturne", name: "nocturne" },
  // The macro roll only exists when a macro is OPEN: with the dialog closed
  // the payload serves empty lists, so every cell, row body and pill in it sat
  // outside this gate and outside every screenshot — which is how a 390px
  // collapse and fifteen dead custom properties shipped unseen.
  { path: "/nocturne?slot=1&macro=hadouken", name: "nocturne-macro" },
  { path: "/check", name: "check" },
  { path: "/pads", name: "pads" },
  { path: "/devices", name: "devices" },
  { path: "/redesign", name: "redesign" },
];

const CONTEXTS = [
  {
    name: "dark-desktop",
    expectCoarse: false,
    options: {
      viewport: { width: 1600, height: 1200 },
      colorScheme: "dark",
      reducedMotion: "reduce",
      deviceScaleFactor: 1,
    },
  },
  {
    name: "light-mobile",
    expectCoarse: true,
    options: {
      viewport: { width: 390, height: 844 },
      colorScheme: "light",
      reducedMotion: "reduce",
      deviceScaleFactor: 1,
      hasTouch: true,
      isMobile: true,
    },
  },
  {
    name: "coarse-cabinet",
    expectCoarse: true,
    options: {
      viewport: { width: 1280, height: 800 },
      colorScheme: "dark",
      reducedMotion: "reduce",
      deviceScaleFactor: 1,
      hasTouch: true,
    },
  },
];

let server;
let serverExit = null;
let serverStderr = "";
let browser;
const screenshotRecords = [];

async function waitForServer(deadlineMs = 120_000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const up = await fetch(`${BASE}/api/nocturne`).then(
      (response) => response.ok,
      () => false,
    );
    if (up) return;
    assert.equal(
      serverExit,
      null,
      `visual fixture exited before serving ${BASE}:\n${serverStderr.trim() || "(it said nothing)"}`,
    );
    assert.ok(
      Date.now() < until,
      `visual fixture never answered on ${BASE}:\n${serverStderr.trim() || "(it said nothing)"}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

before(async () => {
  await rm(screenshotDir, { recursive: true, force: true });
  await mkdir(screenshotDir, { recursive: true });

  const squatter = await fetch(`${BASE}/api/nocturne`).then(
    () => true,
    () => false,
  );
  assert.equal(squatter, false, `something is already listening on ${BASE} — stop it first`);

  const built = spawnSync(
    "cargo",
    ["build", "--quiet", "-p", "ksx-studio", "--example", "macro_fixture"],
    { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
  );
  assert.equal(built.status, 0, "could not build the ksx-studio visual fixture");

  server = spawn(exe, [String(PORT)], {
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, KSX_FIXTURE_SESSION: "idle" },
  });
  server.stderr?.on("data", (chunk) => (serverStderr += chunk.toString()));
  server.on("exit", (code, signal) => (serverExit = { code, signal }));
  await waitForServer();
  browser = await chromium.launch();
});

after(async () => {
  const failures = [];
  try {
    const expectedCount = ROUTES.length * CONTEXTS.length;
    const records = screenshotRecords.toSorted((left, right) =>
      left.file.localeCompare(right.file, "en"),
    );
    const manifest = {
      schemaVersion: 1,
      commit: process.env.GITHUB_SHA ?? null,
      workflowRun: process.env.GITHUB_RUN_ID ?? null,
      fixtureState: "idle",
      node: process.version,
      playwright: "1.62.1",
      chromium: browser?.version() ?? null,
      expectedCount,
      capturedCount: records.length,
      screenshots: records,
    };
    await writeFile(
      path.join(screenshotDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    // The completeness pin is what makes the artifact trustworthy in CI: a
    // suite that captured 12 of 15 screenshots and said nothing is how a
    // regression hides, so it stays ON by default and CI never sets the escape
    // hatch below.
    //
    // The hatch exists because this hook is file-level: running ONE test by
    // name (`--test-name-pattern`) still runs it, so teardown failed on every
    // filtered run long after the test itself had passed. Detecting the filter
    // from inside the test process is NOT possible — node's runner spawns each
    // file as a child WITHOUT the runner's own flags, so `process.argv` here is
    // just `[node, <file>]` (measured 2026-08-26; an earlier attempt to sniff
    // argv was silently inert, which is worse than no fix). An explicit opt-in
    // is the honest mechanism:
    //
    //     KSX_PARTIAL_SHOTS=1 node --test --test-name-pattern="…" visual-smoke.test.mjs
    if (process.env.KSX_PARTIAL_SHOTS === "1") {
      console.log(
        `visual smoke: captured ${records.length} of ${expectedCount} screenshots ` +
          "(KSX_PARTIAL_SHOTS=1, so the completeness pin is skipped)",
      );
    } else {
      assert.equal(records.length, expectedCount, "the screenshot artifact is incomplete");
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    await browser?.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await stopFixtureProcess(server, "visual fixture");
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "visual fixture teardown failed");
});

for (const config of CONTEXTS) {
  describe(`visual smoke — ${config.name}`, () => {
    let context;

    before(async () => {
      context = await browser.newContext({
        ...config.options,
        locale: "en-US",
        timezoneId: "UTC",
        serviceWorkers: "block",
      });
    });

    after(async () => {
      await context?.close();
    });

    for (const route of ROUTES) {
      test(`${route.path} hydrates and stays inside its viewport`, async () => {
        const page = await context.newPage();
        const diagnostics = [];
        page.on("pageerror", (error) => diagnostics.push(`pageerror: ${error.stack ?? error}`));
        page.on("console", (message) => {
          if (message.type() === "error") diagnostics.push(`console: ${message.text()}`);
        });

        const screenshotPath = path.join(screenshotDir, `${config.name}-${route.name}.png`);
        let failure;
        try {
          const response = await page.goto(`${BASE}${route.path}`, {
            waitUntil: "domcontentloaded",
          });
          assert.ok(response?.ok(), `${route.path} returned HTTP ${response?.status() ?? "none"}`);
          await page.waitForFunction(
            () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
            null,
            { timeout: 20_000 },
          );
          // Canvas adoption happens in the island's post-mount FRAME, which
          // is not a fixed distance behind hydration — measured between 100
          // and 300 ms here, longer on a loaded runner. Waiting a flat
          // interval would assert against a canvas that simply has not been
          // adopted yet (a flaky gate that reads as a dead canvas), so wait
          // for the adoption itself, then for the opening fitAll to settle.
          // Both waits pass instantly on the routes that have no canvas.
          await page.waitForFunction(
            () => {
              const canvas = document.querySelector(".n-canvas");
              if (!canvas) return true;
              const kb = canvas.querySelector('[data-instance-id="keyboard"]');
              if (kb) return kb.dataset.canvasX !== undefined;
              // The redesign's mock widgets are client-created. Waiting only
              // for the stage transform lets a live engine with a missing
              // product surface pass, so require the first mock's geometry.
              if (canvas.closest(".rd")) {
                return canvas.querySelector('[data-instance-id="mock-a"]')?.dataset.canvasX !==
                  undefined;
              }
              // Any other widget-less canvas uses the engine's first camera
              // transform as its alive mark.
              const stage = canvas.querySelector(".forma-canvas-stage");
              return Boolean(stage && stage.style.transform);
            },
            null,
            { timeout: 20_000 },
          );
          await page.waitForFunction(
            () => !document.querySelector(".is-camera-animating"),
            null,
            { timeout: 20_000 },
          );
          // Inspect the adopted first paint, before the fixture's two-second
          // poll can turn the screenshot into a timing-dependent sample.
          await page.waitForTimeout(300);

          const layout = await page.evaluate(() => {
            const html = document.documentElement;
            const body = document.body;
            const viewportWidth = html.clientWidth;
            const documentWidth = Math.max(html.scrollWidth, body?.scrollWidth ?? 0);
            const roots = [
              document.querySelector("[data-forma-island]"),
              ...document.querySelectorAll(".studio, .wrap"),
            ].filter((element, index, all) => element && all.indexOf(element) === index);
            const containers = roots.map((element) => {
              const rect = element.getBoundingClientRect();
              return {
                tag: element.tagName,
                className: String(element.className ?? ""),
                left: rect.left,
                right: rect.right,
                width: rect.width,
              };
            });
            // The nocturne canvas can die silently: every other assertion
            // here passes with an unadopted keyboard sitting at auto layout.
            // Adoption's one observable is the engine's geometry write.
            const kbWidget = document.querySelector(
              '.n-canvas [data-instance-id="keyboard"]',
            );
            const canvas = document.querySelector(".n-canvas");
            let canvasAdoption = null;
            if (canvas && kbWidget) {
              const kbRect = kbWidget?.getBoundingClientRect();
              const canvasRect = canvas.getBoundingClientRect();
              canvasAdoption = {
                kbPositioned: kbWidget?.dataset.canvasX !== undefined,
                kbIntersectsCanvas: Boolean(
                  kbRect &&
                    kbRect.width > 0 &&
                    kbRect.right > canvasRect.left &&
                    kbRect.left < canvasRect.right &&
                    kbRect.bottom > canvasRect.top &&
                    kbRect.top < canvasRect.bottom,
                ),
              };
            }
            // The engine-alive mark for ANY canvas, keyboard or not: its
            // first camera render writes the stage transform inline.
            const canvasEngineAlive = canvas
              ? Boolean(canvas.querySelector(".forma-canvas-stage")?.style.transform)
              : null;
            return {
              status: document.querySelector("[data-forma-island]")?.dataset.formaStatus ?? null,
              viewportWidth,
              documentWidth,
              coarse: matchMedia("(pointer: coarse)").matches,
              light: matchMedia("(prefers-color-scheme: light)").matches,
              nocturneStage: (() => {
                const stage = document.querySelector(".nocturne");
                return stage ? getComputedStyle(stage).backgroundColor : null;
              })(),
              containers,
              canvasAdoption,
              canvasEngineAlive,
              escaped: containers.filter(
                (box) => box.width > 0 && (box.left < -1 || box.right > viewportWidth + 1),
              ),
            };
          });

          assert.equal(layout.status, "active", `${route.path} did not finish hydration`);
          assert.ok(
            layout.documentWidth <= layout.viewportWidth + 1,
            `${route.path} globally overflows ${config.name}: ` +
              `${layout.documentWidth}px document in ${layout.viewportWidth}px viewport`,
          );
          assert.ok(layout.containers.length > 0, `${route.path} exposed no responsive root`);
          if (layout.canvasAdoption) {
            assert.ok(
              layout.canvasAdoption.kbPositioned,
              `${route.path}: the canvas engine never adopted the keyboard ` +
                "widget (no data-canvas-x) — a dead canvas passes every other check",
            );
            assert.ok(
              layout.canvasAdoption.kbIntersectsCanvas,
              `${route.path}: the keyboard widget does not intersect the ` +
                "visible canvas — the camera or the stored geometry lost it",
            );
          }
          assert.notEqual(
            layout.canvasEngineAlive,
            false,
            route.path +
              ": the canvas engine never wrote its camera — a dead canvas " +
              "passes every other check",
          );
          assert.deepEqual(
            layout.escaped,
            [],
            `${route.path} lets a responsive root escape ${config.name}`,
          );
          assert.equal(
            layout.coarse,
            config.expectCoarse,
            `${config.name} did not expose the intended pointer mode`,
          );
          assert.equal(
            layout.light,
            config.options.colorScheme === "light",
            `${config.name} did not expose the intended color scheme`,
          );
          // Under System (the fixture stamps no data-theme) the product frame
          // itself must follow the OS, not just the body behind it: an
          // emulated light OS repaints `.nocturne` with the light tokens.
          // Dark keeps the Nocturne design's own navy — that face IS dark.
          if (layout.nocturneStage !== null) {
            assert.equal(
              layout.nocturneStage,
              config.options.colorScheme === "light"
                ? hexToRgb(THEMES.find((t) => t.id === "light").bg)
                : "rgb(22, 24, 38)",
              `${route.path} did not paint the System-${config.options.colorScheme} ` +
                `ground on ${config.name}`,
            );
          }
          assert.deepEqual(diagnostics, [], `${route.path} emitted browser errors on ${config.name}`);
        } catch (error) {
          failure = error;
        }

        try {
          const screenshot = await page.screenshot({
            path: screenshotPath,
            fullPage: true,
            animations: "disabled",
            caret: "hide",
            scale: "css",
          });
          assert.equal(
            screenshot.subarray(0, 8).toString("hex"),
            "89504e470d0a1a0a",
            `${screenshotPath} is not a PNG`,
          );
          const width = screenshot.readUInt32BE(16);
          const height = screenshot.readUInt32BE(20);
          assert.ok(width > 0 && height > 0, `${screenshotPath} has empty dimensions`);
          screenshotRecords.push({
            file: path.basename(screenshotPath),
            route: route.path,
            context: config.name,
            viewport: config.options.viewport,
            theme: config.options.colorScheme,
            pointer: config.expectCoarse ? "coarse" : "fine",
            width,
            height,
            bytes: screenshot.length,
            sha256: createHash("sha256").update(screenshot).digest("hex"),
          });
        } catch (error) {
          if (!failure) failure = new Error(`could not capture ${screenshotPath}: ${error}`);
        }
        await page.close();
        if (failure) throw failure;
      });
    }
  });
}

describe("redesign canvas interaction chrome", () => {
  test("Inspector, minimap, position fields, and shortcut scope stay coherent", async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      colorScheme: "dark",
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const diagnostics = [];
    page.on("pageerror", (error) => diagnostics.push(`pageerror: ${error.stack ?? error}`));
    page.on("console", (message) => {
      if (message.type() === "error") diagnostics.push(`console: ${message.text()}`);
    });

    try {
      const response = await page.goto(`${BASE}/redesign`, { waitUntil: "domcontentloaded" });
      assert.ok(response?.ok(), `/redesign returned HTTP ${response?.status() ?? "none"}`);
      await page.waitForFunction(
        () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
        null,
        { timeout: 20_000 },
      );
      await page.waitForFunction(
        () => Boolean(document.querySelector(".forma-canvas-stage")?.style.transform),
        null,
        { timeout: 20_000 },
      );
      await page.waitForFunction(
        () => document.querySelector('[data-instance-id="mock-a"]')?.dataset.canvasX !== undefined,
        null,
        { timeout: 20_000 },
      );
      await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      await page.waitForFunction(
        () => !document.querySelector(".is-camera-animating"),
        null,
        { timeout: 20_000 },
      );

      const inspectorLayout = async () => page.locator(".rd-inspector").evaluate((panel) => {
        const rect = panel.getBoundingClientRect();
        return {
          hidden: panel.hidden,
          display: getComputedStyle(panel).display,
          width: rect.width,
        };
      });
      assert.deepEqual(
        await inspectorLayout(),
        { hidden: true, display: "none", width: 0 },
        "the served-hidden Inspector must not cover the canvas before selection",
      );

      const stageItem = (id) =>
        page.locator(`.forma-canvas-stage > [data-instance-id="${id}"]`);
      const nextPaint = async () => page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      const cameraState = async () => page.evaluate(() => {
        const stage = document.querySelector(".forma-canvas-stage");
        const viewport = document.querySelector(".forma-canvas-viewport");
        const inspector = document.querySelector(".rd-inspector");
        if (!stage || !viewport || !inspector) return null;
        const match = stage.style.transform.match(
          /translate\(([-\d.]+)px,\s*([-\d.]+)px\) scale\(([-\d.]+)\)/,
        );
        if (!match) return null;
        const [, panX, panY, zoom] = match.map(Number);
        const viewportRect = viewport.getBoundingClientRect();
        const inspectorWidth = inspector.hidden ? 0 : inspector.getBoundingClientRect().width;
        const safeWidth = viewportRect.width -
          (inspectorWidth >= viewportRect.width - 1 ? 0 : inspectorWidth);
        return {
          panX,
          panY,
          zoom,
          safeWidth,
          height: viewportRect.height,
          worldX: (safeWidth / 2 - panX) / zoom,
          worldY: (viewportRect.height / 2 - panY) / zoom,
          transform: stage.style.transform,
        };
      });

      const beforeButtonZoom = await cameraState();
      await page.locator('[data-nx="canvas-zoom-in"]').click();
      await nextPaint();
      const afterButtonZoom = await cameraState();
      assert.ok(beforeButtonZoom && afterButtonZoom);
      assert.ok(
        Math.abs(afterButtonZoom.zoom / beforeButtonZoom.zoom - 1.25) < 0.001,
        "the visible zoom buttons drifted from the documented 1.25× step",
      );
      await page.locator('[data-nx="canvas-zoom-out"]').click();
      await nextPaint();
      assert.ok(
        Math.abs((await cameraState()).zoom - beforeButtonZoom.zoom) < 0.001,
        "zooming out did not invert the 1.25× button step",
      );
      const navigatorGeometry = async () => page.evaluate(() => {
        const area = document.querySelector(".forma-canvas-navigator-items");
        const camera = document.querySelector(".forma-canvas-navigator-viewport");
        if (!area || !camera) return null;
        const bounds = area.getBoundingClientRect();
        const nodes = [camera, ...area.querySelectorAll(".navigator-item")];
        const outside = nodes.flatMap((node) => {
          const rect = node.getBoundingClientRect();
          return rect.left < bounds.left - 1 || rect.top < bounds.top - 1 ||
              rect.right > bounds.right + 1 || rect.bottom > bounds.bottom + 1
            ? [node.className]
            : [];
        });
        return { width: bounds.width, height: bounds.height, outside };
      });
      await stageItem("mock-a").click();
      await page.waitForFunction(() => document.querySelector(".rd-inspector")?.hidden === false);
      await page.locator('[data-nx="rd-insp-close"]').click();
      assert.deepEqual(
        await inspectorLayout(),
        { hidden: true, display: "none", width: 0 },
        "Inspector X must remove the panel from layout, not only set an attribute",
      );

      await stageItem("mock-a").click();
      await page.waitForFunction(
        () =>
          document.querySelector(".rd-inspector")?.hidden === false &&
          document.querySelector(".rd-insp-name")?.textContent === "Mock node A",
      );
      await stageItem("mock-b").click();
      await page.waitForFunction(
        () =>
          document.querySelector(".rd-inspector")?.hidden === false &&
          document.querySelector(".rd-insp-name")?.textContent === "Mock node B",
      );
      const beforeFocus = await cameraState();
      await page.locator('.rd-inspector [data-nx="rd-focus-sel"]').click();
      await page.waitForFunction(
        () => document.querySelector(".forma-canvas-viewport")?.dataset.widgetFocusMode === "active",
      );
      assert.equal(
        await page.locator(".is-camera-animating").count(),
        0,
        "reduced motion removed the tween but left the canvas interaction-locked",
      );
      const focusedCamera = await cameraState();
      assert.ok(
        focusedCamera && focusedCamera.zoom >= 0.9 && focusedCamera.zoom <= 1.2,
        "Focus escaped its documented 90–120% editing range",
      );
      assert.equal(await page.locator(".rd-back").getAttribute("hidden"), null);
      await page.locator('[data-nx="rd-insp-close"]').click();
      assert.equal(
        await page.locator(".forma-canvas-viewport").getAttribute("data-widget-focus-mode"),
        "inactive",
        "closing the Inspector must also leave Focus mode",
      );
      assert.equal(
        (await cameraState()).transform,
        beforeFocus.transform,
        "closing Focus did not restore its exact entry camera",
      );
      assert.equal(
        await page.locator(".rd-back").getAttribute("hidden"),
        "",
        "Focus restoration left a redundant Back-view entry behind",
      );

      // Resizing is a camera translation, not an implicit Fit. Focus's
      // private restore snapshot must receive the same translation, or
      // Escape returns to a view centred for the old window.
      await stageItem("mock-a").click();
      await stageItem("mock-b").click();
      const beforeFocusResize = await cameraState();
      await page.locator('.rd-inspector [data-nx="rd-focus-sel"]').click();
      await page.setViewportSize({ width: 1160, height: 720 });
      await nextPaint();
      await page.keyboard.press("Escape");
      const afterFocusResize = await cameraState();
      assert.ok(beforeFocusResize && afterFocusResize);
      assert.ok(Math.abs(afterFocusResize.zoom - beforeFocusResize.zoom) < 0.001);
      assert.ok(
        Math.abs(afterFocusResize.worldX - beforeFocusResize.worldX) < 0.02,
        `resize moved the safe-centre world X: ${JSON.stringify({ beforeFocusResize, afterFocusResize })}`,
      );
      assert.ok(
        Math.abs(afterFocusResize.worldY - beforeFocusResize.worldY) < 0.02,
        `resize moved the safe-centre world Y: ${JSON.stringify({ beforeFocusResize, afterFocusResize })}`,
      );
      assert.equal(await page.locator(".rd-back").getAttribute("hidden"), "");
      await page.setViewportSize({ width: 1280, height: 800 });
      await nextPaint();
      const afterPlainResize = await cameraState();
      assert.ok(afterPlainResize);
      assert.ok(Math.abs(afterPlainResize.zoom - afterFocusResize.zoom) < 0.001);
      assert.ok(
        Math.abs(afterPlainResize.worldX - afterFocusResize.worldX) < 0.02,
        `plain resize moved world X: ${JSON.stringify({ afterFocusResize, afterPlainResize })}`,
      );
      assert.ok(
        Math.abs(afterPlainResize.worldY - afterFocusResize.worldY) < 0.02,
        `plain resize moved world Y: ${JSON.stringify({ afterFocusResize, afterPlainResize })}`,
      );

      await stageItem("mock-a").click();
      const beforePosition = await stageItem("mock-a").evaluate((item) => ({
        x: Number(item.dataset.canvasX),
        y: Number(item.dataset.canvasY),
      }));
      await page.getByLabel("X", { exact: true }).fill(String(beforePosition.x + 17));
      await page.locator(".rd-insp-head .rd-map-title").click();
      await page.getByLabel("Y", { exact: true }).fill(String(beforePosition.y + 23));
      await page.locator(".rd-insp-head .rd-map-title").click();
      assert.deepEqual(
        await stageItem("mock-a").evaluate((item) => ({
          x: Number(item.dataset.canvasX),
          y: Number(item.dataset.canvasY),
        })),
        { x: beforePosition.x + 17, y: beforePosition.y + 23 },
        "editing Y must not silently undo the preceding X edit",
      );

      const stage = page.locator(".forma-canvas-stage");
      const minimapRepresentedWidth = async () => page.evaluate(() => {
        const area = document.querySelector(".forma-canvas-navigator-items");
        const camera = document.querySelector(".forma-canvas-navigator-viewport");
        const markerA = area?.querySelector('[data-instance-id="mock-a"]');
        const markerB = area?.querySelector('[data-instance-id="mock-b"]');
        const itemA = document.querySelector('.forma-canvas-stage > [data-instance-id="mock-a"]');
        const itemB = document.querySelector('.forma-canvas-stage > [data-instance-id="mock-b"]');
        const stage = document.querySelector(".forma-canvas-stage");
        const viewport = document.querySelector(".forma-canvas-viewport");
        const inspector = document.querySelector(".rd-inspector");
        if (!area || !camera || !markerA || !markerB || !itemA || !itemB ||
            !stage || !viewport || !inspector) return null;
        const match = stage.style.transform.match(/scale\(([-\d.]+)\)/);
        const worldDelta = Number(itemB.dataset.canvasX) - Number(itemA.dataset.canvasX);
        const mapDelta = parseFloat(markerB.style.left) - parseFloat(markerA.style.left);
        const projectionScale = Math.abs(mapDelta / worldDelta);
        const zoom = Number(match?.[1]);
        const viewportWidth = viewport.getBoundingClientRect().width;
        const inspectorWidth = inspector.hidden ? 0 : inspector.getBoundingClientRect().width;
        return {
          represented: parseFloat(camera.style.width) / projectionScale * zoom,
          safe: viewportWidth - inspectorWidth,
          full: viewportWidth,
        };
      });
      await nextPaint();
      const safeMapWidth = await minimapRepresentedWidth();
      assert.ok(safeMapWidth);
      assert.ok(
        Math.abs(safeMapWidth.represented - safeMapWidth.safe) < 3,
        "the minimap camera rectangle included the Inspector-covered strip",
      );

      const mappedWorldPoint = await page.evaluate(() => {
        const area = document.querySelector(".forma-canvas-navigator-items");
        const marker = area?.querySelector('[data-instance-id="mock-a"]');
        const item = document.querySelector('.forma-canvas-stage > [data-instance-id="mock-a"]');
        if (!area || !marker || !item) return null;
        const areaRect = area.getBoundingClientRect();
        const clientX = areaRect.left + parseFloat(marker.style.left) +
          parseFloat(marker.style.width) / 2;
        const clientY = areaRect.top + parseFloat(marker.style.top) +
          parseFloat(marker.style.height) / 2;
        area.dispatchEvent(new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          buttons: 1,
          clientX,
          clientY,
          pointerId: 91,
        }));
        window.dispatchEvent(new PointerEvent("pointerup", {
          bubbles: true,
          button: 0,
          clientX,
          clientY,
          pointerId: 91,
        }));
        return {
          x: Number(item.dataset.canvasX) + Number(item.dataset.canvasWidth) / 2,
          y: Number(item.dataset.canvasY) + Number(item.dataset.canvasHeight) / 2,
        };
      });
      await nextPaint();
      const afterMapPan = await cameraState();
      assert.ok(mappedWorldPoint && afterMapPan);
      assert.ok(
        Math.abs(
          mappedWorldPoint.x * afterMapPan.zoom + afterMapPan.panX -
            afterMapPan.safeWidth / 2,
        ) < 2,
        "minimap navigation centred into the full viewport instead of the safe viewport",
      );

      await page.locator('[data-nx="rd-insp-close"]').click();
      await nextPaint();
      const fullMapWidth = await minimapRepresentedWidth();
      assert.ok(fullMapWidth);
      assert.ok(
        Math.abs(fullMapWidth.represented - fullMapWidth.full) < 3,
        "closing the Inspector did not refresh the minimap camera rectangle",
      );

      const beforeHeaderClick = await stage.evaluate((node) => node.style.transform);
      await page.locator(".rd-map-head .rd-map-title").click();
      await page.waitForTimeout(100);
      assert.equal(
        await stage.evaluate((node) => node.style.transform),
        beforeHeaderClick,
        "the minimap header is chrome, not a camera navigation target",
      );
      const desktopMapGeometry = await navigatorGeometry();
      assert.ok(desktopMapGeometry?.width > 0 && desktopMapGeometry.height > 0);
      assert.deepEqual(
        desktopMapGeometry.outside,
        [],
        "minimap markers or camera viewport escaped the actual drawing area",
      );

      await page.locator('.rd-map-head [data-nx="canvas-map"]').click();
      const collapsedMap = await page.evaluate(() => {
        const fit = document.querySelector('.rd-zoom > [data-nx="canvas-fit"]');
        const show = document.querySelector(".rd-zoom > .rd-mapshow");
        if (!fit || !show) return null;
        const fitRect = fit.getBoundingClientRect();
        const showRect = show.getBoundingClientRect();
        return {
          mapHidden: document.querySelector(".forma-canvas-navigator")?.hidden,
          showHidden: show.hidden,
          position: getComputedStyle(show).position,
          gap: Math.round((showRect.left - fitRect.right) * 10) / 10,
          centerDelta: Math.round(
            Math.abs(
              showRect.top + showRect.height / 2 -
                (fitRect.top + fitRect.height / 2),
            ) * 10,
          ) / 10,
        };
      });
      assert.ok(collapsedMap, "the collapsed minimap control is missing");
      assert.equal(collapsedMap.mapHidden, true);
      assert.equal(collapsedMap.showHidden, false);
      assert.equal(collapsedMap.position, "static");
      assert.ok(
        collapsedMap.gap >= 0 && collapsedMap.gap <= 6,
        `collapsed minimap is ${collapsedMap.gap}px away from Fit instead of beside it`,
      );
      assert.ok(
        collapsedMap.centerDelta <= 1,
        `collapsed minimap is vertically misaligned with Fit by ${collapsedMap.centerDelta}px`,
      );

      const zoomMenuTrigger = page.locator('[data-nx="rd-zoom-menu"]');
      await zoomMenuTrigger.focus();
      assert.equal(
        await zoomMenuTrigger.getAttribute("aria-controls"),
        "rd-zoom-menu-popup",
      );
      await page.keyboard.press("Enter");
      assert.equal(await zoomMenuTrigger.getAttribute("aria-expanded"), "true");
      assert.equal(
        await page.locator('[role="menuitem"]').first().evaluate((item) => item === document.activeElement),
        true,
        "opening the zoom menu did not place focus on its first command",
      );
      await page.keyboard.press("ArrowDown");
      assert.equal(await page.locator('[role="menuitem"]').nth(1).evaluate(
        (item) => item === document.activeElement,
      ), true);
      await page.keyboard.press("End");
      assert.equal(await page.locator('[role="menuitem"]').last().evaluate(
        (item) => item === document.activeElement,
      ), true);
      await page.keyboard.press("Home");
      assert.equal(await page.locator('[role="menuitem"]').first().evaluate(
        (item) => item === document.activeElement,
      ), true);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".rd-menu").getAttribute("hidden"), "");
      assert.equal(await zoomMenuTrigger.getAttribute("aria-expanded"), "false");
      assert.equal(await zoomMenuTrigger.evaluate((button) => button === document.activeElement), true);

      await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      assert.equal(await page.locator(".rd-menu").getAttribute("hidden"), "");
      assert.equal(
        await page.locator('[data-nx="canvas-zoom-in"]').evaluate(
          (button) => button === document.activeElement,
        ),
        true,
        "Tab from the menu did not continue to the next zoom control",
      );
      await zoomMenuTrigger.focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Shift+Tab");
      assert.equal(await page.locator(".rd-menu").getAttribute("hidden"), "");
      assert.equal(await zoomMenuTrigger.evaluate((button) => button === document.activeElement), true);

      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      assert.equal(await page.locator(".n-zoomval").textContent(), "25%");
      assert.equal(await page.locator(".rd-menu").getAttribute("hidden"), "");
      assert.equal(await zoomMenuTrigger.evaluate((button) => button === document.activeElement), true);
      await page.locator(".rd-back").click();
      await nextPaint();
      assert.equal(
        await page.locator(".rd-back").getAttribute("hidden"),
        "",
        "returning from a zoom-menu pick did not retire its one history entry",
      );

      await page.evaluate(() => {
        const canvas = document.querySelector(".n-canvas");
        for (let index = 0; index < 15; index += 1) {
          const probe = document.createElement("div");
          probe.hidden = true;
          probe.className = "rd-palette-probe";
          probe.dataset.instanceId = `palette-probe-${index}`;
          probe.dataset.widgetName = `Palette probe ${index}`;
          canvas?.append(probe);
        }
      });
      await page.locator('[data-nx="rd-search"]').click();
      assert.equal(
        await page.locator(".rd-palette-row").count(),
        10,
        "the palette default did not keep the six-widget/four-command budget",
      );
      const paletteInput = page.locator(".rd-palette-input");
      await paletteInput.fill("Palette probe");
      assert.equal(
        await page.locator(".rd-palette-row").count(),
        10,
        "a palette search rendered beyond its ten-result scan limit",
      );
      await paletteInput.fill("definitely-no-such-widget-or-command");
      assert.equal(await page.locator(".rd-palette-row").count(), 0);
      assert.equal(
        await page.locator(".rd-palette-empty").textContent(),
        "Nothing matches “definitely-no-such-widget-or-command”",
      );
      await page.keyboard.press("Enter");
      assert.equal(await page.locator(".rd-palette").getAttribute("hidden"), null);
      assert.equal(await paletteInput.evaluate((input) => input === document.activeElement), true);
      await page.keyboard.press("Escape");
      await page.evaluate(() => {
        document.querySelectorAll(".rd-palette-probe").forEach((probe) => probe.remove());
      });

      await page.locator('[data-nx="rd-search"]').focus();
      await page.keyboard.press("m");
      assert.equal(
        await page.locator(".forma-canvas-navigator").getAttribute("hidden"),
        "",
        "an unmodified canvas shortcut fired while title-bar focus was outside the canvas",
      );

      await stageItem("mock-b").click();
      await page.getByLabel("X", { exact: true }).fill("2200");
      await page.locator(".rd-insp-head .rd-map-title").click();
      await stageItem("mock-a").click();
      await zoomMenuTrigger.click();
      await page.locator('[data-nx="rd-z-50"]').click();
      await page.locator('.rd-inspector [data-nx="rd-center-sel"]').click();
      const chip = page.locator(".rd-chip", { hasText: "Mock node B" });
      await chip.waitFor({ state: "visible" });
      const beforeChipJump = await stage.evaluate((node) => node.style.transform);
      await chip.click();
      await page.waitForFunction(
        () =>
          document.querySelector(".rd-insp-name")?.textContent === "Mock node B" &&
          document.querySelector('[data-instance-id="mock-b"]')?.classList.contains("rd-pulse"),
      );
      assert.equal(await page.locator(".n-zoomval").textContent(), "90%");
      const chipLanding = await cameraState();
      const chipTarget = await stageItem("mock-b").evaluate((item) => ({
        x: Number(item.dataset.canvasX) + Number(item.dataset.canvasWidth) / 2,
      }));
      assert.ok(chipLanding);
      assert.ok(
        Math.abs(
          chipTarget.x * chipLanding.zoom + chipLanding.panX - chipLanding.safeWidth / 2,
        ) < 2,
        "a proximity chip landed its target behind the Inspector",
      );
      await page.locator(".rd-back").click();
      assert.equal(
        await stage.evaluate((node) => node.style.transform),
        beforeChipJump,
        "Back view did not restore the exact pre-chip camera",
      );
      await page.getByLabel("X", { exact: true }).fill("470");
      await page.locator(".rd-insp-head .rd-map-title").click();

      await stageItem("mock-a").click();
      const beforeKeys = await stageItem("mock-a").evaluate((item) => ({
        x: Number(item.dataset.canvasX),
        y: Number(item.dataset.canvasY),
      }));
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Shift+ArrowDown");
      assert.deepEqual(
        await stageItem("mock-a").evaluate((item) => ({
          x: Number(item.dataset.canvasX),
          y: Number(item.dataset.canvasY),
        })),
        { x: beforeKeys.x + 12, y: beforeKeys.y + 1 },
        "item-focused arrows must use the redesign's 12px / Shift-1px nudge",
      );

      await page.keyboard.press("m");
      assert.equal(
        await page.locator(".forma-canvas-navigator").getAttribute("hidden"),
        null,
        "item-focused M was consumed by widget chrome instead of toggling the minimap",
      );
      await page.keyboard.press("?");
      assert.equal(await page.locator(".rd-sheet").getAttribute("hidden"), null);
      assert.equal(
        await page.locator(".rd-sheet-lede").evaluate((lede) => lede === document.activeElement),
        true,
        "the shortcut sheet did not move focus into its dialog",
      );
      await page.keyboard.press("Escape");
      assert.equal(
        await page.locator(".rd-sheet").getAttribute("hidden"),
        "",
        "Escape cleared the widget underneath instead of closing the shortcut sheet",
      );
      assert.equal(
        await stageItem("mock-a").getAttribute("aria-current"),
        "true",
        "closing the shortcut sheet unexpectedly cleared the active widget",
      );

      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () => document.querySelector(".forma-canvas-viewport")?.dataset.widgetFocusMode === "active",
      );
      await page.keyboard.press("Escape");
      assert.equal(
        await page.locator(".forma-canvas-viewport").getAttribute("data-widget-focus-mode"),
        "inactive",
        "item-focused Escape skipped the redesign's Focus-mode rung",
      );

      const moveHandle = stageItem("mock-a").locator(".widget-drag-handle");
      await moveHandle.focus();
      const beforeHandleKeys = await stageItem("mock-a").evaluate((item) => ({
        x: Number(item.dataset.canvasX),
        y: Number(item.dataset.canvasY),
      }));
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("Shift+ArrowUp");
      assert.deepEqual(
        await stageItem("mock-a").evaluate((item) => ({
          x: Number(item.dataset.canvasX),
          y: Number(item.dataset.canvasY),
        })),
        { x: beforeHandleKeys.x - 12, y: beforeHandleKeys.y - 1 },
        "move-handle focus must not switch to the shared engine's 16px / 64px scale",
      );

      // The narrow layout turns the Inspector into a full-screen drawer. It
      // must neither feed 100vw into the camera's right inset nor strand
      // dialog focus below a short phone viewport.
      await page.locator('[data-nx="rd-insp-close"]').click();
      await page.setViewportSize({ width: 390, height: 667 });
      await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      const mobileMapGeometry = await navigatorGeometry();
      assert.ok(mobileMapGeometry?.width > 0 && mobileMapGeometry.height > 0);
      assert.deepEqual(
        mobileMapGeometry.outside,
        [],
        "the compact minimap projected outside its header-free drawing area",
      );

      const beforeMobileInspector = await stage.evaluate((node) => node.style.transform);
      await stageItem("mock-b").click();
      await page.waitForFunction(() => document.querySelector(".rd-inspector")?.hidden === false);
      assert.equal(
        await stage.evaluate((node) => node.style.transform),
        beforeMobileInspector,
        "opening the full-width mobile Inspector unexpectedly panned the hidden canvas",
      );
      const mobileInspector = await page.locator(".rd-inspector").evaluate((panel) => {
        const rect = panel.getBoundingClientRect();
        return { left: Math.round(rect.left), width: Math.round(rect.width) };
      });
      assert.deepEqual(mobileInspector, { left: 0, width: 390 });

      await page.getByLabel("X", { exact: true }).focus();
      await page.keyboard.press("Escape");
      assert.equal(await stageItem("mock-b").getAttribute("aria-current"), "true");
      assert.equal(await page.locator(".rd-inspector").getAttribute("hidden"), null);
      await page.locator('[data-nx="rd-insp-close"]').click();

      await page.keyboard.press("?");
      const mobileSheetFocus = await page.locator(".rd-sheet-lede").evaluate((lede) => {
        const rect = lede.getBoundingClientRect();
        return {
          active: lede === document.activeElement,
          visible: rect.top >= 0 && rect.bottom <= window.innerHeight,
        };
      });
      assert.deepEqual(mobileSheetFocus, { active: true, visible: true });
      assert.equal(
        await page.locator(".rd-sheet .rd-scrim").evaluate((scrim) => getComputedStyle(scrim).position),
        "fixed",
      );
      await page.keyboard.press("Control+k");
      assert.equal(await page.locator(".rd-sheet").getAttribute("hidden"), "");
      assert.equal(await page.locator(".rd-palette").getAttribute("hidden"), null);
      assert.equal(
        await page.locator(".rd-palette-input").evaluate((input) => input === document.activeElement),
        true,
        "Ctrl+K focused a palette behind the shortcut sheet instead of replacing it",
      );
      await page.keyboard.press("Escape");
      assert.deepEqual(diagnostics, [], "/redesign emitted browser errors during interaction checks");
    } finally {
      await context.close();
    }
  });

  test("reduced-motion Focus corrects a late widget measurement without locking input", async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      colorScheme: "dark",
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    try {
      const response = await page.goto(`${BASE}/redesign`, { waitUntil: "domcontentloaded" });
      assert.ok(response?.ok());
      await page.waitForFunction(
        () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
        null,
        { timeout: 20_000 },
      );
      await page.waitForFunction(
        () => document.querySelector(
          '.forma-canvas-stage > [data-instance-id="mock-a"]',
        )?.dataset.canvasHeight,
        null,
        { timeout: 20_000 },
      );
      const item = page.locator('.forma-canvas-stage > [data-instance-id="mock-a"]');
      await item.click();
      const originalHeight = await item.evaluate((node) => Number(node.dataset.canvasHeight));
      await page.evaluate(() => {
        const button = document.querySelector('.rd-inspector [data-nx="rd-focus-sel"]');
        const item = document.querySelector(
          '.forma-canvas-stage > [data-instance-id="mock-a"]',
        );
        button?.addEventListener("click", () => {
          window.setTimeout(() => {
            if (item instanceof HTMLElement) item.style.height = `${item.offsetHeight + 80}px`;
          }, 20);
        }, { once: true });
      });
      await page.locator('.rd-inspector [data-nx="rd-focus-sel"]').click();
      await page.waitForFunction(
        (height) =>
          Number(document.querySelector(
            '.forma-canvas-stage > [data-instance-id="mock-a"]',
          )?.dataset.canvasHeight) >=
            height + 79,
        originalHeight,
        { timeout: 5_000 },
      );
      await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      assert.equal(
        await page.locator(".is-camera-animating").count(),
        0,
        "reduced motion left the interaction surface locked",
      );
      const landing = await page.evaluate(() => {
        const viewport = document.querySelector(".forma-canvas-viewport");
        const inspector = document.querySelector(".rd-inspector");
        const item = document.querySelector(
          '.forma-canvas-stage > [data-instance-id="mock-a"]',
        );
        if (!viewport || !inspector || !item) return null;
        const viewportRect = viewport.getBoundingClientRect();
        const inspectorWidth = inspector.getBoundingClientRect().width;
        const itemRect = item.getBoundingClientRect();
        return {
          x: Math.abs(
            (itemRect.left + itemRect.right) / 2 -
              (viewportRect.left + (viewportRect.width - inspectorWidth) / 2),
          ),
          y: Math.abs(
            (itemRect.top + itemRect.bottom) / 2 -
              (viewportRect.top + viewportRect.height / 2),
          ),
        };
      });
      assert.ok(landing && landing.x <= 2 && landing.y <= 2,
        `late widget geometry escaped reduced-motion Focus (${JSON.stringify(landing)})`);
    } finally {
      await context.close();
    }
  });

  test("normal motion slides the Inspector and flies zoom plus pan as one camera move", async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      colorScheme: "dark",
      reducedMotion: "no-preference",
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    try {
      const response = await page.goto(`${BASE}/redesign`, { waitUntil: "domcontentloaded" });
      assert.ok(response?.ok());
      await page.waitForFunction(
        () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
        null,
        { timeout: 20_000 },
      );
      await page.waitForFunction(
        () => Boolean(document.querySelector(".forma-canvas-stage")?.style.transform),
        null,
        { timeout: 20_000 },
      );

      const inspectorMotion = await page.evaluate(() => {
        document.querySelector(
          '.forma-canvas-stage > [data-instance-id="mock-b"]',
        )?.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
        );
        const panel = document.querySelector(".rd-inspector");
        const animation = panel?.getAnimations().find(
          (candidate) => candidate.animationName === "rd-inspector-enter",
        );
        return {
          hidden: panel?.hidden,
          duration: animation?.effect?.getTiming().duration ?? null,
          playState: animation?.playState ?? null,
        };
      });
      assert.deepEqual(inspectorMotion, {
        hidden: false,
        duration: 200,
        playState: "running",
      });
      await page.waitForTimeout(220);

      await page.getByLabel("X", { exact: true }).fill("2200");
      await page.locator(".rd-insp-head .rd-map-title").click();
      await page.locator('.forma-canvas-stage > [data-instance-id="mock-a"]').click();
      await page.locator('[data-nx="rd-zoom-menu"]').click();
      await page.locator('[data-nx="rd-z-50"]').click();
      await page.waitForFunction(() => !document.querySelector(".is-camera-animating"));
      await page.locator('.rd-inspector [data-nx="rd-center-sel"]').click();
      await page.waitForFunction(() => !document.querySelector(".is-camera-animating"));
      const chip = page.locator(".rd-chip", { hasText: "Mock node B" });
      await chip.waitFor({ state: "visible" });

      const cameraMotion = await page.evaluate(() => {
        const stage = document.querySelector(".forma-canvas-stage");
        const chip = Array.from(document.querySelectorAll(".rd-chip")).find(
          (candidate) => candidate.textContent?.includes("Mock node B"),
        );
        if (!(stage instanceof HTMLElement) || !(chip instanceof HTMLElement)) return null;
        const before = new DOMMatrixReadOnly(getComputedStyle(stage).transform).a;
        chip.click();
        const immediate = new DOMMatrixReadOnly(getComputedStyle(stage).transform).a;
        const target = Number(stage.style.transform.match(/scale\(([-\d.]+)\)/)?.[1]);
        return {
          before,
          immediate,
          target,
          animating: document.querySelector(".forma-canvas-viewport")
            ?.classList.contains("is-camera-animating"),
        };
      });
      assert.ok(cameraMotion);
      assert.ok(Math.abs(cameraMotion.before - 0.5) < 0.01);
      assert.ok(Math.abs(cameraMotion.immediate - cameraMotion.before) < 0.03,
        `fly-to snapped zoom before its pan (${JSON.stringify(cameraMotion)})`);
      assert.ok(Math.abs(cameraMotion.target - 0.9) < 0.001);
      assert.equal(cameraMotion.animating, true);
      await page.waitForFunction(() => !document.querySelector(".is-camera-animating"));
      assert.equal(await page.locator(".n-zoomval").textContent(), "90%");
    } finally {
      await context.close();
    }
  });
});

// ── Stamped themes: the server-side data-theme choice (TK2) ────────────────
//
// One fixture per shipped theme, seeded via KSX_FIXTURE_THEME (the
// KSX_FIXTURE_SESSION precedent — the fixture fabricates state and reads no
// config.toml). The OS scheme is emulated OPPOSITE to the theme's own, which
// is the whole claim under test: an explicit choice beats the OS in both
// directions. The dark theme's stamped values are byte-identical to the base
// :root, so the PAINT alone cannot detect a missing stamp — the
// html[data-theme] attribute is asserted alongside the painted ground
// (tests/http.rs's route oracle covers the served bytes; this covers what a
// browser actually renders from them). Assertion-only cells: no screenshots,
// so the main manifest's expectedCount pin stays exact.

const THEMES = JSON.parse(
  await readFile(path.join(repoRoot, "crates", "ksx-studio", "assets", "themes.json"), "utf8"),
).themes;
const THEME_FIRST_PORT = Number(process.env.KSX_PWTEST_THEME_PORT ?? 4510);

const hexToRgb = (hex) =>
  `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;

for (const [index, theme] of THEMES.entries()) {
  describe(`stamped theme — ${theme.id}`, () => {
    const port = THEME_FIRST_PORT + index;
    const base = `http://127.0.0.1:${port}`;
    let themedServer;
    let themedStderr = "";
    let context;

    before(async () => {
      const squatter = await fetch(`${base}/api/nocturne`).then(
        () => true,
        () => false,
      );
      assert.equal(squatter, false, `something is already listening on ${base} — stop it first`);
      themedServer = spawn(exe, [String(port)], {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, KSX_FIXTURE_SESSION: "idle", KSX_FIXTURE_THEME: theme.id },
      });
      themedServer.stderr?.on("data", (chunk) => (themedStderr += chunk.toString()));
      const until = Date.now() + 120_000;
      for (;;) {
        const up = await fetch(`${base}/api/nocturne`).then(
          (response) => response.ok,
          () => false,
        );
        if (up) break;
        assert.ok(
          Date.now() < until,
          `themed fixture never answered on ${base}:
${themedStderr.trim() || "(it said nothing)"}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      context = await browser.newContext({
        viewport: { width: 1600, height: 1200 },
        colorScheme: theme.scheme === "dark" ? "light" : "dark",
        reducedMotion: "reduce",
        deviceScaleFactor: 1,
        locale: "en-US",
        timezoneId: "UTC",
        serviceWorkers: "block",
      });
    });

    after(async () => {
      const failures = [];
      try {
        await context?.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await stopFixtureProcess(themedServer, `themed fixture (${theme.id})`);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "themed teardown failed");
    });

    for (const route of ROUTES) {
      test(`${route.path} paints ${theme.id} against the opposite OS scheme`, async () => {
        const page = await context.newPage();
        const diagnostics = [];
        page.on("pageerror", (error) => diagnostics.push(`pageerror: ${error.stack ?? error}`));
        page.on("console", (message) => {
          if (message.type() === "error") diagnostics.push(`console: ${message.text()}`);
        });
        const response = await page.goto(`${base}${route.path}`, {
          waitUntil: "domcontentloaded",
        });
        assert.ok(response?.ok(), `${route.path} returned HTTP ${response?.status() ?? "none"}`);
        await page.waitForFunction(
          () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
          null,
          { timeout: 20_000 },
        );
        const painted = await page.evaluate(() => ({
          stamp: document.documentElement.dataset.theme ?? null,
          bg: getComputedStyle(document.body).backgroundColor,
          nocturneStage: (() => {
            const stage = document.querySelector(".nocturne");
            return stage ? getComputedStyle(stage).backgroundColor : null;
          })(),
        }));
        assert.equal(painted.stamp, theme.id, `${route.path} is missing the data-theme stamp`);
        assert.equal(
          painted.bg,
          hexToRgb(theme.bg),
          `${route.path} painted the wrong ground for stamped ${theme.id}`,
        );
        if (painted.nocturneStage !== null) {
          // The frame learned the themes (2026-08-27). `.nocturne` was the
          // one surface a stamp could not reach — it hard-coded its palette
          // over a 100vh frame, so the shipped picker changed nothing a user
          // could see. Its `--n-*` roles now alias the token values under a
          // stamped light or matrix theme, so the ground here IS `theme.bg`.
          // Stamped dark is the one exception, on purpose: the Nocturne
          // design's own navy (#161826) is the product's dark face, and the
          // picker's Dark row promises "renders dark", not "renders the
          // token ramp's dark".
          const expectedStage =
            theme.id === "dark" ? "rgb(22, 24, 38)" : hexToRgb(theme.bg);
          assert.equal(
            painted.nocturneStage,
            expectedStage,
            `${route.path}'s .nocturne frame did not paint the stamped ${theme.id} ground`,
          );
        }
        assert.deepEqual(
          diagnostics,
          [],
          `${route.path} emitted browser errors stamped ${theme.id}`,
        );
        await page.close();
      });
    }
  });
}

// ── The plate lays out, measured in a real browser ─────────────────────────
//
// These assert on GEOMETRY the page actually computed, which is the only place
// the two defects below were visible. Both shipped, both passed every Rust
// test, and neither could have been caught by one: the Rust side owns the
// numbers, and the stylesheet was quietly disagreeing with them.
//
//  - `.n-key.sp` still carried the cluster gap as a `margin-left` after
//    `board.rs` began baking it into `left`. `.n-kbcase .n-key { margin: 0 }`
//    was meant to hold it off and could not — equal specificity, declared
//    later — so the gap applied twice and 14 caps on the DEFAULT board sat on
//    top of their neighbour by more than half a cap.
//  - `.n-kbcase` was `box-sizing: content-box`, so `aspect-ratio` shaped the
//    content box while the absolutely positioned caps measured percentages
//    against the padding box. They differ by exactly the padding, and every
//    cap came out about 7.5% too tall.
describe("the plate lays out", () => {
  let context;

  before(async () => {
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: "en-US",
      timezoneId: "UTC",
      serviceWorkers: "block",
    });
  });

  after(async () => {
    await context?.close();
  });

  test("no two caps on the board overlap", async () => {
    const page = await context.newPage();
    try {
      const response = await page.goto(`${BASE}/nocturne`, { waitUntil: "domcontentloaded" });
      assert.ok(response?.ok(), `/nocturne returned HTTP ${response?.status() ?? "none"}`);
      await page.waitForFunction(
        () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
        null,
        { timeout: 20_000 },
      );

      const boxes = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".n-kbcase .n-key")).map((el) => {
          const r = el.getBoundingClientRect();
          return {
            key: el.getAttribute("data-key") ?? "",
            sp: el.classList.contains("sp"),
            x: r.x,
            y: r.y,
            w: r.width,
            h: r.height,
          };
        }),
      );

      assert.ok(boxes.length > 60, `expected a full board of caps, saw ${boxes.length}`);

      // A cap that overlaps its neighbour hands clicks to the wrong key, which
      // is indistinguishable from a binding that stopped working. 0.5px of
      // slack absorbs sub-pixel rounding and nothing else.
      const overlaps = [];
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i];
          const b = boxes[j];
          const apart =
            a.x + a.w <= b.x + 0.5 ||
            b.x + b.w <= a.x + 0.5 ||
            a.y + a.h <= b.y + 0.5 ||
            b.y + b.h <= a.y + 0.5;
          if (!apart) overlaps.push(`${a.key || "chrome"} over ${b.key || "chrome"}`);
        }
      }
      assert.deepEqual(
        overlaps.slice(0, 8),
        [],
        `${overlaps.length} caps overlap a neighbour; the cluster gap is most likely being applied twice`,
      );

      // Every cap is authored 34/30 taller than it is wide. A plate whose
      // percentage basis disagrees with its own aspect-ratio stretches all of
      // them uniformly, so this catches the box-sizing class of bug without
      // depending on any single cap's size.
      const square = boxes.filter((b) => !b.sp && b.w > 0 && Math.abs(b.w - boxes[0].w) < 0.5);
      assert.ok(square.length > 20, "expected many 1u caps to compare");
      const ratio = square[0].h / square[0].w;
      assert.ok(
        Math.abs(ratio - 34 / 30) < 0.03,
        `a 1u cap drew ${ratio.toFixed(3)} tall/wide, not the authored ${(34 / 30).toFixed(3)} — the plate's aspect-ratio and its percentage basis disagree`,
      );
    } finally {
      await page.close();
    }
  });

  test("the board fits inside its card", async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${BASE}/nocturne`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
        null,
        { timeout: 20_000 },
      );
      const fit = await page.evaluate(() => {
        const plate = document.querySelector(".n-kbcase");
        if (!plate) return null;
        const p = plate.getBoundingClientRect();
        const card = plate.closest(".n-widget-kb") ?? plate.parentElement;
        const c = card.getBoundingClientRect();
        return { plateW: p.width, plateH: p.height, cardW: c.width };
      });
      assert.ok(fit, "the plate is missing");
      assert.ok(
        fit.plateW <= fit.cardW + 1,
        `the plate is ${fit.plateW.toFixed(0)}px wide inside a ${fit.cardW.toFixed(0)}px card`,
      );
      // A portrait board (an arcade panel) is clamped by a height budget so it
      // cannot grow into a column that swallows the canvas beneath it.
      assert.ok(
        fit.plateH <= 620,
        `the plate is ${fit.plateH.toFixed(0)}px tall; the height budget is meant to cap it`,
      );
    } finally {
      await page.close();
    }
  });
});

// ── The picker changes the page it lives on, WITHOUT a reload ───────────────
//
// The regression this pins: with scripting on, every POST form is
// fetch-enhanced (nocturne.ts wireForms) and the redirect's page is
// discarded — but the theme's whole effect is an attribute on <html>,
// OUTSIDE the island's render tree, so choosing a theme changed nothing a
// user could see until a manual refresh. applyNocturne now converges the
// stamp from the payload's own theme rows; this test walks the journey in
// one living document. It also needed the fixture to ACCEPT the write:
// set_theme's trait default refuses, which made the picker an
// always-erroring control in every fixture-backed pass and hid all of this
// from every browser gate.
describe("live theme switch", () => {
  let context;

  before(async () => {
    context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      colorScheme: "dark",
      reducedMotion: "reduce",
    });
  });

  after(async () => {
    await context?.close();
  });

  test("choosing Light restamps <html> in place, and System removes the stamp", async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${BASE}/nocturne`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.querySelector("[data-forma-island]")?.dataset.formaStatus === "active",
        null,
        { timeout: 20_000 },
      );
      // A property that survives only while this DOCUMENT survives: if the
      // form fell back to a full navigation, the stamp would appear anyway
      // and this test would pass a reload off as a live switch.
      await page.evaluate(() => {
        window.__sameDocument = true;
      });

      await page.click('form[action="/nocturne/theme"]:has(input[value="light"]) button');
      await page.waitForFunction(
        () => document.documentElement.dataset.theme === "light",
        null,
        { timeout: 15_000 },
      );
      assert.equal(
        await page.evaluate(() => window.__sameDocument === true),
        true,
        "the stamp arrived via a full reload, not a live re-stamp",
      );
      // And the frame actually repaints: the themed --n-* roles resolve to
      // the light ground the stamped-theme suite pins.
      const light = THEMES.find((theme) => theme.id === "light");
      await page.waitForFunction(
        (bg) => getComputedStyle(document.querySelector(".nocturne")).backgroundColor === bg,
        hexToRgb(light.bg),
        { timeout: 15_000 },
      );

      // System is the ABSENCE of a stamp — the media guard needs the
      // attribute GONE, not set to a word nothing styles.
      await page.click('form[action="/nocturne/theme"]:has(input[value="system"]) button');
      await page.waitForFunction(
        () => document.documentElement.dataset.theme === undefined,
        null,
        { timeout: 15_000 },
      );
      assert.equal(
        await page.evaluate(() => window.__sameDocument === true),
        true,
        "clearing the stamp navigated instead of re-stamping",
      );
    } finally {
      await page.close();
    }
  });
});
