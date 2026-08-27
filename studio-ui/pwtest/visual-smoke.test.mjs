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
              const kb = document.querySelector('.n-canvas [data-instance-id="keyboard"]');
              return !document.querySelector(".n-canvas") || kb?.dataset.canvasX !== undefined;
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
            if (canvas) {
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
